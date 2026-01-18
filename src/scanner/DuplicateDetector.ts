import { createHash } from "crypto";
import { promises as fs } from "fs";
import PrismaDatabaseManager from "../database/PrismaDatabaseManager.js";

export interface DuplicateGroup {
  videos: Array<{
    id: number;
    path: string;
    filename: string;
    size: bigint;
    width: number;
    height: number;
    duration: number;
    partialHash: string;
    thumbnailPath: string | null;
  }>;
  hash: string;
}

export default class DuplicateDetector {
  private db: PrismaDatabaseManager;
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks for partial hash

  constructor(db: PrismaDatabaseManager) {
    this.db = db;
  }

  /**
   * Calculate partial hash of a file (beginning, middle, end)
   * Much faster than full file hash
   */
  private async calculatePartialHash(filePath: string): Promise<string> {
    const hash = createHash("md5");
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;

    // For small files, hash the entire file
    if (fileSize < this.CHUNK_SIZE * 3) {
      const buffer = await fs.readFile(filePath);
      hash.update(buffer);
      return hash.digest("hex");
    }

    // For larger files, hash: beginning + middle + end
    const file = await fs.open(filePath, "r");
    try {
      const positions = [
        0, // Beginning
        Math.floor(fileSize / 2 - this.CHUNK_SIZE / 2), // Middle
        fileSize - this.CHUNK_SIZE, // End
      ];

      for (const position of positions) {
        const buffer = Buffer.alloc(this.CHUNK_SIZE);
        await file.read(buffer, 0, this.CHUNK_SIZE, position);
        hash.update(buffer);
      }
    } finally {
      await file.close();
    }

    return hash.digest("hex");
  }

  /**
   * Update partial hash for videos that don't have it yet
   */
  async updatePartialHashes(
    onProgress?: (current: number, total: number) => void,
  ): Promise<void> {
    const videos = await this.db.prisma.video.findMany({
      where: { partialHash: null },
      select: { id: true, path: true },
    });

    console.log(`Calculating partial hashes for ${videos.length} videos...`);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      try {
        // Check if file still exists
        await fs.access(video.path);

        const partialHash = await this.calculatePartialHash(video.path);
        await this.db.prisma.video.update({
          where: { id: video.id },
          data: { partialHash },
        });

        if (onProgress) {
          onProgress(i + 1, videos.length);
        }
      } catch (error) {
        console.error(`Failed to hash ${video.path}:`, error);
      }
    }

    console.log(`✅ Updated ${videos.length} partial hashes`);
  }

  /**
   * Find duplicate videos based on size, duration, and partial hash
   */
  async findDuplicates(
    onProgress?: (current: number, total: number, message: string) => void,
  ): Promise<DuplicateGroup[]> {
    // First, ensure all videos have partial hashes
    onProgress?.(0, 3, "部分ハッシュを更新中...");
    await this.updatePartialHashes();

    // Get all videos
    onProgress?.(1, 3, "動画情報を取得中...");
    const videos = await this.db.prisma.video.findMany({
      where: {
        partialHash: { not: null },
      },
      select: {
        id: true,
        path: true,
        filename: true,
        size: true,
        width: true,
        height: true,
        duration: true,
        partialHash: true,
        thumbnailPath: true,
      },
    });

    // Group by: size + duration + partialHash
    onProgress?.(2, 3, "重複を検索中...");
    const groups = new Map<string, typeof videos>();

    for (const video of videos) {
      if (!video.partialHash) continue;

      // Create composite key
      const key = `${video.size}_${video.duration}_${video.partialHash}`;

      const group = groups.get(key) || [];
      group.push(video);
      groups.set(key, group);
    }

    // Filter to only groups with 2+ videos
    const duplicateGroups: DuplicateGroup[] = [];

    for (const [hash, videoGroup] of groups.entries()) {
      if (videoGroup.length >= 2) {
        duplicateGroups.push({
          hash,
          videos: videoGroup,
        });
      }
    }

    console.log(`Found ${duplicateGroups.length} duplicate groups`);
    onProgress?.(3, 3, "完了");
    return duplicateGroups;
  }

  /**
   * Delete a video file and its database entry
   */
  async deleteVideo(
    videoId: number,
    moveToTrash: boolean = true,
  ): Promise<void> {
    const video = await this.db.prisma.video.findUnique({
      where: { id: videoId },
      select: { path: true, thumbnailPath: true },
    });

    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }

    try {
      // Delete or move to trash
      if (moveToTrash) {
        const { shell } = await import("electron");
        await shell.trashItem(video.path);
      } else {
        await fs.unlink(video.path);
      }

      // Delete thumbnail if exists
      if (video.thumbnailPath) {
        try {
          await fs.unlink(video.thumbnailPath);
        } catch (error) {
          console.warn(`Failed to delete thumbnail: ${error}`);
        }
      }

      // Delete from database
      await this.db.prisma.video.delete({
        where: { id: videoId },
      });

      console.log(`✅ Deleted video ${videoId}: ${video.path}`);
    } catch (error) {
      console.error(`Failed to delete video ${videoId}:`, error);
      throw error;
    }
  }

  /**
   * Delete multiple videos at once
   */
  async deleteVideos(
    videoIds: number[],
    moveToTrash: boolean = true,
    onProgress?: (current: number, total: number) => void,
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (let i = 0; i < videoIds.length; i++) {
      try {
        await this.deleteVideo(videoIds[i], moveToTrash);
        success++;
      } catch (error) {
        console.error(`Failed to delete video ${videoIds[i]}:`, error);
        failed++;
      }

      if (onProgress) {
        onProgress(i + 1, videoIds.length);
      }
    }

    return { success, failed };
  }
}
