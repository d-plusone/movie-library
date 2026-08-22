/**
 * 表示フォーマット系ユーティリティ（旧 FormatUtils の React 版）
 */

/** 秒数を HH:MM:SS 形式へ整形する */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

/** バイト数を人間可読なサイズ文字列へ整形する（bigint 対応） */
export function formatFileSize(bytes: number | bigint): string {
  const num = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!num || num <= 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  const value = parseFloat((num / Math.pow(k, i)).toFixed(2));
  return `${value} ${sizes[i]}`;
}

/** ファイル名から拡張子を大文字で取り出す */
export function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop();
  return ext ? ext.toUpperCase() : "";
}

/**
 * ファイルパスを local-file:// URL へ変換する。
 *
 * 開発時はレンダラーが http://localhost 配信されるため file:// の直読みが
 * Chromium のセキュリティ制限でブロックされる。そこで main 側で登録した
 * カスタムプロトコル local-file:// 経由でローカルファイルを読む。
 *
 * スキーマは standard 特権で登録されておりホストが必須のため、
 * ダミーホスト "local" を使用する（main 側で無視される）:
 *   macOS/Linux: local-file://local/Users/x/y.mp4
 *   Windows:     local-file://local/C:/x/y.mp4
 */
export function pathToFileUrl(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const withoutLeadingSlash = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const url = `local-file://local/${withoutLeadingSlash}`;
  return encodeURI(url).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

const RESOLUTION_LABELS = ["4K", "1440p", "1080p", "720p", "SD"] as const;
export type ResolutionLabel = (typeof RESOLUTION_LABELS)[number];

/**
 * 解像度ラベルを返す（長辺基準。レターボックス動画でも誤判定しにくい）。
 * width / height が未知の場合は null。
 */
export function getResolutionLabel(
  width: number,
  height: number,
): ResolutionLabel | null {
  if (width <= 0 && height <= 0) return null;
  const maxSide = Math.max(width, height);
  if (maxSide >= 3840) return "4K";
  if (maxSide >= 2560) return "1440p";
  if (maxSide >= 1920) return "1080p";
  if (maxSide >= 1280) return "720p";
  return "SD";
}

export { RESOLUTION_LABELS };

/** 追加日などの表示用の日付整形（ja-JP） */
export function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("ja-JP");
}

/** FPS を桁数を整えて表示する（0 は "0"） */
export function formatFps(fps: number): string {
  if (fps === 0) return "0";
  if (Number.isInteger(fps)) return fps.toString();
  const firstDecimal = Math.round(fps * 10) / 10;
  if (Math.abs(fps - firstDecimal) < 0.001) return firstDecimal.toString();
  return (Math.round(fps * 100) / 100).toString();
}
