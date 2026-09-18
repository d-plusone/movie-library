const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function removeWrongPlatformPrismaEngines(
  unpackedPath,
  electronPlatformName,
) {
  const engineLocations = [
    path.join(unpackedPath, "node_modules", "prisma"),
    path.join(unpackedPath, "node_modules", "prisma", "node_modules", "@prisma", "engines"),
    path.join(unpackedPath, "node_modules", "@prisma", "engines"),
    path.join(unpackedPath, "node_modules", ".prisma", "client"),
    path.join(unpackedPath, "generated", "prisma"),
  ];
  const wrongPlatformFiles =
    electronPlatformName === "win32"
      ? [
          "libquery_engine-darwin.dylib.node",
          "libquery_engine-darwin-arm64.dylib.node",
          "query_engine-darwin",
          "query_engine-darwin-arm64",
          "schema-engine-darwin",
          "schema-engine-darwin-arm64",
        ]
      : [
          "query_engine-windows.dll.node",
          "schema-engine-windows.exe",
        ];

  for (const location of engineLocations) {
    for (const fileName of wrongPlatformFiles) {
      const targetPath = path.join(location, fileName);
      if (!fs.existsSync(targetPath)) continue;
      fs.rmSync(targetPath, { recursive: true, force: true });
      console.log(`🗑️  Deleted: ${path.relative(unpackedPath, targetPath)}`);
    }
  }
}

/**
 * afterPack で Prisma CLI の依存ツリーをコピーした後に、実行時に読まれない
 * source map を取り除く。electron-builder の files フィルターは後処理の fs.cpSync
 * には適用されないため、ここで明示的に除外する。
 */
function removeSourceMaps(directory) {
  if (!fs.existsSync(directory)) return;

  let removed = 0;
  const visit = (currentPath) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".map")) {
        fs.unlinkSync(entryPath);
        removed += 1;
      }
    }
  };

  visit(directory);
  if (removed > 0) {
    console.log(`🗑️  Deleted ${removed} source map files`);
  }
}

function prepareWindowsPrismaCliEngines() {
  const projectRoot = path.join(__dirname, "..");
  const prismaSourcePath = resolvePackageRoot(
    "prisma",
    path.join(projectRoot, "node_modules"),
  );
  const prismaEnginesDir = resolvePackageRoot(
    "@prisma/engines",
    prismaSourcePath,
  );
  const prismaEnginesPostinstall = path.join(
    prismaEnginesDir,
    "scripts",
    "postinstall.js",
  );
  const requiredEngines = [
    "query_engine-windows.dll.node",
    "schema-engine-windows.exe",
  ];

  if (!fs.existsSync(prismaEnginesPostinstall)) {
    throw new Error(
      "@prisma/engines postinstall.js is missing — cannot prepare Windows Prisma CLI engines",
    );
  }

  if (
    requiredEngines.some(
      (engine) => !fs.existsSync(path.join(prismaEnginesDir, engine)),
    )
  ) {
    console.log("Preparing Windows Prisma CLI engines in afterPack...");
    execFileSync(process.execPath, [prismaEnginesPostinstall], {
      env: {
        ...process.env,
        PRISMA_CLI_BINARY_TARGETS: "windows",
      },
      stdio: "inherit",
    });
  }

  for (const requiredEngine of requiredEngines) {
    if (!fs.existsSync(path.join(prismaEnginesDir, requiredEngine))) {
      throw new Error(
        `${requiredEngine} is missing — cannot create a Windows package with a working Prisma CLI`,
      );
    }
  }
  console.log("✅ Windows Prisma CLI engines ready for packaging");
}

function resolvePackageRoot(packageName, fromPackageRoot) {
  let current = fromPackageRoot;
  while (current !== path.dirname(current)) {
    const candidates = [
      path.join(current, "node_modules", packageName),
      path.join(current, packageName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return fs.realpathSync(candidate);
      }
    }
    current = path.dirname(current);
  }

  const resolved = require.resolve(packageName, { paths: [fromPackageRoot] });
  let packageRoot = path.dirname(resolved);
  while (
    packageRoot !== path.dirname(packageRoot) &&
    !fs.existsSync(path.join(packageRoot, "package.json"))
  ) {
    packageRoot = path.dirname(packageRoot);
  }
  return packageRoot;
}

/**
 * Prisma CLI は devDependency として明示的に梱包しているため、electron-builder
 * の通常の production dependency 収集だけでは pnpm の推移依存を拾えない。
 * npm 互換の node_modules ツリーを app.asar.unpacked に再構成する。
 */
function copyPrismaCliDependencyTree(
  packageName,
  fromPackageRoot,
  targetNodeModules,
  copiedTargets,
) {
  const sourceRoot = resolvePackageRoot(packageName, fromPackageRoot);
  const targetRoot = path.join(
    targetNodeModules,
    ...packageName.split("/"),
  );
  const targetKey = path.resolve(targetRoot);

  if (!copiedTargets.has(targetKey)) {
    copiedTargets.add(targetKey);
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    if (!fs.existsSync(targetRoot)) {
      fs.cpSync(sourceRoot, targetRoot, {
        recursive: true,
        dereference: true,
      });
      console.log(`✓ Bundled Prisma dependency: ${packageName}`);
    }
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
  );
  const dependencies = Object.keys({
    ...(packageJson.dependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  });
  const nestedNodeModules = path.join(targetRoot, "node_modules");

  for (const dependency of dependencies) {
    try {
      copyPrismaCliDependencyTree(
        dependency,
        sourceRoot,
        nestedNodeModules,
        copiedTargets,
      );
    } catch (error) {
      if (packageJson.optionalDependencies?.[dependency] !== undefined) {
        console.log(
          `- Skipping unavailable optional Prisma dependency: ${dependency}`,
        );
        continue;
      }
      throw new Error(
        `Unable to bundle Prisma dependency ${dependency} required by ${packageName}: ${error.message}`,
      );
    }
  }
}

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
      if (archString === "arm64") {
        // macOS arm64 は extraResources の静的リンク ffprobe を使用するため、
        // ffprobe-static は実行時に参照されない。
        deleteIfExists(
          path.join(unpackedPath, "node_modules", "ffprobe-static"),
        );
      }

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
      // Windows x64 のみを配布するため ia32 版は不要。
      deleteIfExists(
        path.join(
          unpackedPath,
          "node_modules",
          "ffprobe-static",
          "bin",
          "win32",
          "ia32",
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
    if (electronPlatformName === "win32") {
      prepareWindowsPrismaCliEngines();
    }

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

    const bundledNodeModules = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
    );
    copyPrismaCliDependencyTree(
      "prisma",
      prismaSourcePath,
      bundledNodeModules,
      new Set(),
    );
    console.log("✓ Bundled Prisma CLI dependency tree");

    // copyPrismaCliDependencyTree は pnpm の nested node_modules も再構成する
    // ため、先ほどの通常 cleanup の後に、そこへコピーされたホストOS用
    // engine が残っていないことを再確認する。
    removeWrongPlatformPrismaEngines(
      path.join(resourcesPath, "app.asar.unpacked"),
      electronPlatformName,
    );
    removeSourceMaps(path.join(resourcesPath, "app.asar.unpacked"));
  } catch (error) {
    throw new Error(`Error copying Prisma files: ${error.message}`);
  }

  return true;
};
