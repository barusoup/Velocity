import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MediaTrack } from "./types";
import { getItem, setItem as storeSetItem } from "./storage";

// ---------------------------------------------------------------------------
// User playlists (local-only, not backed by the YTM entity API).
//
// A user playlist is just an ordered list of MediaTrack references plus the
// editor's metadata (title, description, cover, createdAt). The tracks store
// ALL of the fields we need to render a row and to start playback the next
// time the user opens the page — title, artist, duration, videoId/filePath,
// cover, browse ids, artist credits, etc.
// ---------------------------------------------------------------------------
//
// Persistence: we explicitly strip `_labelOrigin` (queue placement metadata
// that has no meaning across restarts) and `audioSrc` / `cover` blob paths
// (those are live `asset://` URLs that the Tauri WebView considers invalid
// on cold launch) before writing to localStorage. The player rehydrates any
// required `asset://` URL with `withResolvedAudioSrc` when the playlist is
// consumed, so on-disk tracks still play normally after a restart.
//
// Cover: base64-encoded JPEG. We use a canvas-downscaled thumb (max 480px,
// quality 0.7) on upload (see `PlaylistCoverButton` in the page component)
// so an average playlist cover lands at 8-30 KB instead of the 1-2 MB a
// raw photo would be — localStorage caps out around 5 MB so leaving covers
// uncompressed would force very few playlists before quota errors started
// silently dropping saves.

export const DESCRIPTION_MAX_LENGTH = 75;
export const PLAYLIST_TITLE_MAX_LENGTH = 18;

export type UserPlaylist = {
  id: string;
  title: string;
  description: string;
  /** Base64 JPEG data URL of the uploaded cover, or null when unset. */
  cover: string | null;
  /** Tracks in play order. */
  tracks: MediaTrack[];
  /** Creation epoch ms — used as the secondary sort key on the sidebar. */
  createdAt: number;
  /**
   * `true` when the user has pinned this playlist in the sidebar. Drives
   * the green pin affordance on the sidebar entry. Optional so older
   * persisted playlists (saved before pinning shipped) load cleanly —
   * the rest of the app treats `undefined` the same as `false`.
   */
  pinned?: boolean;
};

const PLAYLISTS_KEY = "velocity-user-playlists";

function readStoredPlaylists(): UserPlaylist[] {
  try {
    const raw = getItem(PLAYLISTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UserPlaylist[]) : [];
  } catch {
    return [];
  }
}

function persistPlaylists(playlists: UserPlaylist[]): void {
  try {
    // Strip transient fields before writing so a stale `asset://` from a
    // previous session can't be persisted (the URL is invalid on cold
    // launch, and even if the Tauri side still grants access to the
    // underlying file, the player's `withResolvedAudioSrc` rebuilds a
    // working asset URL on demand — storing the in-session value just
    // bloat and an extra failure surface).
    const sanitized = playlists.map((playlist) => ({
      ...playlist,
      tracks: playlist.tracks.map(stripEphemeralTrackFields),
    }));
    storeSetItem(PLAYLISTS_KEY, JSON.stringify(sanitized));
  } catch {
    // Out of quota or storage disabled — silently keep the in-memory snapshot.
  }
}

// Internal: drop fields that are derived live (not part of the track's
// "identity") so the on-disk JSON doesn't carry blob URLs or queue labels
// that would be stale/noisy after a restart.
function stripEphemeralTrackFields(track: MediaTrack): MediaTrack {
  const {
    audioSrc: _audioSrc,
    _labelOrigin: _labelOrigin,
    ...rest
  } = track;
  void _audioSrc;
  void _labelOrigin;
  return rest as MediaTrack;
}

function nextBlankPlaylistName(existing: UserPlaylist[]): string {
  // Defensive: capitalize the first word in the placeholder to match the
  // user's spelled-out expectation ("Blank Playlist #N" not "blank playlist
  // #N"). The collision check is exact-match because the placeholder is
  // the convention — collision is the only way the user would have a same
  // name before renaming.
  const titles = new Set(existing.map((p) => p.title.trim()));
  let i = 1;
  let candidate = `Blank Playlist #${i}`;
  while (titles.has(candidate) || candidate.length > PLAYLIST_TITLE_MAX_LENGTH) {
    i += 1;
    candidate = `Blank Playlist #${i}`;
  }
  return candidate;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    // `randomUUID` is collision-free across the app's lifetime; even
    // without it the time+random fallback below would be good enough for
    // a sidebar UI that never holds more than a handful of entries.
    return crypto.randomUUID();
  }
  return `pl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type SortMode = "createdAt" | "name" | "creator";
export type SortDirection = "asc" | "desc";

type PlaylistsContextValue = {
  playlists: UserPlaylist[];
  sortMode: SortMode;
  sortDirection: SortDirection;
  setSortMode: (mode: SortMode) => void;
  setSortDirection: (direction: SortDirection) => void;
  getPlaylist: (id: string) => UserPlaylist | null;
  createPlaylist: () => UserPlaylist;
  deletePlaylist: (id: string) => void;
  updatePlaylist: (id: string, fields: Partial<UserPlaylist>) => void;
  addTrackToPlaylist: (id: string, track: MediaTrack) => boolean;
  removeTrackFromPlaylist: (id: string, trackId: string) => void;
  togglePlaylistPinned: (id: string) => void;
};

const PlaylistsContext = createContext<PlaylistsContextValue | null>(null);
const SORT_KEY = "velocity-playlists-sort";
const SORT_DIR_KEY = "velocity-playlists-sort-dir";

function readStoredSortMode(): SortMode {
  try {
    const raw = getItem(SORT_KEY);
    if (raw === "name" || raw === "createdAt" || raw === "creator") return raw;
  } catch {
    // fall through to default
  }
  return "createdAt";
}

function readStoredSortDirection(): SortDirection {
  try {
    const raw = getItem(SORT_DIR_KEY);
    if (raw === "asc" || raw === "desc") return raw;
  } catch {
    // fall through to default
  }
  return "desc";
}

export function PlaylistsProvider({ children }: { children: ReactNode }) {
  const [playlists, setPlaylists] = useState<UserPlaylist[]>(() => readStoredPlaylists());
  const [sortMode, setSortModeState] = useState<SortMode>(() => readStoredSortMode());
  const [sortDirection, setSortDirectionState] = useState<SortDirection>(() => readStoredSortDirection());

  // Persist on every change. The first write is gated behind the initial
  // state read so a malformed default value doesn't immediately overwrite
  // a working copy.
  useEffect(() => {
    persistPlaylists(playlists);
  }, [playlists]);

  useEffect(() => {
    try {
      storeSetItem(SORT_KEY, JSON.stringify(sortMode));
    } catch {
      // ignore quota
    }
  }, [sortMode]);

  useEffect(() => {
    try {
      storeSetItem(SORT_DIR_KEY, JSON.stringify(sortDirection));
    } catch {
      // ignore quota
    }
  }, [sortDirection]);

  const getPlaylist = useCallback(
    (id: string) => playlists.find((p) => p.id === id) ?? null,
    [playlists],
  );

  const createPlaylist = useCallback((): UserPlaylist => {
    // Take a snapshot of the current playlist list at call time. Even
    // though `createPlaylist` is recreated whenever playlists change (so
    // the closure already has the latest set), reading once here keeps
    // the placeholder collision check deterministic in the same render
    // that produced the new playlist.
    const current = playlists;
    const newPlaylist: UserPlaylist = {
      id: generateId(),
      title: nextBlankPlaylistName(current),
      description: "",
      cover: null,
      tracks: [],
      createdAt: Date.now(),
      pinned: false,
    };
    // Newest-first so the freshly-created playlist lands at the top of the
    // sidebar (matches "just created" UX expectations). The setState
    // closure wirings are intentional even though we re-render shortly
    // after — the new playlist is fully-formed by the time the navigate()
    // callback fires so the page can read its data on the very first paint.
    setPlaylists((previous) => [newPlaylist, ...previous]);
    return newPlaylist;
  }, [playlists]);

  const deletePlaylist = useCallback((id: string) => {
    setPlaylists((current) => current.filter((p) => p.id !== id));
  }, []);

  const updatePlaylist = useCallback(
    (id: string, fields: Partial<UserPlaylist>) => {
      if (fields.description && fields.description.length > DESCRIPTION_MAX_LENGTH) {
        fields.description = fields.description.slice(0, DESCRIPTION_MAX_LENGTH);
      }
      if (fields.title && fields.title.length > PLAYLIST_TITLE_MAX_LENGTH) {
        fields.title = fields.title.slice(0, PLAYLIST_TITLE_MAX_LENGTH);
      }
      setPlaylists((current) =>
        current.map((p) => (p.id === id ? { ...p, ...fields } : p)),
      );
    },
    [],
  );

  const addTrackToPlaylist = useCallback(
    (id: string, track: MediaTrack): boolean => {
      let inserted = false;
      setPlaylists((current) =>
        current.map((p) => {
          if (p.id !== id) return p;
          // Don't duplicate — inserting the same song twice would be
          // invisible UX (the user couldn't tell their duplicate-add
          // attempt failed). Return a stable reference so React skips
          // the re-render for untouched playlists.
          if (p.tracks.some((t) => t.id === track.id)) return p;
          inserted = true;
          return { ...p, tracks: [...p.tracks, { ...track, dateAdded: Date.now() }] };
        }),
      );
      return inserted;
    },
    [],
  );

  const removeTrackFromPlaylist = useCallback((id: string, trackId: string) => {
    setPlaylists((current) =>
      current.map((p) => {
        if (p.id !== id) return p;
        return { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) };
      }),
    );
  }, []);

  const togglePlaylistPinned = useCallback((id: string) => {
    setPlaylists((current) =>
      current.map((p) => (p.id === id ? { ...p, pinned: !(p.pinned ?? false) } : p)),
    );
  }, []);

  // The sidebar sorts on every render via this memo so the order stays
  // stable across renders unless the underlying list or sort mode changes.
  //
  // Pinned playlists always sort above non-pinned ones (regardless of the
  // active sort mode) — the whole point of pinning is that a playlist
  // surfaces at the top so it's reachable in one click. Within each
  // group the active sort mode + direction still applies, so a user
  // who pins a playlist and then switches to alphabetical still sees
  // their pinned entries alphabetised at the top. We partition first
  // and sort each bucket independently rather than folding pinned into
  // the comparator — folding it in would mean the sort direction of
  // `desc` would flip the pin ordering too, which is the wrong mental
  // model ("descending pinned" doesn't mean anything to a user).
  const sortedPlaylists = useMemo<UserPlaylist[]>(() => {
    const dir = sortDirection === "asc" ? 1 : -1;

    const sortFn = (left: UserPlaylist, right: UserPlaylist): number => {
      if (sortMode === "name" || sortMode === "creator") {
        return (
          dir *
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
        );
      }
      // createdAt — newest first by default, but respect direction.
      const diff = left.createdAt - right.createdAt;
      if (diff !== 0) return dir * diff;
      return left.title.localeCompare(right.title);
    };

    const pinned: UserPlaylist[] = [];
    const unpinned: UserPlaylist[] = [];
    for (const playlist of playlists) {
      if (playlist.pinned ?? false) {
        pinned.push(playlist);
      } else {
        unpinned.push(playlist);
      }
    }
    return [...pinned.sort(sortFn), ...unpinned.sort(sortFn)];
  }, [playlists, sortMode, sortDirection]);

  const value = useMemo<PlaylistsContextValue>(
    () => ({
      playlists: sortedPlaylists,
      sortMode,
      sortDirection,
      setSortMode: setSortModeState,
      setSortDirection: setSortDirectionState,
      getPlaylist,
      createPlaylist,
      deletePlaylist,
      updatePlaylist,
      addTrackToPlaylist,
      removeTrackFromPlaylist,
      togglePlaylistPinned,
    }),
    [
      sortedPlaylists,
      sortMode,
      sortDirection,
      getPlaylist,
      createPlaylist,
      deletePlaylist,
      updatePlaylist,
      addTrackToPlaylist,
      removeTrackFromPlaylist,
      togglePlaylistPinned,
    ],
  );

  return (
    <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>
  );
}

export function usePlaylists(): PlaylistsContextValue {
  const ctx = useContext(PlaylistsContext);
  if (!ctx) throw new Error("usePlaylists must be used within PlaylistsProvider");
  return ctx;
}

// Public helpers — exported so the page component can reuse the same ID
// picker and downgrade rule without re-implementing it.
export { generateId as generatePlaylistId, nextBlankPlaylistName };
