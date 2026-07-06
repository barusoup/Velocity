import { describe, expect, it } from "vitest";

import { assertInvariants, maxSyncsForPlayingTicks } from "./invariants";
import {
  defaultPlayerState,
  play,
  pause,
  ScenarioRunner,
  skipTo,
  track,
} from "./scenario-runner";
import { makeTrack } from "./simulator";

describe("Discord presence deep scenarios", () => {
  it("rapid skip chain always ends on the final track", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const songs = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((title) => track(title));

    runner.runStep({ kind: "player", state: { track: songs[0], ...play(10) } });
    for (let i = 1; i < songs.length; i += 1) {
      runner.runStep({ kind: "player", state: skipTo(songs[i]!, play(0)) });
      runner.runStep({ kind: "assert-invariants" });
    }

    expect(runner.getSimulator().isActivityShowing("Echo")).toBe(true);
    runner.assertNow();
  });

  it("skip while IPC is down then advance eventually shows the skipped-to track", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 5_000 } });
    const first = track("Before");
    const second = track("After");

    runner.runStep({ kind: "player", state: { track: first, ...play(40) } });
    runner.runStep({ kind: "player", state: skipTo(second, play(0)) });
    expect(runner.getSimulator().isActivityShowing("After")).toBe(false);

    runner.runStep({ kind: "advance", ms: 6_500 });
    expect(runner.getSimulator().isActivityShowing("After")).toBe(true);
    runner.assertNow();
  });

  it("stale IPC success after skip does not mark the wrong track confirmed", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const first = track("Stale Winner");
    const second = track("Current");

    runner.runStep({ kind: "player", state: { track: first, ...play(12) } });
    const genBeforeSkip = runner.getEngineState().syncGeneration;

    runner.runStep({ kind: "player", state: skipTo(second, pause(0)) });
    expect(runner.getEngineState().syncGeneration).toBeGreaterThan(genBeforeSkip);

    const applied = runner.getSyncLog().filter((entry) => entry.applied);
    const lastApplied = applied.at(-1);
    expect(lastApplied?.payload.title).toBe("Current");
    if (runner.getEngineState().ipcConfirmed) {
      expect(runner.getSimulator().getActivity().payload?.title).toBe("Current");
    }
    runner.assertNow();
  });

  it("unpause after session restore applies timestamps at the saved progress", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "advance", ms: 2_000_000 });
    runner.runStep({ kind: "player", state: { track: song, ...pause(88) } });
    runner.runStep({ kind: "player", state: { track: song, ...play(88) } });

    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.paused).toBe(false);
    expect(payload?.startedAt).toBe(2_000_000 - 88_000);
    expect(payload?.endsAt).toBe(2_000_000 - 88_000 + 240_000);
    runner.assertNow();
  });

  it("pause at 0:00 after brief play strips timestamps", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "advance", ms: 2_000_000 });
    runner.runStep({ kind: "player", state: { track: song, ...play(0) } });
    expect(runner.getSimulator().getActivity().payload?.startedAt).toBe(2_000_000);

    runner.runStep({ kind: "player", state: { track: song, ...pause(0) } });
    expect(runner.getSimulator().getActivity().payload?.paused).toBe(true);
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();

    runner.runStep({ kind: "advance", ms: 8_000 });
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();
    runner.assertNow();
  });

  it("stale playing invoke after pause cannot restore timestamps", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...play(12) } });
    runner.runStep({ kind: "player", state: { track: song, ...pause(12) } });
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();

    const stalePlaying = {
      enabled: true,
      paused: false,
      title: song.title,
      artist: song.artist,
      album: song.album,
      state: "Test Artist · Test Album",
      startedAt: 1_000,
      endsAt: 241_000,
      generation: runner.getEngineState().syncGeneration - 1,
    };
    expect(runner.getSimulator().getIpc().applyUpdate(stalePlaying)).toBe(true);
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();
    runner.assertNow();
  });

  it("pause clears timestamps even when the worker lost timestamps_active", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...play(40) } });
    runner.getSimulator().getIpc().seedStaleDiscordTimestamps(1_000, 241_000);
    expect(runner.getSimulator().getIpc().hasActiveTimestamps()).toBe(false);

    runner.runStep({ kind: "player", state: { track: song, ...pause(40) } });
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();
    expect(runner.getSimulator().getIpc().hasActiveTimestamps()).toBe(false);
    runner.assertNow();
  });

  it("pause while playing strips timestamps immediately", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...play(55) } });
    expect(runner.getSimulator().getActivity().payload?.startedAt).not.toBeNull();

    runner.runStep({ kind: "player", state: { track: song, ...pause(55) } });
    expect(runner.getSimulator().getActivity().payload?.paused).toBe(true);
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();
    runner.assertNow();
  });

  it("unpause after mid-song pause restores timestamps from current progress", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "advance", ms: 500_000 });
    runner.runStep({ kind: "player", state: { track: song, ...play(20) } });
    runner.runStep({ kind: "player", state: { track: song, ...pause(35) } });
    runner.runStep({ kind: "player", state: { track: song, ...play(35) } });

    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.startedAt).toBe(500_000 - 35_000);
    runner.assertNow();
  });

  it("skip while paused lands on the new title without timestamps", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "player", state: { track: track("One"), ...pause(50) } });
    runner.runStep({ kind: "player", state: skipTo(track("Two"), pause(0)) });

    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.title).toBe("Two");
    expect(payload?.paused).toBe(true);
    expect(payload?.startedAt ?? null).toBeNull();
    runner.assertNow();
  });

  it("skip while playing resets timestamps for the new track at t=0", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "advance", ms: 100_000 });
    runner.runStep({ kind: "player", state: { track: track("One"), ...play(90) } });
    runner.runStep({ kind: "player", state: skipTo(track("Two"), play(0)) });

    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.title).toBe("Two");
    expect(payload?.startedAt).toBe(100_000);
    runner.assertNow();
  });

  it("buffering during skip shows frozen state for the new track", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "player", state: { track: track("One"), ...play(10) } });
    runner.runStep({
      kind: "player",
      state: {
        ...skipTo(track("Two")),
        isPlaying: true,
        isBuffering: true,
        progress: 0,
      },
    });

    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.title).toBe("Two");
    expect(payload?.paused).toBe(true);
    expect(payload?.startedAt ?? null).toBeNull();
    runner.assertNow();
  });

  it("buffering end while playing restores timestamps", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...play(18) } });
    runner.runStep({ kind: "player", state: { track: song, isPlaying: true, isBuffering: true, progress: 18, duration: 240, seekRevision: 0 } });
    runner.runStep({ kind: "player", state: { track: song, ...play(18) } });

    expect(runner.getSimulator().getActivity().payload?.startedAt).not.toBeNull();
    runner.assertNow();
  });

  it("disable during retry clears and stops retrying", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 10_000 } });
    runner.runStep({ kind: "player", state: { track: makeTrack(), ...play(5) } });
    expect(runner.getSimulator().hasPendingRetry()).toBe(true);

    runner.runStep({ kind: "set-enabled", enabled: false });
    expect(runner.getSimulator().hasPendingRetry()).toBe(false);
    expect(runner.getSimulator().isActivityShowing()).toBe(false);
    runner.assertNow();
  });

  it("re-enable during playback restores current track", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = track("Resume Me");

    runner.runStep({ kind: "player", state: { track: song, ...play(12) } });
    runner.runStep({ kind: "set-enabled", enabled: false });
    runner.runStep({ kind: "set-enabled", enabled: true });

    expect(runner.getSimulator().isActivityShowing("Resume Me")).toBe(true);
    runner.assertNow();
  });

  it("queue clear removes track title from activity", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "player", state: { track: makeTrack(), ...play(4) } });
    runner.runStep({ kind: "player", state: defaultPlayerState() });

    expect(runner.getSimulator().getActivity().payload?.title ?? null).toBeNull();
    runner.assertNow();
  });

  it("duration becoming available while playing triggers exactly one more sync", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack({ durationSeconds: 300 });
    const baseline = () => runner.getSyncLog().length;

    runner.runStep({
      kind: "player",
      state: {
        track: song,
        isPlaying: true,
        isBuffering: false,
        progress: 2,
        duration: 0,
        seekRevision: 0,
      },
    });
    const afterStart = baseline();

    runner.runStep({ kind: "player", state: { track: song, ...play(2), duration: 300 } });
    expect(baseline()).toBe(afterStart + 1);
    expect(runner.getSimulator().getActivity().payload?.startedAt).not.toBeNull();
    runner.assertNow();
  });

  it("playing progress ticks stay within sync budget", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...play(0) } });
    const startCount = runner.getSyncLog().length;

    for (let i = 1; i <= 20; i += 1) {
      runner.runStep({ kind: "advance", ms: 1_000 });
      runner.runStep({ kind: "player", state: { track: song, ...play(i) } });
    }

    const total = runner.getSyncLog().length - startCount;
    expect(total).toBeLessThanOrEqual(maxSyncsForPlayingTicks(20, 0, 1));
    runner.assertNow();
  });

  it("flaky IPC recovers on skip without sticking on the previous song", () => {
    const runner = new ScenarioRunner({
      ipc: { readyAtMs: 0, disconnectEverySuccess: 1, failConnectCount: 1 },
    });
    const first = track("Flaky A");
    const second = track("Flaky B");

    runner.runStep({ kind: "player", state: { track: first, ...play(8) } });
    runner.runStep({ kind: "player", state: skipTo(second, play(0)) });
    runner.runStep({ kind: "advance", ms: 7_000 });

    expect(runner.getSimulator().isActivityShowing("Flaky B")).toBe(true);
    runner.assertNow();
  });

  it("upload cover resolution after skip does not override the current track art", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const upload = makeTrack({
      id: "upload-1",
      source: "upload",
      cover: null,
      title: "Upload",
    });
    const stream = track("Stream Now");

    runner.runStep({ kind: "player", state: { track: upload, ...pause(0) } });
    runner.runStep({ kind: "player", state: skipTo(stream, play(0)) });
    runner.runStep({
      kind: "upload-cover",
      trackId: "upload-1",
      cover: { coverUrl: "https://example.com/old.jpg", videoId: "old" },
    });
    runner.runStep({ kind: "upload-cover-resolved" });

    expect(runner.getSimulator().getActivity().payload?.title).toBe("Stream Now");
    runner.assertNow();
  });

  it("toggle pause/play/pause does not spam Discord", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();
    runner.runStep({ kind: "player", state: { track: song, ...play(10) } });
    const baseline = runner.getSyncLog().length;

    runner.runStep({ kind: "player", state: { track: song, ...pause(10) } });
    runner.runStep({ kind: "player", state: { track: song, ...play(10) } });
    runner.runStep({ kind: "player", state: { track: song, ...pause(10) } });

    expect(runner.getSyncLog().length - baseline).toBeLessThanOrEqual(3);
    runner.assertNow();
  });

  it("unpause when IPC never succeeded on restore still converges", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 8_000 } });
    const song = makeTrack();

    runner.runStep({ kind: "player", state: { track: song, ...pause(72) } });
    expect(runner.getEngineState().ipcConfirmed).toBe(false);

    runner.runStep({ kind: "player", state: { track: song, ...play(72) } });
    expect(runner.getSimulator().getActivity().payload?.startedAt ?? null).toBeNull();

    runner.runStep({ kind: "advance", ms: 9_000 });
    expect(runner.getSimulator().isActivityShowing(song.title)).toBe(true);
    expect(runner.getSimulator().getActivity().payload?.paused).toBe(false);
    runner.assertNow();
  });

  it("rapid skip while playing only issues bounded sync attempts", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const titles = ["S1", "S2", "S3", "S4"];
    runner.runStep({ kind: "player", state: { track: track(titles[0]!), ...play(3) } });
    const start = runner.getSyncLog().length;

    for (let i = 1; i < titles.length; i += 1) {
      runner.runStep({ kind: "player", state: skipTo(track(titles[i]!), play(0)) });
    }

    expect(runner.getSyncLog().length - start).toBeLessThanOrEqual(titles.length);
    expect(runner.getSimulator().isActivityShowing("S4")).toBe(true);
    runner.assertNow();
  });

  it("pause during skip buffering stays frozen until play resumes", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "player", state: { track: track("A"), ...play(20) } });
    runner.runStep({
      kind: "player",
      state: {
        ...skipTo(track("B")),
        isPlaying: false,
        isBuffering: true,
        progress: 0,
      },
    });
    expect(runner.getSimulator().getActivity().payload?.paused).toBe(true);

    runner.runStep({ kind: "player", state: skipTo(track("B"), play(0)) });
    expect(runner.getSimulator().getActivity().payload?.startedAt).not.toBeNull();
    runner.assertNow();
  });

  it("seek while playing forces an immediate sync", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    const song = makeTrack();
    runner.runStep({ kind: "player", state: { track: song, ...play(5) } });
    const baseline = runner.getSyncLog().length;

    runner.runStep({
      kind: "player",
      state: {
        track: song,
        isPlaying: true,
        isBuffering: false,
        progress: 120,
        duration: 240,
        seekRevision: 1,
      },
    });

    expect(runner.getSyncLog().length).toBe(baseline + 1);
    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.startedAt).not.toBeNull();
    runner.assertNow();
  });
});