import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import { promisify } from "util";
import { execFile } from "child_process";
import PrismaDatabaseManager, {
  type VideoScanRecord,
  type VideoRecord,
} from "../database/PrismaDatabaseManager";
import {
  ThumbnailSettings,
  ChapterThumbnail,
  ThumbnailResult,
  RegenerateResult,
  ThumbnailOptions,
} from "../types/types.js";
import { getFfmpegPath } from "../utils/ffmpeg-utils.js";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

// production ビルドではデバッグログを抑制
const logger = createLogger(app.isPackaged);

/**
 * クリーンアップ対象から除外する「直近に書き込まれたファイル」の猶予期間。
 * サムネイル生成はファイル書き込み後に DB 更新（updateVideo）を行うため、
 * その間にクリーンアップが走ると生成直後のファイルを孤立と誤判定しうる。
 */
const THUMBNAIL_CLEANUP_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5分

class ThumbnailGenerator {
  private ffmpegPath: string | null = null;
  private db: PrismaDatabaseManager;
  private thumbnailsDir: string;
  private settings: ThumbnailSettings;
  /** 1 動画あたり最大6本（メイン+チャプター）の ffmpeg を起動するため、
   * アプリ全体では同時実行数をここで制限する。 */
  private readonly maxFfmpegConcurrency = process.platform === "win32" ? 2 : 4;
  private runningFfmpeg = 0;
  private readonly ffmpegWaiters: Array<() => void> = [];

  constructor(database: PrismaDatabaseManager) {
    this.db = database;
    this.thumbnailsDir = path.join(app.getPath("userData"), "thumbnails");
    this.settings = {
      quality: 1, // 1 (best) to 31 (worst)
      width: 1280,
      height: 720,
    };

    this.ensureThumbnailsDirectory();
  }

  async initialize(): Promise<void> {
    try {
      // Get FFmpeg path asynchronously
      this.ffmpegPath = await getFfmpegPath();
      if (!this.ffmpegPath) {
        console.error("⚠️  FFmpeg binary not found!");
      } else {
        logger.log(
          "✅ ThumbnailGenerator initialized with FFmpeg:",
          this.ffmpegPath,
        );
      }
    } catch (error) {
      console.error("❌ Failed to initialize ThumbnailGenerator:", error);
    }
  }

  async ensureThumbnailsDirectory(): Promise<void> {
    try {
      await fs.access(this.thumbnailsDir);
    } catch {
      await fs.mkdir(this.thumbnailsDir, { recursive: true });
    }
  }

  private async withFfmpegSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runningFfmpeg >= this.maxFfmpegConcurrency) {
      await new Promise<void>((resolve) => this.ffmpegWaiters.push(resolve));
    }

    this.runningFfmpeg++;
    try {
      return await operation();
    } finally {
      this.runningFfmpeg--;
      this.ffmpegWaiters.shift()?.();
    }
  }

  async generateThumbnails(video: Pick<VideoScanRecord, "id" | "path" | "duration">): Promise<ThumbnailResult> {
    try {
      const videoId = video.id ?? video.path.replace(/[^a-zA-Z0-9]/g, "_");
      const mainThumbnailPath = path.join(
        this.thumbnailsDir,
        `${videoId}_main.jpg`,
      );

      // Generate main thumbnail (at 5% of video duration)
      const mainTimestamp = video.duration * 0.05;
      await this.generateSingleThumbnail(
        video.path,
        mainThumbnailPath,
        mainTimestamp,
      );

      // Generate chapter thumbnails (5 thumbnails at different timestamps) in parallel
      const chapterThumbnails: ChapterThumbnail[] = [];
      const timestamps = [0.2, 0.35, 0.5, 0.65, 0.8]; // 20%, 35%, 50%, 65%, 80%

      const chapterResults = await Promise.allSettled(
        timestamps.map((ratio, i) => {
          const timestamp = video.duration * ratio;
          const chapterPath = path.join(
            this.thumbnailsDir,
            `${videoId}_chapter_${i}.jpg`,
          );
          return this.generateSingleThumbnail(
            video.path,
            chapterPath,
            timestamp,
          ).then(() => ({ path: chapterPath, timestamp, index: i }));
        }),
      );

      for (const result of chapterResults) {
        if (result.status === "fulfilled") {
          chapterThumbnails.push(result.value);
        } else {
          console.error(
            `Failed to generate chapter thumbnail for video:`,
            video.path,
            result.reason,
          );
        }
      }

      // Update database with thumbnail paths
      await this.db.updateVideo(video.id, {
        thumbnailPath: mainThumbnailPath,
        chapterThumbnails: chapterThumbnails,
      });

      return {
        mainThumbnail: mainThumbnailPath,
        chapterThumbnails: chapterThumbnails,
      };
    } catch (error) {
      console.error(
        "Error generating thumbnails for video:",
        video.path,
        error,
      );
      throw error;
    }
  }

  async generateSingleThumbnail(
    videoPath: string,
    outputPath: string,
    timestamp: number,
    options: ThumbnailOptions = {},
  ): Promise<string> {
    // Ensure FFmpeg is initialized before use
    if (!this.ffmpegPath) {
      logger.debug("⏳ FFmpeg not initialized yet, initializing now...");
      await this.initialize();

      if (!this.ffmpegPath) {
        const error = new Error(
          "FFmpeg binary not found after initialization attempt",
        );
        console.error("❌", error);
        throw error;
      }
    }

    const defaultOptions = {
      width: this.settings.width ?? 1280,
      height: this.settings.height ?? 720,
      quality: this.settings.quality ?? 1,
      ...options,
    };

    try {
      logger.debug("🎬 Generating thumbnail:", {
        videoPath,
        outputPath,
        timestamp,
        options: defaultOptions,
      });

      // Build FFmpeg command arguments
      // Format timestamp to 1 decimal place to ensure 0.1 second precision
      const formattedTimestamp = timestamp.toFixed(1);
      const args = [
        "-ss",
        formattedTimestamp,
        "-i",
        videoPath,
        "-threads",
        process.platform === "win32" ? "2" : "0",
        "-vframes",
        "1",
        "-q:v",
        defaultOptions.quality.toString(),
        "-vf",
        `scale=${defaultOptions.width}:${defaultOptions.height}:force_original_aspect_ratio=decrease,pad=${defaultOptions.width}:${defaultOptions.height}:(ow-iw)/2:(oh-ih)/2:black`,
        "-f",
        "image2",
        "-y", // Overwrite output file
        outputPath,
      ];

      logger.debug("📝 FFmpeg command:", this.ffmpegPath, args.join(" "));

      // Use execFile instead of spawn for better error handling
      const { stderr } = await this.withFfmpegSlot(() =>
        execFileAsync(this.ffmpegPath!, args, {
          maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        }),
      );

      if (stderr) {
        logger.debug("📋 FFmpeg output:", stderr);
      }

      logger.debug("✅ Thumbnail generated successfully:", outputPath);
      return outputPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;
      const stderr =
        error instanceof Error && "stderr" in error
          ? String(error.stderr)
          : undefined;
      const stdout =
        error instanceof Error && "stdout" in error
          ? String(error.stdout)
          : undefined;
      console.error("❌ FFmpeg error:", {
        message,
        code,
        stderr,
        stdout,
      });
      throw new Error(`Failed to generate thumbnail: ${message}`);
    }
  }

  updateSettings(newSettings: Partial<ThumbnailSettings>): void {
    logger.debug("ThumbnailGenerator - Current settings:", this.settings);
    logger.debug("ThumbnailGenerator - New settings:", newSettings);
    this.settings = { ...this.settings, ...newSettings };
    logger.debug("ThumbnailGenerator - Updated settings:", this.settings);
  }

  getThumbnailPath(
    videoId: number | string,
    type: string = "main",
    index: number = 0,
  ): string | null {
    if (type === "main") {
      return path.join(this.thumbnailsDir, `${videoId}_main.jpg`);
    } else if (type === "chapter") {
      return path.join(this.thumbnailsDir, `${videoId}_chapter_${index}.jpg`);
    }
    return null;
  }

  async regenerateMainThumbnail(video: VideoRecord): Promise<RegenerateResult> {
    try {
      logger.debug("🎬 regenerateMainThumbnail: START for video:", video.path);
      logger.debug("🎬 Video ID:", video.id, "Duration:", video.duration);

      const videoId = video.id ?? video.path.replace(/[^a-zA-Z0-9]/g, "_");
      const mainThumbnailPath = path.join(
        this.thumbnailsDir,
        `${videoId}_main.jpg`,
      );

      logger.debug("🎬 Thumbnail path will be:", mainThumbnailPath);

      // Generate a random timestamp between 10% and 90% of video duration
      // Avoid the very beginning and end of the video
      const minPercent = 0.1; // 10%
      const maxPercent = 0.9; // 90%
      const randomPercent =
        minPercent + Math.random() * (maxPercent - minPercent);
      const randomTimestamp = video.duration * randomPercent;

      logger.debug(`🎬 Regenerating main thumbnail for video: ${video.path}`);
      logger.debug(
        `🎬 Random timestamp: ${this.formatTimestamp(randomTimestamp)} (${(
          randomPercent * 100
        ).toFixed(1)}%)`,
      );

      // 新しいサムネイルを生成する（generateSingleThumbnail は ffmpeg の -y で
      // 同一パスを上書きするため、旧ファイルを事前に削除する必要はない。
      // 事前削除すると ffmpeg 失敗時にサムネイルを完全に失ってしまうため、
      // 生成が成功するまで旧ファイルはそのまま残す）
      // Generate new main thumbnail at random position
      logger.debug("🎬 Calling generateSingleThumbnail...");
      await this.generateSingleThumbnail(
        video.path,
        mainThumbnailPath,
        randomTimestamp,
      );
      logger.debug("🎬 generateSingleThumbnail completed");

      // Update database with new thumbnail path
      logger.debug("🎬 Updating database...");
      await this.db.updateVideo(video.id, {
        thumbnailPath: mainThumbnailPath,
      });
      logger.debug("🎬 Database updated");

      logger.debug("✅ Successfully regenerated main thumbnail");

      return {
        thumbnailPath: mainThumbnailPath,
        timestamp: randomTimestamp,
        formattedTimestamp: this.formatTimestamp(randomTimestamp),
      };
    } catch (error) {
      console.error(
        "❌ Error regenerating main thumbnail for video:",
        video.path,
        error,
      );
      throw error;
    }
  }

  formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, "0")}`;
    }
  }

  // 不要なサムネイル画像を削除
  async cleanupThumbnails(): Promise<{
    removedFiles: number;
    totalSize: number;
  }> {
    logger.log("Starting thumbnail cleanup...");

    try {
      const validThumbnailPaths = new Set<string>();
      const REFERENCE_PAGE_SIZE = 500;

      // 有効なサムネイルパスを軽量 DTO でページング収集する。
      let afterId = 0;
      for (;;) {
        const videos = await this.db.getThumbnailReferences(REFERENCE_PAGE_SIZE, afterId);
        if (videos.length === 0) break;

        for (const video of videos) {
          if (video.thumbnailPath) validThumbnailPaths.add(video.thumbnailPath);

          if (!video.chapterThumbnails) continue;
          try {
            const parsed: unknown = JSON.parse(video.chapterThumbnails);
            if (!Array.isArray(parsed)) continue;
            for (const chapter of parsed) {
              if (
                chapter !== null &&
                typeof chapter === "object" &&
                "path" in chapter &&
                typeof chapter.path === "string"
              ) {
                validThumbnailPaths.add(chapter.path);
              }
            }
          } catch (_error) {
            logger.warn("Failed to parse chapter thumbnails during cleanup");
          }
        }
        afterId = videos[videos.length - 1]!.id;
        if (videos.length < REFERENCE_PAGE_SIZE) break;
      }

      // サムネイルディレクトリ内の全ファイルを取得
      const thumbnailDirs = [
        this.thumbnailsDir,
        path.join(path.dirname(this.thumbnailsDir), "chapters"),
      ];

      let removedFiles = 0;
      let totalSize = 0;

      for (const thumbnailDir of thumbnailDirs) {
        if (await this.directoryExists(thumbnailDir)) {
          const files = await fs.readdir(thumbnailDir);

          for (const file of files) {
            const filePath = path.join(thumbnailDir, file);
            let stats;
            try {
              stats = await fs.stat(filePath);
            } catch (error) {
              // 他プロセス（ファイル監視の unlink 処理や動画削除）との競合で
              // readdir 後にファイルが消えている場合がある。1 件のスキップに留め、
              // クリーンアップ全体を中断させない。
              console.warn("Skipping file (stat failed):", filePath, error);
              continue;
            }

            // 生成直後でまだ DB に thumbnailPath/chapterThumbnails がコミットされていない
            // ファイルを誤って「孤立ファイル」と判定して削除しないよう、
            // 直近に書き込まれたファイルは今回のクリーンアップでは対象外とする
            // （次回実行時にはコミット済みのはずなので、本当に孤立していれば削除される）
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs < THUMBNAIL_CLEANUP_GRACE_PERIOD_MS) {
              continue;
            }

            if (stats.isFile() && !validThumbnailPaths.has(filePath)) {
              try {
                totalSize += stats.size;
                await fs.unlink(filePath);
                removedFiles++;
                logger.debug("Removed orphaned thumbnail:", filePath);
              } catch (error) {
                console.error("Failed to remove file:", filePath, error);
              }
            }
          }
        }
      }

      logger.log(
        `Cleanup completed: removed ${removedFiles} files, freed ${this.formatBytes(
          totalSize,
        )}`,
      );

      return { removedFiles, totalSize };
    } catch (error) {
      console.error("Error during thumbnail cleanup:", error);
      throw error;
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

export default ThumbnailGenerator;
