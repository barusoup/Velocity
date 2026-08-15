import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LoaderCircle } from "lucide-react";
import { usePlayerActions } from "../player";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import { useTrackPlaybackState } from "../hooks/usePlayerSelectors";
import { useSetting } from "../settings";
import type { MediaTrack } from "../types";
import {
  getCachedDailyRecommendations,
  getTopSongRows,
  needsDailyRecommendationRefresh,
  subscribeTasteProfile,
  type TopSongsPeriod,
} from "../taste-profile";
import {
  DAILY_RECOMMENDATIONS_TARGET,
  generateDailyRecommendations,
} from "../utils/home-recommendations";
import { useHorizontalDragScroll } from "../hooks/useHorizontalDragScroll";

import {
  getDirectAlbumBrowseId,
  getDirectArtistBrowseId,
  resolveAlbumBrowseId,
  resolveArtistBrowseId,
} from "../utils/navigation";
import { displayAlbumName } from "../utils/upload-enrichment";
import { cn } from "../utils/cn";
import { streamIdentityVideoIds } from "../utils/media";
import { Card } from "./Shared";
import { ArtistCreditText } from "./PagesShared";
import type { View } from "./Sidebar";

function homeTrackRailKey(track: MediaTrack): string {
  const identityIds = streamIdentityVideoIds(track);
  if (identityIds.length > 0) return identityIds.sort().join(":");
  return track.id;
}

const PERIOD_OPTIONS: Array<{ value: TopSongsPeriod; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "allTime", label: "All Time" },
];



const PeriodTabButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    active: boolean;
    onClick: () => void;
  }
>(function PeriodTabButton({ label, active, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative z-10 inline-flex h-8 items-center justify-center rounded-full px-3.5 text-sm font-semibold leading-none transition-colors animate-none",
        active ? "text-black" : "text-white hover:text-white/80",
      )}
    >
      {label}
    </button>
  );
});

function HomeTrackCard({
  track,
  onPlayTrack,
  onNavigate,
}: {
  track: MediaTrack;
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
}) {
  const { togglePlay } = usePlayerActions();
  const { active, playingActive: playing } = useTrackPlaybackState(track);
  const contextTarget = useContextTrackTarget(track);
  const directAlbumBrowseId = getDirectAlbumBrowseId(track);
  const albumLabel = displayAlbumName(track.album);
  const canNavigateToAlbum = Boolean(directAlbumBrowseId || track.videoId || albumLabel);
  const directArtistBrowseId = getDirectArtistBrowseId(track);

  const handleNavigateToAlbum = useCallback(() => {
    if (directAlbumBrowseId) {
      onNavigate({ name: "album", browseId: directAlbumBrowseId, context: "default" });
      return;
    }
    void resolveAlbumBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "album", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [directAlbumBrowseId, onNavigate, track]);

  const handleNavigateToLocal = useCallback(() => {
    onNavigate({ name: "collection", tab: "local" });
  }, [onNavigate]);

  const handleResolveNavigate = useCallback(() => {
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);

  const handleResolveArtistName = useCallback(
    (artistName: string) => {
      void resolveArtistBrowseId({ artist: artistName })
        .then((browseId) => {
          if (!browseId) return;
          onNavigate({ name: "artist", browseId, context: "default" });
        })
        .catch(() => undefined);
    },
    [onNavigate],
  );

  const onCardClick = canNavigateToAlbum
    ? handleNavigateToAlbum
    : track.source === "upload"
      ? handleNavigateToLocal
      : undefined;

  return (
    <div {...contextTarget}>
      <Card
        cover={track.cover}
        title={track.title}
        playing={playing}
        playButtonSize="lg"
        onPlay={() => (active ? togglePlay() : onPlayTrack(track))}
        onClick={onCardClick}
        subtitleContent={
          <div className="mt-0.5 truncate text-xs text-neutral-400">
            <ArtistCreditText
              artist={track.artist || "\u2014"}
              artistBrowseId={track.artistBrowseId}
              artistCredits={track.artistCredits}
              context="default"
              onNavigate={onNavigate}
              onResolveNavigate={directArtistBrowseId ? null : track.artist ? handleResolveNavigate : null}
              onResolveArtistName={handleResolveArtistName}
            />
          </div>
        }
      />
    </div>
  );
}

function HomeRailScrollbar({
  targetRef,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [metrics, setMetrics] = useState({
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
  });
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartScrollLeftRef = useRef(0);

  const updateMetrics = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    setMetrics({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  }, [targetRef]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    updateMetrics();

    el.addEventListener("scroll", updateMetrics, { passive: true });
    const ro = new ResizeObserver(updateMetrics);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", updateMetrics);
      ro.disconnect();
    };
  }, [targetRef, updateMetrics]);

  const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (maxScroll <= 1) return null;

  const trackEl = trackRef.current;
  const trackWidth = trackEl ? trackEl.clientWidth : 0;
  const rawThumbWidth =
    trackWidth > 0 && metrics.scrollWidth > 0
      ? (metrics.clientWidth / metrics.scrollWidth) * trackWidth
      : 0;
  const thumbWidth = Math.max(32, Math.min(rawThumbWidth, trackWidth));
  const availableTrack = Math.max(0, trackWidth - thumbWidth);
  const scrollRatio = maxScroll > 0 ? metrics.scrollLeft / maxScroll : 0;
  const thumbLeft = availableTrack * Math.min(1, Math.max(0, scrollRatio));

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = targetRef.current;
    const track = trackRef.current;
    if (!el || !track) return;

    const trackRect = track.getBoundingClientRect();
    const clickX = e.clientX - trackRect.left;

    if (clickX < thumbLeft || clickX > thumbLeft + thumbWidth) {
      const clickRatio =
        (clickX - thumbWidth / 2) / Math.max(1, trackWidth - thumbWidth);
      el.scrollLeft = Math.max(0, Math.min(maxScroll, clickRatio * maxScroll));
    }

    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartScrollLeftRef.current = el.scrollLeft;
    track.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const el = targetRef.current;
    const track = trackRef.current;
    if (!el || !track) return;

    const deltaX = e.clientX - dragStartXRef.current;
    const currentTrackWidth = track.clientWidth;
    const currentThumbWidth = Math.max(
      32,
      Math.min(
        (metrics.clientWidth / metrics.scrollWidth) * currentTrackWidth,
        currentTrackWidth,
      ),
    );
    const currentAvailable = Math.max(1, currentTrackWidth - currentThumbWidth);
    const scrollDelta = (deltaX / currentAvailable) * maxScroll;
    el.scrollLeft = Math.max(
      0,
      Math.min(maxScroll, dragStartScrollLeftRef.current + scrollDelta),
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        trackRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };

  return (
    <div className="px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)] pt-1 select-none">
      <div
        ref={trackRef}
        className="relative h-1.5 w-full cursor-pointer rounded-full bg-transparent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="absolute top-0 bottom-0 rounded-full bg-[#2a2a2a] transition-colors hover:bg-[#3a3a3a]"
          style={{
            width: `${thumbWidth}px`,
            transform: `translateX(${thumbLeft}px)`,
          }}
        />
      </div>
    </div>
  );
}

function HomeTrackCardRail({
  tracks,
  onPlayTrack,
  onNavigate,
}: {
  tracks: MediaTrack[];
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
}) {
  const { stripRef, isDragging, onPointerDown, onClickCapture } = useHorizontalDragScroll();

  return (
    <div>
      <div
        ref={stripRef}
        className={cn(
          "home-card-rail flex gap-3 overflow-x-auto overscroll-x-contain select-none px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={onPointerDown}
        onClickCapture={onClickCapture}
      >
        {tracks.map((track) => (
          <div key={homeTrackRailKey(track)} className="w-[var(--ui-home-card-width)] shrink-0">
            <HomeTrackCard
              track={track}
              onPlayTrack={onPlayTrack}
              onNavigate={onNavigate}
            />
          </div>
        ))}
      </div>
      <HomeRailScrollbar targetRef={stripRef} />
    </div>
  );
}

function HomeEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="max-w-md text-sm text-neutral-400">{description}</p>
    </div>
  );
}

export function HomePage({
  onPlayTrack,
  onNavigate,
}: {
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
}) {
  const showTopSongs = useSetting("showHomeTopSongs");
  const showTodaysPicks = useSetting("showHomeTodaysPicks");
  const [topPeriod, setTopPeriod] = useState<TopSongsPeriod>("weekly");
  const [recommendations, setRecommendations] = useState<MediaTrack[] | null>(() =>
    getCachedDailyRecommendations(),
  );
  const [recsStatus, setRecsStatus] = useState<"idle" | "loading" | "ready" | "error">(() => {
    if (getCachedDailyRecommendations()) return "ready";
    return needsDailyRecommendationRefresh() ? "loading" : "ready";
  });
  const [recsError, setRecsError] = useState<string | null>(null);
  const [profileRevision, setProfileRevision] = useState(0);

  const periodTabRefs = useRef<Record<TopSongsPeriod, HTMLButtonElement | null>>({
    weekly: null,
    monthly: null,
    yearly: null,
    allTime: null,
  });
  const periodTabContainerRef = useRef<HTMLDivElement | null>(null);
  const [periodIndicatorStyle, setPeriodIndicatorStyle] = useState<{
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => subscribeTasteProfile(() => setProfileRevision((value) => value + 1)), []);

  useLayoutEffect(() => {
    const container = periodTabContainerRef.current;
    const activeBtn = periodTabRefs.current[topPeriod];
    if (!container || !activeBtn) return;
    const containerRect = container.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    setPeriodIndicatorStyle({
      left: btnRect.left - containerRect.left,
      width: btnRect.width,
    });
  }, [topPeriod]);

  const topSongRows = useMemo(
    () => getTopSongRows(topPeriod, DAILY_RECOMMENDATIONS_TARGET),
    [topPeriod, profileRevision],
  );
  const topSongs = useMemo(() => topSongRows.map((row) => row.track), [topSongRows]);

  const refreshRecommendations = useCallback(async () => {
    if (!needsDailyRecommendationRefresh()) {
      const cached = getCachedDailyRecommendations();
      if (cached) {
        setRecommendations(cached);
        setRecsStatus("ready");
        return;
      }
    }

    setRecsStatus("loading");
    setRecsError(null);
    try {
      const tracks = await generateDailyRecommendations();
      setRecommendations(tracks);
      setRecsStatus("ready");
    } catch (error) {
      setRecsStatus("error");
      setRecsError(error instanceof Error ? error.message : "Could not load recommendations.");
    }
  }, []);

  useEffect(() => {
    if (!showTodaysPicks) return;
    void refreshRecommendations();
  }, [refreshRecommendations, showTodaysPicks, profileRevision]);

  const dailyTracks = (recommendations ?? []).slice(0, DAILY_RECOMMENDATIONS_TARGET);
  const showRecsLoading = recsStatus === "loading" && dailyTracks.length === 0;

  return (
    <div className="home-page relative pt-[calc(var(--ui-topbar-height)+clamp(0.75rem,1.25vw,1.125rem))] pb-[clamp(2.5rem,3.125vw,4rem)]">
      {showTopSongs ? (
        <section className="mb-[clamp(2rem,3.125vw,3.25rem)]">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]">
            <h2 className="text-2xl font-semibold leading-none text-white">Top Songs</h2>
            <div ref={periodTabContainerRef} className="relative flex translate-y-[7px] items-center gap-1.5">
              {periodIndicatorStyle && (
                <div
                  className="absolute top-0 bottom-0 rounded-full bg-white transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{
                    left: periodIndicatorStyle.left,
                    width: periodIndicatorStyle.width,
                  }}
                />
              )}
              {PERIOD_OPTIONS.map((option) => (
                <PeriodTabButton
                  key={option.value}
                  ref={(element) => {
                    periodTabRefs.current[option.value] = element;
                  }}
                  label={option.label}
                  active={topPeriod === option.value}
                  onClick={() => setTopPeriod(option.value)}
                />
              ))}
            </div>
          </div>

          {topSongs.length === 0 ? (
            <HomeEmptyState
              title="No top songs yet"
              description="Songs you listen to often will start appearing here."
            />
          ) : (
            <HomeTrackCardRail tracks={topSongs} onPlayTrack={onPlayTrack} onNavigate={onNavigate} />
          )}
        </section>
      ) : null}

      {showTodaysPicks ? (
        <section>
          <h2 className="mb-2 px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)] text-2xl font-semibold text-white">
            Today&apos;s Picks
          </h2>

          {showRecsLoading ? (
            <div className="flex items-center justify-center gap-3 py-16 px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]">
              <LoaderCircle size={28} className="animate-spin text-neutral-400" aria-label="Finding songs for you" />
              <span className="text-sm font-semibold text-neutral-400">Finding songs for you</span>
            </div>
          ) : null}

          {recsStatus === "error" ? (
            <div className="py-16 text-center px-[var(--ui-page-pad)] pl-[var(--ui-page-left-pad)] pr-[var(--ui-page-right-pad)]">
              <p className="text-base font-semibold text-white">Something went wrong</p>
              <p className="mt-2 text-sm text-neutral-400">{recsError ?? "Could not load recommendations."}</p>
            </div>
          ) : null}

          {recsStatus !== "loading" && recsStatus !== "error" && dailyTracks.length === 0 ? (
            <HomeEmptyState
              title="No picks yet"
              description="Keep listening and fresh picks will show up here each day."
            />
          ) : null}

          {dailyTracks.length > 0 ? (
            <HomeTrackCardRail tracks={dailyTracks} onPlayTrack={onPlayTrack} onNavigate={onNavigate} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}