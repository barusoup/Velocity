import type { DiscordPresencePayload } from "../api";

export type SimulatedActivity = {
  cleared: boolean;
  payload: DiscordPresencePayload | null;
  appliedAt: number | null;
};

export type IpcSimulatorOptions = {
  /** Simulator clock time when Discord IPC becomes connectable. */
  readyAtMs?: number;
  /** Number of connect attempts that fail even after readyAtMs. */
  failConnectCount?: number;
  /** When true, purge_stale runs before applying the next update. */
  purgeBeforeNextUpdate?: boolean;
  /** Per-update latency before the result is observable (ms). */
  latencyMs?: number;
  /** Disconnect after every N successful updates (simulates flaky IPC). */
  disconnectEverySuccess?: number;
};

/**
 * Minimal model of the Rust discord_presence worker + Discord IPC handshake.
 */
export class DiscordIpcSimulator {
  private readyAtMs: number;
  private failConnectCount: number;
  private purgeBeforeNextUpdate: boolean;
  private latencyMs: number;
  private disconnectEverySuccess: number;
  private connectAttempts = 0;
  private connected = false;
  private successCount = 0;
  private timestampsActive = false;
  private lastGeneration = 0;
  private activity: SimulatedActivity = { cleared: true, payload: null, appliedAt: null };
  private nowMs = 0;

  constructor(options: IpcSimulatorOptions = {}) {
    this.readyAtMs = options.readyAtMs ?? 0;
    this.failConnectCount = options.failConnectCount ?? 0;
    this.purgeBeforeNextUpdate = options.purgeBeforeNextUpdate ?? false;
    this.latencyMs = options.latencyMs ?? 0;
    this.disconnectEverySuccess = options.disconnectEverySuccess ?? 0;
  }

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  getActivity(): SimulatedActivity {
    return this.activity;
  }

  getConnectAttempts(): number {
    return this.connectAttempts;
  }

  hasActiveTimestamps(): boolean {
    return this.timestampsActive;
  }

  /** Test hook: Discord still shows a bar but our worker lost track of it. */
  seedStaleDiscordTimestamps(startedAt: number, endsAt: number): void {
    this.timestampsActive = false;
    this.activity = {
      cleared: false,
      payload: {
        enabled: true,
        title: this.activity.payload?.title ?? "Stale",
        paused: false,
        startedAt,
        endsAt,
      },
      appliedAt: this.nowMs,
    };
  }

  purgeStale(): void {
    this.connected = false;
    this.timestampsActive = false;
    this.activity = { cleared: true, payload: null, appliedAt: null };
  }

  clear(): void {
    this.connected = false;
    this.timestampsActive = false;
    this.activity = { cleared: true, payload: null, appliedAt: null };
  }

  /**
   * Mirrors `sync_discord_presence` → worker `apply_update`.
   * Returns whether the activity was applied to a live Discord connection.
   */
  applyUpdate(payload: DiscordPresencePayload): boolean {
    if (this.nowMs < this.latencyMs) {
      return false;
    }

    if (!payload.enabled) {
      this.clear();
      this.lastGeneration = 0;
      return true;
    }

    if (payload.generation != null) {
      if (payload.generation < this.lastGeneration) {
        return true;
      }
      this.lastGeneration = payload.generation;
    }

    if (!payload.title) {
      if (this.connected) {
        this.activity = { cleared: true, payload: null, appliedAt: this.nowMs };
      }
      return true;
    }

    if (this.purgeBeforeNextUpdate) {
      this.purgeStale();
      this.purgeBeforeNextUpdate = false;
    }

    if (!this.tryConnect()) {
      return false;
    }

    const paused = payload.paused === true;
    const wantTimestamps =
      !paused
      && payload.startedAt != null
      && payload.endsAt != null
      && payload.endsAt > payload.startedAt;

    // Mirror Rust: paused always wipes timestamp state before republishing.
    if (paused) {
      this.timestampsActive = false;
    } else if (!wantTimestamps && this.timestampsActive) {
      this.timestampsActive = false;
    }

    const merged: DiscordPresencePayload = { ...payload };
    merged.startedAt = null;
    merged.endsAt = null;
    if (wantTimestamps) {
      merged.startedAt = payload.startedAt ?? null;
      merged.endsAt = payload.endsAt ?? null;
    }

    this.activity = {
      cleared: false,
      payload: merged,
      appliedAt: this.nowMs,
    };
    this.timestampsActive = wantTimestamps;
    this.successCount += 1;
    if (
      this.disconnectEverySuccess > 0
      && this.successCount % this.disconnectEverySuccess === 0
    ) {
      this.connected = false;
    }
    return true;
  }

  private tryConnect(): boolean {
    if (this.nowMs < this.readyAtMs) {
      this.connectAttempts += 1;
      return false;
    }
    if (this.failConnectCount > 0) {
      this.failConnectCount -= 1;
      this.connectAttempts += 1;
      return false;
    }
    if (!this.connected) {
      this.connectAttempts += 1;
    }
    this.connected = true;
    return true;
  }
}