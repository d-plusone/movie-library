import { promises as fs } from "fs";
import path from "path";
import { app, protocol } from "electron";
import { detectContainerKind } from "../utils/container.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(app.isPackaged);
const LOCAL_FILE_SCHEME = "local-file";
const LOCAL_FILE_READ_CHUNK = 1024 * 1024;
const localFileMimeCache = new Map<
  string,
  { size: number; mtimeMs: number; mimeType: string | null }
>();
const MAX_MIME_CACHE_ENTRIES = 2048;

function cacheMimeType(
  filePath: string,
  value: { size: number; mtimeMs: number; mimeType: string | null },
): void {
  if (localFileMimeCache.size >= MAX_MIME_CACHE_ENTRIES) {
    const oldest = localFileMimeCache.keys().next().value;
    if (typeof oldest === "string") localFileMimeCache.delete(oldest);
  }
  localFileMimeCache.set(filePath, value);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function isPathWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveLocalFileUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  if (parsed.hostname !== "local") {
    throw new Error("Invalid local-file host");
  }
  let pathname = decodeURIComponent(parsed.pathname);
  if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

async function sniffContainerMime(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    switch (detectContainerKind(buffer.subarray(0, bytesRead))) {
      case "isobmff":
        return path.extname(filePath).toLowerCase() === ".m4v"
          ? "video/x-m4v"
          : "video/mp4";
      case "webm":
        return "video/webm";
      case "mpegts":
        return "video/mp2t";
      case "avi":
        return "video/x-msvideo";
      default:
        return null;
    }
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

type RangeParseResult = ParsedRange | "invalid" | "unsatisfiable";

interface AllowedRoot {
  lexicalPath: string;
  realPath: string;
}

interface ParsedRange {
  start: number;
  end: number;
}

function parseByteRange(header: string | null, size: number): RangeParseResult {
  if (size <= 0) return "unsatisfiable";
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return "invalid";

  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start >= size) return "unsatisfiable";
  if (start > end) return "invalid";
  return { start, end };
}

async function openLocalFileStream(
  filePath: string,
  start: number,
  endInclusive: number,
): Promise<ReadableStream<Uint8Array>> {
  const handle = await fs.open(filePath, "r");
  let position = start;
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (controller.desiredSize === null) {
        await closeOnce();
        return;
      }
      try {
        if (position > endInclusive) {
          await closeOnce();
          if (controller.desiredSize !== null) controller.close();
          return;
        }
        const want = Math.min(LOCAL_FILE_READ_CHUNK, endInclusive - position + 1);
        const buffer = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buffer, 0, want, position);
        if (bytesRead <= 0) {
          await closeOnce();
          if (controller.desiredSize !== null) controller.close();
          return;
        }
        position += bytesRead;
        if (controller.desiredSize !== null) {
          controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
        } else {
          await closeOnce();
        }
      } catch (error) {
        logger.error(`local-file stream error (${filePath}):`, error);
        await closeOnce();
        if (controller.desiredSize !== null) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        }
      }
    },
    async cancel() {
      await closeOnce();
    },
  });
}

async function serveLocalFile(
  request: Request,
  getAllowedRoots: () => Promise<AllowedRoot[]>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let filePath: string;
  try {
    filePath = resolveLocalFileUrl(request.url);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const allowedRoots = await getAllowedRoots();
  if (!allowedRoots.some((root) => isPathWithinDirectory(filePath, root.lexicalPath))) {
    logger.warn(`[local-file] forbidden path: ${filePath}`);
    return new Response("Forbidden", { status: 403 });
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
    if (!stats.isFile()) return new Response("Not Found", { status: 404 });
  } catch {
    logger.warn(`[local-file] 404: ${filePath} (request: ${request.url})`);
    return new Response("Not Found", { status: 404 });
  }

  // シンボリックリンク経由で許可ルートの外へ抜けるケースも拒否する。
  try {
    const realFilePath = await fs.realpath(filePath);
    if (!allowedRoots.some((root) => isPathWithinDirectory(realFilePath, root.realPath))) {
      logger.warn(`[local-file] forbidden symlink target: ${filePath}`);
      return new Response("Forbidden", { status: 403 });
    }
    filePath = realFilePath;
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  // realpath 解決後の実体を改めて stat する。シンボリックリンクの解決中に
  // 差し替えが起きても、レスポンスのメタデータとストリーム対象を一致させる。
  try {
    stats = await fs.stat(filePath);
    if (!stats.isFile()) return new Response("Not Found", { status: 404 });
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const size = stats.size;
  const rangeHeader = request.headers.get("Range");
  const parsed = parseByteRange(rangeHeader, size);
  let mimeType = guessMimeType(filePath);
  if (mimeType === "video/mp4" || mimeType === "application/octet-stream") {
    const cached = localFileMimeCache.get(filePath);
    if (cached?.size === size && cached.mtimeMs === stats.mtimeMs) {
      mimeType = cached.mimeType ?? mimeType;
    } else {
      const sniffed = await sniffContainerMime(filePath);
      cacheMimeType(filePath, { size, mtimeMs: stats.mtimeMs, mimeType: sniffed });
      if (sniffed !== null) mimeType = sniffed;
    }
  }

  const headers = new Headers({
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: `W/"${size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    "Last-Modified": stats.mtime.toUTCString(),
  });
  if (parsed === "invalid" || parsed === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(
      request.method === "HEAD" ? null : "Requested Range Not Satisfiable",
      { status: 416, headers },
    );
  }

  const hasRange = rangeHeader !== null && rangeHeader !== "";
  const etag = headers.get("ETag")!;
  const ifNoneMatch = request.headers.get("If-None-Match");
  const etagMatches =
    ifNoneMatch !== null &&
    (ifNoneMatch.trim() === "*" ||
      ifNoneMatch
        .split(",")
        .map((value) => value.trim())
        .some((value) => value === etag || value === etag.replace(/^W\//, "")));
  const ifModifiedSince = request.headers.get("If-Modified-Since");
  const modifiedSinceMatches =
    ifModifiedSince !== null &&
    !Number.isNaN(Date.parse(ifModifiedSince)) &&
    Math.floor(stats.mtimeMs / 1000) <=
      Math.floor(Date.parse(ifModifiedSince) / 1000);

  // If-None-Match が存在する場合はそれを優先する。Range 応答でも条件一致時は
  // 304 とし、クライアントが不要な本文を再取得しないようにする。
  if (
    etagMatches ||
    (ifNoneMatch === null && !hasRange && modifiedSinceMatches)
  ) {
    return new Response(null, { status: 304, headers });
  }

  try {
    if (hasRange) {
      headers.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${size}`);
      headers.set("Content-Length", String(parsed.end - parsed.start + 1));
      if (request.method === "HEAD") return new Response(null, { status: 206, headers });
      const body = await openLocalFileStream(filePath, parsed.start, parsed.end);
      return new Response(body, { status: 206, headers });
    }

    headers.set("Content-Length", String(size));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const body = size === 0
      ? new Response(new Uint8Array(0), { status: 200 }).body
      : await openLocalFileStream(filePath, 0, size - 1);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    logger.error(`local-file serve error (${filePath}):`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

export function registerLocalFileProtocol(
  getAllowedRoots: () => Promise<string[]>,
): void {
  let cachedRoots: AllowedRoot[] = [];
  let cachedAt = 0;
  let rootsPromise: Promise<string[]> | null = null;
  const getCachedRoots = async (): Promise<AllowedRoot[]> => {
    if (Date.now() - cachedAt < 1000) return cachedRoots;
    if (rootsPromise === null) {
      rootsPromise = getAllowedRoots().finally(() => {
        rootsPromise = null;
      });
    }
    const lexicalRoots = await rootsPromise;
    cachedRoots = await Promise.all(
      lexicalRoots.map(async (lexicalPath) => {
        try {
          return { lexicalPath, realPath: await fs.realpath(lexicalPath) };
        } catch {
          return { lexicalPath, realPath: path.resolve(lexicalPath) };
        }
      }),
    );
    cachedAt = Date.now();
    return cachedRoots;
  };
  protocol.handle(LOCAL_FILE_SCHEME, (request) =>
    serveLocalFile(request, getCachedRoots),
  );
}
