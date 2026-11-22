import { describe, expect, it } from "vitest";
import {
  getMp4ConversionEligibility,
  verifyConvertedMp4,
} from "../src/main/remux";
import {
  canPotentiallyRemuxVideoToMp4,
  getInternalPlaybackStatus,
} from "../src/utils/playback-compatibility";

describe("internal playback compatibility", () => {
  it("marks WMV as unavailable even if FFmpeg can inspect it", () => {
    expect(getInternalPlaybackStatus("/library/old.wmv", "wmv3")).toEqual({
      playable: false,
      reason: "container",
    });
  });

  it("accepts a native MP4/H.264 combination", () => {
    expect(getInternalPlaybackStatus("movie.mp4", "h264")).toEqual({
      playable: true,
    });
  });

  it("marks an unsupported video codec as unavailable", () => {
    expect(getInternalPlaybackStatus("movie.mp4", "hevc")).toEqual({
      playable: false,
      reason: "codec",
    });
  });

  it("marks H.264 in Matroska as unavailable instead of assuming all containers work", () => {
    expect(getInternalPlaybackStatus("movie.mkv", "h264")).toEqual({
      playable: false,
      reason: "codec",
    });
  });

  it("accepts a WebM-compatible VP9 combination", () => {
    expect(getInternalPlaybackStatus("movie.webm", "vp9")).toEqual({
      playable: true,
    });
  });

  it("allows only video codecs that can plausibly be copied into MP4", () => {
    expect(canPotentiallyRemuxVideoToMp4("h264")).toBe(true);
    expect(canPotentiallyRemuxVideoToMp4("wmv3")).toBe(false);
  });
});

describe("MP4 conversion eligibility", () => {
  it("accepts only stream-copyable video and audio streams", () => {
    expect(
      getMp4ConversionEligibility({
        format: {},
        streams: [
          { codec_type: "video", codec_name: "h264" },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
    ).toEqual({ convertible: true, mode: "remux" });
  });

  it("uses high-quality conversion when WMV/WMA would require re-encoding", () => {
    expect(
      getMp4ConversionEligibility({
        format: {},
        streams: [
          { codec_type: "video", codec_name: "wmv3" },
          { codec_type: "audio", codec_name: "wmav2" },
        ],
      }),
    ).toEqual({
      convertible: true,
      mode: "transcode",
      reason: "H.264/320kbps MP3 の高品質変換を行います",
    });
  });

  it("rejects subtitle streams rather than silently dropping them", () => {
    expect(
      getMp4ConversionEligibility({
        format: {},
        streams: [
          { codec_type: "video", codec_name: "h264" },
          { codec_type: "subtitle", codec_name: "subrip" },
        ],
      }),
    ).toEqual({
      convertible: false,
      reason: "字幕・データ・添付ストリームを保持したまま MP4 に変換できません",
    });
  });
});

describe("converted MP4 verification", () => {
  it("accepts a high-quality result with matching tracks, resolution, and duration", () => {
    expect(() =>
      verifyConvertedMp4(
        {
          format: { duration: 120 },
          streams: [
            { codec_type: "video", codec_name: "wmv3", width: 640, height: 480, duration: 120 },
            { codec_type: "audio", codec_name: "wmav2", duration: 120 },
          ],
        },
        {
          format: { duration: 120.1 },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 640, height: 480, duration: 120.1 },
            { codec_type: "audio", codec_name: "mp3", duration: 120.1 },
          ],
        },
        "transcode",
      ),
    ).not.toThrow();
  });

  it("rejects a result whose total duration indicates a possible sync problem", () => {
    expect(() =>
      verifyConvertedMp4(
        {
          format: { duration: 120 },
          streams: [{ codec_type: "video", codec_name: "wmv3", width: 640, height: 480 }],
        },
        {
          format: { duration: 122 },
          streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 480 }],
        },
        "transcode",
      ),
    ).toThrow("動画全体の再生時間が変換前後で一致しません");
  });

  it("rejects a result whose audio-to-video start offset changed", () => {
    expect(() =>
      verifyConvertedMp4(
        {
          format: { duration: 120 },
          streams: [
            {
              codec_type: "video",
              codec_name: "wmv3",
              width: 640,
              height: 480,
              start_time: 0,
            },
            { codec_type: "audio", codec_name: "wmav2", start_time: 0.2 },
          ],
        },
        {
          format: { duration: 120 },
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 640,
              height: 480,
              start_time: 0,
            },
            { codec_type: "audio", codec_name: "mp3", start_time: 0 },
          ],
        },
        "transcode",
      ),
    ).toThrow("音声トラック 1 の映像に対する開始位置が変化しました");
  });
});
