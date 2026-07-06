import { useEffect, useRef } from "react";
import type { MediaTrack } from "../types";
import { mergeTrackListMetadata, resolveTrackMetadata } from "../utils/track-metadata-backfill";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [700, 2500, 5000];
const BACKFILL_CONCURRENCY = 4;

export function useTrackMetadataBackfill(
  tracks: MediaTrack[],
  onTracksChange: (tracks: MediaTrack[]) => void,
  options?: { duration?: boolean; playCount?: boolean },
): void {
  const backfillDuration = options?.duration ?? true;
  const backfillPlayCount = options?.playCount ?? true;
  const onTracksChangeRef = useRef(onTracksChange);
  onTracksChangeRef.current = onTracksChange;

  const tracksKey = tracks
    .map((track) => `${track.id}:${track.durationSeconds ?? ""}:${track.playCount ?? ""}`)
    .join("|");

  useEffect(() => {
    const missing = tracks.filter(
      (track) =>
        !!track.videoId &&
        ((backfillDuration && track.durationSeconds == null) ||
          (backfillPlayCount && track.playCount == null)),
    );
    if (missing.length === 0) return;

    const controller = new AbortController();
    let currentTracks = tracks;

    async function backfillTrack(track: MediaTrack): Promise<boolean> {
      if (controller.signal.aborted) return false;
      try {
        const updates = await resolveTrackMetadata(track, {
          needsDuration: backfillDuration && track.durationSeconds == null,
          needsPlayCount: backfillPlayCount && track.playCount == null,
        });
        if (!updates || controller.signal.aborted) return false;
        currentTracks = mergeTrackListMetadata(currentTracks, track.id, updates);
        onTracksChangeRef.current(currentTracks);
        return true;
      } catch {
        return false;
      }
    }

    async function backfillBatch(batch: MediaTrack[]): Promise<boolean> {
      const results = await Promise.all(batch.map((track) => backfillTrack(track)));
      return results.some(Boolean);
    }

    async function backfill() {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (controller.signal.aborted) return;

        let anyFetched = false;
        for (let index = 0; index < missing.length; index += BACKFILL_CONCURRENCY) {
          if (controller.signal.aborted) return;
          const batch = missing.slice(index, index + BACKFILL_CONCURRENCY);
          if (await backfillBatch(batch)) {
            anyFetched = true;
          }
        }

        if (anyFetched) return;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
      }
    }

    void backfill();

    return () => controller.abort();
  }, [tracksKey, backfillDuration, backfillPlayCount, tracks]);
}