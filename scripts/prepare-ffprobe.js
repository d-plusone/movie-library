// prepare-ffprobe.js
//
// macOS arm64 用の静的リンク ffprobe を準備するスクリプト。
//
// 背景:
//   Homebrew の ffprobe (/opt/homebrew/bin/ffprobe) は多数の Homebrew dylib
//   (libavdevice, libavcodec, libx264 など) に動的リンクされている。
//   これをそのままアプリに同梱すると、Homebrew のアップグレードで
//   dylib のパス (Cellar/ffmpeg/8.1 → 8.1.2_1 など) が変わるたびに
//   dyld エラー "Library not loaded: ..." で起動できなくなる。
//
// 対策:
//   eugeneware/ffmpeg-static の GitHub Releases から
//   「システムフレームワークのみに依存する静的リンク版 ffprobe (arm64)」を取得する。
//   このバイナリは Homebrew に依存しないため、どのマシンでも動く。
//
// 冪等:
//   有効な静的リンク版バイナリが既にあれば何もしない（即終了・高速）。
//   Homebrew 由来や x86_64 のバイナリが置かれていれば置き換える。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// eugeneware/ffmpeg-static のリリースタグ（ffprobe 6.0 ベース、arm64 静的リンク）
const FFPROBE_STATIC_TAG = "b6.1.1";
const FFPROBE_DOWNLOAD_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFPROBE_STATIC_TAG}/ffprobe-darwin-arm64`;
const FFPROBE_BIN_DIR = path.join(
  __dirname,
  "..",
  "ffprobe-bin",
  "darwin-arm64",
);
const FFPROBE_DEST = path.join(FFPROBE_BIN_DIR, "ffprobe");
// ダウンロード中の一時ファイル。検証に成功した場合のみ FFPROBE_DEST へ
// アトミックにリネームする（curl がタイムアウト/中断された場合に、
// 破損した実行ファイルを最終パスへ残してしまうのを防ぐ）。
const FFPROBE_DOWNLOAD_TMP = `${FFPROBE_DEST}.download`;

// Mach-O ヘッダの CPU_TYPE_ARM64 (arm64)
const CPU_TYPE_ARM64 = 0x0100000c; // 16777228
// Homebrew の dylib パスが埋め込まれているかのマーカー（動的リンク判定）
const HOMEBREW_MARKER = Buffer.from("/opt/homebrew");
// 正常な静的リンク版バイナリは数十MBあるため、これより極端に小さい場合は
// ダウンロードが途中で切れた/壊れたとみなす（旧実装は先頭8バイトしか見ておらず、
// 切り詰められたファイルでもヘッダーさえ無事なら「使用可能」と誤判定していた）。
const MIN_EXPECTED_SIZE_BYTES = 1_000_000; // 1MB

// ファイルが「arm64 ネイティブの Mach-O で、Homebrew に依存していない」かを判定
function isUsableFfprobe(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (stat.size < MIN_EXPECTED_SIZE_BYTES) return false;
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  // Mach-O 64-bit little-endian マジック (0xfeedfacf)
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0xfeedfacf) return false;
  // CPU タイプが arm64 であること（x86_64 の Rosetta 依存を排除）
  if (buf.readUInt32LE(4) !== CPU_TYPE_ARM64) return false;
  // Homebrew の dylib パスが埋め込まれていないこと（動的リンク版を排除）
  if (buf.includes(HOMEBREW_MARKER)) return false;
  return true;
}

function downloadFfprobe() {
  console.log("⬇️  Downloading static arm64 ffprobe...");
  fs.mkdirSync(FFPROBE_BIN_DIR, { recursive: true });
  if (fs.existsSync(FFPROBE_DOWNLOAD_TMP)) {
    fs.unlinkSync(FFPROBE_DOWNLOAD_TMP);
  }
  const result = spawnSync(
    "curl",
    ["-sL", "--fail", "-o", FFPROBE_DOWNLOAD_TMP, FFPROBE_DOWNLOAD_URL],
    { stdio: "inherit", timeout: 120000 },
  );
  if (result.status !== 0) {
    try {
      fs.unlinkSync(FFPROBE_DOWNLOAD_TMP);
    } catch {
      // 一時ファイルが存在しない場合は無視
    }
    throw new Error(
      `Failed to download ffprobe from ${FFPROBE_DOWNLOAD_URL} (curl exit code ${result.status})`,
    );
  }
  fs.chmodSync(FFPROBE_DOWNLOAD_TMP, 0o755);
  if (!isUsableFfprobe(FFPROBE_DOWNLOAD_TMP)) {
    fs.unlinkSync(FFPROBE_DOWNLOAD_TMP);
    throw new Error(
      "Downloaded ffprobe failed validation (truncated download or unexpected binary?)",
    );
  }
  // 検証済みバイナリのみを最終パスへ反映する
  fs.renameSync(FFPROBE_DOWNLOAD_TMP, FFPROBE_DEST);
}

function prepare() {
  // このスクリプトは macOS arm64 専用。他プラットフォームのビルド
  // （例: Windows CI からの build:vite 実行）ではこのネットワーク依存を
  // 発生させず、何もせず正常終了する。
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log(
      `ℹ️  Skipping static ffprobe preparation (not macOS arm64: ${process.platform}/${process.arch})`,
    );
    return;
  }

  if (isUsableFfprobe(FFPROBE_DEST)) {
    const size = fs.statSync(FFPROBE_DEST).size;
    console.log(`✅ Static arm64 ffprobe already present (${size} bytes)`);
    return;
  }

  // 壊れたバイナリ（Homebrew コピーや x86_64 版、切り詰められたダウンロード）が
  // あれば削除してから取得
  if (fs.existsSync(FFPROBE_DEST)) {
    console.log("♻️  Replacing broken / Homebrew-linked / truncated ffprobe...");
    fs.unlinkSync(FFPROBE_DEST);
  }

  try {
    downloadFfprobe();
    const size = fs.statSync(FFPROBE_DEST).size;
    console.log(`✅ Static arm64 ffprobe ready (${size} bytes)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Failed to prepare static arm64 ffprobe:", message);
    throw error;
  }
}

prepare();
