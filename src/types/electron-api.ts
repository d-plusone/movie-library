/**
 * Electron IPC 契約（preload ↔ renderer 共通の型定義）
 *
 * このインターフェースが window.electronAPI の唯一の真実源（Single Source of Truth）。
 * - preload.ts はこの型で実装をアノテートするため、メンバーの過不足はコンパイルエラーになる
 * - electron.d.ts はこの型を Window.electronAPI へ反映する
 * - main プロセスに IPC チャネルを追加・変更した場合は、必ずここも更新する
 */

import type {
  CleanupThumbnailsResult,
  CaptureFrameResult,
  BulkTagChange,
  BulkTagResult,
  ContainerMismatchItem,
  ConvertVideosResult,
  DeleteProgress,
  DeleteVideoRequest,
  DeleteVideosResult,
  Directory,
  DirectoryAvailability,
  DirectoryStatus,
  DuplicateGroup,
  DuplicateSearchProgress,
  IncompleteThumbnailsResult,
  OperationProgress,
  ProgressEvent,
  FileExportResult,
  ScanResult,
  ScanPreviewResult,
  Tag,
  ThumbnailResult,
  ThumbnailSettings,
  Video,
  VideoUpdateData,
} from "./types";

export interface ElectronAPI {
  /** production ビルドかどうか（main プロセスから追加引数経由で渡される） */
  isProduction: boolean;

  // ---- Video operations ----
  getVideos(): Promise<Video[]>;
  updateVideo(id: number, data: VideoUpdateData): Promise<boolean>;
  openVideo(filePath: string): Promise<void>;
  hasVideoUpdates(lastCheckTime: number): Promise<boolean>;
  /** 現在のフレームを PNG で保存する（最高画質スクリーンショット） */
  captureFrame(
    videoPath: string,
    timestamp: number,
    outputDir: string,
  ): Promise<CaptureFrameResult>;
  selectScreenshotDir(): Promise<string | null>;
  backupDatabase(): Promise<FileExportResult>;
  exportTags(format: "json" | "csv"): Promise<FileExportResult>;

  // ---- Directory operations ----
  getDirectories(): Promise<Directory[]>;
  /** ディレクトリを登録して新規 ID を返す */
  addDirectory(path: string): Promise<number>;
  removeDirectory(path: string): Promise<boolean>;
  chooseDirectory(): Promise<string[]>;
  scanDirectories(): Promise<ScanResult>;
  previewScan(): Promise<ScanPreviewResult>;
  rescanAllVideos(): Promise<ScanResult>;
  /**
   * 登録ディレクトリの接続状態（path -> "online" | "offline"）。
   * NAS の切断中も登録は維持され、offline として報告される。
   */
  getDirectoryStatuses(): Promise<Record<string, DirectoryAvailability>>;

  // ---- Thumbnail operations ----
  generateThumbnails(): Promise<ThumbnailResult[]>;
  generateIncompleteThumbnails(): Promise<IncompleteThumbnailsResult>;
  regenerateAllThumbnails(): Promise<ThumbnailResult[]>;
  /** null は再生成後の再取得時点で動画が削除済みだった場合 */
  regenerateMainThumbnail(videoId: number): Promise<Video | null>;
  regenerateMainThumbnailWithTimestamp(
    videoId: number,
    timestamp: number,
  ): Promise<Video | null>;
  updateThumbnailSettings(settings: ThumbnailSettings): Promise<boolean>;
  cleanupThumbnails(): Promise<CleanupThumbnailsResult>;
  getThumbnailsDir(): Promise<string>;
  generatePreviewThumbnail(
    videoPath: string,
    timestamp: number,
  ): Promise<string>;
  deletePreviewThumbnail(previewPath: string): Promise<boolean>;

  // ---- Tag operations ----
  getTags(): Promise<Tag[]>;
  addTagToVideo(videoId: number, tagName: string): Promise<boolean>;
  removeTagFromVideo(videoId: number, tagName: string): Promise<boolean>;
  addTagsToVideos(videoIds: number[], tagNames: string[]): Promise<BulkTagResult>;
  removeTagsFromVideos(videoIds: number[], tagNames: string[]): Promise<BulkTagResult>;
  applyBulkTagChanges(changes: BulkTagChange[]): Promise<BulkTagResult>;
  deleteTag(tagName: string): Promise<boolean>;
  updateTag(oldName: string, newName: string): Promise<boolean>;

  // ---- Directory management ----
  checkDirectoryExists(dirPath: string): Promise<boolean>;

  // ---- Duplicate detection ----
  findDuplicates(): Promise<DuplicateGroup[]>;
  cancelDuplicateSearch(): Promise<void>;
  /**
   * 重複動画を削除する。各リクエストの verifyAgainstVideoId で指定した
   * 「保持する」動画とバイト単位で内容が一致することを、main 側が削除前に確認する。
   */
  deleteVideos(
    requests: DeleteVideoRequest[],
    moveToTrash?: boolean,
  ): Promise<DeleteVideosResult>;

  // ---- Container check / remux ----
  /** ライブラリ内の「拡張子不一致 or 内蔵再生不可コンテナ」動画を列挙する */
  checkContainerMismatches(): Promise<ContainerMismatchItem[]>;
  /** 選択された動画をストリームコピーで MP4 にリマックスし、元ファイルを上書きする */
  convertVideosToMp4(videoIds: number[]): Promise<ConvertVideosResult>;
  onContainerCheckProgress(
    callback: (data: OperationProgress) => void,
  ): void;
  offContainerCheckProgress(
    callback: (data: OperationProgress) => void,
  ): void;
  onContainerConvertProgress(
    callback: (data: OperationProgress) => void,
  ): void;
  offContainerConvertProgress(
    callback: (data: OperationProgress) => void,
  ): void;

  // ---- Event listeners ----
  onScanProgress(callback: (data: ProgressEvent) => void): void;
  offScanProgress(callback: (data: ProgressEvent) => void): void;
  onRescanProgress(callback: (data: ProgressEvent) => void): void;
  offRescanProgress(callback: (data: ProgressEvent) => void): void;
  onThumbnailProgress(callback: (data: ProgressEvent) => void): void;
  offThumbnailProgress(callback: (data: ProgressEvent) => void): void;
  onDuplicateSearchProgress(
    callback: (data: DuplicateSearchProgress) => void,
  ): void;
  offDuplicateSearchProgress(
    callback: (data: DuplicateSearchProgress) => void,
  ): void;
  onVideoAdded(callback: (filePath: string) => void): void;
  offVideoAdded(callback: (filePath: string) => void): void;
  onVideoRemoved(callback: (filePath: string) => void): void;
  offVideoRemoved(callback: (filePath: string) => void): void;
  /** ディレクトリの接続状態が変化した（NAS 切断 / 再接続） */
  onDirectoryStatusChanged(callback: (data: DirectoryStatus) => void): void;
  offDirectoryStatusChanged(callback: (data: DirectoryStatus) => void): void;
  onDeleteProgress(callback: (data: DeleteProgress) => void): void;
  offDeleteProgress(callback: (data: DeleteProgress) => void): void;
  onOpenSettings(callback: () => void): void;
  offOpenSettings(callback: () => void): void;
  onOpenAddDirectory(callback: () => void): void;
  offOpenAddDirectory(callback: () => void): void;

  // ---- Listener cleanup ----
  removeAllListeners(channel: string): void;
}
