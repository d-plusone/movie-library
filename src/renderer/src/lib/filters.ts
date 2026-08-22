/**
 * 動画のフィルタリング・ソート（旧 app.ts applyFiltersAndSort の移植）
 */
import type { FilterState, Video } from "../types";
import { getResolutionLabel, type ResolutionLabel } from "./format";

/** ソート対象フィールド */
export type SortField =
  | "filename"
  | "title"
  | "duration"
  | "size"
  | "createdAt"
  | "rating"
  | "addedAt";

export interface SortSpec {
  field: SortField;
  order: "ASC" | "DESC";
}

const collator = new Intl.Collator("ja");

function compareValues(a: Video[SortField], b: Video[SortField]): number {
  // Date 型
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  // bigint 型（size）
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return collator.compare(a, b);
  }
  return collator.compare(String(a ?? ""), String(b ?? ""));
}

/** null / undefined を先頭に寄せつつ指定順でソートした新しい配列を返す */
export function sortVideos(videos: Video[], spec: SortSpec): Video[] {
  const sorted = [...videos];
  sorted.sort((a, b) => {
    const aKey = a[spec.field];
    const bKey = b[spec.field];
    if (aKey == null && bKey == null) return 0;
    if (aKey == null) return spec.order === "ASC" ? -1 : 1;
    if (bKey == null) return spec.order === "ASC" ? 1 : -1;
    const compared = compareValues(aKey as Video[SortField], bKey as Video[SortField]);
    return spec.order === "ASC" ? compared : -compared;
  });
  return sorted;
}

export interface SearchTarget {
  search: string;
}

/** ファセット集計時に除外するフィルタ次元 */
export type FilterDimension = "tags" | "resolutions" | "codecs";

export interface FilterVideosOptions {
  /**
   * 指定した次元のフィルタを適用せずに絞り込む。
   * サイドバーの件数表示など、ファセット（他軸の選択を反映した件数）計算に使う。
   */
  skip?: FilterDimension[];
}

/**
 * フィルタ状態と検索語で動画を絞り込む。
 * ディレクトリフィルタは利用可能ディレクトリが存在する限り常に適用され、
 * 全解除状態では何も表示しない（旧実装の挙動を維持）。
 */
export function filterVideos(
  videos: Video[],
  state: FilterState,
  availableDirectoryCount: number,
  search: string,
  options: FilterVideosOptions = {},
): Video[] {
  const query = search.trim().toLowerCase();
  const skip = options.skip ?? [];

  return videos.filter((video) => {
    if (state.rating > 0 && (video.rating || 0) < state.rating) {
      return false;
    }

    if (!skip.includes("tags")) {
      if (state.tags.length > 0) {
        const videoTags = video.tags || [];
        if (!state.tags.some((tag) => videoTags.includes(tag))) {
          return false;
        }
      }
    }

    if (availableDirectoryCount > 0) {
      if (state.directories.length === 0) {
        return false;
      }
      const normalizedVideoPath = video.path.replace(/\\/g, "/");
      const matched = state.directories.some((dir) => {
        const normalizedDir = dir.replace(/\\/g, "/");
        const dirWithSlash = normalizedDir.endsWith("/")
          ? normalizedDir
          : `${normalizedDir}/`;
        const videoDir = normalizedVideoPath.substring(
          0,
          normalizedVideoPath.lastIndexOf("/") + 1,
        );
        // 完全一致（直下ファイル）またはサブディレクトリ配下
        return videoDir === dirWithSlash || normalizedVideoPath.startsWith(dirWithSlash);
      });
      if (!matched) {
        return false;
      }
    }

    if (!skip.includes("resolutions")) {
      if (state.resolutions.length > 0) {
        const label = getResolutionLabel(video.width ?? 0, video.height ?? 0);
        if (label === null || !state.resolutions.includes(label)) {
          return false;
        }
      }
    }

    if (!skip.includes("codecs")) {
      if (state.codecs.length > 0) {
        const codec = (video.codec || "").trim();
        if (!codec || !state.codecs.includes(codec)) {
          return false;
        }
      }
    }

    if (query) {
      const matches =
        video.title.toLowerCase().includes(query) ||
        video.filename.toLowerCase().includes(query) ||
        (video.description !== undefined &&
          video.description.toLowerCase().includes(query)) ||
        (video.tags !== undefined &&
          video.tags.some((tag) => tag.toLowerCase().includes(query)));
      if (!matches) {
        return false;
      }
    }

    return true;
  });
}

export interface FilterOptionCount {
  label: string;
  count: number;
}

/** 解像度バケットごとの件数（0 件は非表示） */
export function resolutionOptions(videos: Video[]): FilterOptionCount[] {
  const counts = new Map<ResolutionLabel, number>();
  for (const video of videos) {
    const label = getResolutionLabel(video.width ?? 0, video.height ?? 0);
    if (label) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return RESOLUTION_ORDER.map((label) => ({
    label,
    count: counts.get(label) ?? 0,
  })).filter((option) => option.count > 0);
}

const RESOLUTION_ORDER: ResolutionLabel[] = ["4K", "1440p", "1080p", "720p", "SD"];

/** 保存済みの利用可能ディレクトリ数を取得する（ディレクトリフィルタの有効判定用） */
export function readStoredDirectoryCount(): number {
  try {
    const parsed: string[] = JSON.parse(
      localStorage.getItem("availableDirectories") ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** コーデックごとの件数（件数降順 → 名前昇順） */
export function codecOptions(videos: Video[]): FilterOptionCount[] {
  const counts = new Map<string, number>();
  for (const video of videos) {
    const codec = (video.codec || "").trim();
    if (!codec) continue;
    counts.set(codec, (counts.get(codec) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
}
