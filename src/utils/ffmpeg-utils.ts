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
    console.log("Running in development mode:", isDevMode);
    console.log("app.isPackaged:", app.isPackaged);
    console.log("process.execPath:", process.execPath);

    if (isDevMode) {
      // Development mode - use require directly
      const ffmpegStatic = require("ffmpeg-static");
      console.log("Development ffmpeg path:", ffmpegStatic);
      return ffmpegStatic;
    } else {
      // Production mode - look for ffmpeg in the app.asar.unpacked directory
      const appPath = app.getAppPath();
      console.log("App path:", appPath);

      const unpackedPath = appPath.replace("app.asar", "app.asar.unpacked");
      console.log("Unpacked path:", unpackedPath);

      // Try multiple possible paths for ffmpeg
      const possiblePaths = [
        path.join(unpackedPath, "node_modules", "ffmpeg-static", "ffmpeg"),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg"
        ),
        path.join(process.resourcesPath, "ffmpeg-static", "ffmpeg"),
      ];

      // Add platform-specific extensions
      if (process.platform === "win32") {
        possiblePaths.forEach((p, i) => {
          possiblePaths[i] = p + ".exe";
        });
      }

      for (const ffmpegPath of possiblePaths) {
        try {
          require("fs").accessSync(ffmpegPath, require("fs").constants.F_OK);
          console.log("Found ffmpeg at:", ffmpegPath);
          return ffmpegPath;
        } catch (_error) {
          console.log("ffmpeg not found at:", ffmpegPath);
        }
      }

      // Fallback to require() which should work with asarUnpack
      try {
        const ffmpegStatic = require("ffmpeg-static");
        console.log("Fallback ffmpeg path:", ffmpegStatic);
        return ffmpegStatic;
      } catch (_error) {
        console.error("Could not find ffmpeg binary");
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
    console.log("Getting ffprobe path, development mode:", isDevMode);

    if (isDevMode) {
      // Development mode - use require directly
      const ffprobeStatic = require("ffprobe-static");
      console.log("Development ffprobe path:", ffprobeStatic.path);
      return ffprobeStatic.path;
    } else {
      // Production mode - look for ffprobe in the app.asar.unpacked directory
      const appPath = app.getAppPath();
      const unpackedPath = appPath.replace("app.asar", "app.asar.unpacked");

      // Try multiple possible paths for ffprobe
      const platform = process.platform;
      const arch = process.arch;
      const possiblePaths = [
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          platform,
          arch,
          "ffprobe"
        ),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "ffprobe-static",
          "bin",
          platform,
          arch,
          "ffprobe"
        ),
        path.join(
          process.resourcesPath,
          "ffprobe-static",
          "bin",
          platform,
          arch,
          "ffprobe"
        ),
      ];

      // Add platform-specific extensions
      if (process.platform === "win32") {
        possiblePaths.forEach((p, i) => {
          possiblePaths[i] = p + ".exe";
        });
      }

      for (const ffprobePath of possiblePaths) {
        try {
          require("fs").accessSync(ffprobePath, require("fs").constants.F_OK);
          console.log("Found ffprobe at:", ffprobePath);
          return ffprobePath;
        } catch (_error) {
          console.log("ffprobe not found at:", ffprobePath);
        }
      }

      // Fallback to require() which should work with asarUnpack
      try {
        const ffprobeStatic = require("ffprobe-static");
        console.log("Fallback ffprobe path:", ffprobeStatic.path);
        return ffprobeStatic.path;
      } catch (_error) {
        console.error("Could not find ffprobe binary");
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
      console.log("Setting ffmpeg path:", ffmpegPath);
      ffmpeg.setFfmpegPath(ffmpegPath);
    } else {
      console.error(
        "⚠️  ffmpeg binary not found! Thumbnail generation will not work."
      );
    }

    if (ffprobePath) {
      console.log("Setting ffprobe path:", ffprobePath);
      ffmpeg.setFfprobePath(ffprobePath);
    } else {
      console.error(
        "⚠️  ffprobe binary not found! Video info extraction may not work."
      );
    }

    return { ffmpegPath, ffprobePath };
  } catch (error) {
    console.error("Error setting ffmpeg paths:", error);
    console.log("Will attempt to use system ffmpeg if available");
    return { ffmpegPath: null, ffprobePath: null };
  }
}
