import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MediaTrack, SearchItem } from "./types";
import { getSyncedLyricsForTrack, saveOffline, removeOffline } from "./api";
import { getEntityDetail } from "./api";
import { getSetting } from "./settings";
import { getItem, setItem } from "./storage";
import { resolveStreamTrackAudio, songMetadataFromMatch } from "./utils/song-resolution";
import {
  savedEntryMatchesTrack,
  savedSongMatches,
} from "./utils/saved-collection-match";
import { useCollectionStore } from "./store/collectionStore";
import {
  mergeTrackListMetadataBatch,
  type TrackMetadataUpdates,
} from "./utils/track-metadata-backfill";
import { getSearchItemArtist } from "./utils/search";

// ---------------------------------------------------------------------------
// Saved-collection state
// ---------------------------------------------------------------------------

export type SavedAlbum = {
  browseId: string;
  title: string;
  subtitle: string;
  cover?: string | null;
  byline?: string | null;
  year?: string | null;
  artistBrowseId?: string | null;
};

export type SavedArtist = {
  browseId: string;
  title: string;
  cover?: string | null;
  banner?: string | null;
  monthlyListeners?: string | null;
};

const SAVED_SONGS_KEY = "velocity-saved-songs";
const SAVED_ALBUMS_KEY = "velocity-saved-albums";
const SAVED_ARTISTS_KEY = "velocity-saved-artists";

function readStoredArray<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function persistArray<T>(key: string, value: T[]): void {
  try {
    setItem(key, JSON.stringify(value));
  } catch {
    // Out of quota or storage disabled — silently keep the in-memory snapshot.
  }
}

type SavedSongInput =
  | MediaTrack
  | (Pick<MediaTrack, "title" | "artist"> &
      Partial<Omit<MediaTrack, "title" | "artist" | "id" | "source">> & {
        id: string;
        source?: "stream";
      })
  | SearchItem;

function coerceSavedSong(input: SavedSongInput): MediaTrack {
  if ("source" in input && (input.source === "stream" || input.source === "upload")) {
    return input as MediaTrack;
  }
  const item = input as SearchItem;
  const id = item.albumBrowseId
    ? `yt:${item.videoId ?? ""}:${item.albumBrowseId}`
    : `yt:${item.videoId ?? ""}`;
  return {
    id,
    title: item.title,
    artist: getSearchItemArtist(item),
    album: item.album ?? null,
    albumBrowseId: item.albumBrowseId ?? null,
    artistBrowseId: item.artistBrowseId ?? null,
    artistCredits: item.artistCredits ?? null,
    durationSeconds: item.durationSeconds ?? null,
    playCount: item.playCount ?? null,
    cover: item.cover ?? null,
    videoId: item.videoId ?? null,
    source: "stream",
    filePath: null,
  };
}

export type SavedSongMetadataUpdates = Partial<
  Pick<
    MediaTrack,
    | "durationSeconds"
    | "playCount"
    | "resolvedVideoId"
    | "kind"
    | "title"
    | "artist"
    | "album"
    | "albumBrowseId"
    | "artistBrowseId"
    | "artistCredits"
    | "cover"
  >
>;

export function scheduleOfflineSyncForTrack(
  track: MediaTrack,
  updateSongMetadata?: (trackId: string, updates: SavedSongMetadataUpdates) => void,
): void {
  if (track.source !== "stream" || !track.videoId) return;

  void (async () => {
    let downloadId = track.resolvedVideoId ?? track.videoId!;
    const metadataUpdates: SavedSongMetadataUpdates = {};

    try {
      const resolved = await resolveStreamTrackAudio(track);
      if (resolved) {
        if (resolved.resolvedVideoId && resolved.resolvedVideoId !== track.videoId) {
          downloadId = resolved.resolvedVideoId;
          metadataUpdates.resolvedVideoId = resolved.resolvedVideoId;
        }
        if (track.kind === "video" && resolved.kind && resolved.kind !== "video") {
          metadataUpdates.kind = resolved.kind;
        }
        const enriched = songMetadataFromMatch(resolved);
        if (!track.albumBrowseId && enriched.albumBrowseId) {
          Object.assign(metadataUpdates, enriched);
        }
      }
    } catch {
      // Fall back to the saved videoId.
    }

    if (updateSongMetadata && Object.keys(metadataUpdates).length > 0) {
      updateSongMetadata(track.id, metadataUpdates);
    }

    await saveOffline(downloadId);

    const lyricsTrack: MediaTrack = {
      ...track,
      ...metadataUpdates,
      resolvedVideoId: metadataUpdates.resolvedVideoId ?? track.resolvedVideoId ?? null,
    };
    await getSyncedLyricsForTrack(lyricsTrack, { persist: true });
  })().catch(() => {});
}

export type CollectionData = {
  savedSongs: MediaTrack[];
  savedAlbums: SavedAlbum[];
  savedArtists: SavedArtist[];
};

export type CollectionActions = {
  isTrackSaved: (track: Pick<MediaTrack, "id" | "videoId">) => boolean;
  isSongSaved: (trackId: string, videoId?: string | null) => boolean;
  isSongSavedByVideo: (videoId: string) => boolean;
  isAlbumSaved: (browseId: string) => boolean;
  isArtistSaved: (browseId: string) => boolean;
  toggleSong: (track: SavedSongInput) => boolean;
  toggleAlbum: (album: SavedAlbum) => boolean;
  toggleArtist: (artist: SavedArtist) => boolean;
  updateSongMetadata: (trackId: string, updates: SavedSongMetadataUpdates) => void;
  updateSongsMetadataBatch: (
    updatesById: ReadonlyMap<string, SavedSongMetadataUpdates>,
  ) => void;
};

type CollectionContextValue = CollectionData & CollectionActions;

const collectionDataContextSlot = globalThis as {
  __VelocityCollectionDataContext?: ReturnType<typeof createContext<CollectionData | null>>;
};
const collectionActionsContextSlot = globalThis as {
  __VelocityCollectionActionsContext?: ReturnType<typeof createContext<CollectionActions | null>>;
};
const CollectionDataContext = (collectionDataContextSlot.__VelocityCollectionDataContext ??=
  createContext<CollectionData | null>(null));
const CollectionActionsContext = (collectionActionsContextSlot.__VelocityCollectionActionsContext ??=
  createContext<CollectionActions | null>(null));

export function CollectionProvider({ children }: { children: ReactNode }) {
  const [savedSongs, setSavedSongs] = useState<MediaTrack[]>(() =>
    readStoredArray<MediaTrack>(SAVED_SONGS_KEY, []).filter(
      (entry) => entry.source !== "upload",
    ),
  );
  const [savedAlbums, setSavedAlbums] = useState<SavedAlbum[]>(() =>
    readStoredArray<SavedAlbum>(SAVED_ALBUMS_KEY, []),
  );
  const [savedArtists, setSavedArtists] = useState<SavedArtist[]>(() =>
    readStoredArray<SavedArtist>(SAVED_ARTISTS_KEY, []),
  );

  useEffect(() => {
    persistArray(SAVED_SONGS_KEY, savedSongs);
  }, [savedSongs]);
  useEffect(() => {
    persistArray(SAVED_ALBUMS_KEY, savedAlbums);
  }, [savedAlbums]);
  useEffect(() => {
    persistArray(SAVED_ARTISTS_KEY, savedArtists);
  }, [savedArtists]);

  useEffect(() => {
    useCollectionStore.getState().syncSnapshot({ savedSongs, savedAlbums, savedArtists });
  }, [savedSongs, savedAlbums, savedArtists]);

  const isSongSaved = useCallback(
    (trackId: string, videoId?: string | null) =>
      savedSongMatches(savedSongs, trackId, videoId),
    [savedSongs],
  );
  const isTrackSaved = useCallback(
    (track: Pick<MediaTrack, "id" | "videoId">) =>
      savedSongMatches(savedSongs, track.id, track.videoId),
    [savedSongs],
  );
  const isSongSavedByVideo = useCallback(
    (videoId: string) => savedSongMatches(savedSongs, "", videoId),
    [savedSongs],
  );
  const isAlbumSaved = useCallback(
    (browseId: string) => savedAlbums.some((entry) => entry.browseId === browseId),
    [savedAlbums],
  );
  const isArtistSaved = useCallback(
    (browseId: string) => savedArtists.some((entry) => entry.browseId === browseId),
    [savedArtists],
  );

  const updateSongMetadata = useCallback(
    (trackId: string, updates: SavedSongMetadataUpdates) => {
      setSavedSongs((current) =>
        current.map((entry) =>
          entry.id === trackId ? { ...entry, ...updates } : entry,
        ),
      );
    },
    [],
  );

  const updateSongsMetadataBatch = useCallback(
    (updatesById: ReadonlyMap<string, TrackMetadataUpdates>) => {
      if (updatesById.size === 0) return;
      setSavedSongs((current) => mergeTrackListMetadataBatch(current, updatesById));
    },
    [],
  );

  const toggleSong = useCallback((track: SavedSongInput): boolean => {
    const coerced = coerceSavedSong(track);
    if (coerced.source === "upload") return false;

    const isSaved = savedSongMatches(savedSongs, coerced.id, coerced.videoId);
    const byVideo = coerced.videoId
      ? savedSongs.some((entry) => entry.videoId === coerced.videoId && entry.id !== coerced.id)
      : false;
    const existingEntry = isSaved
      ? savedSongs.find((entry) => savedEntryMatchesTrack(entry, coerced.id, coerced.videoId))
      : undefined;

    setSavedSongs((current) => {
      if (isSaved) {
        return current.filter(
          (entry) => !savedEntryMatchesTrack(entry, coerced.id, coerced.videoId),
        );
      }
      const filtered = coerced.videoId
        ? current.filter((entry) => entry.id !== coerced.id && entry.videoId !== coerced.videoId)
        : current.filter((entry) => entry.id !== coerced.id);
      return [coerced, ...filtered];
    });

    if (coerced.source === "stream" && coerced.videoId) {
      if (isSaved) {
        const offlineIds = new Set(
          [coerced.videoId, existingEntry?.resolvedVideoId].filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        );
        for (const id of offlineIds) {
          removeOffline(id).catch(() => {});
        }
      } else if (!byVideo && getSetting("offlineSync")) {
        scheduleOfflineSyncForTrack(coerced, updateSongMetadata);
      }
    }

    return !isSaved;
  }, [savedSongs, updateSongMetadata]);

  const toggleAlbum = useCallback((album: SavedAlbum): boolean => {
    const isSaved = savedAlbums.some((entry) => entry.browseId === album.browseId);

    setSavedAlbums((current) => {
      if (isSaved) {
        return current.filter((entry) => entry.browseId !== album.browseId);
      }
      return [album, ...current];
    });

    if (isSaved) {
      getEntityDetail(album.browseId)
        .then((detail) => {
          if (detail.kind === "album") {
            for (const track of detail.tracks) {
              if (track.videoId) {
                removeOffline(track.videoId).catch(() => {});
              }
            }
          }
        })
        .catch(() => {});
    } else if (getSetting("offlineSync")) {
      getEntityDetail(album.browseId)
        .then((detail) => {
          if (detail.kind === "album") {
            for (const track of detail.tracks) {
              if (track.source === "stream" && track.videoId) {
                scheduleOfflineSyncForTrack(track);
              }
            }
          }
        })
        .catch(() => {});
    }

    return !isSaved;
  }, [savedAlbums]);

  const toggleArtist = useCallback((artist: SavedArtist): boolean => {
    const isSaved = savedArtists.some((entry) => entry.browseId === artist.browseId);

    setSavedArtists((current) => {
      if (isSaved) {
        return current.filter((entry) => entry.browseId !== artist.browseId);
      }
      return [artist, ...current];
    });

    return !isSaved;
  }, [savedArtists]);

  const dataValue = useMemo<CollectionData>(
    () => ({ savedSongs, savedAlbums, savedArtists }),
    [savedSongs, savedAlbums, savedArtists],
  );

  const actionsValue = useMemo<CollectionActions>(
    () => ({
      isTrackSaved,
      isSongSaved,
      isSongSavedByVideo,
      isAlbumSaved,
      isArtistSaved,
      toggleSong,
      toggleAlbum,
      toggleArtist,
      updateSongMetadata,
      updateSongsMetadataBatch,
    }),
    [
      isTrackSaved,
      isSongSaved,
      isSongSavedByVideo,
      isAlbumSaved,
      isArtistSaved,
      toggleSong,
      toggleAlbum,
      toggleArtist,
      updateSongMetadata,
      updateSongsMetadataBatch,
    ],
  );

  return (
    <CollectionActionsContext.Provider value={actionsValue}>
      <CollectionDataContext.Provider value={dataValue}>
        {children}
      </CollectionDataContext.Provider>
    </CollectionActionsContext.Provider>
  );
}

export function useCollectionData(): CollectionData {
  const ctx = useContext(CollectionDataContext);
  if (!ctx) throw new Error("useCollectionData must be used within CollectionProvider");
  return ctx;
}

export function useCollectionActions(): CollectionActions {
  const ctx = useContext(CollectionActionsContext);
  if (!ctx) throw new Error("useCollectionActions must be used within CollectionProvider");
  return ctx;
}

export function useCollection(): CollectionContextValue {
  const data = useCollectionData();
  const actions = useCollectionActions();
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
}