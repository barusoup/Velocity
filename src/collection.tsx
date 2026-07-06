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
import { saveOffline, removeOffline } from "./api";
import { getEntityDetail } from "./api";
import { getSetting } from "./settings";
import { getItem, setItem } from "./storage";

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

const SAVED_SONGS_KEY = "velocity-saved-songs";
const SAVED_ALBUMS_KEY = "velocity-saved-albums";

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

type CollectionContextValue = {
  savedSongs: MediaTrack[];
  savedAlbums: SavedAlbum[];
  isSongSaved: (trackId: string) => boolean;
  isSongSavedByVideo: (videoId: string) => boolean;
  isAlbumSaved: (browseId: string) => boolean;
  toggleSong: (track: SavedSongInput) => boolean;
  toggleAlbum: (album: SavedAlbum) => boolean;
  updateSongMetadata: (
    trackId: string,
    updates: { durationSeconds?: number; playCount?: string | null },
  ) => void;
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

  // Mirror changes to localStorage. The loads are best-effort and we delay
  // the first write until at least one render has settled so a malformed
  // initial value doesn't immediately overwrite a working copy.
  useEffect(() => {
    persistArray(SAVED_SONGS_KEY, savedSongs);
  }, [savedSongs]);
  useEffect(() => {
    persistArray(SAVED_ALBUMS_KEY, savedAlbums);
  }, [savedAlbums]);

  const isSongSaved = useCallback(
    (trackId: string) => savedSongs.some((entry) => entry.id === trackId),
    [savedSongs],
  );
  const isSongSavedByVideo = useCallback(
    (videoId: string) => savedSongs.some((entry) => entry.videoId === videoId),
    [savedSongs],
  );
  const isAlbumSaved = useCallback(
    (browseId: string) => savedAlbums.some((entry) => entry.browseId === browseId),
    [savedAlbums],
  );

  const toggleSong = useCallback((track: SavedSongInput): boolean => {
    const coerced = coerceSavedSong(track);
    // Locally uploaded tracks can't be saved to the collection — they live
    // in the Local tab behind the backend library store, and the UI
    // surfaces the Delete option there instead of a Save button. Reject
    // uploads at the boundary so a miswired caller can't persist one.
    if (coerced.source === "upload") return false;

    const byId = savedSongs.some((entry) => entry.id === coerced.id);
    const byVideo = coerced.videoId
      ? savedSongs.some((entry) => entry.videoId === coerced.videoId && entry.id !== coerced.id)
      : false;

    setSavedSongs((current) => {
      if (byId) {
        return current.filter((entry) => entry.id !== coerced.id);
      }
      const filtered = coerced.videoId
        ? current.filter((entry) => entry.id !== coerced.id && entry.videoId !== coerced.videoId)
        : current.filter((entry) => entry.id !== coerced.id);
      return [coerced, ...filtered];
    });

    // Fire async offline download/delete
    if (coerced.source === "stream" && coerced.videoId) {
      if (byId) {
        // Unsaving — always clean up local file
        removeOffline(coerced.videoId).catch(() => {});
      } else if (!byVideo && getSetting("offlineSync")) {
        // New save (not replacing a videoId-duplicate) — download
        saveOffline(coerced.videoId).catch(() => {});
      }
    }

    return !byId;
  }, [savedSongs]);

  const updateSongMetadata = useCallback(
    (
      trackId: string,
      updates: { durationSeconds?: number; playCount?: string | null },
    ) => {
      setSavedSongs((current) =>
        current.map((entry) =>
          entry.id === trackId ? { ...entry, ...updates } : entry,
        ),
      );
    },
    [],
  );

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
                saveOffline(track.videoId).catch(() => {});
              }
            }
          }
        })
        .catch(() => {});
    }

    return !isSaved;
  }, [savedAlbums]);

  const value = useMemo<CollectionContextValue>(
    () => ({
      savedSongs,
      savedAlbums,
      isSongSaved,
      isSongSavedByVideo,
      isAlbumSaved,
      toggleSong,
      toggleAlbum,
      updateSongMetadata,
    }),
    [savedSongs, savedAlbums, isSongSaved, isSongSavedByVideo, isAlbumSaved, toggleSong, toggleAlbum, updateSongMetadata],
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
