import type { MediaTrack } from "../types";

/** Max tracks stored per playback-history entry (window around the playhead). */
export const PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX = 150;

/**
 * Compact a queue snapshot for playback-history storage. Long autoplay /
 * imported playlists can hold hundreds of tracks; storing the full queue in
 * every history entry multiplied by RECENTLY_PLAYED_LIMIT would retain tens
 * of thousands of duplicate MediaTrack objects. Keep a window centered on
 * the playhead so restore still works for the active session context.
 */
export function compactQueueForHistorySnapshot(
  queue: readonly MediaTrack[],
  queueIndex: number,
): { queue: MediaTrack[]; queueIndex: number } {
  const max = PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX;
  if (queue.length <= max) {
    return { queue: [...queue], queueIndex };
  }

  const half = Math.floor(max / 2);
  let start = Math.max(0, queueIndex - half);
  let end = start + max;
  if (end > queue.length) {
    end = queue.length;
    start = Math.max(0, end - max);
  }

  return {
    queue: queue.slice(start, end),
    queueIndex: queueIndex - start,
  };
}