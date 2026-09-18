import { describe, expect, it } from "vitest";
import { filterVideos } from "../src/renderer/src/lib/filters";
import type { FilterState, Video } from "../src/renderer/src/types";

function video(id: number, tags: string[], rating: number): Video {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    path: `/videos/${id}.mp4`,
    title: `Video ${id}`,
    filename: `${id}.mp4`,
    duration: 60,
    size: 1n,
    width: 1920,
    height: 1080,
    addedAt: now,
    tags,
    rating,
  };
}

function state(overrides: Partial<FilterState> = {}): FilterState {
  return {
    rating: 0,
    tags: [],
    directories: [],
    resolutions: [],
    codecs: [],
    tagMatchMode: "OR",
    unratedOnly: false,
    untaggedOnly: false,
    ...overrides,
  };
}

describe("video filters", () => {
  const videos = [video(1, ["A", "B"], 0), video(2, ["A"], 3), video(3, [], 0)];

  it("supports OR and AND tag matching", () => {
    expect(filterVideos(videos, state({ tags: ["A", "B"], tagMatchMode: "OR" }), 0, "").map((item) => item.id)).toEqual([1, 2]);
    expect(filterVideos(videos, state({ tags: ["A", "B"], tagMatchMode: "AND" }), 0, "").map((item) => item.id)).toEqual([1]);
  });

  it("can select unrated and untagged videos independently", () => {
    expect(filterVideos(videos, state({ unratedOnly: true }), 0, "").map((item) => item.id)).toEqual([1, 3]);
    expect(filterVideos(videos, state({ untaggedOnly: true }), 0, "").map((item) => item.id)).toEqual([3]);
    expect(filterVideos(videos, state({ unratedOnly: true, untaggedOnly: true }), 0, "").map((item) => item.id)).toEqual([3]);
  });
});
