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

  return true;
};
