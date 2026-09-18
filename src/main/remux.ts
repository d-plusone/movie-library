import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const REMUX_TEMP_PREFIX = "movie-library-remux-";
const REMUX_TEMP_SUFFIX = ".tmp";

/**
 * ストリームコピー（劣化なし）で MP4 へリマックスし、元ファイルを同一パスで上書きする。
 * 一時ファイルは同じディレクトリに置き、rename をアトミックにする。
 */
export async function remuxToMp4(
  ffmpegPath: string,
  inputPath: string,
): Promise<void> {
  const dir = path.dirname(inputPath);
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpPath = path.join(
    dir,
    `${REMUX_TEMP_PREFIX}${unique}${REMUX_TEMP_SUFFIX}`,
  );

  const attempt = async (mapAll: boolean): Promise<void> => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-i",
      inputPath,
      ...(mapAll ? ["-map", "0"] : ["-map", "0:v:0", "-map", "0:a?"]),
      "-c",
      "copy",
      ...(mapAll ? [] : ["-ignore_unknown"]),
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      tmpPath,
    ];
    await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 });
  };

  try {
    try {
      await attempt(true);
    } catch {
      await attempt(false);
    }
    const statResult = await fs.stat(tmpPath);
    if (statResult.size <= 0) throw new Error("変換結果が空です");
    await fs.rename(tmpPath, inputPath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 一時ファイルが存在しない場合は無視
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`劣化なし（MP4 ストリームコピー）では変換できません: ${message}`);
  }
}
