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
import { ProcessedVideo, ThumbnailResult } from "./src/types/types.js";
import { initializeFFmpeg } from "./src/utils/ffmpeg-utils.js";

// Set app name BEFORE app is ready to ensure consistent userData path across versions
// This must be done before any app.getPath() calls
app.setName("movie-library");

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

    process.env.DATABASE_URL = `file:${dbPath}`;
    console.log(`Database path: ${dbPath}`);

    this.db = new PrismaDatabaseManager();
    this.videoScanner = new VideoScanner(this.db);
    this.duplicateDetector = new DuplicateDetector(this.db);
    this.thumbnailGenerator = new ThumbnailGenerator(this.db);
  }

  async initialize(): Promise<void> {
    console.log("🚀 Initializing Movie Library App...");

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

    console.log("✅ Movie Library App initialized");
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
    // FIXME 一時的に開発者ツールが開けるようにする
    // if (process.env.NODE_ENV === "development" || !app.isPackaged) {
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
    // }

    // Development mode - DevTools can be opened with F12
    // if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    //   this.mainWindow.webContents.openDevTools();
    // }

    // ウィンドウが閉じられたときの処理
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
      // アプリを完全に終了
      app.quit();
    });

    // ウィンドウを閉じる前の処理
    this.mainWindow.on("close", (_event) => {
      console.log("Window is being closed");
      // すべてのwatcherを停止
      this.watchers.forEach((watcher) => watcher.close());
      // データベース接続を閉じる
      if (this.db) {
        this.db.close();
      }
    });

    // Windows用の追加終了処理
    if (process.platform === "win32") {
      this.mainWindow.on("close", (_event) => {
        // Windowsでのクリーンな終了を保証
        setTimeout(() => {
          if (process.platform === "win32") {
            process.exit(0);
          }
        }, 1000);
      });
    }
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

      console.log(
        "Starting comprehensive scan of directories:",
        directoryPaths,
      );

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
          console.log(`Removed deleted video from database: ${deletedPath}`);
        } catch (error) {
          console.error(
            `Failed to remove deleted video: ${deletedPath}`,
            error,
          );
        }
      }

      // 結果をログ出力
      console.log("Comprehensive scan completed:", {
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

        const { dialog } = require("electron");
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

      console.log(
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
          console.log(`Removed deleted video from database: ${deletedPath}`);
        } catch (error) {
          console.error(
            `Failed to remove deleted video: ${deletedPath}`,
            error,
          );
        }
      }

      // 結果をログ出力
      console.log("Force rescan all videos completed:", {
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

        const { dialog } = require("electron");
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
      console.log("Starting automatic thumbnail generation after rescan...");
      try {
        const videos = await this.db.getVideos(); // 全動画を取得
        const results: ThumbnailResult[] = [];
        let processedVideos = 0;
        const totalVideos = videos.length;

        console.log(
          `Auto-generating thumbnails for ${totalVideos} videos after rescan`,
        );

        for (const video of videos) {
          try {
            // プログレス送信（処理開始前）
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `自動サムネイル生成中: ${video.filename}`,
              file: video.filename,
            });

            console.log(
              `Auto-generating thumbnail ${
                processedVideos + 1
              }/${totalVideos}: ${video.filename}`,
            );

            if (video.duration !== undefined) {
              const thumbnailResult =
                await this.thumbnailGenerator.generateThumbnails(video);
              results.push(thumbnailResult);
            }

            // 処理完了後にカウンターを増加
            processedVideos++;

            // 完了時プログレス送信
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `自動サムネイル生成完了: ${video.filename}`,
              file: video.filename,
            });

            console.log(
              `Auto-thumbnail generation completed ${processedVideos}/${totalVideos}: ${video.filename}`,
            );
          } catch (error) {
            console.error(
              "Error auto-generating thumbnails for:",
              video.path,
              error,
            );
            // エラー時もカウンターを増加
            processedVideos++;

            // エラー時のプログレス送信
            this.mainWindow?.webContents.send("thumbnail-progress", {
              current: processedVideos,
              total: totalVideos,
              message: `自動サムネイル生成エラー: ${video.filename}`,
              file: video.filename,
            });
          }
        }

        // 最終プログレス送信
        this.mainWindow?.webContents.send("thumbnail-progress", {
          message: "自動サムネイル生成完了",
        });

        console.log(
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
      const videos = await this.db.getVideosWithoutThumbnails();
      const results: ThumbnailResult[] = [];
      let processedVideos = 0;
      const totalVideos = videos.length;

      console.log(`Starting generation of ${totalVideos} thumbnails`);

      for (const video of videos) {
        try {
          // プログレス送信（処理開始前）
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル生成中: ${video.filename}`,
            file: video.filename,
          });

          console.log(
            `Generating thumbnail ${processedVideos + 1}/${totalVideos}: ${
              video.filename
            }`,
          );

          if (video.duration !== undefined) {
            const result =
              await this.thumbnailGenerator.generateThumbnails(video);
            results.push(result);
          }

          // 処理完了後にカウンターを増加
          processedVideos++;

          // 完了時プログレス送信
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル生成完了: ${video.filename}`,
            file: video.filename,
          });

          console.log(
            `Completed thumbnail ${processedVideos}/${totalVideos}: ${video.filename}`,
          );
        } catch (error) {
          console.error("Error generating thumbnails for:", video.path, error);
          // エラー時もカウンターを増加
          processedVideos++;

          // エラー時のプログレス送信
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル生成エラー: ${video.filename}`,
            file: video.filename,
          });
        }
      }

      // 最終プログレス送信
      this.mainWindow?.webContents.send("thumbnail-progress", {
        message: "サムネイル生成完了",
      });

      console.log(
        `Thumbnail generation completed: ${processedVideos}/${totalVideos} processed`,
      );
      return results;
    });

    // Regenerate all thumbnails
    ipcMain.handle("regenerate-all-thumbnails", async () => {
      const videos = await this.db.getVideos();
      const results: ThumbnailResult[] = [];
      let processedVideos = 0;
      const totalVideos = videos.length;

      console.log(`Starting regeneration of ${totalVideos} thumbnails`);

      for (const video of videos) {
        try {
          // プログレス送信（処理開始前）
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル再生成中: ${video.filename}`,
            file: video.filename,
          });

          console.log(
            `Regenerating thumbnail ${processedVideos + 1}/${totalVideos}: ${
              video.filename
            }`,
          );

          if (video.duration !== undefined) {
            const result =
              await this.thumbnailGenerator.generateThumbnails(video);
            results.push(result);
          }

          // 処理完了後にカウンターを増加
          processedVideos++;

          // 完了時プログレス送信
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル再生成完了: ${video.filename}`,
            file: video.filename,
          });

          console.log(
            `Completed thumbnail ${processedVideos}/${totalVideos}: ${video.filename}`,
          );
        } catch (error) {
          console.error(
            "Error regenerating thumbnails for:",
            video.path,
            error,
          );
          // エラー時もカウンターを増加
          processedVideos++;

          // エラー時のプログレス送信
          this.mainWindow?.webContents.send("thumbnail-progress", {
            current: processedVideos,
            total: totalVideos,
            message: `サムネイル再生成エラー: ${video.filename}`,
            file: video.filename,
          });
        }
      }

      // 最終プログレス送信
      this.mainWindow?.webContents.send("thumbnail-progress", {
        message: "全サムネイル再生成完了",
      });

      console.log(
        `Thumbnail regeneration completed: ${processedVideos}/${totalVideos} processed`,
      );
      return results;
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
        console.log("Thumbnail cleanup completed:", result);
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
    ipcMain.handle("update-video", async (_event, videoId: string, data) => {
      return await this.db.updateVideo(parseInt(videoId), data);
    });

    // Add tag to video
    ipcMain.handle(
      "add-tag-to-video",
      async (_event, videoId: string, tagName: string) => {
        return await this.db.addTagToVideo(parseInt(videoId), tagName);
      },
    );

    // Remove tag from video
    ipcMain.handle(
      "remove-tag-from-video",
      async (_event, videoId: string, tagName: string) => {
        return await this.db.removeTagFromVideo(parseInt(videoId), tagName);
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
      async (_event, videoId: string) => {
        try {
          const video = await this.db.getVideo(parseInt(videoId));
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
          const updatedVideo = await this.db.getVideo(parseInt(videoId));
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
          const video = await this.db.getVideo(parseInt(videoId));
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
          const updatedVideo = await this.db.getVideo(parseInt(videoId));
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
        console.log("Thumbnails generated for:", video.path);
      }
    } catch (error) {
      console.error("Error generating thumbnails for:", video.path, error);
    }
  }

  startWatching(directoryPath: string): void {
    if (this.watchers.has(directoryPath)) {
      return;
    }

    console.log("Starting to watch directory:", directoryPath);

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on("add", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          console.log("Processing new video file:", filePath);

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
            console.log(
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
            console.log(
              "Video already has thumbnails, skipping generation:",
              video.path,
            );
          }

          console.log("New video processed successfully:", filePath);
        } catch (error) {
          console.error("Error processing new video file:", filePath, error);
        }
      }
    });

    watcher.on("unlink", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          console.log("Processing video file removal:", filePath);

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

          console.log("Video file removal processed successfully:", filePath);
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
          console.log("Directory removed:", dirPath);

          // データベースからディレクトリを削除
          await this.db.removeDirectory(dirPath);

          // 監視を停止
          this.stopWatching(dirPath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("directory-removed", dirPath);
          }

          console.log("Directory removal processed successfully:", dirPath);
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
        console.log("Directory no longer exists:", directory.path);
        removedDirectories.push(directory.path);
      }
    }

    // 削除されたディレクトリがある場合の処理
    if (removedDirectories.length > 0) {
      for (const dirPath of removedDirectories) {
        try {
          await this.db.removeDirectory(dirPath);
          console.log("Removed non-existent directory from database:", dirPath);

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
  public cleanup(): void {
    console.log("Cleaning up application resources...");

    // すべてのwatcherを停止
    this.watchers.forEach((watcher) => {
      try {
        watcher.close();
      } catch (error) {
        console.error("Error closing watcher:", error);
      }
    });
    this.watchers.clear();

    // データベース接続を閉じる
    try {
      if (this.db) {
        this.db.close();
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
        app.dock.setIcon(iconPath);
        console.log("Dock icon set successfully");
      } catch (error) {
        console.warn("Failed to set dock icon:", error);
      }
    } else {
      console.warn("Icon file not found:", iconPath);
    }
  }

  try {
    console.log("Initializing Movie Library App...");
    console.log("App packaged:", app.isPackaged);
    console.log("Platform:", process.platform);
    console.log("Architecture:", process.arch);

    await movieApp.initialize();
    console.log("App initialized successfully");

    movieApp.createWindow();
    console.log("Window created successfully");

    await movieApp.startWatchingAllDirectories();
    console.log("Directory watching started successfully");
  } catch (error) {
    console.error("Failed to initialize app:", error);

    // エラーダイアログを表示
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "Initialization Error",
      `Failed to start Movie Library: ${error.message || error}`,
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
  console.log("All windows closed, quitting application");

  // リソースのクリーンアップ
  if (movieApp.watchers) {
    movieApp.watchers.forEach((watcher) => {
      try {
        watcher.close();
      } catch (error) {
        console.error("Error closing watcher:", error);
      }
    });
  }

  // プロセスを確実に終了
  app.quit();

  // Windows用の強制終了処理
  if (process.platform === "win32") {
    setTimeout(() => {
      process.exit(0);
    }, 2000);
  }
});

app.on("before-quit", (_event) => {
  console.log("Application is about to quit");

  // Close all watchers
  if (movieApp.watchers) {
    movieApp.watchers.forEach((watcher) => {
      try {
        watcher.close();
      } catch (error) {
        console.error("Error closing watcher during quit:", error);
      }
    });
  }

  // データベース接続のクリーンアップ
  try {
    movieApp.cleanup();
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
});

// Windows用の追加終了処理
if (process.platform === "win32") {
  app.on("will-quit", (_event) => {
    console.log("Windows: Application will quit");
  });

  // プロセス終了時の処理
  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down gracefully");
    app.quit();
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down gracefully");
    app.quit();
  });

  // Windows特有の終了シグナル
  process.on("SIGHUP", () => {
    console.log("Received SIGHUP, shutting down gracefully");
    app.quit();
  });
}
