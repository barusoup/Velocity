import type { DiscordPresencePayload } from "../api";
import type { PresenceEngineState, PresencePlayerSnapshot } from "./sync-engine";
import type { SyncLogEntry } from "./simulator";
import { isPlaybackFrozen } from "./payload";

export type InvariantViolation = {
  code: string;
  message: string;
};

export type InvariantContext = {
  snapshot: PresencePlayerSnapshot;
  engineState: PresenceEngineState;
  activity: {
    cleared: boolean;
    payload: DiscordPresencePayload | null;
  };
  syncLog: readonly SyncLogEntry[];
  enabled: boolean;
  pendingRetry: boolean;
};

export function checkPresenceInvariants(ctx: InvariantContext): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const { snapshot, activity, enabled, engineState } = ctx;
  const payload = activity.payload;
  const frozen = snapshot.track
    ? isPlaybackFrozen(snapshot.isPlaying, snapshot.isBuffering)
    : true;

  if (!enabled) {
    if (!activity.cleared && payload?.title) {
      violations.push({
        code: "disabled-should-clear",
        message: "Presence is disabled but Discord still shows a track title",
      });
    }
    return violations;
  }

  if (!snapshot.track) {
    if (payload?.title) {
      violations.push({
        code: "idle-should-not-show-track",
        message: "No current track but Discord activity still has a title",
      });
    }
    return violations;
  }

  const lastApplied = [...ctx.syncLog].reverse().find((entry) => entry.applied);
  if (
    engineState.ipcConfirmed
    && payload?.title
    && payload.title !== snapshot.track.title
  ) {
    violations.push({
      code: "confirmed-title-mismatch",
      message: `IPC confirmed for "${payload.title}" but player is on "${snapshot.track.title}"`,
    });
  }

  if (
    lastApplied?.payload.title
    && lastApplied.payload.title !== snapshot.track.title
    && engineState.ipcConfirmed
  ) {
    violations.push({
      code: "latest-applied-stale",
      message: `Last applied sync was "${lastApplied.payload.title}" but player is on "${snapshot.track.title}"`,
    });
  }

  if (payload?.title && !activity.cleared) {
    if (frozen && (payload.startedAt != null || payload.endsAt != null)) {
      violations.push({
        code: "frozen-has-timestamps",
        message: "Paused/buffering state must not expose Discord progress timestamps",
      });
    }

    if (!frozen && snapshot.duration > 0 && payload.paused) {
      violations.push({
        code: "playing-marked-paused",
        message: "Active playback is incorrectly marked paused in Discord payload",
      });
    }

    if (!frozen && snapshot.duration > 0) {
      if (payload.startedAt == null || payload.endsAt == null) {
        violations.push({
          code: "playing-missing-timestamps",
          message: "Playing track with known duration must include timestamps",
        });
      } else {
        const span = payload.endsAt - payload.startedAt;
        const expectedMs = Math.max(1, Math.floor((snapshot.duration || snapshot.track.durationSeconds || 0) * 1000));
        if (Math.abs(span - expectedMs) > 1) {
          violations.push({
            code: "timestamp-span-wrong",
            message: `Timestamp span ${span}ms != duration ${expectedMs}ms`,
          });
        }
      }
    }
  }

  if (engineState.ipcConfirmed && snapshot.track && !payload?.title) {
    violations.push({
      code: "confirmed-without-activity",
      message: "Engine thinks IPC is confirmed but no Discord activity is visible",
    });
  }

  return violations;
}

export function assertInvariants(ctx: InvariantContext): void {
  const violations = checkPresenceInvariants(ctx);
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.code}: ${v.message}`).join("\n");
    throw new Error(`Presence invariant violation(s):\n${detail}`);
  }
}

export function countAppliedSyncs(log: readonly SyncLogEntry[]): number {
  return log.filter((entry) => entry.applied).length;
}

export function maxSyncsForPlayingTicks(ticks: number, seeks = 0, stateChanges = 0): number {
  const periodic = Math.ceil(ticks / 4);
  return periodic + seeks + stateChanges + 2;
}