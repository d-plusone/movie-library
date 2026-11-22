import { promises as fs } from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type { Mp4ConversionMode, VideoMetadata } from "../types/types.js";
import {
  canPotentiallyRemuxVideoToMp4,
  canRemuxAudioToMp4,
} from "../utils/playback-compatibility.js";

const execFileAsync = promisify(execFile);
const REMUX_TEMP_PREFIX = ".movie-library-remux-";
const REMUX_TEMP_SUFFIX = ".tmp";

export interface Mp4ConversionEligibility {
  convertible: boolean;
  mode?: Mp4ConversionMode;
  reason?: string;
}

const HIGH_QUALITY_VIDEO_CRF = "15";
const HIGH_QUALITY_AUDIO_BITRATE = "320k";
const MINIMUM_AVERAGE_PSNR = 40;
const MINIMUM_FRAME_PSNR = 32;

type FfmpegProgressCallback = (progress: number | null) => void;

interface FfmpegProgressState {
  outTimeUs?: number;
  outTimeMs?: number;
  outTime?: string;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [hours, minutes, seconds] = parts.map(Number);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  duration: number | string | undefined,
  onProgress?: FfmpegProgressCallback,
): Promise<void> {
  const durationSeconds = numericDuration(duration);
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdoutBuffer = "";
    let stderr = "";
    let state: FfmpegProgressState = {};
    let settled = false;

    const emitProgress = (): void => {
      if (!onProgress) return;
      if (durationSeconds === null) {
        // duration が取得できない場合も、処理継続中であることを伝えて
        // 進捗表示がタイムアウト完了扱いにならないようにする。
        onProgress(null);
        return;
      }
      const timestamp =
        (state.outTimeUs !== undefined ? state.outTimeUs / 1_000_000 : null) ??
        (state.outTimeMs !== undefined ? state.outTimeMs / 1_000_000 : null) ??
        parseTimestamp(state.outTime);
      if (timestamp === null || !Number.isFinite(timestamp)) return;
      onProgress(Math.max(0, Math.min(1, timestamp / durationSeconds)));
    };

    const consumeProgress = (chunk: string): void => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === "out_time_us" && Number.isFinite(Number(value))) {
          state = { ...state, outTimeUs: Number(value) };
        }
        if (key === "out_time_ms" && Number.isFinite(Number(value))) {
          state = { ...state, outTimeMs: Number(value) };
        }
        if (key === "out_time") state = { ...state, outTime: value };
        if (key === "progress") emitProgress();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consumeProgress);
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        if (stdoutBuffer) consumeProgress("\n");
        resolve();
        return;
      }
      const reason = stderr.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
      reject(new Error(reason));
    });
  });
}

/**
 * 再エンコードを一切せず MP4 に入れ直した場合に、内蔵プレーヤー再生を期待
 * できるストリーム構成かを確認する。字幕・データ・添付ストリームを捨てて
 * 変換成功扱いにすることは、無劣化の約束に反するため許可しない。
 */
function getLosslessMp4RemuxEligibility(
  metadata: VideoMetadata,
): Mp4ConversionEligibility {
  const streams = metadata.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  if (videoStreams.length === 0) {
    return { convertible: false, reason: "映像ストリームが見つかりません" };
  }

  for (const stream of streams) {
    if (stream.codec_type !== "video" && stream.codec_type !== "audio") {
      return {
        convertible: false,
        reason: "字幕・データ・添付ストリームを無劣化のまま MP4 へ移せません",
      };
    }
    if (
      stream.codec_type === "video" &&
      !canPotentiallyRemuxVideoToMp4(stream.codec_name)
    ) {
      return {
        convertible: false,
        reason: `映像コーデック ${stream.codec_name ?? "不明"} は無劣化 MP4 変換の対象外です`,
      };
    }
    if (stream.codec_type === "audio" && !canRemuxAudioToMp4(stream.codec_name)) {
      return {
        convertible: false,
        reason: `音声コーデック ${stream.codec_name ?? "不明"} は無劣化 MP4 変換の対象外です`,
      };
    }
  }

  return { convertible: true, mode: "remux" };
}

/**
 * 内蔵再生できない動画を MP4 にする手段を決める。H.264/AAC/MP3 なら
 * パケットをそのまま再配置し、それ以外は H.264/320kbps MP3 の高品質変換を使う。
 * 字幕・データ・添付ストリームを黙って捨てないため、それらを含む動画は対象外にする。
 */
export function getMp4ConversionEligibility(
  metadata: VideoMetadata,
): Mp4ConversionEligibility {
  const lossless = getLosslessMp4RemuxEligibility(metadata);
  if (lossless.convertible) return lossless;

  const streams = metadata.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  if (videoStreams.length === 0) {
    return { convertible: false, reason: "映像ストリームが見つかりません" };
  }
  if (videoStreams.length !== 1) {
    return {
      convertible: false,
      reason: "高品質変換では複数の映像トラックを安全に検証できません",
    };
  }
  if (streams.some(
    (stream) => stream.codec_type !== "video" && stream.codec_type !== "audio",
  )) {
    return {
      convertible: false,
      reason: "字幕・データ・添付ストリームを保持したまま MP4 に変換できません",
    };
  }
  return {
    convertible: true,
    mode: "transcode",
    reason: "H.264/320kbps MP3 の高品質変換を行います",
  };
}

function numericDuration(value: number | string | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericTimestamp(value: number | string | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function streamsOfType(metadata: VideoMetadata, type: "video" | "audio") {
  return (metadata.streams ?? []).filter((stream) => stream.codec_type === type);
}

function verifyDuration(
  source: number | string | undefined,
  converted: number | string | undefined,
  label: string,
): void {
  const sourceSeconds = numericDuration(source);
  const convertedSeconds = numericDuration(converted);
  if (sourceSeconds === null || convertedSeconds === null) return;
  // 音声エンコーダーのフレーム終端パディングを許しつつ、長尺での同期ずれは見逃さない。
  const allowedDifference = Math.max(0.25, sourceSeconds * 0.001);
  if (Math.abs(sourceSeconds - convertedSeconds) > allowedDifference) {
    throw new Error(
      `${label}が変換前後で一致しません（${sourceSeconds.toFixed(3)}秒 → ${convertedSeconds.toFixed(3)}秒）`,
    );
  }
}

function verifyAudioVideoOffset(
  source: VideoMetadata,
  converted: VideoMetadata,
): void {
  const sourceVideoStart = numericTimestamp(streamsOfType(source, "video")[0]?.start_time);
  const convertedVideoStart = numericTimestamp(streamsOfType(converted, "video")[0]?.start_time);
  if (sourceVideoStart === null || convertedVideoStart === null) return;

  const sourceAudio = streamsOfType(source, "audio");
  const convertedAudio = streamsOfType(converted, "audio");
  for (let index = 0; index < sourceAudio.length; index++) {
    const sourceAudioStart = numericTimestamp(sourceAudio[index]?.start_time);
    const convertedAudioStart = numericTimestamp(convertedAudio[index]?.start_time);
    if (sourceAudioStart === null || convertedAudioStart === null) continue;
    const sourceOffset = sourceAudioStart - sourceVideoStart;
    const convertedOffset = convertedAudioStart - convertedVideoStart;
    if (Math.abs(sourceOffset - convertedOffset) > 0.1) {
      throw new Error(`音声トラック ${index + 1} の映像に対する開始位置が変化しました`);
    }
  }
}

/** 変換後にトラック構成・解像度・再生時間を検証し、音ズレを検出できる範囲で防ぐ。 */
export function verifyConvertedMp4(
  source: VideoMetadata,
  converted: VideoMetadata,
  mode: Mp4ConversionMode,
): void {
  const sourceVideo = streamsOfType(source, "video");
  const convertedVideo = streamsOfType(converted, "video");
  const sourceAudio = streamsOfType(source, "audio");
  const convertedAudio = streamsOfType(converted, "audio");
  if (sourceVideo.length !== convertedVideo.length || sourceAudio.length !== convertedAudio.length) {
    throw new Error("変換前後で映像または音声トラック数が一致しません");
  }
  for (let index = 0; index < sourceVideo.length; index++) {
    const before = sourceVideo[index]!;
    const after = convertedVideo[index]!;
    if (before.width !== after.width || before.height !== after.height) {
      throw new Error("変換前後で映像解像度が一致しません");
    }
    if (mode === "remux" && before.codec_name !== after.codec_name) {
      throw new Error("無劣化リマックス後の映像コーデックが変化しました");
    }
    if (mode === "transcode" && after.codec_name !== "h264") {
      throw new Error("高品質変換後の映像コーデックが H.264 ではありません");
    }
    verifyDuration(before.duration, after.duration, `映像トラック ${index + 1} の再生時間`);
  }
  for (let index = 0; index < sourceAudio.length; index++) {
    const before = sourceAudio[index]!;
    const after = convertedAudio[index]!;
    if (mode === "remux" && before.codec_name !== after.codec_name) {
      throw new Error("無劣化リマックス後の音声コーデックが変化しました");
    }
    if (mode === "transcode" && after.codec_name !== "mp3") {
      throw new Error("高品質変換後の音声コーデックが MP3 ではありません");
    }
    verifyDuration(before.duration, after.duration, `音声トラック ${index + 1} の再生時間`);
  }
  verifyDuration(source.format.duration, converted.format.duration, "動画全体の再生時間");
  verifyAudioVideoOffset(source, converted);
}

/**
 * 高品質変換の映像を元動画と比較する。平均 PSNR 40dB / 最低フレーム 32dB 未満を
 * 検出した出力は、見た目の品質を満たさないものとして登録しない。
 */
export async function verifyHighQualityVideo(
  ffmpegPath: string,
  sourcePath: string,
  convertedPath: string,
): Promise<void> {
  const { stderr } = await execFileAsync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    sourcePath,
    "-i",
    convertedPath,
    "-lavfi",
    "[0:v]settb=AVTB,setpts=PTS-STARTPTS[source];[1:v]settb=AVTB,setpts=PTS-STARTPTS[converted];[source][converted]psnr",
    "-f",
    "null",
    "-",
  ], { maxBuffer: 1024 * 1024 });
  const match = /PSNR .*average:([\d.]+) min:([\d.]+)/.exec(stderr);
  if (!match) throw new Error("映像品質（PSNR）を取得できませんでした");
  const average = Number(match[1]);
  const minimum = Number(match[2]);
  if (!Number.isFinite(average) || !Number.isFinite(minimum)) {
    throw new Error("映像品質（PSNR）の値が不正です");
  }
  if (average < MINIMUM_AVERAGE_PSNR || minimum < MINIMUM_FRAME_PSNR) {
    throw new Error(
      `映像品質が基準未満です（平均 ${average.toFixed(2)}dB / 最低 ${minimum.toFixed(2)}dB）`,
    );
  }
}

/**
 * 元ファイルを絶対に上書きしない変換先パスを選ぶ。
 * 同名の変換済みファイルがあれば連番を付ける。
 */
export async function findConvertedMp4Path(inputPath: string): Promise<string> {
  const directory = path.dirname(inputPath);
  const extension = path.extname(inputPath);
  const stem = path.basename(inputPath, extension);
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const label = suffix === 0 ? " (変換済み)" : ` (変換済み ${suffix + 1})`;
    const candidate = path.join(directory, `${stem}${label}.mp4`);
    try {
      // 空ファイルを O_EXCL で確保して、変換完了時の rename が既存ファイルを
      // 上書きしないようにする。失敗時は変換関数がこの予約を削除する。
      const handle = await fs.open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("変換先ファイル名を決められませんでした");
}

/**
 * ストリームコピー（再エンコードなし）で別 MP4 ファイルを作成する。
 * 映像・音声のパケットをそのままコピーし、相対タイムスタンプを保つため
 * -copyts / -start_at_zero を併用する。対応できないストリームがある場合は
 * 一切省略せず失敗させ、元ファイル・変換先とも破損させない。
 */
export async function remuxToMp4(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  duration?: number | string,
  onProgress?: FfmpegProgressCallback,
): Promise<void> {
  if (path.extname(outputPath).toLowerCase() !== ".mp4") {
    throw new Error("変換先は MP4 ファイルである必要があります");
  }

  const directory = path.dirname(outputPath);
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(
    directory,
    `${REMUX_TEMP_PREFIX}${unique}${REMUX_TEMP_SUFFIX}`,
  );

  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-copyts",
      "-i",
      inputPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-copytb",
      "1",
      "-map_metadata",
      "0",
      "-map_chapters",
      "0",
      "-start_at_zero",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      temporaryPath,
    ];
    await runFfmpeg(ffmpegPath, args, duration, onProgress);
    const stats = await fs.stat(temporaryPath);
    if (stats.size <= 0) throw new Error("変換結果が空です");
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // 一時ファイルが存在しない場合は無視する。
    }
    try {
      await fs.unlink(outputPath);
    } catch {
      // 予約ファイルが存在しない場合は無視する。
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`無劣化 MP4 変換に失敗しました: ${message}`);
  }
}

/**
 * WMV/VC-1/WMA 等、MP4 へそのまま入れ直せない動画を H.264/320kbps MP3 に高品質変換する。
 * 元ファイルには触れず、出力は一時ファイルを検証可能な状態で完成させてから移動する。
 */
export async function transcodeToMp4(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  duration?: number | string,
  onProgress?: FfmpegProgressCallback,
): Promise<void> {
  if (path.extname(outputPath).toLowerCase() !== ".mp4") {
    throw new Error("変換先は MP4 ファイルである必要があります");
  }
  const directory = path.dirname(outputPath);
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(
    directory,
    `${REMUX_TEMP_PREFIX}${unique}${REMUX_TEMP_SUFFIX}`,
  );

  try {
    await runFfmpeg(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-copyts",
      "-i",
      inputPath,
      "-map",
      "0:v?",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      HIGH_QUALITY_VIDEO_CRF,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "libmp3lame",
      "-b:a",
      HIGH_QUALITY_AUDIO_BITRATE,
      "-map_metadata",
      "0",
      "-map_chapters",
      "0",
      "-start_at_zero",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      temporaryPath,
    ], duration, onProgress);
    const stats = await fs.stat(temporaryPath);
    if (stats.size <= 0) throw new Error("変換結果が空です");
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await Promise.all([
      fs.unlink(temporaryPath).catch(() => {}),
      fs.unlink(outputPath).catch(() => {}),
    ]);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`高品質 MP4 変換に失敗しました: ${message}`);
  }
}
