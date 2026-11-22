import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trashItem: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  shell: { trashItem: mocks.trashItem },
}));

import DuplicateDetector from "../src/scanner/DuplicateDetector";
import type PrismaDatabaseManager from "../src/database/PrismaDatabaseManager";

describe("DuplicateDetector library deletion", () => {
  it("moves selected files with bounded concurrency and reports each completion", async () => {
    let active = 0;
    let peak = 0;
    mocks.trashItem.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active--;
    });

    const videos = new Map(
      Array.from({ length: 9 }, (_, index) => [
        index + 1,
        {
          path: `/library/movie-${index + 1}.mp4`,
          thumbnailPath: null,
          chapterThumbnails: "[]",
        },
      ]),
    );
    const db = {
      prisma: {
        video: {
          findUnique: vi.fn(async ({ where: { id } }: { where: { id: number } }) =>
            videos.get(id) ?? null,
          ),
          delete: vi.fn(async () => ({})),
        },
      },
    } as unknown as PrismaDatabaseManager;
    const detector = new DuplicateDetector(db);
    const progress: Array<[number, number]> = [];

    const result = await detector.deleteLibraryVideos(
      Array.from(videos.keys()),
      true,
      (current, total) => progress.push([current, total]),
    );

    expect(result).toEqual({ success: 9, failed: 0 });
    expect(mocks.trashItem).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);
    expect(progress).toHaveLength(9);
    expect(progress.at(-1)).toEqual([9, 9]);
  });
});
