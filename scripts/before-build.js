const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch } = context;

  console.log(`Building for platform: ${electronPlatformName}, arch: ${arch}`);

  // macOS arm64 ビルドの場合、arm64 ffprobe バイナリを準備
  if (electronPlatformName === "darwin" && arch === "arm64") {
    console.log("Preparing arm64 ffprobe for macOS build...");

    const ffprobeBinDir = path.join(__dirname, "..", "ffprobe-bin", "darwin-arm64");
    const ffprobeDest = path.join(ffprobeBinDir, "ffprobe");

    if (fs.existsSync(ffprobeDest)) {
      const stats = fs.statSync(ffprobeDest);
      console.log(`✅ arm64 ffprobe already present (${stats.size} bytes)`);
    } else {
      // Homebrew からコピー
      const homebrewFfprobe = "/opt/homebrew/bin/ffprobe";
      if (fs.existsSync(homebrewFfprobe)) {
        fs.mkdirSync(ffprobeBinDir, { recursive: true });
        fs.copyFileSync(homebrewFfprobe, ffprobeDest);
        fs.chmodSync(ffprobeDest, 0o755);
        const stats = fs.statSync(ffprobeDest);
        console.log(`✅ Copied arm64 ffprobe from Homebrew (${stats.size} bytes)`);
      } else {
        console.error("❌ Homebrew ffprobe not found at /opt/homebrew/bin/ffprobe");
        console.error("   Run: brew install ffmpeg");
        throw new Error("arm64 ffprobe not available. Run: brew install ffmpeg");
      }
    }
  }

  // Windows用のビルドの場合、ffmpegバイナリを準備
  if (electronPlatformName === "win32") {
    console.log("Preparing @ffmpeg-installer/win32-x64 for Windows build...");

    const win32PkgDir = path.join(
      __dirname,
      "..",
      "node_modules",
      "@ffmpeg-installer",
      "win32-x64",
    );
    const ffmpegExePath = path.join(win32PkgDir, "ffmpeg.exe");

    if (fs.existsSync(ffmpegExePath)) {
      const stats = fs.statSync(ffmpegExePath);
      console.log(
        `✅ @ffmpeg-installer/win32-x64/ffmpeg.exe already present (${stats.size} bytes)`,
      );
    } else {
      console.log("📦 @ffmpeg-installer/win32-x64 not found, installing...");
      try {
        // プラットフォームを win32 に強制して npm install
        // --no-save で package.json は変更しない
        // npm_config_os / npm_config_cpu で OS チェックをバイパスして
        // macOS 上でも Windows バイナリをインストールできる
        execSync("npm install @ffmpeg-installer/win32-x64 --no-save", {
          cwd: path.join(__dirname, ".."),
          stdio: "inherit",
          env: {
            ...process.env,
            npm_config_os: "win32",
            npm_config_cpu: "x64",
          },
        });

        if (fs.existsSync(ffmpegExePath)) {
          const stats = fs.statSync(ffmpegExePath);
          console.log(`✅ ffmpeg.exe installed: ${stats.size} bytes`);

          // Windows PE形式かどうか確認 (MZ ヘッダー = 4d5a)
          const buf = Buffer.alloc(2);
          const fd = fs.openSync(ffmpegExePath, "r");
          fs.readSync(fd, buf, 0, 2, 0);
          fs.closeSync(fd);
          if (buf[0] === 0x4d && buf[1] === 0x5a) {
            console.log("✅ Binary is Windows PE format (MZ header) ✅");
          } else {
            console.warn(
              `⚠️  Unexpected binary header: ${buf.toString("hex")} — may not be a valid Windows binary`,
            );
          }
        } else {
          throw new Error("ffmpeg.exe not found after install");
        }
      } catch (error) {
        console.error("❌ Error preparing Windows ffmpeg:", error.message);
        console.warn(
          "⚠️  Build will continue, but ffmpeg may not work on Windows",
        );
      }
    }
  }

  return true;
};
