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

      // Ensure we have a valid path
      if (ffmpegStatic && typeof ffmpegStatic === "string") {
        const normalizedPath = path.normalize(ffmpegStatic);
        console.log("Normalized development ffmpeg path:", normalizedPath);
        return normalizedPath;
      }
      return ffmpegStatic;
    } else {
      // Production mode - look for ffmpeg in the app.asar.unpacked directory
      const appPath = app.getAppPath();
      console.log("App path:", appPath);

      const unpackedPath = appPath.replace("app.asar", "app.asar.unpacked");
      console.log("Unpacked path:", unpackedPath);

      // First, try require() as it's most reliable with electron's module resolution
      try {
        let ffmpegStatic = require("ffmpeg-static");
        console.log("FFmpeg path from require():", ffmpegStatic);

        if (ffmpegStatic && typeof ffmpegStatic === "string") {
          // CRITICAL: If the path points to app.asar (not unpacked), fix it
          if (
            ffmpegStatic.includes("app.asar") &&
            !ffmpegStatic.includes("app.asar.unpacked")
          ) {
            ffmpegStatic = ffmpegStatic.replace(
              "app.asar",
              "app.asar.unpacked"
            );
            console.log("🔧 Fixed ASAR path to unpacked:", ffmpegStatic);
          }

          // List files in the ffmpeg-static directory for debugging
          if (process.platform === "win32") {
            try {
              const fs = require("fs");
              const ffmpegDir = path.dirname(ffmpegStatic);
              console.log("FFmpeg directory:", ffmpegDir);
              const files = fs.readdirSync(ffmpegDir);
              console.log("Files in ffmpeg-static directory:", files);
            } catch (listError) {
              console.warn("Could not list ffmpeg directory:", listError);
            }
          }

          // On Windows, prioritize .exe extension
          const pathsToTry =
            process.platform === "win32"
              ? [
                  // Try .exe first (created by after-pack.js)
                  ffmpegStatic + ".exe",
                  path.join(path.dirname(ffmpegStatic), "ffmpeg.exe"),
                  // Then try without extension
                  ffmpegStatic.replace(/\.exe$/, ""),
                  path.join(path.dirname(ffmpegStatic), "ffmpeg"),
                  // Original path as fallback
                  ffmpegStatic,
                ]
              : [ffmpegStatic];

          console.log("Trying these ffmpeg paths:", pathsToTry);

          for (const tryPath of pathsToTry) {
            try {
              const fs = require("fs");
              fs.accessSync(tryPath, fs.constants.F_OK);
              console.log("✅ FFmpeg found and accessible at:", tryPath);

              const stats = fs.statSync(tryPath);
              console.log("FFmpeg file stats:", {
                size: stats.size,
                isFile: stats.isFile(),
                mode: stats.mode.toString(8),
              });
              
              // Test if we can actually spawn this binary (Windows specific test)
              if (process.platform === "win32") {
                try {
                  const { spawnSync } = require("child_process");
                  const testResult = spawnSync(tryPath, ["-version"], {
                    timeout: 5000,
                    windowsHide: true,
                  });
                  
                  if (testResult.error) {
                    console.error("❌ Cannot spawn ffmpeg:", testResult.error.message);
                    continue; // Try next path
                  } else {
                    console.log("✅ FFmpeg spawn test successful");
                  }
                } catch (spawnError) {
                  console.error("❌ FFmpeg spawn test failed:", spawnError);
                  continue; // Try next path
                }
              }

              // Normalize path for Windows
              const normalizedPath = path.normalize(tryPath);
              console.log("Returning normalized ffmpeg path:", normalizedPath);
              return normalizedPath;
            } catch (accessError) {
              console.warn(
                `Cannot access ${tryPath}:`,
                (accessError as Error).message
              );
            }
          }

          console.error("❌ None of the ffmpeg paths are accessible");
        }
      } catch (requireError) {
        console.warn(
          "Could not require ffmpeg-static, trying manual paths:",
          requireError
        );
      }

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
          const fs = require("fs");
          fs.accessSync(ffmpegPath, fs.constants.F_OK | fs.constants.X_OK);
          console.log("✅ Found ffmpeg at:", ffmpegPath);

          // Additional verification for Windows
          if (process.platform === "win32") {
            const stats = fs.statSync(ffmpegPath);
            console.log("FFmpeg file stats:", {
              size: stats.size,
              isFile: stats.isFile(),
              mode: stats.mode.toString(8),
            });
          }

          // Normalize path for Windows
          const normalizedPath = path.normalize(ffmpegPath);
          console.log("Returning normalized ffmpeg path:", normalizedPath);
          return normalizedPath;
        } catch (_error) {
          // Silent - will log at the end if nothing found
        }
      }

      console.error("❌ ffmpeg not found in any location");
      return null;
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
        let ffprobePath = ffprobeStatic.path;
        console.log("✅ Fallback ffprobe path from require():", ffprobePath);

        // CRITICAL: If the path points to app.asar (not unpacked), fix it
        if (
          ffprobePath &&
          ffprobePath.includes("app.asar") &&
          !ffprobePath.includes("app.asar.unpacked")
        ) {
          ffprobePath = ffprobePath.replace("app.asar", "app.asar.unpacked");
          console.log("🔧 Fixed ASAR path to unpacked:", ffprobePath);
        }

        // Verify the fallback path exists
        try {
          require("fs").accessSync(ffprobePath, require("fs").constants.F_OK);
          console.log("✅ Fallback ffprobe verified to exist");

          // Normalize path for Windows
          const normalizedPath = path.normalize(ffprobePath);
          console.log("Returning normalized ffprobe path:", normalizedPath);
          return normalizedPath;
        } catch (_verifyError) {
          console.error(
            "❌ Fallback ffprobe path does not exist:",
            ffprobePath
          );
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
