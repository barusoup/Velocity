import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import {
  hydratePersistedLyricsForTrack,
  isLyricsExhaustedForTrack,
  lyricsCacheVideoId,
} from "../api";
import { fetchSyncedLyrics, fetchSyncedLyricsByMeta, findActiveLyricIndex, type SyncedLyrics } from "../lyrics";
import { useAccent } from "../accent-context";
import { useSetting } from "../settings";
import { currentAudio, usePlayer } from "../player";
import { usePlayerUiStore } from "../store/playerUiStore";
import { rgbToCss, type RgbColor } from "../utils/artwork-color";
import { type View } from "./Sidebar";

/** Map a bar's horizontal position to the analyser spectrum (log-spaced). */
function sampleLogFrequencyAt(
  dataArray: Float32Array,
  t: number,
  minDb: number,
  maxDb: number,
): number {
  const bufferLength = dataArray.length;
  if (bufferLength <= 1) return 0;

  const dbRange = maxDb - minDb;
  if (dbRange <= 0) return 0;

  const minBin = 1;
  const maxBin = bufferLength - 1;
  const logMin = Math.log(minBin);
  const logMax = Math.log(maxBin);
  const clampedT = Math.min(1, Math.max(0, t));
  const center = Math.exp(logMin + clampedT * (logMax - logMin));
  const left = Math.min(maxBin, Math.max(minBin, Math.floor(center)));
  const right = Math.min(maxBin, left + 1);
  const frac = center - left;

  const loDb = dataArray[left] ?? minDb;
  const hiDb = dataArray[right] ?? minDb;
  const db = loDb * (1 - frac) + hiDb * frac;

  return Math.max(0, Math.min(1, (db - minDb) / dbRange));
}

/** Bars ease to flat at full opacity, then the visualizer fades out. */
const PAUSE_SETTLE_MS = 300;
const PAUSE_FADE_MS = 200;

function resolveLyricsScrollContainer(): HTMLElement | null {
  const lyricsScrollArea = document.querySelector(".lyrics-scroll-area");
  if (!lyricsScrollArea) {
    return document.querySelector(".main-scrollport");
  }
  let container = lyricsScrollArea.parentElement;
  while (container) {
    const style = window.getComputedStyle(container);
    if (style.overflowY === "auto" || style.overflowY === "scroll") break;
    container = container.parentElement;
  }
  return container;
}

type PausePhase = "idle" | "settling" | "fading";

function WaveformVisualizer({
  getAnalyser,
  accent,
  isPlaying,
}: {
  getAnalyser: () => AnalyserNode | null;
  accent: RgbColor;
  isPlaying: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const opacityRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  const wasPlayingRef = useRef(isPlaying);
  const pausePhaseRef = useRef<PausePhase>("idle");
  const pausePhaseStartedAtRef = useRef(0);
  const settleStartHeightsRef = useRef<Float32Array | null>(null);
  const accentRef = useRef(accent);
  const dataArrayRef = useRef<Float32Array | null>(null);
  const smoothedHeightsRef = useRef<Float32Array | null>(null);
  const smoothedBarCountRef = useRef(0);
  const hiddenRef = useRef(document.hidden);

  useEffect(() => {
    if (isPlaying) {
      pausePhaseRef.current = "idle";
      settleStartHeightsRef.current = null;
    } else if (wasPlayingRef.current) {
      pausePhaseRef.current = "settling";
      pausePhaseStartedAtRef.current = performance.now();
      settleStartHeightsRef.current = null;
    }
    wasPlayingRef.current = isPlaying;
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    accentRef.current = accent;
  }, [accent]);

  useEffect(() => {
    const onVisibility = () => {
      hiddenRef.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const draw = () => {
      if (!running) return;
      frameRef.current = requestAnimationFrame(draw);

      if (hiddenRef.current) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const analyser = (analyserRef.current = getAnalyser());
      if (!analyser) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const bufferLength = analyser.frequencyBinCount;
      const minDb = analyser.minDecibels;
      const maxDb = analyser.maxDecibels;
      let dataArray = dataArrayRef.current;
      if (!dataArray || dataArray.length !== bufferLength) {
        dataArray = new Float32Array(bufferLength);
        dataArrayRef.current = dataArray;
      }
      analyser.getFloatFrequencyData(dataArray as Float32Array<ArrayBuffer>);

      const now = performance.now();
      let globalAlpha = opacityRef.current;

      if (isPlayingRef.current) {
        opacityRef.current = 1;
        globalAlpha = 1;
      } else {
        const phase = pausePhaseRef.current;
        if (phase === "settling") {
          const elapsed = now - pausePhaseStartedAtRef.current;
          globalAlpha = 1;
          opacityRef.current = 1;
          if (elapsed >= PAUSE_SETTLE_MS) {
            pausePhaseRef.current = "fading";
            pausePhaseStartedAtRef.current = now;
          }
        } else if (phase === "fading") {
          const elapsed = now - pausePhaseStartedAtRef.current;
          const t = Math.min(1, elapsed / PAUSE_FADE_MS);
          globalAlpha = 1 - t;
          opacityRef.current = globalAlpha;
          if (t >= 1) {
            pausePhaseRef.current = "idle";
          }
        } else {
          globalAlpha = 0;
          opacityRef.current = 0;
        }
      }

      if (globalAlpha <= 0.005) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.clearRect(0, 0, w, h);

      const barCount = Math.max(32, Math.floor(w / 14));
      const totalBarWidth = w / barCount;
      const gap = 2;
      const settling = !isPlayingRef.current && pausePhaseRef.current === "settling";

      let smoothedHeights = smoothedHeightsRef.current;
      if (!smoothedHeights || smoothedBarCountRef.current !== barCount) {
        smoothedHeights = new Float32Array(barCount);
        smoothedHeightsRef.current = smoothedHeights;
        smoothedBarCountRef.current = barCount;
      }

      if (settling) {
        let snapshot = settleStartHeightsRef.current;
        if (!snapshot || snapshot.length !== barCount) {
          snapshot = new Float32Array(smoothedHeights);
          settleStartHeightsRef.current = snapshot;
        }
        const elapsed = now - pausePhaseStartedAtRef.current;
        const t = Math.min(1, elapsed / PAUSE_SETTLE_MS);
        const eased = 1 - (1 - t) * (1 - t);
        const scale = 1 - eased;
        for (let i = 0; i < barCount; i++) {
          smoothedHeights[i] = (snapshot[i] ?? 0) * scale;
        }
      } else if (isPlayingRef.current) {
        for (let i = 0; i < barCount; i++) {
          smoothedHeights[i] = sampleLogFrequencyAt(dataArray, (i + 0.5) / barCount, minDb, maxDb);
        }
      }

      for (let i = 0; i < barCount; i++) {
        const value = smoothedHeights[i] ?? 0;
        const barHeight = Math.max(2, value * h * 0.7);
        const x = i * totalBarWidth;
        const y = (h - barHeight) / 2;
        const alpha = 0.8 * globalAlpha;
        ctx.fillStyle = rgbToCss(accentRef.current, alpha);
        ctx.beginPath();
        const radius = Math.min(Math.max(0, (totalBarWidth - gap) / 2), 2);
        const bw = Math.max(1, totalBarWidth - gap);
        ctx.roundRect(x + gap / 2, y, bw, barHeight, radius);
        ctx.fill();
      }
    };

    draw();
    return () => {
      running = false;
      cancelAnimationFrame(frameRef.current);
      dataArrayRef.current = null;
      smoothedHeightsRef.current = null;
      smoothedBarCountRef.current = 0;
    };
  }, [getAnalyser]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed left-0 right-0 top-1/2 z-0 block h-[40vh] w-full -translate-y-1/2"
        style={{ imageRendering: "auto" }}
      />
      <div className="pointer-events-none fixed left-0 right-0 top-1/2 z-0 h-[40vh] -translate-y-1/2 bg-black/40" />
    </>
  );
}

export function LyricsPage({
  onNavigate: _onNavigate,
}: {
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();
  const track = player.currentTrack;
  const [lyrics, setLyrics] = useState<SyncedLyrics | null>(() =>
    track?.source === "stream" && track ? hydratePersistedLyricsForTrack(track) : null,
  );
  const [loading, setLoading] = useState(() => {
    if (!track) return false;
    if (track.source === "upload") return Boolean(track.findLyrics);
    return track.source === "stream"
      ? hydratePersistedLyricsForTrack(track) === null
      : false;
  });
  const [timedOut, setTimedOut] = useState(false);
  const accent = useAccent();
  const [displayProgress, setDisplayProgress] = useState(0);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastScrolledIndexRef = useRef(-1);
  const displayProgressRef = useRef(0);
  const playerProgressRef = useRef(0);
  const seekScrubProgressRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const holdTopAfterTrackChangeRef = useRef(false);
  /** Active line index when the new track's lyrics first appear; auto-follow stays at top until this advances. */
  const trackChangeLyricBaselineRef = useRef<number | null>(null);
  const autoScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const activeLyricIndexRef = useRef(-1);
  const hoveredLineIndexRef = useRef(-1);
  const isReducedMotionRef = useRef(false);
  const lyricsDistanceFade = useSetting("lyricsDistanceFade");
  const hideSearchOnLyrics = useSetting("hideSearchOnLyrics");
  const hidePlayerOnLyrics = useSetting("hidePlayerOnLyrics");
  const lyricsViewportParts = ["100dvh"];
  if (!hideSearchOnLyrics) lyricsViewportParts.push("var(--ui-topbar-height)");
  if (!hidePlayerOnLyrics) {
    lyricsViewportParts.push("var(--ui-player-bottom)");
    lyricsViewportParts.push("var(--ui-player-height)");
  }
  const lyricsViewportMinHeight =
    lyricsViewportParts.length === 1
      ? lyricsViewportParts[0]
      : `calc(${lyricsViewportParts[0]} - ${lyricsViewportParts.slice(1).join(" - ")})`;
  const lyricsScrollPaddingTop = hideSearchOnLyrics
    ? "clamp(2rem, 4vw, 3rem)"
    : "var(--ui-topbar-height)";

  const updateLineOpacities = useCallback(() => {
    const container = scrollContainerRef.current;
    const lineEls = lyricLineRefs.current;
    if (isReducedMotionRef.current || !lyricsDistanceFade) {
      lineEls.forEach((el) => { if (el) el.style.opacity = ''; });
      return;
    }
    if (!container || lineEls.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const viewportCenter = containerRect.top + container.clientHeight / 2;
    const maxDistance = container.clientHeight / 2;

    lineEls.forEach((el, index) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const lineCenter = rect.top + rect.height / 2;
      const distance = Math.abs(lineCenter - viewportCenter);
      const t = Math.min(distance / maxDistance, 1);
      const easeOut = t * (2 - t);
      let opacity = 1 - 0.75 * easeOut;
      if (hoveredLineIndexRef.current === index) {
        opacity = Math.min(opacity + 0.12, 0.9);
      }
      el.style.opacity = String(opacity);
    });
  }, [lyricsDistanceFade]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    isReducedMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      isReducedMotionRef.current = e.matches;
      updateLineOpacities();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [updateLineOpacities]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateLineOpacities();
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    updateLineOpacities();
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [updateLineOpacities]);

  const updateLyricsSpacers = useCallback(() => {
    const viewport = scrollContainerRef.current;
    if (!viewport || !lyrics || lyrics.lines.length === 0) return;

    const vh = viewport.clientHeight;
    const scrollStyle = window.getComputedStyle(viewport);
    const scrollPadTop = parseFloat(scrollStyle.paddingTop) || 0;
    const scrollPadBottom = parseFloat(scrollStyle.paddingBottom) || 0;
    const areaEl = document.querySelector(".lyrics-scroll-area");
    const areaStyle = areaEl ? window.getComputedStyle(areaEl) : null;
    const areaPadTop = areaStyle ? parseFloat(areaStyle.paddingTop) || 0 : 0;
    const areaPadBottom = areaStyle ? parseFloat(areaStyle.paddingBottom) || 0 : 0;

    const firstEl = lyricLineRefs.current[0];
    if (firstEl && topSpacerRef.current) {
      const firstHeight = firstEl.offsetHeight;
      const idealTop = Math.max(0, (vh - firstHeight) / 2 - scrollPadTop - areaPadTop);
      topSpacerRef.current.style.height = `${idealTop}px`;
    }

    const lastIndex = lyrics.lines.length - 1;
    const lastEl = lyricLineRefs.current[lastIndex];
    if (lastEl && bottomSpacerRef.current) {
      const lastHeight = lastEl.offsetHeight;
      const idealBottom = Math.max(0, (vh - lastHeight) / 2 - scrollPadBottom - areaPadBottom);
      bottomSpacerRef.current.style.height = `${idealBottom}px`;
    }
  }, [lyrics]);

  const scrollLyricsToTop = useCallback((behavior: ScrollBehavior = "instant") => {
    const container = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (!container) return;
    scrollContainerRef.current = container;
    isProgrammaticScrollRef.current = true;
    container.scrollTo({ top: 0, behavior });
    setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 0);
  }, []);

  const recenterActiveLyric = useCallback((behavior: ScrollBehavior = "instant") => {
    if (holdTopAfterTrackChangeRef.current) return;
    const index = activeLyricIndexRef.current;
    if (index < 0) return;
    const el = lyricLineRefs.current[index];
    if (!el) return;
    isProgrammaticScrollRef.current = true;
    el.scrollIntoView({ block: "center", behavior });
    setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 0);
  }, []);

  const handleLyricsLayoutChange = useCallback(() => {
    updateLyricsSpacers();
    recenterActiveLyric("instant");
    updateLineOpacities();
  }, [updateLyricsSpacers, recenterActiveLyric, updateLineOpacities]);

  useEffect(() => {
    const id = requestAnimationFrame(updateLineOpacities);
    return () => cancelAnimationFrame(id);
  }, [lyrics, updateLineOpacities]);

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

  // Reset scroll position and display progress when the track changes.
  // Jump to the top immediately so we are not still scrolled to the
  // previous song's active line while the new track's lyrics load.
  // Auto-follow resumes once the active line advances (or when playback
  // reaches the first timed line on a fresh start).
  useLayoutEffect(() => {
    lyricLineRefs.current = [];
    lastScrolledIndexRef.current = -1;
    holdTopAfterTrackChangeRef.current = true;
    trackChangeLyricBaselineRef.current = null;
    if (autoScrollTimeoutRef.current) clearTimeout(autoScrollTimeoutRef.current);
    scrollLyricsToTop("instant");

    const initial = playerProgressRef.current;
    displayProgressRef.current = initial;
    setDisplayProgress(initial);
  }, [track?.id, scrollLyricsToTop]);

  // When the underlying audio element fires its `ended` event (track
  // reached its natural end without an immediate next-track handoff),
  // center the first lyric line so the page is ready for a replay or
  // the next track. We listen on `currentAudio.current` directly
  // because that element owns the media event surface; rebinding on
  // every track change ensures stale listeners from a previous track
  // are cleaned up.
  useEffect(() => {
    if (!track) return;
    const audio = currentAudio.current;
    if (!audio) return;
    const onEnded = () => {
      isProgrammaticScrollRef.current = true;
      lyricLineRefs.current[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [track?.id]);

  useEffect(() => {
    if (!track) return;
    const audio = currentAudio.current;
    if (!audio) return;

    let frameId = 0;
    let running = true;

    const syncProgress = () => {
      if (!running) return;

      const scrubbing = seekScrubProgressRef.current !== null;
      if (audio.paused && !scrubbing) return;

      frameId = window.requestAnimationFrame(syncProgress);
      if (scrubbing) return;

      const liveProgress = audio.currentTime;
      const nextProgress = Number.isFinite(liveProgress)
        ? liveProgress
        : playerProgressRef.current;
      if (Math.abs(nextProgress - displayProgressRef.current) >= 0.01) {
        displayProgressRef.current = nextProgress;
        playerProgressRef.current = nextProgress;
        setDisplayProgress(nextProgress);
      }
    };

    const schedule = () => {
      if (!running) return;
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(syncProgress);
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
  }, [track?.id]);

  const seekScrubProgress = usePlayerUiStore((state) => state.seekScrubProgress);
  const progressForLyrics = seekScrubProgress ?? displayProgress;

  const activeLyricIndex = useMemo(() => {
    if (!lyrics || !track) return -1;
    return findActiveLyricIndex(lyrics.lines, progressForLyrics);
  }, [lyrics, track, progressForLyrics]);

  useEffect(() => {
    activeLyricIndexRef.current = activeLyricIndex;
  }, [activeLyricIndex]);

  // Find the scroll container and attach auto-recenter listener
  useLayoutEffect(() => {
    const container = resolveLyricsScrollContainer();
    if (!container) return;
    scrollContainerRef.current = container;

    const onUserScroll = () => {
      if (isProgrammaticScrollRef.current) return;
      if (autoScrollTimeoutRef.current) clearTimeout(autoScrollTimeoutRef.current);
      autoScrollTimeoutRef.current = setTimeout(() => {
        const index = activeLyricIndexRef.current;
        if (index < 0) return;
        const el = lyricLineRefs.current[index];
        if (!el) return;
        isProgrammaticScrollRef.current = true;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
      }, 2000);
    };

    container.addEventListener('scroll', onUserScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onUserScroll);
      if (autoScrollTimeoutRef.current) clearTimeout(autoScrollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!track) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(false);
      return;
    }

    const isStream = track.source === "stream";
    const isUploadWithLyrics = track.source === "upload" && track.findLyrics;
    const effectiveVideoId = isStream ? lyricsCacheVideoId(track) : null;

    if (isStream && !effectiveVideoId) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(true);
      return;
    }
    if (!isStream && !isUploadWithLyrics) {
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

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const MAX_ERROR_RETRIES = 2;
    const ERROR_RETRY_DELAY_MS = 800;

    const cachedStreamLyrics = isStream ? hydratePersistedLyricsForTrack(track) : null;

    setLyrics(cachedStreamLyrics);
    setLoading(!cachedStreamLyrics);
    setTimedOut(false);

    const loadLyrics = () => {
      const request = isStream
        ? fetchSyncedLyrics(track, { persist: true })
        : fetchSyncedLyricsByMeta(track);

      void request
        .then((nextLyrics) => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          if (nextLyrics) {
            setLyrics(nextLyrics);
            setLoading(false);
            setTimedOut(false);
            return;
          }
          // Keep any cached/persisted lyrics on screen when a background
          // refresh misses — wiping here made the page flash "no lyrics"
          // after showing a stale-but-readable snapshot.
          if (!cachedStreamLyrics) {
            setLyrics(null);
            setTimedOut(true);
          }
          setLoading(false);
        })
        .catch(() => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          attempt += 1;
          if (attempt < MAX_ERROR_RETRIES) {
            retryTimer = setTimeout(loadLyrics, ERROR_RETRY_DELAY_MS);
            return;
          }
          if (!cachedStreamLyrics) {
            setLyrics(null);
            setTimedOut(true);
          }
          setLoading(false);
        });
    };

    // Always refresh in the background so the active track picks up the
    // full `get_synced_lyrics` resolution (incl. YouTube Music native
    // timed lyrics). Cached/persisted lyrics above are only for instant
    // first paint — skipping the fetch left stale prefetch snapshots
    // (metadata-only providers + wrong offsets) on screen indefinitely.
    loadLyrics();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    // Derive a stable primitive key from the exact fields that should
    // force a lyrics refetch. Tracking every individual field would
    // re-fire the request on any unrelated metadata tweak (e.g. a
    // upload track's `durationSeconds` hydrating in after the page
    // mounted). Stream tracks are uniquely identified by the effective
    // lyrics video id (`resolvedVideoId ?? videoId`); upload tracks are
    // identified by (id, findLyrics, title, artist, album, durationSeconds)
    // so a re-import that corrected the title (or async duration hydration)
    // still picks up the new lyrics.
    track?.source === "stream"
      ? `stream-${lyricsCacheVideoId(track) ?? ""}`
      : `upload-${track?.id ?? ""}-${track?.findLyrics ? 1 : 0}-${track?.title ?? ""}-${track?.artist ?? ""}-${track?.album ?? ""}-${track?.durationSeconds ?? ""}`,
  ]);

  useEffect(() => {
    if (activeLyricIndex < 0 || activeLyricIndex === lastScrolledIndexRef.current) return;
    if (holdTopAfterTrackChangeRef.current) {
      // Baseline is captured when the new track's lyrics mount — until then,
      // ignore active-line updates that may still reflect the previous song.
      if (trackChangeLyricBaselineRef.current === null) return;
      if (activeLyricIndex === trackChangeLyricBaselineRef.current) return;
      holdTopAfterTrackChangeRef.current = false;
      trackChangeLyricBaselineRef.current = null;
    }
    lastScrolledIndexRef.current = activeLyricIndex;
    isProgrammaticScrollRef.current = true;
    lyricLineRefs.current[activeLyricIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
  }, [activeLyricIndex]);

  const prevLyricsRef = useRef<SyncedLyrics | null>(null);
  // When lyrics load or change for a new track, size spacers and keep the
  // viewport at the top until playback advances the active line.
  // Top and bottom spacers are sized dynamically so the first and last
  // lines can scroll to the viewport center without overscroll past the
  // ends. Both are recalculated on layout changes (see below).
  useEffect(() => {
    const previousLyrics = prevLyricsRef.current;
    prevLyricsRef.current = lyrics;
    if (!lyrics || lyrics.lines.length === 0 || lyrics === previousLyrics) return;
    updateLyricsSpacers();
    const index = findActiveLyricIndex(lyrics.lines, displayProgressRef.current);
    if (holdTopAfterTrackChangeRef.current) {
      trackChangeLyricBaselineRef.current = index;
      lastScrolledIndexRef.current = index;
      scrollLyricsToTop("instant");
      return;
    }
    lastScrolledIndexRef.current = index;
    if (index < 0) return;
    isProgrammaticScrollRef.current = true;
    lyricLineRefs.current[index]?.scrollIntoView({ block: "center", behavior: "instant" });
    setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
  }, [lyrics, updateLyricsSpacers, scrollLyricsToTop]);

  // Keep the active lyric centered when the scrollport changes size (window
  // resize, monitor move, DPI change, or --app-height refresh). A fixed
  // scrollTop drifts off-center once viewport height or spacer sizes change.
  useEffect(() => {
    if (!lyrics || lyrics.lines.length === 0) return;
    const viewport = scrollContainerRef.current;
    if (!viewport) return;

    let rafId = 0;
    const onLayoutChange = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        handleLyricsLayoutChange();
      });
    };

    const resizeObserver = new ResizeObserver(onLayoutChange);
    resizeObserver.observe(viewport);
    window.addEventListener("resize", onLayoutChange);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", onLayoutChange);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [lyrics, handleLyricsLayoutChange]);

  const handleSeek = useCallback((seconds: number) => {
    player.seek(seconds);
  }, [player]);

  if (!track) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <LoaderCircle size={40} className="animate-spin text-neutral-300" aria-label="Loading lyrics" />
      </div>
    );
  }

  return (
    <div
      className="lyrics-page relative bg-transparent"
      style={{ minHeight: lyricsViewportMinHeight }}
    >
      <WaveformVisualizer
        getAnalyser={player.getAnalyser}
        accent={accent}
        isPlaying={player.isPlaying}
      />

      <div
        className="lyrics-scroll-area nice-scroll relative z-10 mx-auto max-w-3xl px-4 pb-[clamp(2rem,4vw,3rem)] sm:px-6"
        style={{ paddingTop: lyricsScrollPaddingTop }}
      >
        <div className="relative mx-auto max-w-2xl">
          <div
            className="relative flex flex-col gap-3"
          >
          {loading && !timedOut && (
            <div
              className="-mt-12 flex min-h-0 flex-col items-center justify-center gap-4"
              style={{ minHeight: lyricsViewportMinHeight }}
            >
              <LoaderCircle size={48} className="animate-spin text-neutral-300" />
              <span className="text-base text-neutral-300">Loading lyrics...</span>
            </div>
          )}
          {timedOut && !loading && (
            <div
              className="animate-no-lyrics-fadeout -mt-12 flex min-h-0 flex-col items-center justify-center gap-4"
              style={{ minHeight: lyricsViewportMinHeight }}
            >
              <X size={48} className="text-neutral-300" />
              <span className="text-base text-neutral-300">No synced lyrics available</span>
            </div>
          )}
          {lyrics && (
            <>
              {/* Spacer to allow first lyric to scroll to center of viewport */}
              <div aria-hidden="true" ref={topSpacerRef} className="pointer-events-none" />
              {lyrics.lines.map((line, index) => {
                const active = index === activeLyricIndex;
                return (
                  <button
                    key={`${line.id}-${index}`}
                    type="button"
                    ref={(node) => {
                      lyricLineRefs.current[index] = node;
                    }}
                    onMouseDown={(event) => {
                      // Keep focus on the scroll container so the browser
                      // doesn't scroll the clicked line into view on its
                      // own — that fights the active-line centering logic
                      // and reads as a jittery double-scroll after seek.
                      event.preventDefault();
                    }}
                    onClick={() => handleSeek(line.startTimeMs / 1000)}
                    onMouseEnter={() => {
                      hoveredLineIndexRef.current = index;
                      updateLineOpacities();
                    }}
                    onMouseLeave={() => {
                      if (hoveredLineIndexRef.current === index) {
                        hoveredLineIndexRef.current = -1;
                        updateLineOpacities();
                      }
                    }}
                    /*
                     * Loose lyrics, NO decoration: bare centered text on a
                     * transparent button. NO rounded-2xl, NO bg-black/*, NO
                     * surrounding element of any kind. The glyph color lives
                     * on the button itself (and inherits into the inner text
                     * container via standard cascade), so the hover brighten
                     * below (`hover:text-white`) naturally cascades onto the
                     * text — no outline, no font-weight change, no shadow
                     * halo are needed. Active vs inactive is differentiated
                     * purely by glyph color plus hover-cue on the inactive
                     * side.
                     *
                     * `transition-colors` (NOT `transition-all`) scopes the
                     * color transition to `color`/`background-color` so a
                     * color change does not momentarily promote this button
                     * onto a fresh compositor layer, which previously
                     * produced visible antialiasing seams on the text.
                     */
                    className={`lyrics-line relative px-5 py-3 text-center transition-colors duration-300 sm:px-6 sm:py-4 ${
                      active
                        ? "text-white"
                        : "text-neutral-300 hover:text-white"
                    }`}
                  >
                    <div className="whitespace-normal text-[clamp(1.35rem,3.1vw,1.85rem)] font-semibold leading-[1.35]">
                      {line.text.replace(/\s+/g, ' ').trim()}
                    </div>
                  </button>
                );
              })}
              {/* Spacer to allow last lyric to scroll to center of viewport */}
              <div aria-hidden="true" ref={bottomSpacerRef} className="pointer-events-none" />
            </>
          )}
          </div>
        </div>
      </div>


    </div>
  );
}
