import { describe, expect, it } from "vitest";
import {
  classifyMissingPath,
  findMountForPath,
  fsErrorCode,
  isNetworkMount,
  isNotExistError,
  isPathUnderDirectory,
  isTransientFsError,
  parseMountOutput,
  smbUrlFromSource,
} from "../src/utils/network-mount";

describe("parseMountOutput", () => {
  it("SMB マウントを解析する", () => {
    const entries = parseMountOutput(
      "//user@server/media on /Volumes/media (smbfs, nodev, nosuid, mounted by iku)",
    );
    expect(entries).toEqual([
      {
        source: "//user@server/media",
        mountPoint: "/Volumes/media",
        fsType: "smbfs",
      },
    ]);
  });

  it("マウントポイントの空白・複数行を扱える", () => {
    const entries = parseMountOutput(
      [
        "/dev/disk5s1 on /Volumes/ChatGPT Installer (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by iku)",
        "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
        "",
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.mountPoint).toBe("/Volumes/ChatGPT Installer");
    expect(entries[0]?.fsType).toBe("hfs");
    expect(entries[1]?.source).toBe("map auto_home");
    expect(entries[1]?.mountPoint).toBe("/System/Volumes/Data/home");
  });

  it("区切りの無い行は無視する", () => {
    expect(parseMountOutput("garbage line")).toEqual([]);
  });
});

describe("findMountForPath", () => {
  const entries = parseMountOutput(
    [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "//user@server/media on /Volumes/media (smbfs, nodev, nosuid)",
      "//user@server/media on /Volumes/media/Movies (smbfs, nodev, nosuid)",
    ].join("\n"),
  );

  it("最も深いマウントポイントを返す", () => {
    expect(findMountForPath("/Volumes/media/Movies/a.mkv", entries)?.mountPoint).toBe(
      "/Volumes/media/Movies",
    );
  });

  it("マウント外のパスは null", () => {
    expect(findMountForPath("/Users/iku/movie.mkv", entries)?.mountPoint).toBe("/");
  });

  it("マウントポイント自身も対象になる", () => {
    expect(findMountForPath("/Volumes/media", entries)?.mountPoint).toBe(
      "/Volumes/media",
    );
  });
});

describe("isPathUnderDirectory", () => {
  it("自身・配下・末尾セパレータを正規化して判定する", () => {
    expect(isPathUnderDirectory("/Volumes/media", "/Volumes/media/")).toBe(true);
    expect(isPathUnderDirectory("/Volumes/media/a.mkv", "/Volumes/media")).toBe(
      true,
    );
    expect(isPathUnderDirectory("/Volumes/media2/a.mkv", "/Volumes/media")).toBe(
      false,
    );
  });
});

describe("isNetworkMount / smbUrlFromSource", () => {
  it("SMB はネットワークマウントとして SMB URL に変換する", () => {
    const entries = parseMountOutput(
      "//user@server/My Share on /Volumes/My Share (smbfs, nodev)",
    );
    const mount = entries[0] ?? null;
    expect(isNetworkMount(mount)).toBe(true);
    expect(smbUrlFromSource(mount)).toBe("smb://user@server/My%20Share");
  });

  it("記号を含む共有名をエスケープする", () => {
    const mount = {
      source: "//user@server/A% B&?#++C",
      mountPoint: "/Volumes/Share",
      fsType: "smbfs",
    };
    expect(smbUrlFromSource(mount)).toBe(
      "smb://user@server/A%25%20B%26%3F%23%2B%2BC",
    );
  });

  it("NFS / AFP はネットワークマウントだが SMB URL には変換しない", () => {
    const entries = parseMountOutput(
      [
        "server:/export/media on /Volumes/media (nfs, nodev, nosuid)",
        "afp_server on /Volumes/afp (afpfs, nodev)",
      ].join("\n"),
    );
    expect(isNetworkMount(entries[0] ?? null)).toBe(true);
    expect(smbUrlFromSource(entries[0] ?? null)).toBeNull();
    expect(isNetworkMount(entries[1] ?? null)).toBe(true);
  });

  it("ローカルボリュームはネットワークマウントではない", () => {
    const entries = parseMountOutput(
      "/dev/disk4s1 on /Volumes/HDD (exfat, local, noowners, noatime, fskit)",
    );
    const mount = entries[0] ?? null;
    expect(isNetworkMount(mount)).toBe(false);
    expect(smbUrlFromSource(mount)).toBeNull();
  });

  it("// で始まらない SMB は変換しない", () => {
    expect(
      smbUrlFromSource({
        source: "server/share",
        mountPoint: "/Volumes/share",
        fsType: "smbfs",
      }),
    ).toBeNull();
  });
});

describe("classifyMissingPath", () => {
  it("マウントが生きていれば本当の削除と判定する", () => {
    expect(
      classifyMissingPath({
        hasRegisteredOwner: true,
        isRegisteredDirectoryItself: false,
        ownerAccessible: true,
        recordedNetworkMountMissing: false,
      }),
    ).toBe("missing");
  });

  it("以前の SMB マウントが消えていれば削除と断定しない", () => {
    // アンマウント後もマウントポイントが空ディレクトリとして残るケース
    expect(
      classifyMissingPath({
        hasRegisteredOwner: true,
        isRegisteredDirectoryItself: false,
        ownerAccessible: true,
        recordedNetworkMountMissing: true,
      }),
    ).toBe("unknown");
  });

  it("監視ルート自身が消えた場合は削除と断定しない", () => {
    expect(
      classifyMissingPath({
        hasRegisteredOwner: true,
        isRegisteredDirectoryItself: true,
        ownerAccessible: false,
        recordedNetworkMountMissing: false,
      }),
    ).toBe("unknown");
  });

  it("所属ディレクトリにアクセスできなければ削除と断定しない", () => {
    expect(
      classifyMissingPath({
        hasRegisteredOwner: true,
        isRegisteredDirectoryItself: false,
        ownerAccessible: false,
        recordedNetworkMountMissing: false,
      }),
    ).toBe("unknown");
  });

  it("登録ディレクトリ外は削除と断定しない", () => {
    expect(
      classifyMissingPath({
        hasRegisteredOwner: false,
        isRegisteredDirectoryItself: false,
        ownerAccessible: true,
        recordedNetworkMountMissing: false,
      }),
    ).toBe("unknown");
  });
});

describe("エラー判定", () => {
  it("ENOENT のみ「存在しない」と断定する", () => {
    expect(isNotExistError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      true,
    );
    expect(isNotExistError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(
      false,
    );
    expect(isNotExistError(new Error("x"))).toBe(false);
  });

  it("ネットワーク系のエラーを一時エラーとして扱う", () => {
    expect(isTransientFsError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(
      true,
    );
    expect(
      isTransientFsError(Object.assign(new Error("x"), { code: "ENOTCONN" })),
    ).toBe(true);
    expect(isTransientFsError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      false,
    );
  });

  it("errno コードを取り出せる", () => {
    expect(fsErrorCode(Object.assign(new Error("x"), { code: "EIO" }))).toBe("EIO");
    expect(fsErrorCode(new Error("x"))).toBeUndefined();
  });
});
