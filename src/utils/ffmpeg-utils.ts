import path from "path";
import { app } from "electron";
import { promisify } from "util";
import { chmod, access, constants } from "fs";
import { createLogger } from "./logger.js";

const chmodAsync = promisify(chmod);
const accessAsync = promisify(access);

// production ビルドではデバッグログを抑制
const logger = createLogger(app.isPackaged);

// Function to detect if running in development mode
function isDevelopment(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    !app.isPackaged ||
    process.defaultApp ||
    /[\\/]electron-prebuilt[\\/]/.test(process.execPath) ||
    /[\\/]electron[\\/]/.test(process.execPath)
  );
}

// Function to ensure binary has execute permissions
async function ensureExecutable(binaryPath: string): Promise<void> {
  try {
    // Check if file exists
    await accessAsync(binaryPath, constants.F_OK);

    // Check if already executable - if so, no need to chmod
    try {
      await accessAsync(binaryPath, constants.X_OK);
      return; // Already executable
    } catch {
      // Not executable, try to chmod
    }

    // Add execute permissions (0o755 = rwxr-xr-x)
    try {
      await chmodAsync(binaryPath, 0o755);
      logger.debug(`✅ Set executable permissions on: ${binaryPath}`);
    } catch (chmodError) {
      // chmod failed (e.g. read-only app bundle), warn but don't throw
      // The spawn will fail with a clear error if the binary truly can't execute
      console.warn(`⚠️  Could not chmod ${binaryPath}:`, chmodError);
    }
  } catch (error) {
    console.error(`⚠️  Binary not found: ${binaryPath}:`, error);
    throw error;
  }
}

// Function to get ffmpeg path
export async function getFfmpegPath(): Promise<string | null> {
  try {
    logger.debug("🔍 Getting FFmpeg path...");
    logger.debug("  - Is development:", isDevelopment());
    logger.debug("  - Is packaged:", !isDevelopment());
    logger.debug("  - __dirname:", __dirname);
    logger.debug("  - process.resourcesPath:", process.resourcesPath);

    let ffmpegPath: string;

    if (isDevelopment()) {
      // Development mode: use @ffmpeg-installer/ffmpeg
      try {
        const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
        ffmpegPath = ffmpegInstaller.path;
        logger.debug("  - Dev mode: using @ffmpeg-installer/ffmpeg ✅");
        logger.debug("  - Raw path:", ffmpegPath);
      } catch (requireError) {
        console.error(
          "  - Dev mode: @ffmpeg-installer/ffmpeg require failed ❌",
        );
        const message =
          requireError instanceof Error
            ? requireError.message
            : String(requireError);
        console.error("  - Error:", message);
        throw requireError;
      }
    } else {
      // Production mode: use extraResources
      const arch = process.arch;
      const platform = process.platform;
      logger.debug("  - Prod mode: using extraResources");
      logger.debug("  - Platform:", platform, "Arch:", arch);

      // Determine the correct architecture subdirectory
      let archDir: string;
      if (platform === "darwin") {
        archDir = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
      } else if (platform === "win32") {
        // 同梱している Windows 用バイナリは win32-x64 のみ（win32-ia32 は同梱していない）。
        // arm64 (Windows on ARM) は x64 バイナリを WOW64 エミュレーションで実行できるため、
        // ia32 に誤解決せず常に win32-x64 を使う。
        archDir = "win32-x64";
      } else {
        archDir = "linux-x64";
      }

      const resourcesPath = process.resourcesPath;
      ffmpegPath = path.join(resourcesPath, "ffmpeg-bin", archDir, "ffmpeg");

      if (platform === "win32") {
        ffmpegPath += ".exe";
      }

      logger.debug("  - Constructed path:", ffmpegPath);
      logger.debug("  - Resources path:", resourcesPath);
    }

    if (!ffmpegPath) {
      console.error("❌ FFmpeg path not found");
      return null;
    }

    // Normalize path
    ffmpegPath = path.normalize(ffmpegPath);
    logger.debug("  - Normalized path:", ffmpegPath);

    // Ensure binary exists
    try {
      await accessAsync(ffmpegPath, constants.F_OK);
      logger.debug("  - Binary exists: ✅");
    } catch (err) {
      console.error("  - Binary exists: ❌");
      console.error("  - Access error:", err);
      throw err;
    }

    // Ensure binary is executable
    await ensureExecutable(ffmpegPath);

    logger.log(`✅ FFmpeg binary ready at: ${ffmpegPath}`);
    return ffmpegPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("❌ Error loading FFmpeg:");
    console.error("  - Error message:", message);
    console.error("  - Error stack:", stack);
    return null;
  }
}

// Function to get ffprobe path
export async function getFfprobePath(): Promise<string | null> {
  try {
    let ffprobePath: string;

    if (process.platform === "darwin" && process.arch === "arm64") {
      // macOS arm64: 静的リンク版 ffprobe（Homebrew 依存なし）を dev/prod とも使用。
      // scripts/prepare-ffprobe.js が dev / build 時に ffprobe-bin へ準備する。
      // （Homebrew の ffprobe は動的リンクのため、アップグレードで dyld エラーになる）
      if (isDevelopment()) {
        // dev: バンドル済み out/main/index.js → プロジェクトルート/ffprobe-bin
        // （out/main → out → プロジェクトルート の 2 段上がり）
        ffprobePath = path.join(
          __dirname,
          "..",
          "..",
          "ffprobe-bin",
          "darwin-arm64",
          "ffprobe",
        );
        logger.debug("  - Dev mode: using bundled static arm64 ffprobe ✅");
      } else {
        // prod: extraResources でコピーされた ffprobe-bin/darwin-arm64/ffprobe
        ffprobePath = path.join(
          process.resourcesPath,
          "ffprobe-bin",
          "darwin-arm64",
          "ffprobe",
        );
        logger.debug("  - Prod mode: using bundled static arm64 ffprobe ✅");
      }
      logger.debug("  - Constructed path:", ffprobePath);
    } else {
      // その他のプラットフォーム: ffprobe-static（静的リンクの同梱バイナリ）
      const ffprobeStatic = require("ffprobe-static");
      ffprobePath = ffprobeStatic.path;
      // Fix ASAR path if needed
      if (
        ffprobePath.includes("app.asar") &&
        !ffprobePath.includes("app.asar.unpacked")
      ) {
        ffprobePath = ffprobePath.replace("app.asar", "app.asar.unpacked");
      }
    }

    if (!ffprobePath) {
      console.error("❌ FFprobe path not found");
      return null;
    }

    // Normalize path
    ffprobePath = path.normalize(ffprobePath);

    // Ensure binary exists
    await accessAsync(ffprobePath, constants.F_OK);

    // Ensure binary is executable
    await ensureExecutable(ffprobePath);

    logger.log(`✅ FFprobe binary ready at: ${ffprobePath}`);
    return ffprobePath;
  } catch (error) {
    console.error("❌ Error loading FFprobe:", error);
    return null;
  }
}

// Initialize ffmpeg - ensures binaries are ready
export async function initializeFFmpeg(): Promise<{
  ffmpegPath: string | null;
  ffprobePath: string | null;
}> {
  try {
    logger.log("🎬 Initializing FFmpeg...");

    const ffmpegPath = await getFfmpegPath();
    const ffprobePath = await getFfprobePath();

    if (!ffmpegPath) {
      console.error("⚠️  FFmpeg binary not found!");
    }

    if (!ffprobePath) {
      console.error("⚠️  FFprobe binary not found!");
    }

    if (ffmpegPath && ffprobePath) {
      logger.log("✅ FFmpeg initialization completed successfully");
    } else {
      console.error("❌ FFmpeg initialization failed");
    }

    return { ffmpegPath, ffprobePath };
  } catch (error) {
    console.error("❌ Error initializing FFmpeg:", error);
    return { ffmpegPath: null, ffprobePath: null };
  }
}
