import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  MenuItemConstructorOptions,
  protocol,
} from "electron";
import path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import * as chokidar from "chokidar";
import PrismaDatabaseManager from "../database/PrismaDatabaseManager.js";
import type { VideoRecord } from "../database/PrismaDatabaseManager.js";
import VideoScanner from "../scanner/VideoScanner.js";
import ThumbnailGenerator from "../thumbnail/ThumbnailGenerator.js";
import DuplicateDetector from "../scanner/DuplicateDetector.js";
import {
  ProcessedVideo,
  ProgressEvent,
  OperationProgress,
  ThumbnailResult,
  VideoUpdateData,
  ContainerMismatchItem,
  ConvertVideosResult,
  ConvertItemResult,
  DeleteVideoRequest,
  DirectoryAvailability,
  DirectoryStatus,
} from "../types/types.js";
import {
  classifyContainer,
  containerLabel,
  detectContainerKind,
} from "../utils/container.js";
import {
  classifyMissingPath,
  findMountForPath,
  fsErrorCode,
  isNetworkMount,
  isNotExistError,
  isPathUnderDirectory,
  isTransientFsError,
  readMountEntries,
  smbUrlFromSource,
  type MountEntry,
  type PathState,
} from "../utils/network-mount.js";
import { initializeFFmpeg, getFfmpegPath } from "../utils/ffmpeg-utils.js";
import { createLogger } from "../utils/logger.js";

// production ビルドではデバッグログを抑制
const logger = createLogger(app.isPackaged);

// 標準出力/標準エラーが閉じられた状態で console.log 等を呼ぶと
// "write EPIPE" でプロセスがクラッシュするのを防ぐ
// （例: ログを `| head` や別プロセスにパイプして読み手がいなくなった場合）
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      // 読み手がいないだけなので致命的ではない
      return;
    }
    // EPIPE 以外は元のエラーハンドリングに委ねる
    throw error;
  });
}

const execFileAsync = promisify(execFile);

// ============================================================
// NAS / SMB 切断への耐性
// ============================================================
// ファイルやディレクトリが「見えない」と報告されても、NAS の瞬断・スリープ復帰直後は
// 実在するケースがある。削除と断定する前に複数回・時間を空けて再確認する。
const MISSING_CONFIRM_DELAYS_MS = [3000, 10000, 30000] as const;

// オフラインになった登録ディレクトリの再接続リトライ間隔（試行回数に応じて延長）
const RECONNECT_DELAYS_MS = [3000, 10000, 30000, 60000] as const;

// ローカルパスの削除確認（ネットワークマウントより誤検知が少ないため短め）
const LOCAL_MISSING_CONFIRM_DELAYS_MS = [3000] as const;

// 連続して SMB 再マウントを試みる回数（以降は間隔を空けて試行し、Finder を頻繁に呼ばない）
const MAX_CONSECUTIVE_MOUNT_ATTEMPTS = 3;

// SMB の stale マウントで fs.access が固まらないようにするタイムアウト
const FS_CHECK_TIMEOUT_MS = 10000;

// 再マウントを要求した後、マウント完了を待つ時間
const MOUNT_WAIT_MS = 20000;

// ネットワークマウントの定期ヘルスチェック間隔
// （stale マウントではファイル監視イベントが来ないことがあるため、定期的に確認する）
const NETWORK_HEALTH_CHECK_INTERVAL_MS = 60000;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** promise が指定時間内に解決しなければタイムアウトさせる */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ============================================================
// local-file:// カスタムプロトコル
// ============================================================
// 開発時はレンダラーが Vite の dev サーバー（http://localhost）配信されるため、
// file:// 直読みのサムネイル/動画は Chromium のセキュリティ制限でブロックされる。
// そこでレンダラー側は local-file:///... 形式の URL を使うようにし、
// main 側でこのプロトコルを実ファイルへのアクセスに変換する。
// （registerSchemesAsPrivileged は app ready より前に呼ぶ必要がある）
const LOCAL_FILE_SCHEME = "local-file";

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_FILE_SCHEME,
    privileges: {
      // standard + secure: URL を通常の階層型 URL（ホスト付き）として解釈させる。
      // 非標準スキームだと Chromium のメディアローダ（Range 前提の多段バッファ）が
      // 正しく動作せず、大きな動画で NotSupportedError になる。
      // レンダラー側はダミーホスト "local" を付けた URL を生成すること。
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

/**
 * local-file:// リクエストを実ファイルパスへ解決する。
 * URL 形式（standard スキーマ・ホストは "local" 固定）:
 *   macOS/Linux: local-file://local/Users/x/y.mp4
 *   Windows:     local-file://local/C:/x/y.mp4
 */
function resolveLocalFileUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  let pathname = decodeURIComponent(parsed.pathname);
  // Windows のドライブレター（先頭の "/C:"）を正規化
  if (/^\/[a-zA-Z]:/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return pathname;
}

/** 拡張子から MIME タイプを推定する */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
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

/**
 * 先頭バイトから実際のコンテナ形式を推定し、MIME を補正する。
 * 拡張子を偽装したファイル（例: 中身が MPEG-TS の .mp4）への対策。
 * 判定ロジックは src/utils/container.ts（テスト対象の純粋関数）に集約。
 * 決定的手がかりがない場合は null を返し、拡張子ベースの推定にフォールバックする。
 */
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
    const kind = detectContainerKind(buffer.subarray(0, bytesRead));
    switch (kind) {
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

/**
 * ストリームコピー（劣化なし）で MP4 へリマックスし、元ファイルを同一パスで上書きする。
 * まず全ストリームのコピーを試み、MP4 に入らないストリーム（字幕/データ等）が
 * 原因で失敗した場合は映像+音声に絞って再試行する。それでも失敗すればエラー。
 */
async function remuxToMp4(ffmpegPath: string, inputPath: string): Promise<void> {
  const dir = path.dirname(inputPath);
  const stem = path.basename(inputPath, path.extname(inputPath));
  const tmpPath = path.join(dir, `${stem}.remuxing.mp4`);

  const attempt = async (mapAll: boolean): Promise<void> => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-i",
      inputPath,
      ...(mapAll ? ["-map", "0"] : ["-map", "0:v:0", "-map", "0:a?"]),
      "-c",
      "copy",
      ...(mapAll ? [] : ["-ignore_unknown"]),
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      tmpPath,
    ];
    await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 });
  };

  try {
    try {
      await attempt(true);
    } catch {
      await attempt(false);
    }
    const statResult = await fs.stat(tmpPath);
    if (statResult.size <= 0) throw new Error("変換結果が空です");
    // 同一ボリュームへの rename はアトミックに上書きされる
    await fs.rename(tmpPath, inputPath);
  } catch (e) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 一時ファイルが存在しない場合は無視
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`劣化なし（MP4 ストリームコピー）では変換できません: ${message}`);
  }
}

/** ファイル先頭バイトを読み取る（読めない場合は null） */
async function readFileHead(
  filePath: string,
  bytes: number,
): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

type RangeParseResult = ParsedRange | "invalid" | "unsatisfiable";

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Range ヘッダーを解釈する。
 * - ヘッダー無し / 構文不正 → null（呼び出し側は 200 全体応答を行う）
 * - start がファイル末尾以降 → "unsatisfiable"（416 を返す）
 */
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
    // 後方指定（最後の N バイト）
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "invalid";
  }
  if (start >= size) return "unsatisfiable";
  if (start > end) return "invalid";

  return { start, end };
}

/** ストリーム 1 回の pull で読み取るバイト数 */
const LOCAL_FILE_READ_CHUNK = 1024 * 1024;

/**
 * ファイルの [start, endInclusive] 区間を遅延読み込みする Web ReadableStream を返す。
 * バックプレッシャーは ReadableStream の pull 経由で効くため、
 * 巨大ファイルでもメモリを圧迫しない。
 */
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
      // desiredSize === null は close()/error() 済みを示す。
      // メディアローダは通常の動作としてリクエストを中断するため、
      // cancel 後に再開された pull が閉じ済み controller を操作しないよう
      // すべての操作前にガードする（さもないと応答全体がエラー扱いになる）。
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
          // 予期しない EOF（ファイルが縮んだ等）
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
      } catch (e) {
        console.error(`local-file stream error (${filePath}):`, e);
        await closeOnce();
        if (controller.desiredSize !== null) {
          controller.error(e instanceof Error ? e : new Error(String(e)));
        }
      }
    },
    async cancel() {
      await closeOnce();
    },
  });
}

/**
 * local-file リクエストに応答する。
 * - Range リクエストには 206 + Content-Range で区間をストリーミング応答する
 *   （<video> のシーク・部分バッファリングが正しく機能する）
 * - 通常リクエストには 200 全体をストリーミング応答する
 *   （Range 未指定への 206 応答は HTTP 違反であり、旧実装の不具合だった）
 */
async function serveLocalFile(request: Request): Promise<Response> {
  const filePath = resolveLocalFileUrl(request.url);

  let size: number;
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      logger.warn(`[local-file] not a file: ${filePath}`);
      return new Response("Not Found", { status: 404 });
    }
    size = stats.size;
  } catch {
    // 存在しないパス。URL の破損(host 食い等)の診断に役立てるため出力する
    logger.warn(`[local-file] 404: ${filePath} (request: ${request.url})`);
    return new Response("Not Found", { status: 404 });
  }

  const rangeHeader = request.headers.get("Range");
  const parsed = parseByteRange(rangeHeader, size);

  // 拡張子偽装ファイル対策: 先頭バイトから実際のコンテナを判定して MIME を補正する
  let mimeType = guessMimeType(filePath);
  if (mimeType === "video/mp4" || mimeType === "application/octet-stream") {
    const sniffed = await sniffContainerMime(filePath);
    if (sniffed !== null) mimeType = sniffed;
  }

  // 要求シーケンスのトレース（dev のみ出力）
  const planned =
    parsed === "invalid"
      ? "200 full(invalid range ignored)"
      : parsed === "unsatisfiable"
        ? "416"
        : rangeHeader !== null && rangeHeader !== ""
          ? `206 bytes ${parsed.start}-${parsed.end}`
          : "200 full";
  logger.debug(`[local-file] ${request.method} ${filePath} (size=${size}, Range=${rangeHeader ?? "-"}) -> ${planned}`);
  const headers = new Headers({
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });

  if (parsed === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response("Requested Range Not Satisfiable", { status: 416, headers });
  }

  try {
    if (rangeHeader !== null && rangeHeader !== "" && parsed !== "invalid") {
      headers.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${size}`);
      headers.set("Content-Length", String(parsed.end - parsed.start + 1));
      const body = await openLocalFileStream(filePath, parsed.start, parsed.end);
      return new Response(body, { status: 206, headers });
    }

    // Range 未指定 / 構文不正は全体を 200 で返す
    headers.set("Content-Length", String(size));
    const body =
      size === 0 ? new Response(new Uint8Array(0), { status: 200 }).body : await openLocalFileStream(filePath, 0, size - 1);
    if (body === null) {
      return new Response(new Uint8Array(0), { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  } catch (e) {
    console.error(`local-file serve error (${filePath}):`, e);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function registerLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, (request) => serveLocalFile(request));
}

// ============================================================
// GPU アクセラレーション強化（動画再生のヌルヌル化。before ready で有効化）
// ============================================================
// 基本のラスタライズ高速化
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// macOS では ANGLE バックエンドに Metal を使用（OpenGL より高速）
app.commandLine.appendSwitch("use-angle", "metal");

// デュアル GPU（M シリーズ + 外付け）時に高性能 GPU を強制
app.commandLine.appendSwitch("force_high_performance_gpu");

// ハードウェアデコード機能の強化（HEVC/H.265 のネイティブデコードを含む）
// 注意: enable-hardware-overlays / enable-gpu-memory-buffer-video-frames /
// disable-frame-rate-limit は macOS で GPU プロセスがクラッシュする
// （exit_code=11: SIGSEGV）ため使用しない
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCDecoderSupport,HardwareMediaKeyHandling,CanvasOopRasterization",
);

// Set app name BEFORE app is ready to ensure consistent userData path across versions
// This must be done before any app.getPath() calls
app.setName("movie-library");

// About パネル (macOS / Windows のネイティブダイアログ) のカスタマイズ
// アプリ自体のバージョンは表示せず、代わりに Electron のバージョンを表示する
app.setAboutPanelOptions({
  applicationName: "Movie Library",
  applicationVersion: `Electron ${process.versions.electron}`,
  copyright: "© 2025 Movie Library",
  website: "https://github.com/d-plusone/movie-library/",
  credits: "動画ファイルの管理と再生を支援するアプリケーションです。",
});

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await task(item);
      }
    },
  );
  await Promise.allSettled(workers);
}

// プログレスイベントの送信先チャネル
type ProgressChannel =
  | "scan-progress"
  | "rescan-progress"
  | "thumbnail-progress";

// 汎用操作進捗（container-check / container-convert）の送信先チャネル
type OperationProgressChannel =
  | "container-check-progress"
  | "container-convert-progress";

class MovieLibraryApp {
  private mainWindow: BrowserWindow | null = null;
  private db: PrismaDatabaseManager;
  private videoScanner: VideoScanner;
  private duplicateDetector: DuplicateDetector;
  private thumbnailGenerator: ThumbnailGenerator;
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  /** 登録ディレクトリの接続状態（描画側のバッジ表示用） */
  private directoryAvailability: Map<string, DirectoryAvailability> =
    new Map();
  /** オフライン中のディレクトリの再接続タイマー */
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  /** 再接続処理が実行中のディレクトリ（多重実行の防止） */
  private reconnectRunning: Set<string> = new Set();
  /** オフラインになってからの再接続試行回数 */
  private reconnectAttempts: Map<string, number> = new Map();
  /** 再マウント用に記録した SMB URL（マウントポイント -> smb://...） */
  private networkMountUrls: Map<string, string> = new Map();
  private networkMountUrlsLoaded = false;
  private mountEntriesCache: { at: number; entries: MountEntry[] } | null =
    null;
  /** 登録ディレクトリのパス一覧の短時間キャッシュ */
  private registeredDirectoriesCache: { at: number; paths: string[] } | null =
    null;
  /** ネットワークマウントの定期ヘルスチェック */
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private healthCheckRunning = false;

  constructor() {
    // データベースファイルのパスを設定
    let dbPath: string;

    if (app.isPackaged) {
      // パッケージされたアプリの場合、ユーザーデータディレクトリを使用
      const userDataPath = app.getPath("userData");
      dbPath = path.join(userDataPath, "movie-library.db");
    } else {
      // 開発環境では現在のワーキングディレクトリを使用
      dbPath = path.join(process.cwd(), "movie-library.db");
    }

    // Windows のバックスラッシュをフォワードスラッシュに変換 (Prisma SQLite URL の要件)
    process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
    logger.debug(`Database path: ${dbPath}`);

    this.db = new PrismaDatabaseManager();
    this.videoScanner = new VideoScanner(this.db);
    this.duplicateDetector = new DuplicateDetector(this.db);
    this.thumbnailGenerator = new ThumbnailGenerator(this.db);
  }

  async initialize(): Promise<void> {
    logger.log("🚀 Initializing Movie Library App...");

    // local-file:// プロトコルを有効化（サムネイル等のローカルファイル読み込み用）
    registerLocalFileProtocol();

    // Initialize FFmpeg binaries
    try {
      const { ffmpegPath, ffprobePath } = await initializeFFmpeg();
      if (!ffmpegPath || !ffprobePath) {
        console.error("⚠️  FFmpeg initialization failed");
      }
    } catch (error) {
      console.error("❌ Failed to initialize FFmpeg:", error);
    }

    // Initialize database
    await this.db.initialize();

    // Initialize video scanner (async)
    await this.videoScanner.initialize();

    // Initialize thumbnail generator (async)
    await this.thumbnailGenerator.initialize();

    // Setup IPC handlers
    this.setupIpcHandlers();

    logger.log("✅ Movie Library App initialized");
  }

  createWindow(): void {
    // プラットフォーム別のアイコンパス
    // （electron-vite のレイアウトでは out/main から 2 階層上 = アプリルートが assets の位置）
    let iconPath: string;
    if (process.platform === "darwin") {
      iconPath = path.join(__dirname, "../../assets", "icon.icns");
    } else if (process.platform === "win32") {
      iconPath = path.join(__dirname, "../../assets", "icon.ico");
    } else {
      iconPath = path.join(__dirname, "../../assets", "icon.png");
    }

    this.mainWindow = new BrowserWindow({
      minWidth: 1000,
      minHeight: 600,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "../preload/index.js"),
        // 動画再生中にタイマーが抑制されてカクつくのを防ぐ
        backgroundThrottling: false,
        // preload に production フラグを渡す（sandbox 下でも process.argv で読める）
        additionalArguments: [
          `--movie-library-production=${app.isPackaged ? "1" : "0"}`,
        ],
      },
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: false,
      show: false, // 初期状態では非表示にして最大化後に表示
    });

    // カスタムメニューを設定
    this.createMenu();

    // ウィンドウを最大化してから表示
    this.mainWindow.maximize();
    this.mainWindow.show();

    // HTML の読み込み（開発時は Vite の開発サーバー、本番ではビルド済みファイル）
    if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
      this.mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
      this.mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
    }

    // 開発モードでのみキーボードショートカットで開発者ツールを開く
    if (process.env.NODE_ENV === "development" || !app.isPackaged) {
      this.mainWindow.webContents.on("before-input-event", (_event, input) => {
        // macOS: Cmd+Option+I または F12
        if (
          process.platform === "darwin" &&
          ((input.meta && input.alt && input.key.toLowerCase() === "i") ||
            input.key === "F12")
        ) {
          this.mainWindow!.webContents.toggleDevTools();
        }
        // Windows/Linux: Ctrl+Shift+I または F12
        else if (
          process.platform !== "darwin" &&
          ((input.control && input.shift && input.key.toLowerCase() === "i") ||
            input.key === "F12")
        ) {
          this.mainWindow!.webContents.toggleDevTools();
        }
      });
    }

    // ウィンドウが閉じられたときの処理
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
      // アプリを完全に終了（クリーンアップは before-quit で一括実施）
      app.quit();
    });
  }

  createMenu(): void {
    const isMac = process.platform === "darwin";

    const template: MenuItemConstructorOptions[] = [
      // macOS用のアプリメニュー
      ...(isMac
        ? [
            {
              label: app.getName(),
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      // ファイルメニュー
      {
        label: "ファイル",
        submenu: [
          {
            label: "ディレクトリを追加",
            accelerator: "CmdOrCtrl+O",
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send("open-add-directory");
              }
            },
          },
          { type: "separator" },
          {
            label: "設定",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send("open-settings");
              }
            },
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      // 編集メニュー
      {
        label: "編集",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          ...(isMac
            ? [
                { role: "pasteAndMatchStyle" as const },
                { role: "delete" as const },
                { role: "selectAll" as const },
                { type: "separator" as const },
              ]
            : [
                { role: "delete" as const },
                { type: "separator" as const },
                { role: "selectAll" as const },
              ]),
        ],
      },
      // 表示メニュー
      {
        label: "表示",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      // ウィンドウメニュー
      {
        label: "ウィンドウ",
        submenu: [
          { role: "minimize" },
          { role: "close" },
          ...(isMac
            ? [
                { type: "separator" as const },
                { role: "front" as const },
                { type: "separator" as const },
                { role: "window" as const },
              ]
            : []),
        ],
      },
      // ヘルプメニュー
      {
        role: "help",
        submenu: [
          {
            label: "Movie Libraryについて",
            click: async () => {
              await shell.openExternal("https://electron.js.org");
            },
          },
        ],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  /**
   * レンダラーへ進捗イベントを送信する型付きラッパー。
   * webContents.send を直接呼ぶとペイロードが any になるため、
   * このメソッド経由で ProgressEvent の形状をコンパイル時に強制する。
   */
  private sendProgress(channel: ProgressChannel, payload: ProgressEvent): void {
    this.mainWindow?.webContents.send(channel, payload);
  }

  /** 汎用操作進捗（拡張子チェック / 変換）を送信する型付きラッパー */
  private sendOperationProgress(
    channel: OperationProgressChannel,
    payload: OperationProgress,
  ): void {
    this.mainWindow?.webContents.send(channel, payload);
  }

  /**
   * 動画をページング取得しながらサムネイルを並列生成し、
   * 進捗を thumbnail-progress チャネルへ送信する。
   * 「サムネイル生成」「全再生成」「再スキャン後の自動生成」で共用する。
   *
   * 常に先頭ページから再取得する: 「サムネイル無し」条件は生成のたびに
   * 該当行が減るため、offset 進行方式だと未処理行を飛ばしてしまうため。
   *
   * @param fetchPage ページ取得関数（先頭から limit 件）
   * @param totalVideos 総動画数（プログレス表示用）
   * @param verb 進捗メッセージの先頭語（例: "サムネイル生成"）
   */
  private async generateThumbnailsBatch(
    fetchPage: (limit: number) => Promise<VideoRecord[]>,
    totalVideos: number,
    verb: string,
  ): Promise<ThumbnailResult[]> {
    const BATCH_SIZE = 50;
    const CONCURRENCY = 3;
    const results: ThumbnailResult[] = [];
    let processedVideos = 0;

    logger.debug(`Generating thumbnails for ${totalVideos} videos (${verb})`);

    // 無限ループ防止のガード（失敗行が残り続けるケースでも打ち切る）
    const maxRounds = Math.ceil(totalVideos / BATCH_SIZE) + 10;
    for (let round = 0; round < maxRounds; round++) {
      const videos = await fetchPage(BATCH_SIZE);
      if (videos.length === 0) break;
      await runConcurrent(videos, CONCURRENCY, async (video) => {
        try {
          this.sendProgress("thumbnail-progress", {
            kind: "progress",
            current: processedVideos,
            total: totalVideos,
            message: `${verb}中: ${video.filename}`,
            file: video.filename,
          });

          if (video.duration !== undefined) {
            const thumbnailResult =
              await this.thumbnailGenerator.generateThumbnails(video);
            results.push(thumbnailResult);
          }

          processedVideos++;

          this.sendProgress("thumbnail-progress", {
            kind: "progress",
            current: processedVideos,
            total: totalVideos,
            message: `${verb}完了: ${video.filename}`,
            file: video.filename,
          });
        } catch (error) {
          console.error(
            `Error generating thumbnails (${verb}):`,
            video.path,
            error,
          );
          processedVideos++;
          this.sendProgress("thumbnail-progress", {
            kind: "progress",
            current: processedVideos,
            total: totalVideos,
            message: `${verb}エラー: ${video.filename}`,
            file: video.filename,
          });
        }
      });
    }

    return results;
  }

  /**
   * メインサムネイルを指定タイムスタンプで再生成し、DB を更新して
   * 最新の動画オブジェクトを返す。
   */
  private async regenerateMainThumbnailAt(
    videoId: number,
    timestamp: number,
  ): Promise<VideoRecord | null> {
    const video = await this.db.getVideo(videoId);
    if (!video) {
      throw new Error("Video not found");
    }

    const thumbnailsDir = path.join(app.getPath("userData"), "thumbnails");
    const mainThumbnailPath = path.join(thumbnailsDir, `${video.id}_main.jpg`);

    await this.thumbnailGenerator.generateSingleThumbnail(
      video.path,
      mainThumbnailPath,
      timestamp,
    );

    await this.db.updateVideo(video.id, {
      thumbnailPath: mainThumbnailPath,
    });

    // 更新後の動画オブジェクトを返す
    return await this.db.getVideo(videoId);
  }

  setupIpcHandlers(): void {
    // Get videos
    ipcMain.handle("get-videos", async () => {
      return await this.db.getVideos();
    });

    // Get tags
    ipcMain.handle("get-tags", async () => {
      const tags = await this.db.getTags();
      return tags.map((tag) => ({ name: tag.name, count: 0 }));
    });

    // Get directories
    ipcMain.handle("get-directories", async () => {
      return await this.db.getDirectories();
    });

    // Choose directory
    ipcMain.handle("choose-directory", async () => {
      if (!this.mainWindow) return [];

      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ["openDirectory", "multiSelections"],
        title: "動画フォルダを選択",
      });

      return result.canceled ? [] : result.filePaths;
    });

    // Add directory
    ipcMain.handle("add-directory", async (_event, directoryPath: string) => {
      const id = await this.db.addDirectory(directoryPath);
      this.registeredDirectoriesCache = null;
      if (await this.isDirectoryAvailable(directoryPath)) {
        this.setDirectoryAvailability(directoryPath, "online");
        this.startWatching(directoryPath);
        await this.rememberNetworkMount(directoryPath);
      } else {
        // 追加時点でマウントされていない場合も登録は維持し、再接続を試みる
        await this.handleDirectoryUnavailable(
          directoryPath,
          "added while unavailable",
        );
      }
      return id;
    });

    // Remove directory
    ipcMain.handle(
      "remove-directory",
      async (_event, directoryPath: string) => {
        const result = await this.db.removeDirectory(directoryPath);
        this.registeredDirectoriesCache = null;
        this.stopWatching(directoryPath);
        this.forgetDirectory(directoryPath);
        return result;
      },
    );

    // Directory availability (online / offline)
    ipcMain.handle("get-directory-statuses", async () => {
      const directories = await this.db.getDirectories();
      const statuses: Record<string, DirectoryAvailability> = {};
      for (const directory of directories) {
        const known = this.directoryAvailability.get(directory.path);
        if (known === undefined) {
          // 起動時の一括チェックが終わっていない場合はバックグラウンドで確認し、
          // 結果は directory-status-changed イベントで通知する
          void this.probeDirectoryAvailability(directory.path);
          statuses[directory.path] = "online";
          continue;
        }
        statuses[directory.path] = known;
      }
      return statuses;
    });

    // Check directory exists
    ipcMain.handle(
      "check-directory-exists",
      async (_event, dirPath: string) => {
        return await this.isDirectoryAccessible(dirPath);
      },
    );

    // Scan directories (improved comprehensive scan)
    ipcMain.handle("scan-directories", async () => {
      const directories = await this.db.getDirectories();
      const directoryPaths: string[] = [];
      for (const directory of directories) {
        if (await this.isDirectoryAvailable(directory.path)) {
          directoryPaths.push(directory.path);
          continue;
        }
        // 切断中のディレクトリはスキャン対象から除外する。
        // （マウントポイントだけが残るケースで配下の動画を誤って削除しないため）
        await this.handleDirectoryUnavailable(
          directory.path,
          "skipped during scan",
        );
      }

      logger.log("Starting comprehensive scan of directories:", directoryPaths);

      // 包括的スキャンを実行
      const result = await this.videoScanner.comprehensiveScan(
        directoryPaths,
        (progress) => {
          // プログレス送信
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: progress.current,
            total: progress.total,
            message: `スキャン中: ${progress.file}`,
            file: progress.file,
          });
        },
      );

      // 削除された動画をデータベースから削除
      for (const deletedPath of result.deletedVideos) {
        try {
          await this.db.removeVideo(deletedPath);
          logger.debug(`Removed deleted video from database: ${deletedPath}`);
        } catch (error) {
          console.error(
            `Failed to remove deleted video: ${deletedPath}`,
            error,
          );
        }
      }

      // 結果をログ出力
      logger.log("Comprehensive scan completed:", {
        newVideos: result.newVideos.length,
        updatedVideos: result.updatedVideos.length,
        reprocessedVideos: result.reprocessedVideos.length,
        deletedVideos: result.deletedVideos.length,
        errors: result.errors.length,
      });

      // エラーがある場合はダイアログで詳細を表示
      if (result.errors.length > 0) {
        const errorDetails = result.errors
          .map((err) => `ファイル: ${err.filePath}\nエラー: ${err.error}`)
          .join("\n\n");

        dialog.showErrorBox(
          `スキャンエラー (${result.errors.length}件)`,
          `以下のファイルでエラーが発生しました:\n\n${errorDetails}`,
        );
      }

      // 最終プログレス送信（件数入りの文言をトーストにも流す）
      const details: string[] = [];
      if (result.newVideos.length > 0) {
        details.push(`新規: ${result.newVideos.length}件`);
      }
      if (result.updatedVideos.length > 0) {
        details.push(`更新: ${result.updatedVideos.length}件`);
      }
      if (result.reprocessedVideos.length > 0) {
        details.push(`再処理: ${result.reprocessedVideos.length}件`);
      }
      if (result.deletedVideos.length > 0) {
        details.push(`削除: ${result.deletedVideos.length}件`);
      }
      const hasChanges = details.length > 0;
      this.sendProgress("scan-progress", {
        kind: "done",
        message: hasChanges
          ? `スキャンが完了しました (${details.join(", ")})`
          : "スキャンが完了しました（変更はありませんでした）",
        type:
          result.errors.length > 0
            ? "warning"
            : hasChanges
              ? "success"
              : "info",
      });

      return {
        totalNew: result.newVideos.length,
        totalUpdated: result.updatedVideos.length,
        totalReprocessed: result.reprocessedVideos.length,
        totalDeleted: result.deletedVideos.length,
        totalErrors: result.errors.length,
        errors: result.errors,
      };
    });

    // Rescan all videos (force rescan of all existing videos)
    ipcMain.handle("rescan-all-videos", async () => {
      const directories = await this.db.getDirectories();
      const directoryPaths: string[] = [];
      for (const directory of directories) {
        if (await this.isDirectoryAvailable(directory.path)) {
          directoryPaths.push(directory.path);
          continue;
        }
        // 切断中のディレクトリは再スキャン対象から除外する（誤削除防止）
        await this.handleDirectoryUnavailable(
          directory.path,
          "skipped during rescan",
        );
      }

      logger.log(
        "Starting force rescan of all videos in directories:",
        directoryPaths,
      );

      // 全動画の強制再スキャンを実行
      const result = await this.videoScanner.forceRescanAllVideos(
        directoryPaths,
        (progress) => {
          // プログレス送信
          this.sendProgress("rescan-progress", {
            kind: "progress",
            current: progress.current,
            total: progress.total,
            message: `再スキャン中: ${progress.file}`,
            file: progress.file,
          });
        },
      );

      // 削除された動画をデータベースから削除
      for (const deletedPath of result.deletedVideos) {
        try {
          await this.db.removeVideo(deletedPath);
          logger.debug(`Removed deleted video from database: ${deletedPath}`);
        } catch (error) {
          console.error(
            `Failed to remove deleted video: ${deletedPath}`,
            error,
          );
        }
      }

      // 結果をログ出力
      logger.log("Force rescan all videos completed:", {
        totalProcessed: result.totalProcessed,
        totalUpdated: result.totalUpdated,
        totalErrors: result.totalErrors,
        deletedVideos: result.deletedVideos.length,
      });

      // エラーがある場合はダイアログで詳細を表示
      if (result.errors.length > 0) {
        const errorDetails = result.errors
          .map((err) => `ファイル: ${err.filePath}\nエラー: ${err.error}`)
          .join("\n\n");

        dialog.showErrorBox(
          `再スキャンエラー (${result.errors.length}件)`,
          `以下のファイルでエラーが発生しました:\n\n${errorDetails}`,
        );
      }

      // 再スキャン完了メッセージ（件数入りの文言をトーストにも流す）
      const rescanDetails: string[] = [`処理: ${result.totalProcessed}件`];
      if (result.totalUpdated > 0) rescanDetails.push(`更新: ${result.totalUpdated}件`);
      if (result.deletedVideos.length > 0) {
        rescanDetails.push(`削除: ${result.deletedVideos.length}件`);
      }
      if (result.totalErrors > 0) rescanDetails.push(`エラー: ${result.totalErrors}件`);
      this.sendProgress("rescan-progress", {
        kind: "done",
        message:
          result.totalProcessed === 0
            ? "再スキャン対象の動画はありませんでした"
            : `再スキャンが完了しました (${rescanDetails.join(", ")})。サムネイル生成を開始します`,
        type:
          result.totalErrors > 0
            ? "warning"
            : result.totalProcessed === 0
              ? "info"
              : "success",
      });

      // 自動的にサムネイル生成を実行
      logger.log("Starting automatic thumbnail generation after rescan...");
      try {
        const totalVideos = await this.db.getVideoCount();
        const thumbnailResults = await this.generateThumbnailsBatch(
          (limit) => this.db.getVideos("filename", "ASC", limit, 0),
          totalVideos,
          "自動サムネイル生成",
        );

        this.sendProgress("thumbnail-progress", {
          kind: "done",
          message:
            thumbnailResults.length > 0
              ? `サムネイル生成が完了しました (${thumbnailResults.length}件)`
              : "サムネイル生成の対象はありませんでした",
          type: thumbnailResults.length > 0 ? "success" : "info",
          // 再スキャン側の完了トーストで結果が分かるため、0 件時は重ねて出さない
          silent: thumbnailResults.length === 0,
        });
      } catch (error) {
        console.error("Error during automatic thumbnail generation:", error);
        this.sendProgress("thumbnail-progress", {
          kind: "done",
          message: "自動サムネイル生成でエラーが発生しました",
          type: "warning",
        });
      }

      return {
        totalProcessed: result.totalProcessed,
        totalUpdated: result.totalUpdated,
        totalReprocessed: result.totalProcessed, // 全て再処理されたので同じ値
        totalDeleted: result.deletedVideos.length,
        totalErrors: result.totalErrors,
        errors: result.errors,
      };
    });

    // Generate thumbnails
    ipcMain.handle("generate-thumbnails", async () => {
      const totalVideos = await this.db.getVideosWithoutThumbnailsCount();

      logger.log(`Starting generation of ${totalVideos} thumbnails`);

      const results = await this.generateThumbnailsBatch(
        (limit) => this.db.getVideosWithoutThumbnails(limit, 0),
        totalVideos,
        "サムネイル生成",
      );

      this.sendProgress("thumbnail-progress", {
        kind: "done",
        message:
          results.length > 0
            ? `サムネイル生成が完了しました (${results.length}件)`
            : "サムネイル生成の対象はありませんでした",
        type: results.length > 0 ? "success" : "info",
      });

      return results;
    });

    // Regenerate all thumbnails
    ipcMain.handle("regenerate-all-thumbnails", async () => {
      const totalVideos = await this.db.getVideoCount();

      logger.log(`Starting regeneration of ${totalVideos} thumbnails`);

      const results = await this.generateThumbnailsBatch(
        (limit) => this.db.getVideos("filename", "ASC", limit, 0),
        totalVideos,
        "サムネイル再生成",
      );

      this.sendProgress("thumbnail-progress", {
        kind: "done",
        message:
          results.length > 0
            ? `サムネイル再生成が完了しました (${results.length}件)`
            : "サムネイル再生成の対象はありませんでした",
        type: results.length > 0 ? "success" : "info",
      });

      return results;
    });

    // Generate thumbnails for videos with incomplete thumbnails (startup check)
    ipcMain.handle("generate-incomplete-thumbnails", async () => {
      const BATCH_SIZE = 50;
      const totalCount = await this.db.getVideoCount();
      let generatedVideos = 0;
      let scannedVideos = 0;

      logger.log(`Scanning ${totalCount} videos for incomplete thumbnails`);

      for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
        const videos = await this.db.getVideos(
          "filename",
          "ASC",
          BATCH_SIZE,
          offset,
        );

        await runConcurrent(videos, 3, async (video) => {
          scannedVideos++;
          try {
            try {
              await fs.access(video.path);
            } catch {
              return;
            }

            let isIncomplete = false;

            if (!video.thumbnailPath) {
              isIncomplete = true;
            } else {
              try {
                await fs.access(video.thumbnailPath);
              } catch {
                isIncomplete = true;
              }
            }

            if (!isIncomplete) {
              const chapters = video.chapterThumbnails || [];
              if (chapters.length === 0) {
                isIncomplete = true;
              } else {
                let anyExists = false;
                for (const chapter of chapters) {
                  try {
                    await fs.access(chapter.path);
                    anyExists = true;
                    break;
                  } catch {
                    // continue checking
                  }
                }
                if (!anyExists) {
                  isIncomplete = true;
                }
              }
            }

            if (isIncomplete) {
              this.sendProgress("thumbnail-progress", {
                kind: "progress",
                current: generatedVideos,
                total: totalCount,
                message: `サムネイル補完中: ${video.filename}`,
                file: video.filename,
                // 起動時のバックグラウンド補完はオーバーレイのみ（完了時にまとめて通知する）
                silent: true,
              });

              if (video.duration !== undefined) {
                await this.thumbnailGenerator.generateThumbnails(video);
              }

              generatedVideos++;

              this.sendProgress("thumbnail-progress", {
                kind: "progress",
                current: generatedVideos,
                total: totalCount,
                message: `サムネイル補完完了: ${video.filename}`,
                file: video.filename,
                silent: true,
              });
            }
          } catch (error) {
            console.error(
              "Error checking thumbnail completeness for:",
              video.path,
              error,
            );
          }
        });
      }

      this.sendProgress("thumbnail-progress", {
        kind: "done",
        message: `不完全なサムネイルを補完しました (${generatedVideos}/${scannedVideos})`,
        type: "info",
        // 補完対象が無かった起動では何も出さない
        silent: generatedVideos === 0,
      });

      logger.log(
        `Incomplete thumbnail generation completed: ${generatedVideos} generated out of ${scannedVideos} scanned`,
      );
      return { total: scannedVideos, generated: generatedVideos };
    });

    // Update thumbnail settings
    ipcMain.handle("update-thumbnail-settings", async (_event, settings) => {
      this.thumbnailGenerator.updateSettings(settings);
      return true;
    });

    // Cleanup thumbnails
    ipcMain.handle("cleanup-thumbnails", async () => {
      try {
        const result = await this.thumbnailGenerator.cleanupThumbnails();
        logger.log("Thumbnail cleanup completed:", result);
        return result;
      } catch (error) {
        console.error("Error during thumbnail cleanup:", error);
        throw error;
      }
    });

    // Get thumbnails directory path
    ipcMain.handle("get-thumbnails-dir", () => {
      return path.join(app.getPath("userData"), "thumbnails");
    });

    // Update video
    ipcMain.handle(
      "update-video",
      async (_event, videoId: number, data: VideoUpdateData) => {
        return await this.db.updateVideo(videoId, data);
      },
    );

    // Add tag to video
    ipcMain.handle(
      "add-tag-to-video",
      async (_event, videoId: number, tagName: string) => {
        return await this.db.addTagToVideo(videoId, tagName);
      },
    );

    // Remove tag from video
    ipcMain.handle(
      "remove-tag-from-video",
      async (_event, videoId: number, tagName: string) => {
        return await this.db.removeTagFromVideo(videoId, tagName);
      },
    );

    // Update tag
    ipcMain.handle(
      "update-tag",
      async (_event, oldName: string, newName: string) => {
        return await this.db.updateTag(oldName, newName);
      },
    );

    // Delete tag
    ipcMain.handle("delete-tag", async (_event, tagName: string) => {
      return await this.db.deleteTag(tagName);
    });

    // Generate preview thumbnail at specific timestamp
    ipcMain.handle(
      "generate-preview-thumbnail",
      async (_event, videoPath: string, timestamp: number) => {
        try {
          const path = await import("path");
          const { app } = await import("electron");
          const tmpDir = app.getPath("temp");
          const previewPath = path.join(tmpDir, `preview_${Date.now()}.jpg`);

          await this.thumbnailGenerator.generateSingleThumbnail(
            videoPath,
            previewPath,
            timestamp,
          );

          return previewPath;
        } catch (error) {
          console.error("Error generating preview thumbnail:", error);
          throw error;
        }
      },
    );

    // Regenerate main thumbnail (without custom timestamp)
    ipcMain.handle(
      "regenerate-main-thumbnail",
      async (_event, videoId: number) => {
        try {
          const video = await this.db.getVideo(videoId);
          if (!video) {
            throw new Error("Video not found");
          }

          // Use random timestamp (10% to 90% into the video)
          const randomPercent = 0.1 + Math.random() * 0.8; // 0.1 to 0.9
          const timestamp = video.duration * randomPercent;

          return await this.regenerateMainThumbnailAt(videoId, timestamp);
        } catch (error) {
          console.error("Error regenerating main thumbnail:", error);
          throw error;
        }
      },
    );

    // Regenerate main thumbnail with custom timestamp
    ipcMain.handle(
      "regenerate-main-thumbnail-with-timestamp",
      async (_event, videoId: number, timestamp: number) => {
        try {
          return await this.regenerateMainThumbnailAt(videoId, timestamp);
        } catch (error) {
          console.error(
            "Error regenerating main thumbnail with timestamp:",
            error,
          );
          throw error;
        }
      },
    );

    // Find duplicate videos
    // 拡張子チェック: 「拡張子不一致 or 内蔵再生不可コンテナ」の動画を列挙する
    ipcMain.handle("check-container-mismatches", async () => {
      const videos = await this.db.getVideos();
      const items: ContainerMismatchItem[] = [];
      let checkedCount = 0;

      await runConcurrent(videos, 4, async (video) => {
        try {
          const head = await readFileHead(video.path, 512);
          if (head === null) return;

          const kind = detectContainerKind(head);
          if (kind === "unknown") return; // 判定不能は対象外

          const extension = path.extname(video.path).toLowerCase();
          const verdict = classifyContainer(kind, extension);
          checkedCount++;

          if (!verdict.nativePlayable || verdict.extensionMismatch) {
            items.push({
              videoId: video.id,
              path: video.path,
              filename: video.filename,
              size: Number(video.size ?? 0),
              extension,
              detectedKind: kind,
              detectedLabel: containerLabel(kind),
              nativePlayable: verdict.nativePlayable,
              extensionMismatch: verdict.extensionMismatch,
              convertible: extension === ".mp4" || extension === ".m4v",
            });
          }
        } catch (error) {
          console.error("Error checking container:", video.path, error);
        } finally {
          this.sendOperationProgress("container-check-progress", {
            current: checkedCount,
            total: videos.length,
            message: `確認中: ${video.filename}`,
          });
        }
      });

      logger.log(
        `Container check completed: ${items.length} mismatches / ${videos.length} videos`,
      );
      return items;
    });

    // 選択動画をストリームコピーで MP4 にリマックスし、元ファイルを上書きする
    ipcMain.handle(
      "convert-videos-to-mp4",
      async (_event, videoIds: number[]) => {
        const ffmpegPath = await getFfmpegPath();
        if (!ffmpegPath) {
          throw new Error("FFmpeg binary not found");
        }

        const items: ConvertItemResult[] = [];
        let succeeded = 0;
        let failed = 0;
        const total = videoIds.length;

        for (let i = 0; i < total; i++) {
          const videoId = videoIds[i] ?? 0;
          try {
            const video = await this.db.getVideo(videoId);
            if (!video) throw new Error("動画が見つかりません");

            const extension = path.extname(video.path).toLowerCase();
            if (extension !== ".mp4" && extension !== ".m4v") {
              throw new Error(
                "拡張子が mp4/m4v ではないため上書き変換できません",
              );
            }

            this.sendOperationProgress("container-convert-progress", {
              current: i,
              total,
              message: `変換中: ${video.filename}`,
            });

            await remuxToMp4(ffmpegPath, video.path);

            succeeded++;
            items.push({ path: video.path, ok: true });
            logger.log(`Remuxed to MP4: ${video.path}`);
          } catch (e) {
            failed++;
            const message =
              e instanceof Error ? e.message : String(e);
            console.error(`Failed to convert video ${videoId}:`, message);
            const fallbackPath =
              (await this.db.getVideo(videoId))?.path ?? `(id:${videoId})`;
            items.push({
              path: fallbackPath,
              ok: false,
              error: message,
            });
          }

          this.sendOperationProgress("container-convert-progress", {
            current: i + 1,
            total,
            message: `変換完了 (${i + 1}/${total})`,
          });
        }

        logger.log(
          `Batch remux completed: ${succeeded} succeeded, ${failed} failed`,
        );
        const result: ConvertVideosResult = { succeeded, failed, items };
        return result;
      },
    );

    ipcMain.handle("find-duplicates", async () => {
      try {
        return await this.duplicateDetector.findDuplicates(
          (current, total, message) => {
            this.mainWindow?.webContents.send("duplicate-search-progress", {
              current,
              total,
              message,
            });
          },
        );
      } catch (error) {
        console.error("Failed to find duplicates:", error);
        throw error;
      }
    });

    // Delete videos (duplicate cleanup)
    ipcMain.handle(
      "delete-videos",
      async (
        _event,
        requests: DeleteVideoRequest[],
        moveToTrash: boolean = true,
      ) => {
        try {
          const result = await this.duplicateDetector.deleteVideos(
            requests,
            moveToTrash,
            (current, total) => {
              this.mainWindow?.webContents.send("delete-progress", {
                current,
                total,
              });
            },
          );
          return result;
        } catch (error) {
          console.error("Failed to delete videos:", error);
          throw error;
        }
      },
    );

    // Open video
    ipcMain.handle("open-video", async (_event, videoPath: string) => {
      await shell.openPath(videoPath);
    });

    // フレームキャプチャ（最高画質スクリーンショット）
    // ffmpeg で指定タイムスタンプのフレームを PNG として保存する
    ipcMain.handle(
      "capture-frame",
      async (
        _event,
        videoPath: string,
        timestamp: number,
        outputDir: string,
      ) => {
        try {
          const ffmpegPath = await getFfmpegPath();
          if (!ffmpegPath) {
            throw new Error("FFmpeg binary not found");
          }

          await fs.mkdir(outputDir, { recursive: true });

          // ファイル名: <動画ファイル名>_<タイムスタンプ>.png
          // （パスに使えない文字を除去）
          const parsed = path.parse(videoPath);
          const safeBase = parsed.name.replace(/[\\/:*?"<>|]/g, "_");
          const tsLabel = timestamp.toFixed(1).replace(".", "_");
          const outputPath = path.join(outputDir, `${safeBase}_${tsLabel}.png`);

          // 最高画質: PNG（ロスレス）。-ss を -i の前に置いて高速シーク
          const args = [
            "-ss",
            timestamp.toFixed(3),
            "-i",
            videoPath,
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-y", // 上書き
            outputPath,
          ];

          logger.debug("🎬 Capturing frame:", ffmpegPath, args.join(" "));

          await execFileAsync(ffmpegPath, args, {
            maxBuffer: 1024 * 1024 * 10,
          });

          logger.log("✅ Frame captured:", outputPath);
          return { success: true, outputPath } as const;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error("❌ Failed to capture frame:", message);
          return { success: false, error: message } as const;
        }
      },
    );

    // スクリーンショット保存先フォルダの選択ダイアログ
    ipcMain.handle("select-screenshot-dir", async () => {
      const result = await dialog.showOpenDialog({
        title: "スクリーンショットの保存先フォルダを選択",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    });

    // Check for video updates
    ipcMain.handle(
      "has-video-updates",
      async (_event, lastCheckTime: number) => {
        return await this.db.hasVideoUpdates(lastCheckTime);
      },
    );
  }

  async generateThumbnailsForSingleVideo(video: ProcessedVideo): Promise<boolean> {
    try {
      if (video.id !== undefined) {
        await this.thumbnailGenerator.generateThumbnails(video);
        logger.debug("Thumbnails generated for:", video.path);
        return true;
      }
      return false;
    } catch (error) {
      console.error("Error generating thumbnails for:", video.path, error);
      return false;
    }
  }

  // ============================================================
  // ディレクトリの可用性判定と再接続（NAS / SMB 切断対策）
  // ============================================================

  /** タイムアウト付きでディレクトリへアクセスできるか確認する */
  private async isDirectoryAccessible(dirPath: string): Promise<boolean> {
    try {
      await withTimeout(fs.access(dirPath), FS_CHECK_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * パスが「本当に存在しない」と確認できるか調べる。
   * 登録ディレクトリ（マウント）が生きていれば、パスが無いのは本当の削除。
   * マウントごと見えなくなっている場合（アンマウント後にマウントポイントだけが
   * 残るケースを含む）は切断と区別が付かないため「不明」として扱う。
   */
  private async checkPathState(targetPath: string): Promise<PathState> {
    try {
      await withTimeout(fs.access(targetPath), FS_CHECK_TIMEOUT_MS);
      return "present";
    } catch (error) {
      if (!isNotExistError(error)) {
        if (isTransientFsError(error)) {
          // 切断中は多数のパスで発生し得るため、通常のデバッグログに留める
          logger.debug(
            `Transient I/O error while checking (${fsErrorCode(error)}):`,
            targetPath,
          );
        } else {
          logger.debug(
            `Path check failed, deferring removal (${fsErrorCode(error) ?? "unknown"}):`,
            targetPath,
          );
        }
        return "unknown";
      }
    }

    // ENOENT: 所属する登録ディレクトリ（＝マウント）が生きているかを確認する
    const owner = await this.findRegisteredDirectoryOwner(targetPath);
    if (owner === null) {
      logger.debug("Path is outside registered directories:", targetPath);
      return "unknown";
    }
    const recordedNetworkMountMissing =
      await this.isRecordedNetworkMountMissing(owner);
    const ownerAccessible = recordedNetworkMountMissing
      ? false
      : await this.isDirectoryAccessible(owner);
    return classifyMissingPath({
      hasRegisteredOwner: true,
      isRegisteredDirectoryItself: owner === targetPath,
      ownerAccessible,
      recordedNetworkMountMissing,
    });
  }

  /**
   * 以前 SMB マウントだったマウントポイントが、現在のマウント一覧に存在しないか。
   * アンマウント後も空ディレクトリが残るケースで「アクセスできる＝生きている」と
   * 誤判定しないための確認。
   */
  private async isRecordedNetworkMountMissing(
    targetPath: string,
  ): Promise<boolean> {
    await this.loadNetworkMountUrls();
    if (this.networkMountUrls.size === 0) {
      return false;
    }
    let recordedMountPoint: string | null = null;
    for (const mountPoint of this.networkMountUrls.keys()) {
      if (!isPathUnderDirectory(targetPath, mountPoint)) {
        continue;
      }
      if (
        recordedMountPoint === null ||
        mountPoint.length > recordedMountPoint.length
      ) {
        recordedMountPoint = mountPoint;
      }
    }
    if (recordedMountPoint === null) {
      return false;
    }
    const entries = await this.getMountEntries();
    return !entries.some((entry) => entry.mountPoint === recordedMountPoint);
  }

  /** ディレクトリが利用可能か（アクセス可能かつ、以前の SMB マウントが消えていない） */
  private async isDirectoryAvailable(dirPath: string): Promise<boolean> {
    if (await this.isRecordedNetworkMountMissing(dirPath)) {
      return false;
    }
    return await this.isDirectoryAccessible(dirPath);
  }

  /**
   * 削除と断定する前に再確認する。
   * NAS（ネットワークマウント）配下や状態不明の場合は 3秒 / 10秒 / 30秒と長めに確認し、
   * ローカルパスで明確に存在しない場合は短い確認に留める。
   * 1度でも存在が確認できれば "present"、最後まで不明なら "unknown"。
   */
  private async confirmRemoval(targetPath: string): Promise<PathState> {
    let state = await this.checkPathState(targetPath);
    const isNetworkPath =
      state === "unknown" || (await this.isUnderNetworkMount(targetPath));
    const waitMsList = isNetworkPath
      ? MISSING_CONFIRM_DELAYS_MS
      : LOCAL_MISSING_CONFIRM_DELAYS_MS;

    for (const waitMs of waitMsList) {
      if (state === "present") {
        return "present";
      }
      await delay(waitMs);
      state = await this.checkPathState(targetPath);
    }
    return state;
  }

  /** パスがネットワークマウント（NAS など）の配下かどうか */
  private async isUnderNetworkMount(targetPath: string): Promise<boolean> {
    const mount = findMountForPath(targetPath, await this.getMountEntries());
    return isNetworkMount(mount);
  }

  private setDirectoryAvailability(
    dirPath: string,
    status: DirectoryAvailability,
  ): void {
    const previous = this.directoryAvailability.get(dirPath);
    if (previous === status) {
      return;
    }
    this.directoryAvailability.set(dirPath, status);
    const payload: DirectoryStatus = {
      path: dirPath,
      status,
      previousStatus: previous,
    };
    this.mainWindow?.webContents.send("directory-status-changed", payload);
    logger.log(`Directory ${status}:`, dirPath);
  }

  /** マウント一覧を取得する（短時間はキャッシュする） */
  private async getMountEntries(force = false): Promise<MountEntry[]> {
    const now = Date.now();
    if (
      !force &&
      this.mountEntriesCache !== null &&
      now - this.mountEntriesCache.at < 5000
    ) {
      return this.mountEntriesCache.entries;
    }
    const entries = await readMountEntries();
    this.mountEntriesCache = { at: now, entries };
    return entries;
  }

  private networkMountInfoPath(): string {
    return path.join(app.getPath("userData"), "network-mounts.json");
  }

  /** 再マウント用の SMB URL をファイルから読み込む */
  private async loadNetworkMountUrls(): Promise<void> {
    if (this.networkMountUrlsLoaded) {
      return;
    }
    try {
      const raw = await fs.readFile(this.networkMountInfoPath(), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        for (const [mountPoint, url] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof url === "string" && url.startsWith("smb://")) {
            this.networkMountUrls.set(mountPoint, url);
          }
        }
      }
      this.networkMountUrlsLoaded = true;
    } catch (error) {
      if (isNotExistError(error)) {
        // まだ記録ファイルが無いだけ
        this.networkMountUrlsLoaded = true;
        return;
      }
      // 破損・権限エラー時は次回また読み込む（空の内容で上書きしない）
      logger.debug("Failed to load network mount info:", error);
    }
  }

  private async saveNetworkMountUrls(): Promise<void> {
    try {
      const filePath = this.networkMountInfoPath();
      // 読み込みに失敗した場合に備え、既存ファイルの内容とマージしてから保存する
      const merged: Record<string, string> = {};
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") {
          for (const [mountPoint, url] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (typeof url === "string") {
              merged[mountPoint] = url;
            }
          }
        }
      } catch {
        // 既存ファイルが無い・壊れている場合はメモリ上の内容のみ保存する
      }
      for (const [mountPoint, url] of this.networkMountUrls) {
        merged[mountPoint] = url;
      }

      // 書き込み途中のクラッシュで既存の記録を壊さないよう一時ファイル経由で置き換える
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.debug("Failed to save network mount info:", error);
    }
  }

  /**
   * アクセスできたタイミングで、所属する SMB 共有の URL を記録しておく。
   * 切断後に再マウントするには、接続中のうちに情報を残しておく必要がある。
   */
  private async rememberNetworkMount(dirPath: string): Promise<void> {
    await this.loadNetworkMountUrls();
    const mount = findMountForPath(dirPath, await this.getMountEntries());
    const url = smbUrlFromSource(mount);
    if (mount === null || url === null) {
      return;
    }
    if (this.networkMountUrls.get(mount.mountPoint) === url) {
      return;
    }
    this.networkMountUrls.set(mount.mountPoint, url);
    await this.saveNetworkMountUrls();
    logger.debug(
      `Recorded SMB mount for remount: ${mount.mountPoint} -> ${url}`,
    );
  }

  /** 登録ディレクトリに紐づく SMB URL を探す（最も深いマウントポイントを優先） */
  private findRemountUrl(dirPath: string): string | null {
    let bestMountPoint: string | null = null;
    let bestUrl: string | null = null;
    for (const [mountPoint, url] of this.networkMountUrls) {
      if (!isPathUnderDirectory(dirPath, mountPoint)) {
        continue;
      }
      if (bestMountPoint === null || mountPoint.length > bestMountPoint.length) {
        bestMountPoint = mountPoint;
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  /**
   * アンマウントされた SMB 共有を再マウントする。
   * Finder 経由（osascript → 失敗時は open）で行うため、Keychain に保存済みの
   * 認証情報がそのまま使われる。未保存の場合は Finder が入力を求める。
   */
  private async attemptRemount(dirPath: string): Promise<boolean> {
    if (process.platform !== "darwin") {
      return false;
    }
    const entries = await this.getMountEntries(true);

    await this.loadNetworkMountUrls();
    const url = this.findRemountUrl(dirPath);
    if (url === null) {
      logger.debug(
        "No SMB URL recorded for directory; cannot remount automatically:",
        dirPath,
      );
      return false;
    }

    // 共有自体が（別のマウントポイントでも）マウント済みなら再マウントは不要
    const mountedEntry = entries.find(
      (entry) => smbUrlFromSource(entry) === url,
    );
    if (mountedEntry !== undefined) {
      logger.debug(
        "SMB share is already mounted; skipping remount:",
        mountedEntry.mountPoint,
      );
      return false;
    }

    logger.log(`Attempting to remount ${url} for ${dirPath}`);
    const script = `mount volume ${JSON.stringify(url)}`;
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", script], {
        timeout: MOUNT_WAIT_MS,
      });
    } catch (error) {
      logger.debug(
        "osascript mount volume failed, falling back to open:",
        fsErrorCode(error) ?? error,
      );
      try {
        await execFileAsync("/usr/bin/open", [url], { timeout: 15000 });
      } catch (openError) {
        console.error("Failed to remount SMB share:", url, openError);
        return false;
      }
    }

    // マウント完了を待つ（完了前に fs.access すると失敗するため）
    const deadline = Date.now() + MOUNT_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.isDirectoryAvailable(dirPath)) {
        return true;
      }
      await delay(1000);
    }
    return false;
  }

  private clearReconnectTimer(dirPath: string): void {
    const timer = this.reconnectTimers.get(dirPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(dirPath);
    }
  }

  private scheduleReconnect(dirPath: string, delayMs: number): void {
    this.clearReconnectTimer(dirPath);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(dirPath);
      void this.tryReconnect(dirPath);
    }, delayMs);
    timer.unref();
    this.reconnectTimers.set(dirPath, timer);
  }

  /**
   * ディレクトリが見えなくなったときの共通処理。
   * 登録は削除せず、オフラインとして保持したうえで再接続（必要なら再マウント）を試みる。
   */
  private async handleDirectoryUnavailable(
    dirPath: string,
    reason: string,
  ): Promise<void> {
    // 見えていないパスを watch し続けても意味がないため一旦止める（復帰時に張り直す）
    this.stopWatching(dirPath);
    this.setDirectoryAvailability(dirPath, "offline");

    if (
      this.reconnectTimers.has(dirPath) ||
      this.reconnectRunning.has(dirPath)
    ) {
      return; // すでに再接続待ち・再接続処理中
    }
    logger.log(`Directory unavailable (${reason}):`, dirPath);
    this.reconnectAttempts.set(dirPath, 0);
    this.scheduleReconnect(dirPath, RECONNECT_DELAYS_MS[0]);
  }

  /** オフラインから復帰したときの処理 */
  private async markDirectoryOnline(dirPath: string): Promise<void> {
    if (!(await this.isDirectoryRegistered(dirPath))) {
      // ユーザーが登録解除した後に復帰した場合は何もしない
      this.forgetDirectory(dirPath);
      return;
    }
    this.clearReconnectTimer(dirPath);
    this.reconnectAttempts.delete(dirPath);
    this.setDirectoryAvailability(dirPath, "online");
    if (!this.watchers.has(dirPath)) {
      this.startWatching(dirPath);
    }
    await this.rememberNetworkMount(dirPath);
  }

  /** 再接続を試みる（成功するまで間隔を空けて繰り返す） */
  private async tryReconnect(dirPath: string): Promise<void> {
    if (this.reconnectRunning.has(dirPath)) {
      return;
    }
    this.reconnectRunning.add(dirPath);
    try {
      if (!(await this.isDirectoryRegistered(dirPath))) {
        this.forgetDirectory(dirPath);
        return;
      }

      const attempt = (this.reconnectAttempts.get(dirPath) ?? 0) + 1;
      this.reconnectAttempts.set(dirPath, attempt);

      if (await this.isDirectoryAvailable(dirPath)) {
        await this.markDirectoryOnline(dirPath);
        logger.log(`Directory reconnected (attempt ${attempt}):`, dirPath);
        return;
      }

      if (attempt <= MAX_CONSECUTIVE_MOUNT_ATTEMPTS || attempt % 10 === 0) {
        if (await this.attemptRemount(dirPath)) {
          await this.markDirectoryOnline(dirPath);
          logger.log("Directory remounted and reconnected:", dirPath);
          return;
        }
      }

      // 実行中にユーザーが登録解除した場合はチェーンを止める
      if (!(await this.isDirectoryRegistered(dirPath))) {
        this.forgetDirectory(dirPath);
        return;
      }
      const index = Math.min(attempt, RECONNECT_DELAYS_MS.length - 1);
      this.scheduleReconnect(dirPath, RECONNECT_DELAYS_MS[index]);
    } finally {
      this.reconnectRunning.delete(dirPath);
    }
  }

  /** ディレクトリが DB に登録されているか */
  private async isDirectoryRegistered(dirPath: string): Promise<boolean> {
    const directories = await this.db.getDirectories();
    return directories.some((directory) => directory.path === dirPath);
  }

  /** 登録解除されたディレクトリの状態を破棄する */
  private forgetDirectory(dirPath: string): void {
    this.clearReconnectTimer(dirPath);
    this.reconnectAttempts.delete(dirPath);
    this.directoryAvailability.delete(dirPath);
  }

  /**
   * 起動直後などで状態が未確定のディレクトリを確認し、結果をイベントで通知する。
   * （起動時の一括チェックが終わる前に描画側が状態を取得した場合の保険）
   */
  private async probeDirectoryAvailability(dirPath: string): Promise<void> {
    if (this.directoryAvailability.has(dirPath)) {
      return;
    }
    if (await this.isDirectoryAvailable(dirPath)) {
      this.setDirectoryAvailability(dirPath, "online");
      return;
    }
    await this.handleDirectoryUnavailable(dirPath, "initial check failed");
  }

  /**
   * ファイルが読めない原因がディレクトリ（マウント）自体の消失かどうかを確認し、
   * 該当する場合は所属ディレクトリをオフライン扱いにして再接続を開始する。
   */
  private async handleUnreachablePath(targetPath: string): Promise<void> {
    const owner = await this.findRegisteredDirectoryOwner(targetPath);
    if (owner === null) {
      return;
    }
    if (this.directoryAvailability.get(owner) === "offline") {
      // すでにオフライン処理済み（切断時に多数の unlink が来ても二重処理しない）
      return;
    }
    if (await this.isDirectoryAvailable(owner)) {
      // ディレクトリ自体は利用可能 → 個別ファイルの問題なので登録には触れない
      return;
    }
    await this.handleDirectoryUnavailable(
      owner,
      "contained path became unreachable",
    );
  }

  /** パスを含む登録ディレクトリを返す（最も深いものを優先） */
  private async findRegisteredDirectoryOwner(
    targetPath: string,
  ): Promise<string | null> {
    const paths = await this.getRegisteredDirectoryPaths();
    let owner: string | null = null;
    for (const dirPath of paths) {
      if (!isPathUnderDirectory(targetPath, dirPath)) {
        continue;
      }
      if (owner === null || dirPath.length > owner.length) {
        owner = dirPath;
      }
    }
    return owner;
  }

  /** 登録ディレクトリのパス一覧（短時間キャッシュ。切断時の大量イベント対策） */
  private async getRegisteredDirectoryPaths(): Promise<string[]> {
    const now = Date.now();
    if (
      this.registeredDirectoriesCache !== null &&
      now - this.registeredDirectoriesCache.at < 5000
    ) {
      return this.registeredDirectoriesCache.paths;
    }
    const directories = await this.db.getDirectories();
    const paths = directories.map((directory) => directory.path);
    this.registeredDirectoriesCache = { at: now, paths };
    return paths;
  }

  /**
   * ネットワークマウントの定期チェックを開始する。
   * 共有が stale になった場合、ファイル監視イベントが来ないまま
   * 「接続できているように見える」状態が続くことがあるため、能動的に確認する。
   */
  private startNetworkHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      void this.checkNetworkDirectoriesHealth();
    }, NETWORK_HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckTimer.unref();
  }

  private async checkNetworkDirectoriesHealth(): Promise<void> {
    if (this.healthCheckRunning) {
      return;
    }
    this.healthCheckRunning = true;
    try {
      const directories = await this.getRegisteredDirectoryPaths();
      for (const dirPath of directories) {
        if (this.directoryAvailability.get(dirPath) !== "online") {
          continue; // オフライン中のディレクトリは再接続処理側で確認している
        }
        if (!(await this.isUnderNetworkMount(dirPath))) {
          continue; // ローカルディスクは対象外
        }
        if (await this.isDirectoryAvailable(dirPath)) {
          continue;
        }
        await this.handleDirectoryUnavailable(
          dirPath,
          "periodic health check failed",
        );
      }
    } finally {
      this.healthCheckRunning = false;
    }
  }

  startWatching(directoryPath: string): void {
    if (this.watchers.has(directoryPath)) {
      return;
    }

    logger.debug("Starting to watch directory:", directoryPath);

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on("add", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          logger.debug("Processing new video file:", filePath);

          // プログレス通知を送信（トーストは追加完了時にまとめて出す）
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `新しい動画を処理中: ${path.basename(filePath)}`,
            silent: true,
          });

          const video = await this.videoScanner.processFile(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-added", filePath);
          }

          // 追加処理の完了。完了イベントが無いと進捗表示にエントリが残留する
          this.sendProgress("scan-progress", {
            kind: "done",
            message: video
              ? `新しい動画が追加されました: ${path.basename(filePath)}`
              : "新しい動画は追加されませんでした",
            type: video ? "success" : "info",
            silent: video === null,
          });

          // 新しく追加された動画で、サムネイル生成が必要な場合のみ実行
          if (video && video.needsThumbnails) {
            logger.debug(
              "Auto-generating thumbnails for new video:",
              video.path,
            );

            // サムネイル生成の進捗通知（トーストは完了時に出す）
            this.sendProgress("thumbnail-progress", {
              kind: "progress",
              current: 0,
              total: 1,
              message: `サムネイル生成中: ${video.filename}`,
              file: video.filename,
              silent: true,
            });

            const generated = await this.generateThumbnailsForSingleVideo(video);

            // 完了通知（トーストにも流す）
            this.sendProgress("thumbnail-progress", {
              kind: "done",
              message: generated
                ? `サムネイル生成が完了しました: ${video.filename}`
                : `サムネイルの生成に失敗しました: ${video.filename}`,
              type: generated ? "success" : "error",
            });
          } else if (video && !video.needsThumbnails) {
            logger.debug(
              "Video already has thumbnails, skipping generation:",
              video.path,
            );
          }

          logger.debug("New video processed successfully:", filePath);
        } catch (error) {
          console.error("Error processing new video file:", filePath, error);
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `新しい動画の追加に失敗しました: ${path.basename(filePath)}`,
            type: "error",
          });
        }
      }
    });

    watcher.on("unlink", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          logger.debug("Processing video file removal:", filePath);

          // 接続エラー中のディレクトリでは削除確認をスキップする
          // （切断時に大量の unlink が来て fs 呼び出しが滞留するのを防ぐ）
          const owner = await this.findRegisteredDirectoryOwner(filePath);
          if (owner !== null) {
            if (this.directoryAvailability.get(owner) === "offline") {
              logger.debug(
                "Skipping removal check for offline directory:",
                filePath,
              );
              return;
            }
            if (!(await this.isDirectoryAvailable(owner))) {
              // マウント自体が見えない → ファイル個別の削除判定はせず接続エラーとして扱う
              await this.handleDirectoryUnavailable(
                owner,
                "file unlinked while directory is unreachable",
              );
              return;
            }
          }

          // 外付けドライブや NAS の一時的な切断で「消えたように見える」ことがあるため、
          // 3秒 / 10秒 / 30秒と再確認し、所属ディレクトリ（マウント）が生きている
          // 状態でファイルが無いと確認できた場合のみ削除する。
          const state = await this.confirmRemoval(filePath);
          if (state !== "missing") {
            logger.debug(
              `Deferring video removal (${state}):`,
              filePath,
            );
            if (state === "unknown") {
              // マウント消失が疑われる場合は、所属ディレクトリをオフラインにして再接続を試みる
              await this.handleUnreachablePath(filePath);
            }
            return;
          }

          // プログレス通知を送信（トーストは削除完了時にまとめて出す）
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `動画を削除中: ${path.basename(filePath)}`,
            silent: true,
          });

          await this.db.removeVideo(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-removed", filePath);
          }

          // 完了通知（トーストにも流す）
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `動画が削除されました: ${path.basename(filePath)}`,
            type: "info",
          });

          logger.debug("Video file removal processed successfully:", filePath);
        } catch (error) {
          console.error(
            "Error processing video file removal:",
            filePath,
            error,
          );
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `動画の削除に失敗しました: ${path.basename(filePath)}`,
            type: "error",
          });
        }
      }
    });

    // ディレクトリ自体の削除を監視
    watcher.on("unlinkDir", async (dirPath: string) => {
      // 監視しているディレクトリ自体が削除された場合
      if (dirPath === directoryPath) {
        try {
          logger.debug("Directory unlinkDir event:", dirPath);

          // 外付けドライブや NAS の一時的な切断で「消えたように見える」ことがあるため、
          // 削除と断定する前に複数回（3秒 / 10秒 / 30秒）再確認する
          const state = await this.confirmRemoval(dirPath);
          if (state === "present") {
            logger.debug("Directory re-appeared, keeping watch:", dirPath);
            return;
          }

          // 本当に無くなっている場合でも、NAS の切断と区別が付かないため登録は削除しない。
          // オフライン扱いにして再接続を試み、削除はユーザーの明示操作（UI の削除）のみとする。
          await this.handleDirectoryUnavailable(
            dirPath,
            `watch root unavailable (${state})`,
          );
        } catch (error) {
          console.error("Error processing directory removal:", dirPath, error);
        }
      }
    });

    this.watchers.set(directoryPath, watcher);
  }

  stopWatching(directoryPath: string): void {
    const watcher = this.watchers.get(directoryPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(directoryPath);
    }
  }

  async startWatchingAllDirectories(): Promise<void> {
    await this.loadNetworkMountUrls();
    const directories = await this.db.getDirectories();

    for (const directory of directories) {
      if (await this.isDirectoryAvailable(directory.path)) {
        this.setDirectoryAvailability(directory.path, "online");
        this.startWatching(directory.path);
        // 切断後に再マウントできるよう、接続中に SMB URL を記録しておく
        await this.rememberNetworkMount(directory.path);
        continue;
      }

      // 起動時に共有がまだマウントされていないケース（ログイン直後・スリープ復帰など）。
      // ここで登録を削除すると NAS のフォルダが勝手に消えるため、オフライン扱いで維持し、
      // 再接続（必要なら SMB の再マウント）を試みる。
      await this.handleDirectoryUnavailable(
        directory.path,
        "not accessible at startup",
      );
    }

    // stale マウント対策として定期的な確認を開始する
    this.startNetworkHealthCheck();
  }

  // アプリケーションのクリーンアップメソッド
  // （watcher 停止と DB 切断を完了させてから終了するため async）
  public async cleanup(): Promise<void> {
    logger.log("Cleaning up application resources...");

    // すべてのwatcherを停止
    this.watchers.forEach((watcher) => {
      try {
        watcher.close();
      } catch (error) {
        console.error("Error closing watcher:", error);
      }
    });
    this.watchers.clear();

    // 再接続タイマーを停止（終了を妨げないように）
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // 定期ヘルスチェックを停止
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // データベース接続を閉じる（$disconnect で WAL をフラッシュ）
    try {
      if (this.db) {
        await this.db.close();
      }
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}

const movieApp = new MovieLibraryApp();

app.whenReady().then(async () => {
  // macOS固有の設定
  if (process.platform === "darwin") {
    // Dockアイコンの設定（nativeImage が確実に扱える PNG を使用）
    const iconPath = path.join(__dirname, "../../assets", "icon.png");
    if (
      await fs
        .access(iconPath)
        .then(() => true)
        .catch(() => false)
    ) {
      try {
        // app.dock は macOS でのみ存在する
        app.dock?.setIcon(iconPath);
        logger.log("Dock icon set successfully");
      } catch (error) {
        console.warn("Failed to set dock icon:", error);
      }
    } else {
      console.warn("Icon file not found:", iconPath);
    }
  }

  try {
    logger.log("Initializing Movie Library App...");
    logger.log("App packaged:", app.isPackaged);
    logger.log("Platform:", process.platform);
    logger.log("Architecture:", process.arch);

    await movieApp.initialize();
    logger.log("App initialized successfully");

    movieApp.createWindow();
    logger.log("Window created successfully");

    await movieApp.startWatchingAllDirectories();
    logger.log("Directory watching started successfully");
  } catch (error) {
    console.error("Failed to initialize app:", error);

    // エラーダイアログを表示
    const errorMessage = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      "Initialization Error",
      `Failed to start Movie Library: ${errorMessage}`,
    );

    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      movieApp.createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // すべてのプラットフォームでアプリを完全に終了
  // （watcher 停止・DB 切断などのクリーンアップは before-quit で一括実施）
  app.quit();
});

// before-quit で DB の WAL フラッシュを完了させてから終了する
// （$disconnect() 完了後に process.exit で即座に終了する。
//    app.quit() による通常シャットダウンは V8 isolate 破棄中に Prisma クエリエンジンの
//    tokio ワーカースレッドが v8::String::MakeExternal を呼び EXC_BREAKPOINT でクラッシュするため）
let quitCleanupDone = false;
app.on("before-quit", (event) => {
  if (quitCleanupDone) {
    return;
  }
  event.preventDefault();
  movieApp
    .cleanup()
    .catch((error) => {
      console.error("Error during cleanup:", error);
    })
    .finally(() => {
      quitCleanupDone = true;
      // $disconnect() 完了後なので SQLite の WAL はフラッシュ済み（データは安全）。
      // V8 isolate の破棄（v8::Isolate::Dispose）をスキップして即座に終了し、
      // Prisma エンジンのワーカースレッドによる破棄中 isolate へのアクセスを防ぐ。
      process.exit(0);
    });
});

app.on("will-quit", () => {
  logger.log("Application will quit");
});

// プロセス終了時の処理（開発時の Ctrl+C 等でもクリーンアップを経由して終了）
process.on("SIGINT", () => {
  logger.log("Received SIGINT, shutting down gracefully");
  app.quit();
});

process.on("SIGTERM", () => {
  logger.log("Received SIGTERM, shutting down gracefully");
  app.quit();
});

// ターミナルが閉じられたときの処理（macOS / Linux）
process.on("SIGHUP", () => {
  logger.log("Received SIGHUP, shutting down gracefully");
  app.quit();
});
