import { useEffect, useRef } from "react";
import { getPlayerProgress, usePlayerUiStore } from "../store/playerUiStore";
import { usePlayerState } from "../player";
import { useSetting } from "../settings";
import { LISTEN_QUALIFY_RATIO, recordQualifiedListen } from "../taste-profile";
import {
  sampleListenProgress,
  type ListenSession,
} from "../utils/listen-accumulator";

const TASTE_SAMPLE_INTERVAL_MS = 1000;

/**
 * Invisibly records a qualified listen once the user has actually played
 * through 75% of a track's duration. Seeks do not count toward that total.
 */
export function useTasteProfileTracking(): void {
  const showHomeMenu = useSetting("showHomeMenu");
  const { currentTrack, duration, isPlaying, seekRevision } = usePlayerState();
  const sessionRef = useRef<ListenSession | null>(null);
  const seekRevisionRef = useRef(seekRevision);

  useEffect(() => {
    seekRevisionRef.current = seekRevision;
  }, [seekRevision]);

  useEffect(() => {
    if (!showHomeMenu || !currentTrack) {
      sessionRef.current = null;
      return;
    }

    const effectiveDuration =
      duration > 0 ? duration : currentTrack.durationSeconds ?? 0;
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return;

    const sample = () => {
      const track = currentTrack;
      if (!track) return;

      const { session, newlyQualified } = sampleListenProgress(sessionRef.current, {
        trackId: track.id,
        progress: getPlayerProgress(),
        duration: effectiveDuration,
        isPlaying: usePlayerUiStore.getState().isPlaying,
        qualifyRatio: LISTEN_QUALIFY_RATIO,
      });
      sessionRef.current = session;

      if (newlyQualified) {
        recordQualifiedListen(track);
      }
    };

    sample();
    const timer = window.setInterval(sample, TASTE_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [showHomeMenu, currentTrack, duration, isPlaying, seekRevision]);
}