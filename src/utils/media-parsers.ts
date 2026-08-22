/**
 * ffprobe 出力のパース用純粋関数群。
 * Electron / Prisma に依存しないため、単体テストから直接検証できる。
 */

/**
 * ffprobe のフレームレート表現（例: "30000/1001", "29.97"）を fps 数値へ変換する。
 * パースできない場合は 0 を返す。小数第 2 位で丸める。
 */
export function parseFrameRate(frameRate?: string): number {
  if (!frameRate) {
    return 0;
  }

  try {
    if (frameRate.includes("/")) {
      const [numerator, denominator] = frameRate.split("/").map(Number);
      if (denominator === 0) {
        return 0;
      }
      const fps = numerator / denominator;
      return Number.isNaN(fps) ? 0 : Math.round(fps * 100) / 100;
    }

    const fps = parseFloat(frameRate);
    return Number.isNaN(fps) ? 0 : Math.round(fps * 100) / 100;
  } catch {
    return 0;
  }
}

/** duration 表現（数値または文字列）を秒数の数値へ変換する。失敗時は 0。 */
export function parseDurationValue(duration?: number | string): number {
  if (!duration) return 0;

  if (typeof duration === "string") {
    const parsed = parseFloat(duration);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return duration;
}

/** bitrate 表現（数値または文字列）を整数へ変換する。失敗時は 0。 */
export function parseBitrateValue(bitrate?: number | string): number {
  if (!bitrate) return 0;

  if (typeof bitrate === "string") {
    const parsed = parseInt(bitrate, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return bitrate;
}
