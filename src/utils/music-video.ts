// ---------------------------------------------------------------------------
// Music-video lookup for the watch page ("Music Video" button).
//
// The official music video is very often the TOP result of a direct song
// search ("Song Artist"), but not always — the studio audio upload can rank
// first, or a remix/live version can sit above the video shelf. The picker
// therefore only ever returns a `kind === "video"` search row whose title and
// artist actually match the active song, ranked by how video-like / how
// close to the top it is. When no such row exists, the song has no (found)
// music video and the caller shows "no music video" instead of guessing.
// ---------------------------------------------------------------------------

import { searchMusic } from "../api";
import type { MediaTrack, SearchItem } from "../types";
import { streamIdentityVideoIds } from "./media";
import { getSearchItemArtist, isPlaceholderArtist } from "./search";
import {
  cleanAutoplaySearchTitle,
  normalizeText,
  titleLooksLikeMusicVideo,
  tokenOverlap,
} from "./track-titles";

// ---------------------------------------------------------------------------
// Session cache
//
// Both the Now Playing button check and the watch page call
// `findMusicVideoForTrack` for the same track. The panel's check populates
// this cache so the page skips the duplicate network search and goes straight
// to the download — the page's own 8s search timeout was the visible delay
// between clicking "Music Video" and the download actually starting. Negative
// results are cached too, so a song with no MV doesn't get re-searched every
// time the panel opens. Capped so a long session can't grow it unbounded.
// ---------------------------------------------------------------------------
const FINDER_CACHE_MAX = 64;
const finderCache = new Map<string, MusicVideoMatch | null>();

function finderCacheKey(
  track: Pick<
    MediaTrack,
    "id" | "videoId" | "resolvedVideoId" | "source" | "title" | "artist"
  >,
): string | null {
  if (track.source === "stream") {
    const ids = streamIdentityVideoIds(track);
    return ids.length > 0 ? `stream:${ids.join(",")}` : null;
  }
  return `upload:${track.id}:${track.title}:${track.artist}`;
}

/** Drop all cached results (used by tests and the retry path). */
export function clearMusicVideoFinderCache(): void {
  finderCache.clear();
}

export type MusicVideoMatch = {
  videoId: string;
  title: string;
  artist: string;
  cover?: string | null;
  durationSeconds?: number | null;
};

/** Lenient title equality: "Song (Official Music Video)" matches "Song". */
function titlesMatchLenient(sourceTitle: string, candidateTitle: string): boolean {
  const source = normalizeText(cleanAutoplaySearchTitle(sourceTitle));
  const candidate = normalizeText(cleanAutoplaySearchTitle(candidateTitle));
  if (!source || !candidate) return false;
  if (source === candidate) return true;
  return tokenOverlap(source, candidate) >= 0.8;
}

function artistsMatchLenient(left: string, right: string | null | undefined): boolean {
  const a = normalizeText(left);
  const b = normalizeText(right ?? "");
  if (!a || !b) return false;
  if (a === b) return true;
  return tokenOverlap(a, b) >= 0.75;
}

function candidateMatchesSong(
  track: Pick<MediaTrack, "title" | "artist">,
  item: SearchItem,
): boolean {
  const artist = getSearchItemArtist(item);
  if (isPlaceholderArtist(artist)) return false;
  return titlesMatchLenient(track.title, item.title) && artistsMatchLenient(track.artist, artist);
}

/**
 * Rank a matching candidate. Higher is better. The top-of-list bonus is
 * deliberately smaller than the video-kind bonus so a music video a few rows
 * down still beats the studio song at the top.
 */
function candidateScore(
  track: Pick<MediaTrack, "title" | "artist" | "durationSeconds" | "videoId">,
  item: SearchItem,
  index: number,
): number {
  let score = 0;
  if (item.kind === "video") score += 100;
  else if (item.kind === "song") score += 30;
  if (titleLooksLikeMusicVideo(item.title)) score += 25;
  if (item.videoId && track.videoId && item.videoId === track.videoId) score += 60;
  if (index === 0) score += 40;
  else score += Math.max(0, 20 - index * 4);
  if (
    track.durationSeconds &&
    item.durationSeconds &&
    Math.abs(track.durationSeconds - item.durationSeconds) <=
      Math.max(15, track.durationSeconds * 0.15)
  ) {
    score += 15;
  }
  return score;
}

function collectSearchCandidates(response: {
  topResult?: SearchItem | null;
  results?: SearchItem[];
}): SearchItem[] {
  const candidates: SearchItem[] = [];
  if (response.topResult) candidates.push(response.topResult);
  for (const item of response.results ?? []) {
    if (!candidates.some((existing) => existing.id === item.id)) {
      candidates.push(item);
    }
  }
  return candidates;
}

/**
 * Find the official music video for a track, or `null` when the song has no
 * music video in the search results. Uses the track's own videoId directly
 * when the active track already IS a music video.
 *
 * Results are cached per track for the session, so the watch page (which
 * mounts after the Now Playing button confirmed the MV) skips the duplicate
 * search and starts the download immediately.
 */
export async function findMusicVideoForTrack(
  track: Pick<MediaTrack, "title" | "artist" | "videoId" | "kind"> & {
    id?: string;
    source?: MediaTrack["source"];
    resolvedVideoId?: string | null;
  },
): Promise<MusicVideoMatch | null> {
  const title = track.title?.trim();
  const artist = track.artist?.trim();
  if (!title || !artist) return null;

  // The active track is already a music video (e.g. queued from a playlist
  // panel row) — no search needed, its videoId IS the video.
  if (track.kind === "video" && track.videoId) {
    return { videoId: track.videoId, title, artist };
  }

  const cacheKey = finderCacheKey(
    track as Pick<
      MediaTrack,
      "id" | "videoId" | "resolvedVideoId" | "source" | "title" | "artist"
    >,
  );
  if (cacheKey && finderCache.has(cacheKey)) {
    return finderCache.get(cacheKey) ?? null;
  }

  const response = await searchMusic(`${title} ${artist}`);
  const candidates = collectSearchCandidates(response);

  let best: SearchItem | null = null;
  let bestScore = -1;
  for (const [index, item] of candidates.entries()) {
    if (!item.videoId) continue;
    // Only music-video rows are acceptable: a studio-song row that matches
    // (usually the top result) means no MV surfaced, and showing the audio
    // upload as "the music video" would be wrong.
    if (item.kind !== "video") continue;
    if (!candidateMatchesSong(track, item)) continue;
    const score = candidateScore(track, item, index);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  const result: MusicVideoMatch | null = !best?.videoId
    ? null
    : {
        videoId: best.videoId,
        title: best.title,
        artist: getSearchItemArtist(best),
        cover: best.cover ?? null,
        durationSeconds: best.durationSeconds ?? null,
      };

  if (cacheKey) {
    if (finderCache.size >= FINDER_CACHE_MAX) {
      const oldest = finderCache.keys().next().value;
      if (oldest !== undefined) finderCache.delete(oldest);
    }
    finderCache.set(cacheKey, result);
  }
  return result;
}
