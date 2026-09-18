import {
  PrismaClient as GeneratedPrismaClient,
  Prisma,
} from "../../generated/prisma";
import path from "path";
import { promises as fs } from "fs";
import { app } from "electron";
import { spawn } from "child_process";
import type {
  Video as AppVideo,
  Directory as AppDirectory,
  Tag as AppTag,
  ChapterThumbnail,
  BulkTagResult,
  BulkTagChange,
  VideoCreateData,
  VideoUpdateData,
} from "../types/types";
import { createLogger } from "../utils/logger.js";
import {
  LEGACY_BASELINE_MIGRATIONS,
  databasePathFromUrl,
  ensureDatabaseMigrated,
} from "./migration-manager.js";

// production ビルドではデバッグログを抑制
const logger = createLogger(app?.isPackaged ?? false);

// SQLite の bind parameter 上限を超えないよう、bulk 操作の SQL 条件を分割する。
// videoId/tagId の組み合わせは1組あたり2パラメータを使うため、余裕を持たせる。
const BULK_TAG_CHUNK_SIZE = 400;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// データベース操作用の型定義（Prismaの型とアプリの型を橋渡し）
export interface VideoRecord extends AppVideo {
  videoTags?: {
    tag: { name: string; id: number; createdAt: Date; color: string };
  }[];
}

export interface DirectoryRecord extends AppDirectory {}

export interface TagRecord extends AppTag {}

export interface ContainerCheckRecord {
  id: number;
  path: string;
  filename: string;
  size: bigint;
}

export interface VideoScanRecord {
  id: number;
  path: string;
  filename: string;
  title: string;
  duration: number;
  size: bigint;
  width: number;
  height: number;
  fps: number;
  codec: string;
  modifiedAt: Date;
  thumbnailPath?: string;
  chapterThumbnails: ChapterThumbnail[];
}

/** スキャンの差分判定に必要な最小限の既存動画情報。 */
export interface VideoScanComparisonRecord {
  id: number;
  path: string;
  title: string;
  duration: number;
  size: bigint;
  width: number;
  height: number;
  fps: number;
  codec: string;
  modifiedAt: Date;
}

export interface ThumbnailGenerationRecord {
  id: number;
  path: string;
  filename: string;
  duration: number;
}

export interface ThumbnailReferenceRecord {
  thumbnailPath: string | null;
  chapterThumbnails: string;
  id: number;
}

export interface DuplicateDetectionRecord {
  id: number;
  path: string;
  filename: string;
  size: bigint;
  width: number;
  height: number;
  duration: number;
  partialHash: string;
  thumbnailPath: string | null;
}

// Prisma の video 取得結果（videoTags 込み）の型
type VideoWithTags = Prisma.VideoGetPayload<{
  include: {
    videoTags: {
      include: { tag: true };
    };
  };
}>;

// chapterThumbnails の JSON パース。壊れた行が1件あるだけで一覧取得全体が
// 例外で落ちるのを防ぐため、失敗時は空配列にフォールバックする。
function safeParseChapterThumbnails(raw: string | null): ChapterThumbnail[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChapterThumbnail[]) : [];
  } catch (error) {
    console.error(
      "Failed to parse chapterThumbnails JSON, defaulting to []:",
      error,
    );
    return [];
  }
}

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
    watchedAt: video.watchedAt ?? undefined,
    watchPosition: video.watchPosition,
    tags: video.videoTags.map((vt) => vt.tag.name),
    chapterThumbnails: safeParseChapterThumbnails(video.chapterThumbnails),
  };
}

/** 一時的な DB ロックなど、リトライすれば成功する可能性があるエラーか */
function isRetryableDbError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database is locked") || message.includes("SQLITE_BUSY");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * filePath が dir 配下（dir 自身を含む）かどうかを判定する。
 * dir の末尾セパレータ有無や区切り文字（"/" / "\\"）の違いを正規化してから比較する
 * （VideoScanner.ts の同名ヘルパーと同じロジック。DB 層は scanner モジュールに
 * 依存させたくないためここに複製している）。
 */
function isPathUnderDirectory(filePath: string, dir: string): boolean {
  const normalizedDir = dir.replace(/[/\\]+$/, "");
  return (
    filePath === normalizedDir ||
    filePath.startsWith(`${normalizedDir}/`) ||
    filePath.startsWith(`${normalizedDir}\\`)
  );
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
): Prisma.VideoOrderByWithRelationInput[] {
  switch (sortBy) {
    case "title":
      return [{ title: order }, { id: order }];
    case "addedAt":
      return [{ addedAt: order }, { id: order }];
    case "updatedAt":
      return [{ updatedAt: order }, { id: order }];
    case "rating":
      return [{ rating: order }, { id: order }];
    case "duration":
      return [{ duration: order }, { id: order }];
    case "size":
      return [{ size: order }, { id: order }];
    case "createdAt":
      return [{ createdAt: order }, { id: order }];
    case "modifiedAt":
      return [{ modifiedAt: order }, { id: order }];
    default:
      return [{ filename: order }, { id: order }];
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

  /** SQLite の WAL をチェックポイントしてから、利用者が選んだ場所へDBを複製する。 */
  async backupDatabase(destinationPath: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL が設定されていません");
    const sourcePath = databasePathFromUrl(databaseUrl);
    const targetPath = path.resolve(destinationPath);
    if (sourcePath === targetPath) {
      throw new Error("現在使用中のDBファイルと同じ場所には保存できません");
    }
    await this._prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    await fs.copyFile(sourcePath, targetPath);
  }

  private async ensureDatabaseExists(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL が設定されていません");
    }

    const migrationNames = await this.getMigrationNames();
    const result = await ensureDatabaseMigrated({
      databasePath: databasePathFromUrl(databaseUrl),
      migrationNames,
      legacyBaselineMigrations: LEGACY_BASELINE_MIGRATIONS,
      sql: {
        query: <T>(sql: string) => this._prisma.$queryRawUnsafe<T[]>(sql),
        connect: () => this._prisma.$connect(),
        disconnect: () => this._prisma.$disconnect(),
      },
      runner: {
        deploy: () => this.runPrismaMigrateDeploy(),
        resolveApplied: (migrationName) =>
          this.runPrismaMigrateResolve(migrationName),
      },
    });

    if (result.backupPath) {
      logger.log(`Database backup created before migration: ${result.backupPath}`);
    }
    logger.log(`Database migration state: ${result.kind}`);
  }

  private getPrismaBaseDir(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked")
      : process.cwd();
  }

  private async getMigrationNames(): Promise<string[]> {
    const migrationsDir = path.join(this.getPrismaBaseDir(), "prisma", "migrations");
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isDirectory() && /^\d+_.+/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * prisma CLI をサブプロセスで実行する共通ランナー。
   * 開発中は node、パッケージ版では Electron を ELECTRON_RUN_AS_NODE=1 で
   * Node.js モード起動して実行する。
   *
   * @param args prisma への引数（例: ["migrate", "deploy"]）
   * @param successMessage 成功時にログへ出力するメッセージ
   */
  private runPrismaCli(args: string[], successMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 開発中: プロジェクト直下、リリース時: ASAR unpackedからバイナリ参照
      const baseDir = this.getPrismaBaseDir();

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
      logger.debug("Prisma args:", args.join(" "));

      const prismaProcess = spawn(
        nodeExecutable,
        [prismaScript, ...args, "--schema", schemaPath],
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
          logger.log(successMessage);
          if (stdout.trim()) {
            logger.debug("Prisma CLI output:", stdout);
          }
          resolve();
        } else {
          console.error(
            `Prisma CLI (${args.join(" ")}) failed with code:`,
            code,
          );
          if (stderr.trim()) {
            console.error("Error output:", stderr);
          }

          // エラーメッセージに stderr を含めて、migration失敗の理由を
          // 起動側へそのまま伝える。失敗時のschema自動変更は行わない。
          reject(
            new Error(
              `prisma ${args.join(" ")} failed with code ${code}${
                stderr ? `: ${stderr}` : ""
              }`,
            ),
          );
        }
      });

      prismaProcess.on("error", (error: Error) => {
        console.error("Failed to start Prisma CLI process:", error);
        reject(error);
      });
    });
  }

  private async runPrismaMigrateDeploy(): Promise<void> {
    await this.runPrismaCli(
      ["migrate", "deploy"],
      "Prisma migration completed successfully",
    );
  }

  private async runPrismaMigrateResolve(migrationName: string): Promise<void> {
    await this.runPrismaCli(
      ["migrate", "resolve", "--applied", migrationName],
      `Prisma migration baseline recorded: ${migrationName}`,
    );
  }

  async addVideo(videoData: VideoCreateData): Promise<number> {
    // Prisma DateTime へ変換（スキャナからは ISO 文字列で渡される）
    // Prisma スキーマでは必須のため、新規作成時に未指定なら現在時刻を使用
    const createdAt = new Date(videoData.createdAt ?? new Date().toISOString());
    const modifiedAt = new Date(
      videoData.modifiedAt ?? new Date().toISOString(),
    );

    // update 側は明示的に渡されたフィールドのみ更新する。
    // createdAt/modifiedAt を常に「今」でフォールバックして書き込むと、
    // 呼び出し側がこれらを省略した場合に既存のファイル生成/更新時刻を
    // 上書きしてしまう（現在の呼び出し元は必ず両方渡すため未発生だが、
    // 将来別の呼び出し元が省略した場合の地雷になっていた）。
    const updateData: Prisma.VideoUpdateInput = {
      filename: videoData.filename,
      title: videoData.title || videoData.filename,
      duration: videoData.duration,
      size: videoData.size,
      width: videoData.width,
      height: videoData.height,
      fps: videoData.fps,
      codec: videoData.codec,
      bitrate: videoData.bitrate,
      thumbnailPath: videoData.thumbnailPath,
      chapterThumbnails: JSON.stringify(videoData.chapterThumbnails || []),
      updatedAt: new Date(),
    };
    if (videoData.createdAt !== undefined) {
      updateData.createdAt = new Date(videoData.createdAt);
    }
    if (videoData.modifiedAt !== undefined) {
      updateData.modifiedAt = new Date(videoData.modifiedAt);
    }

    const video = await this._prisma.video.upsert({
      where: { path: videoData.path },
      update: updateData,
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
        createdAt,
        modifiedAt,
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
      take: limit ?? undefined,
      skip: offset,
    });

    return videos.map(mapVideoRecord);
  }

  /** スキャン用の軽量取得。IDカーソルでページングし、同時更新で行を飛ばさない。 */
  async getVideosForScanPage(
    limit: number,
    afterId: number = 0,
  ): Promise<VideoScanRecord[]> {
    const videos = await this._prisma.video.findMany({
      where: afterId > 0 ? { id: { gt: afterId } } : undefined,
      select: {
        id: true,
        path: true,
        filename: true,
        title: true,
        duration: true,
        size: true,
        width: true,
        height: true,
        fps: true,
        codec: true,
        modifiedAt: true,
        thumbnailPath: true,
        chapterThumbnails: true,
      },
      orderBy: { id: "asc" },
      take: limit,
    });
    return videos.map((video) => ({
      ...video,
      modifiedAt: new Date(video.modifiedAt),
      thumbnailPath: video.thumbnailPath ?? undefined,
      chapterThumbnails: safeParseChapterThumbnails(video.chapterThumbnails),
    }));
  }

  /**
   * スキャン比較用の最小 DTO。
   * サムネイル JSON やタグを含めず、ページ単位で読み込むことで大規模 DB でも
   * 不要なレコードをメモリへ展開しない。
   */
  async getVideosForScanComparisonPage(
    limit: number,
    afterId: number = 0,
  ): Promise<VideoScanComparisonRecord[]> {
    const videos = await this._prisma.video.findMany({
      where: afterId > 0 ? { id: { gt: afterId } } : undefined,
      select: {
        id: true,
        path: true,
        title: true,
        duration: true,
        size: true,
        width: true,
        height: true,
        fps: true,
        codec: true,
        modifiedAt: true,
      },
      orderBy: { id: "asc" },
      take: limit,
    });
    return videos.map((video) => ({
      ...video,
      modifiedAt: new Date(video.modifiedAt),
    }));
  }

  /** コンテナ判定用の最小 DTO。動画本体やタグをメモリへ展開しない。 */
  async getVideosForContainerCheck(
    limit: number,
    afterId: number = 0,
  ): Promise<ContainerCheckRecord[]> {
    return this._prisma.video.findMany({
      select: { id: true, path: true, filename: true, size: true },
      where: afterId > 0 ? { id: { gt: afterId } } : undefined,
      orderBy: { id: "asc" },
      take: limit,
    });
  }

  async getVideosWithoutPartialHashPage(
    limit: number,
    afterId: number = 0,
  ): Promise<Array<{ id: number; path: string }>> {
    const videos = await this._prisma.video.findMany({
      where: {
        partialHash: null,
        ...(afterId > 0 ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, path: true },
      orderBy: { id: "asc" },
      take: limit,
    });
    return videos;
  }

  async getVideosForDuplicatePage(
    limit: number,
    afterId: number = 0,
  ): Promise<DuplicateDetectionRecord[]> {
    const videos = await this._prisma.video.findMany({
      where: {
        partialHash: { not: null },
        ...(afterId > 0 ? { id: { gt: afterId } } : {}),
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
      orderBy: { id: "asc" },
      take: limit,
    });
    return videos.filter(
      (video): video is DuplicateDetectionRecord => video.partialHash !== null,
    );
  }

  /** サムネイル掃除用の最小 DTO。タグや動画メタデータは取得しない。 */
  async getThumbnailReferences(
    limit: number,
    afterId: number = 0,
  ): Promise<ThumbnailReferenceRecord[]> {
    return this._prisma.video.findMany({
      select: { id: true, thumbnailPath: true, chapterThumbnails: true },
      where: afterId > 0 ? { id: { gt: afterId } } : undefined,
      orderBy: { id: "asc" },
      take: limit,
    });
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
    const updateData: {
      title?: string;
      rating?: number;
      description?: string;
      thumbnailPath?: string;
      chapterThumbnails?: string;
      watchedAt?: Date;
      watchPosition?: number;
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
    if (data.watchedAt !== undefined) updateData.watchedAt = data.watchedAt;
    if (data.watchPosition !== undefined)
      updateData.watchPosition = data.watchPosition;

    // 更新対象フィールドが無いのはエラーではない（何もする必要がないだけ）ため true を返す。
    // false は「DB 書き込みが実際に失敗した」場合のみに限定する。
    if (Object.keys(updateData).length === 0) return true;

    updateData.updatedAt = new Date();

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this._prisma.video.update({
          where: { id },
          data: updateData,
        });
        return true;
      } catch (error) {
        if (attempt < MAX_ATTEMPTS && isRetryableDbError(error)) {
          console.warn(
            `updateVideo: transient DB error, retrying (attempt ${attempt}/${MAX_ATTEMPTS}):`,
            error,
          );
          await delay(attempt * 150);
          continue;
        }
        console.error("Error updating video:", error);
        return false;
      }
    }
    return false;
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
  ): Promise<ThumbnailGenerationRecord[]> {
    try {
      logger.debug("getVideosWithoutThumbnails: Starting Prisma query");

      const videos = await this._prisma.video.findMany({
        where: {
          OR: [{ thumbnailPath: null }, { thumbnailPath: "" }],
        },
        select: { id: true, path: true, filename: true, duration: true },
        orderBy: [{ filename: "asc" }, { id: "asc" }],
        take: limit ?? undefined,
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
          })),
        );
      }

      return videos;
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

  /**
   * ディレクトリの登録解除。
   * Directory と Video の間には DB 上の関連（FK）が無く、パスの前方一致だけで
   * 暗黙的に紐づいているため、ここで明示的にディレクトリ配下の Video を削除しないと
   * 二度と削除判定にかからない孤立レコード（タグ・サムネイル参照含む）が残り続ける
   * （VideoScanner の削除検出は「現在登録済みのディレクトリ配下か」を見るため、
   * 登録解除した時点でその配下の動画は永久に対象外になる）。
   * 元動画ファイル自体は削除しない（ここでの「削除」はライブラリからの追跡解除のため）。
   */
  async removeDirectory(directoryPath: string): Promise<boolean> {
    try {
      const videosUnderDir: Array<{
        id: number;
        path: string;
        thumbnailPath: string | null;
        chapterThumbnails: string;
      }> = [];
      const PAGE_SIZE = 500;
      let afterId = 0;
      for (;;) {
        const page = await this._prisma.video.findMany({
          select: {
            id: true,
            path: true,
            thumbnailPath: true,
            chapterThumbnails: true,
          },
          where: afterId > 0 ? { id: { gt: afterId } } : undefined,
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
        });
        if (page.length === 0) break;
        videosUnderDir.push(
          ...page.filter((video) =>
            isPathUnderDirectory(video.path, directoryPath),
          ),
        );
        afterId = page[page.length - 1]!.id;
        if (page.length < PAGE_SIZE) break;
      }

      // アプリが生成した副産物（サムネイル）のみベストエフォートで削除する。
      // 元動画ファイルには一切触れない。
      for (const video of videosUnderDir) {
        if (video.thumbnailPath) {
          await fs.unlink(video.thumbnailPath).catch(() => {});
        }
        const chapters = safeParseChapterThumbnails(video.chapterThumbnails);
        for (const chapter of chapters) {
          if (chapter.path) {
            await fs.unlink(chapter.path).catch(() => {});
          }
        }
      }

      // Video 削除 + Directory 削除は同一トランザクションで行う
      // （VideoTag は video 側の onDelete: Cascade で自動的に削除される）
      await this._prisma.$transaction([
        this._prisma.video.deleteMany({
          where: { id: { in: videosUnderDir.map((video) => video.id) } },
        }),
        this._prisma.directory.delete({ where: { path: directoryPath } }),
      ]);
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
    const tags = await this._prisma.tag.findMany({
      include: { _count: { select: { videoTags: true } } },
      orderBy: { name: "asc" },
    });
    return tags.map(({ _count, ...tag }) => ({
      ...tag,
      count: _count.videoTags,
    }));
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
      // タグの作成と動画への関連付けを 1 トランザクションにまとめる。
      // 別々の await にすると、間でクラッシュ/DBエラーが起きた場合に
      // 「誰にも使われていない Tag だけが残る」不整合な中間状態になりうる。
      await this._prisma.$transaction(async (tx) => {
        const tag = await tx.tag.upsert({
          where: { name: tagName },
          update: {},
          create: {
            name: tagName,
            color: "#007AFF",
          },
        });

        await tx.videoTag.upsert({
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
      });

      return true;
    } catch (error) {
      console.error("Error adding tag to video:", error);
      return false;
    }
  }

  async addTagsToVideos(
    videoIds: number[],
    tagNames: string[],
  ): Promise<BulkTagResult> {
    if (
      !Array.isArray(videoIds) ||
      !videoIds.every((id) => Number.isInteger(id)) ||
      !Array.isArray(tagNames) ||
      !tagNames.every((name) => typeof name === "string")
    ) {
      throw new Error("Invalid bulk tag arguments");
    }
    const ids = [...new Set(videoIds.filter((id) => Number.isInteger(id)))];
    const names = [...new Set(tagNames.map((name) => name.trim()).filter(Boolean))];
    if (ids.length === 0 || names.length === 0) return { affected: 0 };

    try {
      const affected = await this._prisma.$transaction(async (tx) => {
        const tagIds: number[] = [];
        for (const name of names) {
          const tag = await tx.tag.upsert({
            where: { name },
            update: {},
            create: { name, color: "#007AFF" },
          });
          tagIds.push(tag.id);
        }
        let affected = 0;
        for (const videoChunk of chunkArray(ids, BULK_TAG_CHUNK_SIZE)) {
          for (const tagChunk of chunkArray(tagIds, BULK_TAG_CHUNK_SIZE)) {
            const pairs = videoChunk.flatMap((videoId) =>
              tagChunk.map((tagId) => ({ videoId, tagId })),
            );
            for (const pairChunk of chunkArray(pairs, BULK_TAG_CHUNK_SIZE)) {
              const existing = await tx.videoTag.findMany({
                where: { OR: pairChunk },
                select: { videoId: true, tagId: true },
              });
              const existingKeys = new Set(
                existing.map((pair) => `${pair.videoId}:${pair.tagId}`),
              );
              const pendingPairs = pairChunk.filter(
                (pair) => !existingKeys.has(`${pair.videoId}:${pair.tagId}`),
              );
              if (pendingPairs.length > 0) {
                const result = await tx.videoTag.createMany({ data: pendingPairs });
                affected += result.count;
              }
            }
          }
        }
        return affected;
      });
      return { affected };
    } catch (error) {
      console.error("Error adding tags to videos:", error);
      throw error;
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

  async removeTagsFromVideos(
    videoIds: number[],
    tagNames: string[],
  ): Promise<BulkTagResult> {
    if (
      !Array.isArray(videoIds) ||
      !videoIds.every((id) => Number.isInteger(id)) ||
      !Array.isArray(tagNames) ||
      !tagNames.every((name) => typeof name === "string")
    ) {
      throw new Error("Invalid bulk tag arguments");
    }
    const ids = [...new Set(videoIds.filter((id) => Number.isInteger(id)))];
    const names = [...new Set(tagNames.map((name) => name.trim()).filter(Boolean))];
    if (ids.length === 0 || names.length === 0) return { affected: 0 };

    try {
      const affected = await this._prisma.$transaction(async (tx) => {
        const tags = (
          await Promise.all(
            chunkArray(names, BULK_TAG_CHUNK_SIZE).map((nameChunk) =>
              tx.tag.findMany({
                where: { name: { in: nameChunk } },
                select: { id: true },
              }),
            ),
          )
        ).flat();
        if (tags.length === 0) return 0;
        let affected = 0;
        for (const videoChunk of chunkArray(ids, BULK_TAG_CHUNK_SIZE)) {
          for (const tagChunk of chunkArray(
            tags.map((tag) => tag.id),
            BULK_TAG_CHUNK_SIZE,
          )) {
            const result = await tx.videoTag.deleteMany({
              where: {
                videoId: { in: videoChunk },
                tagId: { in: tagChunk },
              },
            });
            affected += result.count;
          }
        }
        return affected;
      });
      return { affected };
    } catch (error) {
      console.error("Error removing tags from videos:", error);
      throw error;
    }
  }

  async applyBulkTagChanges(
    changes: BulkTagChange[],
  ): Promise<BulkTagResult> {
    if (!Array.isArray(changes)) {
      throw new Error("Invalid bulk tag changes");
    }
    const normalized = changes.filter(
      (change) =>
        change !== null &&
        typeof change === "object" &&
        Number.isInteger(change.videoId) &&
        typeof change.tagName === "string" &&
        change.tagName.trim().length > 0 &&
        (change.action === "add" || change.action === "remove"),
    );
    if (normalized.length === 0) return { affected: 0 };

    try {
      const affected = await this._prisma.$transaction(async (tx) => {
        const addChanges = normalized.filter((change) => change.action === "add");
        const removeChanges = normalized.filter(
          (change) => change.action === "remove",
        );
        const tagNames = [
          ...new Set(normalized.map((change) => change.tagName.trim())),
        ];
        const tags = (
          await Promise.all(
            chunkArray(tagNames, BULK_TAG_CHUNK_SIZE).map((tagNameChunk) =>
              tx.tag.findMany({
                where: { name: { in: tagNameChunk } },
                select: { id: true, name: true },
              }),
            ),
          )
        ).flat();
        const tagIds = new Map(tags.map((tag) => [tag.name, tag.id]));

        for (const change of addChanges) {
          const name = change.tagName.trim();
          if (tagIds.has(name)) continue;
          const tag = await tx.tag.upsert({
            where: { name },
            update: {},
            create: { name, color: "#007AFF" },
          });
          tagIds.set(name, tag.id);
        }

        const addPairs = addChanges.map((change) => ({
          videoId: change.videoId,
          tagId: tagIds.get(change.tagName.trim())!,
        }));
        const uniqueAddPairs = [
          ...new Map(
            addPairs.map((pair) => [`${pair.videoId}:${pair.tagId}`, pair]),
          ).values(),
        ];
        let addAffected = 0;
        for (const pairChunk of chunkArray(
          uniqueAddPairs,
          BULK_TAG_CHUNK_SIZE,
        )) {
          if (pairChunk.length === 0) continue;
          const existingAddPairs = await tx.videoTag.findMany({
            where: { OR: pairChunk },
            select: { videoId: true, tagId: true },
          });
          const existingAddKeys = new Set(
            existingAddPairs.map((pair) => `${pair.videoId}:${pair.tagId}`),
          );
          const pendingPairs = pairChunk.filter(
            (pair) => !existingAddKeys.has(`${pair.videoId}:${pair.tagId}`),
          );
          if (pendingPairs.length > 0) {
            const addResult = await tx.videoTag.createMany({ data: pendingPairs });
            addAffected += addResult.count;
          }
        }
        const removePairs = removeChanges.flatMap((change) => {
          const tagId = tagIds.get(change.tagName.trim());
          return tagId === undefined
            ? []
            : [{ videoId: change.videoId, tagId }];
        });
        let removeAffected = 0;
        for (const pairChunk of chunkArray(
          removePairs,
          BULK_TAG_CHUNK_SIZE,
        )) {
          if (pairChunk.length === 0) continue;
          const removeResult = await tx.videoTag.deleteMany({
            where: { OR: pairChunk },
          });
          removeAffected += removeResult.count;
        }
        return addAffected + removeAffected;
      });
      return { affected };
    } catch (error) {
      console.error("Error applying bulk tag changes:", error);
      throw error;
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
