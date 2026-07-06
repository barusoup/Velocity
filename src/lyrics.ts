import { getSyncedLyrics, getSyncedLyricsByMeta } from "./api";
import type { SyncedLyricsResponse, TimedLyricLine, TimedLyricWord } from "./types";

export type SyncedLyrics = SyncedLyricsResponse;
export type SyncedLyricLine = TimedLyricLine;
export type { TimedLyricWord };

export function fetchSyncedLyrics(videoId: string): Promise<SyncedLyrics | null> {
  return getSyncedLyrics(videoId);
}

export function fetchSyncedLyricsByMeta(track: {
  title: string;
  artist: string;
  album?: string | null;
  durationSeconds?: number | null;
}): Promise<SyncedLyrics | null> {
  return getSyncedLyricsByMeta(track);
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
