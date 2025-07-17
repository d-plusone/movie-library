const fs = require("fs").promises;
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

class VideoScanner {
  constructor(database) {
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

  isVideoFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(ext);
  }

  async scanDirectory(directoryPath, progressCallback = null) {
    const videos = [];
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

  async getAllFiles(directoryPath) {
    const files = [];

    async function scanDir(currentPath) {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          if (entry.isDirectory()) {
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

  async processFile(filePath) {
    try {
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
          isNewVideo: false,
          needsThumbnails: false 
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
          ? parseInt(metadata.format.bit_rate)
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
        needsThumbnails: isNewVideo // 新規動画の場合はサムネイル生成が必要
      };
    } catch (error) {
      console.error("Error processing video file:", filePath, error);
      throw error;
    }
  }

  async checkExistingVideo(filePath) {
    return new Promise((resolve, reject) => {
      this.db.db.get(
        "SELECT * FROM videos WHERE path = ?",
        [filePath],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      });
    });
  }

  parseFps(frameRate) {
    if (!frameRate) return 0;

    if (frameRate.includes("/")) {
      const [numerator, denominator] = frameRate.split("/").map(Number);
      return denominator ? numerator / denominator : 0;
    }

    return parseFloat(frameRate) || 0;
  }

  formatDuration(seconds) {
    if (!seconds) return "00:00:00";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

module.exports = VideoScanner;
