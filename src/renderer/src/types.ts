/**
 * レンダラー側で使う型のバレル。
 * main / preload と共有する型は src/types/types.ts、
 * renderer 固有の UI 状態型はここで定義する。
 */
import type { Video as SharedVideo } from "../../types/types";

export * from "../../types/types";

/** サイドバーのフィルタ状態 */
export type TagMatchMode = "OR" | "AND";

export interface FilterState {
  rating: number;
  tags: string[];
  directories: string[];
  resolutions: string[];
  codecs: string[];
  tagMatchMode: TagMatchMode;
  unratedOnly: boolean;
  untaggedOnly: boolean;
}

export interface SavedFilter {
  id: string;
  name: string;
  filters: FilterState;
  search: string;
  createdAt: string;
  updatedAt: string;
}

/** 詳細パネル等で選択中の動画参照 */
export type SelectedVideo = SharedVideo;
