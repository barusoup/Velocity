import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronRight, Disc3, History, List, LoaderCircle } from "lucide-react";
import { usePlayer } from "../player";
import { usePlayerUiStore } from "../store/playerUiStore";
import {
  cacheArtwork,
  getArtistDetail,
  hydratePersistedLyricsForTrack,
  isCleanLyricsSource,
  isLyricsExhaustedForTrack,
  isUnsyncedLyricsSource,
  peekCachedArtwork,
  subscribeLyricsUpdates,
} from "../api";
import { streamIdentityVideoIds } from "../utils/media";
import {
  fetchSyncedLyrics,
  fetchSyncedLyricsByMeta,
  findActiveLyricIndex,
  hasValidLyricSync,
  shouldReplaceLyricsWith,
} from "../lyrics";
import type { SyncedLyrics } from "../lyrics";
import type { MediaTrack } from "../types";
import { ArtworkImage, DefaultArtwork, getArtworkRoundedClass } from "./Shared";
import { Marquee } from "./Marquee";
import { getDirectAlbumBrowseId, getDirectArtistBrowseId, resolveAlbumBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import { resolveTrackAlbumMetadata } from "../utils/track-metadata-backfill";
import { isPlaceholderAlbumName } from "../utils/upload-enrichment";
import type { View } from "./Sidebar";
import { QueuePanelBody } from "./QueuePanel";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";

const SIDEBAR_TRANSITION = "duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]";
const MARQUEE_SPEED = 40;
const MARQUEE_PAUSE_SECONDS = 0.85;
const MARQUEE_MIN_DURATION = 4;
// Compact lyrics preview: smoothly auto-centers the active line,
// mirroring the lyrics page while expanding to fill available vertical space.
type PanelTab = "now-playing" | "queue" | "recently-played";

function hasLyricsMeta(
  track: Pick<MediaTrack, "title" | "artist">,
): boolean {
  return Boolean(track.title?.trim() && track.artist?.trim());
}

function acceptSyncedLyrics(candidate: SyncedLyrics | null): SyncedLyrics | null {
  if (!candidate || !hasValidLyricSync(candidate.lines)) return null;
  if (isUnsyncedLyricsSource(candidate.source)) return null;
  if (!isCleanLyricsSource(candidate.source)) return null;
  return candidate;
}

function PanelTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-semibold leading-none transition-colors ${
        active ? "text-white" : "text-neutral-500 hover:text-white"
      }`}
    >
      <span className={`transition-opacity ${active ? "opacity-100" : "opacity-70"}`}>
        {icon}
      </span>
      <span className="whitespace-nowrap">{label}</span>
      <span
        className={`absolute inset-x-0 bottom-0 h-0.5 bg-white transition-transform duration-150 ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

export function NowPlayingPanel({
  open,
  hidden = false,
  onClose,
  onNavigate,
}: {
  open: boolean;
  hidden?: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();
  const track = player.currentTrack;
  const contextTarget = useContextTrackTarget(track!, Boolean(track));
  const progress = usePlayerUiStore((s) => s.seekScrubProgress ?? s.progress);
  const [tab, setTab] = useState<PanelTab>("now-playing");

  const [lyrics, setLyrics] = useState<SyncedLyrics | null>(() =>
    track ? acceptSyncedLyrics(hydratePersistedLyricsForTrack(track)) : null,
  );
  const [loading, setLoading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const previewLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastScrolledIndexRef = useRef(-1);

  const [narrowCollapsed, setNarrowCollapsed] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 760px)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const onChange = () => setNarrowCollapsed(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isEffectivelyOpen = open && !hidden;
  const showCrescent = !hidden && open && !(narrowCollapsed && !open);

  useEffect(() => {
    if (!track) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(false);
      return;
    }
    const isStream = track.source === "stream";
    const isUploadWithLyrics = track.source === "upload" && track.findLyrics;
    if (!isStream && !isUploadWithLyrics) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(true);
      return;
    }
    if (track.source === "stream" && !track.videoId && !track.resolvedVideoId) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(true);
      return;
    }
    if (isLyricsExhaustedForTrack(track)) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(true);
      return;
    }

    const cached = isStream
      ? acceptSyncedLyrics(hydratePersistedLyricsForTrack(track))
      : null;
    setLyrics(cached);
    setLoading(!cached);
    setTimedOut(false);

    let cancelled = false;
    const load = async () => {
      try {
        let result: SyncedLyrics | null = null;
        if (isStream) {
          result = await fetchSyncedLyrics(track, { persist: true });
        } else if (isUploadWithLyrics && hasLyricsMeta(track)) {
          result = await fetchSyncedLyricsByMeta(track);
        }
        if (cancelled) return;
        const accepted = acceptSyncedLyrics(result);
        if (accepted) {
          if (cached && shouldReplaceLyricsWith(cached, accepted)) {
            setLyrics(accepted);
          } else if (!cached) {
            setLyrics(accepted);
          }
          setLoading(false);
          setTimedOut(false);
          return;
        }
        if (!cached) {
          setLyrics(null);
          setTimedOut(true);
        }
        setLoading(false);
      } catch {
        if (cancelled) return;
        if (!cached) {
          setLyrics(null);
          setTimedOut(true);
        }
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [track?.id, track?.videoId, track?.resolvedVideoId, track?.source, track?.findLyrics, track?.title, track?.artist]);

  // Keep preview in sync with LyricsPage: if authoritative lyrics are
  // re-fetched elsewhere (offset correction, clean-provider retry), the
  // shared bus notifies this panel so it doesn't stay few-seconds behind.
  useEffect(() => {
    if (!track || track.source !== "stream") return;
    const ids = new Set(streamIdentityVideoIds(track as unknown as Parameters<typeof streamIdentityVideoIds>[0]));
    const unsub = subscribeLyricsUpdates((videoId, updated) => {
      if (!ids.has(videoId)) return;
      const accepted = acceptSyncedLyrics(updated);
      if (!accepted) return;
      setLyrics((prev) => {
        if (!prev) {
          setLoading(false);
          setTimedOut(false);
          return accepted;
        }
        if (shouldReplaceLyricsWith(prev, accepted)) {
          setLoading(false);
          setTimedOut(false);
          return accepted;
        }
        return prev;
      });
    });
    return unsub;
  }, [track?.id, track?.videoId, track?.resolvedVideoId]);

  const activeIndex = useMemo(() => {
    if (!lyrics || !track) return -1;
    return findActiveLyricIndex(lyrics.lines, progress);
  }, [lyrics, track, progress]);

  // Whether the preview is on screen. The auto-center effect below only
  // follows active-line *advances*; depending on this makes it re-position
  // the instant the preview becomes visible (panel opened, or tab switched
  // back to Now Playing), so it doesn't sit stale until the next lyric plays.
  const previewVisible = open && tab === "now-playing";

  // Update top and bottom fade mask dynamically based on scroll position:
  // - Top fade is only applied when scrolled down past the top (> 1px).
  // - Bottom fade is only applied when scrolled up before the bottom (> 1px remaining).
  // - If the content fits without scrolling, no fade is applied.
  const updatePreviewMask = useCallback(() => {
    const container = previewScrollRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;

    if (maxScroll <= 1) {
      container.style.maskImage = "none";
      container.style.webkitMaskImage = "none";
      return;
    }

    const fadeTop = scrollTop > 2;
    const fadeBottom = scrollTop < maxScroll - 2;

    let mask = "none";
    if (fadeTop && fadeBottom) {
      mask = "linear-gradient(to bottom, transparent 0%, black 14%, black 86%, transparent 100%)";
    } else if (fadeTop) {
      mask = "linear-gradient(to bottom, transparent 0%, black 14%, black 100%)";
    } else if (fadeBottom) {
      mask = "linear-gradient(to bottom, black 0%, black 86%, transparent 100%)";
    }

    container.style.maskImage = mask;
    container.style.webkitMaskImage = mask;
  }, []);

  // Smoothly auto-center the active line in the fixed-height preview clip
  // (same centering math as the lyrics page's auto-scroll). Resets to the
  // top before the first lyric is reached, and snaps instantly when the
  // preview (re)appears instead of animating in from the top.
  useLayoutEffect(() => {
    const container = previewScrollRef.current;
    if (!container) {
      lastScrolledIndexRef.current = -1;
      return;
    }
    if (activeIndex < 0) {
      lastScrolledIndexRef.current = -1;
      container.scrollTop = 0;
      updatePreviewMask();
      return;
    }
    const el = previewLineRefs.current[activeIndex];
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target =
      container.scrollTop +
      (elRect.top + elRect.height / 2) -
      (containerRect.top + container.clientHeight / 2);
    const maxScroll = container.scrollHeight - container.clientHeight;
    const justMounted = lastScrolledIndexRef.current === -1;
    lastScrolledIndexRef.current = activeIndex;
    container.scrollTo({
      top: Math.max(0, Math.min(target, maxScroll)),
      behavior: justMounted ? "instant" : "smooth",
    });
    updatePreviewMask();
  }, [activeIndex, lyrics, previewVisible, updatePreviewMask]);

  useEffect(() => {
    const container = previewScrollRef.current;
    if (!container) return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updatePreviewMask();
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updatePreviewMask();
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [lyrics, previewVisible, updatePreviewMask]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleArtistClick = useCallback(() => {
    if (!track) return;
    const direct = getDirectArtistBrowseId(track);
    if (direct) {
      onNavigate({ name: "artist", browseId: direct, context: "default" });
      return;
    }
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);

  // Artist avatar for the bottom-of-menu artist entry. The rest of the app
  // shows artists as circular square avatars (their `cover`, not the wide
  // `banner`), so the Now Playing menu should too — not the album artwork
  // currently playing that track. Prefer a locally-cached copy so the avatar
  // renders reliably even when the CDN URL fails (expiry/CORS) or the image
  // is deferred by lazy loading while the panel is closed on startup.
  const [artistAvatar, setArtistAvatar] = useState<string | null>(null);
  const [artistAvatarCached, setArtistAvatarCached] = useState<string | null>(null);
  useEffect(() => {
    if (!track) {
      setArtistAvatar(null);
      setArtistAvatarCached(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      let browseId = getDirectArtistBrowseId(track);
      if (!browseId) {
        browseId = await resolveArtistBrowseId(track);
      }
      if (cancelled || !browseId) return;
      try {
        const detail = await getArtistDetail(browseId);
        if (cancelled) return;
        const source = detail.cover ?? detail.banner ?? null;
        setArtistAvatar(source);
        if (!source) {
          setArtistAvatarCached(null);
          return;
        }
        setArtistAvatarCached(peekCachedArtwork(source));
        try {
          const filePath = await cacheArtwork(source);
          if (!cancelled) setArtistAvatarCached(convertFileSrc(filePath));
        } catch {
          // Keep the remote URL as the fallback source.
        }
      } catch {
        if (cancelled) return;
        setArtistAvatar(null);
        setArtistAvatarCached(null);
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [track?.artist, track?.artistBrowseId, track?.artistCredits, track?.videoId, track?.id]);

  // Stream tracks often arrive without an album name or browseId. Resolve
  // the missing album metadata on demand so the album row actually loads.
  const [albumMetadata, setAlbumMetadata] = useState<{
    album: string | null;
    albumBrowseId: string | null;
  } | null>(null);
  useEffect(() => {
    if (!track) {
      setAlbumMetadata(null);
      return;
    }
    const needsAlbum = isPlaceholderAlbumName(track.album);
    const needsBrowseId = !track.albumBrowseId?.trim();
    if ((!needsAlbum && !needsBrowseId) || !track.videoId) {
      setAlbumMetadata(null);
      return;
    }

    let cancelled = false;
    void resolveTrackAlbumMetadata(track)
      .then((updates) => {
        if (cancelled) return;
        setAlbumMetadata({
          album: updates?.album ?? null,
          albumBrowseId: updates?.albumBrowseId ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAlbumMetadata(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    track?.id,
    track?.videoId,
    track?.album,
    track?.albumBrowseId,
    track?.title,
    track?.artist,
  ]);

  const displayAlbum = !isPlaceholderAlbumName(track?.album)
    ? track?.album ?? null
    : albumMetadata?.album ?? null;

  const handleSeekLyric = useCallback(
    (startTimeMs: number) => {
      player.seek(startTimeMs / 1000);
    },
    [player],
  );

  const handleNavigateToAlbum = useCallback(() => {
    if (!track) return;
    const resolvedBrowseId = albumMetadata?.albumBrowseId;
    const direct = getDirectAlbumBrowseId(
      resolvedBrowseId ? { albumBrowseId: resolvedBrowseId } : track,
    );
    if (direct) {
      onNavigate({ name: "album", browseId: direct, context: "default" });
      return;
    }
    // Upload tracks with no album metadata fall back to the Local tab of
    // the Collection page, mirroring PlayerBar's title-button behavior.
    const canResolve = Boolean(track.videoId || track.album?.trim());
    if (!canResolve) {
      onNavigate({ name: "collection", tab: "local" });
      return;
    }
    void resolveAlbumBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "album", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track, albumMetadata?.albumBrowseId]);

  const nextTrack = useMemo(() => {
    if (!player.queue || player.queue.length === 0) return null;
    if (player.queueIndex + 1 < player.queue.length) {
      return player.queue[player.queueIndex + 1];
    }
    if (player.repeat === "all" && player.queue.length > 0) {
      return player.queue[0];
    }
    return null;
  }, [player.queue, player.queueIndex, player.repeat]);

  const nextQueueIndex = useMemo(() => {
    if (!player.queue || player.queue.length === 0) return -1;
    if (player.queueIndex + 1 < player.queue.length) {
      return player.queueIndex + 1;
    }
    if (player.repeat === "all" && player.queue.length > 0) {
      return 0;
    }
    return -1;
  }, [player.queue, player.queueIndex, player.repeat]);

  const nextTrackContextTarget = useContextTrackTarget(nextTrack!, Boolean(nextTrack));

  const handlePlayNext = useCallback(() => {
    if (!nextTrack || nextQueueIndex < 0) return;
    player.playQueueIndex(nextQueueIndex, nextTrack.id);
  }, [player, nextTrack, nextQueueIndex]);

  return (
    <>
      <aside
        className={`nowplaying-shell absolute inset-y-0 right-0 z-40 flex h-full min-h-0 flex-col overflow-hidden bg-neutral-950 transition-[width] ${SIDEBAR_TRANSITION} ${isEffectivelyOpen ? "w-[var(--ui-nowplaying-open)]" : "w-0"}`}
        style={{ willChange: "width", contain: "size layout" } as React.CSSProperties}
        aria-label="Now playing"
        aria-hidden={!isEffectivelyOpen}
        inert={!isEffectivelyOpen ? true : undefined}
      >
        <div className="relative flex h-full w-[var(--ui-nowplaying-open)] min-w-0 flex-col overflow-hidden">
          {/* Tabs — Now Playing / Queue / Recently Played */}
          <div className="flex shrink-0 items-center justify-center gap-3 px-2 py-1.5" role="tablist" aria-label="Now playing views">
            <PanelTabButton
              active={tab === "now-playing"}
              icon={<Disc3 size={12} />}
              label="Now Playing"
              onClick={() => setTab("now-playing")}
            />
            <PanelTabButton
              active={tab === "queue"}
              icon={<List size={12} />}
              label="Queue"
              onClick={() => setTab("queue")}
            />
            <PanelTabButton
              active={tab === "recently-played"}
              icon={<History size={12} />}
              label="Recently Played"
              onClick={() => setTab("recently-played")}
            />
          </div>

          {tab !== "now-playing" ? (
            <QueuePanelBody
              tab={tab === "queue" ? "queued" : "recent"}
              open={open}
              onNavigate={onNavigate}
            />
          ) : !track ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-[4px] bg-neutral-900 text-neutral-600">
                <Disc3 size={18} />
              </div>
              <div className="text-sm font-semibold text-neutral-200">No song playing</div>
              <div className="max-w-[16rem] text-xs font-semibold leading-relaxed text-neutral-500">
                Start playback and your active song, lyrics, and artist will appear here.
              </div>
            </div>
          ) : (
            <>
              {/* Active song — centered artwork + metadata, flat, no shadows */}
              <div {...contextTarget} className="w-[var(--ui-nowplaying-open)] px-2 pt-2 shrink-0">
                <div className="flex w-full flex-col items-center gap-3 pb-2">
                  <div className={`h-[13rem] w-[13rem] shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`}>
                    {track.cover ? (
                      <ArtworkImage sources={[track.cover]} className="h-full w-full object-cover" loading="eager" />
                    ) : (
                      <DefaultArtwork />
                    )}
                  </div>
                  <div className="w-full min-w-0 text-center">
                    <button
                      type="button"
                      onClick={handleNavigateToAlbum}
                      className="block w-full text-center text-sm font-bold leading-tight text-white hover:text-white/90"
                    >
                      <Marquee
                        speed={MARQUEE_SPEED}
                        pauseSeconds={MARQUEE_PAUSE_SECONDS}
                        minDuration={MARQUEE_MIN_DURATION}
                        className="text-sm font-bold leading-tight text-white"
                      >
                        {track.title || "Untitled"}
                      </Marquee>
                    </button>
                    {displayAlbum && (
                      <button
                        type="button"
                        onClick={handleNavigateToAlbum}
                        className="block w-full text-center text-[11px] font-semibold text-neutral-500 transition-colors hover:text-white"
                      >
                        <Marquee
                          speed={MARQUEE_SPEED}
                          pauseSeconds={MARQUEE_PAUSE_SECONDS}
                          minDuration={MARQUEE_MIN_DURATION}
                          className="text-center text-[11px] font-semibold text-neutral-500"
                        >
                          {displayAlbum}
                        </Marquee>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Lyrics preview — flat, unboxed. Expands to fill available vertical space above Next in queue. */}
              <div className="mx-3 my-1 flex min-h-0 flex-1 flex-col">
                <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center text-center">
                  {loading && !lyrics ? (
                    <div className="flex items-center justify-center gap-1.5 py-1">
                      <LoaderCircle size={13} className="animate-spin text-neutral-600" />
                      <span className="text-xs font-semibold text-neutral-600">Loading lyrics…</span>
                    </div>
                  ) : !lyrics || lyrics.lines.length === 0 ? (
                    <div className="flex flex-col items-center gap-0.5 py-1 text-center">
                      <span className="text-xs font-semibold text-neutral-600">
                        {timedOut ? "No synced lyrics" : "Lyrics not found"}
                      </span>
                      {track.source === "upload" && !track.findLyrics && (
                        <span className="text-[11px] font-semibold text-neutral-600">
                          Enable “Find lyrics” for this upload
                        </span>
                      )}
                    </div>
                  ) : (
                    <div
                      ref={previewScrollRef}
                      onWheel={(e) => e.preventDefault()}
                      className="relative h-full w-full min-h-0 overflow-hidden select-none"
                    >
                      <div className="flex w-full flex-col py-4">
                        {lyrics.lines.map((line, index) => {
                          const active = index === activeIndex;
                          return (
                            <button
                              key={`${line.id}-${index}`}
                              ref={(el) => {
                                previewLineRefs.current[index] = el;
                              }}
                              type="button"
                              onClick={() => handleSeekLyric(line.startTimeMs)}
                              className={`block w-full px-3 py-0.5 text-center text-xs font-semibold leading-snug transition-colors duration-300 ${
                                active ? "text-white" : "text-neutral-600 hover:text-white"
                              }`}
                            >
                              <span>{line.text || "♪"}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom area: Next in queue + Artist */}
              <div className="mt-auto shrink-0">
                <div
                  aria-hidden
                  className="block h-4 w-full bg-gradient-to-b from-transparent to-neutral-950"
                />
                {nextTrack && (
                  <div className="w-[var(--ui-nowplaying-open)] px-2 pb-2 shrink-0">
                    <div className="px-1 pb-1.5 text-[11px] font-semibold text-neutral-500">
                      Next in queue
                    </div>
                    <button
                      type="button"
                      {...nextTrackContextTarget}
                      onClick={handlePlayNext}
                      className={`group relative z-10 flex w-full items-center gap-2.5 overflow-hidden rounded-xl p-1.5 text-left text-sm transition-[color,background-color] ${SIDEBAR_TRANSITION} font-semibold text-neutral-200 hover:bg-neutral-900/50 hover:text-white`}
                    >
                      <span className={`relative z-10 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-neutral-900 ${getArtworkRoundedClass()}`}>
                        {nextTrack.cover ? (
                          <ArtworkImage src={nextTrack.cover} className="h-full w-full object-cover" />
                        ) : (
                          <DefaultArtwork className="h-full w-full" />
                        )}
                      </span>
                      <span className="relative z-10 min-w-0 flex-1 overflow-hidden text-left">
                        <Marquee
                          speed={MARQUEE_SPEED}
                          pauseSeconds={MARQUEE_PAUSE_SECONDS}
                          minDuration={MARQUEE_MIN_DURATION}
                          className="text-sm font-semibold leading-tight text-neutral-200"
                        >
                          {nextTrack.title || "Untitled"}
                        </Marquee>
                        <span className="block truncate whitespace-nowrap text-[11px] font-semibold text-neutral-500">
                          {nextTrack.artist || "Unknown artist"}
                        </span>
                      </span>
                      <span className="relative z-10 mr-1 flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500 group-hover:text-white">
                        <ChevronRight size={14} />
                      </span>
                    </button>
                    <div className="mt-2.5 h-px w-full bg-white/[0.08]" aria-hidden="true" />
                  </div>
                )}
                <div className="w-[var(--ui-nowplaying-open)] px-2 pb-0.5 shrink-0">
                <button
                  type="button"
                  onClick={handleArtistClick}
                  className={`group relative z-10 mb-1 flex w-full items-center gap-2.5 overflow-hidden rounded-xl p-1.5 text-left text-sm transition-[color,background-color] ${SIDEBAR_TRANSITION} font-semibold text-neutral-200 hover:bg-neutral-900/50 hover:text-white`}
                >
                  <span className={`relative z-10 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-900`}>
                    {artistAvatarCached || artistAvatar ? (
                      <ArtworkImage
                        sources={artistAvatarCached ? [artistAvatarCached, artistAvatar] : [artistAvatar]}
                        className="h-full w-full object-cover"
                        loading="eager"
                      />
                    ) : (
                      <DefaultArtwork className="h-full w-full" />
                    )}
                  </span>
                  <span className="relative z-10 min-w-0 flex-1 overflow-hidden text-left">
                    <Marquee
                      speed={MARQUEE_SPEED}
                      pauseSeconds={MARQUEE_PAUSE_SECONDS}
                      minDuration={MARQUEE_MIN_DURATION}
                      className="text-sm font-semibold leading-tight text-neutral-200"
                    >
                      {track.artist || "Unknown artist"}
                    </Marquee>
                    <span className="block truncate whitespace-nowrap text-[11px] font-semibold text-neutral-500">
                      View artist
                    </span>
                  </span>
                  <span className="relative z-10 mr-1 flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500 group-hover:text-white">
                    <ChevronRight size={14} />
                  </span>
                </button>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {showCrescent && (
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-px right-[var(--ui-nowplaying-current)] z-40 h-[21px] w-[20px] bg-neutral-950"
          style={{ clipPath: "path('M 20 0 C 20 20 6 20 0 20 L 0 21 L 20 21 Z')" }}
        />
      )}
    </>
  );
}
