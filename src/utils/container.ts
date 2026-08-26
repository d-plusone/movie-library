/**
 * コンテナ形式の判別ユーティリティ（純粋関数）
 *
 * ファイル先頭バイトのシグネチャから実際のコンテナ種別を判定し、
 * 拡張子との不一致や内蔵プレーヤー再生可否を分類する。
 * Electron / fs に依存しないため単体テストから直接検証できる。
 */

export type ContainerKind =
  | "isobmff" // MP4 / M4V / MOV 系（"ftyp" ボックス）
  | "webm" // Matroska / WebM（EBML ヘッダ）
  | "mpegts" // MPEG-TS（188 バイト周期の同期バイト）
  | "avi"
  | "flv"
  | "unknown";

// ISOBMFF（MP4/M4V/MOV）の先頭ボックスとして現れうる 4 文字タイプ。
// 新しめのファイルはほぼ常に "ftyp" だが、古い QuickTime 由来の .mov は
// ftyp を持たず moov/free/wide/skip/pnot/mdat/junk から始まることがある。
// これらを判別できないと、実際は再生可能なファイルを
// 「内蔵プレーヤーで再生不可」と誤判定してしまう。
const ISOBMFF_BOX_TYPES = new Set([
  "ftyp",
  "moov",
  "free",
  "skip",
  "wide",
  "pnot",
  "mdat",
  "junk",
]);

function readAscii4(head: Readonly<Uint8Array>, offset: number): string {
  return String.fromCharCode(
    head[offset],
    head[offset + 1],
    head[offset + 2],
    head[offset + 3],
  );
}

/** 先頭バイト列からコンテナ種別を判定する（判別できない場合は "unknown"） */
export function detectContainerKind(
  head: Readonly<Uint8Array>,
): ContainerKind {
  if (head.length >= 12) {
    // ISOBMFF: 4 バイトのサイズの後にボックスタイプ（"ftyp" 等）
    if (ISOBMFF_BOX_TYPES.has(readAscii4(head, 4))) {
      return "isobmff";
    }
    // Matroska / WebM: EBML マジック 0x1A45DFA3
    if (
      head[0] === 0x1a &&
      head[1] === 0x45 &&
      head[2] === 0xdf &&
      head[3] === 0xa3
    ) {
      return "webm";
    }
    // AVI: "RIFF" .... "AVI "
    if (
      head[0] === 0x52 &&
      head[1] === 0x49 &&
      head[2] === 0x46 &&
      head[3] === 0x46 &&
      head[8] === 0x41 &&
      head[9] === 0x56 &&
      head[10] === 0x49 &&
      head[11] === 0x20
    ) {
      return "avi";
    }
    // FLV: "FLV\x01"
    if (
      head[0] === 0x46 &&
      head[1] === 0x4c &&
      head[2] === 0x56 &&
      head[3] === 0x01
    ) {
      return "flv";
    }
  }

  // MPEG-TS: 188 バイト周期のパケット同期バイト 0x47 を 3 点確認
  if (head.length >= 377) {
    if (head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) {
      return "mpegts";
    }
  }

  return "unknown";
}

/** 拡張子（ドット込み・小文字正規化済み）から期待されるコンテナ種別を返す */
export function expectedKindForExtension(
  extension: string,
): ContainerKind | null {
  const ext = extension.toLowerCase();
  switch (ext) {
    case ".mp4":
    case ".m4v":
    case ".mov":
      return "isobmff";
    case ".webm":
    case ".mkv":
      return "webm";
    case ".ts":
    case ".mts":
    case ".m2ts":
      return "mpegts";
    case ".avi":
      return "avi";
    case ".flv":
      return "flv";
    default:
      return null;
  }
}

/** 人間可読なコンテナ名 */
export function containerLabel(kind: ContainerKind): string {
  switch (kind) {
    case "isobmff":
      return "MP4 (ISOBMFF)";
    case "webm":
      return "WebM/Matroska";
    case "mpegts":
      return "MPEG-TS";
    case "avi":
      return "AVI";
    case "flv":
      return "FLV";
    default:
      return "不明";
  }
}

/** Chromium の <video> で直接再生できるコンテナ種別 */
const NATIVE_PLAYABLE: ReadonlySet<ContainerKind> = new Set<ContainerKind>([
  "isobmff",
  "webm",
]);

export interface ContainerVerdict {
  kind: ContainerKind;
  /** 内蔵プレーヤーで再生可能なコンテナか */
  nativePlayable: boolean;
  /** 拡張子と実際のコンテナが一致しないか */
  extensionMismatch: boolean;
}

/**
 * 判定結果を分類する。
 * - nativePlayable=false: MPEG-TS 等の内蔵非対応コンテナ
 * - extensionMismatch=true: 拡張子と中身が不一致（例: 中身が TS の .mp4）
 */
export function classifyContainer(
  kind: ContainerKind,
  extension: string,
): ContainerVerdict {
  const expected = expectedKindForExtension(extension);
  const extensionMismatch =
    kind !== "unknown" && expected !== null && expected !== kind;
  return {
    kind,
    nativePlayable: NATIVE_PLAYABLE.has(kind),
    extensionMismatch,
  };
}
