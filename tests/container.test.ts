import { describe, expect, it } from "vitest";
import {
  classifyContainer,
  containerLabel,
  detectContainerKind,
  expectedKindForExtension,
} from "../src/utils/container";

/** テスト用のヘッダーバイト列を生成する */
function head(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe("detectContainerKind", () => {
  it("ftyp ボックスから isobmff (MP4 系) を判定する", () => {
    const ftyp = "ftypisom".split("").map((c) => c.charCodeAt(0));
    const bytes = [0, 0, 0, 24, ...ftyp, ...new Array<number>(16).fill(0)];
    expect(detectContainerKind(head(bytes))).toBe("isobmff");
  });

  it("EBML マジックから webm/matroska を判定する", () => {
    const bytes = [0x1a, 0x45, 0xdf, 0xa3, ...new Array<number>(20).fill(0)];
    expect(detectContainerKind(head(bytes))).toBe("webm");
  });

  it("188 バイト周期の同期バイトから mpegts を判定する", () => {
    const bytes = new Array<number>(512).fill(0);
    bytes[0] = 0x47;
    bytes[188] = 0x47;
    bytes[376] = 0x47;
    expect(detectContainerKind(head(bytes))).toBe("mpegts");
  });

  it("RIFF/AVI ヘッダから avi を判定する", () => {
    const riffAvi = "RIFF\x00\x00\x00\x00AVI LIST"
      .split("")
      .map((c) => c.charCodeAt(0));
    expect(detectContainerKind(head(riffAvi))).toBe("avi");
  });

  it("FLV ヘッダから flv を判定する", () => {
    const flv = "FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00"
      .split("")
      .map((c) => c.charCodeAt(0));
    expect(detectContainerKind(head(flv))).toBe("flv");
  });

  it("ftyp を持たない古い QuickTime (.mov) の moov ボックスも isobmff と判定する", () => {
    const moov = "moov".split("").map((c) => c.charCodeAt(0));
    const bytes = [0, 0, 0, 8, ...moov, ...new Array<number>(16).fill(0)];
    expect(detectContainerKind(head(bytes))).toBe("isobmff");
  });

  it("判別できない入力は unknown を返す", () => {
    expect(detectContainerKind(head([1, 2, 3]))).toBe("unknown");
    expect(
      detectContainerKind(head(new Array<number>(512).fill(0xab))),
    ).toBe("unknown");
  });
});

describe("expectedKindForExtension", () => {
  it.each([
    [".mp4", "isobmff"],
    [".m4v", "isobmff"],
    [".mov", "isobmff"],
    [".webm", "webm"],
    [".mkv", "webm"],
    [".ts", "mpegts"],
    [".mts", "mpegts"],
    [".avi", "avi"],
    [".flv", "flv"],
  ] as const)("%s の期待種別は %s", (ext, kind) => {
    expect(expectedKindForExtension(ext)).toBe(kind);
  });

  it("大文字でも判定できる", () => {
    expect(expectedKindForExtension(".MP4")).toBe("isobmff");
  });

  it("未知の拡張子は null", () => {
    expect(expectedKindForExtension(".xyz")).toBeNull();
  });
});

describe("classifyContainer", () => {
  it("中身が MPEG-TS の .mp4 は不一致かつ内蔵再生不可", () => {
    const verdict = classifyContainer("mpegts", ".mp4");
    expect(verdict.nativePlayable).toBe(false);
    expect(verdict.extensionMismatch).toBe(true);
  });

  it("中身が ISOBMFF の .mp4 は一致かつ再生可能", () => {
    const verdict = classifyContainer("isobmff", ".mp4");
    expect(verdict.nativePlayable).toBe(true);
    expect(verdict.extensionMismatch).toBe(false);
  });

  it("中身が WebM の .mkv は一致かつ再生可能", () => {
    const verdict = classifyContainer("webm", ".mkv");
    expect(verdict.nativePlayable).toBe(true);
    expect(verdict.extensionMismatch).toBe(false);
  });

  it("unknown は不一致扱いにしない", () => {
    const verdict = classifyContainer("unknown", ".mp4");
    expect(verdict.extensionMismatch).toBe(false);
  });
});

describe("containerLabel", () => {
  it.each([
    ["isobmff", "MP4 (ISOBMFF)"],
    ["webm", "WebM/Matroska"],
    ["mpegts", "MPEG-TS"],
    ["avi", "AVI"],
    ["flv", "FLV"],
    ["unknown", "不明"],
  ] as const)("%s のラベルは %s", (kind, label) => {
    expect(containerLabel(kind)).toBe(label);
  });
});
