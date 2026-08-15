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
  const { currentTrack, duration, isPlaying } = usePlayerState();
  const sessionRef = useRef<ListenSession | null>(null);
  const currentTrackRef = useRef(currentTrack);
  const effectiveDurationRef = useRef(0);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  useEffect(() => {
    if (!showHomeMenu || !currentTrack) {
      sessionRef.current = null;
      return;
    }

    const effectiveDuration =
      duration > 0 ? duration : currentTrack.durationSeconds ?? 0;
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return;
    effectiveDurationRef.current = effectiveDuration;

    const sample = () => {
      const track = currentTrackRef.current;
      if (!track) return;

      const { session, newlyQualified } = sampleListenProgress(sessionRef.current, {
        trackId: track.id,
        progress: getPlayerProgress(),
        duration: effectiveDurationRef.current,
        isPlaying: usePlayerUiStore.getState().isPlaying,
        qualifyRatio: LISTEN_QUALIFY_RATIO,
      });
      sessionRef.current = session;

      if (newlyQualified) {
        recordQualifiedListen(track);
      }
    };

    // Reset session when track changes; seekRevision is handled inside
    // sampleListenProgress via progress resets, not by restarting the timer.
    sessionRef.current = null;
    sample();
    const timer = window.setInterval(sample, TASTE_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [showHomeMenu, currentTrack?.id, duration, isPlaying]);
}