const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch, appOutDir } = context;

  // Convert arch number to string (Arch.x64 = 1, Arch.ia32 = 0, etc.)
  const archMap = {
    0: "ia32",
    1: "x64",
    2: "armv7l",
    3: "arm64",
    4: "universal", // macOS universal binary
  };
  const archString = typeof arch === "number" ? archMap[arch] || "x64" : arch;

  // Determine the correct resources path based on platform
  let resourcesPath;
  if (electronPlatformName === "darwin") {
    // macOS: appOutDir contains the .app bundle
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

  // Set executable permissions for ffmpeg and ffprobe binaries
  try {
    // ffmpeg is shipped via electron-builder's extraResources (see package.json
    // build.mac/build.win), NOT bundled inside node_modules/ffmpeg-static
    // (that package isn't even a dependency of this project — this used to
    // point there as a leftover from an earlier packaging approach and never
    // actually matched a real file, so the chmod below silently no-op'd).
    // Only darwin-arm64 (dmg) and win32-x64 (nsis) targets are built
    // (see package.json build.mac.target / build.win.target).
    let ffmpegArchDir;
    if (electronPlatformName === "darwin") {
      ffmpegArchDir = archString === "arm64" ? "darwin-arm64" : "darwin-x64";
    } else if (electronPlatformName === "win32") {
      ffmpegArchDir = "win32-x64";
    } else {
      ffmpegArchDir = "linux-x64";
    }
    const ffmpegExt = electronPlatformName === "win32" ? ".exe" : "";
    const ffmpegPath = path.join(
      resourcesPath,
      "ffmpeg-bin",
      ffmpegArchDir,
      `ffmpeg${ffmpegExt}`,
    );

    // macOS arm64 は Homebrew非依存の静的リンク ffprobe を extraResources 経由で
    // 同梱している（scripts/prepare-ffprobe.js が用意する）。
    const staticFfprobePath =
      electronPlatformName === "darwin" && archString === "arm64"
        ? path.join(resourcesPath, "ffprobe-bin", "darwin-arm64", "ffprobe")
        : null;

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
          "ffprobe",
        ),
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "ffprobe-static",
          "bin",
          electronPlatformName,
          "x64",
          "ffprobe",
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
        "ffprobe",
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
        fs.chmodSync(ffmpegPath, 0o755);
        console.log(`✓ chmod +x ${path.relative(resourcesPath, ffmpegPath)}`);
      }

      // Set executable permission for the bundled static ffprobe (macOS arm64)
      if (staticFfprobePath && fs.existsSync(staticFfprobePath)) {
        fs.chmodSync(staticFfprobePath, 0o755);
        console.log(
          `✓ chmod +x ${path.relative(resourcesPath, staticFfprobePath)}`,
        );
      }

      // Set executable permission for ffprobe (try all possible paths)
      for (const ffprobePath of ffprobePaths) {
        if (fs.existsSync(ffprobePath)) {
          fs.chmodSync(ffprobePath, 0o755);
        }
      }
    }
  } catch (error) {
    console.error("Error setting executable permissions:", error.message);
  }

  // Remove platform-specific binaries that are not needed for this build
  try {
    const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");

    const deleteIfExists = (targetPath) => {
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetPath);
        }
        console.log(`🗑️  Deleted: ${path.relative(unpackedPath, targetPath)}`);
      }
    };

    const prismaLocations = [
      path.join(unpackedPath, "node_modules", "prisma"),
      path.join(unpackedPath, "node_modules", ".prisma", "client"),
      path.join(unpackedPath, "generated", "prisma"),
    ];

    if (electronPlatformName === "darwin") {
      // Remove non-darwin ffprobe binaries
      deleteIfExists(
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          "linux",
        ),
      );
      deleteIfExists(
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          "win32",
        ),
      );
      if (archString === "arm64") {
        deleteIfExists(
          path.join(
            unpackedPath,
            "node_modules",
            "ffprobe-static",
            "bin",
            "darwin",
            "x64",
          ),
        );
      } else {
        deleteIfExists(
          path.join(
            unpackedPath,
            "node_modules",
            "ffprobe-static",
            "bin",
            "darwin",
            "arm64",
          ),
        );
      }

      // Remove non-darwin / non-arch Prisma engines
      const prismaToDelete = [
        "libquery_engine-linux-musl.so.node",
        "query_engine-windows.dll.node",
        archString === "arm64"
          ? "libquery_engine-darwin.dylib.node"
          : "libquery_engine-darwin-arm64.dylib.node",
      ];
      for (const location of prismaLocations) {
        for (const engineFile of prismaToDelete) {
          deleteIfExists(path.join(location, engineFile));
        }
      }
    } else if (electronPlatformName === "win32") {
      // Remove non-win32 ffprobe binaries
      deleteIfExists(
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          "linux",
        ),
      );
      deleteIfExists(
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          "darwin",
        ),
      );

      // Remove non-windows Prisma engines
      const prismaToDelete = [
        "libquery_engine-linux-musl.so.node",
        "libquery_engine-darwin.dylib.node",
        "libquery_engine-darwin-arm64.dylib.node",
      ];
      for (const location of prismaLocations) {
        for (const engineFile of prismaToDelete) {
          deleteIfExists(path.join(location, engineFile));
        }
      }
    }

    console.log("✓ Cleaned up platform-specific binaries");
  } catch (error) {
    console.error("Warning: Binary cleanup error:", error.message);
  }

  // Copy Prisma build directory to ensure CLI works
  try {
    const prismaSourcePath = path.join(
      __dirname,
      "..",
      "node_modules",
      "prisma",
    );
    const prismaTargetPath = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "prisma",
    );

    // Create target directory if it doesn't exist
    if (!fs.existsSync(prismaTargetPath)) {
      fs.mkdirSync(prismaTargetPath, { recursive: true });
    }

    // Copy build directory
    const prismaBuildSource = path.join(prismaSourcePath, "build");
    const prismaBuildTarget = path.join(prismaTargetPath, "build");

    if (fs.existsSync(prismaBuildSource)) {
      // Use recursive copy
      const copyRecursiveSync = (src, dest) => {
        const exists = fs.existsSync(src);
        const stats = exists && fs.statSync(src);
        const isDirectory = exists && stats.isDirectory();

        if (isDirectory) {
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          fs.readdirSync(src).forEach((childItemName) => {
            copyRecursiveSync(
              path.join(src, childItemName),
              path.join(dest, childItemName),
            );
          });
        } else {
          fs.copyFileSync(src, dest);
        }
      };

      copyRecursiveSync(prismaBuildSource, prismaBuildTarget);
      console.log("✓ Copied Prisma build directory");
    }

    // Copy package.json
    const prismaPackageSource = path.join(prismaSourcePath, "package.json");
    const prismaPackageTarget = path.join(prismaTargetPath, "package.json");
    if (fs.existsSync(prismaPackageSource)) {
      fs.copyFileSync(prismaPackageSource, prismaPackageTarget);
      console.log("✓ Copied Prisma package.json");
    }
  } catch (error) {
    console.error("Error copying Prisma files:", error.message);
  }

  return true;
};
