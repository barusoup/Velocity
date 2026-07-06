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

// ---------------------------------------------------------------------------
// Saved-collection state
// ---------------------------------------------------------------------------
//
// `savedSongs` and `savedAlbums` mirror what's stored in the user's
// Collections page. They live in localStorage so they survive restarts; the
// Shape mirrors `MediaTrack` (for songs, we keep enough metadata to render the
// row + reopen the source page) and a trimmed `SavedAlbum` shape for albums
// since storing a full track list per saved album would balloon storage and
// go stale. Album detail data is re-fetched via `getEntityDetail` when the
// user opens a saved album page.

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

// ---------------------------------------------------------------------------
// Minimal song shape we accept as "saved". The full MediaTrack is fine; we
// also produce this shape from SearchItems (right-click → Save to Collection
// on a search row) so we don't drag in extra fields the caller doesn't care
// about. Reading the entry back merges it onto an empty MediaTrack so the
// queue / player APIs don't reject it for missing fields.
//
// Note: locally uploaded tracks (`source === "upload"`) are NOT accepted
// here. The toggle boundary below rejects them so we never persist a
// upload into the saved-songs list. The caller-side `track.source` check
// should hide the affordance, but this guard is the actual policy.
// ---------------------------------------------------------------------------

type SavedSongInput =
  | MediaTrack
  | (Pick<MediaTrack, "title" | "artist"> &
      Partial<Omit<MediaTrack, "title" | "artist" | "id" | "source">> & {
        id: string;
        source?: "stream";
      })
  | SearchItem;

function coerceSavedSong(input: SavedSongInput): MediaTrack {
  // If it's already a real MediaTrack with a recognized source, return
  // as-is. The upload branch is exposed here only so types line up; the
  // `toggleSong` boundary below refuses to actually persist it.
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
    artist: item.artist ?? "Unknown artist",
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

// Stream tracks use `yt:<videoId>` or `yt:<videoId>:<albumBrowseId>` ids.
// `toggleSong` dedupes saves by `videoId`, but callers were checking only
// exact `id` equality — so the same song looked saved on an album row
// (`yt:vid:album`) and unsaved in search / the player bar (`yt:vid`).
function streamVideoIdFromTrackId(trackId: string): string | null {
  if (!trackId.startsWith("yt:")) return null;
  const payload = trackId.slice(3);
  if (!payload) return null;
  const sep = payload.indexOf(":");
  return sep === -1 ? payload : payload.slice(0, sep);
}

function savedEntryMatchesTrack(
  entry: MediaTrack,
  trackId: string,
  videoId?: string | null,
): boolean {
  const vid = videoId ?? streamVideoIdFromTrackId(trackId);
  return (
    entry.id === trackId ||
    (vid != null && vid !== "" && entry.videoId === vid)
  );
}

function savedSongMatches(
  savedSongs: MediaTrack[],
  trackId: string,
  videoId?: string | null,
): boolean {
  return savedSongs.some((entry) => savedEntryMatchesTrack(entry, trackId, videoId));
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

/**
 * Resolve the canonical audio upload, download it for offline playback, and
 * persist synced lyrics when available. Failures for one track never reject
 * the caller.
 */
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

type CollectionContextValue = {
  savedSongs: MediaTrack[];
  savedAlbums: SavedAlbum[];
  savedArtists: SavedArtist[];
  isTrackSaved: (track: Pick<MediaTrack, "id" | "videoId">) => boolean;
  isSongSaved: (trackId: string, videoId?: string | null) => boolean;
  isSongSavedByVideo: (videoId: string) => boolean;
  isAlbumSaved: (browseId: string) => boolean;
  isArtistSaved: (browseId: string) => boolean;
  toggleSong: (track: SavedSongInput) => boolean;
  toggleAlbum: (album: SavedAlbum) => boolean;
  toggleArtist: (artist: SavedArtist) => boolean;
  updateSongMetadata: (trackId: string, updates: SavedSongMetadataUpdates) => void;
};

const CollectionContext = createContext<CollectionContextValue | null>(null);

export function CollectionProvider({ children }: { children: ReactNode }) {
  const [savedSongs, setSavedSongs] = useState<MediaTrack[]>(() =>
    // Drop any upload entries from legacy state so previously-saved
    // uploaded tracks don't linger in the saved-songs list. Upload
    // tracks aren't an officially supported save target, so we silently
    // evict them on load rather than migrating them.
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

  // Mirror changes to localStorage. The loads are best-effort and we delay
  // the first write until at least one render has settled so a malformed
  // initial value doesn't immediately overwrite a working copy.
  useEffect(() => {
    persistArray(SAVED_SONGS_KEY, savedSongs);
  }, [savedSongs]);
  useEffect(() => {
    persistArray(SAVED_ALBUMS_KEY, savedAlbums);
  }, [savedAlbums]);
  useEffect(() => {
    persistArray(SAVED_ARTISTS_KEY, savedArtists);
  }, [savedArtists]);

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

  const toggleSong = useCallback((track: SavedSongInput): boolean => {
    const coerced = coerceSavedSong(track);
    // Locally uploaded tracks can't be saved to the collection — they live
    // in the Local tab behind the backend library store, and the UI
    // surfaces the Delete option there instead of a Save button. Reject
    // uploads at the boundary so a miswired caller can't persist one.
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

    // Fire async offline download/delete
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

    // Fire async offline operations for album tracks
    if (isSaved) {
      // Unsaving album — remove all tracks locally
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
      // Saving album — download all tracks
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

  const value = useMemo<CollectionContextValue>(
    () => ({
      savedSongs,
      savedAlbums,
      savedArtists,
      isTrackSaved,
      isSongSaved,
      isSongSavedByVideo,
      isAlbumSaved,
      isArtistSaved,
      toggleSong,
      toggleAlbum,
      toggleArtist,
      updateSongMetadata,
    }),
    [savedSongs, savedAlbums, savedArtists, isTrackSaved, isSongSaved, isSongSavedByVideo, isAlbumSaved, isArtistSaved, toggleSong, toggleAlbum, toggleArtist, updateSongMetadata],
  );

  return (
    <CollectionContext.Provider value={value}>
      {children}
    </CollectionContext.Provider>
  );
}

export function useCollection(): CollectionContextValue {
  const ctx = useContext(CollectionContext);
  if (!ctx) throw new Error("useCollection must be used within CollectionProvider");
  return ctx;
}
