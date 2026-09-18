import { contextBridge, ipcRenderer } from "electron";
import type { ElectronAPI } from "../types/electron-api";
import type {
  BulkTagChange,
  DeleteProgress,
  DeleteVideoRequest,
  DirectoryStatus,
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

function createEventListenerPair(
  channel: string,
): { on: (callback: () => void) => void; off: (callback: () => void) => void } {
  const listenerMap = new Map<() => void, () => void>();
  return {
    on: (callback) => {
      const existing = listenerMap.get(callback);
      if (existing !== undefined) ipcRenderer.removeListener(channel, existing);
      const listener = (): void => callback();
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
const scanProgressListeners = createListenerPair<ProgressEvent>("scan-progress");
const rescanProgressListeners = createListenerPair<ProgressEvent>(
  "rescan-progress",
);
const thumbnailProgressListeners = createListenerPair<ProgressEvent>(
  "thumbnail-progress",
);
const directoryStatusListeners = createListenerPair<DirectoryStatus>(
  "directory-status-changed",
);
const videoAddedListeners = createListenerPair<string>("video-added");
const videoRemovedListeners = createListenerPair<string>("video-removed");
const openSettingsListeners = createEventListenerPair("open-settings");
const openAddDirectoryListeners = createEventListenerPair("open-add-directory");

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
  backupDatabase: () => ipcRenderer.invoke("backup-database"),
  exportTags: (format: "json" | "csv") => ipcRenderer.invoke("export-tags", format),

  // Directory operations
  getDirectories: () => ipcRenderer.invoke("get-directories"),
  addDirectory: (path: string) => ipcRenderer.invoke("add-directory", path),
  removeDirectory: (path: string) =>
    ipcRenderer.invoke("remove-directory", path),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  scanDirectories: () => ipcRenderer.invoke("scan-directories"),
  previewScan: () => ipcRenderer.invoke("preview-scan"),
  rescanAllVideos: () => ipcRenderer.invoke("rescan-all-videos"),
  getDirectoryStatuses: () => ipcRenderer.invoke("get-directory-statuses"),

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
  deletePreviewThumbnail: (previewPath: string) =>
    ipcRenderer.invoke("delete-preview-thumbnail", previewPath),
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
  addTagsToVideos: (videoIds: number[], tagNames: string[]) =>
    ipcRenderer.invoke("add-tags-to-videos", videoIds, tagNames),
  removeTagsFromVideos: (videoIds: number[], tagNames: string[]) =>
    ipcRenderer.invoke("remove-tags-from-videos", videoIds, tagNames),
  applyBulkTagChanges: (changes: BulkTagChange[]) =>
    ipcRenderer.invoke("apply-bulk-tag-changes", changes),
  deleteTag: (tagName: string) => ipcRenderer.invoke("delete-tag", tagName),
  updateTag: (oldName: string, newName: string) =>
    ipcRenderer.invoke("update-tag", oldName, newName),

  // Directory management
  checkDirectoryExists: (dirPath: string) =>
    ipcRenderer.invoke("check-directory-exists", dirPath),

  // Duplicate detection
  findDuplicates: () => ipcRenderer.invoke("find-duplicates"),
  cancelDuplicateSearch: () => ipcRenderer.invoke("cancel-duplicate-search"),
  deleteVideos: (requests: DeleteVideoRequest[], moveToTrash: boolean = true) =>
    ipcRenderer.invoke("delete-videos", requests, moveToTrash),

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
    scanProgressListeners.on(callback);
  },
  offScanProgress: (callback: (data: ProgressEvent) => void) => {
    scanProgressListeners.off(callback);
  },
  onRescanProgress: (callback: (data: ProgressEvent) => void) => {
    rescanProgressListeners.on(callback);
  },
  offRescanProgress: (callback: (data: ProgressEvent) => void) => {
    rescanProgressListeners.off(callback);
  },
  onThumbnailProgress: (callback: (data: ProgressEvent) => void) => {
    thumbnailProgressListeners.on(callback);
  },
  offThumbnailProgress: (callback: (data: ProgressEvent) => void) => {
    thumbnailProgressListeners.off(callback);
  },
  onVideoAdded: (callback: (filePath: string) => void) => {
    videoAddedListeners.on(callback);
  },
  offVideoAdded: (callback: (filePath: string) => void) => {
    videoAddedListeners.off(callback);
  },
  onVideoRemoved: (callback: (filePath: string) => void) => {
    videoRemovedListeners.on(callback);
  },
  offVideoRemoved: (callback: (filePath: string) => void) => {
    videoRemovedListeners.off(callback);
  },
  onDirectoryStatusChanged: (callback: (data: DirectoryStatus) => void) => {
    directoryStatusListeners.on(callback);
  },
  offDirectoryStatusChanged: (callback: (data: DirectoryStatus) => void) => {
    directoryStatusListeners.off(callback);
  },
  onDeleteProgress: (callback: (data: DeleteProgress) => void) => {
    deleteProgressListeners.on(callback);
  },
  offDeleteProgress: (callback: (data: DeleteProgress) => void) => {
    deleteProgressListeners.off(callback);
  },
  onOpenSettings: (callback: () => void) => {
    openSettingsListeners.on(callback);
  },
  offOpenSettings: (callback: () => void) => {
    openSettingsListeners.off(callback);
  },
  onOpenAddDirectory: (callback: () => void) => {
    openAddDirectoryListeners.on(callback);
  },
  offOpenAddDirectory: (callback: () => void) => {
    openAddDirectoryListeners.off(callback);
  },

  // Remove listeners
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
