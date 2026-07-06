import { useEffect } from "react";

import { listImportedTracks } from "../api";
import type { MediaTrack } from "../types";
import { withResolvedAudioSrc } from "../utils/media";
import { cancelIdle, useIdle } from "./useIdle";

/**
 * Deferred hydration of the user's imported (uploaded) tracks.
 *
 * Wait for an idle callback (so the work doesn't compete with the first
 * paint + splash teardown), then load the import list and hand it to
 * `onLoaded`. Drops failed loads into an empty array so the caller can
 * skip rendering rather than showing stale data.
 *
 * If `onHydrate` is also provided, it's awaited AFTER the load completes
 * but before the hook effect resolves — typically used to kick off
 * duration metadata batching on the freshly loaded set.
 *
 * `useImportedTracksHydration` is the single owner of the initial-load
 * sequence; the parent does not need to wire a follow-on useEffect.
 * Subsequent manual imports route through the parent's own import
 * handler (which already calls its own duration batcher).
 */
export function useImportedTracksHydration({
  onLoaded,
  onHydrate,
}: {
  onLoaded: (tracks: MediaTrack[]) => void;
  onHydrate?: (tracks: MediaTrack[]) => Promise<void> | void;
}): void {
  useEffect(() => {
    const handle = useIdle(() => {
      const loadImports = async () => {
        try {
          const tracks = await listImportedTracks();
          const hydrated = tracks.map(withResolvedAudioSrc);
          onLoaded(hydrated);
          if (onHydrate) await onHydrate(hydrated);
        } catch {
          onLoaded([]);
        }
      };
      void loadImports();
    });

    return () => cancelIdle(handle);
  }, [onLoaded, onHydrate]);
}
