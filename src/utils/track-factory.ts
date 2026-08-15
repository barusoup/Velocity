import type { MediaTrack, SearchItem } from "../types";
import { getSearchItemArtist } from "./search";

/**
 * Single source of truth for MediaTrack creation from SearchItem.
 * Previously duplicated in App.tsx:trackFromSearchItem and PagesShared.tsx:toTrack
 * with 90% overlap. Now all code paths use this factory so track ids,
 * albumBrowseId scoping, and artist fallback are consistent.
 */

export function createTrackFromSearchItem(item: SearchItem): MediaTrack | null {
  if (!item.videoId) return null;
  // Only song/video are playable as MediaTrack; album/artist/playlist are navigational.
  // This check mirrors `isPlayable` in PagesShared and prevents non-song SearchItems
  // from being turned into queue entries that would fail on resolve_stream.
  // Factory still allows any SearchItem with videoId to be converted when caller
  // has already validated kind (e.g. SearchPage's toSaveableTrack handles video).
  const id = item.albumBrowseId ? `yt:${item.videoId}:${item.albumBrowseId}` : `yt:${item.videoId}`;
  return {
    id,
    kind: item.kind,
    title: item.title,
    artist: getSearchItemArtist(item),
    album: item.album ?? null,
    albumBrowseId: item.albumBrowseId ?? null,
    artistBrowseId: item.artistBrowseId ?? null,
    artistCredits: item.artistCredits ?? null,
    durationSeconds: item.durationSeconds ?? null,
    playCount: item.playCount ?? null,
    cover: item.cover ?? null,
    videoId: item.videoId,
    source: "stream",
    filePath: null,
  };
}

/**
 * Shared helper for encoding track for context menu data attributes.
 * Strips ephemeral fields that shouldn't leak into JSON.
 */
export function encodeTrackForContextMenu(track: MediaTrack): string {
  const { filePath: _fp, audioSrc: _as, _labelOrigin: _lo, ...rest } = track as unknown as Record<string, unknown>;
  void _fp;
  void _as;
  void _lo;
  return JSON.stringify(rest);
}

/**
 * Re-hydrate a stripped track (from context menu JSON) for playback.
 * Restores filePath/audioSrc via listImportedTracks when needed.
 */
export function isSameTrackIdentity(a: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">, b: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">): boolean {
  if (a.source === "upload" || b.source === "upload") return a.id === b.id;
  const aIds = [a.videoId, a.resolvedVideoId].filter(Boolean) as string[];
  const bIds = [b.videoId, b.resolvedVideoId].filter(Boolean) as string[];
  if (aIds.length === 0 || bIds.length === 0) return a.id === b.id;
  return aIds.some((id) => bIds.includes(id));
}
