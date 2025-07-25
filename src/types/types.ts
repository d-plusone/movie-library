/**
 * アプリケーション全体で使用する共通型定義
 * すべての型定義をここに一元化
 */

// ========================================
// 基本的なエンティティ型
// ========================================

export interface ChapterThumbnail {
  path: string;
  timestamp: number;
  index?: number;
}

export interface Video {
  id: number;
  path: string;
  title: string;
  filename: string;
  description?: string;
  rating?: number;
  tags?: string[];
  duration: number;
  size: bigint;
  width: number;
  height: number;
  addedAt: Date;
  modifiedAt?: Date;
  thumbnailPath?: string;
  chapterThumbnails?: ChapterThumbnail[];
  fps?: number;
  codec?: string;
  bitrate?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Directory {
  id?: number;
  path: string;
  name: string;
  addedAt: Date;
}

export interface Tag {
  id?: number;
  name: string;
  count?: number;
  color?: string;
}

// ========================================
// データ転送オブジェクト（DTO）型
// ========================================

export interface VideoCreateData {
  path: string;
  filename: string;
  title?: string;
  duration?: number;
  size?: bigint;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  createdAt?: string;
  modifiedAt?: string;
  thumbnailPath?: string;
  chapterThumbnails?: ChapterThumbnail[];
}

export interface VideoUpdateData {
  title?: string;
  rating?: number;
  description?: string;
  thumbnailPath?: string;
  chapterThumbnails?: ChapterThumbnail[];
}

// ========================================
// UI関連型
// ========================================

export interface ThumbnailInfo {
  src: string;
  label: string;
}

export interface Filter {
  tags: string[];
  directories: string[];
  rating: number;
  searchQuery?: string;
}

export interface VideoStats {
  totalVideos: number;
  totalTags: number;
  totalDirectories: number;
  totalDuration: number;
  totalSize: number;
}

export interface ThumbnailSettings {
  quality?: number;
  scale?: string;
  format?: string;
  width?: number;
  height?: number;
  count?: number;
  interval?: number;
  enabled?: boolean;
  maxCount?: number;
  compression?: string;
}

// ========================================
// 操作結果型
// ========================================

export interface ScanResult {
  totalNew: number;
  totalUpdated: number;
  totalReprocessed: number;
  totalDeleted?: number;
  totalProcessed?: number;
  totalErrors?: number;
}

export interface ScanProgress {
  current: number;
  total: number;
  file: string;
  phase: "scanning" | "processing" | "thumbnails";
  message?: string;
}

export interface ThumbnailProgress {
  current: number;
  total: number;
  file: string;
  phase: "main" | "chapters";
  message?: string;
}

// ========================================
// アプリケーション制御型（app.tsから移動）
// ========================================

// ソート関連の型
export interface SortState {
  field: string;
  order: "ASC" | "DESC";
}

// サムネイル表示関連の型
export interface ThumbnailData {
  path: string;
  timestamp: number;
  index: number;
}

// 一括タグ操作の型
export interface BulkTagChange {
  action: "add" | "remove";
  videoId: number;
  tagName: string;
}

// ========================================
// サムネイル生成関連型（ThumbnailGenerator.tsから移動）
// ========================================

export interface ThumbnailResult {
  mainThumbnail: string;
  chapterThumbnails: ChapterThumbnail[];
}

export interface RegenerateResult {
  thumbnailPath: string;
  timestamp: number;
  formattedTimestamp: string;
}

export interface ThumbnailOptions {
  width?: number;
  height?: number;
  quality?: number;
}

// ========================================
// ビジネスロジック型
// ========================================

export interface ProcessedVideo extends Video {
  isNewVideo: boolean;
  needsThumbnails: boolean;
}

export interface ComprehensiveScanResult {
  newVideos: ProcessedVideo[];
  updatedVideos: ProcessedVideo[];
  deletedVideos: string[];
  reprocessedVideos: ProcessedVideo[];
}

export interface ForceRescanResult {
  processedVideos: ProcessedVideo[];
  updatedVideos: ProcessedVideo[];
  deletedVideos: string[];
  totalProcessed: number;
  totalUpdated: number;
  totalErrors: number;
}

// ========================================
// プログレス管理型
// ========================================

export interface ProgressCallback {
  (progress: { current: number; total: number; file: string }): void;
}

export interface ProgressManager {
  showProgress: (message: string, progress: number) => void;
  hideProgress: () => void;
  handleScanProgress: (data: ScanProgress) => void;
  handleThumbnailProgress: (data: ThumbnailProgress) => void;
}

// ========================================
// テーマ管理型
// ========================================

export interface ThemeManager {
  getCurrentTheme: () => string;
  toggleTheme: () => void;
  applyTheme: (theme: string) => void;
}

// ========================================
// 通知管理型
// ========================================

export type NotificationType = "info" | "success" | "warning" | "error";

export interface NotificationManager {
  show: (message: string, type?: NotificationType, duration?: number) => void;
  hide: () => void;
}

// ========================================
// ビューモード型
// ========================================

export type ViewType = "grid" | "list";

// ========================================
// FFmpeg メタデータ型
// ========================================

export interface VideoMetadata {
  format: {
    duration?: number | string;
    bit_rate?: number | string;
    size?: bigint | string;
    format_name?: string;
  };
  streams: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: number | string;
    bit_rate?: number | string;
  }>;
}
