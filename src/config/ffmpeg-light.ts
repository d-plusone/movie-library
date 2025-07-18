/**
 * 軽量版FFmpeg設定
 * 必要最小限の機能のみを使用してサイズを削減
 */

export interface LightweightFFmpegOptions {
  videoCodec: string;
  audioCodec: string;
  videoBitrate: string;
  audioBitrate: string;
  preset: string;
  removeMetadata: boolean;
}

export interface FFmpegConfig {
  ffmpegPath: string;
  ffprobePath: string;
  lightweightFFmpegOptions: LightweightFFmpegOptions;
}

// カスタムFFmpegパス（より軽量なビルドを使用）
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
const ffprobePath = process.env.FFPROBE_PATH || require("ffprobe-static").path;

// FFmpegの軽量設定
const lightweightFFmpegOptions: LightweightFFmpegOptions = {
  // 必要最小限のコーデック
  videoCodec: "libx264",
  audioCodec: "aac",

  // 品質を下げてファイルサイズ削減
  videoBitrate: "1000k",
  audioBitrate: "128k",

  // 処理速度優先（ファイルサイズよりも処理速度）
  preset: "ultrafast",

  // 不要なメタデータ削除
  removeMetadata: true,
};

const config: FFmpegConfig = {
  ffmpegPath,
  ffprobePath,
  lightweightFFmpegOptions,
};

export default config;
export { ffmpegPath, ffprobePath, lightweightFFmpegOptions };

// CommonJS互換性のため
module.exports = config;
