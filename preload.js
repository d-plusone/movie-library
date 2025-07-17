const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Video operations
  getVideos: () => ipcRenderer.invoke("get-videos"),
  getVideo: (id) => ipcRenderer.invoke("get-video", id),
  updateVideo: (id, data) => ipcRenderer.invoke("update-video", id, data),
  searchVideos: (query) => ipcRenderer.invoke("search-videos", query),
  openVideo: (filePath) => ipcRenderer.invoke("open-video", filePath),
  hasVideoUpdates: (lastCheckTime) =>
    ipcRenderer.invoke("has-video-updates", lastCheckTime),

  // Directory operations
  getDirectories: () => ipcRenderer.invoke("get-directories"),
  addDirectory: (path) => ipcRenderer.invoke("add-directory", path),
  removeDirectory: (path) => ipcRenderer.invoke("remove-directory", path),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  scanDirectories: () => ipcRenderer.invoke("scan-directories"),

  // Thumbnail operations
  generateThumbnails: () => ipcRenderer.invoke("generate-thumbnails"),
  regenerateAllThumbnails: () =>
    ipcRenderer.invoke("regenerate-all-thumbnails"),
  regenerateMainThumbnail: (videoId) =>
    ipcRenderer.invoke("regenerate-main-thumbnail", videoId),
  updateThumbnailSettings: (settings) =>
    ipcRenderer.invoke("update-thumbnail-settings", settings),

  // Tag operations
  getTags: () => ipcRenderer.invoke("get-tags"),
  addTagToVideo: (videoId, tagName) =>
    ipcRenderer.invoke("add-tag-to-video", videoId, tagName),
  removeTagFromVideo: (videoId, tagName) =>
    ipcRenderer.invoke("remove-tag-from-video", videoId, tagName),
  deleteTag: (tagName) => ipcRenderer.invoke("delete-tag", tagName),
  updateTag: (oldName, newName) =>
    ipcRenderer.invoke("update-tag", oldName, newName),

  // Event listeners
  onScanProgress: (callback) => {
    ipcRenderer.on("scan-progress", (event, data) => callback(data));
  },
  onThumbnailProgress: (callback) => {
    ipcRenderer.on("thumbnail-progress", (event, data) => callback(data));
  },
  onVideoAdded: (callback) => {
    ipcRenderer.on("video-added", (event, filePath) => callback(filePath));
  },
  onVideoRemoved: (callback) => {
    ipcRenderer.on("video-removed", (event, filePath) => callback(filePath));
  },
  onOpenSettings: (callback) => {
    ipcRenderer.on("open-settings", () => callback());
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
