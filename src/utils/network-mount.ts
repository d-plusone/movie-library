/**
 * ネットワークマウント（SMB / NFS / AFP など）の判定ヘルパー。
 *
 * NAS（SMB 共有）を登録している場合、macOS 側の都合（スリープ復帰・ネットワーク切替・
 * サーバー側のアイドル切断）で共有が勝手にアンマウントされることがある。
 * アンマウントされると「ディレクトリが本当に削除された」場合と同じエラー（ENOENT）に
 * 見えるため、単純な存在チェックだけでは誤って登録を消してしまう。
 *
 * ここでは
 * - `mount` 出力からネットワークマウントと再マウント用の SMB URL を取り出す
 * - ファイルシステムエラーが「削除された」と断定できるものか（ENOENT か）を判定する
 * ための純粋関数を提供する。
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface MountEntry {
  /** マウント元（例: //user@server/share, /dev/disk3s1s1） */
  source: string;
  /** マウントポイント（例: /Volumes/share） */
  mountPoint: string;
  /** ファイルシステム種別（例: smbfs, apfs） */
  fsType: string;
}

/** パスの状態: present=存在, missing=存在しないと断定, unknown=一時的なエラーで不明 */
export type PathState = "present" | "missing" | "unknown";

/** ネットワーク越しのファイルシステム種別 */
const NETWORK_FS_TYPES = new Set([
  "smbfs",
  "cifs",
  "nfs",
  "afpfs",
  "webdav",
  "ftp",
]);

/**
 * `mount` コマンドの出力を解析する。
 *
 * 例:
 *   //user@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by iku)
 *   map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
 *
 * マウント元・マウントポイントのどちらにも空白が入り得るため、
 * 最後の " (" をオプション開始位置、その直前の最後の " on " を区切りとして扱う。
 */
export function parseMountOutput(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const optionsStart = line.lastIndexOf(" (");
    if (optionsStart === -1) {
      continue;
    }
    const head = line.slice(0, optionsStart);
    const separatorIndex = head.lastIndexOf(" on ");
    if (separatorIndex === -1) {
      continue;
    }
    const options = line
      .slice(optionsStart + 2, line.endsWith(")") ? -1 : undefined)
      .split(",")
      .map((option) => option.trim());
    entries.push({
      source: head.slice(0, separatorIndex),
      mountPoint: head.slice(separatorIndex + 4),
      fsType: options[0] ?? "",
    });
  }
  return entries;
}

/** trim 済みの文字列同士で path が dir 配下（dir 自身を含む）か判定する */
export function isPathUnderDirectory(filePath: string, dir: string): boolean {
  const normalizedDir = dir.replace(/[/\\]+$/, "");
  return (
    filePath === normalizedDir ||
    filePath.startsWith(`${normalizedDir}/`) ||
    filePath.startsWith(`${normalizedDir}\\`)
  );
}

/** filePath を含むマウントのうち、最も深いマウントポイントのものを返す */
export function findMountForPath(
  filePath: string,
  entries: MountEntry[],
): MountEntry | null {
  let best: MountEntry | null = null;
  for (const entry of entries) {
    if (!isPathUnderDirectory(filePath, entry.mountPoint)) {
      continue;
    }
    if (best === null || entry.mountPoint.length > best.mountPoint.length) {
      best = entry;
    }
  }
  return best;
}

/** ネットワーク越しのマウントかどうか */
export function isNetworkMount(entry: MountEntry | null): boolean {
  return entry !== null && NETWORK_FS_TYPES.has(entry.fsType.toLowerCase());
}

/**
 * `//user@server/share` 形式のマウント元を `smb://user@server/share` に変換する。
 * SMB 以外、または変換できない形式の場合は null。
 */
export function smbUrlFromSource(entry: MountEntry | null): string | null {
  if (entry === null || entry.fsType.toLowerCase() !== "smbfs") {
    return null;
  }
  if (!entry.source.startsWith("//")) {
    return null;
  }
  // URL として扱えない文字をエスケープする（認証情報の区切り ; や @ は維持）
  const escaped = escapeUrlComponent(entry.source.slice(2));
  return `smb://${escaped}`;
}

/** URL 内で問題になる文字のみをパーセントエンコードする */
function escapeUrlComponent(value: string): string {
  return value.replace(/[ %#?&+]/g, (character) => {
    const code = character.charCodeAt(0);
    return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

/** エラーから errno コードを取り出す */
export function fsErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * 「もう存在しない」と断定できるエラーかどうか。
 * ENOENT 以外（ETIMEDOUT / ENOTCONN / EIO / EACCES など）は
 * 一時的な切断や権限問題の可能性があるため、削除判定には使わない。
 */
export function isNotExistError(error: unknown): boolean {
  return fsErrorCode(error) === "ENOENT";
}

/** ネットワーク切断・一時的な I/O エラーでよく現れるコードかどうか（ログ・表示用） */
const TRANSIENT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ENOTCONN",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ESTALE",
  "EIO",
  "ENXIO",
  "ENODEV",
  "EAGAIN",
  "EINTR",
  "EBUSY",
]);

export function isTransientFsError(error: unknown): boolean {
  const code = fsErrorCode(error);
  return code !== undefined && TRANSIENT_ERROR_CODES.has(code);
}

export interface MissingPathContext {
  /** 対象パスが登録ディレクトリ配下か */
  hasRegisteredOwner: boolean;
  /** 対象パス自身が登録ディレクトリ（監視ルート）か */
  isRegisteredDirectoryItself: boolean;
  /** 所属する登録ディレクトリへアクセスできるか */
  ownerAccessible: boolean;
  /**
   * 以前 SMB だったマウントポイントが現在のマウント一覧に無いか。
   * アンマウント後もマウントポイントが空ディレクトリとして残るケースでは
   * 「ディレクトリは見えるが中身が無い」ように見えるため、この判定が必要。
   */
  recordedNetworkMountMissing: boolean;
}

/**
 * ENOENT（存在しない）が返ったパスを「本当に削除された」か
 * 「接続が切れているだけ」かに分類する。
 *
 * - 登録ディレクトリ配下でない / 監視ルート自身 / 以前の SMB マウントが消えている
 *   → 切断の可能性があるため "unknown"（削除しない）
 * - 所属ディレクトリへアクセスでき、SMB マウントの消失も無い
 *   → "missing"（本当に削除された）
 */
export function classifyMissingPath(context: MissingPathContext): PathState {
  if (!context.hasRegisteredOwner) {
    return "unknown";
  }
  if (context.isRegisteredDirectoryItself) {
    return "unknown";
  }
  if (context.recordedNetworkMountMissing) {
    return "unknown";
  }
  return context.ownerAccessible ? "missing" : "unknown";
}

/**
 * 現在のマウント一覧を取得する（macOS / Linux のみ。Windows は空配列）。
 * GUI 起動時は PATH が限られることがあるため絶対パスを優先する。
 */
export async function readMountEntries(): Promise<MountEntry[]> {
  if (process.platform === "win32") {
    return [];
  }
  const candidates =
    process.platform === "darwin"
      ? ["/sbin/mount", "/usr/sbin/mount", "mount"]
      : ["/bin/mount", "/usr/bin/mount", "mount"];

  for (const command of candidates) {
    try {
      const { stdout } = await execFileAsync(command, [], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      return parseMountOutput(stdout);
    } catch (error) {
      if (fsErrorCode(error) !== "ENOENT") {
        // 実行はできたが失敗した場合は、他のパスを試しても同じ結果になる
        return [];
      }
    }
  }
  return [];
}
