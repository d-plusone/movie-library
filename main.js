const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs").promises;
const chokidar = require("chokidar");
const DatabaseManager = require("./src/database/DatabaseManager");
const VideoScanner = require("./src/scanner/VideoScanner");
const ThumbnailGenerator = require("./src/thumbnail/ThumbnailGenerator");

class MovieLibraryApp {
  constructor() {
    this.mainWindow = null;
    this.db = new DatabaseManager();
    this.videoScanner = new VideoScanner(this.db);
    this.thumbnailGenerator = new ThumbnailGenerator(this.db);
    this.watchers = new Map();
  }

  async initialize() {
    await this.db.initialize();
    this.setupIpcHandlers();
  }

  createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: false,
    });

    this.mainWindow.loadFile("src/renderer/index.html");

    // Development mode
    if (process.env.NODE_ENV === "development") {
      this.mainWindow.webContents.openDevTools();
    }

    // ウィンドウが閉じられたときの処理
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
      // アプリを完全に終了
      app.quit();
    });

    // ウィンドウを閉じる前の処理
    this.mainWindow.on("close", (event) => {
      // すべてのwatcherを停止
      this.watchers.forEach((watcher) => watcher.close());
    });
  }

  setupIpcHandlers() {
    // Get all videos
    ipcMain.handle("get-videos", async () => {
      return await this.db.getVideos();
    });

    // Get video by id
    ipcMain.handle("get-video", async (event, id) => {
      return await this.db.getVideo(id);
    });

    // Update video metadata
    ipcMain.handle("update-video", async (event, id, data) => {
      return await this.db.updateVideo(id, data);
    });

    // Search videos
    ipcMain.handle("search-videos", async (event, query) => {
      return await this.db.searchVideos(query);
    });

    // Get directories
    ipcMain.handle("get-directories", async () => {
      return await this.db.getDirectories();
    });

    // Add directory
    ipcMain.handle("add-directory", async (event, directoryPath) => {
      await this.db.addDirectory(directoryPath);
      this.startWatching(directoryPath);
      return await this.scanDirectory(directoryPath);
    });

    // Remove directory
    ipcMain.handle("remove-directory", async (event, directoryPath) => {
      await this.db.removeDirectory(directoryPath);
      this.stopWatching(directoryPath);
      return true;
    });

    // Choose directory dialog
    ipcMain.handle("choose-directory", async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ["openDirectory", "multiSelections"],
        title: "Select video directories",
      });
      return result.filePaths;
    });

    // Scan all directories
    ipcMain.handle("scan-directories", async () => {
      const directories = await this.db.getDirectories();
      const scanPromises = directories.map((dir) =>
        this.scanDirectory(dir.path)
      );
      await Promise.all(scanPromises);
      return true;
    });

    // Generate thumbnails
    ipcMain.handle("generate-thumbnails", async () => {
      const videos = await this.db.getVideosWithoutThumbnails();
      for (const video of videos) {
        await this.thumbnailGenerator.generateThumbnails(video);
      }
      return true;
    });

    // Regenerate main thumbnail for a specific video
    ipcMain.handle("regenerate-main-thumbnail", async (event, videoId) => {
      try {
        const video = await this.db.getVideo(videoId);
        if (!video) {
          throw new Error("Video not found");
        }
        
        // Generate a new main thumbnail at a random position
        const thumbnailResult = await this.thumbnailGenerator.regenerateMainThumbnail(video);
        
        // Return the updated video data with new thumbnail path
        const updatedVideo = await this.db.getVideo(videoId);
        return {
          ...updatedVideo,
          thumbnail_path: thumbnailResult.thumbnailPath,
          regeneration_info: {
            timestamp: thumbnailResult.timestamp,
            formattedTimestamp: thumbnailResult.formattedTimestamp
          }
        };
      } catch (error) {
        console.error("Error regenerating main thumbnail:", error);
        throw error;
      }
    });

    // Open video with default player
    ipcMain.handle("open-video", async (event, filePath) => {
      await shell.openPath(filePath);
      return true;
    });

    // Get tags
    ipcMain.handle("get-tags", async () => {
      return await this.db.getTags();
    });

    // Add tag to video
    ipcMain.handle("add-tag-to-video", async (event, videoId, tagName) => {
      return await this.db.addTagToVideo(videoId, tagName);
    });

    // Remove tag from video
    ipcMain.handle("remove-tag-from-video", async (event, videoId, tagName) => {
      return await this.db.removeTagFromVideo(videoId, tagName);
    });

    // Delete tag completely
    ipcMain.handle("delete-tag", async (event, tagName) => {
      return await this.db.deleteTag(tagName);
    });

    // Update tag name
    ipcMain.handle("update-tag", async (event, oldName, newName) => {
      return await this.db.updateTag(oldName, newName);
    });

    // Update thumbnail settings
    ipcMain.handle("update-thumbnail-settings", async (event, settings) => {
      this.thumbnailGenerator.updateSettings(settings);
      return true;
    });

    // Regenerate all thumbnails
    ipcMain.handle("regenerate-all-thumbnails", async () => {
      const videos = await this.db.getVideos();
      this.mainWindow.webContents.send("thumbnail-progress", {
        type: "thumbnail-start",
        count: videos.length,
      });

      let completed = 0;
      for (const video of videos) {
        try {
          await this.thumbnailGenerator.generateThumbnails(video);
          completed++;
          this.mainWindow.webContents.send("thumbnail-progress", {
            type: "thumbnail-progress",
            completed,
            total: videos.length,
          });
        } catch (error) {
          console.error(
            "Failed to regenerate thumbnail for:",
            video.path,
            error
          );
        }
      }

      this.mainWindow.webContents.send("thumbnail-progress", {
        type: "thumbnail-complete",
        completed,
      });

      return true;
    });
  }

  async scanDirectory(directoryPath) {
    this.mainWindow.webContents.send("scan-progress", {
      type: "scan-start",
      directory: directoryPath,
    });

    try {
      const videos = await this.videoScanner.scanDirectory(
        directoryPath,
        (progress) => {
          this.mainWindow.webContents.send("scan-progress", {
            type: "scan-progress",
            directory: directoryPath,
            progress,
          });
        }
      );

      this.mainWindow.webContents.send("scan-progress", {
        type: "scan-complete",
        directory: directoryPath,
        count: videos.length,
      });

      // Start thumbnail generation
      this.generateThumbnailsForVideos(videos);

      return videos;
    } catch (error) {
      this.mainWindow.webContents.send("scan-progress", {
        type: "scan-error",
        directory: directoryPath,
        error: error.message,
      });
      throw error;
    }
  }

  async generateThumbnailsForVideos(videos) {
    this.mainWindow.webContents.send("thumbnail-progress", {
      type: "thumbnail-start",
      count: videos.length,
    });

    let completed = 0;
    for (const video of videos) {
      try {
        await this.thumbnailGenerator.generateThumbnails(video);
        completed++;
        this.mainWindow.webContents.send("thumbnail-progress", {
          type: "thumbnail-progress",
          completed,
          total: videos.length,
        });
      } catch (error) {
        console.error("Failed to generate thumbnail for:", video.path, error);
      }
    }

    this.mainWindow.webContents.send("thumbnail-progress", {
      type: "thumbnail-complete",
      completed,
    });
  }

  startWatching(directoryPath) {
    if (this.watchers.has(directoryPath)) {
      return;
    }

    const watcher = chokidar.watch(directoryPath, {
      ignored: /^\./,
      persistent: true,
      depth: 10,
    });

    watcher.on("add", async (filePath) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        await this.videoScanner.processFile(filePath);
        this.mainWindow.webContents.send("video-added", filePath);
      }
    });

    watcher.on("unlink", async (filePath) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        await this.db.removeVideo(filePath);
        this.mainWindow.webContents.send("video-removed", filePath);
      }
    });

    this.watchers.set(directoryPath, watcher);
  }

  stopWatching(directoryPath) {
    const watcher = this.watchers.get(directoryPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(directoryPath);
    }
  }

  async startWatchingAllDirectories() {
    const directories = await this.db.getDirectories();
    for (const directory of directories) {
      this.startWatching(directory.path);
    }
  }
}

const movieApp = new MovieLibraryApp();

app.whenReady().then(async () => {
  await movieApp.initialize();
  movieApp.createWindow();
  await movieApp.startWatchingAllDirectories();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      movieApp.createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // すべてのプラットフォームでアプリを完全に終了
  app.quit();
});

app.on("before-quit", () => {
  // Close all watchers
  movieApp.watchers.forEach((watcher) => watcher.close());
});
