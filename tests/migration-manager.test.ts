import { constants, promises as fs } from "fs";
import path from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/prisma/index.js";
import {
  LEGACY_BASELINE_MIGRATIONS,
  ensureDatabaseMigrated,
  type MigrationRunner,
} from "../src/database/migration-manager";

const execFileAsync = promisify(execFile);
const ALL_MIGRATIONS = [
  ...LEGACY_BASELINE_MIGRATIONS,
  "20260918000000_normalize_video_dates_and_indexes",
];
const temporaryDirectories: string[] = [];

async function createTemporaryDatabasePath(): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "movie-library-migration-"));
  temporaryDirectories.push(directory);
  return { directory, databasePath: path.join(directory, "movie-library.db") };
}

function createSqlClient(databasePath: string): {
  prisma: PrismaClient;
  sql: {
    query: <T>(sql: string) => Promise<T[]>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
  };
} {
  const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  return {
    prisma,
    sql: {
      query: <T>(sql: string): Promise<T[]> => prisma.$queryRawUnsafe<T[]>(sql),
      connect: () => prisma.$connect(),
      disconnect: () => prisma.$disconnect(),
    },
  };
}

function createCliRunner(databasePath: string): MigrationRunner {
  const run = async (args: string[]): Promise<void> => {
    await execFileAsync(
      "pnpm",
      ["exec", "prisma", ...args, "--schema", "prisma/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  };
  return {
    deploy: () => run(["migrate", "deploy"]),
    resolveApplied: (migrationName) =>
      run(["migrate", "resolve", "--applied", migrationName]),
  };
}

async function createLegacyDatabase(
  databasePath: string,
  createdAt = "2025-01-01T00:00:00.000Z",
): Promise<PrismaClient> {
  const { prisma } = createSqlClient(databasePath);
  await prisma.$connect();
  const schemaStatements = [
    `CREATE TABLE "videos" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "duration" INTEGER NOT NULL DEFAULT 0,
      "size" BIGINT NOT NULL DEFAULT 0,
      "width" INTEGER NOT NULL DEFAULT 0,
      "height" INTEGER NOT NULL DEFAULT 0,
      "fps" INTEGER NOT NULL DEFAULT 0,
      "codec" TEXT NOT NULL DEFAULT '',
      "bitrate" INTEGER NOT NULL DEFAULT 0,
      "rating" INTEGER NOT NULL DEFAULT 0,
      "thumbnail_path" TEXT,
      "chapter_thumbnails" TEXT NOT NULL DEFAULT '[]',
      "description" TEXT,
      "created_at" TEXT NOT NULL,
      "modified_at" TEXT NOT NULL,
      "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL,
      "file_hash" TEXT,
      "partial_hash" TEXT,
      "watched_at" DATETIME,
      "watch_position" INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE "directories" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE "tags" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "color" TEXT NOT NULL DEFAULT '#007AFF',
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE "video_tags" (
      "video_id" INTEGER NOT NULL,
      "tag_id" INTEGER NOT NULL,
      PRIMARY KEY ("video_id", "tag_id"),
      CONSTRAINT "video_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "video_tags_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "videos_path_key" ON "videos"("path")`,
    `CREATE INDEX "videos_updated_at_idx" ON "videos"("updated_at")`,
    `CREATE INDEX "videos_added_at_idx" ON "videos"("added_at")`,
    `CREATE INDEX "videos_thumbnail_path_idx" ON "videos"("thumbnail_path")`,
    `CREATE INDEX "video_tags_tag_id_idx" ON "video_tags"("tag_id")`,
    `CREATE UNIQUE INDEX "directories_path_key" ON "directories"("path")`,
    `CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name")`,
  ];
  for (const statement of schemaStatements) {
    await prisma.$executeRawUnsafe(statement);
  }
  await prisma.$executeRawUnsafe(`
    INSERT INTO "videos" (
      "id", "path", "filename", "title", "duration", "size", "width",
      "height", "fps", "codec", "bitrate", "rating", "created_at",
      "modified_at", "updated_at"
    ) VALUES (
      1, '/library/movie.mp4', 'movie.mp4', 'Movie', 10, 123, 1920, 1080,
      30, 'h264', 100, 0, '${createdAt}', '${createdAt}', CURRENT_TIMESTAMP
    );
    INSERT INTO "directories" ("id", "path", "name")
      VALUES (1, '/library', 'library');
    INSERT INTO "tags" ("id", "name") VALUES (1, 'sample');
    INSERT INTO "video_tags" ("video_id", "tag_id") VALUES (1, 1);
  `);
  await prisma.$disconnect();
  return prisma;
}

async function runCoordinator(
  databasePath: string,
  runner: MigrationRunner = createCliRunner(databasePath),
  validationFailure?: "integrity" | "foreign-key",
) {
  const { prisma, sql: baseSql } = createSqlClient(databasePath);
  const sql = validationFailure
    ? {
        query: async <T>(sql: string): Promise<T[]> => {
          if (validationFailure === "integrity" && sql === "PRAGMA integrity_check") {
            return [{ integrity_check: "not ok" } as T];
          }
          if (validationFailure === "foreign-key" && sql === "PRAGMA foreign_key_check") {
            return [{ table: "video_tags", rowid: 1 } as T];
          }
          return baseSql.query<T>(sql);
        },
        connect: baseSql.connect,
        disconnect: baseSql.disconnect,
      }
    : baseSql;
  try {
    const result = await ensureDatabaseMigrated({
      databasePath,
      migrationNames: ALL_MIGRATIONS,
      sql,
      runner,
    });
    return { prisma, result };
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("database migration compatibility", () => {
  it("新規DBを通常の migrate deploy で作成する", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    const { prisma, result } = await runCoordinator(databasePath);

    expect(result.kind).toBe("new");
    expect(result.backupPath).toBeUndefined();
    expect(await prisma.video.count()).toBe(0);
    await prisma.$disconnect();
  });

  it("migration管理済みDBはバックアップなしで通常migrationを実行する", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    const first = await runCoordinator(databasePath);
    await first.prisma.$disconnect();

    const second = await runCoordinator(databasePath);
    expect(second.result.kind).toBe("managed");
    expect(second.result.backupPath).toBeUndefined();
    await second.prisma.$disconnect();
  });

  it("migration管理済みで保留migrationがあるDBは先にバックアップする", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    await createLegacyDatabase(databasePath);
    const setupRunner = createCliRunner(databasePath);
    for (const migrationName of LEGACY_BASELINE_MIGRATIONS) {
      await setupRunner.resolveApplied(migrationName);
    }

    const { prisma, result } = await runCoordinator(databasePath);
    expect(result.kind).toBe("managed");
    expect(result.backupPath).toBeDefined();
    await fs.access(result.backupPath!, constants.F_OK);
    expect(await prisma.video.count()).toBe(1);
    await prisma.$disconnect();
  });

  it("履歴なしの既知legacy DBをバックアップしてbaseline後にmigrationする", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    await createLegacyDatabase(databasePath);

    const { prisma, result } = await runCoordinator(databasePath);
    expect(result.kind).toBe("legacy-baseline");
    expect(result.backupPath).toBeDefined();
    await fs.access(result.backupPath!, constants.F_OK);
    expect(await prisma.video.count()).toBe(1);

    const backupPrisma = new PrismaClient({ datasourceUrl: `file:${result.backupPath}` });
    await backupPrisma.$connect();
    const backupColumns = await backupPrisma.$queryRawUnsafe<
      Array<{ name: string; type: string }>
    >('PRAGMA table_info("videos")');
    expect(backupColumns.find((column) => column.name === "created_at")?.type).toBe("TEXT");
    await backupPrisma.$disconnect();

    const history = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*) as count FROM "_prisma_migrations"',
    );
    expect(Number(history[0]?.count)).toBe(ALL_MIGRATIONS.length);
    await prisma.$disconnect();
  });

  it("履歴なしの未知schemaは変更せず中断する", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    const { prisma } = createSqlClient(databasePath);
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "videos" ("id" INTEGER PRIMARY KEY, "unknown_column" TEXT)',
    );
    await prisma.$disconnect();

    let deployCalled = false;
    const runner: MigrationRunner = {
      deploy: async () => {
        deployCalled = true;
      },
      resolveApplied: async () => {
        deployCalled = true;
      },
    };
    await expect(runCoordinator(databasePath, runner)).rejects.toThrow(
      "schemaを安全に判定できません",
    );
    expect(deployCalled).toBe(false);
    expect((await fs.readdir(path.dirname(databasePath))).some((name) => name.includes(".backup-"))).toBe(false);
  });

  it("変換不能な日時値はbaselineせず中断する", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    await createLegacyDatabase(databasePath, "not-a-date");

    let deployCalled = false;
    const runner: MigrationRunner = {
      deploy: async () => {
        deployCalled = true;
      },
      resolveApplied: async () => {
        deployCalled = true;
      },
    };
    await expect(runCoordinator(databasePath, runner)).rejects.toThrow(
      "日時値を変換できません",
    );
    expect(deployCalled).toBe(false);
    expect((await fs.readdir(path.dirname(databasePath))).some((name) => name.includes(".backup-"))).toBe(false);
  });

  it("migration失敗時はバックアップを残してfallbackせず中断する", async () => {
    const { databasePath } = await createTemporaryDatabasePath();
    await createLegacyDatabase(databasePath);
    let deployCalled = false;
    const runner: MigrationRunner = {
      deploy: async () => {
        deployCalled = true;
        throw new Error("synthetic migration failure");
      },
      resolveApplied: async () => undefined,
    };

    await expect(runCoordinator(databasePath, runner)).rejects.toThrow(
      "synthetic migration failure",
    );
    expect(deployCalled).toBe(true);
    expect((await fs.readdir(path.dirname(databasePath))).some((name) => name.includes(".backup-"))).toBe(true);
  });

  it.each([
    ["integrity", "integrity_check"],
    ["foreign-key", "foreign_key_check"],
  ] as const)("%s検証失敗時はmigrationせず中断する", async (failure, label) => {
    const { databasePath } = await createTemporaryDatabasePath();
    await createLegacyDatabase(databasePath);
    let deployCalled = false;
    const runner: MigrationRunner = {
      deploy: async () => {
        deployCalled = true;
      },
      resolveApplied: async () => {
        deployCalled = true;
      },
    };

    await expect(runCoordinator(databasePath, runner, failure)).rejects.toThrow(label);
    expect(deployCalled).toBe(false);
    expect((await fs.readdir(path.dirname(databasePath))).some((name) => name.includes(".backup-"))).toBe(false);
  });
});
