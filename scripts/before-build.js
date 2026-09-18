const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
        "   pnpm-workspace.yaml の supportedArchitectures を有効にしたうえで、次を実行してください:",
      );
      console.error(
        "     pnpm install --frozen-lockfile",
      );
      console.error(
        "   (pnpm が管理する node_modules を壊すため、ここで npm install は行いません)",
      );
      throw new Error(
        "@ffmpeg-installer/win32-x64/ffmpeg.exe is missing — see instructions above before building for Windows",
      );
    }

    // Prisma の CLI もアプリ起動時に migration を実行するため、
    // クロスビルド時はホスト(macOS)用ではなく Windows 用の CLI engine を
    // 明示的に取得する。Windows runner 上では通常の postinstall で既に
    // 存在するが、同じ処理を再実行して成果物の前提を統一する。
    const prismaPackageJson = require.resolve(
      "prisma/package.json",
      { paths: [path.join(__dirname, "..", "node_modules")] },
    );
    const prismaEnginesPostinstall = require.resolve(
      "@prisma/engines/scripts/postinstall.js",
      { paths: [path.dirname(prismaPackageJson)] },
    );
    if (!fs.existsSync(prismaEnginesPostinstall)) {
      throw new Error(
        "@prisma/engines postinstall.js is missing — cannot prepare Windows Prisma CLI engines",
      );
    }

    console.log("Preparing Windows Prisma CLI engines...");
    execFileSync(process.execPath, [prismaEnginesPostinstall], {
      env: {
        ...process.env,
        PRISMA_CLI_BINARY_TARGETS: "windows",
      },
      stdio: "inherit",
    });

    const prismaEnginesDir = path.dirname(
      path.dirname(prismaEnginesPostinstall),
    );
    for (const requiredEngine of [
      "query_engine-windows.dll.node",
      "schema-engine-windows.exe",
    ]) {
      if (!fs.existsSync(path.join(prismaEnginesDir, requiredEngine))) {
        throw new Error(
          `${requiredEngine} is missing — cannot create a Windows package with a working Prisma CLI`,
        );
      }
    }
    console.log("✅ Windows Prisma CLI engines ready");
  }

  return true;
};
