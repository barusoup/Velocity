import type { MediaTrack } from "../types";
import { isAutoplayWatchPlaylistCandidate, isLikelyMusicVideoTrack } from "./media";

/**
 * Pure resolver for the autoplay queue refill.
 *
 * Carved out of `player.tsx`'s `fetchAndAppendAutoplay`. Returns the
 * full set of additions plus the playlist id discovered from the primary
 * seed and the seed the caller should advance to. The wrapper that hands
 * the additions to React state, mutates the seed, and runs the
 * retry/backoff timer logic stays in `player.tsx`.
 *
 * The helper depends on injected `getWatchPlaylist` and the
 * `resolveAutoplayEntryToSong` transform so it can be unit-tested with
 * stub implementations. The production wiring passes the real
 * `getWatchPlaylist` from `../api` and `resolveAutoplayEntryToSong`
 * from the player at the call site.
 */

export type AutoplaySeed = {
  videoId: string;
  playlistId: string | null;
};

/**
 * Watch-playlist response from the Tauri API. We declare our own
 * narrow type here (vs. importing `WatchPlaylistResponse` from
 * `../types`) so this helper is self-contained — the call site passes
 * the real `getWatchPlaylist` from `../api`.
 */
type WatchPlaylistResponse = {
  tracks: MediaTrack[];
  playlistId?: string | null;
};

export interface AutoplayResolverDeps {
  getWatchPlaylist: (
    videoId: string,
    playlistId?: string | null,
  ) => Promise<WatchPlaylistResponse>;
  resolveAutoplayEntryToSong: (entry: MediaTrack) => Promise<MediaTrack | null>;
  buildSeenIndex: (
    queue: readonly MediaTrack[],
  ) => {
    ids: Set<string>;
    videoIds: Set<string>;
    artistTitles: Set<string>;
  };
  isInRecentlyPlayed: (entry: MediaTrack) => boolean;
}

export interface AutoplayResolverInput {
  seed: AutoplaySeed;
  queue: readonly MediaTrack[];
  currentIndex: number;
  autoplayIds: ReadonlySet<string>;
  autoplayEnabled: () => boolean;
  seedStillCurrent: () => boolean;
  batchLimit: number;
  queueTarget: number;
}

export interface AutoplayResolverResult {
  additions: MediaTrack[];
  nextSeed: AutoplaySeed | null;
  playlistId: string | null;
}

type SeenIndex = {
  ids: Set<string>;
  videoIds: Set<string>;
  artistTitles: Set<string>;
};

const RESOLVE_CONCURRENCY = 4;

function isAcceptableAutoplayEntry(
  entry: MediaTrack,
  seen: SeenIndex,
  deps: AutoplayResolverDeps,
): boolean {
  if (isLikelyMusicVideoTrack(entry)) return false;
  if (seen.ids.has(entry.id)) return false;
  if (entry.videoId != null && seen.videoIds.has(entry.videoId)) return false;
  if (seen.artistTitles.has(`${entry.artist}\0${entry.title}`.toLowerCase())) return false;
  if (deps.isInRecentlyPlayed(entry)) return false;
  return true;
}

async function resolveEntriesWithConcurrency(
  entries: MediaTrack[],
  resolve: (entry: MediaTrack) => Promise<MediaTrack | null>,
): Promise<Array<MediaTrack | null>> {
  const results: Array<MediaTrack | null> = new Array(entries.length).fill(null);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await resolve(entries[index]!);
    }
  }

  const workerCount = Math.min(RESOLVE_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function fetchAdditionsFromSeed(
  seed: AutoplaySeed,
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
  seen: SeenIndex,
  limit: number,
): Promise<{ tracks: MediaTrack[]; playlistId: string | null }> {
  const response = await deps.getWatchPlaylist(seed.videoId, seed.playlistId);

  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return { tracks: [], playlistId: response.playlistId ?? null };
  }

  const incoming = response.tracks.filter(isAutoplayWatchPlaylistCandidate);
  const transformed = await resolveEntriesWithConcurrency(
    incoming,
    deps.resolveAutoplayEntryToSong,
  );

  const candidates = transformed.filter((entry): entry is MediaTrack => entry !== null);
  const tracks: MediaTrack[] = [];

  for (const entry of candidates) {
    if (!isAcceptableAutoplayEntry(entry, seen, deps)) continue;
    seen.ids.add(entry.id);
    if (entry.videoId) seen.videoIds.add(entry.videoId);
    seen.artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
    tracks.push(entry);
    if (tracks.length >= limit) break;
  }

  return {
    tracks,
    playlistId: response.playlistId ?? null,
  };
}

/**
 * Resolve the autoplay queue refill.
 *
 * Compute the gap (queue target − autoplay tracks currently AFTER the
 * playhead), run the primary fetch, then compensate for any dropped
 * music videos / duplicates / recently-played tracks by fetching from
 * upcoming manually-queued songs until the target is met or the queue
 * is exhausted.
 */
export async function resolveAutoplayAdditions(
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
): Promise<AutoplayResolverResult> {
  if (!input.autoplayEnabled()) {
    return { additions: [], nextSeed: null, playlistId: null };
  }

  const seen = deps.buildSeenIndex(input.queue);
  // Mark manually-queued songs as seen too so we never auto-pick them.
  for (const track of input.queue) {
    if (input.autoplayIds.has(track.id)) continue;
    seen.ids.add(track.id);
    if (track.videoId) seen.videoIds.add(track.videoId);
    seen.artistTitles.add(`${track.artist}\0${track.title}`.toLowerCase());
  }

  const autoplayAhead = input.queue
    .slice(input.currentIndex + 1)
    .filter((track) => input.autoplayIds.has(track.id)).length;
  const missingTracks = Math.max(0, input.queueTarget - autoplayAhead);
  if (missingTracks === 0) {
    return { additions: [], nextSeed: null, playlistId: null };
  }

  const primary = await fetchAdditionsFromSeed(
    input.seed,
    input,
    deps,
    seen,
    Math.min(input.batchLimit, missingTracks),
  );

  const additions: MediaTrack[] = primary.tracks.slice();
  // Track which fetch's playlistId produced the last addition. When the
  // final addition comes from a compensatory/secondary fetch we must pair
  // the next seed with that response's playlist context — not the primary
  // fetch's.
  let lastAdditionPlaylistId: string | null = primary.playlistId;

  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return { additions: [], nextSeed: null, playlistId: null };
  }

  // If the primary fetch fell short, try to compensate by seeding from
  // upcoming manually-queued songs. This covers music videos that were
  // dropped because they have no studio match, duplicates, or recently
  // played tracks.
  if (additions.length < missingTracks) {
    const upcomingManual = input.queue
      .slice(input.currentIndex + 1)
      .filter((track) => !input.autoplayIds.has(track.id) && track.videoId);
    const usedManualVideoIds = new Set<string>();

    for (const candidate of upcomingManual) {
      if (!candidate.videoId || candidate.videoId === input.seed.videoId) continue;
      if (usedManualVideoIds.has(candidate.videoId)) continue;
      usedManualVideoIds.add(candidate.videoId);
      if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
        break;
      }

      const remaining = missingTracks - additions.length;
      try {
        const batch = await fetchAdditionsFromSeed(
          { videoId: candidate.videoId, playlistId: null },
          input,
          deps,
          seen,
          remaining,
        );
        if (batch.tracks.length > 0) {
          additions.push(...batch.tracks);
          lastAdditionPlaylistId = batch.playlistId;
        }
      } catch (error) {
        console.warn("Compensatory autoplay fetch failed:", error);
      }
      if (additions.length >= missingTracks) break;
    }
  }

  const last = additions[additions.length - 1];
  const nextSeed: AutoplaySeed | null = last
    ? {
        videoId: last.resolvedVideoId ?? last.videoId ?? "",
        playlistId: lastAdditionPlaylistId ?? input.seed.playlistId ?? null,
      }
    : null;
  if (nextSeed && !nextSeed.videoId) {
    return { additions: [], nextSeed: null, playlistId: null };
  }

  return {
    additions: additions.slice(0, missingTracks),
    nextSeed,
    playlistId: lastAdditionPlaylistId,
  };
}
