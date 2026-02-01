import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import { promisify } from "util";
import { execFile } from "child_process";
import PrismaDatabaseManager, {
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

const execFileAsync = promisify(execFile);

class ThumbnailGenerator {
  private ffmpegPath: string | null = null;
  private db: PrismaDatabaseManager;
  private thumbnailsDir: string;
  private settings: ThumbnailSettings;

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
        console.log(
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

  async generateThumbnails(video: VideoRecord): Promise<ThumbnailResult> {
    try {
      const videoId = video.id || video.path.replace(/[^a-zA-Z0-9]/g, "_");
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

      // Generate chapter thumbnails (5 thumbnails at different timestamps)
      const chapterThumbnails: ChapterThumbnail[] = [];
      const timestamps = [0.2, 0.35, 0.5, 0.65, 0.8]; // 20%, 35%, 50%, 65%, 80%

      for (let i = 0; i < timestamps.length; i++) {
        const timestamp = video.duration * timestamps[i];
        const chapterPath = path.join(
          this.thumbnailsDir,
          `${videoId}_chapter_${i}.jpg`,
        );

        try {
          await this.generateSingleThumbnail(
            video.path,
            chapterPath,
            timestamp,
          );
          chapterThumbnails.push({
            path: chapterPath,
            timestamp: timestamp,
            index: i,
          });
        } catch (error) {
          console.error(
            `Failed to generate chapter thumbnail ${i} for video:`,
            video.path,
            error,
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
      console.log("⏳ FFmpeg not initialized yet, initializing now...");
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
      width: this.settings.width,
      height: this.settings.height,
      quality: this.settings.quality,
      ...options,
    };

    try {
      console.log("🎬 Generating thumbnail:", {
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

      console.log("📝 FFmpeg command:", this.ffmpegPath, args.join(" "));

      // Use execFile instead of spawn for better error handling
      const { stderr } = await execFileAsync(this.ffmpegPath, args, {
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      });

      if (stderr) {
        console.log("📋 FFmpeg output:", stderr);
      }

      console.log("✅ Thumbnail generated successfully:", outputPath);
      return outputPath;
    } catch (error: any) {
      console.error("❌ FFmpeg error:", {
        message: error.message,
        code: error.code,
        stderr: error.stderr,
        stdout: error.stdout,
      });
      throw new Error(`Failed to generate thumbnail: ${error.message}`);
    }
  }

  updateSettings(newSettings: Partial<ThumbnailSettings>): void {
    console.log("ThumbnailGenerator - Current settings:", this.settings);
    console.log("ThumbnailGenerator - New settings:", newSettings);
    this.settings = { ...this.settings, ...newSettings };
    console.log("ThumbnailGenerator - Updated settings:", this.settings);
  }

  async generateHighQualityThumbnail(
    videoPath: string,
    outputPath: string,
    timestamp: number,
  ): Promise<string> {
    return this.generateSingleThumbnail(videoPath, outputPath, timestamp, {
      width: 640,
      height: 360,
      quality: 2,
    });
  }

  async deleteThumbnails(video: VideoRecord): Promise<void> {
    try {
      // Delete main thumbnail
      if (video.thumbnailPath) {
        try {
          await fs.unlink(video.thumbnailPath);
        } catch (error) {
          console.error("Error deleting main thumbnail:", error);
        }
      }

      // Delete chapter thumbnails
      if (video.chapterThumbnails) {
        const chapterThumbnails = Array.isArray(video.chapterThumbnails)
          ? video.chapterThumbnails
          : JSON.parse(video.chapterThumbnails as string);
        for (const chapter of chapterThumbnails) {
          try {
            await fs.unlink(chapter.path);
          } catch (error) {
            console.error("Error deleting chapter thumbnail:", error);
          }
        }
      }
    } catch (error) {
      console.error("Error deleting thumbnails for video:", video.path, error);
    }
  }

  async cleanupOrphanedThumbnails(): Promise<void> {
    try {
      const files = await fs.readdir(this.thumbnailsDir);
      const videos = await this.db.getVideos();

      const usedThumbnails = new Set<string>();

      // Collect all used thumbnail paths
      for (const video of videos) {
        if (video.thumbnailPath) {
          usedThumbnails.add(path.basename(video.thumbnailPath));
        }

        if (video.chapterThumbnails) {
          const chapterThumbnails = Array.isArray(video.chapterThumbnails)
            ? video.chapterThumbnails
            : JSON.parse(video.chapterThumbnails as string);
          for (const chapter of chapterThumbnails) {
            usedThumbnails.add(path.basename(chapter.path));
          }
        }
      }

      // Delete orphaned files
      for (const file of files) {
        if (!usedThumbnails.has(file)) {
          try {
            await fs.unlink(path.join(this.thumbnailsDir, file));
            console.log("Deleted orphaned thumbnail:", file);
          } catch (error) {
            console.error("Error deleting orphaned thumbnail:", file, error);
          }
        }
      }
    } catch (error) {
      console.error("Error cleaning up orphaned thumbnails:", error);
    }
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

  async thumbnailExists(thumbnailPath: string): Promise<boolean> {
    try {
      await fs.access(thumbnailPath);
      return true;
    } catch {
      return false;
    }
  }

  async regenerateMainThumbnail(video: VideoRecord): Promise<RegenerateResult> {
    try {
      console.log("🎬 regenerateMainThumbnail: START for video:", video.path);
      console.log("🎬 Video ID:", video.id, "Duration:", video.duration);

      const videoId = video.id || video.path.replace(/[^a-zA-Z0-9]/g, "_");
      const mainThumbnailPath = path.join(
        this.thumbnailsDir,
        `${videoId}_main.jpg`,
      );

      console.log("🎬 Thumbnail path will be:", mainThumbnailPath);

      // Generate a random timestamp between 10% and 90% of video duration
      // Avoid the very beginning and end of the video
      const minPercent = 0.1; // 10%
      const maxPercent = 0.9; // 90%
      const randomPercent =
        minPercent + Math.random() * (maxPercent - minPercent);
      const randomTimestamp = video.duration * randomPercent;

      console.log(`🎬 Regenerating main thumbnail for video: ${video.path}`);
      console.log(
        `🎬 Random timestamp: ${this.formatTimestamp(randomTimestamp)} (${(
          randomPercent * 100
        ).toFixed(1)}%)`,
      );

      // Delete the old thumbnail if it exists
      if (await this.thumbnailExists(mainThumbnailPath)) {
        try {
          console.log("🎬 Deleting old thumbnail...");
          await fs.unlink(mainThumbnailPath);
          console.log("🎬 Deleted old main thumbnail");
        } catch (error) {
          console.warn(
            "⚠️  Could not delete old thumbnail:",
            (error as Error).message,
          );
        }
      }

      // Generate new main thumbnail at random position
      console.log("🎬 Calling generateSingleThumbnail...");
      await this.generateSingleThumbnail(
        video.path,
        mainThumbnailPath,
        randomTimestamp,
      );
      console.log("🎬 generateSingleThumbnail completed");

      // Update database with new thumbnail path
      console.log("🎬 Updating database...");
      await this.db.updateVideo(video.id, {
        thumbnailPath: mainThumbnailPath,
      });
      console.log("🎬 Database updated");

      console.log("✅ Successfully regenerated main thumbnail");

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
    console.log("Starting thumbnail cleanup...");

    try {
      // データベースから全動画を取得
      const videos = await this.db.getVideos();
      const validThumbnailPaths = new Set<string>();

      // 有効なサムネイルパスを収集
      for (const video of videos) {
        if (
          video.thumbnailPath &&
          (await this.fileExists(video.thumbnailPath))
        ) {
          validThumbnailPaths.add(video.thumbnailPath);
        }

        // チャプターサムネイルも収集
        if (video.chapterThumbnails) {
          try {
            const chapters = Array.isArray(video.chapterThumbnails)
              ? video.chapterThumbnails
              : JSON.parse(video.chapterThumbnails as string);

            if (Array.isArray(chapters)) {
              for (const chapter of chapters) {
                const chapterPath = chapter.path;
                if (chapterPath && (await this.fileExists(chapterPath))) {
                  validThumbnailPaths.add(chapterPath);
                }
              }
            }
          } catch (_error) {
            console.warn(
              "Failed to parse chapter thumbnails for video:",
              video.id,
            );
          }
        }
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
            const stats = await fs.stat(filePath);

            if (stats.isFile() && !validThumbnailPaths.has(filePath)) {
              try {
                totalSize += stats.size;
                await fs.unlink(filePath);
                removedFiles++;
                console.log("Removed orphaned thumbnail:", filePath);
              } catch (error) {
                console.error("Failed to remove file:", filePath, error);
              }
            }
          }
        }
      }

      console.log(
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

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
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
