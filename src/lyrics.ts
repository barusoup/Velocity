import { getSyncedLyricsByMeta, getSyncedLyricsForTrack, probeLyricsAvailability } from "./api";
import type { LyricsAvailability, MediaTrack, SyncedLyricsResponse, TimedLyricLine, TimedLyricWord } from "./types";

export type SyncedLyrics = SyncedLyricsResponse;
export type SyncedLyricLine = TimedLyricLine;
export type { TimedLyricWord };

// Pass-through for LyricsPage. The `options.persist` flag is what
// gates cross-session localStorage persistence of the active track's
// lyrics at the api.ts layer; LyricsPage always opts in because the
// user is (by definition, it's the lyrics page) on the active track.
export function fetchSyncedLyrics(
  track: Pick<
    MediaTrack,
    | "id"
    | "videoId"
    | "resolvedVideoId"
    | "source"
    | "title"
    | "artist"
    | "album"
    | "durationSeconds"
    | "findLyrics"
  >,
  options?: { persist?: boolean },
): Promise<SyncedLyrics | null> {
  return getSyncedLyricsForTrack(track, options);
}

export function fetchSyncedLyricsByMeta(
  track: Pick<
    MediaTrack,
    "id" | "source" | "findLyrics" | "title" | "artist" | "album" | "durationSeconds"
  >,
): Promise<SyncedLyrics | null> {
  return getSyncedLyricsByMeta(
    {
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSeconds: track.durationSeconds,
    },
    { exhaustionTrack: track },
  );
}

export function probeLyrics(
  track: Pick<
    MediaTrack,
    "title" | "artist" | "album" | "durationSeconds" | "videoId" | "resolvedVideoId" | "source"
  >,
): Promise<LyricsAvailability> {
  const videoId = track.source === "stream" ? (track.resolvedVideoId ?? track.videoId ?? null) : null;
  return probeLyricsAvailability({
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    durationSeconds: track.durationSeconds ?? null,
    videoId,
  });
}

export function lyricsAreEffectivelySame(
  left: SyncedLyrics | null,
  right: SyncedLyrics | null,
): boolean {
  if (!left || !right) return false;
  if (left.lines.length !== right.lines.length) return false;
  // Cheap text-equality gate: if the line texts are identical (modulo
  // whitespace/casing), a provider switch did not change what the user
  // reads — swapping would only flicker and re-center the viewport.
  for (let i = 0; i < left.lines.length; i++) {
    const a = left.lines[i]?.text?.trim().toLowerCase() ?? "";
    const b = right.lines[i]?.text?.trim().toLowerCase() ?? "";
    if (a !== b) return false;
  }
  return true;
}

/**
 * Whether fresh lyrics are worth replacing cached/visible lyrics with.
 * A per-word result is a strict upgrade over plain line-sync. Otherwise,
 * provider switches that only rephrase punctuation should not flicker
 * the viewport. YouTube Music native lyrics never appear here (they are
 * rejected at the accept layer). Clean-provider filtering happens in
 * api.ts; this guard only decides if a visible clean result should be
 * swapped for a fresh clean result mid-viewport.
 *
 * Same-text but timestamp-shifted results (vocal-offset correction)
 * are treated as an upgrade and are allowed to replace, otherwise the
 * Now Playing preview would stay a few seconds behind the Lyrics page
 * when one fetched before the offset was computed and the other after.
 */
export function shouldReplaceLyricsWith(
  visible: SyncedLyrics | null,
  fresh: SyncedLyrics | null,
): boolean {
  if (!fresh || !hasValidLyricSync(fresh.lines)) return false;
  if (!visible) return true;
  // Per-word sync is a strict visual upgrade on the karaoke render path.
  if (fresh.hasPerWordSync === true && visible.hasPerWordSync !== true) return true;
  const sameText = lyricsAreEffectivelySame(visible, fresh);
  if (sameText) {
    // Same text but timestamps shifted => vocal-offset correction.
    // The preview and full page can otherwise diverge by the offset
    // amount (up to 8s) if one fetched before the DSP analysis finished.
    const offsetChanged = (visible.appliedOffsetMs ?? 0) !== (fresh.appliedOffsetMs ?? 0);
    if (offsetChanged) return true;
    const firstVisible = visible.lines[0]?.startTimeMs ?? 0;
    const firstFresh = fresh.lines[0]?.startTimeMs ?? 0;
    if (Math.abs(firstVisible - firstFresh) > 400) return true;
    return false;
  }
  return false;
}

/** Reject lyrics whose timestamps cannot track playback (mirrors backend scoring). */
export function hasValidLyricSync(lines: SyncedLyricLine[]): boolean {
  if (lines.length < 2) return false;

  const uniqueStarts = new Set(lines.map((line) => line.startTimeMs)).size;
  if (uniqueStarts <= 1) return false;
  if (uniqueStarts < lines.length / 3) return false;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].startTimeMs < lines[index - 1].startTimeMs) return false;
  }

  return true;
}

export function findActiveLyricIndex(lines: SyncedLyricLine[], progress: number) {
  const progressMs = progress * 1000;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (progressMs >= lines[index].startTimeMs) return index;
  }

  return -1;
}

export function findActiveWordIndex(words: TimedLyricWord[], progressMs: number) {
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (progressMs >= words[index].startTimeMs) return index;
  }
  return -1;
}
