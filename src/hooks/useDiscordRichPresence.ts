import { useEffect, useRef } from "react";
import { listen, TauriEvent } from "@tauri-apps/api/event";

import { syncDiscordPresence, type DiscordPresencePayload } from "../api";
import {
  confirmBurstDelays,
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
  type PresenceSyncInput,
} from "../discord-presence/sync-engine";
import {
  collapseQueuedSync,
  isStaleIpcGeneration,
  isSupersededQueuedSync,
  type QueuedPresenceSync,
} from "../discord-presence/sync-queue";
import { usePlayer } from "../player";
import { useSetting } from "../settings";
import {
  needsYtmCoverFallback,
  resolveUploadDiscordCover,
  type UploadDiscordCover,
} from "../utils/upload-enrichment";

function applyPresenceEffects(
  effects: PresenceEngineEffect[],
  getInput: () => PresenceSyncInput,
  engineStateRef: { current: PresenceEngineState },
  queueSync: (payload: DiscordPresencePayload, generation: number) => void,
  scheduleRetry: (delayMs: number) => void,
  cancelRetry: () => void,
  startConfirmBurst: () => void,
): void {
  for (const effect of effects) {
    if (effect.type === "cancel-retry") {
      cancelRetry();
      continue;
    }

    if (effect.type === "start-confirm-burst") {
      startConfirmBurst();
      continue;
    }

    if (effect.type === "schedule-retry") {
      scheduleRetry(effect.delayMs);
      continue;
    }

    if (effect.type === "sync") {
      queueSync(effect.payload, effect.generation);
    }
  }
}

/**
 * Pushes the current playback state to Discord Rich Presence when enabled.
 */
export function useDiscordRichPresence(): void {
  const enabled = useSetting("discordRichPresence");
  const player = usePlayer();
  const engineStateRef = useRef(createPresenceEngineState());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmBurstTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const confirmBurstGenRef = useRef(0);
  const uploadCoverCacheRef = useRef<Map<string, UploadDiscordCover>>(new Map());
  const uploadCoverRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const pendingSyncRef = useRef<QueuedPresenceSync | null>(null);
  const syncDrainRef = useRef<Promise<void>>(Promise.resolve());

  const cancelRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const cancelConfirmBurst = () => {
    confirmBurstGenRef.current += 1;
    for (const timer of confirmBurstTimersRef.current) {
      clearTimeout(timer);
    }
    confirmBurstTimersRef.current = [];
  };

  const buildInput = (): PresenceSyncInput => ({
    enabled,
    track: player.currentTrack,
    isPlaying: player.isPlaying,
    isBuffering: player.isBuffering,
    progress: player.progress,
    duration: player.duration,
    seekRevision: player.seekRevision,
    uploadCoverCache: uploadCoverCacheRef.current,
    nowMs: Date.now(),
  });

  const flushQueuedSyncs = () => {
    syncDrainRef.current = syncDrainRef.current
      .then(async () => {
        while (pendingSyncRef.current) {
          let current = pendingSyncRef.current;
          pendingSyncRef.current = null;
          while (pendingSyncRef.current) {
            current = pendingSyncRef.current;
            pendingSyncRef.current = null;
          }

          if (
            isSupersededQueuedSync(
              current.generation,
              engineStateRef.current.syncGeneration,
            )
          ) {
            continue;
          }

          const sentGeneration = current.generation;
          const success = await syncDiscordPresence({
            ...current.payload,
            generation: sentGeneration,
          });

          if (
            isStaleIpcGeneration(
              sentGeneration,
              engineStateRef.current.syncGeneration,
            )
          ) {
            continue;
          }

          const input = buildInput();
          const result = reducePresenceIpcResult(
            engineStateRef.current,
            input,
            success,
            sentGeneration,
          );
          engineStateRef.current = result.state;
          applyPresenceEffects(
            result.effects,
            buildInput,
            engineStateRef,
            queuePresenceSync,
            scheduleRetry,
            cancelRetry,
            startConfirmBurst,
          );
        }
      })
      .catch(() => {
        // IPC errors are surfaced via success=false; keep draining.
      });
  };

  const queuePresenceSync = (payload: DiscordPresencePayload, generation: number) => {
    pendingSyncRef.current = collapseQueuedSync(pendingSyncRef.current, {
      payload,
      generation,
    });
    flushQueuedSyncs();
  };

  const scheduleRetry = (delayMs: number) => {
    cancelRetry();
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      const input = buildInput();
      const result = reducePresenceRetryTimer(engineStateRef.current, input);
      engineStateRef.current = result.state;
      applyPresenceEffects(
        result.effects,
        buildInput,
        engineStateRef,
        queuePresenceSync,
        scheduleRetry,
        cancelRetry,
        startConfirmBurst,
      );
    }, delayMs);
  };

  const startConfirmBurst = () => {
    cancelConfirmBurst();
    const burstId = confirmBurstGenRef.current;
    const targetGeneration = engineStateRef.current.syncGeneration;

    for (const delayMs of confirmBurstDelays()) {
      const timer = setTimeout(() => {
        if (burstId !== confirmBurstGenRef.current) return;
        if (engineStateRef.current.ipcConfirmed) return;
        if (engineStateRef.current.syncGeneration !== targetGeneration) return;

        const input = buildInput();
        if (!input.enabled || !input.track) return;

        const result = reducePresenceRetryTimer(engineStateRef.current, input);
        engineStateRef.current = result.state;
        applyPresenceEffects(
          result.effects,
          buildInput,
          engineStateRef,
          queuePresenceSync,
          scheduleRetry,
          cancelRetry,
          startConfirmBurst,
        );
      }, delayMs);
      confirmBurstTimersRef.current.push(timer);
    }
  };

  const dispatch = (
    reducer: (
      state: PresenceEngineState,
      input: PresenceSyncInput,
    ) => { state: PresenceEngineState; effects: PresenceEngineEffect[] },
  ) => {
    const input = buildInput();
    const result = reducer(engineStateRef.current, input);
    engineStateRef.current = result.state;
    applyPresenceEffects(
      result.effects,
      buildInput,
      engineStateRef,
      queuePresenceSync,
      scheduleRetry,
      cancelRetry,
      startConfirmBurst,
    );
  };

  useEffect(() => {
    if (!enabled) {
      uploadCoverRequestRef.current += 1;
      return;
    }

    const track = player.currentTrack;
    if (!track || !needsYtmCoverFallback(track)) {
      return;
    }
    if (uploadCoverCacheRef.current.has(track.id)) {
      return;
    }

    const requestId = ++uploadCoverRequestRef.current;
    void resolveUploadDiscordCover(track)
      .then((resolved) => {
        if (requestId !== uploadCoverRequestRef.current) return;
        if (player.currentTrack?.id !== track.id) return;

        uploadCoverCacheRef.current.set(track.id, resolved);
        dispatch(reducePresenceUploadCoverResolved);
      })
      .catch(() => {
        if (requestId !== uploadCoverRequestRef.current) return;
        if (player.currentTrack?.id !== track.id) return;
        uploadCoverCacheRef.current.set(track.id, { coverUrl: null, videoId: null });
      });
  }, [enabled, player.currentTrack?.id, player.currentTrack?.source, player.currentTrack?.cover]);

  useEffect(() => {
    const clearPresence = async () => {
      cancelRetry();
      cancelConfirmBurst();
      pendingSyncRef.current = null;
      try {
        await syncDiscordPresence({ enabled: false });
      } catch {
        // Best-effort; Rust also clears on window/process exit.
      }
    };

    const onPageHide = () => {
      void clearPresence();
    };

    const unlistenClose = listen(TauriEvent.WINDOW_CLOSE_REQUESTED, () => {
      void clearPresence();
    });

    document.addEventListener("pagehide", onPageHide);

    return () => {
      document.removeEventListener("pagehide", onPageHide);
      cancelRetry();
      cancelConfirmBurst();
      void unlistenClose.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      dispatch(reducePresenceMount);
      return;
    }

    if (!enabled) {
      cancelConfirmBurst();
      dispatch(reducePresenceSettingDisabled);
      return;
    }

    if (!player.isPlaying) {
      cancelConfirmBurst();
    }

    dispatch(reducePresencePlayerUpdate);
  }, [
    enabled,
    player.currentTrack,
    player.isPlaying,
    player.isBuffering,
    player.progress,
    player.seekRevision,
    player.duration,
  ]);

  useEffect(() => () => {
    cancelConfirmBurst();
    dispatch(reducePresenceUnmount);
  }, []);
}