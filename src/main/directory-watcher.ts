import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { app, type BrowserWindow } from "electron";
import * as chokidar from "chokidar";
import PrismaDatabaseManager from "../database/PrismaDatabaseManager.js";
import VideoScanner from "../scanner/VideoScanner.js";
import type { ProcessedVideo, ProgressEvent, DirectoryAvailability, DirectoryStatus } from "../types/types.js";
import { createLogger } from "../utils/logger.js";
import {
  classifyMissingPath,
  findMountForPath,
  fsErrorCode,
  isNetworkMount,
  isNotExistError,
  isPathUnderDirectory,
  isTransientFsError,
  readMountEntries,
  smbUrlFromSource,
  type MountEntry,
  type PathState,
} from "../utils/network-mount.js";

const logger = createLogger(app.isPackaged);
const execFileAsync = promisify(execFile);
const MISSING_CONFIRM_DELAYS_MS = [3000, 10000, 30000] as const;
const RECONNECT_DELAYS_MS = [3000, 10000, 30000, 60000] as const;
const LOCAL_MISSING_CONFIRM_DELAYS_MS = [3000] as const;
const MAX_CONSECUTIVE_MOUNT_ATTEMPTS = 3;
const FS_CHECK_TIMEOUT_MS = 10000;
const MOUNT_WAIT_MS = 20000;
const NETWORK_HEALTH_CHECK_INTERVAL_MS = 60000;

type ProgressChannel = "scan-progress" | "rescan-progress" | "thumbnail-progress";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out after " + timeoutMs)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export default class DirectoryWatcher {
  private readonly db: PrismaDatabaseManager;
  private readonly videoScanner: VideoScanner;
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly sendProgress: (channel: ProgressChannel, payload: ProgressEvent) => void;
  private readonly generateThumbnailsForSingleVideo: (video: ProcessedVideo) => Promise<boolean>;
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  public readonly directoryAvailability: Map<string, DirectoryAvailability> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectRunning: Set<string> = new Set();
  private reconnectAttempts: Map<string, number> = new Map();
  private networkMountUrls: Map<string, string> = new Map();
  private networkMountUrlsLoaded = false;
  private mountEntriesCache: { at: number; entries: MountEntry[] } | null = null;
  private registeredDirectoriesCache: { at: number; paths: string[] } | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private healthCheckRunning = false;

  constructor(options: {
    db: PrismaDatabaseManager;
    videoScanner: VideoScanner;
    getMainWindow: () => BrowserWindow | null;
    sendProgress: (channel: ProgressChannel, payload: ProgressEvent) => void;
    generateThumbnailsForSingleVideo: (video: ProcessedVideo) => Promise<boolean>;
  }) {
    this.db = options.db;
    this.videoScanner = options.videoScanner;
    this.getMainWindow = options.getMainWindow;
    this.sendProgress = options.sendProgress;
    this.generateThumbnailsForSingleVideo = options.generateThumbnailsForSingleVideo;
  }

  private get mainWindow(): BrowserWindow | null {
    return this.getMainWindow();
  }
  // ディレクトリの可用性判定と再接続（NAS / SMB 切断対策）
  // ============================================================

  /** タイムアウト付きでディレクトリへアクセスできるか確認する */
  public async isDirectoryAccessible(dirPath: string): Promise<boolean> {
    try {
      await withTimeout(fs.access(dirPath), FS_CHECK_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * パスが「本当に存在しない」と確認できるか調べる。
   * 登録ディレクトリ（マウント）が生きていれば、パスが無いのは本当の削除。
   * マウントごと見えなくなっている場合（アンマウント後にマウントポイントだけが
   * 残るケースを含む）は切断と区別が付かないため「不明」として扱う。
   */
  private async checkPathState(targetPath: string): Promise<PathState> {
    try {
      await withTimeout(fs.access(targetPath), FS_CHECK_TIMEOUT_MS);
      return "present";
    } catch (error) {
      if (!isNotExistError(error)) {
        if (isTransientFsError(error)) {
          // 切断中は多数のパスで発生し得るため、通常のデバッグログに留める
          logger.debug(
            `Transient I/O error while checking (${fsErrorCode(error)}):`,
            targetPath,
          );
        } else {
          logger.debug(
            `Path check failed, deferring removal (${fsErrorCode(error) ?? "unknown"}):`,
            targetPath,
          );
        }
        return "unknown";
      }
    }

    // ENOENT: 所属する登録ディレクトリ（＝マウント）が生きているかを確認する
    const owner = await this.findRegisteredDirectoryOwner(targetPath);
    if (owner === null) {
      logger.debug("Path is outside registered directories:", targetPath);
      return "unknown";
    }
    const recordedNetworkMountMissing =
      await this.isRecordedNetworkMountMissing(owner);
    const ownerAccessible = recordedNetworkMountMissing
      ? false
      : await this.isDirectoryAccessible(owner);
    return classifyMissingPath({
      hasRegisteredOwner: true,
      isRegisteredDirectoryItself: owner === targetPath,
      ownerAccessible,
      recordedNetworkMountMissing,
    });
  }

  /**
   * 以前 SMB マウントだったマウントポイントが、現在のマウント一覧に存在しないか。
   * アンマウント後も空ディレクトリが残るケースで「アクセスできる＝生きている」と
   * 誤判定しないための確認。
   */
  private async isRecordedNetworkMountMissing(
    targetPath: string,
  ): Promise<boolean> {
    await this.loadNetworkMountUrls();
    if (this.networkMountUrls.size === 0) {
      return false;
    }
    let recordedMountPoint: string | null = null;
    for (const mountPoint of this.networkMountUrls.keys()) {
      if (!isPathUnderDirectory(targetPath, mountPoint)) {
        continue;
      }
      if (
        recordedMountPoint === null ||
        mountPoint.length > recordedMountPoint.length
      ) {
        recordedMountPoint = mountPoint;
      }
    }
    if (recordedMountPoint === null) {
      return false;
    }
    const entries = await this.getMountEntries();
    return !entries.some((entry) => entry.mountPoint === recordedMountPoint);
  }

  /** ディレクトリが利用可能か（アクセス可能かつ、以前の SMB マウントが消えていない） */
  public async isDirectoryAvailable(dirPath: string): Promise<boolean> {
    if (await this.isRecordedNetworkMountMissing(dirPath)) {
      return false;
    }
    return await this.isDirectoryAccessible(dirPath);
  }

  /**
   * 削除と断定する前に再確認する。
   * NAS（ネットワークマウント）配下や状態不明の場合は 3秒 / 10秒 / 30秒と長めに確認し、
   * ローカルパスで明確に存在しない場合は短い確認に留める。
   * 1度でも存在が確認できれば "present"、最後まで不明なら "unknown"。
   */
  private async confirmRemoval(targetPath: string): Promise<PathState> {
    let state = await this.checkPathState(targetPath);
    const isNetworkPath =
      state === "unknown" || (await this.isUnderNetworkMount(targetPath));
    const waitMsList = isNetworkPath
      ? MISSING_CONFIRM_DELAYS_MS
      : LOCAL_MISSING_CONFIRM_DELAYS_MS;

    for (const waitMs of waitMsList) {
      if (state === "present") {
        return "present";
      }
      await delay(waitMs);
      state = await this.checkPathState(targetPath);
    }
    return state;
  }

  /** パスがネットワークマウント（NAS など）の配下かどうか */
  private async isUnderNetworkMount(targetPath: string): Promise<boolean> {
    const mount = findMountForPath(targetPath, await this.getMountEntries());
    return isNetworkMount(mount);
  }

  public setDirectoryAvailability(
    dirPath: string,
    status: DirectoryAvailability,
  ): void {
    const previous = this.directoryAvailability.get(dirPath);
    if (previous === status) {
      return;
    }
    this.directoryAvailability.set(dirPath, status);
    const payload: DirectoryStatus = {
      path: dirPath,
      status,
      previousStatus: previous,
    };
    this.mainWindow?.webContents.send("directory-status-changed", payload);
    logger.log(`Directory ${status}:`, dirPath);
  }

  /** マウント一覧を取得する（短時間はキャッシュする） */
  private async getMountEntries(force = false): Promise<MountEntry[]> {
    const now = Date.now();
    if (
      !force &&
      this.mountEntriesCache !== null &&
      now - this.mountEntriesCache.at < 5000
    ) {
      return this.mountEntriesCache.entries;
    }
    const entries = await readMountEntries();
    this.mountEntriesCache = { at: now, entries };
    return entries;
  }

  private networkMountInfoPath(): string {
    return path.join(app.getPath("userData"), "network-mounts.json");
  }

  /** 再マウント用の SMB URL をファイルから読み込む */
  private async loadNetworkMountUrls(): Promise<void> {
    if (this.networkMountUrlsLoaded) {
      return;
    }
    try {
      const raw = await fs.readFile(this.networkMountInfoPath(), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        for (const [mountPoint, url] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof url === "string" && url.startsWith("smb://")) {
            this.networkMountUrls.set(mountPoint, url);
          }
        }
      }
      this.networkMountUrlsLoaded = true;
    } catch (error) {
      if (isNotExistError(error)) {
        // まだ記録ファイルが無いだけ
        this.networkMountUrlsLoaded = true;
        return;
      }
      // 破損・権限エラー時は次回また読み込む（空の内容で上書きしない）
      logger.debug("Failed to load network mount info:", error);
    }
  }

  private async saveNetworkMountUrls(): Promise<void> {
    try {
      const filePath = this.networkMountInfoPath();
      // 読み込みに失敗した場合に備え、既存ファイルの内容とマージしてから保存する
      const merged: Record<string, string> = {};
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") {
          for (const [mountPoint, url] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (typeof url === "string") {
              merged[mountPoint] = url;
            }
          }
        }
      } catch {
        // 既存ファイルが無い・壊れている場合はメモリ上の内容のみ保存する
      }
      for (const [mountPoint, url] of this.networkMountUrls) {
        merged[mountPoint] = url;
      }

      // 書き込み途中のクラッシュで既存の記録を壊さないよう一時ファイル経由で置き換える
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.debug("Failed to save network mount info:", error);
    }
  }

  /**
   * アクセスできたタイミングで、所属する SMB 共有の URL を記録しておく。
   * 切断後に再マウントするには、接続中のうちに情報を残しておく必要がある。
   */
  public async rememberNetworkMount(dirPath: string): Promise<void> {
    await this.loadNetworkMountUrls();
    const mount = findMountForPath(dirPath, await this.getMountEntries());
    const url = smbUrlFromSource(mount);
    if (mount === null || url === null) {
      return;
    }
    if (this.networkMountUrls.get(mount.mountPoint) === url) {
      return;
    }
    this.networkMountUrls.set(mount.mountPoint, url);
    await this.saveNetworkMountUrls();
    logger.debug(
      `Recorded SMB mount for remount: ${mount.mountPoint} -> ${url}`,
    );
  }

  /** 登録ディレクトリに紐づく SMB URL を探す（最も深いマウントポイントを優先） */
  private findRemountUrl(dirPath: string): string | null {
    let bestMountPoint: string | null = null;
    let bestUrl: string | null = null;
    for (const [mountPoint, url] of this.networkMountUrls) {
      if (!isPathUnderDirectory(dirPath, mountPoint)) {
        continue;
      }
      if (bestMountPoint === null || mountPoint.length > bestMountPoint.length) {
        bestMountPoint = mountPoint;
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  /**
   * アンマウントされた SMB 共有を再マウントする。
   * Finder 経由（osascript → 失敗時は open）で行うため、Keychain に保存済みの
   * 認証情報がそのまま使われる。未保存の場合は Finder が入力を求める。
   */
  private async attemptRemount(dirPath: string): Promise<boolean> {
    if (process.platform !== "darwin") {
      return false;
    }
    const entries = await this.getMountEntries(true);

    await this.loadNetworkMountUrls();
    const url = this.findRemountUrl(dirPath);
    if (url === null) {
      logger.debug(
        "No SMB URL recorded for directory; cannot remount automatically:",
        dirPath,
      );
      return false;
    }

    // 共有自体が（別のマウントポイントでも）マウント済みなら再マウントは不要
    const mountedEntry = entries.find(
      (entry) => smbUrlFromSource(entry) === url,
    );
    if (mountedEntry !== undefined) {
      logger.debug(
        "SMB share is already mounted; skipping remount:",
        mountedEntry.mountPoint,
      );
      return false;
    }

    logger.log(`Attempting to remount ${url} for ${dirPath}`);
    const script = `mount volume ${JSON.stringify(url)}`;
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", script], {
        timeout: MOUNT_WAIT_MS,
      });
    } catch (error) {
      logger.debug(
        "osascript mount volume failed, falling back to open:",
        fsErrorCode(error) ?? error,
      );
      try {
        await execFileAsync("/usr/bin/open", [url], { timeout: 15000 });
      } catch (openError) {
        console.error("Failed to remount SMB share:", url, openError);
        return false;
      }
    }

    // マウント完了を待つ（完了前に fs.access すると失敗するため）
    const deadline = Date.now() + MOUNT_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.isDirectoryAvailable(dirPath)) {
        return true;
      }
      await delay(1000);
    }
    return false;
  }

  private clearReconnectTimer(dirPath: string): void {
    const timer = this.reconnectTimers.get(dirPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(dirPath);
    }
  }

  private scheduleReconnect(dirPath: string, delayMs: number): void {
    this.clearReconnectTimer(dirPath);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(dirPath);
      void this.tryReconnect(dirPath);
    }, delayMs);
    timer.unref();
    this.reconnectTimers.set(dirPath, timer);
  }

  /**
   * ディレクトリが見えなくなったときの共通処理。
   * 登録は削除せず、オフラインとして保持したうえで再接続（必要なら再マウント）を試みる。
   */
  public async handleDirectoryUnavailable(
    dirPath: string,
    reason: string,
  ): Promise<void> {
    // 見えていないパスを watch し続けても意味がないため一旦止める（復帰時に張り直す）
    this.stopWatching(dirPath);
    this.setDirectoryAvailability(dirPath, "offline");

    if (
      this.reconnectTimers.has(dirPath) ||
      this.reconnectRunning.has(dirPath)
    ) {
      return; // すでに再接続待ち・再接続処理中
    }
    logger.log(`Directory unavailable (${reason}):`, dirPath);
    this.reconnectAttempts.set(dirPath, 0);
    this.scheduleReconnect(dirPath, RECONNECT_DELAYS_MS[0]);
  }

  /** オフラインから復帰したときの処理 */
  private async markDirectoryOnline(dirPath: string): Promise<void> {
    if (!(await this.isDirectoryRegistered(dirPath))) {
      // ユーザーが登録解除した後に復帰した場合は何もしない
      this.forgetDirectory(dirPath);
      return;
    }
    this.clearReconnectTimer(dirPath);
    this.reconnectAttempts.delete(dirPath);
    this.setDirectoryAvailability(dirPath, "online");
    if (!this.watchers.has(dirPath)) {
      this.startWatching(dirPath);
    }
    await this.rememberNetworkMount(dirPath);
  }

  /** 再接続を試みる（成功するまで間隔を空けて繰り返す） */
  private async tryReconnect(dirPath: string): Promise<void> {
    if (this.reconnectRunning.has(dirPath)) {
      return;
    }
    this.reconnectRunning.add(dirPath);
    try {
      if (!(await this.isDirectoryRegistered(dirPath))) {
        this.forgetDirectory(dirPath);
        return;
      }

      const attempt = (this.reconnectAttempts.get(dirPath) ?? 0) + 1;
      this.reconnectAttempts.set(dirPath, attempt);

      if (await this.isDirectoryAvailable(dirPath)) {
        await this.markDirectoryOnline(dirPath);
        logger.log(`Directory reconnected (attempt ${attempt}):`, dirPath);
        return;
      }

      if (attempt <= MAX_CONSECUTIVE_MOUNT_ATTEMPTS || attempt % 10 === 0) {
        if (await this.attemptRemount(dirPath)) {
          await this.markDirectoryOnline(dirPath);
          logger.log("Directory remounted and reconnected:", dirPath);
          return;
        }
      }

      // 実行中にユーザーが登録解除した場合はチェーンを止める
      if (!(await this.isDirectoryRegistered(dirPath))) {
        this.forgetDirectory(dirPath);
        return;
      }
      const index = Math.min(attempt, RECONNECT_DELAYS_MS.length - 1);
      this.scheduleReconnect(dirPath, RECONNECT_DELAYS_MS[index]);
    } finally {
      this.reconnectRunning.delete(dirPath);
    }
  }

  /** ディレクトリが DB に登録されているか */
  private async isDirectoryRegistered(dirPath: string): Promise<boolean> {
    const directories = await this.db.getDirectories();
    return directories.some((directory) => directory.path === dirPath);
  }

  /** 登録解除されたディレクトリの状態を破棄する */
  public forgetDirectory(dirPath: string): void {
    this.clearReconnectTimer(dirPath);
    this.reconnectAttempts.delete(dirPath);
    this.directoryAvailability.delete(dirPath);
  }

  /**
   * 起動直後などで状態が未確定のディレクトリを確認し、結果をイベントで通知する。
   * （起動時の一括チェックが終わる前に描画側が状態を取得した場合の保険）
   */
  public async probeDirectoryAvailability(dirPath: string): Promise<void> {
    if (this.directoryAvailability.has(dirPath)) {
      return;
    }
    if (await this.isDirectoryAvailable(dirPath)) {
      this.setDirectoryAvailability(dirPath, "online");
      return;
    }
    await this.handleDirectoryUnavailable(dirPath, "initial check failed");
  }

  /**
   * ファイルが読めない原因がディレクトリ（マウント）自体の消失かどうかを確認し、
   * 該当する場合は所属ディレクトリをオフライン扱いにして再接続を開始する。
   */
  private async handleUnreachablePath(targetPath: string): Promise<void> {
    const owner = await this.findRegisteredDirectoryOwner(targetPath);
    if (owner === null) {
      return;
    }
    if (this.directoryAvailability.get(owner) === "offline") {
      // すでにオフライン処理済み（切断時に多数の unlink が来ても二重処理しない）
      return;
    }
    if (await this.isDirectoryAvailable(owner)) {
      // ディレクトリ自体は利用可能 → 個別ファイルの問題なので登録には触れない
      return;
    }
    await this.handleDirectoryUnavailable(
      owner,
      "contained path became unreachable",
    );
  }

  /** パスを含む登録ディレクトリを返す（最も深いものを優先） */
  private async findRegisteredDirectoryOwner(
    targetPath: string,
  ): Promise<string | null> {
    const paths = await this.getRegisteredDirectoryPaths();
    let owner: string | null = null;
    for (const dirPath of paths) {
      if (!isPathUnderDirectory(targetPath, dirPath)) {
        continue;
      }
      if (owner === null || dirPath.length > owner.length) {
        owner = dirPath;
      }
    }
    return owner;
  }

  /** 登録ディレクトリのパス一覧（短時間キャッシュ。切断時の大量イベント対策） */
  private async getRegisteredDirectoryPaths(): Promise<string[]> {
    const now = Date.now();
    if (
      this.registeredDirectoriesCache !== null &&
      now - this.registeredDirectoriesCache.at < 5000
    ) {
      return this.registeredDirectoriesCache.paths;
    }
    const directories = await this.db.getDirectories();
    const paths = directories.map((directory) => directory.path);
    this.registeredDirectoriesCache = { at: now, paths };
    return paths;
  }

  public invalidateRegisteredDirectoriesCache(): void {
    this.registeredDirectoriesCache = null;
  }

  /**
   * ネットワークマウントの定期チェックを開始する。
   * 共有が stale になった場合、ファイル監視イベントが来ないまま
   * 「接続できているように見える」状態が続くことがあるため、能動的に確認する。
   */
  private startNetworkHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      void this.checkNetworkDirectoriesHealth();
    }, NETWORK_HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckTimer.unref();
  }

  private async checkNetworkDirectoriesHealth(): Promise<void> {
    if (this.healthCheckRunning) {
      return;
    }
    this.healthCheckRunning = true;
    try {
      const directories = await this.getRegisteredDirectoryPaths();
      for (const dirPath of directories) {
        if (this.directoryAvailability.get(dirPath) !== "online") {
          continue; // オフライン中のディレクトリは再接続処理側で確認している
        }
        if (!(await this.isUnderNetworkMount(dirPath))) {
          continue; // ローカルディスクは対象外
        }
        if (await this.isDirectoryAvailable(dirPath)) {
          continue;
        }
        await this.handleDirectoryUnavailable(
          dirPath,
          "periodic health check failed",
        );
      }
    } finally {
      this.healthCheckRunning = false;
    }
  }

  startWatching(directoryPath: string): void {
    if (this.watchers.has(directoryPath)) {
      return;
    }

    logger.debug("Starting to watch directory:", directoryPath);

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on("add", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          logger.debug("Processing new video file:", filePath);

          // プログレス通知を送信（トーストは追加完了時にまとめて出す）
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `新しい動画を処理中: ${path.basename(filePath)}`,
            silent: true,
          });

          const video = await this.videoScanner.processFile(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-added", filePath);
          }

          // 追加処理の完了。完了イベントが無いと進捗表示にエントリが残留する
          this.sendProgress("scan-progress", {
            kind: "done",
            message: video
              ? `新しい動画が追加されました: ${path.basename(filePath)}`
              : "新しい動画は追加されませんでした",
            type: video ? "success" : "info",
            silent: video === null,
          });

          // 新しく追加された動画で、サムネイル生成が必要な場合のみ実行
          if (video && video.needsThumbnails) {
            logger.debug(
              "Auto-generating thumbnails for new video:",
              video.path,
            );

            // サムネイル生成の進捗通知（トーストは完了時に出す）
            this.sendProgress("thumbnail-progress", {
              kind: "progress",
              current: 0,
              total: 1,
              message: `サムネイル生成中: ${video.filename}`,
              file: video.filename,
              silent: true,
            });

            const generated = await this.generateThumbnailsForSingleVideo(video);

            // 完了通知（トーストにも流す）
            this.sendProgress("thumbnail-progress", {
              kind: "done",
              message: generated
                ? `サムネイル生成が完了しました: ${video.filename}`
                : `サムネイルの生成に失敗しました: ${video.filename}`,
              type: generated ? "success" : "error",
            });
          } else if (video && !video.needsThumbnails) {
            logger.debug(
              "Video already has thumbnails, skipping generation:",
              video.path,
            );
          }

          logger.debug("New video processed successfully:", filePath);
        } catch (error) {
          console.error("Error processing new video file:", filePath, error);
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `新しい動画の追加に失敗しました: ${path.basename(filePath)}`,
            type: "error",
          });
        }
      }
    });

    watcher.on("unlink", async (filePath: string) => {
      if (this.videoScanner.isVideoFile(filePath)) {
        try {
          logger.debug("Processing video file removal:", filePath);

          // 接続エラー中のディレクトリでは削除確認をスキップする
          // （切断時に大量の unlink が来て fs 呼び出しが滞留するのを防ぐ）
          const owner = await this.findRegisteredDirectoryOwner(filePath);
          if (owner !== null) {
            if (this.directoryAvailability.get(owner) === "offline") {
              logger.debug(
                "Skipping removal check for offline directory:",
                filePath,
              );
              return;
            }
            if (!(await this.isDirectoryAvailable(owner))) {
              // マウント自体が見えない → ファイル個別の削除判定はせず接続エラーとして扱う
              await this.handleDirectoryUnavailable(
                owner,
                "file unlinked while directory is unreachable",
              );
              return;
            }
          }

          // 外付けドライブや NAS の一時的な切断で「消えたように見える」ことがあるため、
          // 3秒 / 10秒 / 30秒と再確認し、所属ディレクトリ（マウント）が生きている
          // 状態でファイルが無いと確認できた場合のみ削除する。
          const state = await this.confirmRemoval(filePath);
          if (state !== "missing") {
            logger.debug(
              `Deferring video removal (${state}):`,
              filePath,
            );
            if (state === "unknown") {
              // マウント消失が疑われる場合は、所属ディレクトリをオフラインにして再接続を試みる
              await this.handleUnreachablePath(filePath);
            }
            return;
          }

          // プログレス通知を送信（トーストは削除完了時にまとめて出す）
          this.sendProgress("scan-progress", {
            kind: "progress",
            current: 0,
            total: 1,
            message: `動画を削除中: ${path.basename(filePath)}`,
            silent: true,
          });

          await this.db.removeVideo(filePath);

          if (this.mainWindow) {
            this.mainWindow.webContents.send("video-removed", filePath);
          }

          // 完了通知（トーストにも流す）
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `動画が削除されました: ${path.basename(filePath)}`,
            type: "info",
          });

          logger.debug("Video file removal processed successfully:", filePath);
        } catch (error) {
          console.error(
            "Error processing video file removal:",
            filePath,
            error,
          );
          this.sendProgress("scan-progress", {
            kind: "done",
            message: `動画の削除に失敗しました: ${path.basename(filePath)}`,
            type: "error",
          });
        }
      }
    });

    // ディレクトリ自体の削除を監視
    watcher.on("unlinkDir", async (dirPath: string) => {
      // 監視しているディレクトリ自体が削除された場合
      if (dirPath === directoryPath) {
        try {
          logger.debug("Directory unlinkDir event:", dirPath);

          // 外付けドライブや NAS の一時的な切断で「消えたように見える」ことがあるため、
          // 削除と断定する前に複数回（3秒 / 10秒 / 30秒）再確認する
          const state = await this.confirmRemoval(dirPath);
          if (state === "present") {
            logger.debug("Directory re-appeared, keeping watch:", dirPath);
            return;
          }

          // 本当に無くなっている場合でも、NAS の切断と区別が付かないため登録は削除しない。
          // オフライン扱いにして再接続を試み、削除はユーザーの明示操作（UI の削除）のみとする。
          await this.handleDirectoryUnavailable(
            dirPath,
            `watch root unavailable (${state})`,
          );
        } catch (error) {
          console.error("Error processing directory removal:", dirPath, error);
        }
      }
    });

    this.watchers.set(directoryPath, watcher);
  }

  stopWatching(directoryPath: string): void {
    const watcher = this.watchers.get(directoryPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(directoryPath);
    }
  }

  async startWatchingAllDirectories(): Promise<void> {
    await this.loadNetworkMountUrls();
    const directories = await this.db.getDirectories();

    for (const directory of directories) {
      if (await this.isDirectoryAvailable(directory.path)) {
        this.setDirectoryAvailability(directory.path, "online");
        this.startWatching(directory.path);
        // 切断後に再マウントできるよう、接続中に SMB URL を記録しておく
        await this.rememberNetworkMount(directory.path);
        continue;
      }

      // 起動時に共有がまだマウントされていないケース（ログイン直後・スリープ復帰など）。
      // ここで登録を削除すると NAS のフォルダが勝手に消えるため、オフライン扱いで維持し、
      // 再接続（必要なら SMB の再マウント）を試みる。
      await this.handleDirectoryUnavailable(
        directory.path,
        "not accessible at startup",
      );
    }

    // stale マウント対策として定期的な確認を開始する
    this.startNetworkHealthCheck();
  }

  public async cleanup(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      try {
        await watcher.close();
      } catch (error) {
        logger.error("Error closing watcher:", error);
      }
    }
    this.watchers.clear();

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectRunning.clear();
    this.reconnectAttempts.clear();

    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
