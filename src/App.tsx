import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  importTracks,
  listImportedTracks,
  removeImportedTrack,
  resolveTrackAlbum,
  updateImportedTrackMetadata,
} from "./api";
import { AccentProvider } from "./accent-context";
import { CollectionProvider } from "./collection";
import { PlaylistsProvider, usePlaylists } from "./playlists";
import { AlbumContextMenu } from "./components/AlbumContextMenu";
import { SongContextMenu, type AddToPlaylistResolver } from "./components/SongContextMenu";
import { ConfirmDialog } from "./components/Shared";
import { LoadingPanel } from "./components/PagesShared";
import { PlayerProvider, usePlayer, type QueueOrigin } from "./player";
import { usePlayerHasTrack } from "./hooks/usePlayerSelectors";
import { useGlobalContextMenus } from "./hooks/useGlobalContextMenus";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useImportedTracksHydration } from "./hooks/useImportedTracksHydration";
import { useScrollRestoration } from "./hooks/useScrollRestoration";
import { useDiscordRichPresence } from "./hooks/useDiscordRichPresence";
import { useStartupMinimized } from "./hooks/useStartupMinimized";
import { useStartupSplash } from "./hooks/useStartupSplash";
import { useViewportHeightTracker } from "./hooks/useViewportHeightTracker";
import type { MediaTrack, SearchItem } from "./types";
import type { SavedAlbum } from "./collection";
import { readDuration, readFileImports, stripQueueMetadata, withResolvedAudioSrc } from "./utils/media";
import {
  displayAlbumName,
  enrichUploadMetadataFromYtm,
  isPlaceholderAlbumName,
} from "./utils/upload-enrichment";
import { getSearchItemArtist } from "./utils/search";
import { cn } from "./utils/cn";
import { getItem, setItem } from "./storage";
import { getSettings, useSetting } from "./settings";
import PlayerBar from "./components/PlayerBar";
import { HomePage } from "./components/HomePage";
import { SearchPage } from "./components/SearchPage";
import { Sidebar, TopBar, isSearchWorkspace, type View } from "./components/Sidebar";
import { useTasteProfileTracking } from "./hooks/useTasteProfileTracking";
import { DEFAULT_SEARCH_FILTERS, type SearchFilters } from "./components/SearchFilters";

declare global {
  interface Window {
    __velocityHideSplash?: () => void;
  }
}

const CollectionPage = lazy(() => import("./components/CollectionPage").then((m) => ({ default: m.CollectionPage })));
const EntityPage = lazy(() => import("./components/EntityPage").then((m) => ({ default: m.EntityPage })));
const ArtistPage = lazy(() => import("./components/ArtistPage").then((m) => ({ default: m.ArtistPage })));
const LyricsPage = lazy(() => import("./components/LyricsPage").then((m) => ({ default: m.LyricsPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const UserPlaylistPage = lazy(() => import("./components/UserPlaylistPage").then((m) => ({ default: m.UserPlaylistPage })));
const UserPlaylistsPage = lazy(() => import("./components/UserPlaylistsPage").then((m) => ({ default: m.UserPlaylistsPage })));

const RECENT_SEARCHES_KEY = "velocity-recent-searches";

type HistoryEntry = {
  view: View;
  scrollTop: number;
};

type HistoryState = {
  entries: HistoryEntry[];
  index: number;
};

function getArtistSection(view: Extract<View, { name: "artist" }>): "overview" | "discography" {
  return view.section ?? "overview";
}

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

function viewsEqual(left: View, right: View): boolean {
  if (left.name !== right.name) return false;
  switch (left.name) {
    case "collection":
      if (right.name !== "collection") return false;
      return left.tab === right.tab;
    case "home":
      return right.name === "home";
    case "search":
      return right.name === "search" && left.query === right.query;
    case "lyrics":
      return true;
    case "settings":
      return true;
    case "album":
    case "artist":
    case "playlist":
      if (
        right.name !== left.name ||
        left.browseId !== right.browseId ||
        left.context !== right.context
      ) {
        return false;
      }
      if (left.name === "artist") {
        // `right` is guaranteed to share `left`'s shape here (discriminant
        // check + fall-through guard), but TypeScript can't propagate that
        // correlation into this nested branch. Narrow-cast so the helper
        // accepts the argument.
        return (
          getArtistSection(left) ===
          getArtistSection(right as Extract<View, { name: "artist" }>)
        );
      }
      return true;
    case "user-playlist":
      return right.name === "user-playlist" && left.id === right.id;
    case "user-playlists":
      return right.name === "user-playlists";
    default:
      return false;
  }
}

function getViewAnimationKey(view: View): string {
  switch (view.name) {
    case "home":
      return "home";
    case "collection":
      return "collection";
    case "search":
      return `search:${view.query}`;
    case "lyrics":
      return "lyrics";
    case "album":
    case "artist":
    case "playlist":
      return `${view.name}:${view.browseId}:${view.context}`;
    case "user-playlist":
      // Stable key across every user-playlist. Earlier revisions keyed on
      // `view.id` to fresh-mount `<UserPlaylistPage>` on each navigation,
      // but the new mount played `.page-content`'s `page-enter` opacity
      // 0→1 fade — and during that fade the body's `#000000` showed through
      // the hero's transparent first paint, producing the "flashes black"
      // transition between two banner colors. Reusing the same DOM lets
      // the existing `useArtworkAccent` hook re-derive the accent from the
      // new `cover`/`resetKey`, the reset-state `useEffect` keyed on
      // `playlistId` still fires on prop change, and scroll restoration
      // still runs because `historyState.index` changes on navigation.
      // The fade-in animation only plays on the first transition INTO a
      // user-playlist (e.g. from search), which is the right behavior.
      return "user-playlist";
    case "user-playlists":
      return "user-playlists";
    default:
      return view.name;
  }
}

// Single source of truth for pushing a page onto the back/forward stack.
// If the next view matches the currently active one, we drop the push so the
// history doesn't pile up duplicate entries when navigation is triggered more
// than once for the same destination (e.g. a rapid double-click).
function pushHistoryEntry(
  current: HistoryState,
  nextView: View,
  scrollTop: number,
): HistoryState {
  const active = current.entries[current.index]?.view;
  if (active && viewsEqual(active, nextView)) {
    return current;
  }
  const entries = current.entries.slice(0, current.index + 1);
  entries.push({ view: nextView, scrollTop });
  return { entries, index: entries.length - 1 };
}

function trackFromSearchItem(item: SearchItem): MediaTrack | null {
  if (!item.videoId) return null;
  // Encode the release/album so identical songs that appear under multiple
  // YouTube Music releases (e.g. a single and its parent album) produce
  // distinct MediaTrack ids. This keeps the UI's "selected" row identity
  // aligned with the actual release the user picked instead of bleeding
  // across every appearance.
  const id = item.albumBrowseId
    ? `yt:${item.videoId}:${item.albumBrowseId}`
    : `yt:${item.videoId}`;
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

function getInitialView(): View {
  return getSettings().showHomeMenu ? { name: "home" } : { name: "collection" };
}

function Shell() {
  const player = usePlayer();
  const hasActiveTrack = usePlayerHasTrack();
  const showHomeMenu = useSetting("showHomeMenu");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useStartupSplash();
  useStartupMinimized();
  useDiscordRichPresence();
  useViewportHeightTracker();

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((current) => !current);
  }, []);

  useGlobalShortcuts({ onToggleSidebar: handleToggleSidebar });
  useTasteProfileTracking();

  const [historyState, setHistoryState] = useState<HistoryState>(() => ({
    entries: [{ view: getInitialView(), scrollTop: 0 }],
    index: 0,
  }));
  const [transientView, setTransientView] = useState<View | null>(null);
  // Mirror of `transientView` so the synchronous setHistoryState callback can
  // read the latest pending transient without relying on the (stale)
  // useCallback closure value. Cleared inline whenever a transient is
  // committed, so back-to-back navigations in the same render don't push it
  // twice.
  const transientViewRef = useRef<View | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const transientScrollTopRef = useRef(0);
  const committedView = historyState.entries[historyState.index].view;
  const view = transientView ?? committedView;
  const pageAnimationKey = getViewAnimationKey(view);
  const canBack = Boolean(transientView) || historyState.index > 0;
  const canForward = !transientView && historyState.index < historyState.entries.length - 1;
  // Pages that paint their own cover-style hero stretch all the way to
  // the topbar — these views drop the scroll container's outer pt / px
  // so the hero's internal `pt-[calc(topbar+pad)]` and `px-[page-pad]`
  // are the single source of clearance, avoiding double padding.
  const isFullBleedView =
    view.name === "album" ||
    view.name === "playlist" ||
    view.name === "user-playlist" ||
    view.name === "user-playlists" ||
    view.name === "artist" ||
    view.name === "lyrics";

  const hideSearchOnLyrics = useSetting("hideSearchOnLyrics");
  const hidePlayerOnLyrics = useSetting("hidePlayerOnLyrics");
  const onLyricsPage = view.name === "lyrics";
  const lyricsPlayerHidden = onLyricsPage && hidePlayerOnLyrics;

  // Derived each render from refs + state. The hook reads it at render
  // time, then re-runs its layout effect when transientView or
  // historyState.index changes — covering both the \"transient
  // commit\" path and the \"history back/forward\" path.
  const savedScrollTop = transientView
    ? transientScrollTopRef.current
    : historyState.entries[historyState.index]?.scrollTop ?? 0;
  useScrollRestoration({
    containerRef: scrollContainerRef,
    savedScrollTop,
    enabled: true,
  });

  const transitionView = useCallback((updater: () => void) => {
    const currentScrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    if (transientView) {
      transientScrollTopRef.current = currentScrollTop;
    } else {
      setHistoryState((current) => {
        const active = current.entries[current.index];
        if (active.scrollTop === currentScrollTop) return current;
        const entries = current.entries.slice();
        entries[current.index] = { ...active, scrollTop: currentScrollTop };
        return { ...current, entries };
      });
    }
    updater();
  }, [transientView]);

  const [searchInput, setSearchInput] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    readStoredArray<string>(RECENT_SEARCHES_KEY, []),
  );
  const [uploadedTracks, setUploadedTracks] = useState<MediaTrack[]>([]);
  const [searchSessionView, setSearchSessionView] = useState<View | null>(null);
  const [searchRetryToken, setSearchRetryToken] = useState(0);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const searchTimeoutRef = useRef<number | null>(null);
  const historyCommitTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setItem(RECENT_SEARCHES_KEY, JSON.stringify(recentSearches));
  }, [recentSearches]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const collapseIfNarrow = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    // Only auto-collapse on narrow viewports. Never auto-expand when the
    // viewport widens — Win+Shift+Arrow monitor moves in fullscreen can
    // briefly flicker this query and would reopen a sidebar the user closed.
    collapseIfNarrow();
    mq.addEventListener?.("change", collapseIfNarrow);
    return () => mq.removeEventListener?.("change", collapseIfNarrow);
  }, []);

  useEffect(() => {
    if (view.name === "search") {
      setSearchInput(view.query);
    } else {
      setSearchInput("");
    }
  }, [view]);

  useEffect(() => {
    if (view.name !== "search" || !view.query.trim()) {
      setSearchFiltersOpen(false);
    }
  }, [view]);

  useEffect(() => {
    transientViewRef.current = transientView;
  }, [transientView]);

  useEffect(() => {
    clearTimer(historyCommitTimeoutRef);
    if (!transientView || transientView.name !== "search" || !transientView.query.trim()) {
      return;
    }

    historyCommitTimeoutRef.current = window.setTimeout(() => {
      setHistoryState((current) =>
        pushHistoryEntry(current, transientView, transientScrollTopRef.current),
      );
      setTransientView((current) => (current && viewsEqual(current, transientView) ? null : current));
    }, 1500);

    return () => clearTimer(historyCommitTimeoutRef);
  }, [transientView]);

  useEffect(() => {
    if (!searchSessionView) {
      clearTimer(searchTimeoutRef);
      return;
    }
    if (isSearchWorkspace(view)) {
      clearTimer(searchTimeoutRef);
      if (!viewsEqual(searchSessionView, view)) {
        setSearchSessionView(view);
      }
      return;
    }
    clearTimer(searchTimeoutRef);
    searchTimeoutRef.current = window.setTimeout(() => {
      setSearchSessionView(null);
    }, 15000);
    return () => clearTimer(searchTimeoutRef);
  }, [searchSessionView, view]);

  const hydrateImportedDurations = useCallback(async (tracks: MediaTrack[]) => {
    // Batch the duration probes so we don't spin up an `<audio>` element
    // for every imported track at once. Each `readDuration` call creates a
    // new media element and waits for metadata; with a large library this
    // floods the audio subsystem and slows the first paint. Processing in
    // fixed-size chunks keeps the boot responsive while still hydrating
    // every track.
    const BATCH_SIZE = 4;
    for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
      const batch = tracks.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (track) => {
          const updates: { durationSeconds?: number; album?: string; artist?: string } = {};

          if (track.audioSrc && !track.durationSeconds) {
            const durationSeconds = await readDuration(track.audioSrc);
            if (durationSeconds) updates.durationSeconds = durationSeconds;
          }

          if (
            track.title &&
            track.artist &&
            isPlaceholderAlbumName(displayAlbumName(track.album))
          ) {
            try {
              const enrichment = await enrichUploadMetadataFromYtm({
                title: track.title,
                artist: track.artist,
                album: track.album,
              });
              if (enrichment?.album) updates.album = enrichment.album;
              if (enrichment?.artist && isPlaceholderAlbumName(track.artist)) {
                updates.artist = enrichment.artist;
              }
            } catch {
              // best-effort
            }
          }

          if (Object.keys(updates).length === 0) return;

          setUploadedTracks((current) =>
            current.map((entry) =>
              entry.id === track.id ? { ...entry, ...updates } : entry,
            ),
          );
          void updateImportedTrackMetadata(track.id, updates).catch(() => undefined);
        }),
      );
    }
  }, []);

  useImportedTracksHydration({
    onLoaded: setUploadedTracks,
    onHydrate: hydrateImportedDurations,
  });

  const navigate = useCallback((nextView: View) => {
    transitionView(() => {
      if (nextView.name === "search") {
        if (viewsEqual(view, nextView)) return;
        transientViewRef.current = nextView;
        setTransientView(nextView);
        return;
      }

      setTransientView(null);
      setHistoryState((current) => {
        let intermediate = current;
        const pendingTransient = transientViewRef.current;
        if (pendingTransient) {
          const active = intermediate.entries[intermediate.index]?.view;
          if (!active || !viewsEqual(active, pendingTransient)) {
            intermediate = pushHistoryEntry(
              intermediate,
              pendingTransient,
              transientScrollTopRef.current,
            );
          }
          transientViewRef.current = null;
        }
        return pushHistoryEntry(intermediate, nextView, 0);
      });
    });
  }, [transitionView, transientView, view]);

  useEffect(() => {
    if (!showHomeMenu && view.name === "home") {
      navigate({ name: "collection" });
    }
  }, [showHomeMenu, view.name, navigate]);

  const playTrack = useCallback(
    (track: MediaTrack) => {
      void player.play(track);
    },
    [player],
  );

  const playMany = useCallback(
    (tracks: MediaTrack[], startIndex = 0, origin?: QueueOrigin) => {
      void player.playMany(tracks, startIndex, origin);
    },
    [player],
  );

  const rememberSearch = useCallback((query: string) => {
    setRecentSearches((current) => [query, ...current.filter((value) => value !== query)].slice(0, 8));
  }, []);

  const activateSearchSession = useCallback((sessionView: View) => {
    clearTimer(searchTimeoutRef);
    setSearchSessionView(sessionView);
  }, []);

  const searchNow = useCallback(
    (query: string, forceRefresh = false) => {
      const clean = query.trim();
      if (!clean) {
        setSearchInput("");
        navigate({ name: "search", query: "" });
        return;
      }
      setSearchInput(clean);
      rememberSearch(clean);
      if (forceRefresh) setSearchRetryToken((current) => current + 1);
      navigate({ name: "search", query: clean });
    },
    [navigate, rememberSearch],
  );

  const openItem = useCallback(
    (item: SearchItem, context: "default" | "search" = "default") => {
      if (item.kind === "song" && item.videoId) {
        // Toggle is only the right shortcut when the click would play the
        // exact same release that's already loaded. The same underlying
        // audio on a different release still needs a fresh play() so the
        // album cover / nav context updates to match what the user picked.
        const sameRelease =
          player.currentTrack?.videoId === item.videoId &&
          (player.currentTrack?.albumBrowseId ?? null) ===
            (item.albumBrowseId ?? null);
        if (sameRelease) {
          player.togglePlay();
          return;
        }
        const track = trackFromSearchItem(item);
        if (track) playTrack(track);
        return;
      }
      if (item.kind === "album" && item.browseId) {
        const nextView: View = { name: "album", browseId: item.browseId, context };
        navigate(nextView);
        if (context === "search") activateSearchSession(nextView);
      }
      if (item.kind === "artist" && item.browseId) {
        const nextView: View = {
          name: "artist",
          browseId: item.browseId,
          context,
          cover: item.cover ?? null,
          section: "overview",
        };
        navigate(nextView);
        if (context === "search") activateSearchSession(nextView);
      }
      if (item.kind === "playlist" && item.browseId) {
        const nextView: View = { name: "playlist", browseId: item.browseId, context };
        navigate(nextView);
        if (context === "search") activateSearchSession(nextView);
      }
    },
    [activateSearchSession, navigate, playTrack, player.currentTrack, player.togglePlay],
  );

  const handleOpenSearchItem = useCallback(
    (item: SearchItem) => {
      openItem(item, "search");
    },
    [openItem],
  );

  const handleOpenArtistItem = useCallback(
    (item: SearchItem) => {
      if (view.name === "artist") {
        openItem(item, view.context);
      }
    },
    [openItem, view],
  );

  const handleSearchResolved = useCallback(
    (hasResults: boolean) => {
      if (hasResults) activateSearchSession(view);
    },
    [activateSearchSession, view],
  );

  const handleSearchLoadingChange = useCallback((loading: boolean) => {
    setIsSearchLoading(loading);
  }, []);

  const handleImportFiles = useCallback(
    async (files: FileList | File[]) => {
      const imports = await readFileImports(files);
      if (imports.length === 0) return;
      const stored = await importTracks(imports);
      const hydrated = stored.map(withResolvedAudioSrc);
      setUploadedTracks((current) => [...hydrated, ...current]);
      await hydrateImportedDurations(hydrated);
    },
    [hydrateImportedDurations],
  );

  const handleRemoveUpload = useCallback((trackId: string) => {
    void removeImportedTrack(trackId).catch(() => undefined);
    setUploadedTracks((current) => current.filter((track) => track.id !== trackId));
    // Drop the track from the active player queue so the audio doesn't
    // keep playing a file that's about to be deleted from disk. If the
    // deleted track is the current one, this advances to the next track
    // in the queue; if the deleted track was the current AND the last
    // entry, the queue is cleared and the player bar hides until the
    // user plays something else.
    player.removeTrackFromQueue(trackId);
  }, [player]);

  // Optimistic flip of an upload track's lyrics-fetching preference, mirrored
  // to the Rust store. Follows `handleRemoveUpload`'s silent-fail convention
  // — a transient backend hiccup on an idempotent toggle shouldn't be
  // visibly worse than the same on a destructive delete.
  const handleToggleUploadLyrics = useCallback(
    (trackId: string, nextValue: boolean) => {
      setUploadedTracks((current) =>
        current.map((track) =>
          track.id === trackId ? { ...track, findLyrics: nextValue } : track,
        ),
      );
      void updateImportedTrackMetadata(trackId, { findLyrics: nextValue }).catch(
        () => undefined,
      );
    },
    [],
  );

  const handleRefreshImports = useCallback(async () => {
    try {
      const tracks = await listImportedTracks();
      const hydrated = tracks.map(withResolvedAudioSrc);
      setUploadedTracks(hydrated);
      void hydrateImportedDurations(hydrated);
    } catch {
      // keep current state on failure
    }
  }, [hydrateImportedDurations]);

  // ── Collection bridge handlers ──────────────────────────────────────
  //
  // PlayerContext exposes `appendToQueue(tracks)` which appends the tracks
  // after the current playback slot and ahead of any autoplay tail. The
  // SongContextMenu's "Add to queue" routes through it directly. The
  // AlbumContextMenu's "Add to queue" composes that call with the entire
  // album's track list in chronological order and sets the queue origin
  // so the queue panel labels the section "Next from [Album]".
  const handleAddAlbumToQueue = useCallback(
    (tracks: MediaTrack[], browseId: string, name: string) => {
      player.appendToQueue(tracks, { kind: "album", browseId, name });
    },
    [player],
  );

  // ── Playlists integration ──────────────────────────────────────────
  //
  // The user-playlists store lives in a separate provider so this shell only
  // has to do two things with it:
  //   1. Hand its current list + sort state to `<Sidebar>` so the section
  //      renders every playlist as a button.
  //   2. Bridge the provider's CRUD methods to the imperative
  //      navigation/queue hooks below (create → navigate, add-to-playlist,
  //      remove from playlist).
  //
  // We split out the bare context here because we need access to its
  // actions inside Shell — the provider itself only exposes the data.
  const playlistsCtx = usePlaylists();

  // Playlist-side resolver. The previous stub returned an empty list and
  // write a no-op; the live one reads from `playlistsCtx.playlists` and
  // delegates `addTracksToPlaylist(id, tracks)` to the provider's
  // `addTrackToPlaylist`. We map `id → playlist` via an in-place lookup so
  // the menu's `browseId` slot stays a stable string (the API shape the
  // menu component already understands) without re-shaping the Song /
  // Album context menus.
  const playlistResolver = useCallback<AddToPlaylistResolver["resolvePlaylists"]>(
    async (query: string) => {
      const needle = query.trim().toLowerCase();
      // Surface every user playlist whose title starts with the search
      // needle. Empty needle returns all of them (default list).
      const list = playlistsCtx.playlists;
      const filtered = needle
        ? list.filter((p) => p.title.toLowerCase().includes(needle))
        : list;
      return filtered.map((p) => ({
        browseId: p.id,
        title: p.title,

        cover: p.cover,
      }));
    },
    [playlistsCtx.playlists],
  );

  // Resolve missing album metadata for tracks being added to a user
  // playlist. Tracks from different sources may lack `album` or
  // `albumBrowseId`; this fills them via the backend's
  // `resolveTrackAlbum` (which looks up the videoId on YouTube Music).
  // Skips tracks that already have an album name or lack a videoId.
  const enrichAlbum = useCallback(
    async (tracks: MediaTrack[]): Promise<MediaTrack[]> => {
      const enriched = await Promise.all(
        tracks.map(async (track) => {
          if (track.album || !track.videoId) return track;
          try {
            const resolution = await resolveTrackAlbum(track.videoId);
            if (resolution.album || resolution.albumBrowseId) {
              return {
                ...track,
                album: resolution.album ?? track.album,
                albumBrowseId: resolution.albumBrowseId ?? track.albumBrowseId,
              };
            }
          } catch {
            // Network or backend failure — keep track as-is.
          }
          return track;
        }),
      );
      return enriched;
    },
    [],
  );

  const handleAddAlbumToPlaylist = useCallback<AddToPlaylistResolver["addTracksToPlaylist"]>(
    async (id: string, tracks: MediaTrack[]) => {
      // Sanitize: drop ephemeral fields the same way Persist does so the
      // rejected add doesn't write `_labelOrigin` back into localStorage
      // via the provider's setter (which has its own sanitizer, but
      // staying consistent avoids any drift if the provider's policy
      // changes).
      const sanitized = tracks.map(stripQueueMetadata);
      // Enrich tracks that are missing album metadata so the "Album"
      // column in the playlist view shows a name. This is best-effort;
      // failures are silently skipped.
      const enriched = await enrichAlbum(sanitized);
      for (const track of enriched) {
        playlistsCtx.addTrackToPlaylist(id, track);
      }
    },
    [playlistsCtx, enrichAlbum],
  );

  const handleRemoveTrackFromPlaylist = useCallback(
    (playlistId: string, trackId: string) => {
      playlistsCtx.removeTrackFromPlaylist(playlistId, trackId);
    },
    [playlistsCtx],
  );

  const handleCreatePlaylist = useCallback(() => {
    const playlist = playlistsCtx.createPlaylist();
    navigate({ name: "user-playlist", id: playlist.id });
  }, [playlistsCtx, navigate]);

  const handleDeletePlaylist = useCallback(
    (id: string) => {
      const current = view;
      // Navigate the user off the page if they delete the playlist they're
      // currently looking at. If there's a history entry to go back to,
      // go back; otherwise fall back to a blank search.
      if (current.name === "user-playlist" && current.id === id) {
        if (canBack) {
          transitionView(() => {
            if (transientView) {
              transientViewRef.current = null;
              setTransientView(null);
              return;
            }
            setHistoryState((prev) => ({ ...prev, index: prev.index - 1 }));
          });
        } else {
          navigate(showHomeMenu ? { name: "home" } : { name: "collection" });
        }
      }
      playlistsCtx.deletePlaylist(id);
    },
    [view, navigate, playlistsCtx, canBack, transitionView, transientView, transientViewRef, setTransientView, setHistoryState, showHomeMenu],
  );

  // ── Playlist deletion confirmation (sidebar path) ───────────────────
  //
  // The Sidebar's right-click context menu calls `onDeletePlaylist` to
  // *request* a delete — instead of dropping the playlist immediately
  // (the original, immediate-delete behavior). The request stages the
  // playlist id here; App.tsx renders a top-level `<ConfirmDialog>` so
  // the user gets the matching "Are you sure?" prompt the in-page
  // ellipsis menu on `<UserPlaylistPage>` already provides. Confirm →
  // existing `handleDeletePlaylist` (handles navigation + deletion).
  //
  // The dialog is mounted at the App root rather than inside the
  // Sidebar because the Sidebar's `<aside>` carries `contain: layout`,
  // which modern Chromium implements as a containing block for
  // `position: fixed` descendants. Mounting `inset-0` inside that
  // subtree would size the modal to the ~240px sidebar rather than the
  // viewport — backdrop covering only the sidebar and obscuring the
  // playlist icons. Rendering here also matches the project's existing
  // pattern for global modals (song menu, album menu).
  const [pendingPlaylistDeleteId, setPendingPlaylistDeleteId] = useState<string | null>(null);
  // Look up by id so the dialog can surface the playlist's title. If
  // the row vanished between the request and the confirm — e.g. deleted
  // elsewhere — the lookup returns `undefined` and we skip rendering
  // the dialog rather than crash on a missing `title`.
  const pendingPlaylistDelete = pendingPlaylistDeleteId
    ? playlistsCtx.playlists.find((p) => p.id === pendingPlaylistDeleteId) ?? null
    : null;
  const handleRequestPlaylistDelete = useCallback((id: string) => {
    setPendingPlaylistDeleteId(id);
  }, []);

  // ── Global song context menu ────────────────────────────────────────
  //
  // Any row that tags itself with `data-song-context-target="true"` and
  // encodes the track as `data-track='{JSON}'` opens this menu on right-
  // click. The menu's "Add to queue" / "Save to collection" actions wire
  // through CollectionProvider + PlayerProvider (which wrap the shell).
  const [songMenuState, setSongMenuState] = useState<{
    track: MediaTrack;
    position: { x: number; y: number };
  } | null>(null);
  const songMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeSongMenu = useCallback(() => setSongMenuState(null), []);

  // ── Global album context menu ──────────────────────────────────────
  //
  // Any card that tags itself with `data-album-context-target="true"` and
  // encodes the album as `data-album='{JSON}'` opens this menu on right-
  // click. The handler skips elements that are inside a song context target
  // so track-level menus take precedence.
  const [albumMenuState, setAlbumMenuState] = useState<{
    album: SavedAlbum;
    position: { x: number; y: number };
  } | null>(null);
  const albumMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeAlbumMenu = useCallback(() => setAlbumMenuState(null), []);

  useGlobalContextMenus({
    onSongContextMenu: useCallback((track, position) => {
      setSongMenuState({ track, position });
    }, []),
    onAlbumContextMenu: useCallback((album, position) => {
      setAlbumMenuState({ album, position });
    }, []),
  });

  // App root has no `bg-black` here on purpose. body's `#000000`
  // background provides the base black backdrop for every page, and each
  // page renders its own (opaque or semi-transparent) bg on the nearest
  // container. The lyrics page's waveform canvas is fixed at z-0 above
  // body's background — an opaque bg on this root would cover it.
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden text-neutral-100">
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          view={view}
          expanded={sidebarOpen}
          onToggle={() => setSidebarOpen((current) => !current)}
          onNavigate={navigate}
          playlists={playlistsCtx.playlists}
          playlistsSortMode={playlistsCtx.sortMode}
          playlistsSortDirection={playlistsCtx.sortDirection}
          onSetPlaylistsSortMode={playlistsCtx.setSortMode}
          onSetPlaylistsSortDirection={playlistsCtx.setSortDirection}
          onCreatePlaylist={handleCreatePlaylist}
          onDeletePlaylist={handleRequestPlaylistDelete}
          onTogglePinPlaylist={playlistsCtx.togglePlaylistPinned}
        />

        <main
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          <TopBar
            canBack={canBack}
            canForward={canForward}
            suppressHistoryControls={false}

            suppressSearchBar={onLyricsPage && hideSearchOnLyrics}
            onBack={() =>
              canBack &&
              transitionView(() => {
                if (transientView) {
                  transientViewRef.current = null;
                  setTransientView(null);
                  return;
                }
                setHistoryState((current) => ({ ...current, index: current.index - 1 }));
              })
            }
            onForward={() =>
              canForward &&
              transitionView(() => setHistoryState((current) => ({ ...current, index: current.index + 1 })))
            }
            query={searchInput}
            onSearch={searchNow}
            isSearchLoading={isSearchLoading}
            sidebarExpanded={sidebarOpen}
            showSearchFilters={view.name === "search" && Boolean(view.query.trim())}
            searchFilters={searchFilters}
            searchFiltersOpen={searchFiltersOpen}
            onToggleSearchFilters={() => setSearchFiltersOpen((open) => !open)}
            onCloseSearchFilters={() => setSearchFiltersOpen(false)}
            onChangeSearchFilters={setSearchFilters}
          />

          <div
            ref={scrollContainerRef}
            className={cn(
              "nice-scroll main-scrollport min-h-0 flex-1 overflow-y-auto",
              isFullBleedView ? "pt-0" : "pt-[var(--ui-topbar-height)]",
              isFullBleedView ? "px-0" : "px-[var(--ui-page-pad)]",
              hasActiveTrack && !lyricsPlayerHidden
                ? "pb-[clamp(5rem,8vw,7.5rem)]"
                : "pb-[clamp(1.5rem,2vw,2.5rem)]",
            )}
          >
            <div
              key={pageAnimationKey}
              className={cn(
                "mx-auto w-full page-content",
                isFullBleedView ? "max-w-none" : "max-w-[var(--ui-content-max)]",
              )}
            >
              <Suspense fallback={<LoadingPanel label="Loading page" />}>
                {view.name === "home" ? (
                  <HomePage
                    onPlayTrack={playTrack}
                    onNavigate={navigate}
                  />
                ) : null}

                {view.name === "collection" ? (
                  <CollectionPage
                    uploadedTracks={uploadedTracks}
                    onImportFiles={handleImportFiles}
                    onImportsChanged={handleRefreshImports}
                    onPlayTrack={playTrack}
                    onNavigate={navigate}
                    initialTab={view.tab}
                  />
                ) : null}

                 {view.name === "search" && (
                  <SearchPage
                    query={view.query}
                    retryToken={searchRetryToken}
                    onOpenItem={handleOpenSearchItem}
                    onNavigate={navigate}
                    onPlayTrack={playTrack}
                    onPlayMany={playMany}
                    onSearchResolved={handleSearchResolved}
                    onSearchLoadingChange={handleSearchLoadingChange}
                    filters={searchFilters}
                  />
                )}

                {view.name === "album" && (
                  <EntityPage
                    browseId={view.browseId}
                    onPlayMany={playMany}
                    onNavigate={navigate}
                    onAddAlbumToQueue={handleAddAlbumToQueue}
                    onAddAlbumToPlaylist={handleAddAlbumToPlaylist}
                    resolvePlaylists={playlistResolver}
                  />
                )}

                {view.name === "playlist" && (
                  <EntityPage
                    browseId={view.browseId}
                    onPlayMany={playMany}
                    onNavigate={navigate}
                    onAddAlbumToQueue={handleAddAlbumToQueue}
                    onAddAlbumToPlaylist={handleAddAlbumToPlaylist}
                    resolvePlaylists={playlistResolver}
                  />
                )}

                {view.name === "user-playlist" && (
                  <UserPlaylistPage
                    playlistId={view.id}
                    onPlayMany={playMany}
                    onNavigate={navigate}
                    onAddAlbumToQueue={handleAddAlbumToQueue}
                    onDeletePlaylist={handleDeletePlaylist}
                    onTogglePinPlaylist={playlistsCtx.togglePlaylistPinned}
                  />
                )}

                {view.name === "artist" && (
                  <ArtistPage
                    browseId={view.browseId}
                    cover={view.cover}
                    context={view.context}
                    section={view.section ?? "overview"}
                    navigationKey={historyState.index}
                    onOpenItem={handleOpenArtistItem}
                    onPlayTrack={playTrack}
                    onNavigate={navigate}
                    historyCanBack={canBack}
                    historyCanForward={canForward}
                    onHistoryBack={() =>
                      canBack &&
                      transitionView(() => {
                        if (transientView) {
                          setTransientView(null);
                          transientViewRef.current = null;
                          transientScrollTopRef.current = 0;
                          return;
                        }
            setHistoryState((prev) => ({ ...prev, index: prev.index - 1 }));
                      })
                    }
                    onHistoryForward={() =>
                      canForward &&
                      transitionView(() => setHistoryState((current) => ({ ...current, index: current.index + 1 })))
                    }
                    onAddAlbumToQueue={handleAddAlbumToQueue}
                    onAddAlbumToPlaylist={handleAddAlbumToPlaylist}
                    resolvePlaylists={playlistResolver}
                  />
                )}

                {view.name === "lyrics" && (
                  <LyricsPage
                    onNavigate={navigate}
                  />
                )}

                 {view.name === "settings" && (
                  <SettingsPage />
                )}

                {view.name === "user-playlists" && (
                  <UserPlaylistsPage
                    onNavigate={navigate}
                    onCreatePlaylist={handleCreatePlaylist}
                    onDeletePlaylist={handleRequestPlaylistDelete}
                  />
                )}
              </Suspense>
            </div>
          </div>
        </main>
      </div>

      <PlayerBar
        sidebarOpen={sidebarOpen}
        onNavigate={navigate}
        viewName={view.name}
      />

      {/* Global song context menu — opens from any row that tags itself
          `data-song-context-target` with a `data-track` JSON payload. The
          `onRemoveTrack` slot is only wired for `source === "upload"` rows;
          SongContextMenu checks the track source internally and only
          surfaces the destructive Delete option when the prop is present,
          so stream tracks never get a delete path even if they right-
          click the menu. */}
      {songMenuState && (
        <SongContextMenu
          track={songMenuState.track}
          position={songMenuState.position}
          anchorRef={songMenuTriggerRef}
          addToPlaylistResolver={{
            resolvePlaylists: playlistResolver,
            addTracksToPlaylist: handleAddAlbumToPlaylist,
          }}
          onRemoveTrack={
            songMenuState.track.source === "upload"
              ? handleRemoveUpload
              : undefined
          }
          onToggleUploadLyrics={
            songMenuState.track.source === "upload"
              ? handleToggleUploadLyrics
              : undefined
          }
          onRemoveFromPlaylist={
            view.name === "user-playlist"
              ? handleRemoveTrackFromPlaylist
              : undefined
          }
          onNavigate={navigate}
          onClose={closeSongMenu}
          currentAlbumBrowseId={view.name === "album" ? view.browseId : undefined}
          currentArtistBrowseId={view.name === "artist" ? view.browseId : undefined}
          currentUserPlaylistId={view.name === "user-playlist" ? view.id : undefined}
        />
      )}
      {/* Global album context menu — opens from any card that tags itself
          `data-album-context-target` with a `data-album` JSON payload.
          Tracks are fetched lazily by AlbumContextMenu when not provided. */}        {albumMenuState && (
        <AlbumContextMenu
          open
          position={albumMenuState.position}
          anchorRef={albumMenuTriggerRef}
          onClose={closeAlbumMenu}
          album={albumMenuState.album}
          onAddAlbumToQueue={handleAddAlbumToQueue}
          onAddAlbumToPlaylist={handleAddAlbumToPlaylist}
          resolvePlaylists={playlistResolver}
          onNavigate={navigate}
          currentAlbumBrowseId={view.name === "album" ? view.browseId : undefined}
          currentUserPlaylistId={view.name === "user-playlist" ? view.id : undefined}
        />
      )}
      {/* Hidden anchors used by the context menus' click-away logic. */}
      <button
        ref={songMenuTriggerRef}
        type="button"
        aria-hidden
        tabIndex={-1}
        className="sr-only h-0 w-0 opacity-0"
      />
      <button
        ref={albumMenuTriggerRef}
        type="button"
        aria-hidden
        tabIndex={-1}
        className="sr-only h-0 w-0 opacity-0"
      />

      {/* Playlist deletion confirmation — surfaced when the user picks
          "Delete playlist" from the Sidebar's right-click context menu.
          Mounted at the App root (alongside the song/album menus) so the
          `<aside>`'s `contain: layout` doesn't trap the `position: fixed`
          modal inside the sidebar's containing block. */}
      {pendingPlaylistDelete && (
        <ConfirmDialog
          open
          title={`Delete playlist "${pendingPlaylistDelete.title}"?`}
          message="This action cannot be undone. The playlist and all its tracks will be permanently removed."
          confirmLabel="Delete playlist"
          onConfirm={() => {
            handleDeletePlaylist(pendingPlaylistDelete.id);
            setPendingPlaylistDeleteId(null);
          }}
          onCancel={() => setPendingPlaylistDeleteId(null)}
        />
      )}
    </div>
  );
}

function clearTimer(ref: React.MutableRefObject<number | null>) {
  if (ref.current) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

export default function App() {
  return (
    <PlayerProvider>
      <AccentProvider>
        <CollectionProvider>
          <PlaylistsProvider>
            <Shell />
          </PlaylistsProvider>
        </CollectionProvider>
      </AccentProvider>
    </PlayerProvider>
  );
}
