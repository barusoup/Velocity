import { describe, expect, it } from "vitest";

import { buildTimestamps } from "./payload";
import { DiscordPresenceSimulator, makeTrack } from "./simulator";

function restoredPausedSnapshot(progress = 142) {
  return {
    track: makeTrack(),
    isPlaying: false,
    isBuffering: false,
    progress,
    duration: 240,
    seekRevision: 0,
  };
}

function playingSnapshot(progress = 30) {
  return {
    track: makeTrack(),
    isPlaying: true,
    isBuffering: false,
    progress,
    duration: 240,
    seekRevision: 0,
  };
}

describe("Discord presence simulator", () => {
  it("session restore paused: shows activity once Discord IPC is ready", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 1_000 });
    sim.purgeStaleOnStartup();

    sim.run({ type: "player", snapshot: restoredPausedSnapshot() });
    expect(sim.isActivityShowing()).toBe(false);

    sim.run({ type: "advance", ms: 500 });
    expect(sim.isActivityShowing()).toBe(false);

    sim.run({ type: "advance", ms: 1_700 });
    expect(sim.isActivityShowing("Test Song")).toBe(true);
    expect(sim.getActivity().payload?.paused).toBe(true);
    expect(sim.getActivity().payload?.startedAt ?? null).toBeNull();
  });

  it("session restore: progress settle after load re-syncs while still paused", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({
      type: "player",
      snapshot: {
        ...restoredPausedSnapshot(0),
        isBuffering: true,
      },
    });
    expect(sim.isActivityShowing()).toBe(true);

    sim.run({
      type: "player",
      snapshot: restoredPausedSnapshot(142),
    });
    expect(sim.isActivityShowing()).toBe(true);
    expect(sim.getSyncLog().length).toBe(2);
  });

  it("strict-mode remount re-establishes presence without a track change", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({ type: "player", snapshot: restoredPausedSnapshot() });
    expect(sim.isActivityShowing()).toBe(true);

    sim.run({ type: "unmount" });
    sim.run({ type: "mount" });
    sim.run({ type: "player", snapshot: restoredPausedSnapshot() });
    expect(sim.isActivityShowing("Test Song")).toBe(true);
  });

  it("cold Discord IPC: retries until connected, then stops", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 2_500 });
    sim.run({ type: "player", snapshot: playingSnapshot() });

    const beforeReady = sim.getSyncLog().filter((entry) => entry.applied);
    expect(beforeReady).toHaveLength(0);

    sim.run({ type: "advance", ms: 2_500 });
    expect(sim.isActivityShowing("Test Song")).toBe(true);

    const applied = sim.getSyncLog().filter((entry) => entry.applied);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(applied.length).toBeLessThanOrEqual(3);

    const failedAfterSuccess = sim.getSyncLog().slice(applied.at(-1)!.atMs).filter((e) => !e.applied);
    expect(failedAfterSuccess).toHaveLength(0);
  });

  it("startup purge + update: update still lands after purge", () => {
    const sim = new DiscordPresenceSimulator({
      readyAtMs: 0,
      purgeBeforeNextUpdate: true,
    });
    sim.purgeStaleOnStartup();
    sim.run({ type: "player", snapshot: restoredPausedSnapshot() });
    expect(sim.isActivityShowing("Test Song")).toBe(true);
  });

  it("play after restore attaches timestamps from settled progress", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    const now = 1_700_000_000_000;
    sim.run({ type: "advance", ms: now });
    sim.run({ type: "player", snapshot: restoredPausedSnapshot(60) });
    sim.run({ type: "player", snapshot: playingSnapshot(60) });

    const activity = sim.getActivity().payload;
    expect(activity?.paused).toBe(false);
    expect(activity?.startedAt).not.toBeNull();
    expect(activity?.endsAt).not.toBeNull();
    expect((activity?.endsAt ?? 0) - (activity?.startedAt ?? 0)).toBe(240_000);
  });

  it("paused playback does not spam syncs on progress ticks", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({ type: "player", snapshot: restoredPausedSnapshot(10) });
    const baseline = sim.getSyncLog().length;

    for (let progress = 11; progress <= 20; progress += 1) {
      sim.run({
        type: "player",
        snapshot: {
          ...restoredPausedSnapshot(progress),
        },
      });
    }

    expect(sim.getSyncLog().length).toBe(baseline);
  });

  it("playing syncs periodically and on seek jumps", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({ type: "player", snapshot: playingSnapshot(0) });
    const baseline = sim.getSyncLog().length;

    sim.run({ type: "player", snapshot: playingSnapshot(1) });
    expect(sim.getSyncLog().length).toBe(baseline);

    sim.run({ type: "advance", ms: 4_000 });
    sim.run({ type: "player", snapshot: playingSnapshot(5) });
    expect(sim.getSyncLog().length).toBe(baseline + 1);

    sim.run({
      type: "player",
      snapshot: {
        ...playingSnapshot(50),
        seekRevision: 1,
      },
    });
    expect(sim.getSyncLog().length).toBe(baseline + 2);
  });

  it("buffering clears timestamps; resume restores them", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({ type: "player", snapshot: playingSnapshot(12) });
    expect(sim.getActivity().payload?.startedAt).not.toBeNull();

    sim.run({
      type: "player",
      snapshot: {
        ...playingSnapshot(12),
        isBuffering: true,
      },
    });
    expect(sim.getActivity().payload?.paused).toBe(true);
    expect(sim.getActivity().payload?.startedAt ?? null).toBeNull();

    sim.run({ type: "player", snapshot: playingSnapshot(12) });
    expect(sim.getActivity().payload?.paused).toBe(false);
    expect(sim.getActivity().payload?.startedAt).not.toBeNull();
  });

  it("track skip replaces activity immediately", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({ type: "player", snapshot: playingSnapshot() });
    sim.run({
      type: "player",
      snapshot: {
        ...playingSnapshot(),
        track: makeTrack({ id: "track-2", title: "Next Song" }),
      },
    });
    expect(sim.getActivity().payload?.title).toBe("Next Song");
  });

  it("metadata enrichment while paused re-syncs art", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    const bare = makeTrack({
      source: "upload",
      cover: null,
      videoId: null,
    });
    sim.run({
      type: "player",
      snapshot: {
        track: bare,
        isPlaying: false,
        isBuffering: false,
        progress: 0,
        duration: 200,
        seekRevision: 0,
      },
    });
    const baseline = sim.getSyncLog().length;

    sim.run({
      type: "player",
      snapshot: {
        track: { ...bare, videoId: "ytm123", cover: "https://i.ytimg.com/vi/ytm123/hqdefault.jpg" },
        isPlaying: false,
        isBuffering: false,
        progress: 0,
        duration: 200,
        seekRevision: 0,
      },
    });
    expect(sim.getSyncLog().length).toBeGreaterThan(baseline);
    expect(sim.getActivity().payload?.videoId).toBe("ytm123");
  });

  it("full boot: empty mount → buffering restore → settled pause shows presence", () => {
    const sim = new DiscordPresenceSimulator({ readyAtMs: 800 });
    sim.purgeStaleOnStartup();

    sim.run({ type: "mount" });
    sim.run({
      type: "player",
      snapshot: {
        track: null,
        isPlaying: false,
        isBuffering: false,
        progress: 0,
        duration: 0,
        seekRevision: 0,
      },
    });

    sim.run({
      type: "player",
      snapshot: {
        track: makeTrack(),
        isPlaying: false,
        isBuffering: true,
        progress: 0,
        duration: 240,
        seekRevision: 0,
      },
    });
    expect(sim.isActivityShowing()).toBe(false);

    sim.run({
      type: "player",
      snapshot: restoredPausedSnapshot(96),
    });
    expect(sim.isActivityShowing()).toBe(false);

    sim.run({ type: "advance", ms: 1_700 });
    expect(sim.isActivityShowing("Test Song")).toBe(true);
    expect(sim.getActivity().payload?.paused).toBe(true);
  });

  it("buildTimestamps uses the supplied clock for stable progress math", () => {
    const track = makeTrack({ durationSeconds: 180 });
    const ts = buildTimestamps(45, 180, track, 1_000_000);
    expect(ts).toEqual({ startedAt: 955_000, endsAt: 1_135_000 });
  });

  it("no timestamps until live player duration is known", () => {
    const track = makeTrack({ durationSeconds: 240 });
    const sim = new DiscordPresenceSimulator({ readyAtMs: 0 });
    sim.run({
      type: "player",
      snapshot: {
        track,
        isPlaying: true,
        isBuffering: false,
        progress: 4,
        duration: 0,
        seekRevision: 0,
      },
    });
    expect(sim.getActivity().payload?.startedAt ?? null).toBeNull();

    sim.run({
      type: "player",
      snapshot: {
        track,
        isPlaying: true,
        isBuffering: false,
        progress: 4,
        duration: 240,
        seekRevision: 0,
      },
    });
    expect(sim.getActivity().payload?.startedAt).not.toBeNull();
  });
});