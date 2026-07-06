import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Pause, Play, Search as SearchIcon } from "lucide-react";
import { searchMusic, peekSearchMusic, getSyncedLyrics } from "../api";
import { usePlayerActions } from "../player";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import { useSearchItemPlaybackState } from "../hooks/usePlayerSelectors";
import { VirtualList } from "./VirtualList";
import { type SavedAlbum, type SavedArtist } from "../collection";
import {
  useIsAlbumSaved,
  useIsArtistSaved,
  useIsSongSaved,
  useToggleAlbumSave,
  useToggleArtistSave,
  useToggleTrackSave,
} from "../hooks/useCollectionSelectors";
import type { MediaTrack, SearchItem, SearchResponse } from "../types";
import { ArtworkImage, getArtworkRoundedClass } from "./Shared";
import { SaveButton } from "./SaveButton";
import type { View } from "./Sidebar";
import { DEFAULT_SEARCH_FILTERS, type SearchFilters, type SearchSort } from "./SearchFilters";
import {
  ErrorPanel,
  getPlayHandler,
  getSearchItemTitleView,
  LoadingPanel,
  SearchItemMeta,
  toTrack,
} from "./PagesShared";
import { getSearchItemArtist } from "../utils/search";
import { Marquee } from "./Marquee";

export function SearchPage({
  query,
  retryToken,
  onOpenItem,
  onNavigate,
  onPlayTrack,
  onPlayMany,
  onSearchResolved,
  onSearchLoadingChange,
  filters,
}: {
  query: string;
  retryToken: number;
  onOpenItem: (item: SearchItem) => void;
  onNavigate: (view: View) => void;
  onPlayTrack: (track: MediaTrack) => void;
  onPlayMany: (tracks: MediaTrack[], startIndex?: number) => void;
  onSearchResolved: (hasResults: boolean) => void;
  onSearchLoadingChange?: (loading: boolean) => void;
  filters: SearchFilters;
}) {
  // Seed from the synchronous peek so a Back/Forward navigation to a
  // previously-issued search renders its results on the first paint instead
  // of flashing the loading spinner while the cached promise re-resolves.
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    data?: SearchResponse;
    error?: string;
  }>(() => {
    const clean = query.trim();
    if (!clean) return { status: "ready", data: { query: "", topResult: null, results: [] } };
    const cached = peekSearchMusic(clean);
    if (cached) return { status: "ready", data: cached };
    return { status: "loading" };
  });
  const lastRetryTokenRef = useRef(retryToken);
  const onSearchResolvedRef = useRef(onSearchResolved);
  const onSearchLoadingChangeRef = useRef(onSearchLoadingChange);

  useEffect(() => {
    onSearchResolvedRef.current = onSearchResolved;
  }, [onSearchResolved]);

  useEffect(() => {
    onSearchLoadingChangeRef.current = onSearchLoadingChange;
  }, [onSearchLoadingChange]);

  useEffect(() => {
    let cancelled = false;
    const clean = query.trim();
    const forceRefresh = retryToken !== lastRetryTokenRef.current;
    lastRetryTokenRef.current = retryToken;

    if (!clean) {
      setState({ status: "ready", data: { query: "", topResult: null, results: [] } });
      onSearchResolvedRef.current(false);
      return () => {
        cancelled = true;
      };
    }

    // If we already have a cached result and aren't being asked to force a
    // refresh, adopt it synchronously and skip the loading spinner. The
    // `searchMusic` call below still runs (and re-caches) so the data stays
    // fresh, but the user sees the cached results immediately.
    if (!forceRefresh) {
      const cached = peekSearchMusic(clean);
      if (cached) {
        setState({ status: "ready", data: cached });
        onSearchResolvedRef.current(Boolean(cached.topResult || cached.results.length));
      } else {
        setState({ status: "loading" });
        onSearchLoadingChangeRef.current?.(true);
      }
    } else {
      setState({ status: "loading" });
      onSearchLoadingChangeRef.current?.(true);
    }

    searchMusic(clean, { forceRefresh })
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", data });
        onSearchResolvedRef.current(Boolean(data.topResult || data.results.length));
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Search failed.",
        });
        onSearchResolvedRef.current(false);
      })
      .finally(() => {
        if (cancelled) return;
        onSearchLoadingChangeRef.current?.(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query, retryToken]);

  useEffect(() => {
    const items: SearchItem[] = [];
    if (state.data?.topResult) items.push(state.data.topResult);
    for (const item of state.data?.results ?? []) {
      if (!items.some((existing) => existing.id === item.id)) items.push(item);
    }
    for (const item of items) {
      if (item.kind !== "song") continue;
      if (!item.videoId) continue;
      void getSyncedLyrics(item.videoId).catch(() => {});
    }
  }, [state.data]);

  const top = state.data?.topResult;
  const results = state.data?.results ?? [];
  const isDefaultFilterView =
    filters.types.length === DEFAULT_SEARCH_FILTERS.types.length &&
    filters.sortBy === DEFAULT_SEARCH_FILTERS.sortBy;
  const sortableResults = useMemo(() => {
    if (!top || isDefaultFilterView) return results;
    return [top, ...results.filter((item) => item.id !== top.id)];
  }, [isDefaultFilterView, results, top]);
  const filteredTop = isDefaultFilterView && top && passesSearchFilters(top, filters) ? top : null;
  const filteredResults = useMemo(() => applySearchFilters(sortableResults, filters), [sortableResults, filters]);
  const hasUnfilteredResults = Boolean(top || results.length);
  const hasFilteredResults = Boolean(filteredTop || filteredResults.length);

  const getSongPlayHandler = useCallback(
    (item: SearchItem): (() => void) | undefined => {
      const track = toTrack(item);
      if (!track) return undefined;
      // Play only the clicked result; autoplay fills the queue. Queuing every
      // song-shaped search hit (covers, live cuts, remixes) looked like manual
      // "Up next" entries and drowned out real autoplay.
      return () => onPlayTrack(track);
    },
    [onPlayTrack],
  );

  if (!query.trim()) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <div className="text-center">
          <p className="text-base text-neutral-400/60">Type an artist, song, or album to find relevant content.</p>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return <LoadingPanel label="Loading search results" />;
  }

  if (state.status === "error") {
    return <ErrorPanel message={state.error ?? "Search failed."} />;
  }

  return (
    <div className="pt-[clamp(0.875rem,1.125vw,1.125rem)] pb-0">
      {filteredTop && (
        <section className="mb-[clamp(2rem,3.125vw,3.25rem)]">
          <TopResultBlock
            item={filteredTop}
            onOpen={() => onOpenItem(filteredTop)}
            onNavigate={onNavigate}
            onPlay={
              filteredTop.kind === "song"
                ? getSongPlayHandler(filteredTop)
                : getPlayHandler(filteredTop, onPlayTrack, onPlayMany)
            }
          />
        </section>
      )}

      {filteredResults.length > 0 && (
        <section className="mb-[clamp(2rem,3.125vw,3.25rem)]">
          <VirtualList
            items={filteredResults}
            estimateSize={64}
            getItemKey={(item) => item.id}
            className="space-y-1"
            renderItem={(item) => (
              <SearchResultRow
                item={item}
                onOpen={() => onOpenItem(item)}
                onNavigate={onNavigate}
                onPlay={
                  item.kind === "song"
                    ? getSongPlayHandler(item)
                    : getPlayHandler(item, onPlayTrack, onPlayMany)
                }
              />
            )}
          />
        </section>
      )}

      {hasUnfilteredResults && !hasFilteredResults && (
        <div className="rounded-2xl bg-black p-12 text-center">
          <p className="text-base font-semibold text-white">No filtered results</p>
          <p className="mt-2 text-sm text-neutral-400">Clear the filters to show the original search results.</p>
        </div>
      )}
    </div>
  );
}

function applySearchFilters(items: SearchItem[], filters: SearchFilters): SearchItem[] {
  const filtered = items.filter((item) => passesSearchFilters(item, filters));
  return filtered
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareSearchItems(a.item, b.item, filters.sortBy) || a.index - b.index)
    .map(({ item }) => item);
}

function passesSearchFilters(item: SearchItem, filters: SearchFilters): boolean {
  if (item.kind === "video") return false;
  if (!filters.types.includes(item.kind as "artist" | "album" | "song")) return false;
  return true;
}

function compareSearchItems(a: SearchItem, b: SearchItem, sortBy: SearchSort): number {
  if (sortBy === "releaseDate") {
    return compareNullableNumbers(parseReleaseYear(b), parseReleaseYear(a));
  }
  return 0;
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function parseReleaseYear(item: SearchItem): number | null {
  const match = item.year?.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  return Number(match[0]);
}

function TopResultBlock({
  item,
  onOpen,
  onNavigate,
  onPlay,
}: {
  item: SearchItem;
  onOpen: () => void;
  onNavigate: (view: View) => void;
  onPlay?: () => void;
}) {
  const rounded = getArtworkRoundedClass(item.kind === "artist" ? "circle" : "square");
  const titleView = getSearchItemTitleView(item);
  const { togglePlay } = usePlayerActions();
  const { active, playingActive: currentlyPlaying, bufferingActive } =
    useSearchItemPlaybackState(item);
  const contextTrack = useMemo(() => (item.kind === "song" ? toTrack(item) : null), [item]);
  const contextTarget = useContextTrackTarget(
    contextTrack ?? {
      id: item.id,
      title: item.title,
      artist: item.artist ?? "",
      album: item.subtitle ?? null,
      source: "stream",
    },
    Boolean(contextTrack),
  );

  const contextAlbum = useMemo(() => {
    if (item.kind !== "album") return null;
    return JSON.stringify({
      browseId: item.browseId,
      title: item.title,
      subtitle: item.subtitle,
      cover: item.cover,
      byline: item.artist,
      year: item.year,
      artistBrowseId: item.artistBrowseId,
    });
  }, [item]);

  const saveTrack = useMemo(() => toSaveableTrack(item), [item]);
  const savedAlbum = useMemo(() => toSavedAlbum(item), [item]);
  const savedArtist = useMemo(() => toSavedArtist(item), [item]);

  return (
    <div
      className="rounded-2xl bg-neutral-900/70 p-[clamp(1rem,1.5625vw,1.25rem)]"
      {...(contextTrack ? contextTarget : contextAlbum
        ? {
            "data-album-context-target": "true",
            "data-album": contextAlbum,
          }
        : {})}
      onContextMenu={(e) => {
        if (contextTrack || contextAlbum) e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-[clamp(1rem,1.5625vw,1.25rem)]">
        <div className={`h-[var(--ui-art-feature)] w-[var(--ui-art-feature)] flex-shrink-0 overflow-hidden bg-neutral-800 ${rounded}`}>
          {item.cover ? (
            <ArtworkImage src={item.cover} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-neutral-500">
              <SearchIcon size={18} />
            </div>
          )}
        </div>

        <div
          className="min-w-0 flex-1 cursor-pointer"
          onClick={onOpen}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          <div className="flex w-max max-w-full min-w-0 items-center gap-2">
            <div className="min-w-0 shrink overflow-hidden leading-tight">
              {titleView ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNavigate(titleView);
                  }}
                  className="block w-full text-left text-[clamp(1.2rem,2.4vw,1.55rem)] font-bold leading-tight tracking-tight text-white transition hover:text-white/95 focus-visible:outline-none"
                >
                  <Marquee className="text-[clamp(1.2rem,2.4vw,1.55rem)] font-bold leading-tight tracking-tight text-inherit">{item.title}</Marquee>
                </button>
              ) : (
                <Marquee className="text-[clamp(1.2rem,2.4vw,1.55rem)] font-bold leading-tight tracking-tight text-white">{item.title}</Marquee>
              )}
            </div>
            <SearchItemSaveButtons
              saveTrack={saveTrack}
              savedAlbum={savedAlbum}
              savedArtist={savedArtist}
              titleInline
            />
          </div>
          <div className="mt-1 text-sm text-neutral-400 sm:text-base">
            <SearchItemMeta item={item} onNavigate={onNavigate} />
          </div>
        </div>

        {onPlay && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              (active ? togglePlay : onPlay)();
            }}
            className="mr-1 flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white shadow-lg transition hover:scale-105 hover:bg-white hover:text-black animate-none"
            aria-label={currentlyPlaying ? "Pause" : "Play"}
          >
            {bufferingActive ? (
              <LoaderCircle size={26} className="animate-spin" />
            ) : currentlyPlaying ? (
              <Pause size={26} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={26} fill="currentColor" strokeWidth={0} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function SearchResultRow({
  item,
  onOpen,
  onNavigate,
  onPlay,
}: {
  item: SearchItem;
  onOpen: () => void;
  onNavigate: (view: View) => void;
  onPlay?: () => void;
}) {
  const rounded = getArtworkRoundedClass(item.kind === "artist" ? "circle" : "square");
  const titleView = getSearchItemTitleView(item);
  const { togglePlay } = usePlayerActions();
  const { active, playingActive: currentlyPlaying, bufferingActive } =
    useSearchItemPlaybackState(item);
  const contextTrack = useMemo(() => (item.kind === "song" ? toTrack(item) : null), [item]);
  const contextTarget = useContextTrackTarget(
    contextTrack ?? {
      id: item.id,
      title: item.title,
      artist: item.artist ?? "",
      album: item.subtitle ?? null,
      source: "stream",
    },
    Boolean(contextTrack),
  );

  const contextAlbum = useMemo(() => {
    if (item.kind !== "album") return null;
    return JSON.stringify({
      browseId: item.browseId,
      title: item.title,
      subtitle: item.subtitle,
      cover: item.cover,
      byline: item.artist,
      year: item.year,
      artistBrowseId: item.artistBrowseId,
    });
  }, [item]);

  const saveTrack = useMemo(() => toSaveableTrack(item), [item]);
  const savedAlbum = useMemo(() => toSavedAlbum(item), [item]);
  const savedArtist = useMemo(() => toSavedArtist(item), [item]);

  return (
    <div
      className={`group flex cursor-pointer items-center gap-[clamp(0.75rem,1.6vw,1rem)] rounded-lg px-2 py-2 hover:bg-neutral-900 ${active ? "bg-white/[0.04]" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      {...(contextTrack ? contextTarget : contextAlbum
        ? {
            "data-album-context-target": "true",
            "data-album": contextAlbum,
          }
        : {})}
      onContextMenu={(e) => {
        if (contextTrack || contextAlbum) e.stopPropagation();
      }}
      >
      <div className={`h-[var(--ui-art-row)] w-[var(--ui-art-row)] flex-shrink-0 overflow-hidden bg-neutral-800 ${rounded}`}>
        {item.cover ? (
          <ArtworkImage src={item.cover} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-500">
            <SearchIcon size={16} />
          </div>
        )}
      </div>

      <div className="min-w-0 overflow-hidden">
        {titleView ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onNavigate(titleView);
            }}
            className="text-left text-lg font-semibold text-white transition hover:text-white/95 focus-visible:outline-none"
          >
            <Marquee className="text-lg font-semibold text-inherit">{item.title}</Marquee>
          </button>
        ) : (
          <Marquee className="text-lg font-semibold text-white">{item.title}</Marquee>
        )}
        <div className="truncate text-sm text-neutral-400">
          <SearchItemMeta item={item} onNavigate={onNavigate} />
        </div>
      </div>

      <SearchItemSaveButtons
        saveTrack={saveTrack}
        savedAlbum={savedAlbum}
        savedArtist={savedArtist}
        hoverReveal
      />

      {onPlay && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? togglePlay : onPlay)();
          }}
          className={`ml-auto mr-2 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white hover:scale-105 hover:bg-white hover:text-black animate-none ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
          }`}
          aria-label={currentlyPlaying ? "Pause" : "Play"}
        >
          {bufferingActive ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : currentlyPlaying ? (
            <Pause size={15} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={15} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      )}
    </div>
  );
}

function SearchItemSaveButtons({
  saveTrack,
  savedAlbum,
  savedArtist,
  hoverReveal = false,
  titleInline = false,
}: {
  saveTrack: MediaTrack | null;
  savedAlbum: SavedAlbum | null;
  savedArtist: SavedArtist | null;
  hoverReveal?: boolean;
  /** Top-result title row: keep the icon vertically centered on the name line. */
  titleInline?: boolean;
}) {
  const trackSaved = useIsSongSaved(
    saveTrack?.id ?? "",
    saveTrack?.videoId,
  );
  const toggleTrackSave = useToggleTrackSave(
    saveTrack ?? {
      id: "",
      title: "",
      artist: "",
      source: "stream",
    },
  );
  const albumSaved = useIsAlbumSaved(savedAlbum?.browseId);
  const toggleAlbumSave = useToggleAlbumSave(
    savedAlbum ?? { browseId: "", title: "", subtitle: "" },
  );
  const artistSaved = useIsArtistSaved(savedArtist?.browseId);
  const toggleArtistSave = useToggleArtistSave(
    savedArtist ?? { browseId: "", title: "" },
  );

  const revealClass = hoverReveal
    ? "shrink-0 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all"
    : titleInline
      ? "flex shrink-0 items-center"
      : "shrink-0";
  const buttonSize = hoverReveal ? "sm" : titleInline ? "md" : undefined;

  return (
    <>
      {saveTrack && saveTrack.source !== "upload" && (
        <div className={revealClass} onClick={(event) => event.stopPropagation()}>
          <SaveButton
            isSaved={trackSaved}
            size={buttonSize}
            onToggle={toggleTrackSave}
            ariaLabel={trackSaved ? "Remove from collection" : "Save to collection"}
          />
        </div>
      )}

      {savedAlbum && (
        <div className={revealClass} onClick={(event) => event.stopPropagation()}>
          <SaveButton
            isSaved={albumSaved}
            size={buttonSize}
            onToggle={toggleAlbumSave}
            ariaLabel={albumSaved ? "Remove from collection" : "Save album to collection"}
          />
        </div>
      )}

      {savedArtist && (
        <div className={revealClass} onClick={(event) => event.stopPropagation()}>
          <SaveButton
            isSaved={artistSaved}
            size={buttonSize}
            onToggle={toggleArtistSave}
            ariaLabel={artistSaved ? "Remove from collection" : "Save artist to collection"}
          />
        </div>
      )}
    </>
  );
}

function toSaveableTrack(item: SearchItem): MediaTrack | null {
  if (item.kind !== "song" && item.kind !== "video") return null;
  if (!item.videoId) return null;
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

function browseIdFromSearchItemId(id: string): string | null {
  if (!id.startsWith("browse:")) return null;
  return id.slice("browse:".length) || null;
}

function toSavedAlbum(item: SearchItem): SavedAlbum | null {
  if (item.kind !== "album") return null;
  const browseId = item.browseId ?? browseIdFromSearchItemId(item.id);
  if (!browseId) return null;
  return {
    browseId,
    title: item.title,
    subtitle: item.subtitle,
    cover: item.cover ?? null,
    byline: item.artist ?? null,
    year: item.year ?? null,
    artistBrowseId: item.artistBrowseId ?? null,
  };
}

function toSavedArtist(item: SearchItem): SavedArtist | null {
  if (item.kind !== "artist") return null;
  const browseId = item.browseId ?? browseIdFromSearchItemId(item.id);
  if (!browseId) return null;
  return {
    browseId,
    title: item.title,
    cover: item.cover ?? null,
    banner: null,
    monthlyListeners: monthlyListenersFromSearchSubtitle(item.subtitle),
  };
}

function monthlyListenersFromSearchSubtitle(subtitle: string): string | null {
  for (const part of subtitle.split("•")) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().includes("monthly listener")) return trimmed;
  }
  return null;
}
