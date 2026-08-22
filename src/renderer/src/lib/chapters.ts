/**
 * chapterThumbnails のバリデーション付きパース。
 * DB 層（mapVideoRecord）が既に配列へ正規化して返すため、
 * ここでは要素の構造検証のみ行う。
 */
import type { ChapterThumbnail, Video } from "../../../types/types";

interface RawChapter {
  path?: string;
  timestamp?: number;
}

function isValidChapter(value: RawChapter | null | undefined): value is ChapterThumbnail {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.path === "string" &&
    typeof value.timestamp === "number"
  );
}

/** 無効な要素を除去したチャプターリストを返す */
export function parseChapters(
  raw: Video["chapterThumbnails"],
): ChapterThumbnail[] {
  if (!Array.isArray(raw)) return [];
  const candidates: readonly RawChapter[] = raw;
  return candidates.filter(isValidChapter);
}
