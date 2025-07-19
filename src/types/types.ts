// Type definitions for Movie Library App

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

export interface NotificationManager {
  show: (
    message: string,
    type?: "info" | "success" | "warning" | "error"
  ) => void;
}

export interface ProgressManager {
  showProgress: (message: string, progress: number) => void;
  hideProgress: () => void;
  handleScanProgress: (data: ScanProgress) => any;
  handleThumbnailProgress: (data: ThumbnailProgress) => any;
}

export interface ThemeManager {
  getCurrentTheme: () => string;
  toggleTheme: () => void;
  applyTheme: (theme: string) => void;
  updatePlaceholderColors: () => void;
}

export type ViewType = "grid" | "list";
export type SortOption = "title" | "date" | "size" | "duration" | "rating";
