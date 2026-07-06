import { describe, expect, it } from "vitest";

import { checkPresenceInvariants } from "./invariants";
import { defaultPlayerState, ScenarioRunner } from "./scenario-runner";
import { makeTrack } from "./simulator";

type FuzzAction =
  | { type: "advance"; ms: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "buffer" }
  | { type: "unbuffer" }
  | { type: "skip" }
  | { type: "seek" }
  | { type: "toggle-enabled" }
  | { type: "clear-queue" };

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

describe("Discord presence fuzz", () => {
  it("randomized playback sequences satisfy invariants", () => {
    const seeds = [1, 7, 42, 99, 2026];
    for (const seed of seeds) {
      const rand = mulberry32(seed);
      const runner = new ScenarioRunner({
        ipc: {
          readyAtMs: Math.floor(rand() * 2_000),
          failConnectCount: Math.floor(rand() * 3),
        },
      });

      const tracks = Array.from({ length: 6 }, (_, i) =>
        makeTrack({ id: `fuzz-${seed}-${i}`, title: `Song ${i}` }),
      );

      let player = defaultPlayerState({
        track: tracks[0]!,
        isPlaying: false,
        isBuffering: true,
        progress: 0,
        duration: 240,
      });
      runner.runStep({ kind: "purge-startup" });
      runner.runStep({ kind: "player", state: player });

      const actions: FuzzAction[] = [
        { type: "advance", ms: 250 },
        { type: "play" },
        { type: "pause" },
        { type: "buffer" },
        { type: "unbuffer" },
        { type: "skip" },
        { type: "seek" },
        { type: "toggle-enabled" },
        { type: "clear-queue" },
      ];

      for (let step = 0; step < 80; step += 1) {
        const action = pick(rand, actions);
        switch (action.type) {
          case "advance":
            runner.runStep({ kind: "advance", ms: 200 + Math.floor(rand() * 1_200) });
            break;
          case "play":
            player = {
              ...player,
              isPlaying: true,
              isBuffering: false,
              progress: player.progress,
            };
            runner.runStep({ kind: "player", state: player });
            break;
          case "pause":
            player = { ...player, isPlaying: false, isBuffering: false };
            runner.runStep({ kind: "player", state: player });
            break;
          case "buffer":
            player = { ...player, isBuffering: true };
            runner.runStep({ kind: "player", state: player });
            break;
          case "unbuffer":
            player = { ...player, isBuffering: false };
            runner.runStep({ kind: "player", state: player });
            break;
          case "skip": {
            const next = pick(rand, tracks);
            player = {
              ...player,
              track: next,
              progress: 0,
              seekRevision: player.seekRevision + 1,
              isPlaying: rand() > 0.3,
              isBuffering: rand() > 0.8,
            };
            runner.runStep({ kind: "player", state: player });
            break;
          }
          case "seek":
            player = {
              ...player,
              progress: Math.floor(rand() * 200),
              seekRevision: player.seekRevision + 1,
            };
            runner.runStep({ kind: "player", state: player });
            break;
          case "toggle-enabled":
            runner.runStep({ kind: "set-enabled", enabled: rand() > 0.5 });
            break;
          case "clear-queue":
            player = defaultPlayerState();
            runner.runStep({ kind: "player", state: player });
            break;
          default:
            break;
        }

        expect(runner.checkNow(), `seed ${seed} step ${step}`).toEqual([]);
      }

      runner.runStep({ kind: "advance", ms: 8_000 });
      expect(
        checkPresenceInvariants({
          snapshot: player,
          engineState: runner.getEngineState(),
          activity: runner.getSimulator().getActivity(),
          syncLog: runner.getSyncLog(),
          enabled: runner.isEnabled(),
          pendingRetry: runner.getSimulator().hasPendingRetry(),
        }),
        `seed ${seed} final`,
      ).toEqual([]);
    }
  });
});