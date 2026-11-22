import { promises as fs } from "fs";
import path from "path";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import PrismaDatabaseManager from "../database/PrismaDatabaseManager.js";
import VideoScanner from "../scanner/VideoScanner.js";
import ThumbnailGenerator from "../thumbnail/ThumbnailGenerator.js";
import DuplicateDetector from "../scanner/DuplicateDetector.js";
import {
  BulkTagChange,
  ContainerMismatchItem,
  ConvertItemResult,
  ConvertVideosResult,
  DeleteVideoRequest,
  DirectoryAvailability,
  OperationProgress,
  ProcessedVideo,
  ProgressEvent,
  VideoUpdateData,
} from "../types/types.js";
import { classifyContainer, containerLabel, detectContainerKind } from "../utils/container.js";
import { getFfmpegPath } from "../utils/ffmpeg-utils.js";
import { createLogger } from "../utils/logger.js";
import { readFileHead } from "../utils/file-head.js";
import { getInternalPlaybackStatus } from "../utils/playback-compatibility.js";
import {
  findConvertedMp4Path,
  getMp4ConversionEligibility,
  remuxToMp4,
  transcodeToMp4,
  verifyConvertedMp4,
  verifyHighQualityVideo,
} from "./remux.js";
import { generateThumbnailsBatch } from "./thumbnail-batch.js";

const execFileAsync = promisify(execFile);
const logger = createLogger(app.isPackaged);
const PREVIEW_TEMP_PREFIX = "movie-library-preview-";

type ProgressChannel = "scan-progress" | "rescan-progress" | "thumbnail-progress";
type OperationProgressChannel =
  | "container-check-progress"
  | "container-convert-progress";

export interface IpcHandlerContext {
  db: PrismaDatabaseManager;
  videoScanner: VideoScanner;
  thumbnailGenerator: ThumbnailGenerator;
  duplicateDetector: DuplicateDetector;
  getMainWindow: () => BrowserWindow | null;
  directoryAvailability: ReadonlyMap<string, DirectoryAvailability>;
  sendProgress: (channel: ProgressChannel, payload: ProgressEvent) => void;
  sendOperationProgress: (
    channel: OperationProgressChannel,
    payload: OperationProgress,
  ) => void;
  isDirectoryAvailable: (directoryPath: string) => Promise<boolean>;
  setDirectoryAvailability: (
    directoryPath: string,
    status: DirectoryAvailability,
  ) => void;
  startWatching: (directoryPath: string) => void;
  stopWatching: (directoryPath: string) => void;
  rememberNetworkMount: (directoryPath: string) => Promise<void>;
  handleDirectoryUnavailable: (
    directoryPath: string,
    reason: string,
  ) => Promise<void>;
  forgetDirectory: (directoryPath: string) => void;
  probeDirectoryAvailability: (directoryPath: string) => Promise<void>;
  isDirectoryAccessible: (directoryPath: string) => Promise<boolean>;
  invalidateRegisteredDirectoriesCache: () => void;
  regenerateMainThumbnailAt: (
    videoId: number,
    timestamp: number,
  ) => Promise<unknown>;
  generateThumbnailsForSingleVideo: (video: ProcessedVideo) => Promise<boolean>;
  getPreviewTempDir: () => string;
  clearVideoHashes: (videoId: number) => Promise<void>;
  onRendererReady: () => void;
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await task(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

function resolveScreenshotDir(outputDir: string): string {
  const trimmed = (outputDir ?? "").trim();
  if (trimmed === "" || trimmed === "~/Pictures" || trimmed === "~\\Pictures") {
    return app.getPath("pictures");
  }
  if (trimmed === "~") return process.env.HOME ?? app.getPath("home");
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(app.getPath("home"), trimmed.slice(2));
  }
  return trimmed;
}

function exportStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function registerIpcHandlers(context: IpcHandlerContext): void {
  const {
    db,
    videoScanner,
    thumbnailGenerator,
    duplicateDetector,
    getMainWindow,
    sendProgress,
    sendOperationProgress,
  } = context;
  // 複数の <img> が同じ動画の欠損を検知しても、ffmpeg を一度だけ起動する。
  const pendingThumbnailRepairs = new Map<number, Promise<boolean>>();
  let rendererReadyReceived = false;

  ipcMain.handle("renderer-ready", () => {
    if (!rendererReadyReceived) {
      rendererReadyReceived = true;
      context.onRendererReady();
    }
  });

  ipcMain.handle("get-videos", async () => db.getVideos());
  ipcMain.handle("get-tags", async () => db.getTags());
  ipcMain.handle("get-directories", async () => db.getDirectories());

  ipcMain.handle("backup-database", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: "メインウィンドウがありません" };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "データベースをバックアップ",
      defaultPath: path.join(app.getPath("documents"), `movie-library-backup-${exportStamp()}.db`),
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePath) return { success: false, error: "キャンセルしました" };
    try {
      await db.backupDatabase(result.filePath);
      return { success: true, path: result.filePath };
    } catch (error) {
      logger.error("Failed to backup database:", error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("export-tags", async (_event, format: "json" | "csv") => {
    if (format !== "json" && format !== "csv") {
      return { success: false, error: "不正なエクスポート形式です" };
    }
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: "メインウィンドウがありません" };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `タグを${format.toUpperCase()}でエクスポート`,
      defaultPath: path.join(app.getPath("documents"), `movie-library-tags-${exportStamp()}.${format}`),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return { success: false, error: "キャンセルしました" };
    try {
      const tags = await db.getTags();
      const contents = format === "json"
        ? JSON.stringify(tags, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)
        : `name,count,color\n${tags.map((tag) => [tag.name, tag.count ?? 0, tag.color ?? ""].map(csvEscape).join(",")).join("\n")}\n`;
      await fs.writeFile(result.filePath, format === "csv" ? `\uFEFF${contents}` : contents, "utf8");
      return { success: true, path: result.filePath };
    } catch (error) {
      logger.error("Failed to export tags:", error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("choose-directory", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "multiSelections"],
      title: "動画フォルダを選択",
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("add-directory", async (_event, directoryPath: string) => {
    const id = await db.addDirectory(directoryPath);
    context.invalidateRegisteredDirectoriesCache();
    if (await context.isDirectoryAvailable(directoryPath)) {
      context.setDirectoryAvailability(directoryPath, "online");
      context.startWatching(directoryPath);
      await context.rememberNetworkMount(directoryPath);
    } else {
      await context.handleDirectoryUnavailable(directoryPath, "added while unavailable");
    }
    return id;
  });

  ipcMain.handle("remove-directory", async (_event, directoryPath: string) => {
    const result = await db.removeDirectory(directoryPath);
    context.invalidateRegisteredDirectoriesCache();
    context.stopWatching(directoryPath);
    context.forgetDirectory(directoryPath);
    return result;
  });

  ipcMain.handle("get-directory-statuses", async () => {
    const directories = await db.getDirectories();
    const statuses: Record<string, DirectoryAvailability> = {};
    for (const directory of directories) {
      const known = context.directoryAvailability.get(directory.path);
      if (known === undefined) {
        void context.probeDirectoryAvailability(directory.path);
        statuses[directory.path] = "online";
      } else {
        statuses[directory.path] = known;
      }
    }
    return statuses;
  });

  ipcMain.handle("check-directory-exists", async (_event, directoryPath: string) =>
    context.isDirectoryAccessible(directoryPath),
  );

  ipcMain.handle("preview-scan", async () => {
    const directoryPaths: string[] = [];
    for (const directory of await db.getDirectories()) {
      if (await context.isDirectoryAvailable(directory.path)) {
        directoryPaths.push(directory.path);
      } else {
        // オフラインのNAS配下は削除候補に含めない。登録自体も維持する。
        await context.handleDirectoryUnavailable(directory.path, "skipped during scan preview");
      }
    }
    return videoScanner.previewScan(directoryPaths);
  });

  ipcMain.handle("scan-directories", async () => {
    const directoryPaths: string[] = [];
    for (const directory of await db.getDirectories()) {
      if (await context.isDirectoryAvailable(directory.path)) {
        directoryPaths.push(directory.path);
      } else {
        await context.handleDirectoryUnavailable(directory.path, "skipped during scan");
      }
    }

    const result = await videoScanner.comprehensiveScan(directoryPaths, (progress) =>
      sendProgress("scan-progress", {
        kind: "progress",
        current: progress.current,
        total: progress.total,
        message: `スキャン中: ${progress.file}`,
        file: progress.file,
      }),
    );
    for (const deletedPath of result.deletedVideos) {
      try {
        await db.removeVideo(deletedPath);
      } catch (error) {
        logger.error(`Failed to remove deleted video: ${deletedPath}`, error);
      }
    }
    if (result.errors.length > 0) {
      const details = result.errors
        .map((error) => `ファイル: ${error.filePath}\nエラー: ${error.error}`)
        .join("\n\n");
      // ネイティブダイアログは出さず、ログへ残して完了トーストで件数のみ知らせる。
      logger.error(`スキャンエラー (${result.errors.length}件):\n${details}`);
    }
    const details: string[] = [];
    if (result.newVideos.length > 0) details.push(`新規: ${result.newVideos.length}件`);
    if (result.updatedVideos.length > 0) details.push(`更新: ${result.updatedVideos.length}件`);
    if (result.reprocessedVideos.length > 0) details.push(`再処理: ${result.reprocessedVideos.length}件`);
    if (result.deletedVideos.length > 0) details.push(`削除: ${result.deletedVideos.length}件`);
    if (result.errors.length > 0) details.push(`エラー: ${result.errors.length}件`);
    sendProgress("scan-progress", {
      kind: "done",
      message:
        details.length > 0
          ? `スキャンが完了しました (${details.join(", ")})`
          : "スキャンが完了しました（変更はありませんでした）",
      type: result.errors.length > 0 ? "warning" : details.length > 0 ? "success" : "info",
    });
    return {
      totalNew: result.newVideos.length,
      totalUpdated: result.updatedVideos.length,
      totalReprocessed: result.reprocessedVideos.length,
      totalDeleted: result.deletedVideos.length,
      totalErrors: result.errors.length,
      errors: result.errors,
    };
  });

  ipcMain.handle("rescan-all-videos", async () => {
    const directoryPaths: string[] = [];
    for (const directory of await db.getDirectories()) {
      if (await context.isDirectoryAvailable(directory.path)) {
        directoryPaths.push(directory.path);
      } else {
        await context.handleDirectoryUnavailable(directory.path, "skipped during rescan");
      }
    }
    const result = await videoScanner.forceRescanAllVideos(directoryPaths, (progress) =>
      sendProgress("rescan-progress", {
        kind: "progress",
        current: progress.current,
        total: progress.total,
        message: `再スキャン中: ${progress.file}`,
        file: progress.file,
      }),
    );
    for (const deletedPath of result.deletedVideos) await db.removeVideo(deletedPath);
    if (result.errors.length > 0) {
      const details = result.errors
        .map((error) => `ファイル: ${error.filePath}\nエラー: ${error.error}`)
        .join("\n\n");
      // ネイティブダイアログは出さず、ログへ残して完了トーストで件数のみ知らせる。
      logger.error(`再スキャンエラー (${result.errors.length}件):\n${details}`);
    }
    const rescanDetails = [`処理: ${result.totalProcessed}件`];
    if (result.totalUpdated > 0) rescanDetails.push(`更新: ${result.totalUpdated}件`);
    if (result.deletedVideos.length > 0) rescanDetails.push(`削除: ${result.deletedVideos.length}件`);
    if (result.totalErrors > 0) rescanDetails.push(`エラー: ${result.totalErrors}件`);
    sendProgress("rescan-progress", {
      kind: "done",
      message:
        result.totalProcessed === 0
          ? "再スキャン対象の動画はありませんでした"
          : `再スキャンが完了しました (${rescanDetails.join(", ")})。サムネイル生成を開始します`,
      type: result.totalErrors > 0 ? "warning" : result.totalProcessed === 0 ? "info" : "success",
    });

    try {
      const totalVideos = await db.getVideoCount();
      const thumbnailResults = await generateThumbnailsBatch({
        fetchPage: (limit, afterId) => db.getVideosForScanPage(limit, afterId),
        totalVideos,
        verb: "自動サムネイル生成",
        stablePagination: true,
        generate: (video) => thumbnailGenerator.generateThumbnails(video),
        sendProgress: (payload) => sendProgress("thumbnail-progress", payload),
      });
      sendProgress("thumbnail-progress", {
        kind: "done",
        message:
          thumbnailResults.length > 0
            ? `サムネイル生成が完了しました (${thumbnailResults.length}件)`
            : "サムネイル生成の対象はありませんでした",
        type: thumbnailResults.length > 0 ? "success" : "info",
        silent: thumbnailResults.length === 0,
      });
    } catch (error) {
      logger.error("Error during automatic thumbnail generation:", error);
      sendProgress("thumbnail-progress", {
        kind: "done",
        message: "自動サムネイル生成でエラーが発生しました",
        type: "warning",
      });
    }
    return {
      totalProcessed: result.totalProcessed,
      totalUpdated: result.totalUpdated,
      totalReprocessed: result.totalProcessed,
      totalDeleted: result.deletedVideos.length,
      totalErrors: result.totalErrors,
      errors: result.errors,
    };
  });

  ipcMain.handle("generate-thumbnails", async () => {
    const totalVideos = await db.getVideosWithoutThumbnailsCount();
    const results = await generateThumbnailsBatch({
      fetchPage: (limit, afterId) => db.getVideosWithoutThumbnailsPage(limit, afterId),
      totalVideos,
      verb: "サムネイル生成",
      stablePagination: true,
      generate: (video) => thumbnailGenerator.generateThumbnails(video),
      sendProgress: (payload) => sendProgress("thumbnail-progress", payload),
    });
    sendProgress("thumbnail-progress", {
      kind: "done",
      message:
        results.length > 0
          ? `サムネイル生成が完了しました (${results.length}件)`
          : "サムネイル生成の対象はありませんでした",
      type: results.length > 0 ? "success" : "info",
    });
    return results;
  });

  ipcMain.handle("regenerate-all-thumbnails", async () => {
    const totalVideos = await db.getVideoCount();
    const results = await generateThumbnailsBatch({
      fetchPage: (limit, afterId) => db.getVideosForScanPage(limit, afterId),
      totalVideos,
      verb: "サムネイル再生成",
      stablePagination: true,
      generate: (video) => thumbnailGenerator.generateThumbnails(video),
      sendProgress: (payload) => sendProgress("thumbnail-progress", payload),
    });
    sendProgress("thumbnail-progress", {
      kind: "done",
      message:
        results.length > 0
          ? `サムネイル再生成が完了しました (${results.length}件)`
          : "サムネイル再生成の対象はありませんでした",
      type: results.length > 0 ? "success" : "info",
    });
    return results;
  });

  ipcMain.handle("regenerate-thumbnails-for-videos", async (_event, videoIds: number[]) => {
    const ids = Array.isArray(videoIds)
      ? [...new Set(videoIds.filter((id) => Number.isInteger(id)))]
      : [];
    const videos = (await Promise.all(ids.map((id) => db.getVideo(id)))).filter(
      (video) => video !== null,
    );
    const results: Awaited<ReturnType<typeof thumbnailGenerator.generateThumbnails>>[] = [];
    let processed = 0;

    await runConcurrent(videos, 3, async (video) => {
      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: processed,
        total: videos.length,
        message: `選択動画のサムネイル再生成中: ${video.filename}`,
        file: video.filename,
      });
      try {
        results.push(await thumbnailGenerator.generateThumbnails(video));
      } catch (error) {
        logger.error(`Error regenerating selected thumbnail: ${video.path}`, error);
      } finally {
        processed++;
        sendProgress("thumbnail-progress", {
          kind: "progress",
          current: processed,
          total: videos.length,
          message: `選択動画のサムネイル再生成完了: ${video.filename}`,
          file: video.filename,
        });
      }
    });

    sendProgress("thumbnail-progress", {
      kind: "done",
      message:
        videos.length === 0
          ? "サムネイル再生成の対象はありませんでした"
          : `選択動画のサムネイル再生成が完了しました (${results.length}/${videos.length}件)`,
      type: results.length === videos.length ? "success" : "warning",
    });
    return results;
  });

  ipcMain.handle("generate-incomplete-thumbnails", async () => {
    const batchSize = 50;
    const totalCount = await db.getVideosWithIncompleteThumbnailsCount();
    let generatedVideos = 0;
    let processedVideos = 0;
    let afterId = 0;

    // DB 上で欠損が分かる候補だけを補完する。生成済みファイルの実在確認を
    // ライブラリ全件に対して行わず、個別の実ファイル欠損は画像 load error 時に
    // repair-thumbnail で補修する。
    if (totalCount > 0) {
      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: 0,
        total: totalCount,
        message: `不完全なサムネイルを補完中 (0/${totalCount})`,
        silent: true,
      });
    }

    for (;;) {
      const videos = await db.getVideosWithIncompleteThumbnailsPage(
        batchSize,
        afterId,
      );
      if (videos.length === 0) break;
      await runConcurrent(videos, 3, async (video) => {
        let message = `サムネイル補完中: ${video.filename}`;
        try {
          await thumbnailGenerator.generateThumbnails(video);
          generatedVideos++;
          message = `サムネイル補完完了: ${video.filename}`;
        } catch (error) {
          logger.error(`Error generating incomplete thumbnail for: ${video.path}`, error);
          message = `サムネイル補完エラー: ${video.filename}`;
        } finally {
          processedVideos++;
          sendProgress("thumbnail-progress", {
            kind: "progress",
            current: processedVideos,
            total: totalCount,
            message,
            file: video.filename,
            silent: true,
          });
        }
      });
      afterId = videos[videos.length - 1]!.id;
      if (videos.length < batchSize) break;
    }
    sendProgress("thumbnail-progress", {
      kind: "done",
      message: `不完全なサムネイルを補完しました (${generatedVideos}/${totalCount})`,
      type: "info",
      silent: generatedVideos === 0,
    });
    return { total: totalCount, generated: generatedVideos };
  });

  ipcMain.handle("repair-thumbnail", async (_event, videoId: number) => {
    if (!Number.isInteger(videoId) || videoId <= 0) {
      throw new Error("Invalid video ID");
    }

    const pending = pendingThumbnailRepairs.get(videoId);
    if (pending !== undefined) return pending;

    const repair = (async (): Promise<boolean> => {
      const video = await db.getVideo(videoId);
      if (video === null) return false;

      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: 0,
        total: 1,
        message: `サムネイルを補修中: ${video.filename}`,
        file: video.filename,
        silent: true,
      });
      try {
        await thumbnailGenerator.generateThumbnails(video);
        sendProgress("thumbnail-progress", {
          kind: "done",
          message: `サムネイルを補修しました: ${video.filename}`,
          type: "success",
          silent: true,
        });
        return true;
      } catch (error) {
        logger.error(`Error repairing thumbnail for: ${video.path}`, error);
        sendProgress("thumbnail-progress", {
          kind: "done",
          message: `サムネイルの補修に失敗しました: ${video.filename}`,
          type: "error",
        });
        return false;
      }
    })();
    pendingThumbnailRepairs.set(videoId, repair);
    try {
      return await repair;
    } finally {
      pendingThumbnailRepairs.delete(videoId);
    }
  });

  ipcMain.handle("update-thumbnail-settings", async (_event, settings) => {
    thumbnailGenerator.updateSettings(settings);
    return true;
  });

  ipcMain.handle("cleanup-thumbnails", async () => {
    const result = await thumbnailGenerator.cleanupThumbnails();
    logger.log("Thumbnail cleanup completed:", result);
    return result;
  });

  ipcMain.handle("get-thumbnails-dir", () =>
    path.join(app.getPath("userData"), "thumbnails"),
  );

  ipcMain.handle(
    "update-video",
    async (_event, videoId: number, data: VideoUpdateData) =>
      db.updateVideo(videoId, data),
  );

  ipcMain.handle(
    "add-tag-to-video",
    async (_event, videoId: number, tagName: string) =>
      db.addTagToVideo(videoId, tagName),
  );
  ipcMain.handle(
    "add-tags-to-videos",
    async (_event, videoIds: number[], tagNames: string[]) =>
      db.addTagsToVideos(videoIds, tagNames),
  );
  ipcMain.handle(
    "remove-tag-from-video",
    async (_event, videoId: number, tagName: string) =>
      db.removeTagFromVideo(videoId, tagName),
  );
  ipcMain.handle(
    "remove-tags-from-videos",
    async (_event, videoIds: number[], tagNames: string[]) =>
      db.removeTagsFromVideos(videoIds, tagNames),
  );
  ipcMain.handle(
    "apply-bulk-tag-changes",
    async (_event, changes: BulkTagChange[]) => db.applyBulkTagChanges(changes),
  );
  ipcMain.handle(
    "update-tag",
    async (_event, oldName: string, newName: string) => db.updateTag(oldName, newName),
  );
  ipcMain.handle("delete-tag", async (_event, tagName: string) => db.deleteTag(tagName));

  ipcMain.handle(
    "generate-preview-thumbnail",
    async (_event, videoPath: string, timestamp: number) => {
      const previewDir = context.getPreviewTempDir();
      await fs.mkdir(previewDir, { recursive: true });
      const previewPath = path.join(
        previewDir,
        `${PREVIEW_TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}.jpg`,
      );
      await thumbnailGenerator.generateSingleThumbnail(
        videoPath,
        previewPath,
        timestamp,
      );
      return previewPath;
    },
  );

  ipcMain.handle(
    "delete-preview-thumbnail",
    async (_event, previewPath: string): Promise<boolean> => {
      const previewDir = context.getPreviewTempDir();
      if (typeof previewPath !== "string") {
        throw new Error("Invalid preview thumbnail path");
      }
      const relative = path.relative(path.resolve(previewDir), path.resolve(previewPath));
      if (
        (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) ||
        !path.basename(previewPath).startsWith(PREVIEW_TEMP_PREFIX) ||
        path.extname(previewPath).toLowerCase() !== ".jpg"
      ) {
        throw new Error("Invalid preview thumbnail path");
      }
      try {
        await fs.unlink(previewPath);
        return true;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return false;
        throw error;
      }
    },
  );

  ipcMain.handle("regenerate-main-thumbnail", async (_event, videoId: number) => {
    const video = await db.getVideo(videoId);
    if (!video) throw new Error("Video not found");
    const timestamp = video.duration * (0.1 + Math.random() * 0.8);
    sendProgress("thumbnail-progress", {
      kind: "progress",
      current: 0,
      total: 1,
      message: "メインサムネイルを生成中...",
      silent: true,
    });
    try {
      const result = await context.regenerateMainThumbnailAt(videoId, timestamp);
      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: 1,
        total: 1,
        message: "メインサムネイルの生成が完了しました",
        silent: true,
      });
      sendProgress("thumbnail-progress", {
        kind: "done",
        message: "メインサムネイルの生成が完了しました",
        type: "success",
        silent: true,
      });
      return result;
    } catch (error) {
      sendProgress("thumbnail-progress", {
        kind: "done",
        message: "メインサムネイルの生成に失敗しました",
        type: "error",
        silent: true,
      });
      throw error;
    }
  });
  ipcMain.handle(
    "regenerate-main-thumbnail-with-timestamp",
    async (_event, videoId: number, timestamp: number) => {
      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: 0,
        total: 1,
        message: "指定位置のサムネイルを生成中...",
        silent: true,
      });
      try {
        const result = await context.regenerateMainThumbnailAt(videoId, timestamp);
        sendProgress("thumbnail-progress", {
          kind: "progress",
          current: 1,
          total: 1,
          message: "指定位置のサムネイル生成が完了しました",
          silent: true,
        });
        sendProgress("thumbnail-progress", {
          kind: "done",
          message: "指定位置のサムネイル生成が完了しました",
          type: "success",
          silent: true,
        });
        return result;
      } catch (error) {
        sendProgress("thumbnail-progress", {
          kind: "done",
          message: "指定位置のサムネイル生成に失敗しました",
          type: "error",
          silent: true,
        });
        throw error;
      }
    },
  );

  ipcMain.handle("check-container-mismatches", async () => {
    const items: ContainerMismatchItem[] = [];
    const totalVideos = await db.getVideoCount();
    if (totalVideos > 0) {
      sendOperationProgress("container-check-progress", {
        current: 0,
        total: totalVideos,
        message: `確認を準備中 (0/${totalVideos})`,
        silent: true,
      });
    }
    await videoScanner.initialize();
    const batchSize = 100;
    let checkedCount = 0;
    let afterId = 0;
    for (;;) {
      const videos = await db.getVideosForContainerCheck(batchSize, afterId);
      if (videos.length === 0) break;
      await runConcurrent(videos, 4, async (video) => {
        try {
          const head = await readFileHead(video.path, 512);
          const extension = path.extname(video.path).toLowerCase();
          const kind = head === null ? "unknown" : detectContainerKind(head);
          const containerVerdict = classifyContainer(kind, extension);
          const codecStatus = getInternalPlaybackStatus(video.path, video.codec);
          const nativePlayable =
            codecStatus.playable &&
            (kind === "unknown" || containerVerdict.nativePlayable);
          if (nativePlayable && !containerVerdict.extensionMismatch) return;

          let convertible = false;
          let conversionMode: ContainerMismatchItem["conversionMode"];
          let conversionReason: string | undefined;
          try {
            const metadata = await videoScanner.getVideoMetadata(video.path);
            const eligibility = getMp4ConversionEligibility(metadata);
            convertible = eligibility.convertible;
            conversionReason = eligibility.reason;
            conversionMode = eligibility.mode;
          } catch (error) {
            conversionReason = `ストリーム情報を取得できません: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }

          items.push({
            videoId: video.id,
            path: video.path,
            filename: video.filename,
            size: Number(video.size ?? 0),
            extension,
            detectedKind: kind,
            detectedLabel: kind === "unknown" ? "未判定" : containerLabel(kind),
            nativePlayable,
            extensionMismatch: containerVerdict.extensionMismatch,
            convertible,
            conversionMode,
            conversionReason,
          });
        } catch (error) {
          logger.error(`Error checking container: ${video.path}`, error);
        } finally {
          checkedCount++;
          sendOperationProgress("container-check-progress", {
            current: checkedCount,
            total: totalVideos,
            message: `確認中: ${video.filename}`,
          });
        }
      });
      afterId = videos[videos.length - 1]!.id;
      if (videos.length < batchSize) break;
    }
    sendOperationProgress("container-check-progress", {
      current: checkedCount,
      total: totalVideos,
      message: `確認が完了しました (${checkedCount}/${totalVideos})`,
      completed: true,
      silent: true,
    });
    return items;
  });

  ipcMain.handle("get-mp4-conversion-eligibility", async (_event, videoId: number) => {
    const video = await db.getVideo(videoId);
    if (!video || video.hidden) {
      return { convertible: false, reason: "動画が見つかりません" };
    }
    if (video.internalPlayable) {
      return {
        convertible: false,
        reason: "この動画は既に内蔵プレーヤーで直接再生できる見込みです",
      };
    }
    try {
      await videoScanner.initialize();
      return getMp4ConversionEligibility(
        await videoScanner.getVideoMetadata(video.path),
      );
    } catch (error) {
      return {
        convertible: false,
        reason: `ストリーム情報を取得できません: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });

  ipcMain.handle(
    "convert-videos-to-mp4",
    async (_event, videoIds: number[]): Promise<ConvertVideosResult> => {
      const ffmpegPath = await getFfmpegPath();
      if (!ffmpegPath) throw new Error("FFmpeg binary not found");
      await videoScanner.initialize();
      const items: ConvertItemResult[] = [];
      let succeeded = 0;
      let failed = 0;
      const uniqueVideoIds = [...new Set(videoIds.filter((videoId) => Number.isInteger(videoId) && videoId > 0))];
      const total = uniqueVideoIds.length;
      const detailTotal = 100;
      const reportConversionProgress = (
        current: number,
        detailCurrent: number | undefined,
        message: string,
        completed = false,
      ): void => {
        sendOperationProgress("container-convert-progress", {
          current,
          total,
          detailCurrent,
          detailTotal: detailCurrent === undefined ? undefined : detailTotal,
          message,
          completed,
          silent: true,
        });
      };
      if (total > 0) {
        reportConversionProgress(0, 0, `変換を準備中 (0/${total})`);
      }
      for (let index = 0; index < total; index++) {
        const videoId = uniqueVideoIds[index] ?? 0;
        let sourcePath = `(id:${videoId})`;
        let outputPath: string | undefined;
        try {
          const video = await db.getVideo(videoId);
          if (!video) throw new Error("動画が見つかりません");
          sourcePath = video.path;
          if (video.hidden) {
            throw new Error("変換元の動画は既に一覧から除外されています");
          }
          if (video.internalPlayable) {
            throw new Error("この動画は既に内蔵プレーヤーで直接再生できる見込みです");
          }

          const sourceMetadata = await videoScanner.getVideoMetadata(video.path);
          const eligibility = getMp4ConversionEligibility(sourceMetadata);
          if (!eligibility.convertible || !eligibility.mode) {
            throw new Error(eligibility.reason ?? "MP4 変換の対象外です");
          }
          outputPath = await findConvertedMp4Path(video.path);
          const conversionLabel = eligibility.mode === "remux" ? "無劣化リマックス" : "高品質 H.264/MP3 変換";
          reportConversionProgress(index, 0, `${conversionLabel}を開始: ${video.filename}`);
          const onFfmpegProgress = (progress: number | null): void => {
            if (progress === null) {
              reportConversionProgress(index, undefined, `${conversionLabel}中: ${video.filename}`);
              return;
            }
            // 残り10%を検証・登録に確保し、変換完了前に100%とは表示しない。
            const detailCurrent = Math.min(90, Math.round(progress * 90));
            reportConversionProgress(
              index,
              detailCurrent,
              `${conversionLabel}中 (${detailCurrent}%): ${video.filename}`,
            );
          };
          if (eligibility.mode === "remux") {
            await remuxToMp4(
              ffmpegPath,
              video.path,
              outputPath,
              sourceMetadata.format.duration,
              onFfmpegProgress,
            );
          } else {
            await transcodeToMp4(
              ffmpegPath,
              video.path,
              outputPath,
              sourceMetadata.format.duration,
              onFfmpegProgress,
            );
          }
          reportConversionProgress(index, 90, `品質・同期を検証中: ${video.filename}`);
          verifyConvertedMp4(
            sourceMetadata,
            await videoScanner.getVideoMetadata(outputPath),
            eligibility.mode,
          );
          if (eligibility.mode === "transcode") {
            await verifyHighQualityVideo(ffmpegPath, video.path, outputPath);
          }
          const convertedVideo = await videoScanner.processFile(outputPath, true);
          if (!convertedVideo?.id) {
            throw new Error("変換後の動画をライブラリへ登録できませんでした");
          }
          await db.inheritConvertedVideo(videoId, convertedVideo.id);
          try {
            await context.clearVideoHashes(videoId);
          } catch (error) {
            // 変換と属性引継ぎは成功済み。ハッシュだけは次回の重複検索で再作成される。
            logger.warn(`Failed to clear source hashes after conversion: ${video.path}`, error);
          }
          succeeded++;
          items.push({
            path: video.path,
            outputPath,
            conversionMode: eligibility.mode,
            ok: true,
          });
        } catch (error) {
          if (outputPath) {
            // 属性引継ぎまで完了しなかったアプリ生成物は残さない。元ファイルは一切触れない。
            await db.removeVideo(outputPath).catch(() => {});
            await fs.unlink(outputPath).catch(() => {});
          }
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          items.push({ path: sourcePath, ok: false, error: message });
        }
        reportConversionProgress(
          index + 1,
          index + 1 === total ? detailTotal : undefined,
          `変換完了 (${index + 1}/${total})`,
          index + 1 === total,
        );
      }
      return { succeeded, failed, items };
    },
  );

  ipcMain.handle("find-duplicates", async () =>
    duplicateDetector.findDuplicates(
      (current, total, message, detailCurrent, detailTotal) => {
        getMainWindow()?.webContents.send("duplicate-search-progress", {
          current,
          total,
          message,
          detailCurrent,
          detailTotal,
        });
      },
    ),
  );
  ipcMain.handle("cancel-duplicate-search", async () => {
    duplicateDetector.cancelSearch();
  });
  ipcMain.handle(
    "delete-videos",
    async (_event, requests: DeleteVideoRequest[], moveToTrash: boolean = true) => {
      getMainWindow()?.webContents.send("delete-progress", {
        current: 0,
        total: requests.length,
      });
      const result = await duplicateDetector.deleteVideos(
        requests,
        moveToTrash,
        (current, total) => {
          getMainWindow()?.webContents.send("delete-progress", { current, total });
        },
      );
      getMainWindow()?.webContents.send("delete-progress", {
        current: requests.length,
        total: requests.length,
        completed: true,
        message: `動画の削除が完了しました（${result.success}件成功、${result.failed}件失敗）`,
      });
      return result;
    },
  );
  ipcMain.handle(
    "delete-library-videos",
    async (_event, videoIds: number[], moveToTrash: boolean = true) => {
      getMainWindow()?.webContents.send("delete-progress", {
        current: 0,
        total: videoIds.length,
      });
      const result = await duplicateDetector.deleteLibraryVideos(
        videoIds,
        moveToTrash,
        (current, total) => {
          getMainWindow()?.webContents.send("delete-progress", { current, total });
        },
      );
      getMainWindow()?.webContents.send("delete-progress", {
        current: videoIds.length,
        total: videoIds.length,
        completed: true,
        message: `動画の削除が完了しました（${result.success}件成功、${result.failed}件失敗）`,
      });
      return result;
    },
  );

  ipcMain.handle("open-video", async (_event, videoPath: string) => {
    await shell.openPath(videoPath);
  });

  ipcMain.handle(
    "capture-frame",
    async (_event, videoPath: string, timestamp: number, outputDir: string) => {
      try {
        const ffmpegPath = await getFfmpegPath();
        if (!ffmpegPath) throw new Error("FFmpeg binary not found");
        const resolvedDir = resolveScreenshotDir(outputDir);
        await fs.mkdir(resolvedDir, { recursive: true });
        const parsed = path.parse(videoPath);
        const safeBase = parsed.name.replace(/[\\/:*?"<>|]/g, "_");
        const tsLabel = timestamp.toFixed(1).replace(".", "_");
        const outputPath = path.join(resolvedDir, `${safeBase}_${tsLabel}.png`);
        await execFileAsync(ffmpegPath, [
          "-ss",
          timestamp.toFixed(3),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-f",
          "image2",
          "-y",
          outputPath,
        ], { maxBuffer: 1024 * 1024 * 10 });
        return { success: true, outputPath } as const;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    },
  );

  ipcMain.handle("select-screenshot-dir", async () => {
    const result = await dialog.showOpenDialog({
      title: "スクリーンショットの保存先フォルダを選択",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : result.filePaths[0];
  });

  ipcMain.handle(
    "has-video-updates",
    async (_event, lastCheckTime: number) => db.hasVideoUpdates(lastCheckTime),
  );
}
