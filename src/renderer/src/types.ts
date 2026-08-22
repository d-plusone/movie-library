/**
 * レンダラー側で使う型のバレル。
 * main / preload と共有する型は src/types/types.ts、
 * renderer 固有の UI 状態型はここで定義する。
 */
import type { Video as SharedVideo } from "../../types/types";

export * from "../../types/types";

/** サイドバーのフィルタ状態 */
export interface FilterState {
  rating: number;
  tags: string[];
  directories: string[];
  resolutions: string[];
  codecs: string[];
}

/** 詳細パネル等で選択中の動画参照 */
export type SelectedVideo = SharedVideo;

/** 通知種別（CSS クラス名に対応） */
export type NotificationType = "info" | "success" | "warning" | "error";
