import {
  PrismaClient as GeneratedPrismaClient,
  Prisma,
} from "../../generated/prisma";
import path from "path";
import { app } from "electron";
import { spawn } from "child_process";
import type {
  Video as AppVideo,
  Directory as AppDirectory,
  Tag as AppTag,
  ChapterThumbnail,
  VideoCreateData,
  VideoUpdateData,
} from "../types/types";
import { createLogger } from "../utils/logger.js";

// production ビルドではデバッグログを抑制
const logger = createLogger(app.isPackaged);

// データベース操作用の型定義（Prismaの型とアプリの型を橋渡し）
export interface VideoRecord extends AppVideo {
  videoTags?: {
    tag: { name: string; id: number; createdAt: Date; color: string };
  }[];
}

export interface DirectoryRecord extends AppDirectory {}

export interface TagRecord extends AppTag {}

// Prisma の video 取得結果（videoTags 込み）の型
type VideoWithTags = Prisma.VideoGetPayload<{
  include: {
    videoTags: {
      include: { tag: true };
    };
  };
}>;

// Prisma のレコードをアプリ用の VideoRecord に変換する
// （Prisma の nullable フィールドを optional に変換し、日付文字列を Date に変換する）
function mapVideoRecord(video: VideoWithTags): VideoRecord {
  return {
    ...video,
    description: video.description ?? undefined,
    thumbnailPath: video.thumbnailPath ?? undefined,
    modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
    createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
    updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
    tags: video.videoTags.map((vt) => vt.tag.name),
    chapterThumbnails: video.chapterThumbnails
      ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
      : [],
  };
}

// Prisma の orderBy に使用可能なフィールドのみ許可
// （レンダラープロセスからの任意キー注入を防ぐための許可リスト）
const SORTABLE_FIELDS = [
  "filename",
  "title",
  "addedAt",
  "updatedAt",
  "rating",
  "duration",
  "size",
  "createdAt",
  "modifiedAt",
] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

// ソートフィールドごとの orderBy を生成（許可リストで検証済みのキーのみ使用）
function resolveOrderBy(
  sortBy: SortableField,
  order: Prisma.SortOrder,
): Prisma.VideoOrderByWithRelationInput {
  switch (sortBy) {
    case "title":
      return { title: order };
    case "addedAt":
      return { addedAt: order };
    case "updatedAt":
      return { updatedAt: order };
    case "rating":
      return { rating: order };
    case "duration":
      return { duration: order };
    case "size":
      return { size: order };
    case "createdAt":
      return { createdAt: order };
    case "modifiedAt":
      return { modifiedAt: order };
    default:
      return { filename: order };
  }
}

class PrismaDatabaseManager {
  private _prisma: GeneratedPrismaClient;
  private isClosed = false;

  // Public getter for prisma client (for advanced operations like duplicate detection)
  public get prisma(): GeneratedPrismaClient {
    return this._prisma;
  }

  constructor() {
    this._prisma = new GeneratedPrismaClient();
  }

  async initialize(): Promise<void> {
    try {
      // 現在の作業ディレクトリを表示

      // データベースの自動初期化を試行
      await this.ensureDatabaseExists();

      // Prismaを使用してデータベース接続をテスト
      await this._prisma.$connect();

      // データベースの基本情報を表示
      await this._prisma.video.count();
      await this._prisma.directory.count();
    } catch (error) {
      // Error initializing database
      throw error;
    }
  }

  private async ensureDatabaseExists(): Promise<void> {
    try {
      // データベーステーブルの存在をチェック
      await this._prisma.video.findFirst();
    } catch (error) {
      // テーブルが存在しない場合（Prisma エラーコード P2021）、自動でマイグレーションを実行
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2021"
      ) {
        await this.runDatabaseMigration();
      } else {
        throw error;
      }
    }
  }

  private async runDatabaseMigration(): Promise<void> {
    // Prismaの正しいアプローチ：prisma migrate deploy を使用
    logger.log("Running Prisma migration...");

    try {
      await this.runPrismaMigrateDeploy();
    } catch (error) {
      console.error("Prisma migrate deploy failed:", error);

      // P3005エラー（データベースが空でない）の場合、db pushを試行
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("P3005") ||
        message.includes("database schema is not empty")
      ) {
        logger.log("Database not empty, attempting db push to sync schema...");
        await this.runPrismaDbPush();
      } else if (process.platform === "win32") {
        // Windows環境での代替アプローチ：prisma db push を試行
        logger.log("Attempting alternative migration approach for Windows...");
        await this.runPrismaDbPush();
      } else {
        throw error;
      }
    }
  }

  private async runPrismaDbPush(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.log("Running prisma db push as fallback...");

      // 開発中: プロジェクト直下、リリース時: ASAR unpackedからバイナリ参照
      const baseDir = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked")
        : process.cwd();

      // Prismaの実際のスクリプトパスを直接指定
      const prismaScript = path.join(
        baseDir,
        "node_modules",
        "prisma",
        "build",
        "index.js",
      );
      const schemaPath = path.join(baseDir, "prisma", "schema.prisma");

      // パッケージ版ではprocess.execFilePathを使用（Electronに組み込まれたNode.js）
      // 開発中は通常のnodeコマンドを使用
      const nodeExecutable = app.isPackaged ? process.execPath : "node";

      logger.debug("Node executable:", nodeExecutable);
      logger.debug("Prisma script:", prismaScript);
      logger.debug("Schema path:", schemaPath);
      logger.debug("Working directory:", baseDir);

      const prismaProcess = spawn(
        nodeExecutable,
        [prismaScript, "db", "push", "--schema", schemaPath, "--skip-generate"],
        {
          cwd: baseDir,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1", // ElectronをNode.jsモードで実行
          },
        },
      );

      let stdout = "";
      let stderr = "";

      prismaProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });

      prismaProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      prismaProcess.on("close", (code: number) => {
        if (code === 0) {
          logger.log("Prisma db push completed successfully");
          if (stdout.trim()) {
            logger.debug("Push output:", stdout);
          }
          resolve();
        } else {
          console.error("Prisma db push failed with code:", code);
          if (stderr.trim()) {
            console.error("Push error output:", stderr);
          }
          reject(
            new Error(
              `Database push failed with code ${code}${
                stderr ? `: ${stderr}` : ""
              }`,
            ),
          );
        }
      });

      prismaProcess.on("error", (error: Error) => {
        console.error("Failed to start Prisma db push process:", error);
        reject(error);
      });
    });
  }

  private async runPrismaMigrateDeploy(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 開発中: プロジェクト直下、リリース時: ASAR unpackedからバイナリ参照
      const baseDir = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked")
        : process.cwd();

      // Prismaの実際のスクリプトパスを直接指定
      const prismaScript = path.join(
        baseDir,
        "node_modules",
        "prisma",
        "build",
        "index.js",
      );
      const schemaPath = path.join(baseDir, "prisma", "schema.prisma");

      // パッケージ版ではprocess.execPathを使用（Electronに組み込まれたNode.js）
      // 開発中は通常のnodeコマンドを使用
      const nodeExecutable = app.isPackaged ? process.execPath : "node";

      logger.debug("Node executable:", nodeExecutable);
      logger.debug("Prisma script:", prismaScript);
      logger.debug("Schema path:", schemaPath);
      logger.debug("Working directory:", baseDir);

      const prismaProcess = spawn(
        nodeExecutable,
        [prismaScript, "migrate", "deploy", "--schema", schemaPath],
        {
          cwd: baseDir,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1", // ElectronをNode.jsモードで実行
          },
        },
      );

      let stdout = "";
      let stderr = "";

      prismaProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });

      prismaProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      prismaProcess.on("close", (code: number) => {
        if (code === 0) {
          logger.log("Prisma migration completed successfully");
          if (stdout.trim()) {
            logger.debug("Migration output:", stdout);
          }
          resolve();
        } else {
          console.error("Prisma migration failed with code:", code);
          if (stderr.trim()) {
            console.error("Migration error output:", stderr);
          }

          // エラーメッセージを含めてreject（呼び出し側でP3005を検出できるように）
          reject(
            new Error(
              `Migration failed with code ${code}${stderr ? `: ${stderr}` : ""}`,
            ),
          );
        }
      });

      prismaProcess.on("error", (error: Error) => {
        console.error("Failed to start Prisma migration process:", error);
        reject(error);
      });
    });
  }

  async addVideo(videoData: VideoCreateData): Promise<number> {
    // 日付の型変換（DateオブジェクトはISO文字列に変換）
    // Prisma スキーマでは必須のため、未指定時は現在時刻を使用
    const createdAtString = videoData.createdAt ?? new Date().toISOString();
    const modifiedAtString = videoData.modifiedAt ?? new Date().toISOString();

    const video = await this._prisma.video.upsert({
      where: { path: videoData.path },
      update: {
        filename: videoData.filename,
        title: videoData.title || videoData.filename,
        duration: videoData.duration,
        size: videoData.size,
        width: videoData.width,
        height: videoData.height,
        fps: videoData.fps,
        codec: videoData.codec,
        bitrate: videoData.bitrate,
        createdAt: createdAtString,
        modifiedAt: modifiedAtString,
        thumbnailPath: videoData.thumbnailPath,
        chapterThumbnails: JSON.stringify(videoData.chapterThumbnails || []),
        updatedAt: new Date(),
      },
      create: {
        path: videoData.path,
        filename: videoData.filename,
        title: videoData.title || videoData.filename,
        duration: videoData.duration,
        size: videoData.size,
        width: videoData.width,
        height: videoData.height,
        fps: videoData.fps,
        codec: videoData.codec,
        bitrate: videoData.bitrate,
        createdAt: createdAtString,
        modifiedAt: modifiedAtString,
        thumbnailPath: videoData.thumbnailPath,
        chapterThumbnails: JSON.stringify(videoData.chapterThumbnails || []),
      },
    });

    return video.id;
  }

  async getVideos(
    sortBy: string = "filename",
    sortOrder: string = "ASC",
    limit: number | null = null,
    offset: number = 0,
  ): Promise<VideoRecord[]> {
    // 許可リストによる検証（無効なフィールドは filename にフォールバック）
    const safeSortBy: SortableField = SORTABLE_FIELDS.includes(
      sortBy as SortableField,
    )
      ? (sortBy as SortableField)
      : "filename";
    const safeOrder: Prisma.SortOrder =
      sortOrder.toLowerCase() === "desc" ? "desc" : "asc";

    const orderBy = resolveOrderBy(safeSortBy, safeOrder);

    const videos = await this._prisma.video.findMany({
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy,
      take: limit || undefined,
      skip: offset,
    });

    return videos.map(mapVideoRecord);
  }

  async getVideo(id: number): Promise<VideoRecord | null> {
    const video = await this._prisma.video.findUnique({
      where: { id },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    if (!video) return null;

    return mapVideoRecord(video);
  }

  async getVideoByPath(path: string): Promise<VideoRecord | null> {
    const video = await this._prisma.video.findUnique({
      where: { path },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    if (!video) return null;

    return mapVideoRecord(video);
  }

  async updateVideo(id: number, data: VideoUpdateData): Promise<boolean> {
    try {
      const updateData: {
        title?: string;
        rating?: number;
        description?: string;
        thumbnailPath?: string;
        chapterThumbnails?: string;
        updatedAt?: Date;
      } = {};

      if (data.title !== undefined) updateData.title = data.title;
      if (data.rating !== undefined) updateData.rating = data.rating;
      if (data.description !== undefined)
        updateData.description = data.description;
      if (data.thumbnailPath !== undefined)
        updateData.thumbnailPath = data.thumbnailPath;
      if (data.chapterThumbnails !== undefined) {
        updateData.chapterThumbnails = JSON.stringify(data.chapterThumbnails);
      }

      if (Object.keys(updateData).length === 0) return false;

      updateData.updatedAt = new Date();

      await this._prisma.video.update({
        where: { id },
        data: updateData,
      });

      return true;
    } catch (error) {
      console.error("Error updating video:", error);
      return false;
    }
  }

  async removeVideo(path: string): Promise<boolean> {
    try {
      await this._prisma.video.delete({
        where: { path },
      });
      return true;
    } catch (error) {
      console.error("Error removing video:", error);
      return false;
    }
  }

  async searchVideos(query: string): Promise<VideoRecord[]> {
    const videos = await this._prisma.video.findMany({
      where: {
        OR: [
          { title: { contains: query } },
          { filename: { contains: query } },
          { description: { contains: query } },
          {
            videoTags: {
              some: {
                tag: {
                  name: { contains: query },
                },
              },
            },
          },
        ],
      },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy: { title: "asc" },
    });

    return videos.map(mapVideoRecord);
  }

  async getVideoCount(): Promise<number> {
    return this._prisma.video.count();
  }

  async getVideosWithoutThumbnailsCount(): Promise<number> {
    return this._prisma.video.count({
      where: {
        OR: [{ thumbnailPath: null }, { thumbnailPath: "" }],
      },
    });
  }

  async getVideosWithoutThumbnails(
    limit: number | null = null,
    offset: number = 0,
  ): Promise<VideoRecord[]> {
    try {
      logger.debug("getVideosWithoutThumbnails: Starting Prisma query");

      const videos = await this._prisma.video.findMany({
        where: {
          OR: [{ thumbnailPath: null }, { thumbnailPath: "" }],
        },
        include: {
          videoTags: {
            include: {
              tag: true,
            },
          },
        },
        take: limit || undefined,
        skip: offset,
      });

      logger.debug(
        `getVideosWithoutThumbnails: Found ${videos.length} videos without thumbnails`,
      );
      if (videos.length > 0) {
        logger.debug(
          "Sample videos without thumbnails:",
          videos.slice(0, 3).map((v) => ({
            id: v.id,
            filename: v.filename,
            thumbnailPath: v.thumbnailPath,
          })),
        );
      }

      return videos.map(mapVideoRecord);
    } catch (error) {
      console.error("Error in getVideosWithoutThumbnails:", error);
      throw error;
    }
  }

  // Directory management
  async addDirectory(directoryPath: string): Promise<number> {
    const name = path.basename(directoryPath);
    const directory = await this._prisma.directory.upsert({
      where: { path: directoryPath },
      update: {},
      create: {
        path: directoryPath,
        name,
      },
    });
    return directory.id;
  }

  async removeDirectory(directoryPath: string): Promise<boolean> {
    try {
      await this._prisma.directory.delete({
        where: { path: directoryPath },
      });
      return true;
    } catch (error) {
      console.error("Error removing directory:", error);
      return false;
    }
  }

  async getDirectories(): Promise<DirectoryRecord[]> {
    return await this._prisma.directory.findMany({
      orderBy: { name: "asc" },
    });
  }

  // Tag management
  async getTags(): Promise<TagRecord[]> {
    return await this._prisma.tag.findMany({
      orderBy: { name: "asc" },
    });
  }

  async addTag(name: string, color: string = "#007AFF"): Promise<number> {
    const tag = await this._prisma.tag.upsert({
      where: { name },
      update: {},
      create: {
        name,
        color,
      },
    });
    return tag.id;
  }

  async addTagToVideo(videoId: number, tagName: string): Promise<boolean> {
    try {
      // First ensure the tag exists
      const tag = await this._prisma.tag.upsert({
        where: { name: tagName },
        update: {},
        create: {
          name: tagName,
          color: "#007AFF",
        },
      });

      // Then create the video-tag relationship
      await this._prisma.videoTag.upsert({
        where: {
          videoId_tagId: {
            videoId,
            tagId: tag.id,
          },
        },
        update: {},
        create: {
          videoId,
          tagId: tag.id,
        },
      });

      return true;
    } catch (error) {
      console.error("Error adding tag to video:", error);
      return false;
    }
  }

  async removeTagFromVideo(videoId: number, tagName: string): Promise<boolean> {
    try {
      const tag = await this._prisma.tag.findUnique({
        where: { name: tagName },
      });

      if (!tag) return false;

      await this._prisma.videoTag.delete({
        where: {
          videoId_tagId: {
            videoId,
            tagId: tag.id,
          },
        },
      });

      return true;
    } catch (error) {
      console.error("Error removing tag from video:", error);
      return false;
    }
  }

  async deleteTag(tagName: string): Promise<boolean> {
    try {
      await this._prisma.tag.delete({
        where: { name: tagName },
      });
      return true;
    } catch (error) {
      console.error("Error deleting tag:", error);
      return false;
    }
  }

  async updateTag(oldName: string, newName: string): Promise<boolean> {
    try {
      await this._prisma.tag.update({
        where: { name: oldName },
        data: { name: newName },
      });
      return true;
    } catch (error) {
      console.error("Error updating tag:", error);
      return false;
    }
  }

  // 指定時刻以降にビデオが更新されているかチェック
  async hasVideoUpdates(lastCheckTime: number): Promise<boolean> {
    const checkTime = new Date(lastCheckTime);

    try {
      const count = await this._prisma.video.count({
        where: {
          OR: [
            { updatedAt: { gt: checkTime } },
            { addedAt: { gt: checkTime } },
          ],
        },
      });

      logger.debug("hasVideoUpdates check:", {
        lastCheckTime: checkTime.toISOString(),
        hasUpdates: count > 0,
        updateCount: count,
      });

      return count > 0;
    } catch (error) {
      console.error("Error checking video updates:", error);
      throw error;
    }
  }

  async close(): Promise<void> {
    // 多重呼び出しされた場合は何もしない（$disconnect の冪等化）
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await this._prisma.$disconnect();
  }
}

export default PrismaDatabaseManager;
