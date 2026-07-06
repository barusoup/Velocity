import type { DiscordPresencePayload } from "../api";
import type { MediaTrack } from "../types";
import type { UploadDiscordCover } from "../utils/upload-enrichment";
import { DiscordIpcSimulator, type IpcSimulatorOptions } from "./ipc-simulator";
import {
  createPresenceEngineState,
  reducePresenceIpcResult,
  reducePresenceMount,
  reducePresencePlayerUpdate,
  reducePresenceRetryTimer,
  reducePresenceSettingDisabled,
  reducePresenceUnmount,
  reducePresenceUploadCoverResolved,
  type PresenceEngineEffect,
  type PresenceEngineState,
  type PresencePlayerSnapshot,
  type PresenceSyncInput,
} from "./sync-engine";

export type SyncLogEntry = {
  atMs: number;
  payload: DiscordPresencePayload;
  applied: boolean;
  generation: number;
};

export type SimulatorEvent =
  | { type: "mount" }
  | { type: "unmount" }
  | { type: "player"; snapshot: PresencePlayerSnapshot }
  | { type: "upload-cover-resolved" }
  | { type: "advance"; ms: number };

export class DiscordPresenceSimulator {
  private nowMs = 0;
  private enabled = true;
  private uploadCoverCache = new Map<string, UploadDiscordCover>();
  private engineState: PresenceEngineState = createPresenceEngineState();
  private ipc: DiscordIpcSimulator;
  private retryAtMs: number | null = null;
  private confirmBurstTimers: Array<{ atMs: number; targetGeneration: number }> = [];
  private confirmBurstSerial = 0;
  private syncLog: SyncLogEntry[] = [];
  private mounted = false;

  constructor(ipcOptions: IpcSimulatorOptions = {}) {
    this.ipc = new DiscordIpcSimulator(ipcOptions);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setUploadCoverCache(trackId: string, cover: UploadDiscordCover): void {
    this.uploadCoverCache.set(trackId, cover);
  }

  getNowMs(): number {
    return this.nowMs;
  }

  getSyncLog(): readonly SyncLogEntry[] {
    return this.syncLog;
  }

  getActivity(): ReturnType<DiscordIpcSimulator["getActivity"]> {
    return this.ipc.getActivity();
  }

  getEngineState(): PresenceEngineState {
    return this.engineState;
  }

  getIpc(): DiscordIpcSimulator {
    return this.ipc;
  }

  hasPendingRetry(): boolean {
    return this.retryAtMs !== null;
  }

  isActivityShowing(title?: string): boolean {
    const activity = this.ipc.getActivity();
    if (activity.cleared || !activity.payload?.title) return false;
    if (title) return activity.payload.title === title;
    return true;
  }

  run(event: SimulatorEvent): void {
    if (event.type === "advance") {
      this.nowMs += event.ms;
      this.ipc.setNow(this.nowMs);
      this.drainRetryTimers();
      return;
    }

    if (event.type === "mount") {
      this.mounted = true;
      this.dispatch(reducePresenceMount(this.engineState, this.inputFromSnapshot(this.lastSnapshot)));
      return;
    }

    if (event.type === "unmount") {
      this.mounted = false;
      this.dispatch(reducePresenceUnmount(this.engineState));
      return;
    }

    if (event.type === "upload-cover-resolved") {
      this.dispatch(
        reducePresenceUploadCoverResolved(this.engineState, this.inputFromSnapshot(this.lastSnapshot)),
      );
      return;
    }

    if (event.type === "player") {
      this.lastSnapshot = event.snapshot;
      if (!this.enabled) {
        this.dispatch(reducePresenceSettingDisabled(this.engineState));
        return;
      }
      if (!this.mounted) {
        this.mounted = true;
        this.dispatch(reducePresenceMount(this.engineState, this.inputFromSnapshot(event.snapshot)));
        return;
      }
      this.dispatch(reducePresencePlayerUpdate(this.engineState, this.inputFromSnapshot(event.snapshot)));
    }
  }

  purgeStaleOnStartup(): void {
    this.ipc.purgeStale();
  }

  private lastSnapshot: PresencePlayerSnapshot = {
    track: null,
    isPlaying: false,
    isBuffering: false,
    progress: 0,
    duration: 0,
    seekRevision: 0,
  };

  private inputFromSnapshot(snapshot: PresencePlayerSnapshot): PresenceSyncInput {
    return {
      ...snapshot,
      enabled: this.enabled,
      uploadCoverCache: this.uploadCoverCache,
      nowMs: this.nowMs,
    };
  }

  private dispatch(result: { state: PresenceEngineState; effects: PresenceEngineEffect[] }): void {
    this.engineState = result.state;
    this.applyEffects(result.effects, () => this.inputFromSnapshot(this.lastSnapshot));
  }

  private applyEffects(
    effects: PresenceEngineEffect[],
    getInput: () => PresenceSyncInput,
  ): void {
    for (const effect of effects) {
      if (effect.type === "cancel-retry") {
        this.retryAtMs = null;
        continue;
      }

      if (effect.type === "start-confirm-burst") {
        this.scheduleConfirmBurst();
        continue;
      }

      if (effect.type === "schedule-retry") {
        this.retryAtMs = this.nowMs + effect.delayMs;
        continue;
      }

      if (effect.type === "sync") {
        const applied = this.ipc.applyUpdate({
          ...effect.payload,
          generation: effect.generation,
        });
        this.syncLog.push({
          atMs: this.nowMs,
          payload: { ...effect.payload, generation: effect.generation },
          applied,
          generation: effect.generation,
        });
        const input = getInput();
        const ipcResult = reducePresenceIpcResult(
          this.engineState,
          input,
          applied,
          effect.generation,
        );
        this.engineState = ipcResult.state;
        this.applyEffects(ipcResult.effects, getInput);
      }
    }
  }

  private scheduleConfirmBurst(): void {
    this.confirmBurstTimers = [];
    this.confirmBurstSerial += 1;
    const serial = this.confirmBurstSerial;
    const targetGeneration = this.engineState.syncGeneration;
    for (const delayMs of [350, 900, 2_000, 4_500]) {
      this.confirmBurstTimers.push({
        atMs: this.nowMs + delayMs,
        targetGeneration,
      });
    }
  }

  private drainRetryTimers(): void {
    let guard = 0;
    while (guard < 64) {
      guard += 1;
      let fired = false;

      if (this.retryAtMs !== null && this.nowMs >= this.retryAtMs) {
        fired = true;
        this.retryAtMs = null;
        const input = this.inputFromSnapshot(this.lastSnapshot);
        const result = reducePresenceRetryTimer(this.engineState, input);
        this.engineState = result.state;
        this.applyEffects(result.effects, () => this.inputFromSnapshot(this.lastSnapshot));
      }

      const confirmIdx = this.confirmBurstTimers.findIndex(
        (entry) =>
          this.nowMs >= entry.atMs
          && !this.engineState.ipcConfirmed
          && this.engineState.syncGeneration === entry.targetGeneration,
      );
      if (confirmIdx >= 0) {
        fired = true;
        this.confirmBurstTimers.splice(confirmIdx, 1);
        const input = this.inputFromSnapshot(this.lastSnapshot);
        const result = reducePresenceRetryTimer(this.engineState, input);
        this.engineState = result.state;
        this.applyEffects(result.effects, () => this.inputFromSnapshot(this.lastSnapshot));
      }

      if (!fired) break;
    }
  }
}

export function makeTrack(overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: "track-1",
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    source: "stream",
    videoId: "vid123",
    durationSeconds: 240,
    cover: "https://lh3.googleusercontent.com/example=w544-h544-l90-rj",
    ...overrides,
  };
}