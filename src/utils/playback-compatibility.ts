/**
 * 内蔵プレーヤー（Chromium の <video>）での再生可否を、スキャン済みの
 * ファイル名と映像コーデックから安全側に判定する純粋関数群。
 *
 * 実際の再生可否は OS / Chromium のビルドにも依存するため、対応外と断定
 * できない組み合わせを「対応」とは返さない。変換については、再エンコード
 * を行わない MP4 ストリームコピーで内蔵再生可能になるものだけを許可する。
 */

export type PlaybackIncompatibilityReason = "container" | "codec" | "unknown";

export interface InternalPlaybackStatus {
  playable: boolean;
  reason?: PlaybackIncompatibilityReason;
}

// Electron が載せる Chromium での内蔵再生対象として扱う
// 「コンテナ拡張子と映像コーデック」の組み合わせ。コンテナをまたいで
// H.264 / VP9 が何でも再生できるとは扱わず、安全側に絞る。
const NATIVE_VIDEO_CODECS_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  ".mp4": new Set(["h264", "av1"]),
  ".m4v": new Set(["h264", "av1"]),
  ".mov": new Set(["h264", "av1"]),
  ".webm": new Set(["av1", "vp8", "vp9"]),
  ".mkv": new Set(["av1", "vp8", "vp9"]),
};

// MP4 へストリームコピーして内蔵再生を確実に狙える映像コーデック。
// AV1 / VP9 / Opus は Chromium や MP4 実装の組み合わせに差があるため、
// 「変換後に必ず内蔵再生できる」対象からは保守的に除外する。
const LOSSLESS_MP4_VIDEO_CODECS = new Set(["h264"]);

const LOSSLESS_MP4_AUDIO_CODECS = new Set(["aac", "mp3"]);

function normalizeCodec(codec: string | undefined): string {
  return (codec ?? "").trim().toLowerCase();
}

/** パスまたはファイル名から小文字の拡張子を取り出す（Node 非依存）。 */
export function mediaExtension(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? value;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** スキャン済み情報で分かる範囲の内蔵プレーヤー再生可否。 */
export function getInternalPlaybackStatus(
  filePathOrName: string,
  videoCodec: string | undefined,
): InternalPlaybackStatus {
  const supportedCodecs = NATIVE_VIDEO_CODECS_BY_EXTENSION[mediaExtension(filePathOrName)];
  if (!supportedCodecs) {
    return { playable: false, reason: "container" };
  }
  const codec = normalizeCodec(videoCodec);
  if (!supportedCodecs.has(codec)) {
    return { playable: false, reason: codec === "" || codec === "unknown" ? "unknown" : "codec" };
  }
  return { playable: true };
}

/** 映像コーデックだけで分かる、無劣化 MP4 化の事前候補。 */
export function canPotentiallyRemuxVideoToMp4(videoCodec: string | undefined): boolean {
  return LOSSLESS_MP4_VIDEO_CODECS.has(normalizeCodec(videoCodec));
}

/** MP4 ストリームコピーで内蔵再生を期待できる音声コーデックか。 */
export function canRemuxAudioToMp4(audioCodec: string | undefined): boolean {
  return LOSSLESS_MP4_AUDIO_CODECS.has(normalizeCodec(audioCodec));
}
