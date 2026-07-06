import { describe, expect, it } from "vitest";

import { assertInvariants } from "./invariants";
import { ScenarioRunner, track } from "./scenario-runner";
import { makeTrack } from "./simulator";

/**
 * Mirrors the real React/player effect order on cold boot with saveTimestamp restore.
 */
describe("startup lifecycle (player-faithful)", () => {
  it("mount before session restore does not clear Discord", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 0 } });
    runner.runStep({ kind: "mount" });
    expect(runner.getSyncLog()).toHaveLength(0);

    runner.runStep({
      kind: "player",
      state: {
        track: makeTrack(),
        isPlaying: false,
        isBuffering: true,
        progress: 0,
        duration: 240,
        seekRevision: 0,
      },
    });
    expect(runner.getSyncLog().length).toBeGreaterThanOrEqual(1);
    runner.assertNow();
  });

  it("session restore: load buffering → settled pause → unpause with source refresh", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 1_500 } });
    const song = makeTrack({ title: "Restored" });

    runner.runStep({ kind: "mount" });
    runner.runStep({
      kind: "player",
      state: {
        track: song,
        isPlaying: false,
        isBuffering: true,
        progress: 0,
        duration: 240,
        seekRevision: 0,
      },
    });

    runner.runStep({
      kind: "player",
      state: {
        track: song,
        isPlaying: false,
        isBuffering: false,
        progress: 118,
        duration: 240,
        seekRevision: 0,
      },
    });
    expect(runner.getSimulator().isActivityShowing()).toBe(false);

    runner.runStep({ kind: "advance", ms: 2_500 });
    expect(runner.getSimulator().isActivityShowing("Restored")).toBe(true);
    expect(runner.getSimulator().getActivity().payload?.paused).toBe(true);

    // User hits play after restore: playback resumes from the already-resolved
    // source without forcing a second stream download.
    runner.runStep({
      kind: "player",
      state: {
        track: song,
        isPlaying: true,
        isBuffering: false,
        progress: 118,
        duration: 240,
        seekRevision: 0,
      },
    });

    runner.runStep({ kind: "advance", ms: 1_000 });
    const payload = runner.getSimulator().getActivity().payload;
    expect(payload?.paused).toBe(false);
    expect(payload?.startedAt).not.toBeNull();
    assertInvariants({
      snapshot: {
        track: song,
        isPlaying: true,
        isBuffering: false,
        progress: 118,
        duration: 240,
        seekRevision: 0,
      },
      engineState: runner.getEngineState(),
      activity: runner.getSimulator().getActivity(),
      syncLog: runner.getSyncLog(),
      enabled: true,
      pendingRetry: runner.getSimulator().hasPendingRetry(),
    });
  });

  it("skip during startup handshake still lands on the new song", () => {
    const runner = new ScenarioRunner({ ipc: { readyAtMs: 3_000 } });
    runner.runStep({
      kind: "player",
      state: {
        track: track("Hold"),
        isPlaying: false,
        isBuffering: false,
        progress: 40,
        duration: 240,
        seekRevision: 0,
      },
    });
    runner.runStep({
      kind: "player",
      state: {
        track: track("Skip To"),
        isPlaying: true,
        isBuffering: true,
        progress: 0,
        duration: 240,
        seekRevision: 1,
      },
    });
    runner.runStep({ kind: "advance", ms: 5_000 });
    expect(runner.getSimulator().isActivityShowing("Skip To")).toBe(true);
    runner.assertNow();
  });
});