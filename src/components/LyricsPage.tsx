import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import {
  hydratePersistedLyricsForTrack,
  isLyricsExhaustedForTrack,
  isUnsyncedLyricsSource,
  isCleanLyricsSource,
  lyricsCacheVideoId,
  subscribeLyricsUpdates,
} from "../api";
import { streamIdentityVideoIds } from "../utils/media";
import {
  fetchSyncedLyrics,
  fetchSyncedLyricsByMeta,
  findActiveLyricIndex,
  hasValidLyricSync,
  probeLyrics,
  shouldReplaceLyricsWith,
  type SyncedLyrics,
} from "../lyrics";
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

// Per-bar exponential smoothing (one-pole low-pass) applied to the raw
// frequency samples each frame. Drawn raw, the data jumps enough between
// frames that the bars read as spasming; this takes the jitter off while
// staying subtle. Attack (bar rising) is faster than decay (bar falling)
// — the classic equalizer feel — so beats still hit responsively and only
// the nervous frame-to-frame flicker is damped.
const BAR_ATTACK = 0.5;
const BAR_DECAY = 0.18;

// How long after the user's last manual scroll the lyrics consider them
// "actively scrolling". Within this window auto-follow stays suspended so
// the view isn't yanked mid-read; once it elapses, the next active-line
// advance brings the view back to the current lyric.
const ACTIVE_SCROLL_WINDOW_MS = 2000;

function currentLyricsProgress(): number {
  const state = usePlayerUiStore.getState();
  return state.seekScrubProgress ?? state.progress;
}

function acceptSyncedLyrics(candidate: SyncedLyrics | null): SyncedLyrics | null {
  if (!candidate || !hasValidLyricSync(candidate.lines)) return null;
  if (isUnsyncedLyricsSource(candidate.source)) return null;
  if (!isCleanLyricsSource(candidate.source)) return null;
  return candidate;
}

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
  centerY,
}: {
  getAnalyser: () => AnalyserNode | null;
  accent: RgbColor;
  isPlaying: boolean;
  /** Vertical center (viewport px) the 40vh band is positioned around. */
  centerY: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const opacityRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  const wasPlayingRef = useRef(isPlaying);
  const isPlayingFirstRunRef = useRef(true);
  const pausePhaseRef = useRef<PausePhase>("idle");
  // True once the loop has painted at least one playing frame in this
  // component's lifetime. The first-ever frame seeds the bar heights
  // directly (there's no prior state to ease from — ramping from zero is
  // the first-boot stutter); every later restart (pause→play, visibility
  // change) eases back up from flat instead.
  const hasSeededRef = useRef(false);
  const pausePhaseStartedAtRef = useRef(0);
  const settleStartHeightsRef = useRef<Float32Array | null>(null);
  const accentRef = useRef(accent);
  const dataArrayRef = useRef<Float32Array | null>(null);
  const smoothedHeightsRef = useRef<Float32Array | null>(null);
  const smoothedBarCountRef = useRef(0);
  const hiddenRef = useRef(document.hidden);
  // Bumped to restart the draw loop after it self-stops on idle/hidden.
  const [wakeSignal, setWakeSignal] = useState(0);

  useEffect(() => {
    if (isPlayingFirstRunRef.current) {
      // Initial mount: the draw loop effect below starts itself, so skip the
      // wake bump. Bumping here would tear the freshly-started loop down one
      // frame later and reset the bar state — the momentary first-boot
      // stutter when the page mounts mid-playback. Nothing to settle either:
      // bars start flat in both states.
      isPlayingFirstRunRef.current = false;
      wasPlayingRef.current = isPlaying;
      isPlayingRef.current = isPlaying;
      return;
    }
    if (isPlaying) {
      pausePhaseRef.current = "idle";
      settleStartHeightsRef.current = null;
      setWakeSignal((signal) => signal + 1);
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
      const hidden = document.hidden;
      hiddenRef.current = hidden;
      // Restart the loop when the page becomes visible again. While hidden we
      // stop scheduling entirely (rAF for a covered-but-visible window is not
      // throttled by WebView2, so an idle loop would burn a core in the
      // background).
      if (!hidden) setWakeSignal((signal) => signal + 1);
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

      // Cap the effective backing-store scale. The visualizer is a decorative
      // bar graph behind text; rendering it at full devicePixelRatio on 2x/3x
      // displays just multiplies the canvas backing store (and per-frame fill
      // cost) with zero visible benefit on the bars.
      //
      // `canvas.width`/`canvas.height` are integers, so comparing them
      // against the raw `w * dpr` product reallocates the backing store on
      // every single frame whenever that product is fractional (dpr 1.25 /
      // 1.5 — common on Windows scaling — at most window widths): the canvas
      // is cleared and a multi-MB buffer is re-zeroed 60×/s. Round to exact
      // integers first so the store is left untouched until the CSS size
      // actually changes.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      const backingW = Math.round(w * dpr);
      const backingH = Math.round(h * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.clearRect(0, 0, w, h);

      const barCount = Math.max(32, Math.floor(w / 14));
      const totalBarWidth = w / barCount;
      const gap = 2;
      const settling = !isPlayingRef.current && pausePhaseRef.current === "settling";

      let smoothedHeights = smoothedHeightsRef.current;
      if (smoothedHeights && smoothedBarCountRef.current !== barCount) {
        // The region width (and thus barCount) animates continuously while
        // the sidebar slides, so a count mismatch occurs nearly every frame
        // during the 220ms transition. Resetting the array to zeros here
        // collapsed every bar to flat and ramped it back up each step — the
        // bars never rose, which is the violent jitter on sidebar open/
        // collapse. Instead resample the previous heights onto the new
        // count, left-anchored, so the waveform keeps its shape and just
        // condenses/spreads as the region narrows or widens — like text
        // reflowing around the sidebar.
        const oldCount = smoothedBarCountRef.current;
        const resampled = new Float32Array(barCount);
        for (let i = 0; i < barCount; i++) {
          const oldIndex = Math.min(
            oldCount - 1,
            Math.round((i * oldCount) / barCount),
          );
          resampled[i] = smoothedHeights[oldIndex] ?? 0;
        }
        smoothedHeights = resampled;
        smoothedHeightsRef.current = resampled;
        smoothedBarCountRef.current = barCount;
      } else if (!smoothedHeights) {
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
        // Seed the very first playing frame so the visualizer appears at the
        // correct level instead of easing up from a blank canvas (which reads
        // as a stutter on first boot). Every subsequent frame — including
        // after a pause, where bars legitimately settled to flat — eases
        // toward the new sample instead of snapping to it.
        const seed = !hasSeededRef.current;
        for (let i = 0; i < barCount; i++) {
          const target = sampleLogFrequencyAt(dataArray, (i + 0.5) / barCount, minDb, maxDb);
          if (seed) {
            smoothedHeights[i] = target;
          } else {
            const previous = smoothedHeights[i] ?? 0;
            const factor = target > previous ? BAR_ATTACK : BAR_DECAY;
            smoothedHeights[i] = previous + (target - previous) * factor;
          }
        }
        hasSeededRef.current = true;
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

      // Continue the loop only when there is active work to draw. Reaching
      // this point means we actually painted bars; idle/hidden/no-analyser
      // paths above already returned without rescheduling, and a play or
      // visibility event bumps `wakeSignal` to restart the effect.
      frameRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      running = false;
      cancelAnimationFrame(frameRef.current);
      dataArrayRef.current = null;
      smoothedHeightsRef.current = null;
      smoothedBarCountRef.current = 0;
    };
  }, [getAnalyser, wakeSignal]);

  return (
    <>
      {/* Both the canvas and its backdrop band span from the sidebar's
          current edge to the right window edge (instead of the full
          width), so when the sidebar is revealed/expanded on the lyrics
          page the visualizer shifts right and stays centered over the
          lyrics text — which uses the same `--ui-sidebar-current` offset.
          `--ui-sidebar-current` is 0 while the sidebar is hidden, so this
          is a no-op for the default lyrics view and only ever moves on
          the X axis (the player bar never shifts it).

          The canvas MUST carry an explicit width: it is a replaced
          element, so with `width: auto` + `height: 40vh` the browser
          derives the width from the intrinsic 300×150 aspect ratio
          (~80vh) instead of honoring `left`/`right` — leaving the bars
          crammed into a chunk on the left. `calc(100% - var(--ui-
          sidebar-current))` keeps it pinned to [sidebar edge, right
          edge]. The backdrop div is a plain block, so its `left`/`right`
          suffice. */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed left-[var(--ui-sidebar-current)] right-[var(--ui-nowplaying-current)] z-0 block h-[40vh] -translate-y-1/2"
        style={{
          top: `${centerY}px`,
          width: "calc(100% - var(--ui-sidebar-current) - var(--ui-nowplaying-current))",
          imageRendering: "auto",
        }}
      />
      <div
        className="pointer-events-none fixed left-[var(--ui-sidebar-current)] right-[var(--ui-nowplaying-current)] z-0 h-[40vh] -translate-y-1/2 bg-black/40"
        style={{ top: `${centerY}px` }}
      />
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
    track?.source === "stream" && track
      ? acceptSyncedLyrics(hydratePersistedLyricsForTrack(track))
      : null,
  );
  const [loading, setLoading] = useState(() => {
    if (!track) return false;
    if (track.source === "upload") return Boolean(track.findLyrics);
    if (track.source === "stream") {
      const cached = hydratePersistedLyricsForTrack(track);
      return acceptSyncedLyrics(cached) === null;
    }
    return false;
  });
  const [timedOut, setTimedOut] = useState(false);
  const [probeState, setProbeState] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const accent = useAccent();
  const storedProgress = usePlayerUiStore((state) => state.progress);
  const seekScrubProgress = usePlayerUiStore((state) => state.seekScrubProgress);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastScrolledIndexRef = useRef(-1);
  const prevTrackIdRef = useRef<string | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const holdTopAfterTrackChangeRef = useRef(false);
  /** Active line index when the new track's lyrics first appear; auto-follow stays at top until this advances. */
  const trackChangeLyricBaselineRef = useRef<number | null>(null);
  // Auto-follow control. The lyrics stay centered on the active line by
  // default; a manual scroll only suspends that while the user is actively
  // scrolling (timestamps in lastManualScrollAtRef). Recentering re-engages
  // on the next active-line advance once the user has stopped scrolling.
  const lastManualScrollAtRef = useRef(-Infinity);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const lyricsStackRef = useRef<HTMLDivElement>(null);
  const activeLyricIndexRef = useRef(-1);
  const hoveredLineIndexRef = useRef(-1);
  const isReducedMotionRef = useRef(false);
  const lyricsDistanceFade = useSetting("lyricsDistanceFade");
  const lyricsViewportParts = ["100dvh"];
  lyricsViewportParts.push("var(--ui-topbar-height)");
  // The player dock is always visible, so reserve its space.
  lyricsViewportParts.push("var(--ui-player-bottom)");
  lyricsViewportParts.push("var(--ui-player-height)");
  const lyricsViewportMinHeight =
    lyricsViewportParts.length === 1
      ? lyricsViewportParts[0]
      : `calc(${lyricsViewportParts[0]} - ${lyricsViewportParts.slice(1).join(" - ")})`;
  const lyricsScrollPaddingTop = "var(--ui-topbar-height)";

  const lastOpacityUpdateRef = useRef(0);
  const updateLineOpacities = useCallback(() => {
    const now = performance.now();
    // Throttled to ~16 fps (60 ms). Each pass is cheap — all rect reads
    // are batched ahead of any writes (~2 layout passes regardless of
    // line count) — so the throttle only caps how often we re-measure
    // while scrolling. 60 ms keeps the fade tracking the viewport
    // tightly enough that it never visibly lags a smooth auto-scroll.
    if (now - lastOpacityUpdateRef.current < 60) return;
    lastOpacityUpdateRef.current = now;
    const container = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (container) scrollContainerRef.current = container;
    const lineEls = lyricLineRefs.current;
    if (isReducedMotionRef.current || !lyricsDistanceFade) {
      lineEls.forEach((el) => { if (el) el.style.opacity = ''; });
      return;
    }
    if (!container || lineEls.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const viewportCenter = containerRect.top + container.clientHeight / 2;
    const maxDistance = container.clientHeight / 2;

    // The fade is anchored to the VIEWPORT, not to the active lyric:
    // each line's on-screen position relative to the viewport centre
    // decides its opacity, so scrolling moves the bright band with the
    // user. (An earlier >80-line fast path keyed off the active line's
    // INDEX instead, which froze the fade relative to the view on long
    // songs — every line sat at 0.55 while the 13 around the active
    // lyric stayed bright no matter where the user scrolled.)
    //
    // Reads are batched ahead of writes: interleaving a
    // getBoundingClientRect read with each `el.style.opacity` write
    // would force a synchronous layout pass per line (each write
    // invalidates the layout the next read must recompute) — a
    // 200-line song would thrash layout 200 times per tick. Two
    // batched passes (read all, write all) collapse that to ~2 layout
    // passes with an identical result at any line count.
    const lineCenters = new Array<number>(lineEls.length);
    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      lineCenters[i] = rect.top + rect.height / 2;
    }
    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i];
      if (!el) continue;
      const distance = Math.abs(lineCenters[i] - viewportCenter);
      const t = Math.min(distance / maxDistance, 1);
      const easeOut = t * (2 - t);
      let opacity = 1 - 0.75 * easeOut;
      if (hoveredLineIndexRef.current === i) {
        opacity = Math.min(opacity + 0.12, 0.9);
      }
      el.style.opacity = String(opacity);
    }
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
    const viewport = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (viewport) scrollContainerRef.current = viewport;
    if (!viewport || !lyrics || lyrics.lines.length === 0) return;

    const vh = viewport.clientHeight;
    const scrollStyle = window.getComputedStyle(viewport);
    const scrollPadTop = parseFloat(scrollStyle.paddingTop) || 0;
    const scrollPadBottom = parseFloat(scrollStyle.paddingBottom) || 0;
    const areaEl = document.querySelector(".lyrics-scroll-area");
    const areaStyle = areaEl ? window.getComputedStyle(areaEl) : null;
    const areaPadTop = areaStyle ? parseFloat(areaStyle.paddingTop) || 0 : 0;
    const areaPadBottom = areaStyle ? parseFloat(areaStyle.paddingBottom) || 0 : 0;

    // The spacers are children of the `gap-3` lyrics stack, so the flex gap
    // applies between each spacer and its adjacent line too. Without
    // accounting for it the first line rests a gap below the true center at
    // scrollTop 0 — then the first active-line scrollIntoView snaps it up
    // that same gap, the unwanted shift. The last line gets the mirror
    // treatment at max scroll. The gap is measured (not assumed) so it stays
    // correct if the stack's gap class ever changes.
    const gap = lyricsStackRef.current
      ? parseFloat(window.getComputedStyle(lyricsStackRef.current).rowGap) || 0
      : 0;

    const firstEl = lyricLineRefs.current[0];
    if (firstEl && topSpacerRef.current) {
      const firstHeight = firstEl.offsetHeight;
      const idealTop = Math.max(0, (vh - firstHeight) / 2 - scrollPadTop - areaPadTop - gap);
      topSpacerRef.current.style.height = `${idealTop}px`;
    }

    const lastIndex = lyrics.lines.length - 1;
    const lastEl = lyricLineRefs.current[lastIndex];
    if (lastEl && bottomSpacerRef.current) {
      const lastHeight = lastEl.offsetHeight;
      const idealBottom = Math.max(0, (vh - lastHeight) / 2 - scrollPadBottom - areaPadBottom - gap);
      bottomSpacerRef.current.style.height = `${idealBottom}px`;
    }
  }, [lyrics]);

  // Upper bound for any smooth-scroll animation we might trigger. Used as
  // a safety fallback for `scrollend` so the programmatic flag can never
  // strand itself in the "programmatic" state when the browser doesn't
  // dispatch `scrollend` (e.g. instant scrolls or no-op scrollIntoView
  // calls on already-centered elements). Generous enough to cover slow
  // smooth scrolls but short enough that genuine user input isn't
  // mistakenly treated as programmatic if scrollend misfires.
  const PROGRAMMATIC_SCROLL_SAFETY_TIMEOUT_MS = 1500;

  // Wrap a programmatic scroll (scrollTo / scrollIntoView) so the user-vs-
  // programmatic discrimination in `onUserScroll` correctly excludes every
  // scroll event fired WHILE the smooth animation runs — not just the
  // ones fired before the animation starts.
  //
  // The previous pattern used `setTimeout(() => { isProgrammaticScrollRef
  // .current = false; }, 0)`, which runs synchronously after the scroll
  // call but well before the smooth-scroll animation's own `scroll`
  // events are dispatched. Those in-flight scroll events were misread by
  // `onUserScroll` as user input, scheduling a 2-second recenter timer
  // on every event. Once the animation finished, the last timer
  // eventually fired, kicked off a fresh smooth-scroll animation, and
  // the cycle repeated roughly every ~2.5s — the periodic "jump/stutter"
  // while listening.
  //
  // The fix is to flip the flag to true and keep it true until either
  // `scrollend` fires (the well-defined end of a smooth-scroll
  // animation, shipped in WebKit 17 and Chromium 114) or a generous
  // timeout elapses as a fallback. `scrollend` is registered with
  // `{ once: true }` so even a single late-firing event tears the
  // listener down.
  const runProgrammaticScroll = useCallback((action: () => void) => {
    const container = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (!container) {
      isProgrammaticScrollRef.current = false;
      action();
      return;
    }
    scrollContainerRef.current = container;
    isProgrammaticScrollRef.current = true;

    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      isProgrammaticScrollRef.current = false;
      container.removeEventListener("scrollend", clear);
      window.clearTimeout(safetyTimer);
    };
    container.addEventListener("scrollend", clear, { once: true, passive: true });
    const safetyTimer = window.setTimeout(clear, PROGRAMMATIC_SCROLL_SAFETY_TIMEOUT_MS);

    action();
  }, []);

  const scrollLyricsToTop = useCallback((behavior: ScrollBehavior = "instant") => {
    const container = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (!container) return;
    scrollContainerRef.current = container;
    runProgrammaticScroll(() => {
      container.scrollTo({ top: 0, behavior });
    });
  }, [runProgrammaticScroll]);

  const recenterActiveLyric = useCallback((behavior: ScrollBehavior = "instant") => {
    if (holdTopAfterTrackChangeRef.current) return;
    // Skip while the user is actively scrolling so a layout change (e.g. a
    // window resize) never yanks the view out from under them.
    if (performance.now() - lastManualScrollAtRef.current < ACTIVE_SCROLL_WINDOW_MS) return;
    const index = activeLyricIndexRef.current;
    if (index < 0) return;
    const el = lyricLineRefs.current[index];
    if (!el) return;
    runProgrammaticScroll(() => {
      el.scrollIntoView({ block: "center", behavior });
    });
  }, [runProgrammaticScroll]);

  const handleLyricsLayoutChange = useCallback(() => {
    updateLyricsSpacers();
    recenterActiveLyric("instant");
    updateLineOpacities();
  }, [updateLyricsSpacers, recenterActiveLyric, updateLineOpacities]);

  // Apply the distance fade synchronously in a layout effect so the
  // first painted frame of any lyrics set already carries the correct
  // opacities. The previous rAF version ran after first paint — on page
  // entry, song switch, or re-entry the lyrics flashed fully bright and
  // then the fade visibly "loaded" in front of the user. The throttle is
  // reset first so a lyrics change landing within 60ms of the last
  // scroll update still gets its fade applied immediately.
  //
  // The centering spacers must be sized in the SAME layout pass, before
  // the fade: the fade's distance math depends on them (they push the
  // first/last lines toward the viewport center). Applying the fade
  // against 0-height spacers reads every line as "far from center" and
  // flashes the whole set transparent before the post-paint spacer pass
  // corrects it.
  //
  // This effect also places the viewport on its first frame for a given
  // lyrics set: when auto-follow is engaged (and the view isn't being held
  // at the top for a new track, and the user isn't actively scrolling), it
  // scrolls the active lyric to the viewport center BEFORE paint. That way
  // the page opens already showing the current line centered, white, and at
  // the fade's focus — rather than a top-of-list snapshot that visibly
  // animates into place afterwards (or stays at the top until the next line
  // advances, leaving every visible line faded and uncolored). Active-line
  // ADVANCES during playback are handled by the auto-follow effect (smooth);
  // this runs only when the lyrics set itself changes.
  useLayoutEffect(() => {
    lastOpacityUpdateRef.current = 0;
    updateLyricsSpacers();

    const container = scrollContainerRef.current ?? resolveLyricsScrollContainer();
    if (container) scrollContainerRef.current = container;
    const index =
      lyrics && track ? findActiveLyricIndex(lyrics.lines, currentLyricsProgress()) : -1;
    if (
      container &&
      index >= 0 &&
      !holdTopAfterTrackChangeRef.current &&
      performance.now() - lastManualScrollAtRef.current >= ACTIVE_SCROLL_WINDOW_MS
    ) {
      const el = lyricLineRefs.current[index];
      if (el) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const delta =
          elRect.top + elRect.height / 2 - (containerRect.top + container.clientHeight / 2);
        runProgrammaticScroll(() => {
          const maxScroll = container.scrollHeight - container.clientHeight;
          container.scrollTop = Math.max(0, Math.min(container.scrollTop + delta, maxScroll));
        });
        lastScrolledIndexRef.current = index;
      }
    }

    updateLineOpacities();
  }, [lyrics, updateLineOpacities, updateLyricsSpacers, runProgrammaticScroll]);

  // Reset scroll position when the track actually changes (not on mount).
  // Jump to the top immediately so we are not still scrolled to the
  // previous song's active line while the new track's lyrics load.
  // Auto-follow resumes once the active line advances (or when playback
  // reaches the first timed line on a fresh start).
  useLayoutEffect(() => {
    const trackId = track?.id ?? null;
    const isActualTrackChange =
      prevTrackIdRef.current !== null && prevTrackIdRef.current !== trackId;
    prevTrackIdRef.current = trackId;

    if (!isActualTrackChange) return;

    // Actual track change: clear the previous song's lyric refs and scroll
    // state synchronously before paint. (On mount there is no previous song,
    // so the refs this render just populated are left intact — the entry
    // centering in the fade layout effect needs them to focus the active
    // lyric on the first painted frame.)
    lyricLineRefs.current = [];
    lastManualScrollAtRef.current = -Infinity;
    lastScrolledIndexRef.current = -1;
    trackChangeLyricBaselineRef.current = null;

    // Reset lyrics state synchronously before paint to prevent flashing
    // the previous song's lyrics while the new track's lyrics load.
    if (track?.source === "stream") {
      const cached = acceptSyncedLyrics(hydratePersistedLyricsForTrack(track));
      setLyrics(cached);
      setLoading(!cached);
    } else if (track?.source === "upload") {
      setLyrics(null);
      setLoading(Boolean(track.findLyrics));
    } else {
      setLyrics(null);
      setLoading(false);
    }
    setTimedOut(false);

    holdTopAfterTrackChangeRef.current = true;
    scrollLyricsToTop("instant");
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
      runProgrammaticScroll(() => {
        lyricLineRefs.current[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [track?.id, runProgrammaticScroll]);

  const progressForLyrics = seekScrubProgress ?? storedProgress;

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
      // The user is actively scrolling — suspend auto-follow so the view
      // (and the distance fade, which is anchored to the viewport) stays
      // where they put it while they read. Once they stop scrolling for a
      // beat, the next active-line advance brings them back.
      lastManualScrollAtRef.current = performance.now();
    };

    container.addEventListener('scroll', onUserScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onUserScroll);
    };
  }, [runProgrammaticScroll]);

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

    const cachedStreamLyrics = isStream
      ? acceptSyncedLyrics(hydratePersistedLyricsForTrack(track))
      : null;

    setLyrics(cachedStreamLyrics);
    setLoading(!cachedStreamLyrics);
    setTimedOut(false);
    setProbeState(cachedStreamLyrics ? "available" : "checking");

    // A) Fast Tier-0 probe — <900ms, tells UI whether to keep searching.
    // If the probe reports unavailable with high confidence and we have no
    // cached lyrics, we can show "no lyrics" within 1s instead of waiting
    // 6-10s for the full fan-out to time out. Low-confidence "unavailable"
    // is treated as "unknown" — the full search continues in background.
    if (!cachedStreamLyrics && track) {
      void probeLyrics(track)
        .then((avail) => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          if (avail.available) {
            setProbeState("available");
          } else if (avail.confidence >= 0.6) {
            setProbeState("unavailable");
          } else {
            setProbeState("idle");
          }
        })
        .catch(() => {
          if (!cancelled) setProbeState("idle");
        });
    } else if (cachedStreamLyrics) {
      setProbeState("available");
    }

    const loadLyrics = () => {
      const request = isStream
        ? fetchSyncedLyrics(track, { persist: true })
        : fetchSyncedLyricsByMeta(track);

      void request
        .then((nextLyrics) => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          const accepted = acceptSyncedLyrics(nextLyrics);
          if (accepted) {
            // When cached lyrics are already on screen, only replace them
            // if the fresh result is a meaningful upgrade (per-word sync).
            // Otherwise provider churn between LRCLIB/Kugou/NetEase would
            // flicker the viewport with rephrased-but-equivalent text.
            if (cachedStreamLyrics) {
              if (shouldReplaceLyricsWith(cachedStreamLyrics, accepted)) {
                setLyrics(accepted);
              }
            } else {
              setLyrics(accepted);
            }
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
    // authoritative full `get_synced_lyrics` resolution (offset-corrected
    // providers). Cached/persisted lyrics above are only for instant
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

  // Cross-component sync: if the Now Playing preview (or any other caller)
  // re-fetches authoritative lyrics after the vocal-offset DSP finishes,
  // this page picks up the offset-corrected result without waiting for its
  // own next track change. Keeps the two views lockstepped.
  useEffect(() => {
    if (!track || track.source !== "stream") return;
    const ids = new Set(
      streamIdentityVideoIds(track as unknown as Parameters<typeof streamIdentityVideoIds>[0]),
    );
    const unsub = subscribeLyricsUpdates((videoId, updated) => {
      if (!ids.has(videoId)) return;
      const accepted = acceptSyncedLyrics(updated);
      if (!accepted) return;
      // Use functional update so we compare against the latest visible set
      setLyrics((prev) => {
        if (!prev) return accepted;
        if (shouldReplaceLyricsWith(prev, accepted)) return accepted;
        return prev;
      });
    });
    return unsub;
  }, [track?.id, (track as unknown as { videoId?: string })?.videoId, (track as unknown as { resolvedVideoId?: string })?.resolvedVideoId]);

  useEffect(() => {
    if (activeLyricIndex < 0 || activeLyricIndex === lastScrolledIndexRef.current) return;
    // While the user is actively scrolling, never yank the view out from
    // under them — the highlight still updates, but the scroll position
    // stays theirs. Once they stop scrolling for a beat, the next active-
    // line advance brings them back.
    if (performance.now() - lastManualScrollAtRef.current < ACTIVE_SCROLL_WINDOW_MS) return;
    if (holdTopAfterTrackChangeRef.current) {
      // Baseline is captured when the new track's lyrics mount — until then,
      // ignore active-line updates that may still reflect the previous song.
      if (trackChangeLyricBaselineRef.current === null) return;
      if (activeLyricIndex === trackChangeLyricBaselineRef.current) return;
      holdTopAfterTrackChangeRef.current = false;
      trackChangeLyricBaselineRef.current = null;
    }
    lastScrolledIndexRef.current = activeLyricIndex;
    runProgrammaticScroll(() => {
      lyricLineRefs.current[activeLyricIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [activeLyricIndex, runProgrammaticScroll]);

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
    const index = findActiveLyricIndex(lyrics.lines, currentLyricsProgress());
    if (holdTopAfterTrackChangeRef.current) {
      trackChangeLyricBaselineRef.current = index;
      lastScrolledIndexRef.current = index;
      scrollLyricsToTop("instant");
      return;
    }
    lastScrolledIndexRef.current = index;
    if (index < 0) return;
    runProgrammaticScroll(() => {
      lyricLineRefs.current[index]?.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }, [lyrics, updateLyricsSpacers, scrollLyricsToTop, runProgrammaticScroll]);

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

  // When the sidebar is revealed / expanded / collapsed on the lyrics page,
  // the lyrics column and visualizer shift horizontally with it (via
  // `--ui-sidebar-current` — pure CSS, nothing to do per-frame). Once the
  // 220ms transition settles, re-run the spacer/fade/recenter pass: on
  // narrow windows a wider sidebar can reflow long lyric lines onto extra
  // lines, which would otherwise leave the active line slightly off-center
  // and the end spacers stale. Same hook the ArtistPage uses to re-layout
  // its hero on the same transition.
  useEffect(() => {
    const layoutHost = document.querySelector(".sidebar-layout-transition");
    if (!layoutHost) return;
    const onTransitionEnd = (event: Event) => {
      if ((event as TransitionEvent).propertyName !== "--ui-sidebar-current") return;
      handleLyricsLayoutChange();
    };
    layoutHost.addEventListener("transitionend", onTransitionEnd);
    layoutHost.addEventListener("transitioncancel", onTransitionEnd);
    return () => {
      layoutHost.removeEventListener("transitionend", onTransitionEnd);
      layoutHost.removeEventListener("transitioncancel", onTransitionEnd);
    };
  }, [handleLyricsLayoutChange]);

  const handleSeek = useCallback((seconds: number) => {
    player.seek(seconds);
  }, [player]);

  // The visualizer band must be centered on the lyrics scrollport (the
  // region between the topbar overlay and the player dock) rather than the
  // window center — the active lyric is centered there by `scrollIntoView`,
  // so centering the band on the same point keeps the active line pinned to
  // the middle of the visualizer regardless of player-bar/topbar sizes.
  // Measured at runtime (not derived from CSS vars) so it stays correct even
  // when the player bar's real height diverges from `--ui-player-height`.
  const [visualizerCenterY, setVisualizerCenterY] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight / 2,
  );

  useLayoutEffect(() => {
    const measure = () => {
      const container = resolveLyricsScrollContainer();
      if (!container) {
        setVisualizerCenterY(window.innerHeight / 2);
        return;
      }
      const rect = container.getBoundingClientRect();
      setVisualizerCenterY(rect.top + rect.height / 2);
    };

    measure();
    window.addEventListener("resize", measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      const container = resolveLyricsScrollContainer();
      if (container) observer.observe(container);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  if (!track) {
    // Same treatment as the in-track loading overlay: centered on the
    // measured scrollport center (where the active lyric will land) rather
    // than an in-flow min-h box that drifts with the topbar/dock geometry.
    return (
      <div
        className="pointer-events-none fixed left-[var(--ui-sidebar-current)] right-[var(--ui-nowplaying-current)] z-20 flex -translate-y-1/2 items-center justify-center"
        style={{ top: visualizerCenterY }}
      >
        <LoaderCircle size={40} className="animate-spin text-neutral-300" aria-label="Loading lyrics" />
      </div>
    );
  }

  return (
    <div
      className="lyrics-page relative bg-transparent"
      style={{
        minHeight: lyricsViewportMinHeight,
        // Shift the lyrics column with both sidebars (sidebar reveal and
        // now-playing). Horizontal only: 0 while hidden, so the default
        // player-bar-only view is byte-for-byte the old layout.
        paddingLeft: "var(--ui-sidebar-current)",
        paddingRight: "var(--ui-nowplaying-current)",
      }}
    >
      <WaveformVisualizer
        getAnalyser={player.getAnalyser}
        accent={accent}
        isPlaying={player.isPlaying}
        centerY={visualizerCenterY}
      />

      {/* Loading / no-lyrics overlays are centered on the exact point the
          active lyric scrolls to — the scrollport's measured vertical
          center (`visualizerCenterY`), not the window or the scroll
          area's padding box. The old in-flow version offset itself by the
          scroll area's topbar padding (hacked back with a fixed -mt-12)
          and sized itself with CSS-var viewport math that drifts from the
          real scrollport whenever the player dock's height differs from
          `--ui-player-height` — the spinner sat a visible few px off the
          spot where the first loaded line lands. Fixed + centered on the
          same measured Y (and the same sidebar offset as the lyrics
          column) so loading occupies exactly the active lyric's spot. */}
      {loading && !timedOut && (
        <div
          className="pointer-events-none fixed left-[var(--ui-sidebar-current)] right-[var(--ui-nowplaying-current)] z-20 flex -translate-y-1/2 flex-col items-center justify-center gap-4"
          style={{ top: visualizerCenterY }}
        >
          <LoaderCircle size={48} className="animate-spin text-neutral-300" />
          <span className="text-base text-neutral-300">
            {probeState === "checking" ? "Checking for lyrics..." : "Loading lyrics..."}
          </span>
          {probeState === "unavailable" && (
            <span className="text-xs text-neutral-500">Quick check found no synced lyrics — still searching deeper…</span>
          )}
        </div>
      )}
      {timedOut && !loading && (
        <div
          className="animate-no-lyrics-fadeout pointer-events-none fixed left-[var(--ui-sidebar-current)] right-[var(--ui-nowplaying-current)] z-20 flex -translate-y-1/2 flex-col items-center justify-center gap-4"
          style={{ top: visualizerCenterY }}
        >
          <X size={48} className="text-neutral-300" />
          <span className="text-base text-neutral-300">No synced lyrics available</span>
          {lyrics?.appliedOffsetMs != null && lyrics.appliedOffsetMs !== 0 && (
            <span className="text-xs text-neutral-500">Offset {lyrics.appliedOffsetMs}ms applied</span>
          )}
        </div>
      )}

      <div
        className="lyrics-scroll-area nice-scroll relative z-10 mx-auto max-w-3xl px-4 pb-[clamp(2rem,4vw,3rem)] sm:px-6"
        style={{ paddingTop: lyricsScrollPaddingTop }}
      >
        <div className="relative mx-auto max-w-2xl">
          <div
            ref={lyricsStackRef}
            className="relative flex flex-col gap-3"
          >
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
                    onClick={() => {
                      // Clicking a line is an explicit "take me here"
                      // gesture: re-engage auto-follow and center the
                      // clicked line so the view (and the fade) land on it.
                      lastManualScrollAtRef.current = -Infinity;
                      handleSeek(line.startTimeMs / 1000);
                      runProgrammaticScroll(() => {
                        lyricLineRefs.current[index]?.scrollIntoView({ block: "center", behavior: "smooth" });
                      });
                    }}
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
