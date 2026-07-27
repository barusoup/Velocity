import { describe, expect, it, vi } from "vitest";
import type { MediaTrack } from "../types";
import {
  resolveAutoplayAdditions,
  type AutoplayResolverDeps,
  type AutoplayResolverInput,
  type AutoplaySeed,
} from "./autoplayResolver";

function makeTrack(overrides: Partial<MediaTrack> & { id: string }): MediaTrack {
  const { id, ...rest } = overrides;
  return {
    ...rest,
    id,
    title: overrides.title ?? `Song ${id}`,
    artist: overrides.artist ?? `Artist ${id}`,
    kind: overrides.kind ?? "song",
    videoId: overrides.videoId ?? id,
    source: "stream",
  } as MediaTrack;
}

function buildDeps(
  overrides: Partial<AutoplayResolverDeps> = {},
): AutoplayResolverDeps {
  return {
    getWatchPlaylist: vi.fn().mockResolvedValue({ tracks: [], playlistId: null }),
    resolveAutoplayEntryToSong: vi.fn().mockImplementation((entry) => Promise.resolve(entry)),
    buildSeenIndex: (queue) => {
      const ids = new Set<string>();
      const videoIds = new Set<string>();
      const artistTitles = new Set<string>();
      for (const entry of queue) {
        ids.add(entry.id);
        if (entry.videoId) videoIds.add(entry.videoId);
        artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
      }
      return { ids, videoIds, artistTitles };
    },
    isInRecentlyPlayed: () => false,
    ...overrides,
  };
}

function buildInput(overrides: Partial<AutoplayResolverInput> & { seed: AutoplaySeed }): AutoplayResolverInput {
  return {
    queue: [],
    currentIndex: -1,
    autoplayIds: new Set<string>(),
    autoplayEnabled: () => true,
    seedStillCurrent: () => true,
    batchLimit: 20,
    queueTarget: 10,
    ...overrides,
  } as AutoplayResolverInput;
}

describe("resolveAutoplayAdditions", () => {
  it("returns empty when autoplay is disabled", async () => {
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      autoplayEnabled: () => false,
    });
    const deps = buildDeps();
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(0);
    expect(result.nextSeed).toBeNull();
    expect(deps.getWatchPlaylist).not.toHaveBeenCalled();
  });

  it("returns empty when the queue already has enough autoplay tracks", async () => {
    const manual = makeTrack({ id: "manual" });
    const autoplay = makeTrack({ id: "autoplay1" });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queue: [manual, autoplay],
      currentIndex: 0,
      autoplayIds: new Set([autoplay.id]),
      queueTarget: 1,
    });
    const deps = buildDeps();
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(0);
    expect(deps.getWatchPlaylist).not.toHaveBeenCalled();
  });

  it("resolves primary seed tracks and returns a next seed", async () => {
    const t1 = makeTrack({ id: "yt:a" });
    const t2 = makeTrack({ id: "yt:b" });
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks: [t1, t2],
        playlistId: "PLprimary",
      }),
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: "PLseed" },
      queueTarget: 2,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(2);
    expect(result.additions.map((t) => t.id)).toEqual(["yt:a", "yt:b"]);
    expect(result.playlistId).toBe("PLprimary");
    expect(result.nextSeed).toEqual({ videoId: "yt:b", playlistId: "PLprimary" });
  });

  it("drops music videos that the resolver rejects", async () => {
    const mv = makeTrack({ id: "yt:mv", kind: "video" });
    const studio = makeTrack({ id: "yt:studio" });
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks: [mv, studio],
        playlistId: null,
      }),
      resolveAutoplayEntryToSong: vi.fn().mockImplementation((entry) => {
        if (entry.kind === "video") return Promise.resolve(null);
        return Promise.resolve(entry);
      }),
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queueTarget: 1,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]!.id).toBe("yt:studio");
  });

  it("filters duplicates against the existing queue", async () => {
    const existing = makeTrack({ id: "yt:existing" });
    const t1 = makeTrack({ id: "yt:a" });
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks: [existing, t1],
        playlistId: null,
      }),
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queue: [existing],
      currentIndex: 0,
      queueTarget: 2,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]!.id).toBe("yt:a");
  });

  it("filters recently played tracks", async () => {
    const t1 = makeTrack({ id: "yt:a" });
    const t2 = makeTrack({ id: "yt:b" });
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks: [t1, t2],
        playlistId: null,
      }),
      isInRecentlyPlayed: (entry) => entry.id === "yt:a",
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queueTarget: 2,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]!.id).toBe("yt:b");
  });

  it("compensates from upcoming manual tracks when the primary seed is short", async () => {
    const manual = makeTrack({ id: "yt:manual", videoId: "manualVid" });
    const primary = makeTrack({ id: "yt:primary" });
    const compensatory = makeTrack({ id: "yt:comp" });

    const getWatchPlaylist = vi.fn().mockResolvedValue({ tracks: [], playlistId: null });
    getWatchPlaylist.mockImplementation((videoId: string) => {
      if (videoId === "seed") return Promise.resolve({ tracks: [primary], playlistId: "PLprimary" });
      if (videoId === "manualVid") return Promise.resolve({ tracks: [compensatory], playlistId: null });
      return Promise.resolve({ tracks: [], playlistId: null });
    });

    const deps = buildDeps({ getWatchPlaylist });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queue: [manual],
      currentIndex: -1,
      queueTarget: 2,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(2);
    expect(result.additions.map((t) => t.id)).toEqual(["yt:primary", "yt:comp"]);
    expect(getWatchPlaylist).toHaveBeenCalledWith("manualVid", null);
  });

  it("respects seedStillCurrent cancellation", async () => {
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks: [makeTrack({ id: "yt:a" })],
        playlistId: null,
      }),
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queueTarget: 2,
      seedStillCurrent: () => false,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(0);
  });

  it("continues compensating when a manual seed fetch fails", async () => {
    const manual1 = makeTrack({ id: "yt:manual1", videoId: "manual1" });
    const manual2 = makeTrack({ id: "yt:manual2", videoId: "manual2" });
    const compensatory = makeTrack({ id: "yt:comp" });

    const getWatchPlaylist = vi.fn().mockResolvedValue({ tracks: [], playlistId: null });
    getWatchPlaylist.mockImplementation((videoId: string) => {
      if (videoId === "seed") return Promise.resolve({ tracks: [], playlistId: "PLprimary" });
      if (videoId === "manual1") return Promise.reject(new Error("network"));
      if (videoId === "manual2") return Promise.resolve({ tracks: [compensatory], playlistId: null });
      return Promise.resolve({ tracks: [], playlistId: null });
    });

    const deps = buildDeps({ getWatchPlaylist });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queue: [manual1, manual2],
      currentIndex: -1,
      queueTarget: 1,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]!.id).toBe("yt:comp");
    expect(getWatchPlaylist).toHaveBeenCalledWith("manual1", null);
    expect(getWatchPlaylist).toHaveBeenCalledWith("manual2", null);
  });

  it("does not reuse the same manual videoId twice", async () => {
    const manual = makeTrack({ id: "yt:manual", videoId: "manualVid" });
    const compensatory = makeTrack({ id: "yt:comp" });

    const getWatchPlaylist = vi.fn().mockResolvedValue({ tracks: [], playlistId: null });
    getWatchPlaylist.mockImplementation((videoId: string) => {
      if (videoId === "seed") return Promise.resolve({ tracks: [], playlistId: null });
      if (videoId === "manualVid") return Promise.resolve({ tracks: [compensatory], playlistId: null });
      return Promise.resolve({ tracks: [], playlistId: null });
    });

    const deps = buildDeps({ getWatchPlaylist });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queue: [manual, manual],
      currentIndex: -1,
      queueTarget: 1,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(1);
    expect(getWatchPlaylist).toHaveBeenCalledTimes(2);
    expect(getWatchPlaylist).toHaveBeenCalledWith("manualVid", null);
  });

  it("caps additions at batchLimit and queueTarget", async () => {
    const tracks = Array.from({ length: 30 }, (_, i) => makeTrack({ id: `yt:${i}` }));
    const deps = buildDeps({
      getWatchPlaylist: vi.fn().mockResolvedValue({
        tracks,
        playlistId: null,
      }),
    });
    const input = buildInput({
      seed: { videoId: "seed", playlistId: null },
      queueTarget: 5,
      batchLimit: 3,
    });
    const result = await resolveAutoplayAdditions(input, deps);
    expect(result.additions).toHaveLength(3);
  });
});
