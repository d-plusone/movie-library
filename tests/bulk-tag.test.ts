import { promises as fs } from "fs";
import path from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/prisma/index.js";
import PrismaDatabaseManager from "../src/database/PrismaDatabaseManager";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createDatabase(): Promise<{
  directory: string;
  prisma: PrismaClient;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "movie-library-bulk-tag-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "movie-library.db");
  // Prisma migrate deploy は空ファイルが無い新規 SQLite DB を作れないため、
  // アプリの migration manager と同じく空のDBファイルを先に作る。
  await fs.writeFile(databasePath, Buffer.alloc(0));
  await execFileAsync(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  await prisma.$connect();
  return { directory, prisma };
}

function createDatabaseManager(prisma: PrismaClient): PrismaDatabaseManager {
  const manager = Object.create(
    PrismaDatabaseManager.prototype,
  ) as PrismaDatabaseManager;
  Object.defineProperty(manager, "_prisma", {
    value: prisma,
    writable: true,
  });
  return manager;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("bulk tag database operations", () => {
  it("large video/tag sets are chunked without losing affected counts", async () => {
    const { prisma } = await createDatabase();
    const now = new Date();
    const videos = Array.from({ length: 1200 }, (_, index) => ({
      path: `/bulk/${index}.mp4`,
      filename: `${index}.mp4`,
      title: `Video ${index}`,
      createdAt: now,
      modifiedAt: now,
    }));
    await prisma.video.createMany({ data: videos });
    const ids = (await prisma.video.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    })).map((video) => video.id);
    const manager = createDatabaseManager(prisma);

    expect((await manager.addTagsToVideos(ids, ["bulk-a", "bulk-b"])).affected).toBe(2400);
    expect((await manager.addTagsToVideos(ids, ["bulk-a", "bulk-b"])).affected).toBe(0);
    expect((await manager.removeTagsFromVideos(ids, ["bulk-a", "bulk-b"])).affected).toBe(2400);

    const changes = ids.map((videoId) => ({
      action: "add" as const,
      videoId,
      tagName: "bulk-c",
    }));
    expect((await manager.applyBulkTagChanges(changes)).affected).toBe(1200);
    expect((await manager.applyBulkTagChanges(
      changes.map((change) => ({ ...change, action: "remove" as const })),
    )).affected).toBe(1200);

    await prisma.$disconnect();
  });
});
