const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch, appOutDir } = context;

  console.log(
    `Post-processing package for platform: ${electronPlatformName}, arch: ${arch}`
  );
  console.log(`App output directory: ${appOutDir}`);

  // Windows用のパッケージ後処理
  if (electronPlatformName === "win32") {
    console.log("Post-processing Windows package...");

    // better-sqlite3のバインディングファイルをチェック
    const resourcesPath = path.join(appOutDir, "resources");
    const asarPath = path.join(resourcesPath, "app.asar");
    const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");

    console.log("Resources path:", resourcesPath);
    console.log("ASAR path:", asarPath);
    console.log("Unpacked path:", unpackedPath);

    // node_modules/better-sqlite3/build ディレクトリの確認
    const betterSqlite3UnpackedPath = path.join(
      unpackedPath,
      "node_modules",
      "better-sqlite3",
      "build"
    );

    if (fs.existsSync(betterSqlite3UnpackedPath)) {
      console.log(
        "Found better-sqlite3 build directory:",
        betterSqlite3UnpackedPath
      );

      // ディレクトリ内容を確認
      try {
        const buildContents = fs.readdirSync(betterSqlite3UnpackedPath, {
          recursive: true,
        });
        console.log("Build directory contents:", buildContents);

        // 正しいWindows用バイナリがあるか確認
        const hasWinBinary = buildContents.some(
          (file) => file.includes(".node") || file.includes("better_sqlite3")
        );

        if (hasWinBinary) {
          console.log("Windows binary found in better-sqlite3 build directory");
        } else {
          console.log(
            "Windows binary not found in better-sqlite3 build directory"
          );
        }
      } catch (error) {
        console.error("Error checking build directory:", error.message);
      }
    } else {
      console.log(
        "better-sqlite3 build directory not found in unpacked resources"
      );

      // libディレクトリもチェック
      const betterSqlite3LibPath = path.join(
        unpackedPath,
        "node_modules",
        "better-sqlite3",
        "lib"
      );
      if (fs.existsSync(betterSqlite3LibPath)) {
        console.log(
          "Found better-sqlite3 lib directory:",
          betterSqlite3LibPath
        );
        const libContents = fs.readdirSync(betterSqlite3LibPath);
        console.log("Lib directory contents:", libContents);
      }
    }

    console.log("Windows post-processing completed");
  }

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
        resourcesPath = path.join(
          appOutDir,
          appFile,
          "Contents",
          "Resources"
        );
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

    // Set executable permission for ffmpeg
    if (fs.existsSync(ffmpegPath)) {
      console.log("Setting executable permission for ffmpeg:", ffmpegPath);

      if (electronPlatformName === "win32") {
        // On Windows, rename the file to have .exe extension
        const ffmpegExePath = ffmpegPath + ".exe";

        // If .exe version doesn't exist, copy the file with .exe extension
        if (!fs.existsSync(ffmpegExePath)) {
          console.log("Creating .exe version for Windows:", ffmpegExePath);
          fs.copyFileSync(ffmpegPath, ffmpegExePath);
          console.log("✅ FFmpeg .exe file created");
        }

        // Set permissions on both files
        try {
          fs.chmodSync(ffmpegPath, 0o755);
          fs.chmodSync(ffmpegExePath, 0o755);
          console.log("✅ FFmpeg executable permissions set");
        } catch (chmodError) {
          console.warn(
            "⚠️  chmod failed on Windows (expected):",
            chmodError.message
          );
          console.log("Windows will use .exe extension for execution");
        }
      } else {
        // macOS and Linux - just set chmod
        fs.chmodSync(ffmpegPath, 0o755);
        console.log("✅ FFmpeg executable permission set");
      }
    } else {
      console.warn("⚠️  FFmpeg binary not found at:", ffmpegPath);
    }

    // Set executable permission for ffprobe (try all possible paths)
    let ffprobeFound = false;
    for (const ffprobePath of ffprobePaths) {
      if (fs.existsSync(ffprobePath)) {
        console.log("Setting executable permission for ffprobe:", ffprobePath);
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
  } catch (error) {
    console.error("Error setting executable permissions:", error.message);
  }

  return true;
};
