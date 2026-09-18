import { createHash } from "crypto";
import { promises as fs } from "fs";
import { app } from "electron";
import PrismaDatabaseManager, {
  type DuplicateDetectionRecord,
} from "../database/PrismaDatabaseManager.js";
import { createLogger } from "../utils/logger.js";

// production ビルドではデバッグログを抑制
const logger = createLogger(app?.isPackaged ?? false);

/** ファイル比較時に一度に読み込むバイト数 */
const COMPARE_CHUNK_SIZE = 1024 * 1024; // 1MB

/** chapterThumbnails JSON の安全なパース（DB 層と同等。壊れた行で落とさない） */
function safeParseChapterThumbnailPaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const paths: string[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "path" in entry &&
        typeof (entry as { path: unknown }).path === "string"
      ) {
        paths.push((entry as { path: string }).path);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * 2 つのファイルが完全に同一（バイト単位）かどうかを判定する。
 * findDuplicates の重複判定はサイズ+再生時間+先頭/中央/末尾のみの部分ハッシュという
 * 確率的な近似でしかなく、別の動画が偶然衝突する可能性があるため、
 * 実際にファイルを削除する前の最終確認として必ずこれを通す。
 */
async function filesAreIdentical(pathA: string, pathB: string): Promise<boolean> {
  const handleA = await fs.open(pathA, "r");
  try {
    const handleB = await fs.open(pathB, "r");
    try {
      const [statA, statB] = await Promise.all([handleA.stat(), handleB.stat()]);
      if (statA.size !== statB.size) return false;

      const bufA = Buffer.alloc(COMPARE_CHUNK_SIZE);
      const bufB = Buffer.alloc(COMPARE_CHUNK_SIZE);
      let position = 0;
      while (position < statA.size) {
        const want = Math.min(COMPARE_CHUNK_SIZE, statA.size - position);
        const [{ bytesRead: readA }, { bytesRead: readB }] = await Promise.all([
          handleA.read(bufA, 0, want, position),
          handleB.read(bufB, 0, want, position),
        ]);
        if (
          readA !== readB ||
          !bufA.subarray(0, readA).equals(bufB.subarray(0, readB))
        ) {
          return false;
        }
        position += readA;
      }
      return true;
    } finally {
      await handleB.close();
    }
  } finally {
    await handleA.close();
  }
}

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
  private readonly HASH_CONCURRENCY = 4;
  /** 検索ごとの世代。新しい検索開始・キャンセルで世代を進める。 */
  private searchGeneration = 0;

  constructor(db: PrismaDatabaseManager) {
    this.db = db;
  }

  cancelSearch(): void {
    this.searchGeneration++;
  }

  private throwIfCancelled(generation: number): void {
    if (this.searchGeneration !== generation) {
      throw new Error("DUPLICATE_SEARCH_CANCELLED");
    }
  }

  private isCancelled(generation: number): boolean {
    return this.searchGeneration !== generation;
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
    generation: number,
    onProgress?: (current: number, total: number) => void,
  ): Promise<void> {
    const PAGE_SIZE = 500;
    const total = await this.db.prisma.video.count({
      where: { partialHash: null },
    });
    let completed = 0;
    let afterId = 0;
    onProgress?.(completed, total);
    for (;;) {
      const videos = await this.db.getVideosWithoutPartialHashPage(
        PAGE_SIZE,
        afterId,
      );
      if (videos.length === 0) break;
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          this.throwIfCancelled(generation);
          const index = nextIndex++;
          if (index >= videos.length) return;
          const video = videos[index]!;
          try {
            await fs.access(video.path);
            const partialHash = await this.calculatePartialHash(video.path);
            this.throwIfCancelled(generation);
            await this.db.prisma.video.update({
              where: { id: video.id },
              data: { partialHash },
            });
          } catch (error) {
            if (this.isCancelled(generation)) throw error;
            console.error(`Failed to hash ${video.path}:`, error);
          } finally {
            completed++;
            onProgress?.(completed, total);
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(this.HASH_CONCURRENCY, videos.length) },
          () => worker(),
        ),
      );
      afterId = videos[videos.length - 1]!.id;
      if (videos.length < PAGE_SIZE) break;
    }

    logger.debug(`Calculated partial hashes for ${completed}/${total} videos`);
  }

  /**
   * Find duplicate videos based on size, duration, and partial hash
   */
  async findDuplicates(
    onProgress?: (
      current: number,
      total: number,
      message: string,
      detailCurrent?: number,
      detailTotal?: number,
    ) => void,
  ): Promise<DuplicateGroup[]> {
    // 新しい検索を開始した時点で、前の検索はキャンセル扱いにする。
    // boolean フラグだと「閉じる→すぐ再度開く」で古い検索が復活してしまう。
    const generation = ++this.searchGeneration;
    this.throwIfCancelled(generation);
    // First, ensure all videos have partial hashes
    onProgress?.(0, 3, "部分ハッシュを更新中...");
    await this.updatePartialHashes(generation, (current, total) => {
      onProgress?.(0, 3, "部分ハッシュを更新中...", current, total);
    });
    this.throwIfCancelled(generation);

    // 動画情報をページ単位で取得し、グループMapだけを保持する
    onProgress?.(1, 3, "動画情報を取得中...");
    const PAGE_SIZE = 500;
    const groups = new Map<string, DuplicateDetectionRecord[]>();
    let afterId = 0;
    for (;;) {
      const videos = await this.db.getVideosForDuplicatePage(PAGE_SIZE, afterId);
      if (videos.length === 0) break;
      this.throwIfCancelled(generation);

      for (const video of videos) {
        this.throwIfCancelled(generation);
        if (!video.partialHash) continue;
        const key = `${video.size}_${video.duration}_${video.partialHash}`;
        const group = groups.get(key) ?? [];
        group.push(video);
        groups.set(key, group);
      }
      afterId = videos[videos.length - 1]!.id;
      if (videos.length < PAGE_SIZE) break;
    }

    // Group by: size + duration + partialHash
    onProgress?.(2, 3, "重複を検索中...");

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

    logger.log(`Found ${duplicateGroups.length} duplicate groups`);
    onProgress?.(3, 3, "完了");
    return duplicateGroups;
  }

  /**
   * Delete a video file and its database entry.
   *
   * verifyAgainstVideoId: 同一グループ内で「保持する」動画の ID。
   * findDuplicates のグルーピングはサイズ+再生時間+部分ハッシュという確率的な
   * 近似でしかないため、実際にファイルを削除する前に必ずバイト単位で
   * 完全一致することを確認する（一致しない場合は削除せずエラーとする）。
   */
  async deleteVideo(
    videoId: number,
    verifyAgainstVideoId: number,
    moveToTrash: boolean = true,
  ): Promise<void> {
    const [video, referenceVideo] = await Promise.all([
      this.db.prisma.video.findUnique({
        where: { id: videoId },
        select: { path: true, thumbnailPath: true, chapterThumbnails: true },
      }),
      this.db.prisma.video.findUnique({
        where: { id: verifyAgainstVideoId },
        select: { path: true },
      }),
    ]);

    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }
    if (!referenceVideo) {
      throw new Error(
        `検証用の動画 (id: ${verifyAgainstVideoId}) が見つからないため削除をスキップしました: ${video.path}`,
      );
    }

    let identical: boolean;
    try {
      identical = await filesAreIdentical(video.path, referenceVideo.path);
    } catch (error) {
      throw new Error(
        `重複ファイルの検証に失敗したため削除をスキップしました: ${video.path} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!identical) {
      throw new Error(
        `保持する動画とバイト内容が一致しないため削除をスキップしました（誤検出の可能性）: ${video.path}`,
      );
    }

    // Delete or move to trash
    if (moveToTrash) {
      const { shell } = await import("electron");
      await shell.trashItem(video.path);
    } else {
      await fs.unlink(video.path);
    }

    // アプリが生成した副産物（メイン＋チャプターサムネイル）をベストエフォートで削除する。
    // removeDirectory と同じ範囲を消さないとチャプター画像（最大5枚）がゴミとして残る。
    if (video.thumbnailPath) {
      try {
        await fs.unlink(video.thumbnailPath);
      } catch (error) {
        console.warn(`Failed to delete thumbnail: ${error}`);
      }
    }
    for (const chapterPath of safeParseChapterThumbnailPaths(
      video.chapterThumbnails,
    )) {
      try {
        await fs.unlink(chapterPath);
      } catch (error) {
        console.warn(`Failed to delete chapter thumbnail: ${error}`);
      }
    }

    // Delete from database. ファイルは既に削除済みのため、ここで失敗しても
    // （DB 行が孤立するだけで）ユーザーの意図した「重複ファイルの削除」自体は
    // 達成されている。次回スキャンで実体が無いことが検出され自動的に片付く。
    try {
      await this.db.prisma.video.delete({
        where: { id: videoId },
      });
    } catch (error) {
      console.error(
        `Deleted file but failed to remove DB record for video ${videoId} (will self-heal on next scan):`,
        error,
      );
    }

    logger.log(`✅ Deleted video ${videoId}: ${video.path}`);
  }

  /**
   * Delete multiple videos at once
   */
  async deleteVideos(
    requests: Array<{ videoId: number; verifyAgainstVideoId: number }>,
    moveToTrash: boolean = true,
    onProgress?: (current: number, total: number) => void,
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      try {
        await this.deleteVideo(
          request.videoId,
          request.verifyAgainstVideoId,
          moveToTrash,
        );
        success++;
      } catch (error) {
        console.error(`Failed to delete video ${request.videoId}:`, error);
        failed++;
      }

      if (onProgress) {
        onProgress(i + 1, requests.length);
      }
    }

    return { success, failed };
  }
}
