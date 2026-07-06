import type { MediaTrack } from "../types";
import { isAutoplayWatchPlaylistCandidate } from "./media";

/**
 * Pure resolver for the autoplay queue refill.
 *
 * Carved out of `player.tsx`'s `fetchAndAppendAutoplay`. Returns the
 * full set of `{ initial, second, compensatory }` additions + the
 * `playlistId` from the second-candidate response (if any) and the
 * next seed the orchestrator should commit. The wrapper that hands the
 * additions to React state, mutates the seed, and runs the
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
  playlistId: string | null;
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
  initialAdditions: MediaTrack[];
  secondAdditions: MediaTrack[];
  compensatoryAdditions: MediaTrack[];
  playlistId: string | null;
  primaryPlaylistId: string | null;
  nextSeed: AutoplaySeed | null;
  primaryExhausted: boolean;
  secondExhausted: boolean;
}

/**
 * Step 1 — fetch the watch playlist for the current seed and dedup
 * against the queue snapshot.
 */
async function fetchInitialAdditions(
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
  seen: {
    ids: Set<string>;
    videoIds: Set<string>;
    artistTitles: Set<string>;
  },
): Promise<{ additions: MediaTrack[]; playlistId: string | null; exhausted: boolean }> {
  const rawResponse = await deps.getWatchPlaylist(
    input.seed.videoId,
    input.seed.playlistId,
  );
  const response: WatchPlaylistResponse = {
    tracks: rawResponse.tracks,
    playlistId: rawResponse.playlistId ?? null,
  };
  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return { additions: [], playlistId: response.playlistId, exhausted: true };
  }
  const incoming = response.tracks.filter(isAutoplayWatchPlaylistCandidate);
  const transformed: Array<MediaTrack | null> = [];
  for (const entry of incoming) {
    transformed.push(await deps.resolveAutoplayEntryToSong(entry));
  }
  const candidates = transformed.filter(
    (entry): entry is MediaTrack => entry !== null,
  );
  const additions: MediaTrack[] = [];
  for (const entry of candidates) {
    const isDuplicate =
      seen.ids.has(entry.id) ||
      (entry.videoId != null && seen.videoIds.has(entry.videoId)) ||
      seen.artistTitles.has(`${entry.artist}\0${entry.title}`.toLowerCase());
    if (isDuplicate) continue;
    if (additions.some((existing) => existing.id === entry.id)) continue;
    seen.ids.add(entry.id);
    if (entry.videoId) seen.videoIds.add(entry.videoId);
    seen.artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
    additions.push(entry);
  }
  return {
    additions: additions.slice(0, Math.min(input.batchLimit, input.queueTarget)),
    playlistId: response.playlistId,
    exhausted: additions.length === 0,
  };
}

/**
 * Step 2 — if the primary fetch fell under the queue target, seed
 * another fetch from the last manually-queued song.
 */
async function fetchSecondAdditions(
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
  seen: {
    ids: Set<string>;
    videoIds: Set<string>;
    artistTitles: Set<string>;
  },
  remaining: number,
): Promise<{ additions: MediaTrack[]; playlistId: string | null; exhausted: boolean }> {
  if (remaining <= 0 || input.queue.length === 0) {
    return { additions: [], playlistId: null, exhausted: true };
  }
  const manualSongs = input.queue.filter(
    (track) => !input.autoplayIds.has(track.id) && track.kind !== "video",
  );
  const secondCandidate =
    manualSongs[manualSongs.length - 1] ?? input.queue[input.queue.length - 1];
  // Pull the seed video id into a local so TypeScript can narrow once
  // and propagate the narrow through the rest of the function.
  const seedVideoId: string | null = secondCandidate?.videoId ?? null;
  if (seedVideoId === null) {
    return { additions: [], playlistId: null, exhausted: true };
  }
  if (seedVideoId === input.seed.videoId) {
    return { additions: [], playlistId: null, exhausted: true };
  }
  try {
    const rawResponse = await deps.getWatchPlaylist(seedVideoId);
    const response: WatchPlaylistResponse = {
      tracks: rawResponse.tracks,
      playlistId: rawResponse.playlistId ?? null,
    };
    if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
      return { additions: [], playlistId: response.playlistId, exhausted: true };
    }
    const incoming = response.tracks.filter(isAutoplayWatchPlaylistCandidate);
    const transformed: Array<MediaTrack | null> = [];
    for (const entry of incoming) {
      transformed.push(await deps.resolveAutoplayEntryToSong(entry));
    }
    const candidates = transformed.filter(
      (entry): entry is MediaTrack => entry !== null,
    );
    const additions: MediaTrack[] = [];
    for (const entry of candidates) {
      const isDuplicate =
        seen.ids.has(entry.id) ||
        (entry.videoId != null && seen.videoIds.has(entry.videoId)) ||
        seen.artistTitles.has(`${entry.artist}\0${entry.title}`.toLowerCase());
      if (isDuplicate) continue;
      if (additions.some((existing) => existing.id === entry.id)) continue;
      seen.ids.add(entry.id);
      if (entry.videoId) seen.videoIds.add(entry.videoId);
      seen.artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
      additions.push(entry);
      if (additions.length >= remaining) break;
    }
    return {
      additions,
      playlistId: response.playlistId,
      exhausted: additions.length === 0,
    };
  } catch {
    return { additions: [], playlistId: null, exhausted: true };
  }
}

/**
 * Step 3 — if additions from steps 1+2 are filtered out by the
 * recently-played set, fetch once more from the next manually-queued
 * song after the current index, so the radio compensates without the
 * listener noticing the gap.
 */
async function fetchCompensatoryAdditions(
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
  seen: {
    ids: Set<string>;
    videoIds: Set<string>;
    artistTitles: Set<string>;
  },
  filteredCount: number,
): Promise<MediaTrack[]> {
  if (filteredCount <= 0 || input.queue.length === 0) return [];
  const sliceAfterCurrent = input.queue.slice(input.currentIndex + 1);
  const afterCurrent =
    sliceAfterCurrent.find((t) => !input.autoplayIds.has(t.id)) ??
    sliceAfterCurrent[0];
  const seedVideoId: string | null = afterCurrent?.videoId ?? null;
  if (seedVideoId === null || seedVideoId === input.seed.videoId) {
    return [];
  }
  try {
    const rawResponse = await deps.getWatchPlaylist(seedVideoId);
    const response: WatchPlaylistResponse = {
      tracks: rawResponse.tracks,
      playlistId: rawResponse.playlistId ?? null,
    };
    if (!input.autoplayEnabled() || !input.seedStillCurrent()) return [];
    const incoming = response.tracks.filter(isAutoplayWatchPlaylistCandidate);
    const transformed: Array<MediaTrack | null> = [];
    for (const entry of incoming) {
      transformed.push(await deps.resolveAutoplayEntryToSong(entry));
    }
    const candidates = transformed.filter(
      (e): e is MediaTrack => e !== null,
    );
    const additions: MediaTrack[] = [];
    for (const entry of candidates) {
      const isDuplicate =
        seen.ids.has(entry.id) ||
        (entry.videoId != null && seen.videoIds.has(entry.videoId)) ||
        seen.artistTitles.has(`${entry.artist}\0${entry.title}`.toLowerCase());
      if (isDuplicate) continue;
      if (deps.isInRecentlyPlayed(entry)) continue;
      if (additions.some((existing) => existing.id === entry.id)) continue;
      seen.ids.add(entry.id);
      if (entry.videoId) seen.videoIds.add(entry.videoId);
      seen.artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
      additions.push(entry);
      if (additions.length >= filteredCount) break;
    }
    return additions;
  } catch {
    return [];
  }
}

/**
 * Resolve the autoplay queue refill.
 *
 * Compute the gap (queue target − autoplay tracks currently AFTER the
 * playhead), run the 3-phase fetch (primary seed, second-candidate,
 * compensatory for recently-played filters), filter out recently-played
 * from the merged additions, and compensate from the next manually-
 * queued song if the filter dropped any.
 */
export async function resolveAutoplayAdditions(
  input: AutoplayResolverInput,
  deps: AutoplayResolverDeps,
): Promise<AutoplayResolverResult> {
  if (!input.autoplayEnabled()) {
    return {
      initialAdditions: [],
      secondAdditions: [],
      compensatoryAdditions: [],
      playlistId: null,
      primaryPlaylistId: null,
      nextSeed: null,
      primaryExhausted: true,
      secondExhausted: true,
    };
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
    return {
      initialAdditions: [],
      secondAdditions: [],
      compensatoryAdditions: [],
      playlistId: null,
      primaryPlaylistId: null,
      nextSeed: null,
      primaryExhausted: true,
      secondExhausted: true,
    };
  }

  const initial = await fetchInitialAdditions(input, deps, seen);
  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return {
      initialAdditions: [],
      secondAdditions: [],
      compensatoryAdditions: [],
      playlistId: initial.playlistId,
      primaryPlaylistId: initial.playlistId,
      nextSeed: null,
      primaryExhausted: initial.exhausted,
      secondExhausted: true,
    };
  }

  const remainingAfterInitial = missingTracks - initial.additions.length;
  const second =
    remainingAfterInitial > 0
      ? await fetchSecondAdditions(input, deps, seen, remainingAfterInitial)
      : { additions: [] as MediaTrack[], playlistId: null, exhausted: true };
  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return {
      initialAdditions: initial.additions,
      secondAdditions: second.additions,
      compensatoryAdditions: [],
      playlistId: second.playlistId,
      primaryPlaylistId: initial.playlistId,
      nextSeed: null,
      primaryExhausted: initial.exhausted,
      secondExhausted: second.exhausted,
    };
  }

  const merged = [...initial.additions, ...second.additions].slice(
    0,
    missingTracks,
  );
  const beforeFilter = merged.length;
  const filtered = merged.filter((t) => !deps.isInRecentlyPlayed(t));
  const filteredCount = beforeFilter - filtered.length;

  const compensatory =
    filteredCount > 0
      ? await fetchCompensatoryAdditions(input, deps, seen, filteredCount)
      : [];
  if (!input.autoplayEnabled() || !input.seedStillCurrent()) {
    return {
      initialAdditions: initial.additions,
      secondAdditions: second.additions,
      compensatoryAdditions: [],
      playlistId: second.playlistId,
      primaryPlaylistId: initial.playlistId,
      nextSeed: null,
      primaryExhausted: initial.exhausted,
      secondExhausted: second.exhausted,
    };
  }

  const finalAdditions = [...filtered, ...compensatory];
  const songAdditionsOnly = finalAdditions.filter((t) => t.kind !== "video");
  const seedAdvance =
    songAdditionsOnly[songAdditionsOnly.length - 1] ??
    finalAdditions[finalAdditions.length - 1];
  const nextSeed: AutoplaySeed | null = seedAdvance?.videoId
    ? {
        videoId: seedAdvance.videoId,
        playlistId:
          second.playlistId ?? initial.playlistId ?? input.seed.playlistId ?? null,
      }
    : null;

  return {
    initialAdditions: initial.additions,
    secondAdditions: second.additions,
    compensatoryAdditions: compensatory,
    playlistId: second.playlistId,
    primaryPlaylistId: initial.playlistId,
    nextSeed,
    primaryExhausted: initial.exhausted,
    secondExhausted: second.exhausted,
  };
}
