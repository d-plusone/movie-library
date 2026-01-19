import type {
  Video,
  Directory,
  Tag,
  ThumbnailSettings,
  ScanResult,
  DuplicateGroup,
  DeleteVideosResult,
  DeleteProgress,
} from "./types";

// Electron API専用の型拡張（IDが文字列の場合など）
export interface ElectronVideo extends Omit<Video, "id"> {
  id: string; // Electron APIではIDは文字列
}

export interface ElectronDirectory extends Omit<Directory, "id"> {
  id?: string;
}

export interface ElectronTag extends Omit<Tag, "id"> {
  id?: string;
}

// Electron Main Process API
declare global {
  interface Window {
    electronAPI: {
      // Video operations
      getVideos(): Promise<ElectronVideo[]>;
      updateVideo(id: string, data: Partial<ElectronVideo>): Promise<void>;
      openVideo(path: string): Promise<void>;
      loadVideos(forceReload?: boolean): Promise<ElectronVideo[]>;
      playVideo(path: string): Promise<void>;
      hasVideoUpdates(lastCheckTime: number): Promise<boolean>;

      // Directory operations
      getDirectories(): Promise<ElectronDirectory[]>;
      addDirectory(directoryPath?: string): Promise<ElectronDirectory[]>;
      removeDirectory(directoryPath: string): Promise<void>;
      chooseDirectory(): Promise<string[]>;
      scanDirectories(): Promise<ScanResult>;
      rescanAllVideos(): Promise<ScanResult>;

      // Tag operations
      getTags(): Promise<ElectronTag[]>;
      addTagToVideo(videoId: string, tagName: string): Promise<void>;
      removeTagFromVideo(videoId: string, tagName: string): Promise<void>;
      deleteTag(tagName: string): Promise<void>;
      updateTag(oldName: string, newName: string): Promise<void>;

      // Thumbnail operations
      generateThumbnails(): Promise<void>;
      updateThumbnailSettings(settings: ThumbnailSettings): Promise<void>;
      regenerateAllThumbnails(): Promise<void>;
      regenerateMainThumbnail(videoId: string): Promise<ElectronVideo>;
      cleanupThumbnails(): Promise<void>;
      getThumbnailsDir(): Promise<string>;

      // Progress callbacks
      onScanProgress(callback: (data: ScanProgress) => void): void;
      onThumbnailProgress(callback: (data: ThumbnailProgress) => void): void;
      onRescanProgress(callback: (data: ScanProgress) => void): void;
      onDuplicateSearchProgress(
        callback: (data: {
          current: number;
          total: number;
          message: string;
        }) => void,
      ): void;
      offDuplicateSearchProgress(
        callback: (data: {
          current: number;
          total: number;
          message: string;
        }) => void,
      ): void;

      // Event listeners
      onVideoAdded(callback: (filePath: string) => void): void;
      onVideoRemoved(callback: (filePath: string) => void): void;
      onDirectoryRemoved(callback: (dirPath: string) => void): void;
      onOpenSettings(callback: () => void): void;
      onOpenAddDirectory(callback: () => void): void;
      onDeleteProgress(callback: (data: DeleteProgress) => void): void;

      // Utility methods
      checkDirectoryExists(dirPath: string): Promise<boolean>;

      // Duplicate detection
      findDuplicates(): Promise<DuplicateGroup[]>;
      deleteVideos(
        videoIds: number[],
        moveToTrash?: boolean,
      ): Promise<DeleteVideosResult>;

      // Theme management
      theme: ThemeManager;

      // Progress management
      progress: ProgressManager;
    };
  }
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

export interface ProgressManager {
  showProgress(message: string, progress: number): void;
  hideProgress(): void;
  handleScanProgress(data: ScanProgress): void;
  handleThumbnailProgress(data: ThumbnailProgress): void;
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
