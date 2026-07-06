import { useEffect, useRef } from "react";
import { usePlayer } from "../player";
import { useSetting } from "../settings";
import { LISTEN_QUALIFY_RATIO, recordQualifiedListen } from "../taste-profile";
import {
  sampleListenProgress,
  type ListenSession,
} from "../utils/listen-accumulator";

/**
 * Invisibly records a qualified listen once the user has actually played
 * through 75% of a track's duration. Seeks do not count toward that total.
 */
export function useTasteProfileTracking(): void {
  const showHomeMenu = useSetting("showHomeMenu");
  const { currentTrack, progress, duration, isPlaying, seekRevision } = usePlayer();
  const sessionRef = useRef<ListenSession | null>(null);

  useEffect(() => {
    if (!showHomeMenu) {
      sessionRef.current = null;
      return;
    }

    if (!currentTrack) {
      sessionRef.current = null;
      return;
    }

    const effectiveDuration =
      duration > 0 ? duration : currentTrack.durationSeconds ?? 0;
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return;

    const { session, newlyQualified } = sampleListenProgress(sessionRef.current, {
      trackId: currentTrack.id,
      progress,
      duration: effectiveDuration,
      isPlaying,
      qualifyRatio: LISTEN_QUALIFY_RATIO,
    });
    sessionRef.current = session;

    if (newlyQualified) {
      recordQualifiedListen(currentTrack);
    }
  }, [showHomeMenu, currentTrack, progress, duration, isPlaying, seekRevision]);
}