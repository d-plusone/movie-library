#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

console.log("🔧 Preparing ffmpeg for Windows build...");

const ffmpegStaticPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "ffmpeg-static"
);

try {
  console.log("�️  Removing existing ffmpeg-static...");

  // 既存のffmpeg-staticを完全に削除
  if (fs.existsSync(ffmpegStaticPath)) {
    fs.rmSync(ffmpegStaticPath, { recursive: true, force: true });
    console.log("✅ Removed existing ffmpeg-static");
  }

  console.log("📦 Installing ffmpeg-static for Windows platform...");

  // Windows x64用にffmpeg-staticを新規インストール
  execSync("npm install ffmpeg-static", {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_platform: "win32",
      npm_config_arch: "x64",
    },
  });

  console.log("✅ ffmpeg-static reinstalled for Windows");

  // ファイルの確認（Windows用は .exe 拡張子付き）
  const ffmpegExePath = path.join(ffmpegStaticPath, "ffmpeg.exe");
  const ffmpegPath = path.join(ffmpegStaticPath, "ffmpeg");

  if (fs.existsSync(ffmpegExePath)) {
    const stats = fs.statSync(ffmpegExePath);
    console.log(`✅ ffmpeg.exe found: ${stats.size} bytes`);

    // ファイルタイプを確認（簡易）
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(ffmpegExePath, "r");
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);

    const magic = buffer.toString("hex");
    if (magic === "4d5a9000") {
      console.log("✅ Binary is Windows PE format (MZ header)");
    } else if (magic === "cffaedfe" || magic === "feedfacf") {
      console.error("❌ Binary is Mach-O format (macOS) - WRONG!");
      process.exit(1);
    } else {
      console.log(`ℹ️  Binary magic number: ${magic}`);
    }

    // 拡張子なしのコピーも作成（互換性のため）
    fs.copyFileSync(ffmpegExePath, ffmpegPath);
    console.log("✅ Created ffmpeg (no extension) copy");
  } else {
    console.error("❌ ffmpeg.exe not found after reinstall");
    process.exit(1);
  }

  console.log("🎉 Windows ffmpeg preparation complete!");
} catch (error) {
  console.error("❌ Error preparing Windows ffmpeg:", error.message);
  process.exit(1);
}
