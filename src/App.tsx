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
import { cn } from "./utils/cn";
import { createTrackFromSearchItem } from "./utils/track-factory";
import { getItem, setItem } from "./storage";
import { getSettings, setSetting, useSetting } from "./settings";
import { invoke } from "@tauri-apps/api/core";
import PlayerBar from "./components/PlayerBar";
import { NowPlayingPanel } from "./components/NowPlayingPanel";
import { HomePage } from "./components/HomePage";
import { SearchPage } from "./components/SearchPage";
import { Sidebar, TopBar, isSearchWorkspace, type View } from "./components/Sidebar";
import { useTasteProfileTracking } from "./hooks/useTasteProfileTracking";
import { useHistoryStack } from "./hooks/useHistoryStack";
import { DEFAULT_SEARCH_FILTERS, type SearchFilters } from "./components/SearchFilters";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

const trackFromSearchItem = createTrackFromSearchItem;

function getInitialView(): View {
  return getSettings().showHomeMenu ? { name: "home" } : { name: "collection" };
}

function Shell() {
  const player = usePlayer();
  const showHomeMenu = useSetting("showHomeMenu");
  const sidebarOpen = useSetting("sidebarOpen");
  const nowPlayingOpen = useSetting("nowPlayingOpen");
  const hasTrack = Boolean(player.currentTrack);
  const effectiveNowPlayingOpen = hasTrack && nowPlayingOpen;
  // On the lyrics page the control panels (sidebar / now playing panel)
  // stay hidden by default and only slide out while the cursor hovers
  // near the edges of the window. Those reveals are tracked separately
  // from the persistent preferences so leaving the lyrics page restores
  // them exactly as they were before.
  const [lyricsControlsRevealed, setLyricsControlsRevealed] = useState(false);
  const [lyricsNowPlayingRevealed, setLyricsNowPlayingRevealed] = useState(false);

  useStartupSplash();
  useStartupMinimized();
  useDiscordRichPresence();
  useViewportHeightTracker();
  useTasteProfileTracking();

  // Keep window chrome in sync for transparent+rounded mode.
  // With `transparent: true` + `shadow: false` the window is rounded via
  // CSS (`#root { border-radius: 10px }`). When maximized or pseudo-
  // fullscreen the radius must be 0 so the app fills the monitor.
  useEffect(() => {
    const html = document.documentElement;
    let cancelled = false;
    let unlistenResized: (() => void) | undefined;

    const syncChrome = async () => {
      try {
        const win = getCurrentWindow();
        const [maximized, nativeFs, pseudoFs] = await Promise.all([
          win.isMaximized().catch(() => false),
          win.isFullscreen().catch(() => false),
          invoke<boolean>("is_app_fullscreen").catch(() => false),
        ]);
        if (cancelled) return;
        const isFs = nativeFs || pseudoFs;
        html.setAttribute("data-window-maximized", String(maximized));
        html.setAttribute("data-window-fullscreen", String(isFs));
      } catch {
        if (!cancelled) {
          html.setAttribute("data-window-maximized", "false");
          html.setAttribute("data-window-fullscreen", "false");
        }
      }
    };

    void syncChrome();
    try {
      const win = getCurrentWindow();
      // onResized fires for maximize/unmaximize and for pseudo-fullscreen
      // size changes. This is the only trigger needed — the previous
      // 600 ms poll fired 5 IPC roundtrips per second forever, waking
      // the backend and janking the main thread even when idle.
      win
        .onResized(() => {
          void syncChrome();
        })
        .then((fn) => {
          unlistenResized = fn;
        })
        .catch(() => {});
    } catch {}
    // Listen for Tauri window focus/active changes which also reflect
    // fullscreen transitions on some platforms, as a lightweight
    // alternative to polling.
    const onWindowFocus = () => void syncChrome();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void syncChrome();
    };
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      unlistenResized?.();
    };
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const {
    historyState,
    setHistoryState,
    transientView,
    setTransientView,
    transientViewRef,
    transientScrollTopRef,
    view,
    canBack,
    canForward,
    transitionView,
    navigate,
    goBack,
    goForward,
    viewsEqual,
    pushHistoryEntry,
  } = useHistoryStack(getInitialView(), scrollContainerRef);
  const pageAnimationKey = getViewAnimationKey(view);
  // Pages that paint their own cover-style hero stretch all the way to
  // the topbar — these views drop the scroll container's outer pt / px
  // so the hero's internal `pt-[calc(topbar+pad)]` and `px-[page-pad]`
  // are the single source of clearance, avoiding double padding.
  const isFullBleedView =
    view.name === "home" ||
    view.name === "album" ||
    view.name === "playlist" ||
    view.name === "user-playlist" ||
    view.name === "user-playlists" ||
    view.name === "artist" ||
    view.name === "lyrics";

  const hideSidebarOnLyrics = useSetting("hideSidebarOnLyrics");
  const hideNowPlayingOnLyrics = useSetting("hideNowPlayingOnLyrics");
  const onLyricsPage = view.name === "lyrics";
  // With the "hide sidebar on lyrics" toggle ON, the sidebar stays hidden
  // on the lyrics page and slides out while the cursor hovers near the
  // left edge (or Ctrl+B is pressed). With the toggle OFF it behaves like
  // every other page, following the persistent open/closed state.
  const lyricsSidebarHidden =
    onLyricsPage && hideSidebarOnLyrics && !lyricsControlsRevealed;
  // With the "hide now playing on lyrics" toggle ON, the now playing menu
  // stays hidden on the lyrics page and slides out while the cursor hovers near
  // the right edge (or the toggle button is clicked).
  const lyricsNowPlayingHidden =
    onLyricsPage && hideNowPlayingOnLyrics && !lyricsNowPlayingRevealed;

  // Sidebar toggle. Works the same everywhere: toggles the persistent
  // open/closed state. On the lyrics page the toggle also brings the
  // hidden sidebar back into view (Ctrl+B / brand button) so those
  // shortcuts have a visible effect there too. Collapsing, on the other
  // hand, drops the reveal immediately — otherwise the collapsed rail
  // would linger after the pointer has already left its (now smaller)
  // footprint, with nothing re-evaluating it until the next mouse move.
  const handleToggleSidebar = useCallback(() => {
    const next = !sidebarOpen;
    if (onLyricsPage && hideSidebarOnLyrics) {
      setLyricsControlsRevealed(next);
    }
    setSetting("sidebarOpen", next);
  }, [onLyricsPage, hideSidebarOnLyrics, sidebarOpen]);

  const handleToggleNowPlaying = useCallback(() => {
    if (!player.currentTrack) return;
    const next = !nowPlayingOpen;
    if (onLyricsPage && hideNowPlayingOnLyrics) {
      setLyricsNowPlayingRevealed(next);
    }
    setSetting("nowPlayingOpen", next);
  }, [onLyricsPage, hideNowPlayingOnLyrics, nowPlayingOpen, player.currentTrack]);

  useGlobalShortcuts({ onToggleSidebar: handleToggleSidebar });

  // The reveal is hover-scoped with hysteresis: while the toggle is on
  // and we're on the lyrics page, the sidebar slides out as soon as the
  // pointer approaches its footprint and hides only once the pointer
  // clearly leaves it. The two thresholds (a tight one to reveal, a wide
  // one to hide) leave a dead band between them, so the state never
  // oscillates when the pointer hovers near the sidebar's edge — it
  // decisively stays open or closed instead of jittering.
  useEffect(() => {
    if (!onLyricsPage || !hideSidebarOnLyrics) return;
    let frame = 0;
    // The footprint matches the sidebar's intended rendered size
    // (expanded or collapsed per the persistent preference), so hovering
    // anywhere over where the sidebar would sit reveals it. The custom
    // property is a `clamp(...)`, so resolve it to px by measuring a
    // hidden probe element.
    let intendedWidth = 0;
    const measureIntended = () => {
      const root = document.getElementById("root");
      if (!root) return;
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.style.width = `var(${sidebarOpen ? "--ui-sidebar-open" : "--ui-sidebar-closed"})`;
      root.appendChild(probe);
      intendedWidth = parseFloat(getComputedStyle(probe).width) || 0;
      probe.remove();
    };
    measureIntended();
    const handlePointerMove = (event: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const dock = document.querySelector(".player-bar-dock");
        const zoneBottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
        const width = intendedWidth > 0 ? intendedWidth : 64;
        const hideMargin = Math.max(28, Math.round(width * 0.18));
        setLyricsControlsRevealed((revealed) => {
          const abovePlayerBar = event.clientY < zoneBottom;
          if (revealed) {
            // Stay open until the pointer clearly leaves the sidebar.
            return abovePlayerBar && event.clientX < width + hideMargin;
          }
          // Reveal as soon as the pointer approaches the sidebar.
          return abovePlayerBar && event.clientX < width + 12;
        });
      });
    };
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("resize", measureIntended);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("resize", measureIntended);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onLyricsPage, hideSidebarOnLyrics, sidebarOpen]);

  // Hover reveal with hysteresis for Now Playing panel on lyrics page
  useEffect(() => {
    if (!onLyricsPage || !hideNowPlayingOnLyrics || !effectiveNowPlayingOpen) return;
    let frame = 0;
    let intendedWidth = 0;
    const measureIntended = () => {
      const root = document.getElementById("root");
      if (!root) return;
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.style.width = "var(--ui-nowplaying-open)";
      root.appendChild(probe);
      intendedWidth = parseFloat(getComputedStyle(probe).width) || 0;
      probe.remove();
    };
    measureIntended();
    const handlePointerMove = (event: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const dock = document.querySelector(".player-bar-dock");
        const zoneBottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
        const width = intendedWidth > 0 ? intendedWidth : 320;
        const hideMargin = Math.max(28, Math.round(width * 0.18));
        setLyricsNowPlayingRevealed((revealed) => {
          const abovePlayerBar = event.clientY < zoneBottom;
          const distFromRight = window.innerWidth - event.clientX;
          if (revealed) {
            // Stay open until the pointer clearly leaves the now playing panel.
            return abovePlayerBar && distFromRight < width + hideMargin;
          }
          // Reveal as soon as the pointer approaches the now playing panel.
          return abovePlayerBar && distFromRight < width + 12;
        });
      });
    };
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("resize", measureIntended);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("resize", measureIntended);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onLyricsPage, hideNowPlayingOnLyrics, effectiveNowPlayingOpen]);

  // Leaving the lyrics page drops the hover reveal so the sidebar and
  // now playing panel return to their persistent states.
  useEffect(() => {
    if (onLyricsPage) return;
    setLyricsControlsRevealed(false);
    setLyricsNowPlayingRevealed(false);
  }, [onLyricsPage]);

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
      if (mq.matches) setSetting("sidebarOpen", false);
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
    // Hydrate durations + YTM enrichment in small batches, with explicit
    // idle yielding between batches so the main thread stays responsive
    // even with hundreds of local tracks. The previous version fired
    // BATCH_SIZE=4 enrichUploadMetadataFromYtm calls in parallel per chunk
    // with no yielding, which issued dozens of searchMusic IPCs back-to-back
    // and blocked the UI. We now probe durations in parallel but enrich
    // album/artist sequentially with a yield point.
    const DURATION_BATCH = 3;
    const ENRICH_CONCURRENCY = 2;
    // Phase 1: durations only — fast, local, no network.
    for (let i = 0; i < tracks.length; i += DURATION_BATCH) {
      const batch = tracks.slice(i, i + DURATION_BATCH);
      await Promise.all(
        batch.map(async (track) => {
          if (!track.audioSrc || track.durationSeconds) return;
          try {
            const durationSeconds = await readDuration(track.audioSrc);
            if (!durationSeconds) return;
            setUploadedTracks((current) =>
              current.map((entry) =>
                entry.id === track.id ? { ...entry, durationSeconds } : entry,
              ),
            );
            void updateImportedTrackMetadata(track.id, { durationSeconds }).catch(() => undefined);
          } catch {
            // ignore
          }
        }),
      );
      // Yield to the browser so the player bar and list can paint.
      await new Promise<void>((r) => {
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(() => r(), { timeout: 50 });
        } else {
          setTimeout(r, 0);
        }
      });
    }
    // Phase 2: YTM enrichment — network bound, defer to idle and limit concurrency.
    // Only enrich tracks that still have placeholder album names.
    const needsEnrich = tracks.filter(
      (t) => t.title && t.artist && isPlaceholderAlbumName(displayAlbumName(t.album)),
    );
    // Cap enrichment to first 30 tracks to avoid hammering search on huge libraries.
    const enrichSlice = needsEnrich.slice(0, 30);
    for (let i = 0; i < enrichSlice.length; i += ENRICH_CONCURRENCY) {
      const batch = enrichSlice.slice(i, i + ENRICH_CONCURRENCY);
      await Promise.all(
        batch.map(async (track) => {
          try {
            const enrichment = await enrichUploadMetadataFromYtm({
              title: track.title,
              artist: track.artist,
              album: track.album,
            });
            const updates: { album?: string; artist?: string } = {};
            if (enrichment?.album) updates.album = enrichment.album;
            if (enrichment?.artist && isPlaceholderAlbumName(track.artist)) {
              updates.artist = enrichment.artist;
            }
            if (Object.keys(updates).length === 0) return;
            setUploadedTracks((current) =>
              current.map((entry) =>
                entry.id === track.id ? { ...entry, ...updates } : entry,
              ),
            );
            void updateImportedTrackMetadata(track.id, updates).catch(() => undefined);
          } catch {
            // best-effort
          }
        }),
      );
      await new Promise<void>((r) => setTimeout(r, 80));
    }
  }, []);

  useImportedTracksHydration({
    onLoaded: setUploadedTracks,
    onHydrate: hydrateImportedDurations,
  });

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
          goBack();
        } else {
          navigate(showHomeMenu ? { name: "home" } : { name: "collection" });
        }
      }
      playlistsCtx.deletePlaylist(id);
    },
    [view, navigate, playlistsCtx, canBack, goBack, showHomeMenu],
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

  // The sidebar overlays the workspace instead of consuming a flex column,
  // so the page underneath it (hero artwork, gradients, and scrolling
  // content) is the real thing rather than a separately maintained
  // approximation of whichever page happens to be open.
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden text-neutral-100">
      {/* `sidebar-layout-transition` registers + transitions
           `--ui-sidebar-current` (an interpolable <length>, see index.css)
           so the scrollport padding, page hero padding, TopBar inset, and
           every other consumer of the variable glide in sync with the
           sidebar width and the player bar's own 220ms ease-out transition
           instead of snapping on toggle.
           overflow-visible (not hidden) lets the sidebar crescent's
           -bottom-px bleed 1px into the player bar to hide the hairline seam. */}
      <div
        className="sidebar-layout-transition relative flex min-h-0 flex-1 overflow-visible"
        style={{
          "--ui-sidebar-current": lyricsSidebarHidden
            ? "0px"
            : sidebarOpen
              ? "var(--ui-sidebar-open)"
              : "var(--ui-sidebar-closed)",
          "--ui-nowplaying-current": lyricsNowPlayingHidden
            ? "0px"
            : effectiveNowPlayingOpen
              ? "var(--ui-nowplaying-open)"
              : "0px",
          "--ui-page-left-pad": "calc(var(--ui-sidebar-current) + var(--ui-page-pad))",
          "--ui-page-right-pad": "calc(var(--ui-nowplaying-current) + var(--ui-page-pad))",
        } as React.CSSProperties}
      >
        <Sidebar
          key="primary-sidebar"
          view={view}
          expanded={sidebarOpen}
          hidden={lyricsSidebarHidden}
          onToggle={handleToggleSidebar}
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

        <main key="main-content" className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-black">
          <TopBar
            canBack={canBack}
            canForward={canForward}
            suppressHistoryControls={false}

            onBack={goBack}
            onForward={goForward}
            query={searchInput}
            onSearch={searchNow}
            isSearchLoading={isSearchLoading}
            sidebarExpanded={sidebarOpen}
            nowPlayingOpen={effectiveNowPlayingOpen}
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
              isFullBleedView
                ? "px-0"
                : "pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]",
              "pb-0",
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

                {view.name === "lyrics" && <LyricsPage onNavigate={navigate} />}

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

        <NowPlayingPanel
          key="now-playing-panel"
          open={effectiveNowPlayingOpen}
          hidden={lyricsNowPlayingHidden}
          onClose={() => {
            if (onLyricsPage && hideNowPlayingOnLyrics) {
              setLyricsNowPlayingRevealed(false);
            }
            setSetting("nowPlayingOpen", false);
          }}
          onNavigate={navigate}
        />
      </div>

      <PlayerBar
        onNavigate={navigate}
        viewName={view.name}
        nowPlayingOpen={effectiveNowPlayingOpen}
        onToggleNowPlaying={handleToggleNowPlaying}
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
