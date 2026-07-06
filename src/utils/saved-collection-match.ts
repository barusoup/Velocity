import type { MediaTrack } from "../types";

/** Extract the YouTube video id embedded in a stream track id (`yt:…`). */
export function streamVideoIdFromTrackId(trackId: string): string | null {
  if (!trackId.startsWith("yt:")) return null;
  const payload = trackId.slice(3);
  if (!payload) return null;
  const sep = payload.indexOf(":");
  return sep === -1 ? payload : payload.slice(0, sep);
}

export function savedEntryMatchesTrack(
  entry: Pick<MediaTrack, "id" | "videoId">,
  trackId: string,
  videoId?: string | null,
): boolean {
  const vid = videoId ?? streamVideoIdFromTrackId(trackId);
  return (
    entry.id === trackId ||
    (vid != null && vid !== "" && entry.videoId === vid)
  );
}

export function savedSongMatches(
  savedSongs: readonly Pick<MediaTrack, "id" | "videoId">[],
  trackId: string,
  videoId?: string | null,
): boolean {
  return savedSongs.some((entry) => savedEntryMatchesTrack(entry, trackId, videoId));
}

export function buildSavedSongLookup(savedSongs: readonly MediaTrack[]): {
  entries: readonly MediaTrack[];
  ids: ReadonlySet<string>;
  videoIds: ReadonlySet<string>;
} {
  const ids = new Set<string>();
  const videoIds = new Set<string>();
  for (const entry of savedSongs) {
    ids.add(entry.id);
    if (entry.videoId) videoIds.add(entry.videoId);
  }
  return { entries: savedSongs, ids, videoIds };
}

export function isTrackSavedInLookup(
  lookup: { ids: ReadonlySet<string>; videoIds: ReadonlySet<string> },
  track: Pick<MediaTrack, "id" | "videoId">,
): boolean {
  if (lookup.ids.has(track.id)) return true;
  if (track.videoId && lookup.videoIds.has(track.videoId)) return true;
  const embedded = streamVideoIdFromTrackId(track.id);
  return embedded != null && embedded !== "" && lookup.videoIds.has(embedded);
}