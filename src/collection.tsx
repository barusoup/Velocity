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
import {
  cacheSavedAlbumDetail,
  getEntityDetail,
  listOfflineSongs,
  removeCachedSavedAlbumDetail,
  removeOffline,
} from "./api";
import { getSetting } from "./settings";
import { getItem, setItem } from "./storage";
import {
  savedEntryMatchesTrack,
  savedSongMatches,
} from "./utils/saved-collection-match";
import { useCollectionStore } from "./store/collectionStore";
import { useOfflineStatusStore, type OfflineStatus } from "./store/offlineStatusStore";
import {
  mergeTrackListMetadataBatch,
  type TrackMetadataUpdates,
} from "./utils/track-metadata-backfill";
import { getSearchItemArtist } from "./utils/search";
import { streamIdentityVideoIds } from "./utils/media";
import {
  cancelOfflineSyncForVideoIds,
  enqueueOfflineSync,
  enqueueOfflineSyncForSavedSongs,
  type OfflineSyncMetadataUpdates,
} from "./utils/offline-download-queue";

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

export type SavedSongMetadataUpdates = OfflineSyncMetadataUpdates;

/**
 * Enqueue an offline download for a track. Downloads run through a single
 * bounded queue (see `utils/offline-download-queue.ts`), so saving a whole
 * album no longer fires every track's yt-dlp download at once — the queue
 * keeps the API from being rate-limited and retries failures silently.
 */
export function scheduleOfflineSyncForTrack(
  track: MediaTrack,
  updateSongMetadata?: (trackId: string, updates: SavedSongMetadataUpdates) => void,
): void {
  enqueueOfflineSync(track, updateSongMetadata);
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
  /** Quietly enqueue downloads for every saved song missing a local file. */
  resyncOfflineDownloads: () => void;
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
    const id = setTimeout(() => persistArray(SAVED_SONGS_KEY, savedSongs), 120);
    return () => clearTimeout(id);
  }, [savedSongs]);
  useEffect(() => {
    const id = setTimeout(() => persistArray(SAVED_ALBUMS_KEY, savedAlbums), 120);
    return () => clearTimeout(id);
  }, [savedAlbums]);
  useEffect(() => {
    const id = setTimeout(() => persistArray(SAVED_ARTISTS_KEY, savedArtists), 120);
    return () => clearTimeout(id);
  }, [savedArtists]);

  useEffect(() => {
    useCollectionStore.getState().syncSnapshot({ savedSongs, savedAlbums, savedArtists });
  }, [savedSongs, savedAlbums, savedArtists]);

  // Seed the offline-status store from the files that actually exist on
  // disk, then — when offline sync is enabled — quietly enqueue downloads
  // for every saved song that is missing its local file. This is what makes
  // a song that failed to download (or was saved while offline sync was
  // off) get its file with zero manual effort; the bounded queue keeps the
  // resulting download trickle from hammering the API. Best-effort: if the
  // backend is unreachable the store just starts empty and the sweep is a
  // no-op until the next save.
  useEffect(() => {
    let cancelled = false;
    void listOfflineSongs()
      .then((ids) => {
        if (cancelled) return;
        const statuses: Record<string, OfflineStatus> = {};
        for (const id of ids) {
          statuses[id] = "downloaded";
        }
        useOfflineStatusStore.getState().setStatuses(statuses);
        if (getSetting("offlineSync")) {
          enqueueOfflineSyncForSavedSongs(savedSongs, updateSongMetadata);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const resyncOfflineDownloads = useCallback(() => {
    if (!getSetting("offlineSync")) return;
    enqueueOfflineSyncForSavedSongs(savedSongs, updateSongMetadata);
  }, [savedSongs, updateSongMetadata]);

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
          useOfflineStatusStore.getState().clear(id);
        }
        // Drop queued / retry-pending downloads so an in-flight job can't
        // re-create the file after the user unsaved the song.
        cancelOfflineSyncForVideoIds([...offlineIds]);
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
      // Fetch (falling back to the disk cache) BEFORE dropping the cache
      // key, so an offline unsave can still enumerate the album's tracks
      // and remove their files. On success clear the registry + statuses
      // and delete the cached copy.
      getEntityDetail(album.browseId)
        .then((detail) => {
          removeCachedSavedAlbumDetail(album.browseId);
          useOfflineStatusStore.getState().clearAlbum(album.browseId);
          if (detail.kind === "album") {
            const removedIds: string[] = [];
            for (const track of detail.tracks) {
              for (const id of streamIdentityVideoIds(track)) {
                removeOffline(id).catch(() => {});
                useOfflineStatusStore.getState().clear(id);
                removedIds.push(id);
              }
            }
            cancelOfflineSyncForVideoIds(removedIds);
          }
        })
        .catch(() => {
          // No detail available (offline and nothing cached) — still drop
          // the album registry + cached copy so the collection state is
          // consistent even though orphaned files may remain.
          removeCachedSavedAlbumDetail(album.browseId);
          useOfflineStatusStore.getState().clearAlbum(album.browseId);
        });
    } else {
      getEntityDetail(album.browseId)
        .then((detail) => {
          if (detail.kind !== "album") return;
          // Mirror the track list locally so the saved album opens offline
          // (EntityPage falls back to this copy) and the grid shows a
          // "N of M offline" pill. Written regardless of the offlineSync
          // setting so a saved album is never network-gated.
          cacheSavedAlbumDetail(album.browseId, detail);
          const videoIds = detail.tracks
            .map((track) => track.videoId)
            .filter((id): id is string => typeof id === "string" && id.length > 0);
          useOfflineStatusStore.getState().setAlbumTrackVideoIds(album.browseId, videoIds);
          if (!getSetting("offlineSync")) return;
          for (const track of detail.tracks) {
            if (track.source === "stream" && track.videoId) {
              scheduleOfflineSyncForTrack(track);
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
      resyncOfflineDownloads,
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
      resyncOfflineDownloads,
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
