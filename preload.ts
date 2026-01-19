import { contextBridge, ipcRenderer } from "electron";
import type {
  ThumbnailSettings,
  VideoUpdateData,
  Video,
  Directory,
  Tag,
  ScanResult,
  ScanProgress,
  ThumbnailProgress,
  DuplicateGroup,
  DeleteVideosResult,
  DeleteProgress,
} from "./src/types/types";

interface ElectronAPI {
  // Video operations
  getVideos: () => Promise<Video[]>;
  getVideo: (id: number) => Promise<Video>;
  updateVideo: (id: number, data: VideoUpdateData) => Promise<boolean>;
  searchVideos: (query: string) => Promise<Video[]>;
  openVideo: (filePath: string) => Promise<void>;
  hasVideoUpdates: (lastCheckTime: number) => Promise<boolean>;

  // Directory operations
  getDirectories: () => Promise<Directory[]>;
  addDirectory: (path: string) => Promise<number>;
  removeDirectory: (path: string) => Promise<boolean>;
  chooseDirectory: () => Promise<string[]>;
  scanDirectories: () => Promise<ScanResult>;
  rescanAllVideos: () => Promise<ScanResult>;

  // Thumbnail operations
  generateThumbnails: () => Promise<void>;
  regenerateAllThumbnails: () => Promise<void>;
  regenerateMainThumbnail: (videoId: number) => Promise<Video>;
  updateThumbnailSettings: (settings: ThumbnailSettings) => Promise<boolean>;
  cleanupThumbnails: () => Promise<void>;
  getThumbnailsDir: () => Promise<string>;

  // Tag operations
  getTags: () => Promise<Tag[]>;
  addTagToVideo: (videoId: number, tagName: string) => Promise<boolean>;
  removeTagFromVideo: (videoId: number, tagName: string) => Promise<boolean>;
  deleteTag: (tagName: string) => Promise<boolean>;
  updateTag: (oldName: string, newName: string) => Promise<boolean>;

  // Directory management
  checkDirectoryExists: (dirPath: string) => Promise<boolean>;

  // Duplicate detection
  findDuplicates: () => Promise<DuplicateGroup[]>;
  deleteVideos: (
    videoIds: number[],
    moveToTrash?: boolean,
  ) => Promise<DeleteVideosResult>;

  // Event listeners
  onScanProgress: (callback: (data: ScanProgress) => void) => void;
  onDeleteProgress: (callback: (data: DeleteProgress) => void) => void;
  onRescanProgress: (callback: (data: ScanProgress) => void) => void;
  onThumbnailProgress: (callback: (data: ThumbnailProgress) => void) => void;
  onDuplicateSearchProgress: (
    callback: (data: {
      current: number;
      total: number;
      message: string;
    }) => void,
  ) => void;
  offDuplicateSearchProgress: (
    callback: (data: {
      current: number;
      total: number;
      message: string;
    }) => void,
  ) => void;
  onVideoAdded: (callback: (filePath: string) => void) => void;
  onVideoRemoved: (callback: (filePath: string) => void) => void;
  onDirectoryRemoved: (callback: (dirPath: string) => void) => void;
  onOpenSettings: (callback: () => void) => void;
  onOpenAddDirectory: (callback: () => void) => void;

  // Remove listeners
  removeAllListeners: (channel: string) => void;
}

const electronAPI: ElectronAPI = {
  // Video operations
  getVideos: () => ipcRenderer.invoke("get-videos"),
  getVideo: (id: number) => ipcRenderer.invoke("get-video", id),
  updateVideo: (id: number, data: VideoUpdateData) =>
    ipcRenderer.invoke("update-video", id, data),
  searchVideos: (query: string) => ipcRenderer.invoke("search-videos", query),
  openVideo: (filePath: string) => ipcRenderer.invoke("open-video", filePath),
  hasVideoUpdates: (lastCheckTime: number) =>
    ipcRenderer.invoke("has-video-updates", lastCheckTime),

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
  regenerateAllThumbnails: () =>
    ipcRenderer.invoke("regenerate-all-thumbnails"),
  regenerateMainThumbnail: (videoId: number) =>
    ipcRenderer.invoke("regenerate-main-thumbnail", videoId),
  updateThumbnailSettings: (settings: ThumbnailSettings) =>
    ipcRenderer.invoke("update-thumbnail-settings", settings),
  cleanupThumbnails: () => ipcRenderer.invoke("cleanup-thumbnails"),
  getThumbnailsDir: () => ipcRenderer.invoke("get-thumbnails-dir"),

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
    callback: (data: {
      current: number;
      total: number;
      message: string;
    }) => void,
  ) => {
    ipcRenderer.on("duplicate-search-progress", (_event, data) =>
      callback(data),
    );
  },
  offDuplicateSearchProgress: (
    callback: (data: {
      current: number;
      total: number;
      message: string;
    }) => void,
  ) => {
    ipcRenderer.removeListener("duplicate-search-progress", (_event, data) =>
      callback(data),
    );
  },

  // Event listeners
  // Event listeners
  onScanProgress: (callback: (data: ScanProgress) => void) => {
    ipcRenderer.on("scan-progress", (_event, data) => callback(data));
  },
  onRescanProgress: (callback: (data: ScanProgress) => void) => {
    ipcRenderer.on("rescan-progress", (_event, data) => callback(data));
  },
  onThumbnailProgress: (callback: (data: ThumbnailProgress) => void) => {
    ipcRenderer.on("thumbnail-progress", (_event, data) => callback(data));
  },
  onVideoAdded: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-added", (_event, filePath) => callback(filePath));
  },
  onVideoRemoved: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-removed", (_event, filePath) => callback(filePath));
  },
  onDirectoryRemoved: (callback: (dirPath: string) => void) => {
    ipcRenderer.on("directory-removed", (_event, dirPath) => callback(dirPath));
  },
  onDeleteProgress: (callback: (data: DeleteProgress) => void) => {
    ipcRenderer.on("delete-progress", (_event, data) => callback(data));
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
