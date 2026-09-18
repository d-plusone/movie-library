import {
  app,
  BrowserWindow,
  dialog,
  shell,
  Menu,
  MenuItemConstructorOptions,
} from "electron";
import path from "path";
import { promises as fs } from "fs";
import PrismaDatabaseManager from "../database/PrismaDatabaseManager.js";
import type { VideoRecord } from "../database/PrismaDatabaseManager.js";
import VideoScanner from "../scanner/VideoScanner.js";
import ThumbnailGenerator from "../thumbnail/ThumbnailGenerator.js";
import DuplicateDetector from "../scanner/DuplicateDetector.js";
import {
  ProcessedVideo,
  ProgressEvent,
  OperationProgress,
} from "../types/types.js";
import { initializeFFmpeg } from "../utils/ffmpeg-utils.js";
import { createLogger } from "../utils/logger.js";
import { registerLocalFileProtocol } from "./local-file-protocol.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import DirectoryWatcher from "./directory-watcher.js";

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

const PREVIEW_TEMP_PREFIX = "movie-library-preview-";
const PREVIEW_TEMP_DIR_NAME = "movie-library-previews";

function getPreviewTempDir(): string {
  return path.join(app.getPath("temp"), PREVIEW_TEMP_DIR_NAME);
}

async function cleanupStalePreviewThumbnails(): Promise<void> {
  const previewDirs = [app.getPath("temp"), getPreviewTempDir()];
  await Promise.all(
    previewDirs.map(async (previewDir) => {
      try {
        await fs.mkdir(previewDir, { recursive: true });
        const entries = await fs.readdir(previewDir, { withFileTypes: true });
        await Promise.all(
          entries
            .filter(
              (entry) =>
                entry.isFile() &&
                entry.name.startsWith(PREVIEW_TEMP_PREFIX) &&
                path.extname(entry.name).toLowerCase() === ".jpg",
            )
            .map(async (entry) => {
              try {
                await fs.unlink(path.join(previewDir, entry.name));
              } catch (error) {
                logger.warn("Failed to remove stale preview thumbnail:", error);
              }
            }),
        );
      } catch (error) {
        logger.warn(
          `Failed to clean stale preview thumbnails (${previewDir}):`,
          error,
        );
      }
    }),
  );
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
  private directoryWatcher: DirectoryWatcher;

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
    this.directoryWatcher = new DirectoryWatcher({
      db: this.db,
      videoScanner: this.videoScanner,
      getMainWindow: () => this.mainWindow,
      sendProgress: (channel, payload) => this.sendProgress(channel, payload),
      generateThumbnailsForSingleVideo: (video) =>
        this.generateThumbnailsForSingleVideo(video),
    });
  }

  async initialize(): Promise<void> {
    logger.log("🚀 Initializing Movie Library App...");

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
    await cleanupStalePreviewThumbnails();

    // DB 初期化後に登録ディレクトリを許可ルートとして local-file:// を有効化する。
    // 任意の絶対パスを renderer から読めないようにする。
    registerLocalFileProtocol(async () => {
      const directories = await this.db.getDirectories();
      return [
        ...directories.map((directory) => directory.path),
        path.join(app.getPath("userData"), "thumbnails"),
        getPreviewTempDir(),
      ];
    });

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
    registerIpcHandlers({
      db: this.db,
      videoScanner: this.videoScanner,
      thumbnailGenerator: this.thumbnailGenerator,
      duplicateDetector: this.duplicateDetector,
      getMainWindow: () => this.mainWindow,
      directoryAvailability: this.directoryWatcher.directoryAvailability,
      sendProgress: (channel, payload) => this.sendProgress(channel, payload),
      sendOperationProgress: (channel, payload) =>
        this.sendOperationProgress(channel, payload),
      isDirectoryAvailable: (directoryPath) =>
        this.directoryWatcher.isDirectoryAvailable(directoryPath),
      setDirectoryAvailability: (directoryPath, status) =>
        this.directoryWatcher.setDirectoryAvailability(directoryPath, status),
      startWatching: (directoryPath) => this.directoryWatcher.startWatching(directoryPath),
      stopWatching: (directoryPath) => this.directoryWatcher.stopWatching(directoryPath),
      rememberNetworkMount: (directoryPath) =>
        this.directoryWatcher.rememberNetworkMount(directoryPath),
      handleDirectoryUnavailable: (directoryPath, reason) =>
        this.directoryWatcher.handleDirectoryUnavailable(directoryPath, reason),
      forgetDirectory: (directoryPath) => this.directoryWatcher.forgetDirectory(directoryPath),
      probeDirectoryAvailability: (directoryPath) =>
        this.directoryWatcher.probeDirectoryAvailability(directoryPath),
      isDirectoryAccessible: (directoryPath) =>
        this.directoryWatcher.isDirectoryAccessible(directoryPath),
      invalidateRegisteredDirectoriesCache: () =>
        this.directoryWatcher.invalidateRegisteredDirectoriesCache(),
      regenerateMainThumbnailAt: (videoId, timestamp) =>
        this.regenerateMainThumbnailAt(videoId, timestamp),
      generateThumbnailsForSingleVideo: (video) =>
        this.generateThumbnailsForSingleVideo(video),
      getPreviewTempDir,
      clearVideoHashes: async (videoId) => {
        await this.db.prisma.video.update({
          where: { id: videoId },
          data: { partialHash: null, fileHash: null },
        });
      },
    });
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

  public async startWatchingAllDirectories(): Promise<void> {
    await this.directoryWatcher.startWatchingAllDirectories();
  }

  // アプリケーションのクリーンアップメソッド
  // （watcher 停止と DB 切断を完了させてから終了するため async）
  public async cleanup(): Promise<void> {
    logger.log("Cleaning up application resources...");
    await this.directoryWatcher.cleanup();

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
