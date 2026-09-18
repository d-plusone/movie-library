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
import { remuxToMp4 } from "./remux.js";
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
      dialog.showErrorBox(
        `スキャンエラー (${result.errors.length}件)`,
        `以下のファイルでエラーが発生しました:\n\n${details}`,
      );
    }
    const details: string[] = [];
    if (result.newVideos.length > 0) details.push(`新規: ${result.newVideos.length}件`);
    if (result.updatedVideos.length > 0) details.push(`更新: ${result.updatedVideos.length}件`);
    if (result.reprocessedVideos.length > 0) details.push(`再処理: ${result.reprocessedVideos.length}件`);
    if (result.deletedVideos.length > 0) details.push(`削除: ${result.deletedVideos.length}件`);
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
      dialog.showErrorBox(
        `再スキャンエラー (${result.errors.length}件)`,
        `以下のファイルでエラーが発生しました:\n\n${details}`,
      );
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
      fetchPage: (limit) => db.getVideosWithoutThumbnails(limit, 0),
      totalVideos,
      verb: "サムネイル生成",
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

  ipcMain.handle("generate-incomplete-thumbnails", async () => {
    const batchSize = 50;
    const totalCount = await db.getVideoCount();
    let generatedVideos = 0;
    let scannedVideos = 0;
    let processedVideos = 0;
    let afterId = 0;

    // 起動時は「補完対象が見つかった時」までイベントが発生しないと、
    // 大量の既存サムネイルを確認している間ずっと画面が無表示になる。
    // 最初に確認開始を通知し、確認済み件数を後続イベントで更新する。
    if (totalCount > 0) {
      sendProgress("thumbnail-progress", {
        kind: "progress",
        current: 0,
        total: totalCount,
        message: `サムネイルを確認中 (0/${totalCount})`,
        silent: true,
      });
    }

    for (;;) {
      const videos = await db.getVideosForScanPage(batchSize, afterId);
      if (videos.length === 0) break;
      await runConcurrent(videos, 3, async (video) => {
        scannedVideos++;
        let message = `サムネイルを確認中: ${video.filename}`;
        try {
          await fs.access(video.path);
          let incomplete = !video.thumbnailPath;
          if (!incomplete) {
            try {
              await fs.access(video.thumbnailPath!);
            } catch {
              incomplete = true;
            }
          }
          if (!incomplete) {
            const chapters = video.chapterThumbnails ?? [];
            if (chapters.length === 0) {
              incomplete = true;
            } else {
              let anyExists = false;
              for (const chapter of chapters) {
                try {
                  await fs.access(chapter.path);
                  anyExists = true;
                  break;
                } catch {
                  // 次のチャプターを確認する
                }
              }
              incomplete = !anyExists;
            }
          }
          if (incomplete) {
            sendProgress("thumbnail-progress", {
              kind: "progress",
              current: processedVideos,
              total: totalCount,
              message: `サムネイル補完中: ${video.filename}`,
              file: video.filename,
              silent: true,
            });
            await thumbnailGenerator.generateThumbnails(video);
            generatedVideos++;
            message = `サムネイル補完完了: ${video.filename}`;
          } else {
            message = `サムネイル確認済み: ${video.filename}`;
          }
        } catch (error) {
          logger.error(`Error checking thumbnail completeness for: ${video.path}`, error);
          message = `サムネイル確認エラー: ${video.filename}`;
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
      message: `不完全なサムネイルを補完しました (${generatedVideos}/${scannedVideos})`,
      type: "info",
      silent: generatedVideos === 0,
    });
    return { total: scannedVideos, generated: generatedVideos };
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
    return context.regenerateMainThumbnailAt(videoId, timestamp);
  });
  ipcMain.handle(
    "regenerate-main-thumbnail-with-timestamp",
    async (_event, videoId: number, timestamp: number) =>
      context.regenerateMainThumbnailAt(videoId, timestamp),
  );

  ipcMain.handle("check-container-mismatches", async () => {
    const items: ContainerMismatchItem[] = [];
    const totalVideos = await db.getVideoCount();
    const batchSize = 100;
    let checkedCount = 0;
    let afterId = 0;
    for (;;) {
      const videos = await db.getVideosForContainerCheck(batchSize, afterId);
      if (videos.length === 0) break;
      await runConcurrent(videos, 4, async (video) => {
        try {
          const head = await readFileHead(video.path, 512);
          if (head === null) return;
          const kind = detectContainerKind(head);
          if (kind === "unknown") return;
          const extension = path.extname(video.path).toLowerCase();
          const verdict = classifyContainer(kind, extension);
          if (verdict.nativePlayable && !verdict.extensionMismatch) return;
          items.push({
            videoId: video.id,
            path: video.path,
            filename: video.filename,
            size: Number(video.size ?? 0),
            extension,
            detectedKind: kind,
            detectedLabel: containerLabel(kind),
            nativePlayable: verdict.nativePlayable,
            extensionMismatch: verdict.extensionMismatch,
            convertible: extension === ".mp4" || extension === ".m4v",
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
    return items;
  });

  ipcMain.handle(
    "convert-videos-to-mp4",
    async (_event, videoIds: number[]): Promise<ConvertVideosResult> => {
      const ffmpegPath = await getFfmpegPath();
      if (!ffmpegPath) throw new Error("FFmpeg binary not found");
      const items: ConvertItemResult[] = [];
      let succeeded = 0;
      let failed = 0;
      const total = videoIds.length;
      for (let index = 0; index < total; index++) {
        const videoId = videoIds[index] ?? 0;
        try {
          const video = await db.getVideo(videoId);
          if (!video) throw new Error("動画が見つかりません");
          const extension = path.extname(video.path).toLowerCase();
          if (extension !== ".mp4" && extension !== ".m4v") {
            throw new Error("拡張子が mp4/m4v ではないため上書き変換できません");
          }
          sendOperationProgress("container-convert-progress", {
            current: index,
            total,
            message: `変換中: ${video.filename}`,
          });
          await remuxToMp4(ffmpegPath, video.path);
          try {
            await context.clearVideoHashes(videoId);
            const reprocessed = await videoScanner.processFile(video.path, true);
            if (reprocessed) await context.generateThumbnailsForSingleVideo(reprocessed);
          } catch (error) {
            logger.warn(`Remux succeeded but post-process failed for ${video.path}:`, error);
          }
          succeeded++;
          items.push({ path: video.path, ok: true });
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          const fallbackPath = (await db.getVideo(videoId))?.path ?? `(id:${videoId})`;
          items.push({ path: fallbackPath, ok: false, error: message });
        }
        sendOperationProgress("container-convert-progress", {
          current: index + 1,
          total,
          message: `変換完了 (${index + 1}/${total})`,
        });
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
    async (_event, requests: DeleteVideoRequest[], moveToTrash: boolean = true) =>
      duplicateDetector.deleteVideos(requests, moveToTrash, (current, total) => {
        getMainWindow()?.webContents.send("delete-progress", { current, total });
      }),
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
