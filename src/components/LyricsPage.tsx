import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { fetchSyncedLyrics, fetchSyncedLyricsByMeta, findActiveLyricIndex, type SyncedLyrics } from "../lyrics";
import { useAccent } from "../accent-context";
import { currentAudio, usePlayer } from "../player";
import { rgbToCss, type RgbColor } from "../utils/artwork-color";
import { type View } from "./Sidebar";

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
  const targetOpacityRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const lastDrawRef = useRef(0);
  const hiddenRef = useRef(document.hidden);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    // The rAF interior below now owns the target decision end-to-end —
    // it picks a target on every frame from `isPlayingRef.current` and
    // the analyser output. We deliberately do NOT snap
    // `targetOpacityRef.current` here on the frame this effect runs:
    // on resume (false → true) the analyser might briefly read silent
    // (avg < 1) while the audio context warms up, which would otherwise
    // tear the bars down to the 0.5 floor on the very first frame of
    // playback; and on pause/stop (true → false) we now want the
    // visualizer to ride the analyser buffer's residual audio activity
    // (avg >= 1) all the way down to a completely flat state before
    // the target flips to 0 — snapping to 0 here would short-circuit
    // exactly that "wait-flat" behavior and defeat the whole point.
  }, [isPlaying]);

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
    const FRAME_BUDGET_MS = 33; // ~30 fps; enough for a background decoration

    const draw = (now?: number) => {
      if (!running) return;
      frameRef.current = requestAnimationFrame(draw);

      // Throttle to ~30 fps to keep CPU/GPU headroom on low-end Windows
      // machines and software-rendered WebView2 contexts. We still use
      // requestAnimationFrame so the loop pauses in background tabs.
      if (now !== undefined) {
        if (now - lastDrawRef.current < FRAME_BUDGET_MS) return;
        lastDrawRef.current = now;
      }

      // Skip expensive work when the tab is hidden. The loop keeps
      // scheduling itself so it resumes instantly on visibilitychange.
      if (hiddenRef.current) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      // The Web Audio graph (and thus the AnalyserNode) is built lazily
      // inside ensureAudioGraph(), which only runs on the first togglePlay
      // / track load. So at mount getAnalyser() can legitimately return
      // null even though playback is about to start. Poll every frame
      // until the node exists rather than capturing it once at mount.
      const analyser = (analyserRef.current = getAnalyser());
      if (!analyser) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const bufferLength = analyser.frequencyBinCount;
      let dataArray: Uint8Array<ArrayBuffer> | null = dataArrayRef.current;
      if (!dataArray || dataArray.length !== bufferLength) {
        dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
        dataArrayRef.current = dataArray;
      }
      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;
      // `targetOpacityRef.current` is the opacity the visualizer eases
      // toward over a few frames (controlled by `speed` below).
      //
      // Playing branch: keep the bars at full intensity while the
      // signal is present, and FLOOR them at ~0.5 only on the brief
      // silent passages (intro / outro / edits where avg < 1) so the
      // bars never completely empty out mid-track.
      //
      // Paused/stopped branch: we deliberately do NOT snap the target
      // to 0 the instant playback stops. The AnalyserNode's internal
      // buffer still holds the tail of whatever was playing when the
      // user pressed pause or hit the end of the queue, and we want
      // the visualizer to actually show that audio tail as it drains
      // — gives the user a felt sense that the song just stopped
      // rather than the bars vanishing on the same frame as the
      // pause. The target therefore stays at 1 while there is ANY
      // signal at all in the analyser (avg >= 1), and only flips to 0
      // once the analyser has fully settled into a completely flat
      // silence (avg < 1). At that point the speed differential below
      // (0.08 toward 0) drives the actual fade-out. Earlier revisions
      // either pinned the visualizer at ~0.7 when paused (reported as
      // distracting) or skipped directly to fade-on-pause, which now
      // explicitly waits for the audio to actually decay out first.
      const isSilent = avg < 1;
      if (isPlayingRef.current) {
        targetOpacityRef.current = isSilent ? 0.5 : 1;
      } else {
        targetOpacityRef.current = isSilent ? 0 : 1;
      }

      const opacity = opacityRef.current;
      const target = targetOpacityRef.current;
      const speed = target > opacity ? 0.15 : 0.08;
      const nextOpacity = opacity + (target - opacity) * speed;
      opacityRef.current = Math.abs(nextOpacity - target) < 0.005 ? target : nextOpacity;

      if (opacityRef.current <= 0.005) {
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

      // Scale bar density with display width so narrow windows don't pay
      // for a full 64-bar analysis/draw loop, while wide windows keep the
      // detailed look.
      const barCount = Math.min(bufferLength, Math.max(32, Math.floor(w / 14)));
      const totalBarWidth = w / barCount;
      const gap = 2;
      const globalAlpha = opacityRef.current;

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i] / 255;
        const barHeight = Math.max(2, value * h * 0.7);
        const x = i * totalBarWidth;
        const y = (h - barHeight) / 2;

        // Floor the per-bar alpha at 0.75 instead of 0.55 so even the
        // quietest bins stay clearly visible. Combined with the silence
        // floor above, every bar is on screen at >= ~37% opacity whenever
        // audio is playing, which keeps the visualizer reading as the
        // intentional background decoration even on barely-active tracks.
        const alpha = (0.75 + value * 0.25) * globalAlpha;
        ctx.fillStyle = rgbToCss(accent, alpha);
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
      lastDrawRef.current = 0;
    };
  }, [accent, getAnalyser]);

  // Both the canvas and the tint use `position: fixed inset-0` so they
  // cover the FULL viewport — including the sidebar's column to the
  // left of main. With the previous `position: absolute` host inside
  // `.lyrics-page`, the canvas only painted to `.lyrics-page`'s column
  // width, which sits to the right of the sidebar. The sidebar then
  // read as fully opaque regardless of its bg alpha, because there
  // was nothing visually painted behind it for translucency to reveal.
  // `position: fixed inset-0` makes the canvas span the whole viewport
  // so when the (translucent) sidebar overlays it at z-40, the bars
  // literally show through the chrome.
  //
  // Fixed positioning is now safe because the ancestors that COULD
  // trap a `fixed` descendant (`transform`/`perspective`/`filter`/
  // `contain: paint`) are clean. `.page-content` no longer carries
  // `contain: paint` (see `index.css`). Its `animation: page-enter
  // ... both` ends with `transform: none`, so once the 180ms entrance
  // is over `.page-content` does not establish a containing block for
  // fixed descendants. `.lyrics-page` / the wrapper have no transform,
  // perspective, or filter either. The canvas's containing block for
  // fixed is therefore the App viewport.
  //
  // Layer architecture (inside `.page-content`'s `isolation: isolate`
  // stacking context):
  //
  //   <div fixed inset-0 z-0>               ← covers the entire viewport
  //     <canvas block h-[100dvh] w-full>    ← bars across viewport (NOT
  //                                              just .lyrics-page's
  //                                              column width), so the
  //                                              sidebar column shows
  //                                              bars through it.
  //     <div absolute inset-0 bg-black/40>  ← tint, paints OVER the
  //                                              canvas (DOM order
  //                                              resolves tint-after-
  //                                              canvas inside the z=0
  //                                              wrapper's stacking
  //                                              context).
  //   </div>
  //   <div.lyrics-scroll-area z-10>         ← lyrics, on top.
  //   <aside z-40>                          ← sidebar, paints over main
  //                                              with its own translucent
  //                                              bg (currently bg-black/55,
  //                                              ~45% bars visible
  //                                              through the chrome).
  //
  // Bar peek-through the lyric glyphs is still physically impossible
  // because the lyric text paints ON TOP of the canvas+tint stack.
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
  const [lyrics, setLyrics] = useState<SyncedLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const accent = useAccent();
  const [displayProgress, setDisplayProgress] = useState(0);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastScrolledIndexRef = useRef(-1);
  const displayProgressRef = useRef(0);
  const playerProgressRef = useRef(player.progress);
  const isProgrammaticScrollRef = useRef(false);
  const autoScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const activeLyricIndexRef = useRef(-1);

  // Keep the fallback ref in sync with the coarse player.progress (used
  // only when currentAudio.current is unavailable inside the rAF loop).
  // We deliberately do NOT touch displayProgressRef / displayProgress here:
  // player.progress is driven by the HTML media `timeupdate` event (~4 Hz),
  // which is much coarser than the rAF loop below (~60 Hz). Overwriting the
  // rAF-refined value on every timeupdate would snap the active lyric
  // backwards ~4 times per second, producing a visible flicker / desync.
  useEffect(() => {
    playerProgressRef.current = player.progress;
  }, [player.progress]);

  // Reset the display position when the track changes. The first lyric
  // line will be centered once lyrics load (see the lyrics-loaded effect
  // below). The rAF loop then refines the active line position from
  // audio.currentTime.
  useEffect(() => {
    const initial = playerProgressRef.current;
    displayProgressRef.current = initial;
    setDisplayProgress(initial);
  }, [track?.id]);

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

    let frameId = 0;
    let running = true;
    const FRAME_BUDGET_MS = 33;
    let lastSync = 0;

    const syncProgress = (now?: number) => {
      if (!running) return;
      frameId = window.requestAnimationFrame(syncProgress);
      if (now !== undefined && now - lastSync < FRAME_BUDGET_MS) return;
      lastSync = now ?? performance.now();
      const liveProgress = currentAudio.current?.currentTime;
      const nextProgress = Number.isFinite(liveProgress) ? liveProgress ?? 0 : playerProgressRef.current;
      if (Math.abs(nextProgress - displayProgressRef.current) >= 0.01) {
        displayProgressRef.current = nextProgress;
        setDisplayProgress(nextProgress);
      }
    };

    frameId = window.requestAnimationFrame(syncProgress);
    return () => {
      running = false;
      window.cancelAnimationFrame(frameId);
    };
  }, [track?.id]);

  const activeLyricIndex = useMemo(() => {
    if (!lyrics || !track) return -1;
    return findActiveLyricIndex(lyrics.lines, displayProgress);
  }, [lyrics, track, displayProgress]);

  useEffect(() => {
    activeLyricIndexRef.current = activeLyricIndex;
  }, [activeLyricIndex]);

  // Find the scroll container and attach auto-recenter listener
  useEffect(() => {
    const lyricsScrollArea = document.querySelector('.lyrics-scroll-area');
    if (!lyricsScrollArea) return;
    // Walk up to find the actual scroll viewport (first overflow-y-auto ancestor),
    // not .lyrics-scroll-area itself which has .nice-scroll but no overflow.
    let container = lyricsScrollArea.parentElement;
    while (container) {
      const style = window.getComputedStyle(container);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
      container = container.parentElement;
    }
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
    return () => {
      if (autoScrollTimeoutRef.current) clearTimeout(autoScrollTimeoutRef.current);
    };
  }, [track?.id]);

  useEffect(() => {
    if (!track) {
      setLyrics(null);
      setLoading(false);
      setTimedOut(false);
      return;
    }

    if (track.source === "stream") {
      if (!track.videoId) {
        setLyrics(null);
        setLoading(false);
        setTimedOut(true);
        return;
      }

      let cancelled = false;
      setLoading(true);
      setLyrics(null);
      setTimedOut(false);

      const timeoutId = setTimeout(() => {
        if (cancelled || player.currentTrack?.id !== track.id) return;
        setTimedOut(true);
      }, 7000);

      void fetchSyncedLyrics(track.videoId)
        .then((nextLyrics) => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          clearTimeout(timeoutId);
          setLyrics(nextLyrics);
          setLoading(false);
          if (!nextLyrics) setTimedOut(true);
        })
        .catch(() => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          clearTimeout(timeoutId);
          setLyrics(null);
          setLoading(false);
          setTimedOut(true);
        });

      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }

    // Upload track — only try lyrics if the user opted in.
    if (track.source === "upload" && track.findLyrics) {
      let cancelled = false;
      setLoading(true);
      setLyrics(null);
      setTimedOut(false);

      const timeoutId = setTimeout(() => {
        if (cancelled || player.currentTrack?.id !== track.id) return;
        setTimedOut(true);
      }, 7000);

      void fetchSyncedLyricsByMeta(track)
        .then((nextLyrics) => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          clearTimeout(timeoutId);
          setLyrics(nextLyrics);
          setLoading(false);
          if (!nextLyrics) setTimedOut(true);
        })
        .catch(() => {
          if (cancelled || player.currentTrack?.id !== track.id) return;
          clearTimeout(timeoutId);
          setLyrics(null);
          setLoading(false);
          setTimedOut(true);
        });

      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }

    setLyrics(null);
    setLoading(false);
    setTimedOut(true);
  }, [
    // Derive a stable primitive key from the exact fields that should
    // force a lyrics refetch. Tracking every individual field would
    // re-fire the request on any unrelated metadata tweak (e.g. a
    // upload track's `durationSeconds` hydrating in after the page
    // mounted). Stream tracks are uniquely identified by `videoId`;
    // upload tracks are identified by (id, findLyrics, title, artist,
    // album, durationSeconds) so a re-import that corrected the title
    // (or async duration hydration) still picks up the new lyrics.
    track?.source === "stream"
      ? `stream-${track?.videoId ?? ""}`
      : `upload-${track?.id ?? ""}-${track?.findLyrics ? 1 : 0}-${track?.title ?? ""}-${track?.artist ?? ""}-${track?.album ?? ""}-${track?.durationSeconds ?? ""}`,
  ]);

  useEffect(() => {
    if (activeLyricIndex < 0 || activeLyricIndex === lastScrolledIndexRef.current) return;
    lastScrolledIndexRef.current = activeLyricIndex;
    isProgrammaticScrollRef.current = true;
    lyricLineRefs.current[activeLyricIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
  }, [activeLyricIndex]);

  const prevLyricsRef = useRef<SyncedLyrics | null>(null);
  useEffect(() => {
    // Clear the per-line DOM ref array on every track change. Without
    // this, a 100-line track followed by a 20-line track leaves indices
    // 20-99 holding stale DOM nodes from the previous track. The array
    // is rebuilt naturally as the new `<button ref>` callbacks fire.
    lyricLineRefs.current = [];
    lastScrolledIndexRef.current = -1;
  }, [track?.id]);
  // When lyrics first load, scroll to the active lyric line (if the song
  // is mid-play) or to the first line (if the song is just starting).
  // The top 50dvh spacer gives the scroll container enough room to center
  // the first line. The bottom spacer is calculated dynamically so the
  // last lyric centers exactly at the maximum scroll position, preventing
  // overscroll past the end of the lyrics.
  // We read progress from the rAF-ref (not React state) because the
  // state may lag behind during initial mount batching, causing us to
  // scroll to line 0 and then snap to the real active line a frame later.
  useEffect(() => {
    const hadLyrics = prevLyricsRef.current;
    prevLyricsRef.current = lyrics;
    if (!hadLyrics && lyrics && lyrics.lines.length > 0) {
      // Calculate bottom spacer so the last lyric can be centered but
      // not scrolled past: spacer = (viewportHeight - lastLineHeight) / 2
      // minus any existing padding below the spacer (lyrics-scroll-area pb
      // + scroll container pb) so those don't add extra overscroll.
      const viewport = scrollContainerRef.current;
      const lastIndex = lyrics.lines.length - 1;
      if (viewport && bottomSpacerRef.current) {
        const lastEl = lyricLineRefs.current[lastIndex];
        if (lastEl) {
          const vh = viewport.clientHeight;
          const lh = lastEl.offsetHeight;
          const scrollPad = parseFloat(window.getComputedStyle(viewport).paddingBottom) || 0;
          const areaEl = document.querySelector('.lyrics-scroll-area');
          const areaPad = areaEl ? parseFloat(window.getComputedStyle(areaEl).paddingBottom) || 0 : 0;
          const ideal = Math.max(0, (vh - lh) / 2 - scrollPad - areaPad);
          bottomSpacerRef.current.style.height = `${ideal}px`;
        }
      }
      const index = findActiveLyricIndex(lyrics.lines, displayProgressRef.current);
      const targetIndex = index >= 0 ? index : 0;
      lastScrolledIndexRef.current = targetIndex;
      isProgrammaticScrollRef.current = true;
      lyricLineRefs.current[targetIndex]?.scrollIntoView({ block: "center", behavior: "instant" });
      setTimeout(() => { isProgrammaticScrollRef.current = false; }, 0);
    }
  }, [lyrics]);

  // Recalculate bottom spacer on window resize
  useEffect(() => {
    if (!lyrics || lyrics.lines.length === 0) return;
    const viewport = scrollContainerRef.current;
    const lastIndex = lyrics.lines.length - 1;
    if (!viewport || !bottomSpacerRef.current) return;
    const recalc = () => {
      const lastEl = lyricLineRefs.current[lastIndex];
      const spacer = bottomSpacerRef.current;
      if (!lastEl || !spacer) return;
      const vh = viewport.clientHeight;
      const lh = lastEl.offsetHeight;
      const scrollPad = parseFloat(window.getComputedStyle(viewport).paddingBottom) || 0;
      const areaEl = document.querySelector('.lyrics-scroll-area');
      const areaPad = areaEl ? parseFloat(window.getComputedStyle(areaEl).paddingBottom) || 0 : 0;
      const ideal = Math.max(0, (vh - lh) / 2 - scrollPad - areaPad);
      spacer.style.height = `${ideal}px`;
    };
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [lyrics]);

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

  // The waveform canvas (WaveformVisualizer) is rendered inline here
  // (no body portal) as a scoped descendant of `.lyrics-page`. Lyrics
  // paints physically on top of the canvas/tint stack, so there is no
  // bleed-through text glyphs and no halo/stroke/font-weight trick is
  // needed to "seal" inter-letter gaps. See the comment block inside
  // WaveformVisualizer for the full architectural reasoning.
  //
  // The soft black tint sits between the canvas and the lyrics as a
  // dedicated sibling div inside the WaveformVisualizer stack (NOT as
  // `.lyrics-page`'s own background, which would paint BEHIND the
  // canvas and fail the user's "tint eases the bars while keeping them
  // visible" requirement).
  //
  // The lyric lines themselves carry NO pill, NO rounded background,
  // NO stroke, NO halo — strictly bare text on the wash, with active
  // vs inactive differentiated by text color plus a hover brighten
  // (the original behavior the user asked for).
  return (
    <div className="lyrics-page relative min-h-[calc(100dvh-var(--ui-topbar-height)-var(--ui-player-bottom)-var(--ui-player-height))] bg-transparent">
      <WaveformVisualizer
        getAnalyser={player.getAnalyser}
        accent={accent}
        isPlaying={player.isPlaying}
      />

      <div
        className="lyrics-scroll-area nice-scroll relative z-10 mx-auto max-w-3xl px-4 pt-[var(--ui-topbar-height)] pb-[clamp(2rem,4vw,3rem)] sm:px-6"
      >
        <div className="relative mx-auto max-w-2xl">
          <div
            className="relative flex flex-col gap-3"
          >
          {loading && !timedOut && (
            <div className="flex min-h-[calc(100dvh-var(--ui-topbar-height)-var(--ui-player-bottom)-var(--ui-player-height))] -mt-12 flex-col items-center justify-center gap-4">
              <LoaderCircle size={48} className="animate-spin text-neutral-300" />
              <span className="text-base text-neutral-300">Loading lyrics...</span>
            </div>
          )}
          {timedOut && !loading && (
            <div className="flex min-h-[calc(100dvh-var(--ui-topbar-height)-var(--ui-player-bottom)-var(--ui-player-height))] -mt-12 flex-col items-center justify-center gap-4">
              <X size={48} className="text-neutral-300" />
              <span className="text-base text-neutral-300">No synced lyrics available</span>
            </div>
          )}
          {lyrics && (
            <>
              {/* Spacer to allow first lyric to scroll to center of viewport */}
              <div aria-hidden="true" className="h-[50dvh] pointer-events-none" />
              {lyrics.lines.map((line, index) => {
                const active = index === activeLyricIndex;
                return (
                  <button
                    key={`${line.id}-${index}`}
                    type="button"
                    ref={(node) => {
                      lyricLineRefs.current[index] = node;
                    }}
                    onClick={() => handleSeek(line.startTimeMs / 1000)}
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
