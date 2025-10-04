const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch } = context;

  console.log(`Building for platform: ${electronPlatformName}, arch: ${arch}`);

  // Windows用のビルドの場合、ffmpegバイナリを準備
  if (electronPlatformName === "win32") {
    console.log("Preparing ffmpeg for Windows...");

    try {
      const ffmpegStaticPath = path.join(
        __dirname,
        "..",
        "node_modules",
        "ffmpeg-static"
      );

      console.log("Reinstalling ffmpeg-static for Windows platform...");

      // Windows用にffmpeg-staticを再インストール
      execSync(
        "npm_config_platform=win32 npm_config_arch=x64 npm install ffmpeg-static",
        {
          cwd: path.join(__dirname, ".."),
          stdio: "inherit",
          env: {
            ...process.env,
            npm_config_platform: "win32",
            npm_config_arch:
              arch === 3 || arch === "arm64"
                ? "x64"
                : arch === 1 || arch === "x64"
                ? "x64"
                : "ia32",
          },
        }
      );

      console.log("✅ ffmpeg-static reinstalled for Windows");

      // ファイルの確認
      const ffmpegPath = path.join(ffmpegStaticPath, "ffmpeg");
      if (fs.existsSync(ffmpegPath)) {
        const stats = fs.statSync(ffmpegPath);
        console.log(`✅ ffmpeg binary found: ${stats.size} bytes`);

        // .exeのコピーを作成
        const ffmpegExePath = path.join(ffmpegStaticPath, "ffmpeg.exe");
        if (!fs.existsSync(ffmpegExePath)) {
          fs.copyFileSync(ffmpegPath, ffmpegExePath);
          console.log("✅ Created ffmpeg.exe copy");
        }
      } else {
        console.warn("⚠️  ffmpeg binary not found after reinstall");
      }
    } catch (error) {
      console.error("❌ Error preparing Windows ffmpeg:", error.message);
      console.warn(
        "⚠️  Build will continue, but ffmpeg may not work on Windows"
      );
    }
  }

  // Windows用のビルドの場合
  if (electronPlatformName === "win32") {
    console.log("Preparing better-sqlite3 for Windows...");

    try {
      // better-sqlite3のバイナリ確認
      const betterSqlite3Path = path.join(
        __dirname,
        "..",
        "node_modules",
        "better-sqlite3"
      );

      if (fs.existsSync(betterSqlite3Path)) {
        console.log("better-sqlite3 module found");

        // package.jsonの確認
        const packageJsonPath = path.join(betterSqlite3Path, "package.json");
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
          console.log(`better-sqlite3 version: ${pkg.version}`);
        }

        // buildディレクトリの確認
        const buildPath = path.join(betterSqlite3Path, "build");
        if (fs.existsSync(buildPath)) {
          const buildContents = fs.readdirSync(buildPath);
          console.log("better-sqlite3 build contents:", buildContents);
        } else {
          console.log("better-sqlite3 build directory not found");
        }
      }

      console.log("better-sqlite3 preparation completed");
    } catch (error) {
      console.error("Error in before-build:", error.message);
    }
  }

  return true;
};
