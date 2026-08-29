const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { electronPlatformName, arch } = context;

  console.log(`Building for platform: ${electronPlatformName}, arch: ${arch}`);

  // macOS arm64 ビルドの場合、静的リンク arm64 ffprobe を準備
  // （Homebrew の ffprobe は動的リンクのため dyld エラーになる。prepare-ffprobe.js が
  //   ffmpeg-static リリースの静的リンク版を取得し、既存の壊れたバイナリも置き換える）
  if (electronPlatformName === "darwin" && arch === "arm64") {
    console.log("Preparing static arm64 ffprobe for macOS build...");
    require("./prepare-ffprobe");
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
      // pnpm はプラットフォーム/CPU が一致しない optionalDependencies を
      // インストールしないため、macOS/Linux 上で Windows 向けビルドを行う場合は
      // この依存を明示的に取得しておく必要がある。
      //
      // ここで npm install にフォールバックしてはいけない: pnpm が管理する
      // node_modules はシンボリックリンクの構造（.pnpm ストア）に依存しており、
      // 生の npm install を混在させるとその構造が壊れる
      // （実際に過去これが原因でリポジトリ直下に package-lock.json が
      // 誤って生成されたことがある）。失敗を警告に留めてビルドを継続すると、
      // 壊れた/存在しない ffmpeg.exe のまま Windows パッケージが作られてしまうため、
      // ここでは自動修復を試みずビルドを止める。
      console.error(
        "❌ @ffmpeg-installer/win32-x64/ffmpeg.exe not found in node_modules.",
      );
      console.error(
        "   Windows 向けクロスビルドの前に、次のコマンドで明示的に取得してください:",
      );
      console.error(
        "     pnpm add -D --no-save @ffmpeg-installer/win32-x64 --config.supportedArchitectures.os=win32 --config.supportedArchitectures.cpu=x64",
      );
      console.error(
        "   (pnpm が管理する node_modules を壊すため、ここで npm install は行いません)",
      );
      throw new Error(
        "@ffmpeg-installer/win32-x64/ffmpeg.exe is missing — see instructions above before building for Windows",
      );
    }
  }

  return true;
};
