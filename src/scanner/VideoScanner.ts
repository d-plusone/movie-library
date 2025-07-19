import { promises as fs } from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import DatabaseManager from "../database/DatabaseManager";

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegStatic!);
ffmpeg.setFfprobePath(ffprobeStatic.path);

interface ProcessedVideo {
  id?: number;
  path: string;
  filename: string;
  title: string;
  duration?: number;
  size: number;
  width: number;
  height: number;
  fps: number;
  codec?: string;
  bitrate: number;
  createdAt: string;
  modifiedAt: string;
  isNewVideo: boolean;
  needsThumbnails: boolean;
}

interface ExistingVideo {
  id: number;
  path: string;
  filename: string;
  title?: string;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  created_at?: string;
  modified_at?: string;
  rating: number;
  thumbnail_path?: string;
  chapter_thumbnails: string;
  description?: string;
  added_at: string;
  updated_at: string;
}

interface VideoMetadata {
  format: {
    duration?: number;
    bit_rate?: number | string;
  };
  streams: Array<{
    width?: number;
    height?: number;
    r_frame_rate?: string;
    codec_name?: string;
  }>;
}

interface ProgressCallback {
  (progress: { current: number; total: number; file: string }): void;
}

class VideoScanner {
  private db: DatabaseManager;
  private supportedExtensions: string[];

  constructor(database: DatabaseManager) {
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

  async getAllFiles(directoryPath: string): Promise<string[]> {
    const files: string[] = [];

    async function scanDir(currentPath: string): Promise<void> {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          // 隠しディレクトリやシステムディレクトリをスキップ
          if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || 
                entry.name === "__MACOSX" || 
                entry.name === "System Volume Information" ||
                entry.name === "$RECYCLE.BIN") {
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

  async processFile(filePath: string): Promise<ProcessedVideo | null> {
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

      // If video exists and hasn't been modified, skip processing
      if (
        existingVideo &&
        existingVideo.modified_at === stats.mtime.toISOString()
      ) {
        return {
          ...existingVideo,
          title: existingVideo.title || existingVideo.filename,
          size: existingVideo.size || 0,
          width: existingVideo.width || 0,
          height: existingVideo.height || 0,
          fps: existingVideo.fps || 0,
          bitrate: existingVideo.bitrate || 0,
          createdAt: existingVideo.created_at || "",
          modifiedAt: existingVideo.modified_at || "",
          isNewVideo: false,
          needsThumbnails: false,
        };
      }

      const metadata = await this.getVideoMetadata(filePath);
      const videoData = {
        path: filePath,
        filename: path.basename(filePath),
        title: path.basename(filePath, path.extname(filePath)),
        duration: metadata.format.duration,
        size: stats.size,
        width: metadata.streams[0]?.width || 0,
        height: metadata.streams[0]?.height || 0,
        fps: this.parseFps(metadata.streams[0]?.r_frame_rate),
        codec: metadata.streams[0]?.codec_name,
        bitrate: metadata.format.bit_rate
          ? typeof metadata.format.bit_rate === "string"
            ? parseInt(metadata.format.bit_rate)
            : metadata.format.bit_rate
          : 0,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
      };

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

  async checkExistingVideo(filePath: string): Promise<ExistingVideo | null> {
    return new Promise((resolve, reject) => {
      (this.db as any).db.get(
        "SELECT * FROM videos WHERE path = ?",
        [filePath],
        (err: Error | null, row: ExistingVideo | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  async getVideoMetadata(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata as unknown as VideoMetadata);
        }
      });
    });
  }

  parseFps(frameRate?: string): number {
    if (!frameRate) return 0;

    if (frameRate.includes("/")) {
      const [numerator, denominator] = frameRate.split("/").map(Number);
      return denominator ? numerator / denominator : 0;
    }

    return parseFloat(frameRate) || 0;
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
}

export default VideoScanner;
