import { promises as fs } from "fs";
import path from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { isPackaged: false } }));
import VideoScanner from "../src/scanner/VideoScanner";
import type { VideoScanComparisonRecord } from "../src/database/PrismaDatabaseManager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function comparisonRecord(filePath: string, modifiedAt: Date, id: number): VideoScanComparisonRecord {
  return {
    id,
    path: filePath,
    title: path.basename(filePath),
    duration: 10,
    size: 1n,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "h264",
    modifiedAt,
  };
}

describe("VideoScanner.previewScan", () => {
  it("counts new, modified, deleted files without processing or changing the DB", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "movie-library-scan-preview-"));
    temporaryDirectories.push(directory);
    const newPath = path.join(directory, "new.mp4");
    const updatedPath = path.join(directory, "updated.mp4");
    const stablePath = path.join(directory, "stable.mp4");
    await Promise.all([newPath, updatedPath, stablePath].map((filePath) => fs.writeFile(filePath, "video")));
    const stableMtime = (await fs.stat(stablePath)).mtime;

    const existing = [
      comparisonRecord(updatedPath, new Date(0), 1),
      comparisonRecord(stablePath, stableMtime, 2),
      comparisonRecord(path.join(directory, "deleted.mp4"), new Date(0), 3),
    ];
    const db = {
      getVideosForScanComparisonPage: async (_limit: number, afterId: number) =>
        afterId === 0 ? existing : [],
    } as never;
    const scanner = new VideoScanner(db);

    const result = await scanner.previewScan([directory]);

    expect(result.totalNew).toBe(1);
    expect(result.totalUpdated).toBe(1);
    expect(result.totalDeleted).toBe(1);
    expect(result.totalReprocessed).toBe(0);
    expect(result.totalErrors).toBe(0);
  });
});
