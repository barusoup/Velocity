import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  CirclePlus,
  Ellipsis,
  Grid3X3,
  List,
  LoaderCircle,
  Music2,
  Pause,
  Play,
} from "lucide-react";
import {
  getArtistDetail,
  getArtistMonthlyListeners,
  getArtistTopSongsExtended,
  getEntityDetail,
  cacheArtwork,
  peekArtistDetail,
  peekArtistMonthlyListeners,
  peekEntityDetail,
} from "../api";
import { AnimatedShuffle } from "./PlayerButtonIcons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type SavedAlbum } from "../collection";
import {
  useIsAlbumSaved,
  useIsArtistSaved,
  useIsTrackSaved,
  useToggleAlbumSave,
  useToggleArtistSave,
  useToggleTrackSave,
} from "../hooks/useCollectionSelectors";
import { usePlayer, usePlayerActions } from "../player";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import {
  useAlbumQueuePlaybackState,
  useReleasePlaybackState,
  useTrackPlaybackState,
} from "../hooks/usePlayerSelectors";
import { VirtualList } from "./VirtualList";
import type { ArtistDetail, EntityDetail, MediaTrack, SearchItem } from "../types";
import { extractInterestingArtworkColor, mixRgb, peekArtworkAccent, rgbToCss } from "../utils/artwork-color";
import {
  filterQueueableTracks,
  formatOptionalDuration,
  formatPlayCount,
  isSameSongTrack,
} from "../utils/media";
import {
  ArtworkImage,
  cardHoverPlayRevealClass,
  cardHoverPlayTransitionClass,
  getArtworkRoundedClass,
  useResolvedArtworkSource,
} from "./Shared";
import { SaveButton } from "./SaveButton";
import { Marquee } from "./Marquee";
import { POPULAR_TRACK_GRID, RELEASE_TRACK_GRID, TrackListHeader } from "./TrackList";
import { AlbumContextMenu } from "./AlbumContextMenu";
import { PageHistoryControls, type View } from "./Sidebar";
import {
  ArtistCreditText,
  ErrorPanel,
  LoadingPanel,
  useArtworkAccent,
} from "./PagesShared";
import { useSetting, setSetting } from "../settings";
import { getDirectArtistBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import { useHorizontalDragScroll } from "../hooks/useHorizontalDragScroll";
import { useTrackMetadataBackfill } from "../hooks/useTrackMetadataBackfill";

export type ReleaseType = "album" | "single" | "compilation";
type ReleaseFilter = "all" | ReleaseType;
type SortMode = "releaseDate" | "name" | "views";
type ViewMode = "list" | "grid";

export type ReleaseItem = SearchItem & {
  releaseType: ReleaseType;
  yearLabel: string | null;
  shelfTitle: string;
};

type ReleaseDetailState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: EntityDetail }
  | { status: "error"; message: string };

// Preserve fully loaded release geometry across Back/Forward navigation. This
// prevents a restored discography from rebuilding as a stack of short loading
// placeholders before expanding to its previous height.
//
// Bounded LRU: a heavy user can visit hundreds of distinct albums across
// thousands of releases. Without a cap, the module-level Map would grow
// forever (each `EntityDetail` carries the full track list + browse ids +
// cover URLs — not small). 200 entries is ~50x the largest plausible
// back/forward stack and well under any reasonable memory budget.
const RELEASE_DETAIL_MEMORY_MAX = 200;
const releaseDetailMemory = new Map<string, EntityDetail>();

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

const MAIN_FILTERS: Array<{ value: ReleaseFilter; label: string }> = [
  { value: "all", label: "Popular releases" },
  { value: "album", label: "Albums" },
  { value: "single", label: "Singles and EPs" },
];

const MAIN_FILTER_ORDER: ReleaseFilter[] = MAIN_FILTERS.map((filter) => filter.value);
const RELEASE_STRIP_MOTION_MS = 400;
const RELEASE_STRIP_STAGGER_MS = 34;
const RELEASE_STRIP_MAX_STAGGER_ITEMS = 10;

const FULL_FILTERS: Array<{ value: ReleaseFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "album", label: "Albums" },
  { value: "single", label: "Singles and EPs" },
];

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "releaseDate", label: "Release date" },
  { value: "name", label: "Name" },
  { value: "views", label: "Views" },
];

// Keep the extra rows mounted until the list's closing motion has finished.
const POPULAR_COLLAPSE_TOTAL_MS = 280;
const DISCOGRAPHY_INITIALIZING_ATTRIBUTE = "data-discography-layout-initializing";
const DISCOGRAPHY_TITLE_WIDTH_PROPERTY = "--discography-title-width";
const DISCOGRAPHY_WINDOW_CONTROLS_WIDTH_PROPERTY = "--discography-window-controls-width";
const DISCOGRAPHY_HISTORY_CONTROLS_WIDTH_PROPERTY = "--discography-history-controls-width";
const DISCOGRAPHY_WINDOW_CONTROLS_FALLBACK_WIDTH = "7.5rem";

function clearDiscographyAdaptiveLayout(headerHost: HTMLElement) {
  headerHost.removeAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE);
  headerHost.removeAttribute("data-discography-title-width");
  headerHost.style.removeProperty(DISCOGRAPHY_TITLE_WIDTH_PROPERTY);
  headerHost.style.removeProperty(DISCOGRAPHY_WINDOW_CONTROLS_WIDTH_PROPERTY);
  headerHost.style.removeProperty(DISCOGRAPHY_HISTORY_CONTROLS_WIDTH_PROPERTY);
}

export function ArtistPage({
  browseId,
  cover,
  context,
  section = "overview",
  navigationKey,
  onOpenItem,
  onPlayTrack,
  onNavigate,
  historyCanBack,
  historyCanForward,
  onHistoryBack,
  onHistoryForward,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
}: {
  browseId: string;
  cover?: string | null;
  context: "default" | "search";
  section?: "overview" | "discography";
  navigationKey: number;
  onOpenItem: (item: SearchItem) => void;
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
  historyCanBack: boolean;
  historyCanForward: boolean;
  onHistoryBack: () => void;
  onHistoryForward: () => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (browseId: string, tracks: MediaTrack[]) => Promise<void> | void;
  resolvePlaylists?: (query: string) => Promise<Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>>;
}) {
  const player = usePlayer();
  // Seed from the synchronous peek so a Back/Forward navigation to an
  // already-visited artist renders its full overview on the very first
  // paint, skipping the loading-panel flash the async `.then` would
  // otherwise produce. The effect below still re-fetches (and re-caches)
  // so a stale peek never traps the page in an outdated state.
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    data?: ArtistDetail;
    error?: string;
  }>(() => {
    const cached = peekArtistDetail(browseId);
    if (cached) return { status: "ready", data: cached };
    return { status: "loading" };
  });
  // Some artist browse responses arrive without `monthlyListenerCount` even
  // though the count is reachable via a re-fetch. Hold the resolved value
  // (when the focused retry picks it up) so we can render without waiting
  // for the main detail call to be re-issued. The seed reads from the
  // dedicated cache so a Back/Forward navigation repaints synchronously.
  const [extraMonthlyListeners, setExtraMonthlyListeners] = useState<string | null>(
    () => peekArtistMonthlyListeners(browseId),
  );
  const [popularExpanded, setPopularExpanded] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [popularCollapsing, setPopularCollapsing] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);
  const popularListRef = useRef<HTMLDivElement>(null);
  const [mainFilter, setMainFilter] = useState<ReleaseFilter>("all");
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<CSSProperties>({});
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("releaseDate");
  const viewMode = useSetting("viewModeDiscography");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const fullDiscographyOpen = section === "discography";

  useEffect(() => {
    let cancelled = false;
    // If the synchronous peek already gave us fresh data, we don't need to
    // flip back to loading — just keep the cached overview visible while the
    // re-fetch settles. Only show the loading panel on a genuine cache miss.
    const cached = peekArtistDetail(browseId);
    if (!cached) setState({ status: "loading" });
    setPopularExpanded(false);
    setShowExtras(false);
    setPopularCollapsing(false);
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }

    const applyArtistDetail = (data: ArtistDetail) => {
      if (cancelled) return;
      setState({ status: "ready", data });
      if (!data.monthlyListeners && !peekArtistMonthlyListeners(browseId)) {
        getArtistMonthlyListeners(browseId)
          .then((value) => {
            if (cancelled) return;
            setExtraMonthlyListeners(value);
          })
          .catch(() => undefined);
      }
    };

    void getArtistDetail(browseId)
      .then((data) => {
        if (cancelled) return;
        applyArtistDetail(data);
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Failed to load artist.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [browseId]);

  useEffect(() => {
    setFilterMenuOpen(false);
    setSortMenuOpen(false);
  }, [fullDiscographyOpen]);

  const detail = state.data ?? null;
  const topSongs = useMemo<MediaTrack[]>(
    () =>
      filterQueueableTracks(
        (detail?.topSongs ?? []).map((track) => ({ ...track, artistBrowseId: browseId })),
      ),
    [browseId, detail?.topSongs],
  );
  const [displayTopSongs, setDisplayTopSongs] = useState<MediaTrack[]>(topSongs);

  useEffect(() => {
    setDisplayTopSongs(topSongs);
  }, [topSongs]);

  useTrackMetadataBackfill(displayTopSongs, setDisplayTopSongs);
  const releases = useMemo<ReleaseItem[]>(
    () => (detail ? buildReleaseItems(detail) : []),
    [detail],
  );
  const mainReleases = useMemo(
    () => filterAndSortReleases(releases, mainFilter, "releaseDate"),
    [mainFilter, releases],
  );

  useLayoutEffect(() => {
    const container = filterBarRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLButtonElement>(
      `[data-filter-value="${mainFilter}"]`,
    );
    if (!active) return;
    setPillStyle({
      width: active.offsetWidth,
      left: active.offsetLeft,
    });
  }, [mainFilter, mainReleases.length]);

  const fullReleases = useMemo(
    () => filterAndSortReleases(releases, releaseFilter, sortMode),
    [releaseFilter, releases, sortMode],
  );

  const showTopTracksExpand =
    (detail?.topSongs.length ?? 0) > 5 || Boolean(detail?.topSongsHasMore);

  const handleTogglePopular = useCallback(async () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }

    if (popularExpanded) {
      // Capture the real list heights before changing state. The collapse can
      // then close the whole panel cleanly without crushing individual rows.
      const list = popularListRef.current;
      if (list) {
        const rows = Array.from(list.children) as HTMLElement[];
        const fifthRow = rows[4];
        const listRect = list.getBoundingClientRect();
        const collapsedHeight = fifthRow
          ? fifthRow.getBoundingClientRect().bottom - listRect.top
          : listRect.height / 2;
        const frozenRows = rows
          .map((row) => `${row.getBoundingClientRect().height}px`)
          .join(" ");
        list.style.setProperty("--popular-expanded-height", `${listRect.height}px`);
        list.style.setProperty("--popular-collapsed-height", `${collapsedHeight}px`);
        list.style.setProperty("--popular-collapse-rows", frozenRows);
      }

      setPopularExpanded(false);
      setPopularCollapsing(true);
      collapseTimerRef.current = window.setTimeout(() => {
        setShowExtras(false);
        setPopularCollapsing(false);
        collapseTimerRef.current = null;
      }, POPULAR_COLLAPSE_TOTAL_MS);
    } else {
      if ((detail?.topSongs.length ?? 0) <= 5 && detail?.topSongsHasMore) {
        try {
          const extended = await getArtistTopSongsExtended(browseId);
          setState((prev) => {
            if (prev.status !== "ready" || !prev.data) return prev;
            return {
              ...prev,
              data: {
                ...prev.data,
                topSongs: extended,
                topSongsHasMore: extended.length > 5 ? false : prev.data.topSongsHasMore,
              },
            };
          });
        } catch {
          // Expand with whatever tracks we already have.
        }
      }

      setShowExtras(true);
      setPopularCollapsing(false);
      requestAnimationFrame(() => {
        setPopularExpanded(true);
      });
    }
  }, [browseId, detail?.topSongs.length, detail?.topSongsHasMore, popularExpanded]);

  if (state.status === "loading") return <LoadingPanel label="Loading artist" />;
  if (state.status === "error") return <ErrorPanel message={state.error ?? "Failed to load artist."} />;
  if (!detail) return <ErrorPanel message="No data available." />;

  const displayCover = detail.cover ?? cover;
  const displayBanner = detail.banner ?? detail.cover ?? cover;

  const openFullDiscography = () => {
    onNavigate({
      name: "artist",
      browseId,
      context,
      cover: displayCover,
      section: "discography",
    });
  };

  const closeFullDiscography = () => {
    onNavigate({
      name: "artist",
      browseId,
      context,
      cover: displayCover,
      section: "overview",
    });
  };

  return (
    <div className="-mt-20 [overflow-x:clip] bg-black">
      <div className={`artist-page-slider ${fullDiscographyOpen ? "is-open" : ""}`}>
        <ArtistOverview
          detail={detail}
          monthlyListeners={detail.monthlyListeners ?? extraMonthlyListeners ?? null}
          browseId={browseId}
          displayCover={displayCover}
          displayBanner={displayBanner}
          topSongs={displayTopSongs}
          showTopTracksExpand={showTopTracksExpand}
          popularExpanded={popularExpanded}
          popularCollapsing={popularCollapsing}
          showExtras={showExtras}
          mainFilter={mainFilter}
          mainReleases={mainReleases}
          filterBarRef={filterBarRef}
          popularListRef={popularListRef}
          pillStyle={pillStyle}
          onTogglePopular={handleTogglePopular}
          onChangeMainFilter={setMainFilter}
          onOpenFullDiscography={openFullDiscography}
          onOpenItem={onOpenItem}
          onPlayTrack={onPlayTrack}
          onNavigate={onNavigate}
        />

        <FullDiscographyView
          active={fullDiscographyOpen}
          navigationKey={navigationKey}
          artistTitle={detail.title}
          artistBrowseId={browseId}
          releases={fullReleases}
          releaseFilter={releaseFilter}
          sortMode={sortMode}
          viewMode={viewMode}
          filterMenuOpen={filterMenuOpen}
          sortMenuOpen={sortMenuOpen}
          onBack={closeFullDiscography}
          onOpenItem={onOpenItem}
          onPlayTrack={onPlayTrack}
          onChangeFilter={setReleaseFilter}
          onChangeSort={setSortMode}
          onChangeViewMode={(mode) => setSetting("viewModeDiscography", mode)}
          onToggleFilterMenu={() => {
            setFilterMenuOpen((open) => !open);
            setSortMenuOpen(false);
          }}
          onToggleSortMenu={() => {
            setSortMenuOpen((open) => !open);
            setFilterMenuOpen(false);
          }}
          currentTrack={player.currentTrack}
          playing={player.isPlaying}
          buffering={player.isBuffering}
          togglePlay={player.togglePlay}
          playMany={player.playMany}
          historyCanBack={historyCanBack}
          historyCanForward={historyCanForward}
          onHistoryBack={onHistoryBack}
          onHistoryForward={onHistoryForward}
          onAddAlbumToQueue={onAddAlbumToQueue}
          onAddAlbumToPlaylist={onAddAlbumToPlaylist}
          resolvePlaylists={resolvePlaylists}

          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function ArtistOverview({
  detail,
  monthlyListeners,
  browseId,
  displayCover,
  displayBanner,
  topSongs,
  showTopTracksExpand,
  popularExpanded,
  popularCollapsing,
  showExtras,
  mainFilter,
  mainReleases,
  filterBarRef,
  popularListRef,
  pillStyle,
  onTogglePopular,
  onChangeMainFilter,
  onOpenFullDiscography,
  onOpenItem,
  onPlayTrack: _onPlayTrack,
  onNavigate,
}: {
  detail: ArtistDetail;
  monthlyListeners: string | null;
  browseId: string;
  displayCover?: string | null;
  displayBanner?: string | null;
  topSongs: MediaTrack[];
  showTopTracksExpand: boolean;
  popularExpanded: boolean;
  popularCollapsing: boolean;
  showExtras: boolean;
  mainFilter: ReleaseFilter;
  mainReleases: ReleaseItem[];
  filterBarRef: RefObject<HTMLDivElement | null>;
  popularListRef: RefObject<HTMLDivElement | null>;
  pillStyle: CSSProperties;
  onTogglePopular: () => void | Promise<void>;
  onChangeMainFilter: (filter: ReleaseFilter) => void;
  onOpenFullDiscography: () => void;
  onOpenItem: (item: SearchItem) => void;
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();
  const isArtistSaved = useIsArtistSaved(browseId);
  const savedArtist = useMemo(
    () => ({
      browseId,
      title: detail.title,
      cover: displayCover ?? null,
      banner: displayBanner ?? null,
      monthlyListeners: monthlyListeners ?? null,
    }),
    [browseId, detail.title, displayCover, displayBanner, monthlyListeners],
  );
  const toggleArtistSave = useToggleArtistSave(savedArtist);
  const [topTrackHovered, setTopTrackHovered] = useState(false);
  const firstTopTrackActive = topSongs[0] ? isSameSongTrack(player.currentTrack, topSongs[0]) : false;
  const handlePlayRelease = useCallback((item: ReleaseItem) => {
    const browseId = item.browseId;
    if (!browseId) return;
    getEntityDetail(browseId).then((entity) => {
      const tracks = entity.tracks.map((t) => ({ ...t, albumBrowseId: browseId }));
      void player.playMany(tracks, 0, { kind: "album", browseId });
    });
  }, [player]);
  const {
    stripRef: releaseStripRef,
    isDragging: isDraggingReleases,
    onPointerDown: handleReleaseStripPointerDown,
    onClickCapture: handleReleaseStripClickCapture,
  } = useHorizontalDragScroll();
  const prevMainFilterRef = useRef(mainFilter);
  const stripMotionTimerRef = useRef<number | null>(null);
  const [stripMotion, setStripMotion] = useState<"forward" | "backward" | null>(null);
  const scrollFadesRef = useRef({ left: false, right: false });
  const updateScrollFadesRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (stripMotionTimerRef.current) {
        window.clearTimeout(stripMotionTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const prev = prevMainFilterRef.current;
    if (prev === mainFilter) return;

    const prevIndex = MAIN_FILTER_ORDER.indexOf(prev);
    const nextIndex = MAIN_FILTER_ORDER.indexOf(mainFilter);
    prevMainFilterRef.current = mainFilter;

    if (prevIndex >= 0 && nextIndex >= 0 && prevIndex !== nextIndex) {
      setStripMotion(nextIndex > prevIndex ? "forward" : "backward");
      if (stripMotionTimerRef.current) {
        window.clearTimeout(stripMotionTimerRef.current);
      }
      const staggerCount = Math.min(mainReleases.length, RELEASE_STRIP_MAX_STAGGER_ITEMS);
      stripMotionTimerRef.current = window.setTimeout(
        () => setStripMotion(null),
        RELEASE_STRIP_MOTION_MS + staggerCount * RELEASE_STRIP_STAGGER_MS,
      );
    }

    const strip = releaseStripRef.current;
    if (strip) {
      strip.scrollLeft = 0;
    }
  }, [mainFilter, mainReleases.length]);

  const applyScrollFades = (strip: HTMLElement, left: boolean, right: boolean) => {
    const hasFade = left || right;
    const value = hasFade
      ? `linear-gradient(to right, ${left ? "rgba(0,0,0,0.5)" : "black"} 0, black 24px, black calc(100% - 24px), ${right ? "rgba(0,0,0,0.5)" : "black"} 100%)`
      : "";
    strip.style.maskImage = value;
    strip.style.webkitMaskImage = value;
  };

  useEffect(() => {
    const strip = releaseStripRef.current;
    if (!strip) return;
    const update = () => {
      const children = strip.children;
      if (children.length === 0) {
        if (scrollFadesRef.current.left || scrollFadesRef.current.right) {
          scrollFadesRef.current = { left: false, right: false };
          applyScrollFades(strip, false, false);
        }
        return;
      }
      const first = children[0] as HTMLElement;
      const last = children[children.length - 1] as HTMLElement;
      const stripRect = strip.getBoundingClientRect();
      const left = first.getBoundingClientRect().left < stripRect.left - 4;
      const right = last.getBoundingClientRect().right > stripRect.right + 4;
      if (scrollFadesRef.current.left !== left || scrollFadesRef.current.right !== right) {
        scrollFadesRef.current = { left, right };
        applyScrollFades(strip, left, right);
      }
    };
    updateScrollFadesRef.current = update;
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(strip);
    return () => {
      updateScrollFadesRef.current = null;
      strip.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    updateScrollFadesRef.current?.();
  }, [mainReleases]);

  const artistOrigin = player.queueOrigin;
  const isArtistActive =
    artistOrigin?.kind === "artist" &&
    artistOrigin.browseId === browseId &&
    player.currentTrack?.artistBrowseId === browseId;
  const isArtistPlaying = isArtistActive && player.isPlaying;
  const isArtistBuffering = isArtistActive && player.isBuffering;
  const resolvedHeroArtwork = useResolvedArtworkSource([displayBanner, displayCover]);
  const accent = useArtworkAccent(resolvedHeroArtwork.src, browseId);
  const hasBanner = Boolean(resolvedHeroArtwork.src);
  const playButtonBg = hasBanner
    ? rgbToCss(mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.22))
    : "#ffffff";
  const releaseCardPlayBg = hasBanner
    ? rgbToCss(mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.24))
    : "#ffffff";
  const heroStyle: CSSProperties = {
    background: "linear-gradient(180deg, #292929 0%, #121212 100%)",
  };

  return (
    <div className="artist-pane w-1/2 shrink-0 min-w-0">
      <section className="relative isolate h-[var(--ui-artist-hero)] overflow-hidden px-[var(--ui-page-pad)] pb-[clamp(1.75rem,2.5vw,2.75rem)] pt-[calc(var(--ui-topbar-height)+1rem)]" style={heroStyle}>
        {resolvedHeroArtwork.src && (
          <>
            <img
              src={resolvedHeroArtwork.src}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover object-top"
              decoding="async"
              loading="eager"
              onError={(event) => {
                resolvedHeroArtwork.onError(event.currentTarget.currentSrc || event.currentTarget.src);
              }}
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.04)_0%,rgba(0,0,0,0.18)_52%,rgba(0,0,0,0.62)_100%)]" />
          </>
        )}
        <div className="relative flex h-full flex-col justify-end">
          <h1 className="max-w-[min(68rem,100%)] break-words text-[clamp(4rem,7vw,9rem)] font-bold leading-[1] text-white drop-shadow-[0_6px_28px_rgba(0,0,0,0.5)]">
            {detail.title}
          </h1>
          {monthlyListeners && (
            <p className="mt-5 pl-2 text-[15px] font-semibold text-white/90 drop-shadow">{monthlyListeners}</p>
          )}
        </div>
      </section>

      <section className="bg-black px-[var(--ui-page-pad)] pb-0 pt-[clamp(1.15rem,2.6vw,1.8rem)]">
        <div className="mb-7 flex items-center gap-6 transition-opacity duration-150">
          {topSongs.length > 0 && (
            <button
              type="button"
              onClick={isArtistActive ? player.togglePlay : () => void player.playMany(topSongs, 0, { kind: "artist", browseId })}
              className="flex h-16 w-16 items-center justify-center rounded-full text-black shadow-[0_12px_36px_rgba(0,0,0,0.36)] transition hover:scale-[1.04] animate-none"
              style={{ backgroundColor: playButtonBg }}
              aria-label={isArtistActive ? (isArtistBuffering ? "Loading" : isArtistPlaying ? "Pause artist" : "Resume artist") : "Play artist"}
            >
              {isArtistBuffering ? (
                <LoaderCircle size={28} className="animate-spin" />
              ) : isArtistPlaying ? (
                <Pause size={28} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={28} fill="currentColor" strokeWidth={0} />
              )}
            </button>
          )}

          <button
            type="button"
              onClick={player.toggleShuffle}
            disabled={topSongs.length === 0}
            className={`flex h-10 w-10 items-center justify-center transition hover:text-white animate-none ${
              player.shuffle ? "text-white" : "text-white/58"
            }`}
            aria-label="Shuffle artist"
          >
            <AnimatedShuffle active={player.shuffle} size={28} />
          </button>

          <SaveButton
            isSaved={isArtistSaved}
            onToggle={toggleArtistSave}
            ariaLabel={isArtistSaved ? "Remove from collection" : "Save artist to collection"}
          />
        </div>

        {topSongs.length > 0 && (
          <section className="mb-16 max-w-[1120px]">
            <div className="mb-2 px-4">
              <h2 className="text-2xl font-semibold text-white">Top Tracks</h2>
            </div>

            <div className={`grid ${POPULAR_TRACK_GRID} gap-3 border-b px-3 py-2.5 text-sm text-white/58 transition-colors duration-150 ${(topTrackHovered || firstTopTrackActive) ? "border-transparent" : "border-white/10"}`}>
              <span className="text-center">#</span>
              <span>Title</span>
              <span className="text-center">Plays</span>
              <span className="flex items-center justify-end pr-[0.4rem]">
                <TrackListHeaderIcon />
              </span>
            </div>

            <div
              ref={popularListRef}
              className={`artist-popular-list ${popularExpanded ? "is-expanded" : ""} ${popularCollapsing ? "is-collapsing" : ""}`}
            >
              {topSongs.slice(0, 5).map((track, index) => (
                <PopularTrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  onPlay={() => void player.playMany(topSongs, index, { kind: "artist", browseId })}
                  onNavigateToAlbum={track.albumBrowseId ? () => onNavigate({ name: "album", browseId: track.albumBrowseId!, context: "default" }) : undefined}
                  onNavigate={onNavigate}
                  onHoverChange={index === 0 ? setTopTrackHovered : undefined}
                  queueOrigin={{ kind: "artist", browseId }}
                />
              ))}
              {showExtras && topSongs.slice(5, 10).map((track, index) => (
                <PopularTrackRow
                  key={track.id}
                  track={track}
                  index={index + 5}
                  isExtra
                  onPlay={() => void player.playMany(topSongs, index + 5, { kind: "artist", browseId })}
                  onNavigateToAlbum={track.albumBrowseId ? () => onNavigate({ name: "album", browseId: track.albumBrowseId!, context: "default" }) : undefined}
                  onNavigate={onNavigate}
                  queueOrigin={{ kind: "artist", browseId }}
                />
              ))}
            </div>
            {showTopTracksExpand && (
              <div className="mt-0 px-3">
                <button
                  type="button"
                  aria-expanded={popularExpanded}
                  disabled={popularCollapsing}
                  onClick={() => void onTogglePopular()}
                  className="py-1.5 whitespace-nowrap text-left text-sm font-semibold text-white/60 transition hover:text-white animate-none"
                  style={{ marginLeft: "calc((2.75rem - 1ch) / 2 - 0.55rem)" }}
                >
                  {popularExpanded ? "Show less" : "Show more"}
                </button>
              </div>
            )}
          </section>
        )}

        <section>
            <div className="max-w-[1120px]">
              <div className="mb-4">
                <h2 className="text-2xl font-extrabold text-white">Discography</h2>
              </div>

              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <div ref={filterBarRef} className="relative flex flex-wrap items-center gap-2">
                  <div
                    className="artist-filter-pill-indicator absolute top-0 left-0 h-8 rounded-full bg-white transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={pillStyle}
                    aria-hidden
                  />
                  {MAIN_FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      data-filter-value={filter.value}
                      onClick={() => onChangeMainFilter(filter.value)}
                      className={`relative z-10 h-8 rounded-full px-3 text-sm font-semibold transition-colors duration-200 animate-none ${
                        mainFilter === filter.value
                        ? "text-black"
                        : "text-white hover:text-white/80"
                      }`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={onOpenFullDiscography}
                  className="h-8 px-1 text-sm font-semibold text-white/58 transition hover:text-white animate-none"
                >
                  Show Discography
                </button>
              </div>

              <div
                  ref={releaseStripRef}
                  className={`artist-release-strip flex gap-3 overflow-x-auto pb-3 pr-6 overscroll-x-contain select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                    isDraggingReleases ? "cursor-grabbing" : "cursor-grab"
                  } ${stripMotion === "forward" ? "is-transitioning-forward" : ""} ${
                    stripMotion === "backward" ? "is-transitioning-backward" : ""
                  }`}
                  onPointerDown={handleReleaseStripPointerDown}
                  onClickCapture={handleReleaseStripClickCapture}
                >
                  {mainReleases.map((item, index) => (
                    <div
                      key={`${mainFilter}-${item.id}`}
                      className="artist-release-strip-card w-[clamp(10.25rem,15.3125vw,12.25rem)] shrink-0"
                      style={
                        {
                          "--domino-index": Math.min(index, RELEASE_STRIP_MAX_STAGGER_ITEMS),
                        } as CSSProperties
                      }
                    >
                      <ReleaseCard
                        item={item}
                        onOpen={() => onOpenItem(item)}
                        onPlay={() => handlePlayRelease(item)}
                        playBgColor={releaseCardPlayBg}
                        playButtonSize="lg"
                        artistBrowseId={browseId}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </section>
      </section>
    </div>
  );
}

function PopularTrackRow({
  track,
  index,
  isExtra,
  onPlay,
  onNavigateToAlbum,
  onNavigate,
  onHoverChange,
  queueOrigin: _queueOrigin,
}: {
  track: MediaTrack;
  index: number;
  isExtra?: boolean;
  onPlay: () => void;
  onNavigateToAlbum?: () => void;
  onNavigate?: (view: View) => void;
  onHoverChange?: (hovered: boolean) => void;
  queueOrigin?: import("../player").QueueOrigin | null;
}) {
  const { togglePlay } = usePlayerActions();
  const { active, playingActive, bufferingActive } = useTrackPlaybackState(track);
  const contextTarget = useContextTrackTarget(track);
  const isSaved = useIsTrackSaved(track);
  const toggleSave = useToggleTrackSave(track);
  const directArtistBrowseId = onNavigate ? getDirectArtistBrowseId(track) : null;
  const handleResolveNavigate = useCallback(() => {
    if (!onNavigate) return;
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);
  const handleResolveArtistName = useCallback((artistName: string) => {
    if (!onNavigate) return;
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate]);

  return (
    <div
      {...contextTarget}
      className={`popular-track-row group grid ${POPULAR_TRACK_GRID} cursor-pointer items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-neutral-900 ${active ? "bg-white/[0.04]" : ""} ${isExtra ? "is-extra" : ""}`}
      style={isExtra ? ({ "--domino-index": index - 5 } as CSSProperties) : undefined}
      onClick={active ? togglePlay : onPlay}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="relative flex min-h-[var(--ui-art-row)] items-center justify-center">
        <span className={`text-[15px] font-semibold tabular-nums text-neutral-300 transition-opacity ${active ? "opacity-0" : "group-hover:opacity-0"}`}>
          {index + 1}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? togglePlay : onPlay)();
          }}
          className={`absolute inset-0 flex items-center justify-center text-white animate-none ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={playingActive ? "Pause track" : "Play track"}
        >
          {bufferingActive ? (
            <LoaderCircle size={17} className="animate-spin" />
          ) : playingActive ? (
            <Pause size={18} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={16} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-[clamp(0.75rem,1.8vw,1.15rem)]">
        <div className={`h-[var(--ui-art-row)] w-[var(--ui-art-row)] shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`}>
          {track.cover ? (
            <ArtworkImage src={track.cover} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-neutral-500">
              <Music2 size={16} />
            </div>
          )}
        </div>

        <div className="min-w-0 overflow-hidden">
          {onNavigateToAlbum ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToAlbum();
              }}
              className="block w-full text-left text-lg font-semibold text-white transition hover:text-white/95 focus-visible:outline-none animate-none"
            >
              <Marquee className="text-lg font-semibold text-inherit">{track.title}</Marquee>
            </button>
          ) : (
            <Marquee className="text-lg font-semibold text-white">{track.title}</Marquee>
          )}
          <div className="truncate text-sm font-semibold text-neutral-400">
            {onNavigate ? (
              <ArtistCreditText
                artist={track.artist}
                artistBrowseId={track.artistBrowseId}
                artistCredits={track.artistCredits}
                context="default"
                onNavigate={onNavigate}
                onResolveNavigate={directArtistBrowseId ? null : handleResolveNavigate}
                onResolveArtistName={handleResolveArtistName}
              />
            ) : (
              track.artist
            )}
          </div>
        </div>
        {track.source !== "upload" && (
          <div
            className="shrink-0 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all"
            onClick={(event) => event.stopPropagation()}
          >
            <SaveButton
              isSaved={isSaved}
              size="sm"
              onToggle={toggleSave}
              ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
            />
          </div>
        )}
      </div>

      {track.playCount && (
        <div className="self-center whitespace-nowrap text-center text-sm tabular-nums text-neutral-300">
          {formatPlayCount(track.playCount)}
        </div>
      )}

      <div className="whitespace-nowrap text-right text-sm tabular-nums text-neutral-300">
        {formatOptionalDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

function TrackListHeaderIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 8.3v4.2" /></svg>;
}

function encodeAlbumForContextMenu(item: ReleaseItem): string {
  return JSON.stringify({
    browseId: item.browseId,
    title: item.title,
    subtitle: item.subtitle,
    cover: item.cover,
    byline: item.artist,
    year: item.yearLabel,
    artistBrowseId: item.artistBrowseId,
  });
}

export function ReleaseCard({
  item,
  onOpen,
  onPlay,
  playBgColor,
  className = "",
  style,
  metaExtra,
  suppressContextMenu,
  artistBrowseId: _artistBrowseId,
  playButtonSize = "md",
}: {
  item: ReleaseItem;
  onOpen: () => void;
  onPlay?: () => void;
  playBgColor: string;
  className?: string;
  style?: CSSProperties;
  metaExtra?: React.ReactNode;
  suppressContextMenu?: boolean;
  artistBrowseId?: string | null;
  playButtonSize?: "md" | "lg";
}) {
  const { togglePlay } = usePlayerActions();
  const {
    active: isCurrentAlbum,
    playingActive: playing,
    bufferingActive: buffering,
  } = useAlbumQueuePlaybackState(item.browseId);
  const playButtonClass = playButtonSize === "lg" ? "h-14 w-14" : "h-12 w-12";
  const playIconSize = playButtonSize === "lg" ? 24 : 20;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      {...(suppressContextMenu
        ? {}
        : {
            "data-album-context-target": "true" as const,
            "data-album": encodeAlbumForContextMenu(item),
          })}
      className={`group block w-full min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none animate-none ${className}`}
      style={style}
    >
      <div className={`relative aspect-square overflow-hidden bg-neutral-900 shadow-[0_8px_22px_rgba(0,0,0,0.32)] ${getArtworkRoundedClass()}`}>
        {item.cover ? (
          <ArtworkImage src={item.cover} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-white/30">
            <Music2 size={22} />
          </div>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (isCurrentAlbum) {
              togglePlay();
            } else if (onPlay) {
              onPlay();
            }
          }}
          className={`absolute bottom-2 right-2 flex ${playButtonClass} items-center justify-center rounded-full text-black shadow-lg ${cardHoverPlayTransitionClass} ${cardHoverPlayRevealClass()}`}
          style={{ backgroundColor: playBgColor }}
          aria-label={buffering ? "Loading" : playing ? "Pause release" : "Play release"}
        >
          {buffering ? (
            <LoaderCircle size={playIconSize} className="animate-spin" />
          ) : playing ? (
            <Pause size={playIconSize} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={playIconSize} fill="currentColor" strokeWidth={0} className="translate-x-[1.5px]" />
          )}
        </button>
      </div>
      <div className="mt-2 min-w-0">
        <Marquee className="text-[15px] font-semibold text-white/92">{item.title}</Marquee>
        <div className="mt-0.5 truncate text-[12px] text-white/50">
          {formatReleaseMeta(item)}
          {metaExtra}
        </div>
      </div>
    </div>
  );
}

function FullDiscographyView({
  active,
  navigationKey,
  artistTitle,
  artistBrowseId,
  releases,
  releaseFilter,
  sortMode,
  viewMode,
  filterMenuOpen,
  sortMenuOpen,
  onBack,
  onOpenItem,
  onPlayTrack,
  onChangeFilter,
  onChangeSort,
  onChangeViewMode,
  onToggleFilterMenu,
  onToggleSortMenu,
  currentTrack,
  playing,
  buffering,
  togglePlay,
  playMany,
  historyCanBack,
  historyCanForward,
  onHistoryBack,
  onHistoryForward,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
  onNavigate,
}: {
  active: boolean;
  navigationKey: number;
  artistTitle: string;
  artistBrowseId?: string | null;
  releases: ReleaseItem[];
  releaseFilter: ReleaseFilter;
  sortMode: SortMode;
  viewMode: ViewMode;
  filterMenuOpen: boolean;
  sortMenuOpen: boolean;
  onBack: () => void;
  onOpenItem: (item: SearchItem) => void;
  onPlayTrack: (track: MediaTrack) => void;
  onChangeFilter: (filter: ReleaseFilter) => void;
  onChangeSort: (sort: SortMode) => void;
  onChangeViewMode: (mode: ViewMode) => void;
  onToggleFilterMenu: () => void;
  onToggleSortMenu: () => void;
  currentTrack: MediaTrack | null;
  playing: boolean;
  buffering: boolean;
  togglePlay: () => void;
  playMany: (tracks: MediaTrack[], startIndex?: number) => void;
  historyCanBack: boolean;
  historyCanForward: boolean;
  onHistoryBack: () => void;
  onHistoryForward: () => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (browseId: string, tracks: MediaTrack[]) => Promise<void> | void;
  resolvePlaylists?: (query: string) => Promise<Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>>;
  onNavigate?: (view: View) => void;
}) {
  const [details, setDetails] = useState<Record<string, ReleaseDetailState>>(() => {
    const restored: Record<string, ReleaseDetailState> = {};
    releases.forEach((release) => {
      if (!release.browseId) return;
      // Prefer the dedicated discography memory (set after a prior
      // discography visit), then fall back to the shared entity cache peek
      // (set when the user opened this album directly via its own page).
      // Seeding from either means a Back/Forward return to the discography
      // can render the already-loaded track lists on the first paint.
      const cached = releaseDetailMemory.get(release.browseId) ?? peekEntityDetail(release.browseId);
      if (cached) restored[release.browseId] = { status: "ready", data: cached };
    });
    return restored;
  });
  const player = usePlayer();
  const handlePlayRelease = useCallback((release: ReleaseItem) => {
    const browseId = release.browseId;
    if (!browseId) return;
    const playEntity = (entity: EntityDetail) => {
      const tracks = entity.tracks.map((t) => ({ ...t, albumBrowseId: browseId }));
      if (tracks.length === 0) return;
      void player.playMany(tracks, 0, { kind: "album", browseId });
    };
    const cached = details[browseId];
    if (cached?.status === "ready") {
      playEntity(cached.data);
      return;
    }
    void getEntityDetail(browseId).then(playEntity).catch(() => undefined);
  }, [details, player]);
  const [stickyHeaderVisible, setStickyHeaderVisible] = useState(false);
  const [stickyResolved, setStickyResolved] = useState(false);
  const [stickyResolvedNavigationKey, setStickyResolvedNavigationKey] = useState(navigationKey);
  const [stickyReleaseKey, setStickyReleaseKey] = useState<string | null>(null);
  const [stickyAccent, setStickyAccent] = useState<{ r: number; g: number; b: number } | null>(null);
  const [stickyAccentCover, setStickyAccentCover] = useState<string | null>(null);
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const releaseIdsKey = useMemo(
    () => releases.map((release) => release.browseId).filter(Boolean).join("|"),
    [releases],
  );
  const menuTriggerClassName =
    "inline-flex min-h-10 items-center px-3 py-2 text-left transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 animate-none";
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const stickyReleaseTitleRef = useRef<HTMLDivElement>(null);
  const stickyHistoryControlsRef = useRef<HTMLDivElement>(null);
  const stickyControlsRef = useRef<HTMLDivElement>(null);
  const adaptiveStickyReleaseRef = useRef<ReleaseItem | null>(null);
  const requestAdaptiveLayoutRef = useRef<(() => void) | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const releaseNodesRef = useRef(new Map<string, HTMLElement>());
  const stickyMetricsRef = useRef<{
    headerThresholdOffset: number;
    releaseAnchors: Array<{ top: number; key: string }>;
    revealScrollTop: number;
  }>({
    headerThresholdOffset: 0,
    releaseAnchors: [],
    revealScrollTop: 24,
  });

  const getReleaseKey = useCallback((release: ReleaseItem) => release.browseId ?? release.id, []);
  const stickyRelease = useMemo(
    () => releases.find((release) => getReleaseKey(release) === stickyReleaseKey) ?? null,
    [getReleaseKey, releases, stickyReleaseKey],
  );
  const hasStickyRelease = Boolean(stickyRelease);
  adaptiveStickyReleaseRef.current = stickyRelease;

  useLayoutEffect(() => {
    let cancelled = false;
    const cover = stickyRelease?.cover;
    if (!cover) {
      setStickyAccentCover(null);
      return;
    }

    const cachedAccent = peekArtworkAccent(cover);
    if (cachedAccent) {
      setStickyAccent(cachedAccent);
      setStickyAccentCover(cover);
      return;
    }

    const normalized = cover.startsWith("//") ? `https:${cover}` : cover;
    const resolveSrc =
      normalized.startsWith("asset://") || normalized.startsWith("blob:")
        ? Promise.resolve(normalized)
        : cacheArtwork(normalized)
            .then((filePath) => convertFileSrc(filePath))
            .catch(() => normalized);

    resolveSrc
      .then((src) => extractInterestingArtworkColor(src))
      .then((accent) => {
        if (!cancelled) {
          setStickyAccent(accent);
          setStickyAccentCover(cover);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStickyAccent(null);
          setStickyAccentCover(cover);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [stickyRelease?.cover]);

  const setReleaseNode = useCallback(
    (release: ReleaseItem, node: HTMLElement | null) => {
      const key = getReleaseKey(release);
      if (node) {
        releaseNodesRef.current.set(key, node);
      } else {
        releaseNodesRef.current.delete(key);
      }
    },
    [getReleaseKey],
  );

  const stickyHistoryControlsWidth =
    historyCanBack && historyCanForward ? 84 : historyCanBack || historyCanForward ? 44 : 0;
  const stickyHistoryControlsGap =
    stickyHistoryControlsWidth === 44 ? 12 : stickyHistoryControlsWidth > 0 ? 8 : 0;
  const safeWindowControlsWidth =
    `var(${DISCOGRAPHY_WINDOW_CONTROLS_WIDTH_PROPERTY}, ${DISCOGRAPHY_WINDOW_CONTROLS_FALLBACK_WIDTH})`;

  const measureStickyMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!(scrollContainer instanceof HTMLElement)) return;

    const scrollRect = scrollContainer.getBoundingClientRect();
    const windowControls = headerHost?.querySelector<HTMLElement>(".topbar-window-controls") ?? null;
    if (headerHost) {
      const windowControlsWidth = windowControls?.getBoundingClientRect().width ?? 0;
      headerHost.style.setProperty(
        DISCOGRAPHY_WINDOW_CONTROLS_WIDTH_PROPERTY,
        `${Math.max(0, Math.ceil(windowControlsWidth))}px`,
      );
      headerHost.style.setProperty(
        DISCOGRAPHY_HISTORY_CONTROLS_WIDTH_PROPERTY,
        `${stickyHistoryControlsWidth}px`,
      );
    }
    const rootElement = document.getElementById("root") ?? document.documentElement;
    const topbarHeight =
      Number.parseFloat(getComputedStyle(rootElement).getPropertyValue("--ui-topbar-height")) || 72;
    const controlsHeight =
      stickyControlsRef.current?.getBoundingClientRect().height ?? 48;
    const headerHeight =
      stickyHeaderRef.current?.getBoundingClientRect().height ?? topbarHeight + controlsHeight + 56;
    const releaseAnchors =
      viewMode === "list"
        ? releases
            .map((release) => {
              const node = releaseNodesRef.current.get(getReleaseKey(release));
              if (!node) return null;
              const titleNode = node.querySelector<HTMLElement>("[data-discography-release-title]");
              const titleRect = (titleNode ?? node).getBoundingClientRect();
              return {
                top: titleRect.top - scrollRect.top + scrollContainer.scrollTop,
                key: getReleaseKey(release),
              };
            })
            .filter((anchor): anchor is { top: number; key: string } => anchor !== null)
        : [];
    const revealScrollTop = releaseAnchors[0]
      ? Math.max(topbarHeight, releaseAnchors[0].top - headerHeight - 8)
      : topbarHeight + 24;

    stickyMetricsRef.current = {
      headerThresholdOffset: headerHeight + 8,
      releaseAnchors,
      revealScrollTop,
    };
  }, [getReleaseKey, headerHost, releases, stickyHistoryControlsWidth, viewMode]);

  useEffect(() => {
    if (!filterMenuOpen && !sortMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-discography-menu-scope]")) return;
      if (filterMenuOpen) onToggleFilterMenu();
      if (sortMenuOpen) onToggleSortMenu();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [filterMenuOpen, onToggleFilterMenu, onToggleSortMenu, sortMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    if (viewMode !== "list") return;
    const targets = releases.filter((release) => release.browseId);
    if (targets.length === 0) return;

    setDetails((current) => {
      const next = { ...current };
      targets.forEach((release) => {
        if (release.browseId && !next[release.browseId]) {
          next[release.browseId] = { status: "loading" };
        }
      });
      return next;
    });

    // Resolve each release independently and update state as each one
    // settles, instead of gating the whole list on `Promise.all`. A
    // discography can have 50+ releases; waiting for all of them before
    // showing any track list meant one slow request blanked the entire
    // view. Progressive updates let the visible releases fill in as soon
    // as their data is ready.
    const active = new Set(targets.map((release) => release.browseId!));
    targets.forEach((release) => {
      const browseId = release.browseId!;
      void getEntityDetail(browseId)
        .then((data) => {
          if (cancelled || !active.has(browseId)) return;
          rememberBounded(releaseDetailMemory, browseId, data, RELEASE_DETAIL_MEMORY_MAX);
          setDetails((current) => ({
            ...current,
            [browseId]: { status: "ready", data },
          }));
        })
        .catch((error) => {
          if (cancelled || !active.has(browseId)) return;
          setDetails((current) => ({
            ...current,
            [browseId]: {
              status: "error",
              message: error instanceof Error ? error.message : "Could not load this release.",
            },
          }));
        });
    });

    return () => {
      cancelled = true;
    };
  }, [releaseIdsKey, releases, viewMode]);

  useLayoutEffect(() => {
    if (!active) {
      scrollContainerRef.current = null;
      setHeaderHost(null);
      return;
    }
    scrollContainerRef.current = stickySentinelRef.current?.closest(".nice-scroll") as HTMLElement | null;
    if (!(scrollContainerRef.current instanceof HTMLElement)) return;
    const nextHeaderHost = scrollContainerRef.current.parentElement;
    setHeaderHost(nextHeaderHost);
    // Returning to a scrolled full-discography page restores the scroll
    // position in the parent layout effect, after this child effect has already
    // run. The sticky header then resolves on the next animation frame. Mark
    // the topbar as initializing immediately so the global history pill cannot
    // paint for one frame in the sticky header's slot before the sticky header
    // retakes ownership of that space.
    nextHeaderHost?.setAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE, "");

    const handleResize = () => {
      setLayoutRevision((current) => current + 1);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      nextHeaderHost?.removeAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE);
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;
    measureStickyMetrics();
  }, [active, details, headerHost, layoutRevision, measureStickyMetrics]);

  useLayoutEffect(() => {
    if (!active) {
      setStickyHeaderVisible(false);
      setStickyResolved(false);
      setStickyReleaseKey(null);
      return;
    }

    const scrollContainer = scrollContainerRef.current;
    if (!(scrollContainer instanceof HTMLElement)) return;

    let frame = 0;
    let restoredScrollFrame = 0;
    const updateStickyHeader = () => {
      frame = 0;
      const { headerThresholdOffset, releaseAnchors, revealScrollTop } = stickyMetricsRef.current;
      const scrollTop = scrollContainer.scrollTop;
      // Grid mode releases the sticky header entirely — there's no per-release
      // anchor to track, so the bar would otherwise render an empty slot.
      // Keeping it off also avoids the [data-discography-sticky] CSS rule
      // hiding the topbar search/history controls when there's nothing to
      // replace them with.
      const shouldShow = viewMode === "list" && scrollTop >= revealScrollTop;

      setStickyHeaderVisible((visible) => (visible === shouldShow ? visible : shouldShow));

      if (!shouldShow || viewMode !== "list" || releaseAnchors.length === 0) {
        setStickyReleaseKey((current) => (current === null ? current : null));
        setStickyResolvedNavigationKey(navigationKey);
        setStickyResolved(true);
        if (!shouldShow) {
          scrollContainer.parentElement?.removeAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE);
        }
        return;
      }

      const headerBottom = scrollTop + headerThresholdOffset;
      let low = 0;
      let high = releaseAnchors.length - 1;
      let nextKey: string | null = null;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (releaseAnchors[mid].top <= headerBottom) {
          nextKey = releaseAnchors[mid].key;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      setStickyReleaseKey((current) => (current === nextKey ? current : nextKey));
      setStickyResolvedNavigationKey(navigationKey);
      setStickyResolved(true);
    };

    const requestUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateStickyHeader);
    };

    const requestRestoredScrollChecks = (remaining: number) => {
      if (remaining <= 0 || restoredScrollFrame) return;
      restoredScrollFrame = window.requestAnimationFrame(() => {
        restoredScrollFrame = 0;
        measureStickyMetrics();
        requestUpdate();
        requestRestoredScrollChecks(remaining - 1);
      });
    };

    setStickyResolved(false);
    requestUpdate();
    requestRestoredScrollChecks(4);
    scrollContainer.addEventListener("scroll", requestUpdate, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (restoredScrollFrame) window.cancelAnimationFrame(restoredScrollFrame);
      scrollContainer.removeEventListener("scroll", requestUpdate);
    };
  }, [active, details, layoutRevision, measureStickyMetrics, navigationKey, viewMode]);

  useLayoutEffect(() => {
    if (!headerHost) return;
    if (stickyHeaderVisible) {
      headerHost.setAttribute("data-discography-sticky", "");
    } else {
      headerHost.removeAttribute("data-discography-sticky");
    }
    return () => {
      headerHost.removeAttribute("data-discography-sticky");
    };
  }, [headerHost, stickyHeaderVisible]);

  useLayoutEffect(() => {
    if (!headerHost || !stickyHeaderVisible) return;

    const windowControls = headerHost.querySelector<HTMLElement>(".topbar-window-controls");
    const historyControls = stickyHistoryControlsRef.current;
    const title = stickyReleaseTitleRef.current;
    if (!windowControls || !title) return;

    headerHost.setAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE, "");

    const measurementContext = document.createElement("canvas").getContext("2d");
    let layoutFrame = 0;
    let initializationFrame = 0;

    const finishInitialization = () => {
      if (!headerHost.hasAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE) || initializationFrame) return;
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = 0;
        headerHost.removeAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE);
      });
    };

    const measureAndApplyLayout = () => {
      layoutFrame = 0;
      const currentRelease = adaptiveStickyReleaseRef.current;
      if (!currentRelease) {
        headerHost.style.removeProperty(DISCOGRAPHY_TITLE_WIDTH_PROPERTY);
        finishInitialization();
        return;
      }

      headerHost.style.removeProperty(DISCOGRAPHY_TITLE_WIDTH_PROPERTY);
      headerHost.removeAttribute("data-discography-title-width");

      const titleRect = title.getBoundingClientRect();
      const windowControlsRect = windowControls.getBoundingClientRect();
      const historyControlsRect = historyControls?.getBoundingClientRect() ?? null;
      const hasHistoryNav = historyCanBack || historyCanForward;

      const gap = 20;

      const titleStyle = getComputedStyle(title);
      if (measurementContext) measurementContext.font = titleStyle.font;
      const measuredTitleWidth = measurementContext?.measureText(currentRelease.title).width ?? 0;
      const naturalTitleWidth = Math.max(
        titleRect.width,
        title.scrollWidth,
        measuredTitleWidth,
      );

      const availableWidth =
        (hasHistoryNav && historyControlsRect ? historyControlsRect.left : windowControlsRect.left) -
        titleRect.left -
        gap;

      if (naturalTitleWidth > availableWidth + 1) {
        const clampedWidth = `${Math.max(0, Math.floor(availableWidth))}px`;
        headerHost.style.setProperty(DISCOGRAPHY_TITLE_WIDTH_PROPERTY, clampedWidth);
        headerHost.setAttribute("data-discography-title-width", clampedWidth);
      }

      finishInitialization();
    };

    const requestLayout = () => {
      if (layoutFrame) return;
      layoutFrame = window.requestAnimationFrame(measureAndApplyLayout);
    };

    const observer = new ResizeObserver(requestLayout);
    observer.observe(title);
    observer.observe(windowControls);
    if (historyControls) observer.observe(historyControls);
    requestAdaptiveLayoutRef.current = requestLayout;
    requestLayout();

    document.fonts?.ready.then(requestLayout).catch(() => undefined);

    return () => {
      observer.disconnect();
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      if (initializationFrame) window.cancelAnimationFrame(initializationFrame);
      requestAdaptiveLayoutRef.current = null;
      headerHost.removeAttribute(DISCOGRAPHY_INITIALIZING_ATTRIBUTE);
      clearDiscographyAdaptiveLayout(headerHost);
    };
  }, [headerHost, stickyHeaderVisible, hasStickyRelease, historyCanBack, historyCanForward]);

  useLayoutEffect(() => {
    requestAdaptiveLayoutRef.current?.();
  }, [headerHost, stickyReleaseKey, stickyRelease?.title, historyCanBack, historyCanForward]);

  const stickyHeaderReady = active && stickyHeaderVisible && stickyResolved && stickyResolvedNavigationKey === navigationKey;
  const stickyDisplayRelease = stickyHeaderReady ? stickyRelease : null;
  const stickyCover = stickyDisplayRelease?.cover ?? null;
  const stickyColorReady = stickyCover === null || stickyAccentCover === stickyCover;
  const resolvedStickyAccent = stickyColorReady && stickyAccent
    ? stickyAccent
    : { r: 148, g: 84, b: 71 };
  const stickyHeroTop = mixRgb(resolvedStickyAccent, { r: 0, g: 0, b: 0 }, 0.34);
  const stickyBannerColor = stickyDisplayRelease
    ? rgbToCss(mixRgb(stickyHeroTop, { r: 12, g: 12, b: 12 }, 0.25))
    : "#0a0a0a";
  const stickyPlayColor = rgbToCss(mixRgb(resolvedStickyAccent, { r: 255, g: 255, b: 255 }, 0.22));
  const stickyReleaseActive =
    Boolean(stickyDisplayRelease?.browseId) &&
    player.currentTrack?.albumBrowseId === stickyDisplayRelease?.browseId;
  const stickyReleasePlaying = stickyReleaseActive && player.isPlaying;
  const stickyReleaseBuffering = stickyReleaseActive && player.isBuffering;

  return (
    <>
      {active && headerHost &&
        createPortal(
          <div
            ref={stickyHeaderRef}
            className={`artist-discography-sticky absolute inset-x-0 -top-px z-40 overflow-visible shadow-[0_10px_36px_rgba(0,0,0,0.32)] ${
              stickyHeaderReady
                ? "is-visible pointer-events-auto"
                : "pointer-events-none"
            }`}
            aria-hidden={!stickyHeaderReady}
            style={{ backgroundColor: stickyBannerColor }}
          >
            <div className="pt-[calc(0.5rem+1px)] transition-colors duration-300">
              <div
                className="relative flex items-center gap-3.5"
                style={{
                  paddingLeft: "var(--ui-page-pad)",
                  paddingRight:
                    `calc(0.5rem + ${safeWindowControlsWidth} + ${stickyHistoryControlsWidth}px + ${stickyHistoryControlsGap}px)`,
                }}
              >
                {stickyDisplayRelease && (
                  <button
                    type="button"
                    disabled={!stickyDisplayRelease.browseId}
                    onClick={() => {
                      if (stickyReleaseActive) {
                        player.togglePlay();
                      } else {
                        handlePlayRelease(stickyDisplayRelease);
                      }
                    }}
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-black shadow-sm transition hover:scale-[1.04] disabled:opacity-45 animate-none"
                    style={{ backgroundColor: stickyPlayColor }}
                    aria-label={
                      stickyReleaseBuffering
                        ? "Loading release"
                        : stickyReleasePlaying
                          ? "Pause release"
                          : "Play release"
                    }
                  >
                    {stickyReleaseBuffering ? (
                      <LoaderCircle size={21} className="animate-spin" />
                    ) : stickyReleasePlaying ? (
                      <Pause size={21} fill="currentColor" strokeWidth={0} />
                    ) : (
            <Play size={20} fill="currentColor" strokeWidth={0} className="-translate-x-[0.5px]" />
                    )}
                  </button>
                )}
                <div
                  ref={stickyReleaseTitleRef}
                  className="artist-discography-release-title min-w-0 flex-1 text-2xl font-semibold text-white"
                >
                  {stickyDisplayRelease && <Marquee>{stickyDisplayRelease.title}</Marquee>}
                </div>
                <PageHistoryControls
                  ref={stickyHistoryControlsRef}
                  canBack={historyCanBack}
                  canForward={historyCanForward}
                  onBack={onHistoryBack}
                  onForward={onHistoryForward}
                  animated={false}
                  buttonTextClassName="text-white/72"
                  className="artist-discography-history-controls absolute top-1/2 z-40 shrink-0 -translate-y-1/2"
                  style={{
                    right: `calc(0.5rem + ${safeWindowControlsWidth} + ${stickyHistoryControlsGap}px)`,
                  } as CSSProperties}
                />
              </div>

              <div className="h-2" />

              <div
                className="bg-neutral-950"
                style={{
                  paddingLeft: "var(--ui-page-pad)",
                  paddingRight: "var(--ui-page-pad)",
                }}
              >
                <DiscographyHeaderControls
                  ref={stickyControlsRef}
                  artistTitle={artistTitle}
                  releaseFilter={releaseFilter}
                  sortMode={sortMode}
                  viewMode={viewMode}
                  filterMenuOpen={filterMenuOpen && stickyHeaderVisible}
                  sortMenuOpen={sortMenuOpen && stickyHeaderVisible}
                  menuTriggerClassName={menuTriggerClassName}
                  className="!pb-0"
                  onBack={onBack}
                  onChangeFilter={onChangeFilter}
                  onChangeSort={onChangeSort}
                  onChangeViewMode={onChangeViewMode}
                  onToggleFilterMenu={onToggleFilterMenu}
                  onToggleSortMenu={onToggleSortMenu}
                />
              </div>
            </div>
          </div>,
          headerHost,
        )}

      <div className="artist-pane w-1/2 shrink-0 min-w-0 bg-black px-[var(--ui-page-pad)] pb-[calc(var(--ui-player-bottom)+var(--ui-player-height)+1.25rem)] pt-[calc(var(--ui-topbar-height)+5rem)]">
        <div className="mx-auto max-w-[1120px] pt-1">
          <DiscographyHeaderControls
            artistTitle={artistTitle}
            releaseFilter={releaseFilter}
            sortMode={sortMode}
            viewMode={viewMode}
            filterMenuOpen={filterMenuOpen && !stickyHeaderVisible}
            sortMenuOpen={sortMenuOpen && !stickyHeaderVisible}
            menuTriggerClassName={menuTriggerClassName}
            onBack={onBack}
            onChangeFilter={onChangeFilter}
            onChangeSort={onChangeSort}
            onChangeViewMode={onChangeViewMode}
            onToggleFilterMenu={onToggleFilterMenu}
            onToggleSortMenu={onToggleSortMenu}
          />
        </div>
        <div ref={stickySentinelRef} className="h-px" aria-hidden="true" />

        {viewMode === "grid" ? (
          <div className="mx-auto grid max-w-[var(--ui-content-max)] grid-cols-[repeat(auto-fill,minmax(clamp(8.5rem,14vw,11.5rem),1fr))] gap-2">
            {releases.map((release, index) => (
              <ReleaseCard
                key={release.id}
                item={release}
                onOpen={() => onOpenItem(release)}
                onPlay={() => handlePlayRelease(release)}
                playBgColor="#ffffff"
                className="artist-discography-card"
                style={{ "--domino-index": index } as CSSProperties}
                suppressContextMenu
                artistBrowseId={artistBrowseId}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-16">
            {releases.map((release, index) => (
              <DiscographyRelease
                key={release.id}
                release={release}
                dominoIndex={index}
                sectionRef={(node) => setReleaseNode(release, node)}
                state={release.browseId ? details[release.browseId] : undefined}
                onOpen={() => onOpenItem(release)}
                onPlayTrack={onPlayTrack}
                currentTrack={currentTrack}
                playing={playing}
                buffering={buffering}
              togglePlay={togglePlay}
                playMany={playMany}
                onAddAlbumToQueue={onAddAlbumToQueue}
                onAddAlbumToPlaylist={onAddAlbumToPlaylist}
                resolvePlaylists={resolvePlaylists}
      
                onNavigate={onNavigate}
                artistBrowseId={artistBrowseId}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const DiscographyHeaderControls = forwardRef<HTMLDivElement, {
  artistTitle: string;
  releaseFilter: ReleaseFilter;
  sortMode: SortMode;
  viewMode: ViewMode;
  filterMenuOpen: boolean;
  sortMenuOpen: boolean;
  menuTriggerClassName: string;
  className?: string;
  onBack: () => void;
  onChangeFilter: (filter: ReleaseFilter) => void;
  onChangeSort: (sort: SortMode) => void;
  onChangeViewMode: (mode: ViewMode) => void;
  onToggleFilterMenu: () => void;
  onToggleSortMenu: () => void;
}>(function DiscographyHeaderControls(
  {
    artistTitle,
    releaseFilter,
    sortMode,
    viewMode,
    filterMenuOpen,
    sortMenuOpen,
    menuTriggerClassName,
    className = "",
    onBack,
    onChangeFilter,
    onChangeSort,
    onChangeViewMode,
    onToggleFilterMenu,
    onToggleSortMenu,
  },
  ref,
) {
  return (
    <div ref={ref} className={`relative flex min-h-14 items-center gap-4 pb-4 ${className}`}>
      <div className="min-w-0 flex-1">
      <button
        type="button"
        onClick={onBack}
        className="block h-10 w-full max-w-full truncate text-left text-xl font-semibold text-white/78 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 animate-none"
      >
        {artistTitle}
      </button>
      </div>

      <div
        data-discography-control-actions
        className="artist-discography-control-actions ml-auto flex h-10 shrink-0 items-center gap-5 text-sm font-bold text-white/62"
      >
        <div className="relative" data-discography-menu-scope>
          <button
            type="button"
            onClick={onToggleFilterMenu}
            className={`${menuTriggerClassName} gap-1.5`}
          >
            {FULL_FILTERS.find((filter) => filter.value === releaseFilter)?.label ?? "All"}
            <ChevronDown size={16} className={filterMenuOpen ? "rotate-180 transition" : "transition"} />
          </button>
          {filterMenuOpen && (
            <MenuPanel className="right-0 top-10 w-48">
              {FULL_FILTERS.map((filter) => (
                <MenuOption
                  key={filter.value}
                  label={filter.label}
                  active={releaseFilter === filter.value}
                  onClick={() => {
                    onChangeFilter(filter.value);
                    onToggleFilterMenu();
                  }}
                />
              ))}
            </MenuPanel>
          )}
        </div>

        <div className="relative" data-discography-menu-scope>
          <button
            type="button"
            onClick={onToggleSortMenu}
            className={`${menuTriggerClassName} gap-2`}
          >
            {SORT_OPTIONS.find((sort) => sort.value === sortMode)?.label ?? "Release date"}
            <List size={17} />
          </button>
          {sortMenuOpen && (
            <MenuPanel className="right-0 top-10 w-56">
              <div className="px-4 pb-3 pt-2 text-xs font-extrabold text-white/58">Sort by</div>
              {SORT_OPTIONS.map((sort) => (
                <MenuOption
                  key={sort.value}
                  label={sort.label}
                  active={sortMode === sort.value}
                  onClick={() => {
                    onChangeSort(sort.value);
                    onToggleSortMenu();
                  }}
                />
              ))}
              <div className="h-px bg-white/8" />
              <MenuOption
                label="List"
                active={viewMode === "list"}
                icon={<List size={17} />}
                onClick={() => {
                  onChangeViewMode("list");
                  onToggleSortMenu();
                }}
              />
              <MenuOption
                label="Grid"
                active={viewMode === "grid"}
                icon={<Grid3X3 size={15} />}
                onClick={() => {
                  onChangeViewMode("grid");
                  onToggleSortMenu();
                }}
              />
            </MenuPanel>
          )}
        </div>
      </div>
    </div>
  );
});

function MenuPanel({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <div
      className={`artist-menu-pop absolute z-40 overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] ${className}`}
    >
      {children}
    </div>
  );
}

function MenuOption({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-white/8 animate-none ${
        active ? "text-white" : "text-white/72"
      }`}
    >
      {icon && <span className={active ? "text-white" : "text-white/72"}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={16} />}
    </button>
  );
}

function DiscographyRelease({
  release,
  dominoIndex,
  sectionRef,
  state,
  onOpen,
  onPlayTrack,
  currentTrack: _currentTrack,
  playing: _playing,
  buffering: _buffering,
  togglePlay: _togglePlay,
  playMany,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
  onNavigate,
  artistBrowseId,
}: {
  release: ReleaseItem;
  dominoIndex: number;
  sectionRef?: (node: HTMLElement | null) => void;
  state?: ReleaseDetailState;
  onOpen: () => void;
  onPlayTrack: (track: MediaTrack) => void;
  currentTrack: MediaTrack | null;
  playing: boolean;
  buffering: boolean;
  togglePlay: () => void;
  playMany: (tracks: MediaTrack[], startIndex?: number) => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (browseId: string, tracks: MediaTrack[]) => Promise<void> | void;
  resolvePlaylists?: (query: string) => Promise<Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>>;
  onNavigate?: (view: View) => void;
  artistBrowseId?: string | null;
}) {
  void _currentTrack;
  void _playing;
  void _buffering;
  void _togglePlay;
  const { togglePlay, playMany: playManyTracks } = usePlayerActions();
  const {
    active: isReleaseActive,
    playingActive: isReleasePlaying,
    bufferingActive: isReleaseBuffering,
  } = useReleasePlaybackState(release.browseId, artistBrowseId);
  const detail = state?.status === "ready" ? state.data : null;
  const tracks = useMemo(() => {
    const mapped =
      detail?.tracks.map((track) => ({
        ...track,
        album: track.album ?? release.title,
        albumBrowseId: release.browseId ?? track.albumBrowseId,
      })) ?? [];
    return filterQueueableTracks(mapped);
  }, [detail, release.browseId, release.title]);
  const [displayTracks, setDisplayTracks] = useState<MediaTrack[]>(tracks);

  useEffect(() => {
    setDisplayTracks(tracks);
  }, [tracks]);

  useTrackMetadataBackfill(displayTracks, setDisplayTracks);
  const meta = detail ? formatFullReleaseMeta(release, detail.tracks.length) : formatReleaseMeta(release);
  const [firstTrackHovered, setFirstTrackHovered] = useState(false);
  const firstTrack = displayTracks[0];
  const { active: firstTrackActive } = useTrackPlaybackState(
    firstTrack ?? {
      id: "__discography-none__",
      title: "",
      artist: "",
      source: "stream",
    },
  );
  const firstTrackActiveResolved = Boolean(firstTrack) && firstTrackActive;
  const [ellipsisOpen, setEllipsisOpen] = useState(false);
  const [ellipsisPosition, setEllipsisPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const ellipsisButtonRef = useRef<HTMLButtonElement | null>(null);
  const savedAlbum = useMemo<SavedAlbum>(() => ({
    browseId: release.browseId ?? "",
    title: release.title,
    subtitle: release.subtitle ?? "",
    cover: release.cover ?? null,
    byline: release.artist ?? null,
    year: release.yearLabel ?? null,
    artistBrowseId: release.artistBrowseId ?? null,
  }), [release]);
  const isReleaseSaved = useIsAlbumSaved(release.browseId);
  const toggleAlbumSave = useToggleAlbumSave(savedAlbum);
  return (
    <section
      ref={sectionRef}
      className="artist-discography-release"
      data-album-context-target="true"
      data-album={encodeAlbumForContextMenu(release)}
      style={{ "--domino-index": Math.min(dominoIndex, 14) } as CSSProperties}
    >
      <div className="mb-8 flex items-end gap-6">
        <button
          type="button"
          onClick={onOpen}
          className={`h-[clamp(7.5rem,13vw,10rem)] w-[clamp(7.5rem,13vw,10rem)] shrink-0 overflow-hidden bg-neutral-900 shadow-[0_22px_60px_rgba(0,0,0,0.46)] animate-none ${getArtworkRoundedClass()}`}
        >
          {release.cover ? (
            <ArtworkImage src={release.cover} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/30">
              <Music2 size={28} />
            </div>
          )}
        </button>

        <div className="min-w-0 pb-2">
          <button
            type="button"
            onClick={onOpen}
            data-discography-release-title
            className="block max-w-full text-left text-3xl font-bold leading-tight text-white transition hover:text-white/78 focus-visible:outline-none animate-none sm:text-4xl"
          >
            <Marquee className="text-inherit">{release.title}</Marquee>
          </button>
          <div className="mt-2 text-sm font-bold text-white/58">{meta}</div>
          <div className="mt-6 flex items-center gap-4 transition-opacity duration-150">
            <button
              type="button"
              onClick={() => {
                if (isReleaseActive) {
                  togglePlay();
                } else if (displayTracks.length > 0) {
                  void playManyTracks(displayTracks, 0, release.browseId ? { kind: "album", browseId: release.browseId } : undefined);
                } else {
                  onOpen();
                }
              }}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black transition hover:scale-[1.04] animate-none"
              aria-label={isReleaseBuffering ? "Loading" : isReleasePlaying ? "Pause release" : "Play release"}
            >
              {isReleaseBuffering ? (
                <LoaderCircle size={22} className="animate-spin" />
              ) : isReleasePlaying ? (
                <Pause size={22} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={22} fill="currentColor" strokeWidth={0} />
              )}
            </button>
            {release.browseId ? (
              <SaveButton
                isSaved={isReleaseSaved}
                onToggle={toggleAlbumSave}
                size="md"
                ariaLabel="Add release to collection"
              />
            ) : (
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center text-white/58 transition hover:text-white animate-none"
                aria-label="Add release"
              >
                <CirclePlus size={22} />
              </button>
            )}
            <button
              ref={ellipsisButtonRef}
              type="button"
              onClick={(e) => {
                if (!ellipsisOpen) {
                  setEllipsisPosition({ x: e.clientX, y: e.clientY });
                }
                setEllipsisOpen((open) => !open);
              }}
              className="flex h-8 w-8 items-center justify-center text-white/58 transition hover:text-white animate-none"
              aria-label="More album options"
            >
              <Ellipsis size={22} />
            </button>
          </div>
        </div>
      </div>

      <AlbumContextMenu
        open={ellipsisOpen}
        anchorRef={ellipsisButtonRef}
        position={ellipsisPosition}
        onClose={() => setEllipsisOpen(false)}
        album={savedAlbum}
        tracks={displayTracks.length > 0 ? displayTracks : undefined}
        onAddAlbumToQueue={onAddAlbumToQueue}
        onAddAlbumToPlaylist={onAddAlbumToPlaylist}
        resolvePlaylists={resolvePlaylists}

        onNavigate={onNavigate}
        currentAlbumBrowseId={release.browseId ?? undefined}
      />

      <TrackListHeader showPlays gridClassName={RELEASE_TRACK_GRID} dividerHidden={firstTrackHovered || firstTrackActiveResolved} />

      {state?.status === "loading" || !state ? (
        <div className="flex h-24 items-center px-4 text-sm font-semibold text-white/42">
          <LoaderCircle size={16} className="mr-2 animate-spin" />
          Loading songs
        </div>
      ) : state.status === "error" ? (
        <div className="px-4 py-5 text-sm font-semibold text-white/42">{state.message}</div>
      ) : (
        <VirtualList
          items={displayTracks}
          estimateSize={56}
          getItemKey={(track) => track.id}
          renderItem={(track, index) => (
            <DiscographyTrackRow
              track={track}
              index={index}
              dominoIndex={Math.min(index, 14)}
              onPlay={() => {
                if (displayTracks.length > 0) {
                  if (release.browseId) {
                    void playManyTracks(displayTracks, index, { kind: "album", browseId: release.browseId });
                  } else {
                    playMany(displayTracks, index);
                  }
                } else {
                  onPlayTrack(track);
                }
              }}
              onHoverChange={index === 0 ? setFirstTrackHovered : undefined}
            />
          )}
        />
      )}
    </section>
  );
}

function DiscographyTrackRow({
  track,
  index,
  dominoIndex,
  onPlay,
  onHoverChange,
}: {
  track: MediaTrack;
  index: number;
  dominoIndex: number;
  onPlay: () => void;
  onHoverChange?: (hovered: boolean) => void;
}) {
  const { togglePlay } = usePlayerActions();
  const { active, playingActive: playing, bufferingActive: buffering } = useTrackPlaybackState(track);
  const contextTarget = useContextTrackTarget(track);
  const isSaved = useIsTrackSaved(track);
  const toggleSave = useToggleTrackSave(track);
  return (
    <div
      {...contextTarget}
      style={{ "--domino-index": dominoIndex } as CSSProperties}
      className={`artist-discography-track group grid cursor-pointer ${RELEASE_TRACK_GRID} gap-3 rounded-lg px-4 py-2 transition-colors ${
        active ? "bg-white/[0.04]" : "hover:bg-neutral-900"
      }`}
      onClick={active ? togglePlay : onPlay}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="relative flex items-center justify-center">
        <span className={`text-[15px] font-semibold tabular-nums text-white/54 transition-opacity ${active ? "opacity-0" : "group-hover:opacity-0"}`}>
          {index + 1}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? togglePlay : onPlay)();
          }}
          className={`absolute flex h-7 w-7 items-center justify-center text-white animate-none ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={playing ? "Pause track" : "Play track"}
        >
          {buffering ? (
            <LoaderCircle size={17} className="animate-spin" />
          ) : playing ? (
            <Pause size={18} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={16} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 overflow-hidden">
          <div className="truncate text-[15px] font-bold text-white/92">{track.title}</div>
          <div className="mt-0.5 truncate text-sm text-white/48">{track.artist}</div>
        </div>
        {track.source !== "upload" && (
          <div
            className="shrink-0 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all"
            onClick={(event) => event.stopPropagation()}
          >
            <SaveButton
              isSaved={isSaved}
              size="sm"
              onToggle={toggleSave}
              ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
            />
          </div>
        )}
      </div>

      <div className="self-center text-center text-sm tabular-nums text-white/50">{formatPlayCount(track.playCount)}</div>
      <div className="self-center text-right text-sm tabular-nums text-white/58">{formatOptionalDuration(track.durationSeconds)}</div>
    </div>
  );
}

function buildReleaseItems(detail: ArtistDetail): ReleaseItem[] {
  const seen = new Set<string>();
  const releases: ReleaseItem[] = [];

  detail.shelves.forEach((shelf) => {
    if (!isReleaseShelf(shelf.title)) return;
    shelf.items.forEach((item) => {
      if (!item.browseId || item.kind !== "album") return;
      const key = item.browseId ?? item.id;
      if (seen.has(key)) return;
      seen.add(key);
      releases.push({
        ...item,
        releaseType: inferReleaseType(item, shelf.title),
        yearLabel: extractYear(item),
        shelfTitle: shelf.title,
      });
    });
  });

  return releases;
}

function isReleaseShelf(title: string): boolean {
  const lower = title.toLowerCase();
  if (lower.includes("video") || lower.includes("playlist") || lower.includes("featured")) return false;
  return (
    lower.includes("album") ||
    lower.includes("single") ||
    lower.includes("ep") ||
    lower.includes("release") ||
    lower.includes("discography") ||
    lower.includes("compilation")
  );
}

function filterAndSortReleases(items: ReleaseItem[], filter: ReleaseFilter, sort: SortMode): ReleaseItem[] {
  const filtered = filter === "all" ? items : items.filter((item) => item.releaseType === filter);
  return [...filtered].sort((left, right) => {
    if (sort === "name") return left.title.localeCompare(right.title);
    if (sort === "views") return stableHash(right.id) - stableHash(left.id);
    return (Number(right.yearLabel) || 0) - (Number(left.yearLabel) || 0) || left.title.localeCompare(right.title);
  });
}

function inferReleaseType(item: SearchItem, shelfTitle: string): ReleaseType {
  const text = `${shelfTitle} ${item.subtitle ?? ""} ${item.title}`.toLowerCase();
  if (text.includes("compilation")) return "compilation";
  if (text.includes("single") || text.includes(" ep") || text.includes("eps")) return "single";
  return "album";
}

function extractYear(item: SearchItem): string | null {
  if (item.year && /^\d{4}$/.test(item.year)) return item.year;
  const match = `${item.subtitle ?? ""} ${item.title}`.match(/\b(19|20)\d{2}\b/);
  return match?.[0] ?? null;
}

export function formatReleaseMeta(item: ReleaseItem): string {
  const type = item.releaseType === "single" ? "Single" : item.releaseType === "compilation" ? "Compilation" : "Album";
  return [item.yearLabel, type].filter(Boolean).join(" • ");
}

function formatFullReleaseMeta(item: ReleaseItem, trackCount: number): string {
  const type = item.releaseType === "single" ? "Single" : item.releaseType === "compilation" ? "Compilation" : "Album";
  const songLabel = `${trackCount} ${trackCount === 1 ? "song" : "songs"}`;
  return [type, item.yearLabel, songLabel].filter(Boolean).join(" • ");
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
