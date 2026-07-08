import { getSyncedLyricsByMeta, getSyncedLyricsForTrack } from "./api";
import type { MediaTrack, SyncedLyricsResponse, TimedLyricLine, TimedLyricWord } from "./types";

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
