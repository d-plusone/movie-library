const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch, appOutDir } = context;

  console.log(
    `Post-processing package for platform: ${electronPlatformName}, arch: ${arch}`
  );
  console.log(`App output directory: ${appOutDir}`);

  // Set executable permissions for ffmpeg and ffprobe binaries
  try {
    // Convert arch number to string (Arch.x64 = 1, Arch.ia32 = 0, etc.)
    const archMap = {
      0: "ia32",
      1: "x64",
      2: "armv7l",
      3: "arm64",
      4: "universal", // macOS universal binary
    };
    const archString = typeof arch === "number" ? archMap[arch] || "x64" : arch;

    console.log(
      `Setting permissions for ${electronPlatformName} ${archString}`
    );

    // Determine the correct resources path based on platform
    let resourcesPath;
    if (electronPlatformName === "darwin") {
      // macOS: appOutDir contains the .app bundle
      // Find the .app directory
      const appFiles = require("fs").readdirSync(appOutDir);
      const appFile = appFiles.find((f) => f.endsWith(".app"));
      if (appFile) {
        resourcesPath = path.join(appOutDir, appFile, "Contents", "Resources");
      } else {
        console.error("Could not find .app bundle in:", appOutDir);
        return true;
      }
    } else {
      // Windows/Linux: appOutDir contains resources directly
      resourcesPath = path.join(appOutDir, "resources");
    }

    console.log("Resources path:", resourcesPath);

    // ffmpeg-static stores binary at the root level (same for all platforms)
    const ffmpegPath = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "ffmpeg-static",
      "ffmpeg"
    );

    // ffprobe path with platform-specific directory structure
    // For universal builds, try both x64 and arm64
    let ffprobePaths = [];
    if (archString === "universal") {
      // Try both architectures for universal builds
      ffprobePaths = [
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "ffprobe-static",
          "bin",
          electronPlatformName,
          "arm64",
          "ffprobe"
        ),
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "ffprobe-static",
          "bin",
          electronPlatformName,
          "x64",
          "ffprobe"
        ),
      ];
    } else {
      const ffprobeBasePath = path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "ffprobe-static",
        "bin",
        electronPlatformName,
        archString,
        "ffprobe"
      );

      // On Windows, ffprobe has .exe extension
      ffprobePaths = [
        electronPlatformName === "win32"
          ? ffprobeBasePath + ".exe"
          : ffprobeBasePath,
      ];
    }

    // Set executable permissions (Unix-based systems only)
    if (electronPlatformName !== "win32") {
      // Set executable permission for ffmpeg
      if (fs.existsSync(ffmpegPath)) {
        console.log("Setting executable permission for ffmpeg:", ffmpegPath);
        fs.chmodSync(ffmpegPath, 0o755);
        console.log("✅ FFmpeg executable permission set");
      } else {
        console.warn("⚠️  FFmpeg binary not found at:", ffmpegPath);
      }

      // Set executable permission for ffprobe (try all possible paths)
      let ffprobeFound = false;
      for (const ffprobePath of ffprobePaths) {
        if (fs.existsSync(ffprobePath)) {
          console.log(
            "Setting executable permission for ffprobe:",
            ffprobePath
          );
          fs.chmodSync(ffprobePath, 0o755);
          console.log("✅ FFprobe executable permission set");
          ffprobeFound = true;
        }
      }

      if (!ffprobeFound) {
        console.warn(
          "⚠️  FFprobe binary not found at any of these paths:",
          ffprobePaths
        );
      }
    } else {
      console.log(
        "ℹ️  Windows build - executable permissions not needed (.exe files)"
      );
    }
  } catch (error) {
    console.error("Error setting executable permissions:", error.message);
  }

  return true;
};
