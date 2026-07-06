import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTrack } from "./types";
import {
  clearTasteProfile,
  countPlaysInPeriod,
  loadTasteProfile,
  QUALIFIED_PLAYS_MAX,
  recordQualifiedListen,
} from "./taste-profile";
import {
  getLyricsExhaustionRegistrySizes,
  prefetchSyncedLyricsForTrack,
} from "./api";
import { setCachedLoudness, getCachedLoudness, LOUDNESS_CACHE_MAX_ENTRIES } from "./normalization";
import { compactQueueForHistorySnapshot, PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX } from "./utils/playback-history-snapshot";
import { registerContextTrack, lookupContextTrack } from "./utils/track-context-registry";
import {
  addVisitedQueueTrack,
  resetVisitedQueueTracks,
} from "./utils/queue-visited";

function sampleTrack(overrides: Partial<MediaTrack> & { id: string }): MediaTrack {
  return {
    kind: "song",
    title: "Stress Song",
    artist: "Stress Artist",
    album: "Stress Album",
    videoId: overrides.id.replace(/^yt:/, ""),
    source: "stream",
    filePath: null,
    durationSeconds: 200,
    ...overrides,
  };
}

function heapUsedBytes(): number {
  if (typeof global.gc === "function") global.gc();
  return process.memoryUsage().heapUsed;
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
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      invoke: vi.fn().mockResolvedValue(null),
    },
  });
  clearTasteProfile();
});

describe("memory stress — taste profile", () => {
  it("caps qualifiedPlays growth across thousands of listens on one song", () => {
    const track = sampleTrack({ id: "yt:repeat" });
    const baseNow = Date.UTC(2026, 5, 1, 12, 0, 0);

    for (let i = 0; i < 5_000; i += 1) {
      recordQualifiedListen(track, baseNow + i * 60_000);
    }

    const entry = loadTasteProfile().entries.repeat;
    expect(entry).toBeDefined();
    expect(entry!.qualifiedPlays.length).toBeLessThanOrEqual(QUALIFIED_PLAYS_MAX);
    expect(entry!.playCount).toBe(5_000);
    expect(countPlaysInPeriod(entry!, "yearly", baseNow + 5_000 * 60_000)).toBeGreaterThan(0);
  });

  it("retains at most TASTE_PROFILE_MAX_ENTRIES distinct songs", () => {
    const baseNow = Date.UTC(2026, 5, 1, 12, 0, 0);
    for (let i = 0; i < 400; i += 1) {
      recordQualifiedListen(
        sampleTrack({ id: `yt:song-${i}`, title: `Song ${i}` }),
        baseNow + i,
      );
    }
    expect(Object.keys(loadTasteProfile().entries).length).toBeLessThanOrEqual(250);
  });
});

describe("memory stress — lyrics exhaustion", () => {
  it("bounds session exhaustion registries across thousands of unique tracks", async () => {
    for (let i = 0; i < 2_000; i += 1) {
      const track = sampleTrack({
        id: `yt:lyrics-${i}`,
        videoId: `vid${i}`,
        title: `Title ${i}`,
        artist: `Artist ${i}`,
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        prefetchSyncedLyricsForTrack(track);
        await Promise.resolve();
      }
    }

    const sizes = getLyricsExhaustionRegistrySizes();
    expect(sizes.exhaustedKeys).toBeLessThanOrEqual(500);
    expect(sizes.failureCounts).toBeLessThanOrEqual(500);
  });
});

describe("memory stress — loudness cache", () => {
  it("caps persisted loudness analysis entries", () => {
    for (let i = 0; i < LOUDNESS_CACHE_MAX_ENTRIES + 500; i += 1) {
      setCachedLoudness(`track-${i}`, {
        integratedLufs: -14,
        truePeak: -2,
        analysisVersion: 2,
      });
    }

    expect(getCachedLoudness("track-0")).toBeNull();
    expect(getCachedLoudness(`track-${LOUDNESS_CACHE_MAX_ENTRIES + 499}`)).not.toBeNull();
  });
});

describe("memory stress — playback history snapshots", () => {
  it("windows oversized queue snapshots around the playhead", () => {
    const queue = Array.from({ length: 800 }, (_, i) =>
      sampleTrack({ id: `yt:q-${i}`, title: `Q ${i}` }),
    );
    const { queue: compacted, queueIndex } = compactQueueForHistorySnapshot(queue, 400);

    expect(compacted.length).toBeLessThanOrEqual(PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX);
    expect(compacted[queueIndex]?.id).toBe("yt:q-400");
  });
});

describe("memory stress — context track registry", () => {
  it("unregisters tracks and does not grow without bound", () => {
    const before = heapUsedBytes();
    const cleanups: Array<() => void> = [];

    for (let i = 0; i < 10_000; i += 1) {
      const track = sampleTrack({ id: `yt:ctx-${i}` });
      cleanups.push(registerContextTrack(track));
      cleanups[cleanups.length - 1]!();
    }

    expect(lookupContextTrack("yt:ctx-9999")).toBeNull();
    const after = heapUsedBytes();
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("memory stress — queue visited set", () => {
  it("handles heavy churn without retaining stale visited ids", () => {
    let visited = resetVisitedQueueTracks("seed");
    for (let i = 0; i < 20_000; i += 1) {
      visited = addVisitedQueueTrack(visited, `track-${i}`);
    }
    expect(visited.size).toBe(20_001);
    visited = resetVisitedQueueTracks("fresh");
    expect(visited.size).toBe(1);
  });
});