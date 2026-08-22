import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { app } from "electron";
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
import {
  parseBitrateValue,
  parseDurationValue,
  parseFrameRate,
} from "../utils/media-parsers.js";
import { createLogger } from "../utils/logger.js";

// production ビルドではデバッグログを抑制
const logger = createLogger(app.isPackaged);

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
    // initialize() で遅延設定される
    this.ffprobePath = null;
  }

  async initialize(): Promise<void> {
    // Get ffprobe path from shared utility
    this.ffprobePath = await getFfprobePath();
    logger.debug("VideoScanner: Using ffprobe path:", this.ffprobePath);
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

  /**
   * スキャン系メソッド共通の前処理:
   * 1. DB 内の全動画を取得する
   * 2. ファイルシステムから動画ファイルを列挙する（アクセス不能ディレクトリはスキップして errors に記録）
   * 3. アクセスできたディレクトリ配下で消えた動画を削除対象として検出する
   *    （アクセス不能ディレクトリの動画を誤削除しないための保護）
   *
   * @param contextLabel ログ用ラベル（"scan" / "rescan"）
   */
  private async collectScanState(
    directories: string[],
    errors: ScanError[],
    contextLabel: string,
  ): Promise<{
    existingVideos: VideoRecord[];
    allCurrentFiles: string[];
    currentFilePaths: Set<string>;
    deletedPaths: string[];
  }> {
    // 現在のデータベース内の全動画を取得
    const existingVideos = await this.getAllExistingVideos();

    // 現在のファイルシステムから全動画ファイルを取得
    const allCurrentFiles: string[] = [];
    const scannedDirs = new Set<string>();

    for (const dir of directories) {
      try {
        await fs.access(dir);
        const files = await this.getAllFiles(dir);
        allCurrentFiles.push(...files.filter((file) => this.isVideoFile(file)));
        scannedDirs.add(dir);
      } catch (error) {
        console.warn(
          `Skipping inaccessible directory during ${contextLabel}: ${dir}`,
          error,
        );
        errors.push({
          filePath: dir,
          error: `Directory inaccessible: ${error instanceof Error ? error.message : String(error)}`,
          errorCode:
            error instanceof Error && "code" in error
              ? String(error.code)
              : undefined,
          timestamp: new Date(),
        });
      }
    }

    const currentFilePaths = new Set(allCurrentFiles);
    const deletedPaths: string[] = [];

    for (const existingVideo of existingVideos) {
      if (!currentFilePaths.has(existingVideo.path)) {
        const belongsToScannedDir = [...scannedDirs].some(
          (dir) =>
            existingVideo.path.startsWith(dir + "/") ||
            existingVideo.path.startsWith(dir + "\\"),
        );
        if (belongsToScannedDir) {
          deletedPaths.push(existingVideo.path);
          logger.debug(`Detected deleted video: ${existingVideo.path}`);
        }
      }
    }

    return { existingVideos, allCurrentFiles, currentFilePaths, deletedPaths };
  }

  // 改良されたディレクトリスキャン（包括的チェック）
  async comprehensiveScan(
    directories: string[],
    progressCallback?: ProgressCallback | null,
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

    // 1-3. DB / FS の状態収集と削除検出（forceRescanAllVideos と共通の前処理）
    const { existingVideos, allCurrentFiles, currentFilePaths, deletedPaths } =
      await this.collectScanState(directories, result.errors, "scan");
    result.deletedVideos.push(...deletedPaths);

    // 4. 問題のある動画を検出（メタデータが不完全）
    const problematicVideos = existingVideos.filter(
      (video) =>
        currentFilePaths.has(video.path) && this.isVideoProblematic(video),
    );

    // 5. 新規・更新・問題動画の処理
    const existingVideoMap = new Map(existingVideos.map((v) => [v.path, v]));
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

        const existingVideo = existingVideoMap.get(filePath);
        const stats = await fs.stat(filePath);

        if (!existingVideo) {
          // 新規動画
          const video = await this.processFile(filePath);
          if (video) {
            result.newVideos.push(video);
            logger.debug(`New video detected: ${filePath}`);
          }
        } else if (
          existingVideo.modifiedAt?.getTime() !== stats.mtime.getTime()
        ) {
          // 更新された動画
          const video = await this.processFile(filePath);
          if (video) {
            result.updatedVideos.push(video);
            logger.debug(`Updated video detected: ${filePath}`);
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

        logger.debug(
          `Reprocessing problematic video: ${problematicVideo.path}`,
        );
        const video = await this.processFile(problematicVideo.path, true); // 強制再処理
        if (video) {
          result.reprocessedVideos.push(video);
          logger.debug(`Reprocessed video: ${problematicVideo.path}`);
        }
      } catch (error) {
        console.error(
          "Error reprocessing problematic video:",
          problematicVideo.path,
          error,
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
    forceReprocess: boolean = false,
  ): Promise<ProcessedVideo | null> {
    try {
      // 再度ファイル名をチェック（念のため）
      const fileName = path.basename(filePath);
      if (fileName.startsWith("._") || fileName.startsWith(".")) {
        logger.debug(`Skipping hidden/system file: ${fileName}`);
        return null;
      }

      // Check if file already exists in database
      const existingVideo = await this.checkExistingVideo(filePath);
      const stats = await fs.stat(filePath);

      // If video exists and hasn't been modified, skip processing (unless forced)
      if (
        !forceReprocess &&
        existingVideo &&
        existingVideo.modifiedAt?.getTime() === stats.mtime.getTime()
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
        (stream) => stream.codec_type === "video",
      );

      // ビデオストリームが見つからない場合は最初のストリームを使用（フォールバック）
      const streamToUse = videoStream || metadata.streams[0];

      let videoData;

      if (!streamToUse) {
        console.warn(
          `No usable stream found in file: ${filePath}, using file info only`,
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
          addedAt: new Date(),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      } else {
        logger.debug(`Using stream for ${filePath}:`, {
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
          addedAt: new Date(),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      }

      const videoId = await this.db.addVideo(videoData);
      const isNewVideo = !existingVideo; // 既存動画がない場合は新規動画

      // VideoCreateData の文字列日付を Date に変換して ProcessedVideo として返す
      return {
        id: videoId,
        ...videoData,
        addedAt: videoData.addedAt ?? new Date(),
        modifiedAt: videoData.modifiedAt
          ? new Date(videoData.modifiedAt)
          : new Date(),
        createdAt: videoData.createdAt
          ? new Date(videoData.createdAt)
          : undefined,
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

      const ffprobeArgs = [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ];

      // Windows環境ではコンソールウィンドウを表示しない
      const spawnOptions =
        process.platform === "win32" ? { windowsHide: true } : {};

      const ffprobe = spawn(this.ffprobePath, ffprobeArgs, spawnOptions);

      let stdout = "";
      let stderr = "";
      // 起動失敗（error イベント）と終了（close イベント）の二重 reject を防ぐ
      let settled = false;

      ffprobe.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // バイナリの起動失敗（存在しない・dylib ロード失敗など）を捕捉
      ffprobe.on("error", (err: Error) => {
        console.error("FFprobe failed to start:", err.message);
        console.error("VideoScanner: ffprobe path was:", this.ffprobePath);
        if (!settled) {
          settled = true;
          reject(new Error(`FFprobe failed to start: ${err.message}`));
        }
      });

      ffprobe.on("close", (code: number | null) => {
        if (code !== 0) {
          if (!settled) {
            settled = true;
            console.error("FFprobe error for file:", filePath, stderr);
            console.error("VideoScanner: ffprobe path was:", this.ffprobePath);
            reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
          }
        } else {
          if (settled) {
            return;
          }
          settled = true;
          try {
            const metadata = JSON.parse(stdout) as VideoMetadata;
            logger.debug("FFprobe metadata for:", path.basename(filePath), {
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
              stdout,
            );
            reject(parseError);
          }
        }
      });
    });
  }

  parseFps(frameRate?: string): number {
    return parseFrameRate(frameRate);
  }

  parseDuration(duration?: number | string): number {
    return parseDurationValue(duration);
  }

  parseBitrate(bitrate?: number | string): number {
    return parseBitrateValue(bitrate);
  }

  // 全ての動画を強制的に再スキャンするメソッド
  async forceRescanAllVideos(
    directories: string[],
    progressCallback?: ProgressCallback | null,
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

    logger.log(
      "Starting force rescan of all videos in directories:",
      directories,
    );

    // 1-3. DB / FS の状態収集と削除検出（comprehensiveScan と共通の前処理）
    const { existingVideos, allCurrentFiles, deletedPaths } =
      await this.collectScanState(directories, result.errors, "rescan");
    result.deletedVideos.push(...deletedPaths);

    // 4. 存在する全ての動画ファイルを強制的に再処理
    const existingVideoMap = new Map(existingVideos.map((v) => [v.path, v]));
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

        logger.debug(
          `Force rescanning video ${processedCount}/${totalFiles}: ${filePath}`,
        );

        // 既存の動画データがあるかチェック
        const existingVideo = existingVideoMap.get(filePath);

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
              logger.debug(`Video metadata updated: ${filePath}`);
            }
          } else {
            // 新しい動画として扱う
            result.updatedVideos.push(video);
            result.totalUpdated++;
            logger.debug(`New video processed: ${filePath}`);
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

    logger.log("Force rescan completed:", {
      totalProcessed: result.totalProcessed,
      totalUpdated: result.totalUpdated,
      totalErrors: result.totalErrors,
      deletedVideos: result.deletedVideos.length,
    });

    return result;
  }
}

export default VideoScanner;
