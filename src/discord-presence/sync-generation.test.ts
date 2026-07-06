import { describe, expect, it } from "vitest";

import {
  createPresenceEngineState,
  reducePresenceIpcResult,
  reducePresencePlayerUpdate,
  type PresenceSyncInput,
} from "./sync-engine";
import { makeTrack } from "./simulator";

function inputFor(
  overrides: Partial<PresenceSyncInput> = {},
): PresenceSyncInput {
  const track = overrides.track ?? makeTrack();
  return {
    track,
    isPlaying: overrides.isPlaying ?? true,
    isBuffering: overrides.isBuffering ?? false,
    progress: overrides.progress ?? 10,
    duration: overrides.duration ?? 240,
    seekRevision: overrides.seekRevision ?? 0,
    enabled: overrides.enabled ?? true,
    uploadCoverCache: overrides.uploadCoverCache ?? new Map(),
    nowMs: overrides.nowMs ?? 1_000,
  };
}

describe("sync generation stale IPC guard", () => {
  it("ignores stale success from a prior track generation", () => {
    let state = createPresenceEngineState();
    const first = reducePresencePlayerUpdate(state, inputFor({ track: makeTrack({ id: "a", title: "A" }) }));
    state = first.state;
    const genA = state.syncGeneration;

    const second = reducePresencePlayerUpdate(
      state,
      inputFor({ track: makeTrack({ id: "b", title: "B" }), progress: 0 }),
    );
    state = second.state;
    expect(state.syncGeneration).toBeGreaterThan(genA);
    expect(state.ipcConfirmed).toBe(false);

    const stale = reducePresenceIpcResult(state, inputFor(), true, genA);
    expect(stale.state.ipcConfirmed).toBe(false);
    expect(stale.effects).toHaveLength(0);
  });

  it("ignores stale failure so it does not schedule spurious retries", () => {
    let state = createPresenceEngineState();
    const first = reducePresencePlayerUpdate(state, inputFor());
    state = first.state;
    const gen = state.syncGeneration;

    const staleFail = reducePresenceIpcResult(state, inputFor(), false, gen - 1);
    expect(staleFail.effects).toHaveLength(0);
  });

  it("accepts success only for the current generation", () => {
    let state = createPresenceEngineState();
    const update = reducePresencePlayerUpdate(state, inputFor());
    state = update.state;
    const gen = state.syncGeneration;

    const accepted = reducePresenceIpcResult(state, inputFor(), true, gen);
    expect(accepted.state.ipcConfirmed).toBe(true);
    expect(accepted.effects).toEqual([{ type: "cancel-retry" }]);
  });
});