import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { getOfflineVideoPath, resolveVideoStream } from "../api";
import { audioMuteOverride, currentAudio, usePlayer } from "../player";
import { clampVolume } from "../player/helpers";
import { getSetting } from "../settings";
import {
  subscribeTransport,
  usePlayerTransportStore,
} from "../store/playerTransportStore";
import { usePlayerUiStore } from "../store/playerUiStore";
import { resolveFileMediaSrc, streamIdentityVideoIds } from "../utils/media";
import { findMusicVideoForTrack, type MusicVideoMatch } from "../utils/music-video";

const SEARCH_TIMEOUT_MS = 8_000;
// Matches the backend's VIDEO_STREAM_RESOLVE_TIMEOUT (240s): 1080p music
// videos are much larger than audio-only streams and need the extra room on
// slower connections.
const DOWNLOAD_TIMEOUT_MS = 240_000;
// How far the video may drift from the player's audio clock before it is
// re-seeked. Both media elements run in real time, so drift stays small;
// the tolerance keeps the correction from stuttering the visual.
const SYNC_DRIFT_TOLERANCE_SECONDS = 0.8;
// Page padding around the video (px-4 sides + pb-3 bottom).
const VIDEO_SIDE_PADDING_PX = 32;
const VIDEO_BOTTOM_PADDING_PX = 12;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolve a CSS custom property holding a <length> (e.g. a clamp) to px. */
function readCssVarLength(name: string): number {
  // The design tokens live on `#root`, so the probe must inherit from there —
  // a probe on <body> would see an unresolved var() and measure 0.
  const host = document.getElementById("root") ?? document.body;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.height = `var(${name})`;
  host.appendChild(probe);
  const value = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

type VideoPhase = "searching" | "downloading" | "ready" | "missing" | "error";

/**
 * Music-video watch page. Mirrors the lyrics page's full-bleed layout (player
 * bar stays visible at the bottom) but shows the video instead of lyrics.
 *
 * While the page is open the VIDEO element owns the audible audio: the video
 * is unmuted and the player's audio element is silenced (it keeps running as
 * the master clock, so progress, the player bar, lyrics, session save, and
 * autoplay all stay in lockstep). Player-bar play/pause/seek/volume are
 * mirrored from the audio element onto the video via DOM events rather than
 * polling, so pausing the song pauses the video in the same frame. Closing
 * the page restores the player's audio element to the user's own mute state.
 *
 * The video is sized and centered from measured pixels (not CSS flex tricks):
 * it fills as much of the area between the top bar and the player bar as its
 * real aspect ratio allows, always centered. While the page is open the
 * player bar's seek bar reports the VIDEO's own duration (a 4-minute MV
 * inside an 8-minute studio track) via `setVideoDuration`.
 */
export function MusicVideoPage({ onExit }: { onExit: () => void }) {
  const player = usePlayer();
  const track = player.currentTrack;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [match, setMatch] = useState<MusicVideoMatch | null>(null);
  const [phase, setPhase] = useState<VideoPhase>("searching");
  const [src, setSrc] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // True when the browser blocked unmuted video autoplay (rare — the app's
  // first user click usually unlocks it). Shows a click-to-play hint.
  const [playBlocked, setPlayBlocked] = useState(false);
  // Exact available area (the scrollport the page lives in), measured once
  // the page mounts. Falls back to the CSS calc before the first measure.
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);
  // The largest box that fits the available area at the video's aspect ratio.
  const [videoBox, setVideoBox] = useState<{ w: number; h: number } | null>(null);
  // The video's real aspect ratio, once metadata loads (16:9 before that).
  const [videoAspect, setVideoAspect] = useState(16 / 9);

  // Identity key for the active song. Upload tracks have no videoId, so the
  // (id, title, artist) tuple keeps a re-imported upload's MV fresh.
  const trackKey = useMemo(() => {
    if (!track) return null;
    if (track.source === "stream") {
      return `stream:${streamIdentityVideoIds(track).join(",")}`;
    }
    return `upload:${track.id}:${track.title}:${track.artist}`;
  }, [track]);

  useEffect(() => {
    if (!track || !trackKey) {
      setMatch(null);
      setPhase("missing");
      return;
    }

    let cancelled = false;
    // A new song (or a retry) invalidates the previous video's blob URL.
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPhase("searching");
    setMatch(null);
    setSrc(null);
    setErrorMessage(null);
    setPlayBlocked(false);

    const load = async () => {
      try {
        const mv = await withTimeout(
          findMusicVideoForTrack(track),
          SEARCH_TIMEOUT_MS,
          "Finding the music video took too long.",
        );
        if (cancelled || player.currentTrack?.id !== track.id) return;
        if (!mv) {
          setPhase("missing");
          return;
        }
        setMatch(mv);
        setPhase("downloading");
        // Prefer the locally-saved copy (saved songs with an MV persist it
        // into the offline folder) — instant and offline-capable. Only fall
        // back to the streams-cache resolve / download when no local copy
        // exists.
        let filePath: string | null = null;
        try {
          filePath = await getOfflineVideoPath(mv.videoId);
        } catch {
          // Offline lookup is best-effort; fall through to the resolve path.
        }
        if (!filePath) {
          const stream = await withTimeout(
            resolveVideoStream(mv.videoId),
            DOWNLOAD_TIMEOUT_MS,
            "Downloading the music video took too long.",
          );
          if (cancelled || player.currentTrack?.id !== track.id) return;
          filePath = stream.filePath ?? null;
        }
        if (!filePath) {
          throw new Error("The backend did not return a video file.");
        }
        const mediaSrc = await resolveFileMediaSrc(filePath);
        if (cancelled || player.currentTrack?.id !== track.id) return;
        if (mediaSrc.startsWith("blob:")) blobUrlRef.current = mediaSrc;
        setSrc(mediaSrc);
        setPhase("ready");
      } catch (error) {
        if (cancelled || player.currentTrack?.id !== track.id) return;
        setErrorMessage(error instanceof Error ? error.message : "Could not load the music video.");
        setPhase("error");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // `trackKey` encodes the active song's identity (stream ids / upload id +
    // title + artist), so the effect only re-runs when the song actually
    // changes or the user hits Retry.
  }, [trackKey, retryNonce]);

  // Measure the exact available area (the scrollport), then size the video
  // box to the largest fit at the video's aspect ratio. Measuring from the
  // DOM instead of CSS-var math keeps the box filling the real space even
  // when the player dock's rendered height drifts from `--ui-player-height`.
  useLayoutEffect(() => {
    const scrollport = document.querySelector(".main-scrollport");
    if (!scrollport) return;
    const update = () => {
      setViewportSize({ w: scrollport.clientWidth, h: scrollport.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrollport);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !viewportSize) return;
    const update = () => {
      const cs = window.getComputedStyle(el);
      const padX =
        (Number.parseFloat(cs.paddingLeft) || 0) +
        (Number.parseFloat(cs.paddingRight) || 0);
      const topbar = readCssVarLength("--ui-topbar-height");
      const availW = Math.max(0, viewportSize.w - padX - VIDEO_SIDE_PADDING_PX);
      const availH = Math.max(0, viewportSize.h - topbar - VIDEO_BOTTOM_PADDING_PX);
      if (availW <= 0 || availH <= 0) return;
      const aspect = videoAspect > 0 ? videoAspect : 16 / 9;
      let w = Math.min(availW, availH * aspect);
      let h = w / aspect;
      if (h > availH) {
        h = availH;
        w = h * aspect;
      }
      setVideoBox({ w, h });
    };
    update();
    // Observe the root: its content box shrinks when the sidebars reveal
    // (padding animates), so the box re-fits during the reveal transition.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [viewportSize, videoAspect]);

  // Playback effect: the VIDEO element owns the audible audio while the page
  // is open. The player's audio element is silenced but kept running as the
  // master clock, and its play/pause/seek/timeupdate events are mirrored onto
  // the video immediately (no polling), so the player bar's controls act on
  // the video in the same frame.
  useEffect(() => {
    if (phase !== "ready" || !src) return;
    const video = videoRef.current;
    const audio = currentAudio.current;
    if (!video || !audio) return;

    // Mirror the user's volume/mute from the transport store onto the video
    // element, using the SAME gain chain as the player's audio element
    // (volume × master-volume dB × loudness-normalization gain). Without the
    // normGain factor the video plays quieter than the song at the same
    // slider position.
    const applyUserVolume = () => {
      const { volume, muted, normGain, liveVolume } = usePlayerTransportStore.getState();
      const masterDb = getSetting("masterVolume");
      const normalizationEnabled = getSetting("audioNormalization");
      const norm =
        normalizationEnabled && Number.isFinite(normGain) && normGain > 0 ? normGain : 1;
      // `liveVolume` carries the slider's in-progress value while dragging;
      // fall back to the committed `volume` when no drag is happening.
      const effectiveVolume = liveVolume ?? volume;
      video.volume = clampVolume(effectiveVolume * Math.pow(10, masterDb / 20) * norm);
      video.muted = muted;
    };
    const handlePlay = () => {
      if (video.ended) return;
      void video.play().catch(() => {
        setPlayBlocked(true);
      });
    };
    const handlePause = () => {
      video.pause();
    };
    const handleSeeked = () => {
      if (Number.isFinite(audio.currentTime)) {
        video.currentTime = audio.currentTime;
      }
    };
    const handleTimeUpdate = () => {
      const drift = Math.abs(video.currentTime - audio.currentTime);
      if (audio.duration > 0 && drift > SYNC_DRIFT_TOLERANCE_SECONDS) {
        video.currentTime = audio.currentTime;
      }
    };
    const handleVideoPlay = () => setPlayBlocked(false);
    // Once metadata is known, report the video's real aspect ratio (for
    // sizing) and its real duration (for the player bar's seek bar).
    const handleMetadata = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw > 0 && vh > 0) {
        setVideoAspect(vw / vh);
      }
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        usePlayerUiStore.getState().setVideoDuration(duration);
      }
    };

    // Jump the video to where the song already is, then mirror the audio
    // element's play state.
    if (Number.isFinite(audio.currentTime)) {
      video.currentTime = audio.currentTime;
    }
    applyUserVolume();
    // Silence the background audio. `audioMuteOverride` keeps it silent even
    // when the user drags the volume slider or toggles mute (both of which
    // write to the audio element directly), so only the video is audible.
    audioMuteOverride.current = true;
    audio.muted = true;
    if (audio.paused) {
      video.pause();
    } else {
      handlePlay();
    }

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handleVideoPlay);
    video.addEventListener("loadedmetadata", handleMetadata);
    video.addEventListener("durationchange", handleMetadata);
    // Mirror the user's volume/mute onto the video whenever the transport
    // changes. The mute override (not a re-mute here) keeps the background
    // silent.
    const unsubscribeTransport = subscribeTransport(() => {
      applyUserVolume();
    });

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("seeked", handleSeeked);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handleVideoPlay);
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("durationchange", handleMetadata);
      unsubscribeTransport();
      video.pause();
      // Hand the audio back to the player with the user's own mute state,
      // and restore the seek bar to the song's own duration.
      audioMuteOverride.current = false;
      usePlayerUiStore.getState().setVideoDuration(null);
      const current = currentAudio.current;
      if (current) current.muted = usePlayerTransportStore.getState().muted;
    };
  }, [phase, src]);

  // Revoke the blob URL when the page unmounts.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const handleRetry = useCallback(() => {
    setRetryNonce((nonce) => nonce + 1);
  }, []);

  // Escape closes the page, mirroring the Now Playing panel.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onExit]);

  // Fallback before the first scrollport measure. The top bar overlays the
  // scrollport (it consumes no flow height), so only the player dock is
  // subtracted here; the top bar is cleared with a spacer inside the page.
  const viewportParts = ["100dvh"];
  viewportParts.push("var(--ui-player-bottom)");
  viewportParts.push("var(--ui-player-height)");
  const viewportMinHeight =
    viewportParts.length === 1
      ? viewportParts[0]
      : `calc(${viewportParts[0]} - ${viewportParts.slice(1).join(" - ")})`;

  const busy = phase === "searching" || phase === "downloading";
  const busyLabel = phase === "searching" ? "Finding music video…" : "Downloading music video…";

  // Before the first measurement lands, render a reasonable CSS-sized box so
  // the video element (and its audio takeover + overlays) is never gated on
  // the measurement succeeding.
  const boxStyle: React.CSSProperties = videoBox
    ? { width: videoBox.w, height: videoBox.h }
    : {
        aspectRatio: `${videoAspect}`,
        width: "100%",
        maxWidth: "min(72rem, calc(100vw - 3rem))",
      };

  return (
    <div
      ref={rootRef}
      className="music-video-page relative overflow-hidden bg-transparent"
      style={{
        height: viewportSize ? `${viewportSize.h}px` : viewportMinHeight,
        // Shift the video column with both sidebars, like the lyrics page.
        paddingLeft: "var(--ui-sidebar-current)",
        paddingRight: "var(--ui-nowplaying-current)",
      }}
    >
      {/* Spacer clearing the overlay top bar. */}
      <div aria-hidden className="w-full" style={{ height: "var(--ui-topbar-height)" }} />

      {/* The video box is sized to the largest fit at the video's real aspect
          ratio and centered in the remaining area (between top bar and player
          bar), so it always fills as much of the page as it can. */}
      <div
        className="flex w-full items-center justify-center px-4 pb-3"
        style={{ height: "calc(100% - var(--ui-topbar-height))" }}
      >
        {/* Back button — floats above the content, below the top bar. Matches
            the app's other icon buttons: the icon itself highlights on hover
            (no filled circle / outline). */}
        <button
          type="button"
          onClick={onExit}
          aria-label="Back"
          className="absolute right-[calc(var(--ui-nowplaying-current)+1rem)] top-[calc(var(--ui-topbar-height)+0.75rem)] z-20 flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors duration-100 ease-out hover:text-white"
        >
          <ArrowLeft size={20} />
        </button>

        <div style={boxStyle} className="relative shrink-0 overflow-hidden rounded-2xl bg-black">
            {match && phase !== "missing" && (
              <video
                ref={videoRef}
                src={src ?? undefined}
                playsInline
                preload="auto"
                className="absolute inset-0 h-full w-full object-contain"
              />
            )}
            {busy && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60">
                <LoaderCircle size={34} className="animate-spin text-neutral-300" />
                <span className="text-xs font-semibold text-neutral-400">{busyLabel}</span>
              </div>
            )}
            {phase === "missing" && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-8 text-center">
                <span className="text-sm font-semibold text-neutral-400">
                  No music video found for this song.
                </span>
              </div>
            )}
            {phase === "error" && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-8 text-center">
                <span className="max-w-md text-sm font-semibold text-neutral-300">
                  {errorMessage ?? "Could not load the music video."}
                </span>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-semibold text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
                >
                  Try again
                </button>
              </div>
            )}
            {playBlocked && phase === "ready" && (
              <button
                type="button"
                onClick={() => {
                  setPlayBlocked(false);
                  void videoRef.current?.play().catch(() => setPlayBlocked(true));
                }}
                className="absolute inset-0 z-10 flex items-center justify-center bg-black/50"
              >
                <span className="rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20">
                  Click to play video
                </span>
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
