import { contextBridge, ipcRenderer } from "electron";

interface ThumbnailSettings {
  quality?: number;
  scale?: string;
  format?: string;
  [key: string]: any;
}

interface VideoUpdateData {
  title?: string;
  rating?: number;
  description?: string;
  thumbnailPath?: string;
  chapterThumbnails?: any[];
}

interface ElectronAPI {
  // Video operations
  getVideos: () => Promise<any[]>;
  getVideo: (id: number) => Promise<any>;
  updateVideo: (id: number, data: VideoUpdateData) => Promise<boolean>;
  searchVideos: (query: string) => Promise<any[]>;
  openVideo: (filePath: string) => Promise<void>;
  hasVideoUpdates: (lastCheckTime: number) => Promise<boolean>;

  // Directory operations
  getDirectories: () => Promise<any[]>;
  addDirectory: (path: string) => Promise<number>;
  removeDirectory: (path: string) => Promise<boolean>;
  chooseDirectory: () => Promise<string[]>;
  scanDirectories: () => Promise<any[]>;
  rescanAllVideos: () => Promise<any>;

  // Thumbnail operations
  generateThumbnails: () => Promise<any[]>;
  regenerateAllThumbnails: () => Promise<any[]>;
  regenerateMainThumbnail: (videoId: number) => Promise<any>;
  updateThumbnailSettings: (settings: ThumbnailSettings) => Promise<boolean>;
  cleanupThumbnails: () => Promise<void>;

  // Tag operations
  getTags: () => Promise<any[]>;
  addTagToVideo: (videoId: number, tagName: string) => Promise<boolean>;
  removeTagFromVideo: (videoId: number, tagName: string) => Promise<boolean>;
  deleteTag: (tagName: string) => Promise<boolean>;
  updateTag: (oldName: string, newName: string) => Promise<boolean>;

  // Directory management
  checkDirectoryExists: (dirPath: string) => Promise<boolean>;

  // Event listeners
  onScanProgress: (callback: (data: any) => void) => void;
  onRescanProgress: (callback: (data: any) => void) => void;
  onThumbnailProgress: (callback: (data: any) => void) => void;
  onVideoAdded: (callback: (filePath: string) => void) => void;
  onVideoRemoved: (callback: (filePath: string) => void) => void;
  onDirectoryRemoved: (callback: (dirPath: string) => void) => void;
  onOpenSettings: (callback: () => void) => void;

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

  // Event listeners
  onScanProgress: (callback: (data: any) => void) => {
    ipcRenderer.on("scan-progress", (event, data) => callback(data));
  },
  onRescanProgress: (callback: (data: any) => void) => {
    ipcRenderer.on("rescan-progress", (event, data) => callback(data));
  },
  onThumbnailProgress: (callback: (data: any) => void) => {
    ipcRenderer.on("thumbnail-progress", (event, data) => callback(data));
  },
  onVideoAdded: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-added", (event, filePath) => callback(filePath));
  },
  onVideoRemoved: (callback: (filePath: string) => void) => {
    ipcRenderer.on("video-removed", (event, filePath) => callback(filePath));
  },
  onDirectoryRemoved: (callback: (dirPath: string) => void) => {
    ipcRenderer.on("directory-removed", (event, dirPath) => callback(dirPath));
  },
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on("open-settings", () => callback());
  },

  // Remove listeners
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
