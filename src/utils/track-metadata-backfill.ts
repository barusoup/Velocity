import { getEntityDetail, getTrackDuration, resolveTrackAlbum, searchMusic } from "../api";
import type { MediaTrack, SearchItem } from "../types";
import { isPlaceholderAlbumName } from "./upload-enrichment";

export type TrackMetadataUpdates = {
  durationSeconds?: number;
  playCount?: string | null;
  album?: string | null;
  albumBrowseId?: string | null;
};

export async function resolveTrackMetadata(
  track: MediaTrack,
  options?: { needsDuration?: boolean; needsPlayCount?: boolean },
): Promise<TrackMetadataUpdates | null> {
  const needsDuration = options?.needsDuration ?? track.durationSeconds == null;
  const needsPlayCount = options?.needsPlayCount ?? track.playCount == null;
  if (!track.videoId || (!needsDuration && !needsPlayCount)) return null;

  let duration: number | null = track.durationSeconds ?? null;
  let playCount: string | null = track.playCount ?? null;

  if (needsDuration) {
    duration = await getTrackDuration(track.videoId);
  }

  if ((duration == null && needsDuration) || (playCount == null && needsPlayCount)) {
    if (track.albumBrowseId) {
      const entity = await getEntityDetail(track.albumBrowseId);
      const match = entity.tracks.find(
        (candidate) => candidate.title === track.title && candidate.artist === track.artist,
      );
      if (match) {
        if (duration == null) duration = match.durationSeconds ?? null;
        if (playCount == null) playCount = match.playCount ?? null;
      }
    }
  }

  if ((duration == null && needsDuration) || (playCount == null && needsPlayCount)) {
    if (track.title) {
      const query = [track.title, track.artist].filter(Boolean).join(" ");
      if (query) {
        const response = await searchMusic(query);
        const items = [response.topResult, ...response.results].filter(Boolean) as SearchItem[];
        const match = items.find(
          (item) => item.kind === "song" && item.videoId === track.videoId,
        ) ?? items.find(
          (item) => item.kind === "song" && item.title === track.title && item.artist === track.artist,
        );
        if (match) {
          if (duration == null && match.durationSeconds != null) {
            duration = match.durationSeconds;
          }
          if (playCount == null) playCount = match.playCount ?? null;
        }
      }
    }
  }

  const updates: TrackMetadataUpdates = {};
  if (needsDuration && duration != null) updates.durationSeconds = duration;
  if (needsPlayCount && playCount != null) updates.playCount = playCount;
  return Object.keys(updates).length > 0 ? updates : null;
}

export async function resolveTrackAlbumMetadata(
  track: MediaTrack,
): Promise<Pick<TrackMetadataUpdates, "album" | "albumBrowseId"> | null> {
  if (!track.videoId) return null;

  const needsAlbum = isPlaceholderAlbumName(track.album);
  const needsBrowseId = !track.albumBrowseId?.trim();
  if (!needsAlbum && !needsBrowseId) return null;

  try {
    const resolution = await resolveTrackAlbum(track.videoId);
    const updates: Pick<TrackMetadataUpdates, "album" | "albumBrowseId"> = {};
    if (needsAlbum && resolution.album?.trim()) {
      updates.album = resolution.album.trim();
    }
    if (needsBrowseId && resolution.albumBrowseId?.trim()) {
      updates.albumBrowseId = resolution.albumBrowseId.trim();
    }
    return Object.keys(updates).length > 0 ? updates : null;
  } catch {
    return null;
  }
}

export function mergeTrackMetadata(track: MediaTrack, updates: TrackMetadataUpdates): MediaTrack {
  return {
    ...track,
    ...(updates.durationSeconds != null ? { durationSeconds: updates.durationSeconds } : {}),
    ...(updates.playCount != null ? { playCount: updates.playCount } : {}),
    ...(updates.album != null ? { album: updates.album } : {}),
    ...(updates.albumBrowseId != null ? { albumBrowseId: updates.albumBrowseId } : {}),
  };
}

export function mergeTrackListMetadata(
  tracks: MediaTrack[],
  trackId: string,
  updates: TrackMetadataUpdates,
): MediaTrack[] {
  return tracks.map((track) =>
    track.id === trackId ? mergeTrackMetadata(track, updates) : track,
  );
}