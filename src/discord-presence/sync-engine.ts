import type { DiscordPresencePayload } from "../api";
import type { MediaTrack } from "../types";
import type { UploadDiscordCover } from "../utils/upload-enrichment";
import {
  buildPresencePayload,
  isPlaybackFrozen,
  payloadKey,
  CONFIRM_BURST_DELAYS_MS,
  SEEK_JUMP_SECONDS,
  SEEK_SYNC_INTERVAL_MS,
  STARTUP_RETRY_DELAYS_MS,
  trackArtKey,
} from "./payload";

export type PresencePlayerSnapshot = {
  track: MediaTrack | null;
  isPlaying: boolean;
  isBuffering: boolean;
  progress: number;
  duration: number;
  seekRevision: number;
};

export type PresenceSyncInput = PresencePlayerSnapshot & {
  enabled: boolean;
  uploadCoverCache: ReadonlyMap<string, UploadDiscordCover>;
  nowMs: number;
};

export type PresenceEngineEffect =
  | { type: "sync"; payload: DiscordPresencePayload; generation: number }
  | { type: "schedule-retry"; delayMs: number }
  | { type: "start-confirm-burst" }
  | { type: "cancel-retry" };

export type PresenceEngineState = {
  lastTrackId: string | null;
  lastTrackArtKey: string | null;
  lastPayloadKey: string | null;
  lastSeekSyncAt: number;
  lastSyncedProgress: number;
  lastSyncedDuration: number;
  lastPlaying: boolean | null;
  lastBuffering: boolean | null;
  lastSeekRevision: number;
  startupRetryAttempt: number;
  ipcConfirmed: boolean;
  syncGeneration: number;
  everHadTrack: boolean;
  mounted: boolean;
};

export function createPresenceEngineState(): PresenceEngineState {
  return {
    lastTrackId: null,
    lastTrackArtKey: null,
    lastPayloadKey: null,
    lastSeekSyncAt: 0,
    lastSyncedProgress: 0,
    lastSyncedDuration: 0,
    lastPlaying: null,
    lastBuffering: null,
    lastSeekRevision: 0,
    startupRetryAttempt: 0,
    ipcConfirmed: false,
    syncGeneration: 0,
    everHadTrack: false,
    mounted: false,
  };
}

function pushSnapshot(
  state: PresenceEngineState,
  input: PresenceSyncInput,
  force = false,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  const { enabled, track, isPlaying, isBuffering, progress, duration, uploadCoverCache, nowMs } =
    input;
  if (!enabled || !track) {
    return { state, effects: [] };
  }

  const frozen = isPlaybackFrozen(isPlaying, isBuffering);
  const payload = buildPresencePayload(
    enabled,
    track,
    progress,
    duration,
    frozen,
    uploadCoverCache,
    nowMs,
  );
  const key = payloadKey(payload);
  if (!force && key === state.lastPayloadKey) {
    return { state, effects: [] };
  }

  const generation = state.syncGeneration + 1;
  const next: PresenceEngineState = {
    ...state,
    syncGeneration: generation,
    everHadTrack: true,
    lastPayloadKey: key,
    lastSeekSyncAt: nowMs,
    lastSyncedProgress: progress,
    lastSyncedDuration: duration,
    lastPlaying: isPlaying,
    lastBuffering: isBuffering,
    ipcConfirmed: false,
  };

  return {
    state: next,
    effects: [{ type: "sync", payload, generation }],
  };
}

function scheduleRetryIfNeeded(
  state: PresenceEngineState,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (state.ipcConfirmed) {
    return { state, effects: [{ type: "cancel-retry" }] };
  }
  if (state.startupRetryAttempt >= STARTUP_RETRY_DELAYS_MS.length) {
    return { state, effects: [{ type: "cancel-retry" }] };
  }

  const delayMs = STARTUP_RETRY_DELAYS_MS[state.startupRetryAttempt]!;
  return {
    state: {
      ...state,
      startupRetryAttempt: state.startupRetryAttempt + 1,
    },
    effects: [{ type: "schedule-retry", delayMs }],
  };
}

function resetRetryState(state: PresenceEngineState): PresenceEngineState {
  return {
    ...state,
    startupRetryAttempt: 0,
    ipcConfirmed: false,
  };
}

function emitControlSync(
  state: PresenceEngineState,
  payload: DiscordPresencePayload,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  const generation = state.syncGeneration + 1;
  return {
    state: {
      ...state,
      syncGeneration: generation,
      lastPayloadKey: payloadKey(payload),
      ipcConfirmed: false,
    },
    effects: [{ type: "sync", payload, generation }],
  };
}

function withConfirmBurst(
  result: { state: PresenceEngineState; effects: PresenceEngineEffect[] },
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (!result.effects.some((effect) => effect.type === "sync")) {
    return result;
  }
  return {
    state: result.state,
    effects: [...result.effects, { type: "start-confirm-burst" }],
  };
}

function idleTrackClearEffects(
  state: PresenceEngineState,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  const cleared = {
    ...resetRetryState(state),
    lastTrackId: null,
    lastTrackArtKey: null,
    lastPayloadKey: null,
    everHadTrack: false,
  };
  const control = emitControlSync(cleared, { enabled: true });
  return {
    state: control.state,
    effects: [{ type: "cancel-retry" }, ...control.effects],
  };
}

export function reducePresenceMount(
  state: PresenceEngineState,
  input: PresenceSyncInput,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (!input.enabled) {
    const fresh = { ...createPresenceEngineState(), mounted: true };
    const control = emitControlSync(fresh, { enabled: false });
    return {
      state: control.state,
      effects: [{ type: "cancel-retry" }, ...control.effects],
    };
  }

  if (!input.track) {
    return {
      state: { ...resetRetryState(state), mounted: true },
      effects: [{ type: "cancel-retry" }],
    };
  }

  const next = { ...resetRetryState(state), mounted: true, lastPayloadKey: null };
  return withConfirmBurst(reducePresencePlayerUpdate(next, input, { bootstrap: true }));
}

export function reducePresenceUnmount(
  state: PresenceEngineState,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  return {
    state: { ...createPresenceEngineState(), mounted: false },
    effects: [{ type: "cancel-retry" }],
  };
}

export function reducePresenceSettingDisabled(
  state: PresenceEngineState,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  const fresh = {
    ...createPresenceEngineState(),
    mounted: state.mounted,
  };
  const control = emitControlSync(fresh, { enabled: false });
  return {
    state: control.state,
    effects: [{ type: "cancel-retry" }, ...control.effects],
  };
}

export function reducePresenceIpcResult(
  state: PresenceEngineState,
  input: PresenceSyncInput,
  success: boolean,
  generation: number,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (generation !== state.syncGeneration) {
    return { state, effects: [] };
  }

  if (success) {
    return {
      state: {
        ...state,
        ipcConfirmed: true,
        startupRetryAttempt: 0,
      },
      effects: [{ type: "cancel-retry" }],
    };
  }

  if (!input.enabled || !input.track) {
    return { state, effects: [{ type: "cancel-retry" }] };
  }

  return scheduleRetryIfNeeded(state);
}

export function reducePresenceRetryTimer(
  state: PresenceEngineState,
  input: PresenceSyncInput,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (!input.enabled || !input.track) {
    return { state, effects: [{ type: "cancel-retry" }] };
  }

  return pushSnapshot({ ...state, lastPayloadKey: null }, input, true);
}

export function reducePresenceUploadCoverResolved(
  state: PresenceEngineState,
  input: PresenceSyncInput,
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  if (!input.enabled || !input.track) {
    return { state, effects: [] };
  }

  return withConfirmBurst(pushSnapshot({ ...state, lastPayloadKey: null }, input));
}

export function confirmBurstDelays(): readonly number[] {
  return CONFIRM_BURST_DELAYS_MS;
}

type PlayerUpdateOptions = {
  bootstrap?: boolean;
};

export function reducePresencePlayerUpdate(
  state: PresenceEngineState,
  input: PresenceSyncInput,
  options: PlayerUpdateOptions = {},
): { state: PresenceEngineState; effects: PresenceEngineEffect[] } {
  const { enabled, track, isPlaying, isBuffering, progress, duration, seekRevision, nowMs } =
    input;

  if (!enabled) {
    return reducePresenceSettingDisabled(state);
  }

  const trackId = track?.id ?? null;
  if (!track) {
    if (!state.everHadTrack) {
      return {
        state: {
          ...state,
          lastTrackId: null,
          lastTrackArtKey: null,
        },
        effects: [],
      };
    }
    return idleTrackClearEffects(state);
  }

  const artKey = trackArtKey(track);
  const trackChanged = trackId !== state.lastTrackId || options.bootstrap;
  const artChanged = artKey !== state.lastTrackArtKey;

  if (trackChanged) {
    const next = {
      ...resetRetryState(state),
      lastPayloadKey: null,
      lastTrackId: trackId,
      lastTrackArtKey: artKey,
      lastSeekRevision: seekRevision,
    };
    const pushed = pushSnapshot(next, input);
    return withConfirmBurst({
      state: pushed.state,
      effects: [{ type: "cancel-retry" }, ...pushed.effects],
    });
  }

  const playingChanged = isPlaying !== state.lastPlaying;
  const seekChanged = seekRevision !== state.lastSeekRevision;
  const bufferingChanged = isBuffering !== state.lastBuffering;
  const bufferingStarted = bufferingChanged && isBuffering;
  const bufferingEnded = bufferingChanged && !isBuffering;
  const durationBecameAvailable =
    duration > 0 && state.lastSyncedDuration <= 0;
  const frozen = isPlaybackFrozen(isPlaying, isBuffering);
  const pausedIdle = !isPlaying;
  const progressJump =
    Math.abs(progress - state.lastSyncedProgress) >= SEEK_JUMP_SECONDS;
  const shouldSyncSeek =
    seekChanged
    || (
      isPlaying
      && !isBuffering
      && (nowMs - state.lastSeekSyncAt >= SEEK_SYNC_INTERVAL_MS || progressJump)
    );

  if (pausedIdle) {
    if (
      !playingChanged
      && !seekChanged
      && !artChanged
      && !progressJump
      && !bufferingStarted
      && !bufferingEnded
    ) {
      return { state, effects: [] };
    }
  } else if (
    !playingChanged
    && !bufferingStarted
    && !bufferingEnded
    && !durationBecameAvailable
    && !shouldSyncSeek
  ) {
    return { state, effects: [] };
  }

  let next = state;
  if (seekChanged) {
    next = { ...next, lastSeekRevision: seekRevision, lastPayloadKey: null };
  }
  if (playingChanged) {
    next = { ...next, lastPayloadKey: null };
  }
  if (artChanged) {
    next = { ...next, lastTrackArtKey: artKey, lastPayloadKey: null };
  }
  if (bufferingStarted || bufferingEnded || durationBecameAvailable) {
    next = { ...next, lastPayloadKey: null };
  }

  const forcePush =
    bufferingEnded
    || durationBecameAvailable
    || (playingChanged && !frozen);

  const pushed = pushSnapshot(next, input, forcePush);
  const needsConfirmBurst =
    pushed.effects.length > 0
    && (playingChanged || bufferingEnded || durationBecameAvailable);

  if (!needsConfirmBurst) {
    return pushed;
  }
  return withConfirmBurst(pushed);
}