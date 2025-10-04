import path from "path";
import { app } from "electron";

// Function to detect if running in development mode
function isDevelopment(): boolean {
  // Check multiple indicators for development mode
  return (
    process.env.NODE_ENV === "development" ||
    !app.isPackaged ||
    process.defaultApp ||
    /[\\/]electron-prebuilt[\\/]/.test(process.execPath) ||
    /[\\/]electron[\\/]/.test(process.execPath)
  );
}

// Function to get ffmpeg path
export function getFfmpegPath(): string | null {
  try {
    const isDevMode = isDevelopment();

    if (isDevMode) {
      // Development mode - use require directly
      const ffmpegStatic = require("ffmpeg-static");
      return ffmpegStatic;
    } else {
      // Production mode - look for ffmpeg in the app.asar.unpacked directory
      // First, try require() as it's most reliable with electron's module resolution
      try {
        let ffmpegStatic = require("ffmpeg-static");

        if (ffmpegStatic && typeof ffmpegStatic === "string") {
          // If the path points to app.asar (not unpacked), fix it
          if (
            ffmpegStatic.includes("app.asar") &&
            !ffmpegStatic.includes("app.asar.unpacked")
          ) {
            ffmpegStatic = ffmpegStatic.replace(
              "app.asar",
              "app.asar.unpacked"
            );
          }

          // Try the path from ffmpeg-static
          const pathsToTry =
            process.platform === "win32"
              ? [
                  ffmpegStatic.replace(/\.exe$/, ""),
                  ffmpegStatic.endsWith(".exe")
                    ? ffmpegStatic
                    : ffmpegStatic + ".exe",
                ]
              : [ffmpegStatic];

          for (const tryPath of pathsToTry) {
            try {
              const fs = require("fs");
              fs.accessSync(tryPath, fs.constants.F_OK);
              return path.normalize(tryPath);
            } catch (_accessError) {
              // Try next path
            }
          }

          console.error("❌ FFmpeg binary not found");
          return null;
        }
      } catch (requireError) {
        console.error("Could not require ffmpeg-static:", requireError);
        return null;
      }
    }
  } catch (error) {
    console.error("Error loading ffmpeg-static:", error);
    return null;
  }
}

export function getFfprobePath(): string | null {
  try {
    const isDevMode = isDevelopment();

    if (isDevMode) {
      // Development mode - use require directly
      const ffprobeStatic = require("ffprobe-static");
      return ffprobeStatic.path;
    } else {
      // Production mode - use require() and fix ASAR path if needed
      try {
        const ffprobeStatic = require("ffprobe-static");
        let ffprobePath = ffprobeStatic.path;

        // If the path points to app.asar (not unpacked), fix it
        if (
          ffprobePath &&
          ffprobePath.includes("app.asar") &&
          !ffprobePath.includes("app.asar.unpacked")
        ) {
          ffprobePath = ffprobePath.replace("app.asar", "app.asar.unpacked");
        }

        return path.normalize(ffprobePath);
      } catch (error) {
        console.error("Could not require ffprobe-static:", error);
        return null;
      }
    }
  } catch (error) {
    console.error("Error loading ffprobe-static:", error);
    return null;
  }
}

// Initialize ffmpeg with proper paths
export function initializeFFmpeg() {
  const ffmpeg = require("fluent-ffmpeg");

  try {
    const ffmpegPath = getFfmpegPath();
    const ffprobePath = getFfprobePath();

    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    } else {
      console.error("⚠️  ffmpeg binary not found!");
    }

    if (ffprobePath) {
      ffmpeg.setFfprobePath(ffprobePath);
    } else {
      console.error("⚠️  ffprobe binary not found!");
    }

    return { ffmpegPath, ffprobePath };
  } catch (error) {
    console.error("Error setting ffmpeg paths:", error);
    return { ffmpegPath: null, ffprobePath: null };
  }
}
