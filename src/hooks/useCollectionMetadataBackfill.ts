import { useLayoutEffect, useRef } from "react";
import type { MediaTrack } from "../types";
import {
  peekTrackMetadataCache,
  resolveTrackAlbumMetadata,
  resolveTrackMetadata,
  trackNeedsCollectionMetadataBackfill,
  type TrackMetadataUpdates,
} from "../utils/track-metadata-backfill";
import { isPlaceholderAlbumName } from "../utils/upload-enrichment";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [700, 2500, 5000];
const BACKFILL_CONCURRENCY = 4;

type CollectionMetadataUpdater = {
  updateSongMetadata: (trackId: string, updates: TrackMetadataUpdates) => void;
  updateSongsMetadataBatch: (
    updatesById: ReadonlyMap<string, TrackMetadataUpdates>,
  ) => void;
};

/**
 * Enrich saved-collection songs once per session. Runs at the page level so
 * tab switches do not remount the backfill effect or replay resolved lookups.
 */
export function useCollectionMetadataBackfill(
  songs: MediaTrack[],
  { updateSongMetadata, updateSongsMetadataBatch }: CollectionMetadataUpdater,
): void {
  const updateRef = useRef(updateSongMetadata);
  updateRef.current = updateSongMetadata;
  const batchRef = useRef(updateSongsMetadataBatch);
  batchRef.current = updateSongsMetadataBatch;

  const songsKey = songs
    .map((track) =>
      [
        track.id,
        track.durationSeconds ?? "",
        track.playCount ?? "",
        track.album ?? "",
        track.albumBrowseId ?? "",
      ].join(":"),
    )
    .join("|");

  useLayoutEffect(() => {
    const missing = songs.filter(trackNeedsCollectionMetadataBackfill);
    if (missing.length === 0) return;

    // Apply any session cache hits synchronously in one commit so the first
    // paint after a tab switch already reflects prior backfill work.
    const cachedUpdates = new Map<string, TrackMetadataUpdates>();
    for (const track of missing) {
      const coreCached = peekTrackMetadataCache(track.id, "core");
      const albumCached = peekTrackMetadataCache(track.id, "album");
      const merged = { ...(coreCached ?? {}), ...(albumCached ?? {}) };
      if (Object.keys(merged).length > 0) {
        cachedUpdates.set(track.id, merged);
      }
    }
    if (cachedUpdates.size > 0) {
      batchRef.current(cachedUpdates);
    }

    const controller = new AbortController();

    async function backfillTrack(track: MediaTrack): Promise<TrackMetadataUpdates | null> {
      if (!track.videoId || controller.signal.aborted) return null;
      if (!trackNeedsCollectionMetadataBackfill(track)) return null;

      try {
        const needsDuration = track.durationSeconds == null;
        const needsPlayCount = track.playCount == null;
        const needsAlbum = isPlaceholderAlbumName(track.album);
        const needsAlbumBrowseId = !track.albumBrowseId?.trim();

        const metadataUpdates =
          needsDuration || needsPlayCount
            ? await resolveTrackMetadata(track, { needsDuration, needsPlayCount })
            : null;
        const albumUpdates =
          needsAlbum || needsAlbumBrowseId ? await resolveTrackAlbumMetadata(track) : null;

        const merged = {
          ...(metadataUpdates ?? {}),
          ...(albumUpdates ?? {}),
        };
        return Object.keys(merged).length > 0 ? merged : null;
      } catch {
        return null;
      }
    }

    async function backfill() {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (controller.signal.aborted) return;

        let anyFetched = false;
        for (let index = 0; index < missing.length; index += BACKFILL_CONCURRENCY) {
          if (controller.signal.aborted) return;
          const batch = missing.slice(index, index + BACKFILL_CONCURRENCY);
          const results = await Promise.all(batch.map((track) => backfillTrack(track)));
          const updatesById = new Map<string, TrackMetadataUpdates>();
          for (let resultIndex = 0; resultIndex < batch.length; resultIndex += 1) {
            const updates = results[resultIndex];
            if (!updates) continue;
            updatesById.set(batch[resultIndex]!.id, updates);
          }
          if (updatesById.size > 0) {
            batchRef.current(updatesById);
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
  }, [songsKey, songs]);
}