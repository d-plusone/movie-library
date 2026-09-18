/**
 * アプリケーション全体で使用する共通型定義
 * すべての型定義をここに一元化
 */

// ========================================
// 基本的なエンティティ型
// ========================================

/**
 * 通知トーストの種別（CSS クラス名に対応）
 */
export type NotificationType = "info" | "success" | "warning" | "error";

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
  watchedAt?: Date;
  watchPosition?: number;
}

export interface Directory {
  id?: number;
  path: string;
  name: string;
  addedAt: Date;
}

/**
 * 登録ディレクトリの接続状態。
 * NAS（SMB 共有）の切断中は "offline"（登録は維持し、再接続を試行する）。
 */
export type DirectoryAvailability = "online" | "offline";

export interface DirectoryStatus {
  path: string;
  status: DirectoryAvailability;
  /** 変化前の状態（未確定の場合は undefined）。描画側の通知判定に使う */
  previousStatus?: DirectoryAvailability;
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
  addedAt?: Date;
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
  watchedAt?: Date;
  watchPosition?: number;
}

// ========================================
// UI関連型
// ========================================

export interface ThumbnailInfo {
  src: string;
  label: string;
}

export interface ThumbnailSettings {
  quality?: number;
  width?: number;
  height?: number;
  size?: string; // "1280x720" or "854x480" format
}

export interface Filter {
  tags: string[];
  directories: string[];
  rating: number;
  searchQuery?: string;
  resolutions?: string[];
  codecs?: string[];
}

export interface FilterStateData {
  selectedDirectories?: string[];
  selectedTags?: string[];
  ratingFilter?: number;
  resolutions?: string[];
  codecs?: string[];
}

// サイドバーのフィルターオプション（ラベル + 件数）
export interface FilterOptionCount {
  label: string;
  count: number;
}

export interface VideoStats {
  totalVideos: number;
  totalTags: number;
  totalDirectories: number;
  totalDuration: number;
  totalSize: number;
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

/** 実際のDB更新を行わずに算出したスキャン差分。 */
export interface ScanPreviewResult {
  totalNew: number;
  totalUpdated: number;
  totalDeleted: number;
  totalReprocessed: number;
  totalErrors: number;
  errors: ScanError[];
  scannedDirectories: number;
}

/**
 * プログレスイベント（scan-progress / rescan-progress / thumbnail-progress チャネルのペイロード）
 * 「進捗中」と「完了」を判別可能ユニオンで表現する
 */
export type ProgressEvent =
  | {
      kind: "progress";
      current: number;
      total: number;
      /** 表示用メッセージ（省略時は受信側でラベルを生成する） */
      message?: string;
      /** 処理対象ファイル名 */
      file?: string;
      /** true のときトースト通知は出さず、進捗オーバーレイにのみ表示する */
      silent?: boolean;
    }
  | {
      kind: "done";
      message: string;
      /** トーストの種別（省略時は "success"） */
      type?: NotificationType;
      /** true のときはトーストを出さない（no-op 完了。進行中エントリが無ければオーバーレイにも出さない） */
      silent?: boolean;
    };

/** 重複検索の進捗（duplicate-search-progress チャネル） */
export interface DuplicateSearchProgress {
  current: number;
  total: number;
  message: string;
  /** 現在の工程内の進捗（部分ハッシュ更新時のみ設定） */
  detailCurrent?: number;
  detailTotal?: number;
}

/** 汎用の操作進捗（container-check-progress / container-convert-progress チャネル） */
export interface OperationProgress {
  current: number;
  total: number;
  message: string;
}

/**
 * 拡張子チェックで検出された「再生できない / 拡張子不一致」動画
 */
export interface ContainerMismatchItem {
  videoId: number;
  path: string;
  filename: string;
  size: number;
  /** パスの拡張子（ドット付き・小文字） */
  extension: string;
  /** 実際のコンテナ種別（"isobmff" | "webm" | "mpegts" | "avi" | "flv" | "unknown"） */
  detectedKind: string;
  detectedLabel: string;
  /** 内蔵プレーヤーで再生できないコンテナか（MPEG-TS 等） */
  nativePlayable: boolean;
  /** 拡張子と実際のコンテナが一致しないか */
  extensionMismatch: boolean;
  /** ストリームコピーで MP4 への上書き変換が可能か（拡張子が .mp4/.m4v のみ） */
  convertible: boolean;
}

/** 単一動画の変換結果 */
export interface ConvertItemResult {
  path: string;
  ok: boolean;
  error?: string;
}

/** 一括変換の結果 */
export interface ConvertVideosResult {
  succeeded: number;
  failed: number;
  items: ConvertItemResult[];
}

/** フレームキャプチャ（スクリーンショット保存）の結果 */
export interface CaptureFrameResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/** サムネイルクリーンアップの結果 */
export interface CleanupThumbnailsResult {
  removedFiles: number;
  totalSize: number;
}

export interface FileExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

/** 起動時サムネイル補完の結果 */
export interface IncompleteThumbnailsResult {
  /** 走査した動画数 */
  total: number;
  /** サムネイルを生成した動画数 */
  generated: number;
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

export interface BulkTagResult {
  affected: number;
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

export interface ScanError {
  filePath: string;
  error: string;
  errorCode?: string;
  timestamp: Date;
}

export interface ComprehensiveScanResult {
  newVideos: ProcessedVideo[];
  updatedVideos: ProcessedVideo[];
  deletedVideos: string[];
  reprocessedVideos: ProcessedVideo[];
  errors: ScanError[];
}

export interface ForceRescanResult {
  processedVideos: ProcessedVideo[];
  updatedVideos: ProcessedVideo[];
  deletedVideos: string[];
  totalProcessed: number;
  totalUpdated: number;
  totalErrors: number;
  errors: ScanError[];
}

// ========================================
// プログレス管理型
// ========================================

export interface ProgressCallback {
  (progress: { current: number; total: number; file: string }): void;
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

// Duplicate detection types
export interface DuplicateVideo {
  id: number;
  path: string;
  filename: string;
  size: bigint;
  width: number;
  height: number;
  duration: number;
  partialHash: string;
  thumbnailPath?: string | null;
}

export interface DuplicateGroup {
  videos: DuplicateVideo[];
  hash: string;
}

export interface DeleteVideosResult {
  success: number;
  failed: number;
}

/**
 * 重複動画の削除リクエスト。
 * verifyAgainstVideoId は同一グループ内で保持する動画の ID — 削除前に
 * バイト単位で内容が一致することを確認するための基準として main 側で使用する。
 */
export interface DeleteVideoRequest {
  videoId: number;
  verifyAgainstVideoId: number;
}

export interface DeleteProgress {
  current: number;
  total: number;
}
