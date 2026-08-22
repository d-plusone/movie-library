import { contextBridge, ipcRenderer } from "electron";
import type { ElectronAPI } from "../types/electron-api";
import type {
  DeleteProgress,
  DuplicateSearchProgress,
  OperationProgress,
  ProgressEvent,
  ThumbnailSettings,
  VideoUpdateData,
} from "../types/types";

/**
 * on/off で同一のラッパー関数参照を共有するためのマップ生成。
 * （無名関数を毎回生成すると removeListener が効かずリスナーがリークする）
 */
function createListenerPair<T>(
  channel: string,
): {
  on: (callback: (data: T) => void) => void;
  off: (callback: (data: T) => void) => void;
} {
  const listenerMap = new Map<
    (data: T) => void,
    (event: Electron.IpcRendererEvent, data: T) => void
  >();
  return {
    on: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: T): void =>
        callback(data);
      if (listenerMap.has(callback)) {
        // 同一 callback の二重登録時は旧リスナーを先に外す
        const existing = listenerMap.get(callback);
        if (existing !== undefined) {
          ipcRenderer.removeListener(channel, existing);
        }
      }
      listenerMap.set(callback, listener);
      ipcRenderer.on(channel, listener);
    },
    off: (callback) => {
      const listener = listenerMap.get(callback);
      if (listener !== undefined) {
        ipcRenderer.removeListener(channel, listener);
        listenerMap.delete(callback);
      }
    },
  };
}

const duplicateSearchListeners = createListenerPair<DuplicateSearchProgress>(
  "duplicate-search-progress",
);
const containerCheckListeners = createListenerPair<OperationProgress>(
  "container-check-progress",
);
const containerConvertListeners = createListenerPair<OperationProgress>(
  "container-convert-progress",
);
const deleteProgressListeners = createListenerPair<DeleteProgress>(
  "delete-progress",
);

// main プロセスから追加引数で渡される production フラグ
// （sandbox 化された preload でも process.argv は利用可能）
const isProduction = process.argv.includes("--movie-library-production=1");

// src/types/electron-api.ts の ElectronAPI が唯一の真実源。
// このオブジェクトリテラルへの代入により、メンバーの過不足はコンパイルエラーで検出される。
const electronAPI: ElectronAPI = {
  // アプリ情報
  isProduction,

  // Video operations
  getVideos: () => ipcRenderer.invoke("get-videos"),
  updateVideo: (id: number, data: VideoUpdateData) =>
    ipcRenderer.invoke("update-video", id, data),
  openVideo: (filePath: string) => ipcRenderer.invoke("open-video", filePath),
  hasVideoUpdates: (lastCheckTime: number) =>
    ipcRenderer.invoke("has-video-updates", lastCheckTime),
  captureFrame: (videoPath: string, timestamp: number, outputDir: string) =>
    ipcRenderer.invoke("capture-frame", videoPath, timestamp, outputDir),
  selectScreenshotDir: () => ipcRenderer.invoke("select-screenshot-dir"),

  // Directory operations
  getDirectories: () => ipcRenderer.invoke("get-directories"),
  addDirectory: (path: string) => ipcRenderer.invoke("add-directory", path),
  removeDirectory: (path: string) =>
    ipcRenderer.invoke("remove-directory", path),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  scanDirectories: () => ipcRenderer.invoke("scan-directories"),
  rescanAllVideos: () => ipcRenderer.invoke("rescan-all-videos"),

  // Thumbnail operations
  generateThumbnails: () => ipcRenderer.invoke("generate-thumbnails"),
  generateIncompleteThumbnails: () =>
    ipcRenderer.invoke("generate-incomplete-thumbnails"),
  regenerateAllThumbnails: () =>
    ipcRenderer.invoke("regenerate-all-thumbnails"),
  regenerateMainThumbnail: (videoId: number) =>
    ipcRenderer.invoke("regenerate-main-thumbnail", videoId),
  updateThumbnailSettings: (settings: ThumbnailSettings) =>
    ipcRenderer.invoke("update-thumbnail-settings", settings),
  cleanupThumbnails: () => ipcRenderer.invoke("cleanup-thumbnails"),
  getThumbnailsDir: () => ipcRenderer.invoke("get-thumbnails-dir"),
  generatePreviewThumbnail: (videoPath: string, timestamp: number) =>
    ipcRenderer.invoke("generate-preview-thumbnail", videoPath, timestamp),
  regenerateMainThumbnailWithTimestamp: (videoId: number, timestamp: number) =>
    ipcRenderer.invoke(
      "regenerate-main-thumbnail-with-timestamp",
      videoId,
      timestamp,
    ),

  // Tag operations
  getTags: () => ipcRenderer.invoke("get-tags"),
  addTagToVideo: (videoId: number, tagName: string) =>
    ipcRenderer.invoke("add-tag-to-video", videoId, tagName),
  removeTagFromVideo: (videoId: number, tagName: string) =>
    ipcRenderer.invoke("remove-tag-from-video", videoId, tagName),
  deleteTag: (tagName: string) => ipcRenderer.invoke("delete-tag", tagName),
  updateTag: (oldName: string, newName: string) =>
    ipcRenderer.invoke("update-tag", oldName, newName),

  // Directory management
  checkDirectoryExists: (dirPath: string) =>
    ipcRenderer.invoke("check-directory-exists", dirPath),

  // Duplicate detection
  findDuplicates: () => ipcRenderer.invoke("find-duplicates"),
  deleteVideos: (videoIds: number[], moveToTrash: boolean = true) =>
    ipcRenderer.invoke("delete-videos", videoIds, moveToTrash),

  onDuplicateSearchProgress: (
    callback: (data: DuplicateSearchProgress) => void,
  ) => {
    duplicateSearchListeners.on(callback);
  },
  offDuplicateSearchProgress: (
    callback: (data: DuplicateSearchProgress) => void,
  ) => {
    duplicateSearchListeners.off(callback);
  },

  // Container check / remux
  checkContainerMismatches: () =>
    ipcRenderer.invoke("check-container-mismatches"),
  convertVideosToMp4: (videoIds: number[]) =>
    ipcRenderer.invoke("convert-videos-to-mp4", videoIds),
  onContainerCheckProgress: (callback: (data: OperationProgress) => void) => {
    containerCheckListeners.on(callback);
  },
  offContainerCheckProgress: (callback: (data: OperationProgress) => void) => {
    containerCheckListeners.off(callback);
  },
  onContainerConvertProgress: (
    callback: (data: OperationProgress) => void,
  ) => {
    containerConvertListeners.on(callback);
  },
  offContainerConvertProgress: (
    callback: (data: OperationProgress) => void,
  ) => {
    containerConvertListeners.off(callback);
  },

  // Event listeners
  onScanProgress: (callback: (data: ProgressEvent) => void) => {
    ipcRenderer.on("scan-progress", (_event, data: ProgressEvent) =>
      callback(data),
    );
  },
  onRescanProgress: (callback: (data: ProgressEvent) => void) => {
    ipcRenderer.on("rescan-progress", (_event, data: ProgressEvent) =>
      callback(data),
    );
  },
  onThumbnailProgress: (callback: (data: ProgressEvent) => void) => {
    ipcRenderer.on("thumbnail-progress", (_event, data: ProgressEvent) =>
      callback(data),
    );
  },
  onVideoAdded: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-added", (_event, filePath) => callback(filePath));
  },
  onVideoRemoved: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-removed", (_event, filePath) => callback(filePath));
  },
  onDirectoryRemoved: (callback: (dirPath: string) => void) => {
    ipcRenderer.on("directory-removed", (_event, dirPath) =>
      callback(dirPath),
    );
  },
  onDeleteProgress: (callback: (data: DeleteProgress) => void) => {
    deleteProgressListeners.on(callback);
  },
  offDeleteProgress: (callback: (data: DeleteProgress) => void) => {
    deleteProgressListeners.off(callback);
  },
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on("open-settings", () => callback());
  },
  onOpenAddDirectory: (callback: () => void) => {
    ipcRenderer.on("open-add-directory", () => callback());
  },

  // Remove listeners
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
