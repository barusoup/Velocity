import { useCallback } from "react";
import type { SavedAlbum, SavedArtist } from "../collection";
import { useCollectionActions } from "../collection";
import type { MediaTrack } from "../types";
import {
  selectIsAlbumSaved,
  selectIsArtistSaved,
  selectIsTrackSaved,
  useCollectionStore,
} from "../store/collectionStore";

/** Re-renders only when this track's saved state changes. */
export function useIsTrackSaved(track: Pick<MediaTrack, "id" | "videoId">): boolean {
  return useCollectionStore(
    (state) => selectIsTrackSaved(state, track),
  );
}

/** Re-renders only when this track id/videoId pair's saved state changes. */
export function useIsSongSaved(trackId: string, videoId?: string | null): boolean {
  return useCollectionStore(
    (state) => selectIsTrackSaved(state, { id: trackId, videoId: videoId ?? null }),
  );
}

/** Re-renders only when this video id's saved state changes. */
export function useIsSongSavedByVideo(videoId: string | null | undefined): boolean {
  const id = videoId ?? "";
  return useCollectionStore(
    (state) => (id ? state.songLookup.videoIds.has(id) : false),
  );
}

/** Re-renders only when this album's saved state changes. */
export function useIsAlbumSaved(browseId: string | null | undefined): boolean {
  const id = browseId ?? "";
  return useCollectionStore(
    (state) => (id ? selectIsAlbumSaved(state, id) : false),
  );
}

/** Re-renders only when this artist's saved state changes. */
export function useIsArtistSaved(browseId: string | null | undefined): boolean {
  const id = browseId ?? "";
  return useCollectionStore(
    (state) => (id ? selectIsArtistSaved(state, id) : false),
  );
}

/** Stable toggle callback for a specific track row. */
export function useToggleTrackSave(track: MediaTrack) {
  const { toggleSong } = useCollectionActions();
  return useCallback(() => {
    toggleSong(track);
  }, [toggleSong, track]);
}

/** Stable toggle callback for a specific album. */
export function useToggleAlbumSave(album: SavedAlbum) {
  const { toggleAlbum } = useCollectionActions();
  return useCallback(() => {
    toggleAlbum(album);
  }, [toggleAlbum, album]);
}

/** Stable toggle callback for a specific artist. */
export function useToggleArtistSave(artist: SavedArtist) {
  const { toggleArtist } = useCollectionActions();
  return useCallback(() => {
    toggleArtist(artist);
  }, [toggleArtist, artist]);
}
