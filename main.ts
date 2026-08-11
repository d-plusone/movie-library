import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  MenuItemConstructorOptions,
} from "electron";
import path from "path";
import { promises as fs } from "fs";
import * as chokidar from "chokidar";
import PrismaDatabaseManager from "./src/database/PrismaDatabaseManager.js";
import VideoScanner from "./src/scanner/VideoScanner.js";
import ThumbnailGenerator from "./src/thumbnail/ThumbnailGenerator.js";
import DuplicateDetector from "./src/scanner/DuplicateDetector.js";
import {
  ProcessedVideo,
  ThumbnailResult,
  VideoUpdateData,
} from "./src/types/types.js";
import { initializeFFmpeg } from "./src/utils/ffmpeg-utils.js";
import { createLogger } from "./src/utils/logger.js";

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

class MovieLibraryApp {
  private mainWindow: BrowserWindow | null = null;
  private db: PrismaDatabaseManager;
  private videoScanner: VideoScanner;
  private duplicateDetector: DuplicateDetector;
  private thumbnailGenerator: ThumbnailGenerator;
  public watchers: Map<string, chokidar.FSWatcher> = new Map();

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
    let iconPath: string;
    if (process.platform === "darwin") {
      iconPath = path.join(__dirname, "assets", "icon.icns");
    } else if (process.platform === "win32") {
      iconPath = path.join(__dirname, "assets", "icon.ico");
    } else {
      iconPath = path.join(__dirname, "assets", "icon.png");
    }

    this.mainWindow = new BrowserWindow({
      minWidth: 1000,
      minHeight: 600,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
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

    // HTMLファイルのパスを設定
    const htmlPath = path.join(__dirname, "src/renderer/index.html");
    this.mainWindow.loadFile(htmlPath);

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
          this.mainWindow?.webContents.send("scan-progress", {
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
      this.mainWindow?.webContents.send("scan-progress", {
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
          this.mainWindow?.webContents.send("rescan-progress", {
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
      this.mainWindow?.webContents.send("rescan-progress", {
        message: "再スキャン完了 - サムネイル生成を開始しています...",
      });

      // 自動的にサムネイル生成を実行
      logger.log("Starting automatic thumbnail generation after rescan...");
      try {
        const BATCH_SIZE = 50;
        const totalVideos = await this.db.getVideoCount();
        const results: ThumbnailResult[] = [];
        let processedVideos = 0;

        logger.debug(
          `Auto-generating thumbnails for ${totalVideos} videos after rescan`,
        );

        for (let offset = 0; offset < totalVideos; offset += BATCH_SIZE) {
          const videos = await this.db.getVideos(
            "filename",
            "ASC",
            BATCH_SIZE,
            offset,
          );
          await runConcurrent(videos, 3, async (video) => {
            try {
              this.mainWindow?.webContents.send("thumbnail-progress", {
                current: processedVideos,
                total: totalVideos,
                message: `自動サムネイル生成中: ${video.filename}`,
                file: video.filename,
              });

              if (video.duration !== undefined) {
                const thumbnailResult =
                  await this.thumbnailGenerator.generateThumbnails(video);
                results.push(thumbnailResult);
              }

              processedVideos++;

              this.mainWindow?.webContents.send("thumbnail-progress", {
                current: processedVideos,
                total: totalVideos,
                message: `自動サムネイル生成完了: ${video.filename}`,
                file: video.filename,
              });
            } catch (error) {
              console.error(
                "Error auto-generating thumbnails for:",
                video.path,
                error,
              );
              processedVideos++;
              this.mainWindow?.webContents.send("thumbnail-progress", {
                current: processedVideos,
                total: totalVideos,
                message: `自動サムネイル生成エラー: ${video.filename}`,
                file: video.filename,
              });
            }
          });
        }

        this.mainWindow?.webContents.send("thumbnail-progress", {
          message: "自動サムネイル生成完了",
        });

        logger.log(
          `Auto thumbnail generation completed: ${processedVideos}/${totalVideos} processed`,
        );
      } catch (error) {
        console.error("Error during automatic thumbnail generation:", error);
        this.mainWindow?.webContents.send("thumbnail-progress", {
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
      const BATCH_SIZE = 50;
      const totalVideos = await this.db.getVideosWithoutThumbnailsCount();
      const results: ThumbnailResult[] = [];
      let processedVideos = 0;

      logger.log(`Starting generation of ${totalVideos} thumbnails`);

      for (let offset = 0; offset < totalVideos; offset += BATCH_SIZE) {
        const videos = await this.db.getVideosWithoutThumbnails(
          BATCH_SIZE,
          offset,
        );
        await runConcurrent(videos, 3, async (video) => {
          try {
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル生成中: ${video.filename}`,
              file: video.filename,
            });

            if (video.duration !== undefined) {
              const result =
                await this.thumbnailGenerator.generateThumbnails(video);
              results.push(result);
            }

            processedVideos++;

            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル生成完了: ${video.filename}`,
              file: video.filename,
            });
          } catch (error) {
            console.error(
              "Error generating thumbnails for:",
              video.path,
              error,
            );
            processedVideos++;
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル生成エラー: ${video.filename}`,
              file: video.filename,
            });
          }
        });
      }

      this.mainWindow?.webContents.send("thumbnail-progress", {
        message: "サムネイル生成完了",
      });

      logger.log(
        `Thumbnail generation completed: ${processedVideos}/${totalVideos} processed`,
      );
      return results;
    });

    // Regenerate all thumbnails
    ipcMain.handle("regenerate-all-thumbnails", async () => {
      const BATCH_SIZE = 50;
      const totalVideos = await this.db.getVideoCount();
      const results: ThumbnailResult[] = [];
      let processedVideos = 0;

      logger.log(`Starting regeneration of ${totalVideos} thumbnails`);

      for (let offset = 0; offset < totalVideos; offset += BATCH_SIZE) {
        const videos = await this.db.getVideos(
          "filename",
          "ASC",
          BATCH_SIZE,
          offset,
        );
        await runConcurrent(videos, 3, async (video) => {
          try {
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル再生成中: ${video.filename}`,
              file: video.filename,
            });

            if (video.duration !== undefined) {
              const result =
                await this.thumbnailGenerator.generateThumbnails(video);
              results.push(result);
            }

            processedVideos++;

            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル再生成完了: ${video.filename}`,
              file: video.filename,
            });
          } catch (error) {
            console.error(
              "Error regenerating thumbnails for:",
              video.path,
              error,
            );
            processedVideos++;
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `サムネイル再生成エラー: ${video.filename}`,
              file: video.filename,
            });
          }
        });
      }

      this.mainWindow?.webContents.send("thumbnail-progress", {
        message: "全サムネイル再生成完了",
      });

      logger.log(
        `Thumbnail regeneration completed: ${processedVideos}/${totalVideos} processed`,
      );
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
              this.mainWindow?.webContents.send("thumbnail-progress", {
                current: generatedVideos,
                total: totalCount,
                message: `サムネイル補完中: ${video.filename}`,
                file: video.filename,
              });

              if (video.duration !== undefined) {
                await this.thumbnailGenerator.generateThumbnails(video);
              }

              generatedVideos++;

              this.mainWindow?.webContents.send("thumbnail-progress", {
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

      this.mainWindow?.webContents.send("thumbnail-progress", {
        message: "サムネイル補完完了",
      });

      logger.log(
        `Incomplete thumbnail generation completed: ${generatedVideos} generated out of ${scannedVideos} scanned`,
      );
      return { total: generatedVideos, generated: generatedVideos };
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

          const path = await import("path");
          const thumbnailsDir = path.join(
            app.getPath("userData"),
            "thumbnails",
          );
          const mainThumbnailPath = path.join(
            thumbnailsDir,
            `${video.id}_main.jpg`,
          );

          // Use random timestamp (10% to 90% into the video)
          const randomPercent = 0.1 + Math.random() * 0.8; // 0.1 to 0.9
          const timestamp = video.duration * randomPercent;

          await this.thumbnailGenerator.generateSingleThumbnail(
            video.path,
            mainThumbnailPath,
            timestamp,
          );

          await this.db.updateVideo(video.id, {
            thumbnailPath: mainThumbnailPath,
          });

          // Return the updated video object
          const updatedVideo = await this.db.getVideo(videoId);
          return updatedVideo;
        } catch (error) {
          console.error("Error regenerating main thumbnail:", error);
          throw error;
        }
      },
    );

    // Regenerate main thumbnail with custom timestamp
    ipcMain.handle(
      "regenerate-main-thumbnail-with-timestamp",
      async (_event, videoId: string, timestamp: number) => {
        try {
          const video = await this.db.getVideo(parseInt(videoId, 10));
          if (!video) {
            throw new Error("Video not found");
          }

          const path = await import("path");
          const thumbnailsDir = path.join(
            app.getPath("userData"),
            "thumbnails",
          );
          const mainThumbnailPath = path.join(
            thumbnailsDir,
            `${video.id}_main.jpg`,
          );

          await this.thumbnailGenerator.generateSingleThumbnail(
            video.path,
            mainThumbnailPath,
            timestamp,
          );

          await this.db.updateVideo(video.id, {
            thumbnailPath: mainThumbnailPath,
          });

          // Return the updated video object
          const updatedVideo = await this.db.getVideo(parseInt(videoId, 10));
          return updatedVideo;
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
      async (_event, videoIds: number[], moveToTrash: boolean = true) => {
        try {
          const result = await this.duplicateDetector.deleteVideos(
            videoIds,
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
          if (this.mainWindow) {
            this.mainWindow.webContents.send("scan-progress", {
              message: `新しい動画を処理中: ${filePath.split("/").pop()}`,
              current: 0,
              total: 1,
            });
          }

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
            if (this.mainWindow) {
              this.mainWindow.webContents.send("thumbnail-progress", {
                message: `サムネイル生成中: ${video.filename}`,
                current: 0,
                total: 1,
              });
            }

            await this.generateThumbnailsForSingleVideo(video);

            // 完了通知
            if (this.mainWindow) {
              this.mainWindow.webContents.send("thumbnail-progress", {
                message: `サムネイル生成完了: ${video.filename}`,
                current: 1,
                total: 1,
              });
            }
          } else if (video && !video.needsThumbnails) {
            logger.debug(
              "Video already has thumbnails, skipping generation:",
              video.path,
            );
          }

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
          if (this.mainWindow) {
            this.mainWindow.webContents.send("scan-progress", {
              message: `動画を削除中: ${filePath.split("/").pop()}`,
              current: 0,
              total: 1,
            });
          }

          await this.db.removeVideo(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-removed", filePath);
          }

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
    // Dockアイコンの設定
    const iconPath = path.join(__dirname, "assets", "icon.icns");
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
// （process.exit による強制終了は SQLite の WAL を破損させるリスクがあるため使わない）
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
      app.quit();
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
