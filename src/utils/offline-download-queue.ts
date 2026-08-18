// ---------------------------------------------------------------------------
// Offline download queue.
//
// Saving a song (or an album's worth of tracks) used to fire one
// `saveOffline` per track immediately — every track's resolution search
// AND yt-dlp download ran in parallel, which hammered the YouTube Music
// API and got the app rate-limited (HTTP 429) before most downloads had
// even started.
//
// This module funnels every offline download through ONE bounded queue:
//   - at most `DOWNLOAD_CONCURRENCY` downloads run at once (the resolution
//     search inside each job is bounded by the same slot, so it can't
//     parallel-storm the search API either),
//   - a video id that is already queued / in flight / on disk is skipped,
//   - a failed download is retried silently with exponential backoff —
//     no manual "click to retry" step,
//   - `enqueueOfflineSyncForSavedSongs` lets the app sweep every saved
//     song that is missing its local file (startup, offline-sync re-enable).
// ---------------------------------------------------------------------------

import type { MediaTrack } from "../types";
import {
  cacheArtwork,
  getOfflineVideoPath,
  getSyncedLyricsForTrack,
  saveOffline,
  saveVideoOffline,
} from "../api";
import { getSetting } from "../settings";
import { useOfflineStatusStore } from "../store/offlineStatusStore";
import { createSemaphore } from "./concurrency";
import { streamIdentityVideoIds } from "./media";
import { findMusicVideoForTrack } from "./music-video";
import { resolveStreamTrackAudio, songMetadataFromMatch } from "./song-resolution";

export type OfflineSyncMetadataUpdates = Partial<
  Pick<
    MediaTrack,
    | "durationSeconds"
    | "playCount"
    | "resolvedVideoId"
    | "kind"
    | "title"
    | "artist"
    | "album"
    | "albumBrowseId"
    | "artistBrowseId"
    | "artistCredits"
    | "cover"
  >
>;

/** How many downloads may run at once. Deliberately small: yt-dlp is a full
 *  audio download and the resolution search inside each job is an API call —
 *  parallelizing either is how the app used to get rate-limited. */
const DOWNLOAD_CONCURRENCY = 2;

/** Backoff delays (ms) between retries of a failed download. */
const RETRY_BACKOFF_MS = [8_000, 30_000, 120_000, 600_000];

const semaphore = createSemaphore(DOWNLOAD_CONCURRENCY);

/** Video ids currently queued or in flight. Used to dedupe enqueues. */
const pendingIds = new Set<string>();

type RetryState = {
  attempt: number;
  track: MediaTrack;
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const retryState = new Map<string, RetryState>();

function clearRetryForVideoId(videoId: string): void {
  const state = retryState.get(videoId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  retryState.delete(videoId);
}

/**
 * Cancel any queued / in-flight / retry-pending download work for the given
 * video ids. Called when a song is removed from the collection so an
 * in-flight or retry-scheduled download can't re-create the file after the
 * user unsaved it. Does not touch files already on disk.
 */
export function cancelOfflineSyncForVideoIds(videoIds: readonly string[]): void {
  for (const videoId of videoIds) {
    pendingIds.delete(videoId);
    clearRetryForVideoId(videoId);
  }
}

/**
 * Cancel ALL queued / in-flight / retry-pending download work. Used on a
 * full user-data wipe so a background download can't re-create files after
 * the clear (and to reset module state between tests).
 */
export function cancelAllOfflineSync(): void {
  pendingIds.clear();
  for (const state of retryState.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  retryState.clear();
}

async function runOfflineDownload(
  track: MediaTrack,
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void,
): Promise<boolean> {
  const offlineStatus = useOfflineStatusStore.getState();
  let downloadId = track.resolvedVideoId ?? track.videoId!;
  offlineStatus.setStatus(downloadId, "downloading");
  const metadataUpdates: OfflineSyncMetadataUpdates = {};

  try {
    const resolved = await resolveStreamTrackAudio(track);
    if (resolved) {
      if (resolved.resolvedVideoId && resolved.resolvedVideoId !== track.videoId) {
        downloadId = resolved.resolvedVideoId;
        metadataUpdates.resolvedVideoId = resolved.resolvedVideoId;
      }
      if (track.kind === "video" && resolved.kind && resolved.kind !== "video") {
        metadataUpdates.kind = resolved.kind;
      }
      const enriched = songMetadataFromMatch(resolved);
      if (!track.albumBrowseId && enriched.albumBrowseId) {
        Object.assign(metadataUpdates, enriched);
      }
    }
  } catch {
    // Fall back to the saved videoId.
  }

  if (updateSongMetadata && Object.keys(metadataUpdates).length > 0) {
    updateSongMetadata(track.id, metadataUpdates);
  }

  // A resolved YouTube id can still be rejected by the CDN (403s are
  // common for music-video uploads). Try the other known identities before
  // giving up so one stale/restricted id does not poison offline sync.
  const offlineIds = [
    downloadId,
    ...streamIdentityVideoIds(track).filter((id) => id !== downloadId),
  ];
  // The full identity set INCLUDING the post-resolution id, so the status
  // store is reconciled on both outcomes.
  const identityIds = [...new Set([downloadId, ...streamIdentityVideoIds(track)])];
  let offlineError: unknown = null;
  for (const candidate of offlineIds) {
    try {
      await saveOffline(candidate, getSetting("compactDownloads"));
      offlineError = null;
      for (const id of identityIds) {
        offlineStatus.setStatus(id, "downloaded");
        clearRetryForVideoId(id);
      }
      break;
    } catch (error) {
      offlineError = error;
    }
  }
  if (offlineError) {
    for (const id of identityIds) {
      offlineStatus.setStatus(id, "failed");
    }
    return false;
  }

  const lyricsTrack: MediaTrack = {
    ...track,
    ...metadataUpdates,
    resolvedVideoId: metadataUpdates.resolvedVideoId ?? track.resolvedVideoId ?? null,
  };
  const coverUrl = lyricsTrack.cover ?? track.cover;
  if (coverUrl) {
    void cacheArtwork(coverUrl).catch(() => {});
  }
  try {
    await getSyncedLyricsForTrack(lyricsTrack, { persist: true });
  } catch {
    // Lyrics are best-effort; a failed fetch must not mark the download failed.
  }
  return true;
}

function scheduleRetry(
  track: MediaTrack,
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void,
): void {
  const downloadId = track.resolvedVideoId ?? track.videoId;
  if (!downloadId) return;
  // The retryState entry survives across retry attempts (it is only removed
  // on success or cancel), so the attempt counter keeps growing and the
  // backoff window keeps widening: 8s → 30s → 120s → 600s → 600s…
  const existing = retryState.get(downloadId);
  const currentAttempt = existing?.attempt ?? 0;
  if (existing?.timer) clearTimeout(existing.timer);
  retryState.set(downloadId, {
    attempt: currentAttempt + 1,
    track,
    updateSongMetadata,
    timer: setTimeout(() => {
      void enqueueOfflineSync(track, updateSongMetadata);
    }, RETRY_BACKOFF_MS[Math.min(currentAttempt, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[0]!),
  });
}

/**
 * Enqueue an offline download for a single track. Dedupes by identity video
 * id and skips tracks whose local file already exists. On failure the
 * download is retried silently with exponential backoff instead of leaving
 * a "click to retry" state for the user to deal with.
 */
export function enqueueOfflineSync(
  track: MediaTrack,
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void,
): void {
  if (track.source !== "stream" || !track.videoId) return;

  const identityIds = streamIdentityVideoIds(track);
  const statuses = useOfflineStatusStore.getState().byVideoId;
  // Already on disk (or actively downloading / queued) — nothing to do.
  for (const id of identityIds) {
    if (pendingIds.has(id)) return;
    if (statuses[id] === "downloaded") return;
  }

  const primaryId = track.resolvedVideoId ?? track.videoId;
  if (pendingIds.has(primaryId)) return;

  for (const id of identityIds) {
    pendingIds.add(id);
  }

  void semaphore
    .run(() => runOfflineDownload(track, updateSongMetadata))
    .then(
      (succeeded) => {
        for (const id of identityIds) {
          pendingIds.delete(id);
        }
        if (!succeeded) {
          scheduleRetry(track, updateSongMetadata);
        }
      },
      () => {
        for (const id of identityIds) {
          pendingIds.delete(id);
        }
        scheduleRetry(track, updateSongMetadata);
      },
    );
}

// ---------------------------------------------------------------------------
// Music-video offline saves
// ---------------------------------------------------------------------------
//
// Saved songs with a music video persist the MV into the offline folder via
// the same bounded queue (the backend `save_video_offline` resolves the video
// through the streams cache and copies it into place). The video id is the
// MUSIC VIDEO's id (what `findMusicVideoForTrack` found), not the song's
// audio id — it gets its own pending-dedupe namespace (`mv:` prefix) so it
// can't collide with the audio queue's id set.

/** Music-video ids currently queued / in flight (namespace `mv:`). */
const videoPendingIds = new Set<string>();

async function runMusicVideoOfflineSave(track: MediaTrack): Promise<void> {
  // Find the MV (cached by the Now Playing button check when it exists),
  // then skip when the file is already saved locally.
  const mv = await findMusicVideoForTrack(track);
  if (!mv?.videoId) return;
  const key = `mv:${mv.videoId}`;
  if (videoPendingIds.has(key)) return;
  if (await getOfflineVideoPath(mv.videoId)) return;
  videoPendingIds.add(key);
  try {
    await saveVideoOffline(mv.videoId);
  } finally {
    videoPendingIds.delete(key);
  }
}

/**
 * Enqueue a background music-video offline save for a stream track. Runs
 * through the same bounded semaphore as audio downloads so saving a whole
 * album can't fire a dozen yt-dlp video downloads at once. Best-effort: a
 * failed MV save must never fail the song save it piggybacks on.
 */
export function enqueueMusicVideoOfflineSync(track: MediaTrack): void {
  if (track.source !== "stream" || !track.videoId) return;
  void semaphore.run(() => runMusicVideoOfflineSave(track)).catch(() => {});
}

/**
 * Cancel any queued / in-flight music-video offline save for the given MUSIC
 * VIDEO ids (not the song's audio ids). Called when a song is removed from
 * the collection so a background save can't re-create the MV file after the
 * user unsaved it. Does not touch files already on disk.
 */
export function cancelMusicVideoOfflineSync(musicVideoIds: readonly string[]): void {
  for (const id of musicVideoIds) {
    videoPendingIds.delete(`mv:${id}`);
  }
}

/**
 * Sweep a list of saved songs and quietly enqueue downloads for every
 * stream track that does not yet have a local file. This is what makes a
 * song that never downloaded (failed attempt, offlineSync was off, fresh
 * install) get its file WITHOUT any manual action — while the bounded queue
 * keeps the download trickle from getting the app rate-limited.
 */
export function enqueueOfflineSyncForSavedSongs(
  tracks: readonly MediaTrack[],
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void,
): void {
  for (const track of tracks) {
    if (track.source !== "stream" || !track.videoId) continue;
    enqueueOfflineSync(track, updateSongMetadata);
    // Saved songs with a music video also get the MV persisted locally, so
    // the watch page can play it offline / without re-downloading.
    enqueueMusicVideoOfflineSync(track);
  }
}
