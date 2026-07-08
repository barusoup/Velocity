import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTrack } from "./types";
import {
  countPlaysInPeriod,
  clearTasteProfile,
  getTopSongs,
  getYesterdayDailyRecommendationVideoIds,
  isTasteProfileEmpty,
  loadTasteProfile,
  recordQualifiedListen,
  saveTasteProfile,
  TASTE_PROFILE_KEY,
  todayDateKey,
} from "./taste-profile";

function sampleTrack(id = "yt:abc"): MediaTrack {
  return {
    id,
    kind: "song",
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    videoId: "abc",
    source: "stream",
    filePath: null,
    durationSeconds: 200,
  };
}

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: () => null,
    length: storage.size,
  });
});

describe("taste profile", () => {
  it("records qualified listens at 75% threshold via API", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    recordQualifiedListen(sampleTrack(), now);
    const state = loadTasteProfile();
    expect(state.entries.abc).toBeDefined();
    expect(state.entries.abc.playCount).toBe(1);
    expect(state.entries.abc.qualifiedPlays).toEqual([now]);
  });

  it("ranks top songs by period", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const weekAgo = now - 8 * 24 * 60 * 60 * 1000;

    saveTasteProfile({
      entries: {
        abc: {
          videoId: "abc",
          trackId: "yt:abc",
          title: "Recent",
          artist: "A",
          playCount: 2,
          firstPlayedAt: now,
          lastPlayedAt: now,
          qualifiedPlays: [now, now - 1000],
        },
        def: {
          videoId: "def",
          trackId: "yt:def",
          title: "Old",
          artist: "B",
          playCount: 5,
          firstPlayedAt: weekAgo,
          lastPlayedAt: weekAgo,
          qualifiedPlays: [weekAgo, weekAgo, weekAgo, weekAgo, weekAgo],
        },
      },
      lastProfileChangeAt: now,
      rediscoveryPool: [],
      recommendationHistory: [],
      dailyRecommendations: null,
      lastRecommendationRefreshAt: null,
    });

    expect(countPlaysInPeriod(loadTasteProfile().entries.abc, "weekly", now)).toBe(2);
    expect(countPlaysInPeriod(loadTasteProfile().entries.def, "weekly", now)).toBe(0);
    expect(getTopSongs("weekly", 5, now)[0].title).toBe("Recent");
    expect(getTopSongs("allTime", 5, now)[0].title).toBe("Old");
  });

  it("persists under velocity key", () => {
    recordQualifiedListen(sampleTrack());
    expect(storage.get(TASTE_PROFILE_KEY)).toBeTruthy();
    expect(todayDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("clears taste profile data", () => {
    recordQualifiedListen(sampleTrack());
    expect(isTasteProfileEmpty()).toBe(false);
    clearTasteProfile();
    expect(isTasteProfileEmpty()).toBe(true);
    expect(getTopSongs("allTime", 5)).toHaveLength(0);
  });

  it("merges qualified listens for the same song under different video ids", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    recordQualifiedListen(sampleTrack("yt:catalog"), now);
    recordQualifiedListen(
      {
        ...sampleTrack("yt:audio"),
        videoId: "catalog",
        resolvedVideoId: "audio",
      },
      now + 1_000,
    );

    const state = loadTasteProfile();
    expect(Object.keys(state.entries)).toHaveLength(1);
    expect(Object.values(state.entries)[0]?.playCount).toBe(2);
  });

  it("does not overwrite a known artist with Unknown artist when merging listens", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    recordQualifiedListen(sampleTrack("yt:catalog"), now);
    recordQualifiedListen(
      {
        ...sampleTrack("yt:audio"),
        videoId: "catalog",
        resolvedVideoId: "audio",
        artist: "Unknown artist",
      },
      now + 1_000,
    );

    expect(Object.values(loadTasteProfile().entries)[0]?.artist).toBe("Test Artist");
  });

  it("dedupes top songs when the same song was tracked under multiple video ids", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);

    saveTasteProfile({
      entries: {
        catalog: {
          videoId: "catalog",
          trackId: "yt:catalog",
          title: "Same Song",
          artist: "Artist",
          playCount: 2,
          firstPlayedAt: now,
          lastPlayedAt: now,
          qualifiedPlays: [now, now - 1_000],
        },
        audio: {
          videoId: "audio",
          trackId: "yt:audio",
          title: "Same Song",
          artist: "Artist",
          playCount: 3,
          firstPlayedAt: now,
          lastPlayedAt: now + 2_000,
          qualifiedPlays: [now + 2_000, now + 1_000, now + 500],
        },
      },
      lastProfileChangeAt: now,
      rediscoveryPool: [],
      recommendationHistory: [],
      dailyRecommendations: null,
      lastRecommendationRefreshAt: null,
    });

    const topSongs = getTopSongs("weekly", 10, now + 3_000);
    expect(topSongs).toHaveLength(1);
    expect(topSongs[0]?.title).toBe("Same Song");
    expect(topSongs[0]?.videoId).toBe("audio");
  });

  it("migrates taste profile storage to the resolved studio video id", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    recordQualifiedListen(
      {
        ...sampleTrack("yt:catalog"),
        videoId: "catalog",
        kind: "video",
        title: "Song (Official Music Video)",
      },
      now,
    );
    recordQualifiedListen(
      {
        ...sampleTrack("yt:audio"),
        videoId: "catalog",
        resolvedVideoId: "audio",
      },
      now + 1_000,
    );

    const state = loadTasteProfile();
    expect(Object.keys(state.entries)).toHaveLength(1);
    expect(state.entries.audio?.videoId).toBe("audio");
    expect(state.entries.audio?.resolvedVideoId).toBe("audio");
    expect(state.entries.catalog).toBeUndefined();
  });

  it("returns yesterday's daily recommendation video ids only for the prior day", () => {
    const today = Date.UTC(2026, 0, 12, 12, 0, 0);
    const yesterday = todayDateKey(today - 24 * 60 * 60 * 1000);

    saveTasteProfile({
      entries: {},
      lastProfileChangeAt: 0,
      rediscoveryPool: [],
      recommendationHistory: [],
      dailyRecommendations: {
        date: yesterday,
        tracks: [
          sampleTrack("yt:yesterday-a"),
          { ...sampleTrack("yt:yesterday-b"), videoId: "yesterday-b" },
        ],
      },
      lastRecommendationRefreshAt: today - 24 * 60 * 60 * 1000,
    });

    expect(getYesterdayDailyRecommendationVideoIds(today)).toEqual(new Set(["abc", "yesterday-b"]));
    expect(getYesterdayDailyRecommendationVideoIds(today - 24 * 60 * 60 * 1000)).toEqual(new Set());
  });
});