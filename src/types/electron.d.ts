// TypeScript global declarations for Electron API

export interface Video {
  id: string;
  filename: string;
  title: string;
  path: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  thumbnail_path?: string;
  chapter_thumbnails?: ChapterThumbnail[] | string;
  tags?: string[];
  rating?: number;
  description?: string;
  added_at: string;
  fileSize?: number;
  filePath?: string;
}

export interface ChapterThumbnail {
  path: string;
  timestamp: number;
  thumbnail_path?: string;
}

export interface ThumbnailInfo {
  src: string;
  label: string;
}

export interface Tag {
  name: string;
  count: number;
}

export interface Directory {
  path: string;
  name: string;
}

export interface Filter {
  tags: string[];
  rating: number;
  searchQuery: string;
}

export interface ThumbnailSettings {
  quality: number;
  width: number;
  height: number;
}

export interface ScanProgress {
  type: string;
  current?: number;
  total?: number;
  file?: string;
  message?: string;
  error?: string;
}

export interface ThumbnailProgress {
  type: string;
  current?: number;
  total?: number;
  file?: string;
  message?: string;
  error?: string;
}

export interface ElectronAPI {
  // Video operations
  getVideos(): Promise<Video[]>;
  getVideo(id: string): Promise<Video>;
  updateVideo(id: string, data: Partial<Video>): Promise<Video>;
  searchVideos(query: string): Promise<Video[]>;
  hasVideoUpdates(lastCheckTime: number): Promise<boolean>;
  openVideo(filePath: string): Promise<void>;
  loadVideos(forceReload?: boolean): Promise<Video[]>;
  playVideo(path: string): Promise<void>;

  // Directory operations
  getDirectories(): Promise<Directory[]>;
  addDirectory(directoryPath?: string): Promise<Directory[]>;
  removeDirectory(directoryPath: string): Promise<void>;
  chooseDirectory(): Promise<string[]>;
  scanDirectories(): Promise<void>;

  // Tag operations
  getTags(): Promise<Tag[]>;
  addTagToVideo(videoId: string, tagName: string): Promise<void>;
  removeTagFromVideo(videoId: string, tagName: string): Promise<void>;
  deleteTag(tagName: string): Promise<void>;
  updateTag(oldName: string, newName: string): Promise<void>;

  // Thumbnail operations
  generateThumbnails(): Promise<void>;
  updateThumbnailSettings(settings: ThumbnailSettings): Promise<void>;
  regenerateAllThumbnails(): Promise<void>;
  regenerateMainThumbnail(videoId: string): Promise<Video>;
  setMainThumbnail(filePath: string, timestamp: number): Promise<void>;

  // Directory management
  checkDirectoryExists(dirPath: string): Promise<boolean>;

  // Event listeners
  onScanProgress(callback: (data: ScanProgress) => void): void;
  onThumbnailProgress(callback: (data: ThumbnailProgress) => void): void;
  onVideoAdded(callback: (filePath: string) => void): void;
  onVideoRemoved(callback: (filePath: string) => void): void;
  onDirectoryRemoved(callback: (dirPath: string) => void): void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export interface NotificationManager {
  show(message: string, type?: "info" | "success" | "warning" | "error"): void;
}

export interface ProgressManager {
  showProgress(message: string, progress: number): void;
  hideProgress(): void;
  handleScanProgress(data: ScanProgress): any;
  handleThumbnailProgress(data: ThumbnailProgress): any;
}

export interface ThemeManager {
  getCurrentTheme(): string;
  toggleTheme(): void;
  applyTheme(theme: string): void;
  updatePlaceholderColors(): void;
}

export type ViewType = "grid" | "list";
export type SortOption = "title" | "date" | "size" | "duration" | "rating";

export {};
