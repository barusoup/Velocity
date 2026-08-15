import { describe, expect, it } from "vitest";
import {
  bootAutoplaySeed,
  buildLoudnessPreviewStarts,
  clampVolume,
  describeMediaError,
  getAudioCacheKey,
  isPlaybackIdleLongEnough,
  isUsefulPreviewLoudness,
  parseSavedSessionRaw,
  playbackNeedsSourceRefresh,
  prependPlaybackHistoryEntry,
  queueOriginEquals,
  readMuted,
  readVolume,
  shuffledCopy,
  withTimeout,
} from "./helpers";
import type { LoudnessData, MediaTrack, QueueOrigin } from "../types";

describe("clampVolume", () => {
  it("clamps to [0, 1]", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(2)).toBe(1);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampVolume(Number.NaN)).toBe(0.8);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0.8);
  });
});

describe("isPlaybackIdleLongEnough", () => {
  it("requires a positive idle timestamp beyond the staleness window", () => {
    expect(isPlaybackIdleLongEnough(0)).toBe(false);
    expect(isPlaybackIdleLongEnough(Date.now())).toBe(false);
    expect(isPlaybackIdleLongEnough(Date.now() - 40 * 60 * 1000 - 1)).toBe(true);
  });
});

describe("playbackNeedsSourceRefresh", () => {
  it("only refreshes stream tracks", () => {
    expect(playbackNeedsSourceRefresh({ source: "local" } as unknown as MediaTrack, 0, true)).toBe(false);
    expect(playbackNeedsSourceRefresh({ source: "stream" } as unknown as MediaTrack, 0, true)).toBe(true);
  });

  it("honors the idle-window check without a refresh flag", () => {
    expect(playbackNeedsSourceRefresh({ source: "stream" } as unknown as MediaTrack, 0, false)).toBe(false);
    expect(
      playbackNeedsSourceRefresh(
        { source: "stream" } as unknown as MediaTrack,
        Date.now() - 40 * 60 * 1000 - 1,
        false,
      ),
    ).toBe(true);
  });
});

describe("buildLoudnessPreviewStarts", () => {
  it("returns fixed anchors for missing durations", () => {
    expect(buildLoudnessPreviewStarts()).toEqual([0, 30, 75]);
    expect(buildLoudnessPreviewStarts(null)).toEqual([0, 30, 75]);
  });

  it("spreads starts across a short track without duplicates", () => {
    const starts = buildLoudnessPreviewStarts(60);
    expect(starts[0]).toBe(0);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe("isUsefulPreviewLoudness", () => {
  it("rejects out-of-range loudness", () => {
    expect(isUsefulPreviewLoudness({} as LoudnessData)).toBe(false);
    expect(
      isUsefulPreviewLoudness({ integratedLufs: -50, truePeak: -40 } as LoudnessData),
    ).toBe(false);
  });
});

describe("describeMediaError", () => {
  it("describes null and known codes", () => {
    expect(describeMediaError(null)).toContain("Playback failed");
    // MEDIA_ERR_NETWORK === 2 (MediaError constant unavailable in Node env).
    expect(describeMediaError({ code: 2 } as MediaError)).toContain("network");
  });
});

describe("shuffledCopy", () => {
  it("preserves all items", () => {
    const items = [1, 2, 3, 4, 5];
    const shuffled = shuffledCopy(items);
    expect(shuffled.slice().sort()).toEqual(items.slice().sort());
    expect(shuffled).not.toBe(items);
  });
});

describe("queueOriginEquals", () => {
  it("matches browseId origins", () => {
    const origin: QueueOrigin = { kind: "album", browseId: "MPREabc", name: "x" };
    expect(queueOriginEquals(origin, { ...origin })).toBe(true);
    expect(queueOriginEquals(origin, { ...origin, browseId: "MPREzzz" })).toBe(false);
  });

  it("matches user-playlist origins by id", () => {
    const origin: QueueOrigin = { kind: "user-playlist", id: "pl-1", name: "x" };
    expect(queueOriginEquals(origin, { ...origin })).toBe(true);
    expect(queueOriginEquals(origin, { ...origin, id: "pl-2" })).toBe(false);
  });
});

describe("prependPlaybackHistoryEntry", () => {
  it("dedupes by session key", () => {
    const entry = {
      track: { id: "t1" },
      queue: [{ id: "t1" }],
      queueIndex: 0,
      queueOrigin: null,
      autoplayTrackIds: [],
      autoplaySeed: null,
      shuffle: false,
      queueVisitedTrackIds: [],
    } as unknown as Parameters<typeof prependPlaybackHistoryEntry>[1];
    const result = prependPlaybackHistoryEntry([entry], entry);
    expect(result).toHaveLength(1);
  });
});

describe("getAudioCacheKey", () => {
  it("keys stream tracks by videoId", () => {
    expect(getAudioCacheKey({ source: "stream", videoId: "vid1" } as unknown as MediaTrack)).toBe("yt:vid1");
    expect(getAudioCacheKey({ source: "local", id: "local-1" } as unknown as MediaTrack)).toBe("local-1");
  });
});

describe("withTimeout", () => {
  it("rejects after the timeout", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 20, "timed out"),
    ).rejects.toThrow("timed out");
  });

  it("resolves with the inner promise result", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "nope")).resolves.toBe("ok");
  });
});

describe("parseSavedSessionRaw", () => {
  it("parses a valid session", () => {
    const raw = JSON.stringify({ track: { id: "t1" }, progress: 12, savedAt: Date.now() });
    expect(parseSavedSessionRaw(raw)).toMatchObject({ progress: 12 });
  });

  it("rejects stale or malformed sessions", () => {
    const stale = JSON.stringify({ track: { id: "t1" }, progress: 0, savedAt: Date.now() - 1_000_000_000 });
    expect(parseSavedSessionRaw(stale)).toBeNull();
    expect(parseSavedSessionRaw("garbage")).toBeNull();
    expect(parseSavedSessionRaw(null)).toBeNull();
  });
});

describe("bootAutoplaySeed", () => {
  it("derives a seed from stream tracks only", () => {
    expect(
      bootAutoplaySeed({ track: { source: "stream", videoId: "vid1" } as unknown as MediaTrack, progress: 0, savedAt: 0 }),
    ).toEqual({ videoId: "vid1", playlistId: null });
    expect(
      bootAutoplaySeed({ track: { source: "local" } as unknown as MediaTrack, progress: 0, savedAt: 0 }),
    ).toBeNull();
  });
});

describe("readVolume/readMuted", () => {
  it("return null when nothing is stored", () => {
    expect(readVolume()).toBeNull();
    expect(readMuted()).toBeNull();
  });
});
