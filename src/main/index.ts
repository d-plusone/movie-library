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
} from "../types/types.js";
import {
  classifyContainer,
  containerLabel,
  detectContainerKind,
} from "../utils/container.js";
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
      this.startWatching(directoryPath);
      return id;
    });

    // Remove directory
    ipcMain.handle(
      "remove-directory",
      async (_event, directoryPath: string) => {
        const result = await this.db.removeDirectory(directoryPath);
        this.stopWatching(directoryPath);
        return result;
      },
    );

    // Check directory exists
    ipcMain.handle(
      "check-directory-exists",
      async (_event, dirPath: string) => {
        try {
          const fs = await import("fs");
          await fs.promises.access(dirPath, fs.constants.F_OK);
          return true;
        } catch (_error) {
          return false;
        }
      },
    );

    // Scan directories (improved comprehensive scan)
    ipcMain.handle("scan-directories", async () => {
      const directories = await this.db.getDirectories();
      const directoryPaths = directories.map((d) => d.path);

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

      // 最終プログレス送信
      this.sendProgress("scan-progress", {
        kind: "done",
        message: "スキャン完了",
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
      const directoryPaths = directories.map((d) => d.path);

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

      // 再スキャン完了メッセージ
      this.sendProgress("rescan-progress", {
        kind: "done",
        message: "再スキャン完了 - サムネイル生成を開始しています...",
      });

      // 自動的にサムネイル生成を実行
      logger.log("Starting automatic thumbnail generation after rescan...");
      try {
        const totalVideos = await this.db.getVideoCount();
        await this.generateThumbnailsBatch(
          (limit) => this.db.getVideos("filename", "ASC", limit, 0),
          totalVideos,
          "自動サムネイル生成",
        );

        this.sendProgress("thumbnail-progress", {
          kind: "done",
          message: "自動サムネイル生成完了",
        });
      } catch (error) {
        console.error("Error during automatic thumbnail generation:", error);
        this.sendProgress("thumbnail-progress", {
          kind: "done",
          message: "自動サムネイル生成でエラーが発生しました",
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
        message: "サムネイル生成完了",
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
        message: "全サムネイル再生成完了",
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
        message: "サムネイル補完完了",
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

  async generateThumbnailsForSingleVideo(video: ProcessedVideo): Promise<void> {
    try {
      if (video.id !== undefined) {
        await this.thumbnailGenerator.generateThumbnails(video);
        logger.debug("Thumbnails generated for:", video.path);
      }
    } catch (error) {
      console.error("Error generating thumbnails for:", video.path, error);
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

          // プログレス通知を送信
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `新しい動画を処理中: ${path.basename(filePath)}`,
          });

          const video = await this.videoScanner.processFile(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-added", filePath);
          }

          // 新しく追加された動画で、サムネイル生成が必要な場合のみ実行
          if (video && video.needsThumbnails) {
            logger.debug(
              "Auto-generating thumbnails for new video:",
              video.path,
            );

            // サムネイル生成の進捗通知
            this.sendProgress("thumbnail-progress", {
              kind: "progress",
              current: 0,
              total: 1,
              message: `サムネイル生成中: ${video.filename}`,
              file: video.filename,
            });

            await this.generateThumbnailsForSingleVideo(video);

            // 完了通知
            this.sendProgress("thumbnail-progress", {
              kind: "progress",
              current: 1,
              total: 1,
              message: `サムネイル生成完了: ${video.filename}`,
              file: video.filename,
            });
          } else if (video && !video.needsThumbnails) {
            logger.debug(
              "Video already has thumbnails, skipping generation:",
              video.path,
            );
          }

          // 単発処理の進捗を完了させる（完了イベントが無いと
          // レンダラーの進捗表示にエントリが残留する）
          this.sendProgress("scan-progress", {
            kind: "done",
            message: "新しい動画を処理しました",
          });

          logger.debug("New video processed successfully:", filePath);
        } catch (error) {
          console.error("Error processing new video file:", filePath, error);
        }
      }
    });

    watcher.on("unlink", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          logger.debug("Processing video file removal:", filePath);

          // 外付けドライブの一時的な切断など誤検知を防ぐため、少し待ってから再確認する
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));

          try {
            await fs.access(filePath);
            // ファイルが復活していた（一時的なイベントだった）
            logger.debug(
              "File re-appeared after unlink (transient event), keeping:",
              filePath,
            );
            return;
          } catch {
            // ファイルが本当に存在しない
          }

          // プログレス通知を送信
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `動画を削除中: ${path.basename(filePath)}`,
          });

          await this.db.removeVideo(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-removed", filePath);
          }

          this.sendProgress("scan-progress", {
            kind: "done",
            message: "動画を削除しました",
          });

          logger.debug("Video file removal processed successfully:", filePath);
        } catch (error) {
          console.error(
            "Error processing video file removal:",
            filePath,
            error,
          );
        }
      }
    });

    // ディレクトリ自体の削除を監視
    watcher.on("unlinkDir", async (dirPath: string) => {
      // 監視しているディレクトリ自体が削除された場合
      if (dirPath === directoryPath) {
        try {
          logger.debug("Directory unlinkDir event:", dirPath);

          // 外付けドライブの一時的な切断など誤検知を防ぐため、少し待ってから再確認する
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));

          const { promises: fsPromises } = await import("fs");
          try {
            await fsPromises.access(dirPath);
            // ディレクトリが復活していた（一時的なイベントだった）
            logger.debug(
              "Directory re-appeared after unlinkDir (transient event), keeping:",
              dirPath,
            );
            return;
          } catch {
            // ディレクトリが本当に存在しない
          }

          // データベースからディレクトリを削除
          await this.db.removeDirectory(dirPath);

          // 監視を停止
          this.stopWatching(dirPath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("directory-removed", dirPath);
          }

          this.sendProgress("scan-progress", {
            kind: "done",
            message: "ディレクトリを削除しました",
          });

          logger.debug("Directory removal processed successfully:", dirPath);
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
    const directories = await this.db.getDirectories();
    const removedDirectories: string[] = [];

    for (const directory of directories) {
      try {
        // ディレクトリの存在をチェック
        const fs = await import("fs");
        await fs.promises.access(directory.path, fs.constants.F_OK);

        // 存在する場合は監視を開始
        this.startWatching(directory.path);
      } catch (_error) {
        // 存在しない場合はリストに追加
        logger.debug("Directory no longer exists:", directory.path);
        removedDirectories.push(directory.path);
      }
    }

    // 削除されたディレクトリがある場合の処理
    if (removedDirectories.length > 0) {
      for (const dirPath of removedDirectories) {
        try {
          await this.db.removeDirectory(dirPath);
          logger.debug(
            "Removed non-existent directory from database:",
            dirPath,
          );

          if (this.mainWindow) {
            this.mainWindow.webContents.send("directory-removed", dirPath);
          }
        } catch (error) {
          console.error(
            "Failed to remove directory from database:",
            dirPath,
            error,
          );
        }
      }
    }
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
