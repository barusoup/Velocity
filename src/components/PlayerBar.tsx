import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CircleArrowRight, ChevronUp, LoaderCircle, Pause, Play, RefreshCw, SkipBack, SkipForward, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  getArtistDetail,
  cacheArtwork,
  getEntityDetail,
  getSyncedLyricsForTrack,
  hydratePersistedLyricsForTrack,
  isLyricsExhaustedForTrack,
} from "../api";
import { fetchSyncedLyricsByMeta } from "../lyrics";
import { currentAudio, usePlayer, usePlayerActions, usePlayerState } from "../player";
import type { MediaTrack } from "../types";
import { useIsTrackSaved, useToggleTrackSave } from "../hooks/useCollectionSelectors";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import { usePlayerUiStore } from "../store/playerUiStore";
import { useSetting } from "../settings";
import { formatDuration, readLiveMediaDuration } from "../utils/media";
import {
  getDirectAlbumBrowseId,
  getDirectArtistBrowseId,
  resolveAlbumBrowseId,
  resolveArtistBrowseId,
} from "../utils/navigation";
import { ArtistCreditText } from "./PagesShared";
import type { View } from "./Sidebar";
import { ArtworkImage, DefaultArtwork, getArtworkRoundedClass } from "./Shared";
import { Marquee } from "./Marquee";
import {
  AnimatedRepeat,
  AnimatedShuffle,
  AnimatedVolume,
  QueueMenuIcon,
} from "./PlayerButtonIcons";
import { SaveButton } from "./SaveButton";

const loadQueuePanel = () => import("./QueuePanel");
const QueuePanel = lazy(() =>
  loadQueuePanel().then((m) => ({ default: m.QueuePanel })),
);

const SIDEBAR_LAYOUT_TRANSITION = "220ms cubic-bezier(0.22, 1, 0.36, 1)";

const MARQUEE_SPEED = 40;
const MARQUEE_PAUSE_SECONDS = 0.85;
const MARQUEE_MIN_DURATION = 4;
// Keep in sync with Marquee's overflow dead band so the title/artist
// shared cycle doesn't churn (and rewrite keyframes) on 1–2 px layout
// dither from the volume slider, seek bar, or progress ticks.
const MARQUEE_OVERFLOW_DEAD_BAND_PX = 1.5;

function ArtistLine({
  track,
  onNavigate,
  cycle,
  onOverflowChange,
  pending,
  onPendingChange,
}: {
  track: NonNullable<ReturnType<typeof usePlayer>["currentTrack"]>;
  onNavigate: (view: View) => void;
  cycle: number;
  onOverflowChange: (overflow: number) => void;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const directArtistBrowseId = getDirectArtistBrowseId(track);
  const handleResolveNavigate = useCallback(() => {
    if (pending) return;
    onPendingChange(true);
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        onPendingChange(false);
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => {
        onPendingChange(false);
      });
  }, [onNavigate, onPendingChange, pending, track]);
  const handleResolveArtistName = useCallback((artistName: string) => {
    if (pending) return;
    onPendingChange(true);
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        onPendingChange(false);
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => {
        onPendingChange(false);
      });
  }, [onNavigate, onPendingChange, pending]);

  return (
    <div className={`mt-0.5 text-[0.84rem] leading-tight text-neutral-400 transition-opacity duration-150 ${pending ? "opacity-60" : ""}`}>
      <Marquee
        speed={MARQUEE_SPEED}
        pauseSeconds={MARQUEE_PAUSE_SECONDS}
        minDuration={MARQUEE_MIN_DURATION}
        cycle={cycle}
        onOverflowChange={onOverflowChange}
      >
        <ArtistCreditText
          artist={track.artist}
          artistBrowseId={track.artistBrowseId}
          artistCredits={track.artistCredits}
          context="default"
          onNavigate={onNavigate}
          onResolveNavigate={directArtistBrowseId ? null : handleResolveNavigate}
          onResolveArtistName={handleResolveArtistName}
        />
      </Marquee>
    </div>
  );
}

export default function PlayerBar({
  sidebarOpen,
  onNavigate,
  viewName,
}: {
  sidebarOpen: boolean;
  onNavigate: (view: View) => void;
  viewName: string;
}) {
  const playerState = usePlayerState();
  const playerActions = usePlayerActions();
  const player = { ...playerState, ...playerActions };
  const [volumeHover, setVolumeHover] = useState(false);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const prevQueueOpenRef = useRef(false);
  const [queueMounted, setQueueMounted] = useState(false);
  const [titleOverflow, setTitleOverflow] = useState(0);
  const [artistOverflow, setArtistOverflow] = useState(0);
  const [syncOverflow, setSyncOverflow] = useState(0);
  // Pending flags surface a dimmed/wait-cursor state on the title and artist
  // links while their browseId is being resolved. Without these, a click on
  // a track with no direct browseId appears to do nothing for the seconds
  // the backend search takes, which reads as "broken" rather than "loading".
  const [albumPending, setAlbumPending] = useState(false);
  const [artistPending, setArtistPending] = useState(false);
  const handleArtistPendingChange = useCallback((pending: boolean) => {
    setArtistPending(pending);
  }, []);
  const [cachedCover, setCachedCover] = useState<string | null>(null);

  const onLyricsPage = viewName === "lyrics";
  const hidePlayerOnLyrics = useSetting("hidePlayerOnLyrics");
  const hideBarTimeoutRef = useRef<number | null>(null);
  const barHoveredRef = useRef(false);
  const mouseInBottomZoneRef = useRef(false);
  const [hasHoverCapability, setHasHoverCapability] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setHasHoverCapability(mql.matches);
    sync();
    const listener = (event: MediaQueryListEvent) => setHasHoverCapability(event.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    }
    mql.addListener(listener);
    return () => mql.removeListener(listener);
  }, []);

  const playerBarShellRef = useRef<HTMLDivElement | null>(null);
  const playerDockRef = useRef<HTMLDivElement | null>(null);
  const handleTitleOverflowChange = useCallback((value: number) => {
    setTitleOverflow(value);
  }, []);
  const handleArtistOverflowChange = useCallback((value: number) => {
    setArtistOverflow(value);
  }, []);
  useEffect(() => {
    const next = Math.max(titleOverflow, artistOverflow);
    setSyncOverflow((prev) => {
      if (next === 0 || prev === 0) return next;
      return Math.abs(prev - next) > MARQUEE_OVERFLOW_DEAD_BAND_PX ? next : prev;
    });
  }, [titleOverflow, artistOverflow]);
  const sharedCycle =
    syncOverflow > 0
      ? 2 * (MARQUEE_PAUSE_SECONDS + syncOverflow / MARQUEE_SPEED)
      : 0;
  const textContainerRef = useRef<HTMLDivElement | null>(null);
  const track = player.currentTrack;
  // Reset both pending flags whenever the current track changes so a stale
  // pending state from the previous track can't follow the new track's links.
  useEffect(() => {
    setAlbumPending(false);
    setArtistPending(false);
  }, [track?.id]);

  useEffect(() => {
    if (queueOpen) {
      setQueueMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setQueueMounted(false), 320);
    return () => window.clearTimeout(timer);
  }, [queueOpen]);
  const draggingVolume = useRef(false);
  const draggingSeek = useRef(false);
  const wasPlayingBeforeSeekDragRef = useRef(false);
  const lastSeekClientXRef = useRef<number | null>(null);

  const pendingVolumeRef = useRef(0);
  const volumeTrackRef = useRef<HTMLDivElement | null>(null);
  const volumeContainerRef = useRef<HTMLDivElement | null>(null);
  const seekTrackRef = useRef<HTMLDivElement | null>(null);
  const seekFillRef = useRef<HTMLDivElement | null>(null);
  const seekThumbRef = useRef<HTMLDivElement | null>(null);
  const seekElapsedRef = useRef<HTMLSpanElement | null>(null);
  const seekRemainingRef = useRef<HTMLSpanElement | null>(null);
  const playerRef = useRef(player);
  playerRef.current = player;
  const seekScrubProgressRef = useRef<number | null>(null);
  useEffect(() => {
    const unsub = usePlayerUiStore.subscribe(
      (state) => state.seekScrubProgress,
      (scrub) => {
        seekScrubProgressRef.current = scrub;
      },
    );
    seekScrubProgressRef.current = usePlayerUiStore.getState().seekScrubProgress;
    return unsub;
  }, []);
  const liveDurationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) void loadQueuePanel();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  // Preload artist detail and banner artwork when the track changes so
  // clicking the artist name in the player bar opens the page instantly.
  useEffect(() => {
    if (!track) return;

    let cancelled = false;

    const preload = async () => {
      try {
        let browseId = getDirectArtistBrowseId(track);
        if (!browseId) {
          browseId = await resolveArtistBrowseId(track);
        }
        if (cancelled || !browseId) return;

        const detail = await getArtistDetail(browseId);
        if (cancelled) return;

        if (detail.banner) {
          cacheArtwork(detail.banner).catch(() => {});
        }
        if (detail.cover && detail.cover !== detail.banner) {
          cacheArtwork(detail.cover).catch(() => {});
        }
      } catch {
        // Preloading is best-effort.
      }
    };

    void preload();

    return () => {
      cancelled = true;
    };
  }, [track]);

  // Preload album detail and cover artwork when the track changes so
  // clicking the song title in the player bar opens the album page
  // instantly. Mirrors the artist preload above; without this, an album
  // click with no direct albumBrowseId would wait for up to three
  // sequential network calls (resolveAlbumBrowseId + getEntityDetail)
  // before the page could render anything beyond the loading panel.
  useEffect(() => {
    if (!track) return;

    let cancelled = false;

    const preload = async () => {
      try {
        let browseId = getDirectAlbumBrowseId(track);
        if (!browseId) {
          browseId = await resolveAlbumBrowseId(track);
        }
        if (cancelled || !browseId) return;

        const detail = await getEntityDetail(browseId);
        if (cancelled) return;

        if (detail.cover) {
          cacheArtwork(detail.cover).catch(() => {});
        }
      } catch {
        // Preloading is best-effort.
      }
    };

    void preload();

    return () => {
      cancelled = true;
    };
  }, [track]);

  // Proactively cache the current track's cover artwork so PlayerBar can
  // display it from a local file path instead of relying on the YouTube
  // Music CDN URL (which can fail due to expiry, CORS, or network issues).
  // The cached path is used as the primary source; the CDN URL is kept as
  // a fallback. This mirrors the pattern already used for album/artist
  // artwork preloading above and for accent-color extraction in AccentProvider.
  useEffect(() => {
    setCachedCover(null);
    if (!track?.cover) return;

    let cancelled = false;
    const source = track.cover.startsWith("//") ? `https:${track.cover}` : track.cover;
    if (source.startsWith("asset://") || source.startsWith("blob:") || source.startsWith("data:")) {
      return;
    }

    cacheArtwork(source)
      .then((filePath) => {
        if (!cancelled) setCachedCover(convertFileSrc(filePath));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [track?.cover]);

  const [lyricsAvailable, setLyricsAvailable] = useState(
    () => (track?.source === "stream" ? hydratePersistedLyricsForTrack(track) !== null : false),
  );
  const [lyricsLoading, setLyricsLoading] = useState(
    () =>
      track?.source === "stream" &&
      track !== null &&
      hydratePersistedLyricsForTrack(track) === null,
  );
  const [lyricsLoadFailed, setLyricsLoadFailed] = useState(false);

  useEffect(() => {
    if (!lyricsLoadFailed) return;
    const t = setTimeout(() => setLyricsLoadFailed(false), 1100);
    return () => clearTimeout(t);
  }, [lyricsLoadFailed]);

  useEffect(() => {
    if (!track) {
      setLyricsAvailable(false);
      return;
    }

    // Local uploads have no `videoId` to look lyrics up by — the lyrics
    // page falls back to a title+artist search when the user opted in
    // via the "Find lyrics" checkbox during import. Mirror that here so
    // the cover-art "Open lyrics" overlay actually appears for uploads.
    if (track.source === "upload") {
      if (!track.findLyrics) {
        setLyricsAvailable(false);
        return;
      }
      if (isLyricsExhaustedForTrack(track)) {
        setLyricsAvailable(false);
        setLyricsLoading(false);
        setLyricsLoadFailed(true);
        return;
      }
      setLyricsAvailable(false);
      setLyricsLoading(true);
      setLyricsLoadFailed(false);
      let cancelled = false;
      void fetchSyncedLyricsByMeta(track)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setLyricsAvailable(true);
          setLyricsLoading(false);
          setLyricsLoadFailed(false);
        } else {
          setLyricsAvailable(false);
          setLyricsLoading(false);
          setLyricsLoadFailed(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLyricsAvailable(false);
        setLyricsLoading(false);
        setLyricsLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    }

    const effectiveVideoId = track.resolvedVideoId ?? track.videoId;
    if (!effectiveVideoId) {
      setLyricsAvailable(false);
      setLyricsLoading(false);
      setLyricsLoadFailed(false);
      return;
    }

    if (hydratePersistedLyricsForTrack(track)) {
      setLyricsAvailable(true);
      setLyricsLoading(false);
      setLyricsLoadFailed(false);
      return;
    }

    if (isLyricsExhaustedForTrack(track)) {
      setLyricsAvailable(false);
      setLyricsLoading(false);
      setLyricsLoadFailed(true);
      return;
    }

    setLyricsAvailable(false);
    setLyricsLoading(true);
    setLyricsLoadFailed(false);

    let cancelled = false;

    void getSyncedLyricsForTrack(track, { persist: true })
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setLyricsAvailable(true);
          setLyricsLoading(false);
          setLyricsLoadFailed(false);
        } else {
          setLyricsAvailable(false);
          setLyricsLoading(false);
          setLyricsLoadFailed(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLyricsAvailable(false);
        setLyricsLoading(false);
        setLyricsLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
    // Tighter dep list than the LyricsPage equivalent: we only need to
    // know whether lyrics are *available* to render the affordance, not
    // refetch the lyrics themselves. So we only watch the keys that
    // distinguish "this is a different track" from "this is the same
    // track with a metadata tweak". For stream tracks the effective
    // lyrics id (`resolvedVideoId ?? videoId`) is canonical; for uploads,
    // the (id, findLyrics) pair is.
  }, [track?.id, track?.videoId, track?.resolvedVideoId, track?.source, track?.findLyrics]);

  // Lyrics page: auto-hide player bar, reveal on hover near bottom.
  // Uses the same pattern as the search bar: a bottom-zone sensor
  // (mouseenter/mouseleave) combined with dock hover tracking and a
  // grace timeout. React state drives the hidden class so re-renders
  // (e.g. clicking a button) don't clobber DOM-manipulated classes.
  // When hidePlayerOnLyrics is enabled the bar is omitted entirely
  // (see the early return below) — this path only runs for the default
  // hover-to-reveal behavior.
  const [barVisible, setBarVisible] = useState(true);

  const showBar = useCallback(() => {
    if (hideBarTimeoutRef.current !== null) {
      clearTimeout(hideBarTimeoutRef.current);
      hideBarTimeoutRef.current = null;
    }
    setBarVisible(true);
  }, []);

  const scheduleHideBar = useCallback((fromDockLeave = false) => {
    if (hideBarTimeoutRef.current !== null) {
      clearTimeout(hideBarTimeoutRef.current);
    }
    if (queueOpen) return;
    hideBarTimeoutRef.current = window.setTimeout(() => {
      const keepForBottomZone = !fromDockLeave && mouseInBottomZoneRef.current;
      if (!barHoveredRef.current && !keepForBottomZone) {
        setBarVisible(false);
      }
      hideBarTimeoutRef.current = null;
    }, 250);
  }, [queueOpen]);

  useEffect(() => {
    const wasQueueOpen = prevQueueOpenRef.current;
    prevQueueOpenRef.current = queueOpen;
    if (!onLyricsPage || !hasHoverCapability || queueOpen || hidePlayerOnLyrics) {
      setBarVisible(true);
      return;
    }
    if (wasQueueOpen) return;
    if (barHoveredRef.current || mouseInBottomZoneRef.current) {
      scheduleHideBar();
    } else {
      setBarVisible(false);
    }
  }, [onLyricsPage, hasHoverCapability, queueOpen, hidePlayerOnLyrics, scheduleHideBar]);

  // Bottom-zone detection via mousemove: tracks when the pointer enters
  // or exits the bottom 150px of the viewport. Replaces the old
  // pointer-events-toggling sensor div which caused the dock to
  // sometimes miss mouseenter/mouseleave, leaving the bar visible.
  useEffect(() => {
    if (!onLyricsPage || !hasHoverCapability || hidePlayerOnLyrics) return;

    const handleMouseMove = (e: MouseEvent) => {
      const threshold = window.innerHeight - 150;
      const isInZone = e.clientY >= threshold;

      if (isInZone && !mouseInBottomZoneRef.current) {
        mouseInBottomZoneRef.current = true;
        showBar();
      } else if (!isInZone && mouseInBottomZoneRef.current) {
        mouseInBottomZoneRef.current = false;
        scheduleHideBar();
      }
    };

    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [onLyricsPage, hasHoverCapability, hidePlayerOnLyrics, showBar, scheduleHideBar]);

  // When the cursor leaves the browser window (e.g. alt+tab, or moving
  // diagonally out of the viewport) no mouseleave fires on the dock, so
  // hover refs stay stale and the bar never auto-hides. Detect the exit
  // via document mouseout with a null relatedTarget and reset everything.
  useEffect(() => {
    if (!onLyricsPage || !hasHoverCapability || hidePlayerOnLyrics) return;

    const handleWindowExit = (e: MouseEvent) => {
      if (e.relatedTarget !== null) return;
      barHoveredRef.current = false;
      mouseInBottomZoneRef.current = false;
      setVolumeHover(false);
      scheduleHideBar();
    };

    document.addEventListener("mouseout", handleWindowExit);
    return () => document.removeEventListener("mouseout", handleWindowExit);
  }, [onLyricsPage, hasHoverCapability, hidePlayerOnLyrics, scheduleHideBar]);

  const calcVolumeFromClientX = useCallback((clientX: number) => {
    const el = volumeTrackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const resolveSeekDuration = useCallback(() => {
    const p = playerRef.current;
    const trackDuration = p.currentTrack?.durationSeconds;
    const fromLive = readLiveMediaDuration(currentAudio.current, trackDuration);
    if (fromLive > 0) {
      liveDurationRef.current = fromLive;
      return fromLive;
    }
    const fallback =
      liveDurationRef.current ||
      p.duration ||
      trackDuration ||
      0;
    return fallback > 0 ? fallback : 0;
  }, []);

  // Paint the seek bar straight from the media element so it cannot stall
  // behind sparse React context updates or missing duration metadata.
  useEffect(() => {
    if (!track) return;
    const audio = currentAudio.current;
    if (!audio) return;

    let frameId = 0;
    let running = true;
    let lastProgress = -1;
    let lastDuration = -1;
    let lastPct = -1;

    const paintSeekBar = () => {
      if (!running) return;

      const scrub = seekScrubProgressRef.current;
      if (audio.paused && scrub === null) return;

      frameId = window.requestAnimationFrame(paintSeekBar);

      const latestAudio = currentAudio.current;
      const progress =
        scrub ??
        (latestAudio && Number.isFinite(latestAudio.currentTime)
          ? latestAudio.currentTime
          : usePlayerUiStore.getState().progress);
      const duration = resolveSeekDuration();

      const pct =
        duration > 0
          ? Math.min(100, Math.max(0, (progress / duration) * 100))
          : 0;

      const progressChanged = Math.abs(progress - lastProgress) >= 0.01;
      if (progressChanged) {
        lastProgress = progress;
        if (seekElapsedRef.current) {
          seekElapsedRef.current.textContent = formatDuration(progress);
        }
        if (seekRemainingRef.current) {
          seekRemainingRef.current.textContent = `-${formatDuration(Math.max(0, duration - progress))}`;
        }
      }

      if (Math.abs(duration - lastDuration) >= 0.5) {
        lastDuration = duration;
        if (seekRemainingRef.current) {
          seekRemainingRef.current.textContent = `-${formatDuration(Math.max(0, duration - progress))}`;
        }
      }

      if (Math.abs(pct - lastPct) >= 0.05) {
        lastPct = pct;
        const width = `${pct}%`;
        if (seekFillRef.current) seekFillRef.current.style.width = width;
        if (seekThumbRef.current) seekThumbRef.current.style.left = width;
      }
    };

    const schedule = () => {
      if (!running) return;
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(paintSeekBar);
    };

    const onWake = () => schedule();
    audio.addEventListener("play", onWake);
    audio.addEventListener("seeking", onWake);
    audio.addEventListener("seeked", onWake);

    const unsubScrub = usePlayerUiStore.subscribe(
      (state) => state.seekScrubProgress,
      (scrub) => {
        if (scrub !== null) schedule();
      },
    );

    if (!audio.paused || seekScrubProgressRef.current !== null) {
      schedule();
    }

    return () => {
      running = false;
      window.cancelAnimationFrame(frameId);
      audio.removeEventListener("play", onWake);
      audio.removeEventListener("seeking", onWake);
      audio.removeEventListener("seeked", onWake);
      unsubScrub();
    };
  }, [track?.id, resolveSeekDuration]);

  const calcSeekSecondsFromClientX = useCallback((clientX: number) => {
    const el = seekTrackRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = resolveSeekDuration();
    if (dur <= 0) return null;
    return pct * dur;
  }, [resolveSeekDuration]);

  const commitSeekFromClientX = useCallback((clientX: number) => {
    const seconds = calcSeekSecondsFromClientX(clientX);
    if (seconds === null) return;
    seekScrubProgressRef.current = seconds;
    playerRef.current.seek(seconds);
    playerRef.current.updateSeekScrubPreview(seconds);
  }, [calcSeekSecondsFromClientX]);

  const applyLiveDrag = useCallback((clientX: number) => {
    const pct = calcVolumeFromClientX(clientX);
    pendingVolumeRef.current = pct;
    playerRef.current.setLiveVolume(pct);
    setDragVolume(pct);
  }, [calcVolumeFromClientX]);

  useEffect(() => {
    let rafId: number | null = null;
    let lastClientX: number | null = null;

    const flushVolume = () => {
      rafId = null;
      if (lastClientX === null) return;
      applyLiveDrag(lastClientX);
      lastClientX = null;
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!draggingVolume.current && !draggingSeek.current) return;
      if (draggingSeek.current) {
        lastSeekClientXRef.current = event.clientX;
        const seconds = calcSeekSecondsFromClientX(event.clientX);
        if (seconds !== null) {
          seekScrubProgressRef.current = seconds;
          playerRef.current.updateSeekScrubPreview(seconds);
        }
        return;
      }
      lastClientX = event.clientX;
      if (rafId === null) {
        rafId = requestAnimationFrame(flushVolume);
      }
    };

    const onMouseUp = () => {
      const savedClientX = lastClientX;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        flushVolume();
      }
      if (draggingVolume.current) {
        playerRef.current.setVolume(pendingVolumeRef.current);
        setDragVolume(null);
        const container = volumeContainerRef.current;
        if (container && savedClientX !== null) {
          const rect = container.getBoundingClientRect();
          if (savedClientX < rect.left || savedClientX > rect.right) {
            setVolumeHover(false);
          }
        }
      }
      if (draggingSeek.current) {
        const resume = wasPlayingBeforeSeekDragRef.current;
        wasPlayingBeforeSeekDragRef.current = false;
        const seconds =
          lastSeekClientXRef.current === null
            ? null
            : calcSeekSecondsFromClientX(lastSeekClientXRef.current);
        playerRef.current.finishSeekScrub(seconds, resume);
        seekScrubProgressRef.current = null;
        lastSeekClientXRef.current = null;
      }
      draggingVolume.current = false;
      draggingSeek.current = false;
      lastClientX = null;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [applyLiveDrag, calcSeekSecondsFromClientX]);

  useEffect(() => {
    if (!queueOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target?.closest?.(".queue-panel") && !target?.closest?.("[data-queue-toggle]")) setQueueOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [queueOpen]);

  const contextTarget = useContextTrackTarget(track!, Boolean(track));
  const directAlbumBrowseId = track ? getDirectAlbumBrowseId(track) : null;
  const handleNavigateToAlbum = useCallback(() => {
    if (!track || albumPending) return;
    if (directAlbumBrowseId) {
      onNavigate({ name: "album", browseId: directAlbumBrowseId, context: "default" });
      return;
    }

    const clickedTrackId = track.id;
    setAlbumPending(true);
    void resolveAlbumBrowseId(track)
      .then((browseId) => {
        setAlbumPending(false);
        if (!browseId || playerRef.current.currentTrack?.id !== clickedTrackId) return;
        onNavigate({ name: "album", browseId, context: "default" });
      })
      .catch(() => {
        setAlbumPending(false);
      });
  }, [albumPending, directAlbumBrowseId, onNavigate, track]);

  // Fallback destination for local upload tracks that have no album
  // metadata. We can usually resolve a YouTube Music album from
  // (title, artist) — see `canNavigateToAlbum` and `handleNavigateToAlbum`
  // above — but if the user didn't fill in either field, the title
  // button still needs somewhere to land, so it jumps to the Local
  // tab of the Collection page where the row lives.
  const handleNavigateToLocal = useCallback(() => {
    onNavigate({ name: "collection", tab: "local" });
  }, [onNavigate]);

  const canNavigateToAlbum = Boolean(directAlbumBrowseId || track?.videoId || track?.album?.trim());
  const hasLyrics = lyricsAvailable && viewName !== "lyrics";

  if (!track) return null;
  if (onLyricsPage && hidePlayerOnLyrics) return null;

  const duration =
    player.duration ||
    track.durationSeconds ||
    0;
  const seekScrubProgress = usePlayerUiStore((state) => state.seekScrubProgress);
  const displayProgress =
    seekScrubProgress ?? usePlayerUiStore.getState().progress;
  const remaining = Math.max(0, duration - displayProgress);
  const progressPct = duration ? (displayProgress / duration) * 100 : 0;

  const lyricsEnabled = onLyricsPage && hasHoverCapability && !hidePlayerOnLyrics;
  const lyricsHideActive = lyricsEnabled && !barVisible && !queueOpen;

  return (
      <div
        ref={playerDockRef}
        className="fixed bottom-[var(--ui-player-bottom)] z-40"
        style={{
          left: sidebarOpen
            ? "calc((100vw + var(--ui-sidebar-open)) / 2)"
            : "calc((100vw + var(--ui-sidebar-closed)) / 2)",
          transform: "translateX(-50%)",
          transition: `left ${SIDEBAR_LAYOUT_TRANSITION}`,
        }}
        onMouseEnter={() => {
          barHoveredRef.current = true;
          if (lyricsEnabled) {
            showBar();
          }
        }}
        onMouseLeave={() => {
          barHoveredRef.current = false;
          if (lyricsEnabled) {
            scheduleHideBar(true);
          }
        }}
      >
        {queueMounted && (
          <Suspense fallback={null}>
            <QueuePanel open={queueOpen} onNavigate={onNavigate} />
          </Suspense>
        )}
        <div
          ref={playerBarShellRef}
          className={`player-bar-shell relative z-10 flex items-center gap-[clamp(0.75rem,1.25vw,1.25rem)] rounded-xl border border-white/12 bg-neutral-950/90 py-[clamp(0.45rem,0.625vw,0.7rem)] shadow-[0_20px_60px_rgba(0,0,0,0.62)] backdrop-blur-md${lyricsHideActive ? " player-bar-lyrics-hidden" : ""}`}
          style={{
            paddingLeft: "clamp(0.3rem, 0.5vw, 0.4rem)",
            paddingRight: "clamp(0.6rem,0.9375vw,0.9rem)",
            width: sidebarOpen
              ? "min(var(--ui-player-max), calc(100vw - var(--ui-sidebar-open) - 1.5rem))"
              : "min(var(--ui-player-max), calc(100vw - var(--ui-sidebar-closed) - 1.5rem))",
            transition: onLyricsPage
              ? `width ${SIDEBAR_LAYOUT_TRANSITION}, opacity 320ms cubic-bezier(0.32, 0.72, 0, 1), transform 360ms cubic-bezier(0.32, 0.72, 0, 1)`
              : `width ${SIDEBAR_LAYOUT_TRANSITION}`,
          }}
        >
          <div
            {...contextTarget}
            className="hidden min-w-0 w-[var(--ui-player-side)] shrink-0 items-center gap-2 min-[720px]:flex"
          >
            <div className={`group relative h-[var(--ui-art-sm)] w-[var(--ui-art-sm)] shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`}>
              {(track.cover || cachedCover) ? (
                <ArtworkImage sources={cachedCover ? [cachedCover, track.cover] : [track.cover]} className="h-full w-full object-cover" />
              ) : (
                <DefaultArtwork />
              )}

              {hasLyrics && (
                <div className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 bg-black/45"
                  />
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigate({ name: "lyrics" });
                    }}
                    aria-label="Open synced lyrics"
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black text-white shadow-[0_10px_28px_rgba(0,0,0,0.55)]">
                      <ChevronUp size={16} strokeWidth={2.25} />
                    </span>
                  </button>
                </div>
              )}

              <div
                className={`absolute inset-0 transition-opacity duration-200 ${
                  lyricsLoading || lyricsLoadFailed
                    ? "opacity-100"
                    : "opacity-0 pointer-events-none"
                }`}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-black/45"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span
                    className={`absolute transition-all duration-200 ${
                      lyricsLoadFailed
                        ? "opacity-0 scale-75"
                        : "opacity-100 scale-100"
                    }`}
                  >
                    <LoaderCircle
                      size={18}
                      className={`text-white ${lyricsLoading ? "animate-spin" : ""}`}
                    />
                  </span>
                  <span
                    className={`absolute transition-all duration-200 ${
                      lyricsLoadFailed
                        ? "opacity-100 scale-100"
                        : "opacity-0 scale-75"
                    }`}
                  >
                    <X size={16} strokeWidth={2.25} className="text-white" />
                  </span>
                </div>
              </div>
            </div>
            <div className="relative min-w-0 flex-1">
              <div
                ref={textContainerRef}
                className="min-w-0"
              >
                {canNavigateToAlbum ? (
                  <button
                    type="button"
                    onClick={handleNavigateToAlbum}
                    className={`block w-full text-left text-[0.98rem] font-semibold leading-tight transition hover:text-white focus-visible:outline-none ${albumPending ? "cursor-wait opacity-60" : "text-white/85"}`}
                  >
                    <Marquee
                      speed={MARQUEE_SPEED}
                      pauseSeconds={MARQUEE_PAUSE_SECONDS}
                      minDuration={MARQUEE_MIN_DURATION}
                      cycle={sharedCycle}
                      onOverflowChange={handleTitleOverflowChange}
                    >
                      {track.title}
                    </Marquee>
                  </button>
                ) : track.source === "upload" ? (
                  <button
                    type="button"
                    onClick={handleNavigateToLocal}
                    className="block w-full text-left text-[0.98rem] font-semibold leading-tight text-white/85 transition hover:text-white focus-visible:outline-none"
                  >
                    <Marquee
                      speed={MARQUEE_SPEED}
                      pauseSeconds={MARQUEE_PAUSE_SECONDS}
                      minDuration={MARQUEE_MIN_DURATION}
                      cycle={sharedCycle}
                      onOverflowChange={handleTitleOverflowChange}
                    >
                      {track.title}
                    </Marquee>
                  </button>
                ) : (
                  <Marquee
                    className="text-[0.98rem] font-semibold leading-tight text-white"
                    speed={MARQUEE_SPEED}
                    pauseSeconds={MARQUEE_PAUSE_SECONDS}
                    minDuration={MARQUEE_MIN_DURATION}
                    cycle={sharedCycle}
                    onOverflowChange={handleTitleOverflowChange}
                  >
                    {track.title}
                  </Marquee>
                )}
                <div className="flex w-fit max-w-full items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <ArtistLine
                      track={track}
                      onNavigate={onNavigate}
                      cycle={sharedCycle}
                      onOverflowChange={handleArtistOverflowChange}
                      pending={artistPending}
                      onPendingChange={handleArtistPendingChange}
                    />
                  </div>
                  {track.source !== "upload" && (
                    <div className="shrink-0 mt-1">
                      <PlayerBarTrackSave track={track} />
                    </div>
                  )}
                </div>
                {player.lastError && <div className="truncate text-[11px] text-red-400 leading-tight mt-0.5">{player.lastError}</div>}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col items-center">
            <div className="flex h-9 items-center justify-center gap-2">
              <button
                type="button"
                onClick={player.toggleShuffle}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition duration-100 ease-out ${
                  player.shuffle ? "text-white" : "text-neutral-400 hover:text-white"
                }`}
              >
                <AnimatedShuffle active={player.shuffle} />
              </button>
              <button
                type="button"
                onClick={player.prev}
                className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-200 transition duration-100 ease-out hover:text-white"
              >
                <SkipBack size={18} fill="currentColor" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (player.lastError) {
                    player.clearError();
                    player.retry();
                    return;
                  }
                  player.togglePlay();
                }}
                aria-label={
                  player.lastError
                    ? "Retry loading current track"
                    : player.isBuffering
                      ? "Loading"
                      : player.isPlaying
                        ? "Pause"
                        : "Play"
                }
                className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-[transform,background-color,color] duration-[80ms] ease-out active:scale-[0.93] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                  player.lastError
                    ? "bg-red-500 text-white hover:bg-red-400 active:bg-red-500/90"
                    : "bg-white text-black active:bg-white/85"
                }`}
              >
                {player.isBuffering && !player.lastError ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : player.lastError ? (
                  <RefreshCw size={16} strokeWidth={2.25} />
                ) : player.isPlaying ? (
                  <Pause size={16} fill="currentColor" strokeWidth={0} />
                ) : (
                  <Play size={16} fill="currentColor" strokeWidth={0} />
                )}
              </button>
              <button
                type="button"
                onClick={() => player.next(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-200 transition duration-100 ease-out hover:text-white"
              >
                <SkipForward size={18} fill="currentColor" />
              </button>
              <button
                type="button"
                onClick={player.cycleRepeat}
                className={`relative flex h-8 w-8 items-center justify-center rounded-full transition duration-100 ease-out ${
                  player.repeat !== "off" ? "text-white" : "text-neutral-400 hover:text-white"
                }`}
              >
                <AnimatedRepeat mode={player.repeat} />
              </button>
            </div>

            <div className="mt-1 flex w-full items-center gap-3">
              <span
                ref={seekElapsedRef}
                className="w-10 text-right text-[11px] tabular-nums text-neutral-400"
              >
                {formatDuration(displayProgress)}
              </span>
              <div className="relative h-1 flex-1">
                <div
                  className="absolute -inset-y-2 left-0 right-0 z-10 cursor-pointer"
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    wasPlayingBeforeSeekDragRef.current = player.beginSeekScrub();
                    draggingSeek.current = true;
                    lastSeekClientXRef.current = event.clientX;
                    commitSeekFromClientX(event.clientX);
                  }}
                />
                <div
                  ref={seekTrackRef}
                  className="group relative h-full rounded-full bg-neutral-800"
                >
                  <div
                    ref={seekFillRef}
                    className="pointer-events-none absolute left-0 top-0 z-[1] h-full min-w-0 rounded-full bg-white"
                    style={{ width: `${progressPct}%` }}
                  />
                  <div
                    ref={seekThumbRef}
                    className="pointer-events-none absolute top-1/2 z-[2] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity duration-75 group-hover:opacity-100"
                    style={{ left: `${progressPct}%` }}
                  />
                </div>
              </div>
              <span
                ref={seekRemainingRef}
                className="w-10 text-[11px] tabular-nums text-neutral-400"
              >
                -{formatDuration(remaining)}
              </span>
            </div>
          </div>

          <div className="hidden w-[var(--ui-player-side)] shrink-0 items-center justify-end gap-1 min-[720px]:flex">
            <button
              type="button"
              onClick={() => player.setAutoplay(!player.autoplay)}
              aria-label={player.autoplay ? "Autoplay on" : "Autoplay off"}
              aria-pressed={player.autoplay}
              data-queue-toggle
              className={`relative hidden h-9 w-9 items-center justify-center rounded-full transition-[opacity,transform,color] duration-150 ease-out sm:flex ${
                volumeHover ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
              } ${player.autoplay ? "text-white" : "text-neutral-400 hover:text-white"}`}
            >
              <CircleArrowRight size={18} />
              <span
                className={`absolute bottom-0.5 h-1 w-1 rounded-full bg-white transition-opacity ${
                  player.autoplay ? "opacity-100" : "opacity-0"
                }`}
              />
            </button>
            <button
              type="button"
              data-queue-toggle
              aria-label={queueOpen ? "Close queue" : "Open queue"}
              aria-expanded={queueOpen}
              onClick={() => {
                if (queueOpen) {
                  setQueueOpen(false);
                  return;
                }

                setQueueMounted(true);
                setQueueOpen(false);
                void loadQueuePanel().finally(() => {
                  window.requestAnimationFrame(() => {
                    setQueueOpen(true);
                  });
                });
              }}
              className={`hidden h-9 w-9 items-center justify-center rounded-full transition-[opacity,transform,color] duration-150 ease-out sm:flex ${
                volumeHover ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
              } ${queueOpen ? "text-white" : "text-neutral-400 hover:text-white"}`}
            >
              <QueueMenuIcon />
            </button>
            <div
              ref={volumeContainerRef}
              className="relative flex items-center justify-end py-2"
              onMouseEnter={() => setVolumeHover(true)}
              onMouseLeave={() => {
                if (!draggingVolume.current) setVolumeHover(false);
              }}
            >
              <button
                type="button"
                onClick={player.toggleMute}
                className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition duration-100 ease-out hover:text-white"
              >
                <AnimatedVolume volume={dragVolume ?? player.volume} muted={dragVolume !== null ? false : player.muted} />
              </button>
              <div
                className={`absolute right-9 top-1/2 z-10 flex -translate-y-1/2 items-center overflow-hidden transition-[max-width,opacity,transform] duration-200 ${
                  volumeHover
                    ? "max-w-[136px] translate-x-0 opacity-100"
                    : "pointer-events-none max-w-0 translate-x-2 opacity-0"
                }`}
                style={{ transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}
              >
                <div className="px-3 py-2">
                  <div className="relative h-1 w-[104px]">
                    <div
                      className="absolute -inset-y-2 left-0 right-0 z-10 cursor-pointer"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        draggingVolume.current = true;
                        applyLiveDrag(event.clientX);
                      }}
                    />
                    <div ref={volumeTrackRef} className="relative h-full w-full rounded-full bg-neutral-800">
                      <div
                        className={`absolute left-0 top-0 h-full rounded-full bg-white ${
                          dragVolume === null ? "volume-fill-animating" : ""
                        }`}
                        style={{ width: `${(dragVolume ?? (player.muted ? 0 : player.volume)) * 100}%` }}
                      />
                      <div
                        className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-opacity duration-150 ${
                          dragVolume === null ? "volume-thumb-animating" : ""
                        }`}
                        style={{
                          left: `${(dragVolume ?? (player.muted ? 0 : player.volume)) * 100}%`,
                          opacity: volumeHover ? 1 : 0,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
  );
}

function PlayerBarTrackSave({ track }: { track: MediaTrack }) {
  const isSaved = useIsTrackSaved(track);
  const toggleSave = useToggleTrackSave(track);
  return (
    <SaveButton
      isSaved={isSaved}
      size="sm"
      onToggle={toggleSave}
      ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
      className="!h-5 !w-5"
    />
  );
}
