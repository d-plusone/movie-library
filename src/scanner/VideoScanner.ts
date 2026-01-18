import { promises as fs } from "fs";
import path from "path";
import PrismaDatabaseManager, {
  type VideoRecord,
} from "../database/PrismaDatabaseManager";
import {
  VideoMetadata,
  ProgressCallback,
  ProcessedVideo,
  ScanError,
} from "../types/types.js";
import { getFfprobePath } from "../utils/ffmpeg-utils.js";

class VideoScanner {
  private db: PrismaDatabaseManager;
  private supportedExtensions: string[];
  private ffprobePath: string | null;

  constructor(database: PrismaDatabaseManager) {
    this.db = database;
    this.supportedExtensions = [
      ".mp4",
      ".avi",
      ".mkv",
      ".mov",
      ".wmv",
      ".flv",
      ".webm",
      ".m4v",
      ".mpg",
      ".mpeg",
      ".3gp",
      ".ogv",
      ".ts",
      ".mts",
      ".m2ts",
    ];
  }

  async initialize(): Promise<void> {
    // Get ffprobe path from shared utility
    this.ffprobePath = await getFfprobePath();
    console.log("VideoScanner: Using ffprobe path:", this.ffprobePath);
  }

  isVideoFile(filePath: string): boolean {
    const fileName = path.basename(filePath);

    // macOSの隠しファイル（Resource Fork）をスキップ
    if (fileName.startsWith("._")) {
      return false;
    }

    // 隠しファイル（ドットファイル）をスキップ
    if (fileName.startsWith(".")) {
      return false;
    }

    // システムファイルをスキップ
    const systemFiles = [
      ".DS_Store",
      "Thumbs.db",
      "desktop.ini",
      ".AppleDouble",
      ".localized",
    ];
    if (systemFiles.includes(fileName)) {
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(ext);
  }

  async scanDirectory(
    directoryPath: string,
    progressCallback?: ProgressCallback | null
  ): Promise<ProcessedVideo[]> {
    const videos: ProcessedVideo[] = [];
    const allFiles = await this.getAllFiles(directoryPath);
    const videoFiles = allFiles.filter((file) => this.isVideoFile(file));

    for (let i = 0; i < videoFiles.length; i++) {
      const filePath = videoFiles[i];

      if (progressCallback) {
        progressCallback({
          current: i + 1,
          total: videoFiles.length,
          file: path.basename(filePath),
        });
      }

      try {
        const video = await this.processFile(filePath);
        if (video) {
          videos.push(video);
        }
      } catch (error) {
        console.error("Error processing video file:", filePath, error);
      }
    }

    return videos;
  }

  // 改良されたディレクトリスキャン（包括的チェック）
  async comprehensiveScan(
    directories: string[],
    progressCallback?: ProgressCallback | null
  ): Promise<{
    newVideos: ProcessedVideo[];
    updatedVideos: ProcessedVideo[];
    deletedVideos: string[];
    reprocessedVideos: ProcessedVideo[];
    errors: ScanError[];
  }> {
    const result = {
      newVideos: [] as ProcessedVideo[],
      updatedVideos: [] as ProcessedVideo[],
      deletedVideos: [] as string[],
      reprocessedVideos: [] as ProcessedVideo[],
      errors: [] as ScanError[],
    };

    // 1. 現在のデータベース内の全動画を取得
    const existingVideos = await this.getAllExistingVideos();

    // 2. 現在のファイルシステムから全動画ファイルを取得
    const allCurrentFiles: string[] = [];
    for (const dir of directories) {
      const files = await this.getAllFiles(dir);
      allCurrentFiles.push(...files.filter((file) => this.isVideoFile(file)));
    }
    const currentPaths = new Set(allCurrentFiles);

    // 3. 削除された動画を検出
    for (const existingVideo of existingVideos) {
      if (!currentPaths.has(existingVideo.path)) {
        result.deletedVideos.push(existingVideo.path);
        console.log(`Detected deleted video: ${existingVideo.path}`);
      }
    }

    // 4. 問題のある動画を検出（メタデータが不完全）
    const problematicVideos = existingVideos.filter(
      (video) => currentPaths.has(video.path) && this.isVideoProblematic(video)
    );

    // 5. 新規・更新・問題動画の処理
    const totalFiles = allCurrentFiles.length + problematicVideos.length;
    let processedCount = 0;

    for (const filePath of allCurrentFiles) {
      try {
        processedCount++;
        if (progressCallback) {
          progressCallback({
            current: processedCount,
            total: totalFiles,
            file: path.basename(filePath),
          });
        }

        const existingVideo = existingVideos.find((v) => v.path === filePath);
        const stats = await fs.stat(filePath);

        if (!existingVideo) {
          // 新規動画
          const video = await this.processFile(filePath);
          if (video) {
            result.newVideos.push(video);
            console.log(`New video detected: ${filePath}`);
          }
        } else if (
          existingVideo.modifiedAt.getTime() !== stats.mtime.getTime()
        ) {
          // 更新された動画
          const video = await this.processFile(filePath);
          if (video) {
            result.updatedVideos.push(video);
            console.log(`Updated video detected: ${filePath}`);
          }
        }
      } catch (error) {
        console.error("Error processing file:", filePath, error);
        result.errors.push({
          filePath,
          error: error instanceof Error ? error.message : String(error),
          errorCode:
            error instanceof Error && "code" in error
              ? String(error.code)
              : undefined,
          timestamp: new Date(),
        });
      }
    }

    // 6. 問題のある動画を再処理
    for (const problematicVideo of problematicVideos) {
      try {
        processedCount++;
        if (progressCallback) {
          progressCallback({
            current: processedCount,
            total: totalFiles,
            file: `再処理: ${path.basename(problematicVideo.path)}`,
          });
        }

        console.log(`Reprocessing problematic video: ${problematicVideo.path}`);
        const video = await this.processFile(problematicVideo.path, true); // 強制再処理
        if (video) {
          result.reprocessedVideos.push(video);
          console.log(`Reprocessed video: ${problematicVideo.path}`);
        }
      } catch (error) {
        console.error(
          "Error reprocessing problematic video:",
          problematicVideo.path,
          error
        );
        result.errors.push({
          filePath: problematicVideo.path,
          error: error instanceof Error ? error.message : String(error),
          errorCode:
            error instanceof Error && "code" in error
              ? String(error.code)
              : undefined,
          timestamp: new Date(),
        });
      }
    }

    return result;
  }

  // 動画に問題があるかチェック
  private isVideoProblematic(video: VideoRecord): boolean {
    return (
      !video.width ||
      video.width === 0 ||
      !video.height ||
      video.height === 0 ||
      !video.duration ||
      video.duration === 0 ||
      !video.codec ||
      video.codec === "unknown" ||
      !video.fps ||
      video.fps === 0
    );
  }

  // データベース内の全動画を取得
  private async getAllExistingVideos(): Promise<VideoRecord[]> {
    try {
      // DatabaseManagerのgetVideosメソッドを使用
      return await this.db.getVideos();
    } catch (error) {
      console.error("Error getting existing videos:", error);
      throw error;
    }
  }

  async getAllFiles(directoryPath: string): Promise<string[]> {
    const files: string[] = [];

    async function scanDir(currentPath: string): Promise<void> {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          // 隠しディレクトリやシステムディレクトリをスキップ
          if (entry.isDirectory()) {
            if (
              entry.name.startsWith(".") ||
              entry.name === "__MACOSX" ||
              entry.name === "System Volume Information" ||
              entry.name === "$RECYCLE.BIN"
            ) {
              continue;
            }
            await scanDir(fullPath);
          } else if (entry.isFile()) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        console.error("Error reading directory:", currentPath, error);
      }
    }

    await scanDir(directoryPath);
    return files;
  }

  async processFile(
    filePath: string,
    forceReprocess: boolean = false
  ): Promise<ProcessedVideo | null> {
    try {
      // 再度ファイル名をチェック（念のため）
      const fileName = path.basename(filePath);
      if (fileName.startsWith("._") || fileName.startsWith(".")) {
        console.log(`Skipping hidden/system file: ${fileName}`);
        return null;
      }

      // Check if file already exists in database
      const existingVideo = await this.checkExistingVideo(filePath);
      const stats = await fs.stat(filePath);

      // If video exists and hasn't been modified, skip processing (unless forced)
      if (
        !forceReprocess &&
        existingVideo &&
        existingVideo.modifiedAt.getTime() === stats.mtime.getTime()
      ) {
        return {
          ...existingVideo,
          title: existingVideo.title || existingVideo.filename,
          size: existingVideo.size || BigInt(0),
          width: existingVideo.width || 0,
          height: existingVideo.height || 0,
          fps: existingVideo.fps || 0,
          bitrate: existingVideo.bitrate || 0,
          createdAt: existingVideo.createdAt,
          modifiedAt:
            existingVideo.modifiedAt instanceof Date
              ? existingVideo.modifiedAt
              : new Date(),
          isNewVideo: false,
          needsThumbnails: false,
        };
      }

      const metadata = await this.getVideoMetadata(filePath);

      // ビデオストリームを明示的に探す
      const videoStream = metadata.streams.find(
        (stream) => stream.codec_type === "video"
      );

      // ビデオストリームが見つからない場合は最初のストリームを使用（フォールバック）
      const streamToUse = videoStream || metadata.streams[0];

      let videoData;

      if (!streamToUse) {
        console.warn(
          `No usable stream found in file: ${filePath}, using file info only`
        );
        // ストリームが見つからない場合でも基本的なファイル情報で動画として追加
        videoData = {
          path: filePath,
          filename: path.basename(filePath),
          title: path.basename(filePath, path.extname(filePath)),
          duration: this.parseDuration(metadata.format.duration),
          size: BigInt(stats.size),
          width: 0,
          height: 0,
          fps: 0,
          codec: "unknown",
          bitrate: this.parseBitrate(metadata.format.bit_rate),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      } else {
        console.log(`Using stream for ${filePath}:`, {
          codec_type: streamToUse.codec_type,
          width: streamToUse.width,
          height: streamToUse.height,
          fps: streamToUse.r_frame_rate,
          codec: streamToUse.codec_name,
        });

        videoData = {
          path: filePath,
          filename: path.basename(filePath),
          title: path.basename(filePath, path.extname(filePath)),
          duration: this.parseDuration(metadata.format.duration),
          size: BigInt(stats.size),
          width: streamToUse.width || 0,
          height: streamToUse.height || 0,
          fps: this.parseFps(streamToUse.r_frame_rate),
          codec: streamToUse.codec_name,
          bitrate: this.parseBitrate(metadata.format.bit_rate),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      }

      const videoId = await this.db.addVideo(videoData);
      const isNewVideo = !existingVideo; // 既存動画がない場合は新規動画

      return {
        id: videoId,
        ...videoData,
        isNewVideo,
        needsThumbnails: isNewVideo, // 新規動画の場合はサムネイル生成が必要
      };
    } catch (error) {
      console.error("Error processing video file:", filePath, error);
      throw error;
    }
  }

  async checkExistingVideo(filePath: string): Promise<VideoRecord | null> {
    try {
      // DatabaseManagerのgetVideoByPathメソッドを使用
      return await this.db.getVideoByPath(filePath);
    } catch (error) {
      console.error("Error checking existing video:", error);
      throw error;
    }
  }

  async getVideoMetadata(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      if (!this.ffprobePath) {
        console.error("VideoScanner: ffprobe path not initialized");
        reject(new Error("ffprobe not found"));
        return;
      }

      const { spawn } = require("child_process");

      // Windows用の最適化オプション
      const ffprobeArgs = [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ];

      // Windows環境ではプロセス優先度を下げる
      const spawnOptions =
        process.platform === "win32"
          ? { windowsHide: true, priority: 10 } // 10 = BELOW_NORMAL_PRIORITY_CLASS
          : {};

      const ffprobe = spawn(this.ffprobePath, ffprobeArgs, spawnOptions);

      let stdout = "";
      let stderr = "";

      ffprobe.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ffprobe.on("close", (code: number) => {
        if (code !== 0) {
          console.error("FFprobe error for file:", filePath, stderr);
          console.error("VideoScanner: ffprobe path was:", this.ffprobePath);
          reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
        } else {
          try {
            const metadata = JSON.parse(stdout);
            console.log("FFprobe metadata for:", path.basename(filePath), {
              streamsCount: metadata.streams?.length || 0,
              streams: metadata.streams?.map((s) => ({
                index: s.index,
                codec_type: s.codec_type,
                codec_name: s.codec_name,
                width: s.width,
                height: s.height,
                r_frame_rate: s.r_frame_rate,
                duration: s.duration,
              })),
            });
            resolve(metadata as VideoMetadata);
          } catch (parseError) {
            console.error(
              "Failed to parse FFprobe output:",
              parseError,
              stdout
            );
            reject(parseError);
          }
        }
      });

      ffprobe.on("error", (error: Error) => {
        console.error("FFprobe spawn error for file:", filePath, error);
        console.error("VideoScanner: ffprobe path was:", this.ffprobePath);
        reject(error);
      });
    });
  }

  parseFps(frameRate?: string): number {
    if (!frameRate) {
      console.warn("Frame rate is undefined or empty");
      return 0;
    }

    try {
      // Handle different frame rate formats
      if (frameRate.includes("/")) {
        const [numerator, denominator] = frameRate.split("/").map(Number);
        if (denominator === 0) {
          console.warn("Frame rate denominator is 0:", frameRate);
          return 0;
        }
        const fps = numerator / denominator;
        console.log(`Parsed frame rate: ${frameRate} = ${fps.toFixed(2)} fps`);
        return Math.round(fps * 100) / 100; // 小数点2桁で丸める
      } else {
        const fps = parseFloat(frameRate);
        console.log(`Parsed frame rate: ${frameRate} = ${fps.toFixed(2)} fps`);
        return isNaN(fps) ? 0 : Math.round(fps * 100) / 100;
      }
    } catch (error) {
      console.error("Error parsing frame rate:", frameRate, error);
      return 0;
    }
  }

  parseDuration(duration?: number | string): number {
    if (!duration) return 0;

    if (typeof duration === "string") {
      const parsed = parseFloat(duration);
      return isNaN(parsed) ? 0 : parsed;
    }

    return duration;
  }

  parseBitrate(bitrate?: number | string): number {
    if (!bitrate) return 0;

    if (typeof bitrate === "string") {
      const parsed = parseInt(bitrate);
      return isNaN(parsed) ? 0 : parsed;
    }

    return bitrate;
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return "00:00:00";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // 全ての動画を強制的に再スキャンするメソッド
  async forceRescanAllVideos(
    directories: string[],
    progressCallback?: ProgressCallback | null
  ): Promise<{
    processedVideos: ProcessedVideo[];
    updatedVideos: ProcessedVideo[];
    deletedVideos: string[];
    totalProcessed: number;
    totalUpdated: number;
    totalErrors: number;
    errors: ScanError[];
  }> {
    const result = {
      processedVideos: [] as ProcessedVideo[],
      updatedVideos: [] as ProcessedVideo[],
      deletedVideos: [] as string[],
      totalProcessed: 0,
      totalUpdated: 0,
      totalErrors: 0,
      errors: [] as ScanError[],
    };

    console.log(
      "Starting force rescan of all videos in directories:",
      directories
    );

    // 1. 現在のデータベース内の全動画を取得
    const existingVideos = await this.getAllExistingVideos();

    // 2. 現在のファイルシステムから全動画ファイルを取得
    const allCurrentFiles: string[] = [];
    for (const dir of directories) {
      const files = await this.getAllFiles(dir);
      allCurrentFiles.push(...files.filter((file) => this.isVideoFile(file)));
    }
    const currentPaths = new Set(allCurrentFiles);

    // 3. 削除された動画を検出
    for (const existingVideo of existingVideos) {
      if (!currentPaths.has(existingVideo.path)) {
        result.deletedVideos.push(existingVideo.path);
        console.log(`Detected deleted video: ${existingVideo.path}`);
      }
    }

    // 4. 存在する全ての動画ファイルを強制的に再処理
    const totalFiles = allCurrentFiles.length;
    let processedCount = 0;

    for (const filePath of allCurrentFiles) {
      try {
        processedCount++;
        result.totalProcessed++;

        // プログレスコールバック呼び出し
        if (progressCallback) {
          progressCallback({
            current: processedCount,
            total: totalFiles,
            file: path.basename(filePath),
          });
        }

        console.log(
          `Force rescanning video ${processedCount}/${totalFiles}: ${filePath}`
        );

        // 既存の動画データがあるかチェック
        const existingVideo = existingVideos.find((v) => v.path === filePath);

        // ファイルを強制的に再処理（既存データがあっても無視）
        const video = await this.processFile(filePath, true); // 強制処理フラグを追加

        if (video) {
          result.processedVideos.push(video);

          // 既存データと比較して更新があったかチェック
          if (existingVideo) {
            // メタデータの違いをチェック
            const hasChanges =
              existingVideo.duration !== video.duration ||
              existingVideo.width !== video.width ||
              existingVideo.height !== video.height ||
              existingVideo.size !== video.size ||
              existingVideo.title !== video.title;

            if (hasChanges) {
              result.updatedVideos.push(video);
              result.totalUpdated++;
              console.log(`Video metadata updated: ${filePath}`);
            }
          } else {
            // 新しい動画として扱う
            result.updatedVideos.push(video);
            result.totalUpdated++;
            console.log(`New video processed: ${filePath}`);
          }
        }
      } catch (error) {
        result.totalErrors++;
        console.error(`Error processing video file: ${filePath}`, error);
        result.errors.push({
          filePath,
          error: error instanceof Error ? error.message : String(error),
          errorCode:
            error instanceof Error && "code" in error
              ? String(error.code)
              : undefined,
          timestamp: new Date(),
        });
      }
    }

    console.log("Force rescan completed:", {
      totalProcessed: result.totalProcessed,
      totalUpdated: result.totalUpdated,
      totalErrors: result.totalErrors,
      deletedVideos: result.deletedVideos.length,
    });

    return result;
  }
}

export default VideoScanner;
