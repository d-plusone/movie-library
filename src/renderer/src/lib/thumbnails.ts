import { pathToFileUrl } from "./format";
import type { Video } from "../types";

/** サムネイル生成前でもカードの寸法を確保する共通プレースホルダー。 */
export const PLACEHOLDER_THUMBNAIL =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+PHBhdGggZD0iTTEyOCA3MkwxOTIgMTA4TDEyOCAxNDRWNzJaIiBmaWxsPSIjOTk5OTk5Ii8+PC9zdmc+";

export function thumbnailUrl(video: Video, thumbnailPath: string): string {
  const version = video.updatedAt instanceof Date ? video.updatedAt.getTime() : 0;
  return `${pathToFileUrl(thumbnailPath)}?t=${version}`;
}
