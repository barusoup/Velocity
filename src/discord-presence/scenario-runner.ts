import type { MediaTrack } from "../types";
import type { UploadDiscordCover } from "../utils/upload-enrichment";
import type { IpcSimulatorOptions } from "./ipc-simulator";
import { assertInvariants, checkPresenceInvariants } from "./invariants";
import {
  DiscordPresenceSimulator,
  makeTrack,
  type SimulatorEvent,
  type SyncLogEntry,
} from "./simulator";
import type { PresenceEngineState, PresencePlayerSnapshot } from "./sync-engine";

export type ScenarioPlayerState = PresencePlayerSnapshot & {
  track: MediaTrack | null;
};

export type ScenarioStep =
  | { kind: "advance"; ms: number }
  | { kind: "player"; state: Partial<ScenarioPlayerState> }
  | { kind: "mount" }
  | { kind: "unmount" }
  | { kind: "purge-startup" }
  | { kind: "set-enabled"; enabled: boolean }
  | { kind: "upload-cover"; trackId: string; cover: UploadDiscordCover }
  | { kind: "upload-cover-resolved" }
  | { kind: "assert-invariants" }
  | { kind: "assert-activity"; title?: string | null; paused?: boolean }
  | { kind: "assert-syncs-max"; max: number }
  | { kind: "assert-applied-min"; min: number };

export type ScenarioDefinition = {
  name: string;
  ipc?: IpcSimulatorOptions;
  enabled?: boolean;
  initial?: Partial<ScenarioPlayerState>;
  steps: ScenarioStep[];
};

function mergePlayerState(
  current: ScenarioPlayerState,
  patch: Partial<ScenarioPlayerState>,
): ScenarioPlayerState {
  const track = patch.track !== undefined ? patch.track : current.track;
  return {
    track,
    isPlaying: patch.isPlaying ?? current.isPlaying,
    isBuffering: patch.isBuffering ?? current.isBuffering,
    progress: patch.progress ?? current.progress,
    duration: patch.duration ?? current.duration,
    seekRevision: patch.seekRevision ?? current.seekRevision,
  };
}

export function defaultPlayerState(overrides: Partial<ScenarioPlayerState> = {}): ScenarioPlayerState {
  return mergePlayerState(
    {
      track: null,
      isPlaying: false,
      isBuffering: false,
      progress: 0,
      duration: 0,
      seekRevision: 0,
    },
    overrides,
  );
}

export class ScenarioRunner {
  private sim: DiscordPresenceSimulator;
  private player = defaultPlayerState();
  private enabled: boolean;
  private pendingRetry = false;

  constructor(definition: Pick<ScenarioDefinition, "ipc" | "enabled" | "initial"> = {}) {
    this.sim = new DiscordPresenceSimulator(definition.ipc ?? {});
    this.enabled = definition.enabled ?? true;
    this.sim.setEnabled(this.enabled);
    if (definition.initial) {
      this.player = mergePlayerState(this.player, definition.initial);
    }
  }

  getSimulator(): DiscordPresenceSimulator {
    return this.sim;
  }

  getPlayer(): ScenarioPlayerState {
    return this.player;
  }

  getSyncLog(): readonly SyncLogEntry[] {
    return this.sim.getSyncLog();
  }

  getEngineState(): PresenceEngineState {
    return this.sim.getEngineState();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  runSteps(steps: ScenarioStep[]): void {
    for (const step of steps) {
      this.runStep(step);
    }
  }

  runStep(step: ScenarioStep): void {
    switch (step.kind) {
      case "advance":
        this.pendingRetry = false;
        this.sim.run({ type: "advance", ms: step.ms });
        break;
      case "player": {
        this.player = mergePlayerState(this.player, step.state);
        this.sim.run({ type: "player", snapshot: this.player });
        break;
      }
      case "mount":
        this.sim.run({ type: "mount" });
        break;
      case "unmount":
        this.sim.run({ type: "unmount" });
        break;
      case "purge-startup":
        this.sim.purgeStaleOnStartup();
        break;
      case "set-enabled":
        this.enabled = step.enabled;
        this.sim.setEnabled(step.enabled);
        this.sim.run({ type: "player", snapshot: this.player });
        break;
      case "upload-cover":
        this.sim.setUploadCoverCache(step.trackId, step.cover);
        break;
      case "upload-cover-resolved":
        this.sim.run({ type: "upload-cover-resolved" });
        break;
      case "assert-invariants":
        this.assertNow();
        break;
      case "assert-activity": {
        if (step.title === null) {
          if (this.sim.isActivityShowing()) {
            throw new Error(`Expected no Discord activity, got "${this.sim.getActivity().payload?.title}"`);
          }
          break;
        }
        if (step.title && !this.sim.isActivityShowing(step.title)) {
          throw new Error(`Expected activity "${step.title}", got "${this.sim.getActivity().payload?.title ?? "none"}"`);
        }
        if (step.paused !== undefined && this.sim.getActivity().payload?.paused !== step.paused) {
          throw new Error(`Expected paused=${step.paused}, got ${this.sim.getActivity().payload?.paused}`);
        }
        break;
      }
      case "assert-syncs-max":
        if (this.sim.getSyncLog().length > step.max) {
          throw new Error(`Expected <= ${step.max} sync attempts, got ${this.sim.getSyncLog().length}`);
        }
        break;
      case "assert-applied-min": {
        const applied = this.sim.getSyncLog().filter((entry) => entry.applied).length;
        if (applied < step.min) {
          throw new Error(`Expected >= ${step.min} applied syncs, got ${applied}`);
        }
        break;
      }
      default:
        break;
    }
  }

  assertNow(): void {
    assertInvariants(this.context());
  }

  checkNow() {
    return checkPresenceInvariants(this.context());
  }

  private context() {
    return {
      snapshot: this.player,
      engineState: this.sim.getEngineState(),
      activity: this.sim.getActivity(),
      syncLog: this.sim.getSyncLog(),
      enabled: this.enabled,
      pendingRetry: this.pendingRetry,
    };
  }
}

export function play(
  progress = 0,
  overrides: Partial<ScenarioPlayerState> = {},
): Partial<ScenarioPlayerState> {
  return {
    isPlaying: true,
    isBuffering: false,
    progress,
    duration: overrides.duration ?? 240,
    ...overrides,
  };
}

export function pause(
  progress = 0,
  overrides: Partial<ScenarioPlayerState> = {},
): Partial<ScenarioPlayerState> {
  return {
    isPlaying: false,
    isBuffering: false,
    progress,
    duration: overrides.duration ?? 240,
    ...overrides,
  };
}

export function skipTo(
  track: MediaTrack,
  overrides: Partial<ScenarioPlayerState> = {},
): Partial<ScenarioPlayerState> {
  return {
    track,
    progress: 0,
    seekRevision: (overrides.seekRevision ?? 0),
    ...overrides,
  };
}

export function track(title: string, id?: string): MediaTrack {
  return makeTrack({
    id: id ?? `track-${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
  });
}

export function runScenario(definition: ScenarioDefinition): ScenarioRunner {
  const runner = new ScenarioRunner(definition);
  runner.runSteps(definition.steps);
  return runner;
}

export function scenarioEventFromStep(step: ScenarioStep): SimulatorEvent | null {
  if (step.kind === "advance") return { type: "advance", ms: step.ms };
  if (step.kind === "player") return { type: "player", snapshot: step.state as PresencePlayerSnapshot };
  if (step.kind === "mount") return { type: "mount" };
  if (step.kind === "unmount") return { type: "unmount" };
  return null;
}