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
      // テーブルまたはカラムが存在しない場合（Prisma エラーコード P2021/P2022）、
      // 旧バージョンのスキーマの DB とみなして自動でマイグレーションを実行
      // （P2022 は古いバージョンのアプリで作られた DB に新カラムが無いケース）
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2021" || error.code === "P2022")
      ) {
        // findFirst() の失敗により this._prisma は既にこの DB ファイルへ
        // 遅延接続してしまっている。切断せずに migrate/db push を別プロセスで
        // 起動すると、同一 SQLite ファイルへの接続が競合してロックし、
        // 特に Windows でフォールバック自体が失敗する。マイグレーション完了後は
        // initialize() が $connect() を呼び直すため、ここで一旦切断してよい。
        await this._prisma.$disconnect();
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

      // マイグレーション履歴が無い/食い違っている DB
      // （旧バージョンで db push により作られた DB など）では migrate deploy が
      // 失敗するため、db push でスキーマを同期する
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("P3005") ||
        message.includes("database schema is not empty") ||
        message.includes("P3006") ||
        message.includes("failed to apply") ||
        process.platform === "win32"
      ) {
        logger.log("Database not empty, attempting db push to sync schema...");
        await this.runPrismaDbPush();
      } else {
        throw error;
      }
    }
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

          // エラーメッセージに stderr を含める
          // （呼び出し側が P3005 / P3006 / "failed to apply" 等を検出できるように）
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

  /**
   * マイグレーション履歴が無い/食い違っている DB 向けにスキーマを同期する。
   * --accept-data-loss を付けない場合、破壊的な変更が必要なスキーマ差分では
   * db push が対話的な確認を待ってハングしてしまう（非対話環境のため誰も応答できない）。
   * この経路は既に migrate deploy が失敗した後の最終フォールバックであり、
   * ここで止まるとアプリ自体が起動できなくなるため確認プロンプトを無効化する。
   */
  private async runPrismaDbPush(): Promise<void> {
    await this.runPrismaCli(
      ["db", "push", "--skip-generate", "--accept-data-loss"],
      "Prisma db push completed successfully",
    );
  }

  private async runPrismaMigrateDeploy(): Promise<void> {
    await this.runPrismaCli(
      ["migrate", "deploy"],
      "Prisma migration completed successfully",
    );
  }

  async addVideo(videoData: VideoCreateData): Promise<number> {
    // 日付の型変換（DateオブジェクトはISO文字列に変換）
    // Prisma スキーマでは必須のため、新規作成時に未指定なら現在時刻を使用
    const createdAtString = videoData.createdAt ?? new Date().toISOString();
    const modifiedAtString = videoData.modifiedAt ?? new Date().toISOString();

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
    if (videoData.createdAt !== undefined) updateData.createdAt = videoData.createdAt;
    if (videoData.modifiedAt !== undefined) updateData.modifiedAt = videoData.modifiedAt;

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
      take: limit ?? undefined,
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

  async searchVideos(query: string): Promise<VideoRecord[]> {
    // Prisma の contains は SQLite 上で LIKE に変換され、クエリ中の "%"/"_" が
    // エスケープなしでワイルドカードとして解釈されてしまう
    // （例: "100%" で検索すると "100" + 任意の1文字にマッチしてしまう）。
    // ここでは全件取得してから JS のリテラル部分文字列一致でフィルタすることで、
    // ワイルドカード解釈を避け、常に「入力した文字列そのもの」で検索する。
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const videos = await this._prisma.video.findMany({
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy: { title: "asc" },
    });

    const matched = videos.filter((video) => {
      if (video.title.toLowerCase().includes(normalizedQuery)) return true;
      if (video.filename.toLowerCase().includes(normalizedQuery)) return true;
      if (video.description?.toLowerCase().includes(normalizedQuery)) return true;
      return video.videoTags.some((vt) =>
        vt.tag.name.toLowerCase().includes(normalizedQuery),
      );
    });

    return matched.map(mapVideoRecord);
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
      const allVideos = await this._prisma.video.findMany({
        select: { id: true, path: true, thumbnailPath: true, chapterThumbnails: true },
      });
      const videosUnderDir = allVideos.filter((video) =>
        isPathUnderDirectory(video.path, directoryPath),
      );

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
