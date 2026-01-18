import path from "path";
import { app } from "electron";
import { promisify } from "util";
import { chmod, access, constants } from "fs";

const chmodAsync = promisify(chmod);
const accessAsync = promisify(access);

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
    
    // Add execute permissions (0o755 = rwxr-xr-x)
    await chmodAsync(binaryPath, 0o755);
    console.log(`✅ Set executable permissions on: ${binaryPath}`);
  } catch (error) {
    console.error(`⚠️  Failed to set executable permissions on ${binaryPath}:`, error);
    throw error;
  }
}

// Function to get ffmpeg path
export async function getFfmpegPath(): Promise<string | null> {
  try {
    console.log("🔍 Getting FFmpeg path...");
    console.log("  - Is development:", isDevelopment());
    console.log("  - Is packaged:", !isDevelopment());
    console.log("  - __dirname:", __dirname);
    console.log("  - process.resourcesPath:", process.resourcesPath);
    
    let ffmpegPath: string;

    if (isDevelopment()) {
      // Development mode: use @ffmpeg-installer/ffmpeg
      try {
        const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
        ffmpegPath = ffmpegInstaller.path;
        console.log("  - Dev mode: using @ffmpeg-installer/ffmpeg ✅");
        console.log("  - Raw path:", ffmpegPath);
      } catch (requireError: any) {
        console.error("  - Dev mode: @ffmpeg-installer/ffmpeg require failed ❌");
        console.error("  - Error:", requireError.message);
        throw requireError;
      }
    } else {
      // Production mode: use extraResources
      const arch = process.arch;
      const platform = process.platform;
      console.log("  - Prod mode: using extraResources");
      console.log("  - Platform:", platform, "Arch:", arch);
      
      // Determine the correct architecture subdirectory
      let archDir: string;
      if (platform === "darwin") {
        archDir = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
      } else if (platform === "win32") {
        archDir = arch === "x64" ? "win32-x64" : "win32-ia32";
      } else {
        archDir = "linux-x64";
      }
      
      const resourcesPath = process.resourcesPath;
      ffmpegPath = path.join(resourcesPath, "ffmpeg-bin", archDir, "ffmpeg");
      
      if (platform === "win32") {
        ffmpegPath += ".exe";
      }
      
      console.log("  - Constructed path:", ffmpegPath);
      console.log("  - Resources path:", resourcesPath);
    }

    if (!ffmpegPath) {
      console.error("❌ FFmpeg path not found");
      return null;
    }

    // Normalize path
    ffmpegPath = path.normalize(ffmpegPath);
    console.log("  - Normalized path:", ffmpegPath);

    // Ensure binary exists
    try {
      await accessAsync(ffmpegPath, constants.F_OK);
      console.log("  - Binary exists: ✅");
    } catch (err) {
      console.error("  - Binary exists: ❌");
      console.error("  - Access error:", err);
      throw err;
    }
    
    // Ensure binary is executable
    await ensureExecutable(ffmpegPath);

    console.log(`✅ FFmpeg binary ready at: ${ffmpegPath}`);
    return ffmpegPath;
  } catch (error: any) {
    console.error("❌ Error loading FFmpeg:");
    console.error("  - Error message:", error.message);
    console.error("  - Error stack:", error.stack);
    return null;
  }
}

// Function to get ffprobe path
export async function getFfprobePath(): Promise<string | null> {
  try {
    const ffprobeStatic = require("ffprobe-static");
    let ffprobePath = ffprobeStatic.path;

    if (!ffprobePath) {
      console.error("❌ FFprobe path not found in ffprobe-static");
      return null;
    }

    // Fix ASAR path if needed (production mode)
    if (!isDevelopment()) {
      if (ffprobePath.includes("app.asar") && !ffprobePath.includes("app.asar.unpacked")) {
        ffprobePath = ffprobePath.replace("app.asar", "app.asar.unpacked");
      }
    }

    // Normalize path
    ffprobePath = path.normalize(ffprobePath);

    // Ensure binary exists
    await accessAsync(ffprobePath, constants.F_OK);
    
    // Ensure binary is executable
    await ensureExecutable(ffprobePath);

    console.log(`✅ FFprobe binary ready at: ${ffprobePath}`);
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
    console.log("🎬 Initializing FFmpeg...");
    
    const ffmpegPath = await getFfmpegPath();
    const ffprobePath = await getFfprobePath();

    if (!ffmpegPath) {
      console.error("⚠️  FFmpeg binary not found!");
    }

    if (!ffprobePath) {
      console.error("⚠️  FFprobe binary not found!");
    }

    if (ffmpegPath && ffprobePath) {
      console.log("✅ FFmpeg initialization completed successfully");
    } else {
      console.error("❌ FFmpeg initialization failed");
    }

    return { ffmpegPath, ffprobePath };
  } catch (error) {
    console.error("❌ Error initializing FFmpeg:", error);
    return { ffmpegPath: null, ffprobePath: null };
  }
}
