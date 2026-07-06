import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { SavedAlbum, SavedArtist } from "../collection";
import type { MediaTrack } from "../types";
import {
  buildSavedSongLookup,
  isTrackSavedInLookup,
} from "../utils/saved-collection-match";

type SongLookup = ReturnType<typeof buildSavedSongLookup>;

export interface CollectionSnapshotState {
  songLookup: SongLookup;
  savedAlbumBrowseIds: ReadonlySet<string>;
  savedArtistBrowseIds: ReadonlySet<string>;
}

export interface CollectionSnapshotActions {
  syncSnapshot: (payload: {
    savedSongs: MediaTrack[];
    savedAlbums: SavedAlbum[];
    savedArtists: SavedArtist[];
  }) => void;
}

export type CollectionSnapshotStore = CollectionSnapshotState & CollectionSnapshotActions;

function albumIds(albums: readonly { browseId: string }[]): ReadonlySet<string> {
  return new Set(albums.map((entry) => entry.browseId));
}

function artistIds(artists: readonly { browseId: string }[]): ReadonlySet<string> {
  return new Set(artists.map((entry) => entry.browseId));
}

function snapshotEqual(a: CollectionSnapshotState, b: CollectionSnapshotState): boolean {
  return (
    a.songLookup.entries === b.songLookup.entries &&
    a.songLookup.ids === b.songLookup.ids &&
    a.songLookup.videoIds === b.songLookup.videoIds &&
    a.savedAlbumBrowseIds === b.savedAlbumBrowseIds &&
    a.savedArtistBrowseIds === b.savedArtistBrowseIds
  );
}

const EMPTY_LOOKUP = buildSavedSongLookup([]);

export const useCollectionStore = create<CollectionSnapshotStore>()(
  subscribeWithSelector((set, get) => ({
    songLookup: EMPTY_LOOKUP,
    savedAlbumBrowseIds: new Set<string>(),
    savedArtistBrowseIds: new Set<string>(),
    syncSnapshot: ({ savedSongs, savedAlbums, savedArtists }) => {
      const next: CollectionSnapshotState = {
        songLookup: buildSavedSongLookup(savedSongs),
        savedAlbumBrowseIds: albumIds(savedAlbums),
        savedArtistBrowseIds: artistIds(savedArtists),
      };
      const prev = get();
      if (snapshotEqual(prev, next)) return;
      set(next);
    },
  })),
);

export function selectIsTrackSaved(
  state: CollectionSnapshotState,
  track: Pick<MediaTrack, "id" | "videoId">,
): boolean {
  return isTrackSavedInLookup(state.songLookup, track);
}

export function selectIsAlbumSaved(state: CollectionSnapshotState, browseId: string): boolean {
  return state.savedAlbumBrowseIds.has(browseId);
}

export function selectIsArtistSaved(state: CollectionSnapshotState, browseId: string): boolean {
  return state.savedArtistBrowseIds.has(browseId);
}