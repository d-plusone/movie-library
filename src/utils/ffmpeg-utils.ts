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

      // Add platform-specific extensions for Windows
      const finalPaths: string[] = [];
      if (process.platform === "win32") {
        possiblePaths.forEach((p) => {
          finalPaths.push(p); // Try without .exe first (actual file might not have extension)
          finalPaths.push(p + ".exe"); // Then try with .exe
        });
      } else {
        finalPaths.push(...possiblePaths);
      }

      console.log("Searching for ffmpeg in these paths:", finalPaths);

      for (const ffmpegPath of finalPaths) {
        try {
          require("fs").accessSync(ffmpegPath, require("fs").constants.F_OK);
          console.log("✅ Found ffmpeg at:", ffmpegPath);
          return ffmpegPath;
        } catch (_error) {
          // Silent - will log at the end if nothing found
        }
      }
      
      console.error("❌ ffmpeg not found in any of the expected paths");

      // Fallback to require() which should work with asarUnpack
      try {
        const ffmpegStatic = require("ffmpeg-static");
        console.log("✅ Fallback ffmpeg path from require():", ffmpegStatic);
        
        // Verify the fallback path exists
        try {
          require("fs").accessSync(ffmpegStatic, require("fs").constants.F_OK);
          console.log("✅ Fallback ffmpeg verified to exist");
          return ffmpegStatic;
        } catch (_verifyError) {
          console.error("❌ Fallback ffmpeg path does not exist:", ffmpegStatic);
          return null;
        }
      } catch (_error) {
        console.error("❌ Could not require ffmpeg-static:", _error);
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

      // Add platform-specific extensions for Windows
      const finalPaths: string[] = [];
      if (process.platform === "win32") {
        possiblePaths.forEach((p) => {
          finalPaths.push(p); // Try without .exe first (actual file might not have extension)
          finalPaths.push(p + ".exe"); // Then try with .exe
        });
      } else {
        finalPaths.push(...possiblePaths);
      }

      console.log("Searching for ffprobe in these paths:", finalPaths);

      for (const ffprobePath of finalPaths) {
        try {
          require("fs").accessSync(ffprobePath, require("fs").constants.F_OK);
          console.log("✅ Found ffprobe at:", ffprobePath);
          return ffprobePath;
        } catch (_error) {
          // Silent - will log at the end if nothing found
        }
      }
      
      console.error("❌ ffprobe not found in any of the expected paths");

      // Fallback to require() which should work with asarUnpack
      try {
        const ffprobeStatic = require("ffprobe-static");
        const ffprobePath = ffprobeStatic.path;
        console.log("✅ Fallback ffprobe path from require():", ffprobePath);
        
        // Verify the fallback path exists
        try {
          require("fs").accessSync(ffprobePath, require("fs").constants.F_OK);
          console.log("✅ Fallback ffprobe verified to exist");
          return ffprobePath;
        } catch (_verifyError) {
          console.error("❌ Fallback ffprobe path does not exist:", ffprobePath);
          return null;
        }
      } catch (_error) {
        console.error("❌ Could not require ffprobe-static:", _error);
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
