import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Ellipsis, LoaderCircle, Music2, Pause, Play } from "lucide-react";
import { cacheArtwork } from "../api";
import { usePlayerActions } from "../player";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import { useIsTrackSaved, useToggleTrackSave } from "../hooks/useCollectionSelectors";
import { useTrackPlaybackState } from "../hooks/usePlayerSelectors";
import type { MediaTrack } from "../types";
import type { QueueOrigin } from "../player";
import { formatOptionalDuration } from "../utils/media";
import { getDirectArtistBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import type { View } from "./Sidebar";
import { ArtistCreditText } from "./PagesShared";
import { SaveButton } from "./SaveButton";
import { Marquee } from "./Marquee";

export function getArtworkRoundedClass(shape: "square" | "circle" = "square") {
  return shape === "circle" ? "rounded-full" : "rounded-[4px]";
}

/** Transition + pointer-event gating for artwork-card play buttons that slide up on group hover. */
export const cardHoverPlayTransitionClass =
  "transition-all duration-200 ease-out pointer-events-none group-hover:pointer-events-auto animate-none";

export function cardHoverPlayRevealClass(visible = false): string {
  return visible
    ? "translate-y-0 opacity-100 pointer-events-auto"
    : "translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100";
}

export function cardPlayButtonSizing(size: "sm" | "md" | "lg" = "md") {
  if (size === "lg") return { buttonClass: "h-14 w-14", iconSize: 24 };
  if (size === "sm") return { buttonClass: "h-10 w-10", iconSize: 16 };
  return { buttonClass: "h-12 w-12", iconSize: 20 };
}

function artworkCandidates(src?: string | null): string[] {
  if (!src) return [];

  const normalized = src.startsWith("//") ? `https:${src}` : src;
  const candidates = [normalized];
  const [withoutQuery] = normalized.split("?");

  if (withoutQuery !== normalized) {
    candidates.push(withoutQuery);
  }

  const lastEquals = withoutQuery.lastIndexOf("=");
  if (lastEquals > -1) {
    const suffix = withoutQuery.slice(lastEquals + 1);
    if (/^[a-z]\d/i.test(suffix)) {
      candidates.push(withoutQuery.slice(0, lastEquals));
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function buildArtworkCandidateList(sources: Array<string | null | undefined>): string[] {
  const candidates: string[] = [];
  for (const source of sources) {
    candidates.push(...artworkCandidates(source));
  }
  return Array.from(new Set(candidates));
}

export function useResolvedArtworkSource(sources: Array<string | null | undefined>) {
  const sourceSignature = sources.map((source) => source?.trim() ?? "").join("\n");
  const candidates = useMemo(
    () => buildArtworkCandidateList(sources),
    [sourceSignature],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [cachedSrc, setCachedSrc] = useState<string | null>(null);
  const [cacheAttempted, setCacheAttempted] = useState(false);
  const signatureRef = useRef(sourceSignature);

  useEffect(() => {
    signatureRef.current = sourceSignature;
    setCandidateIndex(0);
    setCachedSrc(null);
    setCacheAttempted(false);
  }, [sourceSignature]);

  const activeSrc = cachedSrc ?? candidates[candidateIndex] ?? null;

  const handleError = (failedSrc?: string | null) => {
    if (failedSrc && activeSrc && failedSrc !== activeSrc) {
      return;
    }

    if (cachedSrc) {
      setCachedSrc(null);
      setCacheAttempted(true);
      return;
    }

    const nextIndex = candidateIndex + 1;
    if (nextIndex < candidates.length) {
      setCandidateIndex(nextIndex);
      return;
    }

    const cacheSource = candidates[0] ?? null;
    if (cacheAttempted || !cacheSource) {
      setCandidateIndex(nextIndex);
      return;
    }

    setCacheAttempted(true);
    cacheArtwork(cacheSource)
      .then((filePath) => {
        if (signatureRef.current === sourceSignature) {
          setCachedSrc(convertFileSrc(filePath));
        }
      })
      .catch(() => setCandidateIndex(nextIndex));
  };

  return {
    src: activeSrc,
    onError: handleError,
  };
}

export function DefaultArtwork({ className = "h-full w-full" }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-black ${className}`}>
      <img src="/icon.png" alt="" className="h-4/5 w-4/5 object-contain" draggable={false} />
    </div>
  );
}

function ArtworkImageLoaded({
  src,
  sources,
  className,
  draggable = false,
  fallback,
}: {
  src?: string | null;
  sources?: Array<string | null | undefined>;
  className: string;
  draggable?: boolean;
  fallback?: ReactNode;
}) {
  const resolved = useResolvedArtworkSource(sources ?? [src]);
  const activeSrc = resolved.src;
  if (!activeSrc) {
    return fallback ?? <DefaultArtwork className={className} />;
  }

  return (
    <img
      src={activeSrc}
      alt=""
      className={`block bg-transparent ${className}`}
      draggable={draggable}
      decoding="async"
      loading="lazy"
      onError={(event) => {
        resolved.onError(event.currentTarget.currentSrc || event.currentTarget.src);
      }}
    />
  );
}

export function ArtworkImage({
  src,
  sources,
  className,
  draggable = false,
  fallback,
  loading = "lazy",
}: {
  src?: string | null;
  sources?: Array<string | null | undefined>;
  className: string;
  draggable?: boolean;
  fallback?: ReactNode;
  loading?: "lazy" | "eager";
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(loading === "eager");

  useEffect(() => {
    if (loading === "eager" || visible) return;
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [loading, visible]);

  return (
    <span ref={hostRef} className={`inline-flex ${className}`}>
      {visible ? (
        <ArtworkImageLoaded
          src={src}
          sources={sources}
          className={className}
          draggable={draggable}
          fallback={fallback}
        />
      ) : (
        fallback ?? <DefaultArtwork className={className} />
      )}
    </span>
  );
}

export const TrackRow = memo(function TrackRow({
  track,
  index,
  onPlay,
  showAlbum = false,
  showArtist = false,
  rightText,
  onNavigateToAlbum,
  onNavigateToArtist,
  onNavigate,
  queueOrigin: _queueOrigin,
}: {
  track: MediaTrack;
  index?: number;
  onPlay: () => void;
  showAlbum?: boolean;
  showArtist?: boolean;
  rightText?: string;
  onNavigateToAlbum?: () => void;
  onNavigateToArtist?: () => void;
  onNavigate?: (view: View) => void;
  queueOrigin?: QueueOrigin | null;
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
      className={`group grid cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_minmax(7.5rem,10rem)_4.5rem] items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-neutral-900 sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(10rem,13rem)_5rem] ${
        active ? "bg-neutral-900/70" : ""
      }`}
      onClick={active ? togglePlay : onPlay}
    >
      <div className="flex items-center justify-center">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? togglePlay : onPlay)();
          }}
          className={`flex h-6 w-6 items-center justify-center text-neutral-500 hover:text-white ${
            bufferingActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={playingActive ? "Pause" : "Play"}
        >
          {bufferingActive ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : playingActive ? (
            <Pause size={14} />
          ) : (
            <Play size={12} fill="currentColor" />
          )}
        </button>

        {!(playingActive || bufferingActive) && (
          <span className={`text-xs tabular-nums group-hover:hidden ${active ? "text-white" : "text-neutral-500"}`}>
            {index != null ? index + 1 : ""}
          </span>
        )}

        {playingActive && !bufferingActive && <PlayingBars />}
        {bufferingActive && (
          <span className="text-white group-hover:hidden">
            <LoaderCircle size={14} className="animate-spin" />
          </span>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <div className={`h-[var(--ui-control-sm)] w-[var(--ui-control-sm)] flex-shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`}>
          {track.cover ? (
            <ArtworkImage src={track.cover} className="h-full w-full object-cover" />
          ) : (
            <DefaultArtwork />
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {onNavigateToAlbum ? (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToAlbum();
              }}
              className={`block w-full text-left font-medium transition focus-visible:outline-none ${
                active ? "text-white/80 hover:text-white/95" : "text-neutral-100 hover:text-white/95"
              }`}
            >
              <Marquee className="font-medium text-inherit">{track.title}</Marquee>
            </button>
          ) : (
            <Marquee className={`font-medium ${active ? "text-white" : "text-neutral-100"}`}>{track.title}</Marquee>
          )}
          {showArtist && (
            <div>
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
              ) : onNavigateToArtist ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onNavigateToArtist();
                  }}
                  className="block w-full truncate text-left text-xs text-neutral-400 hover:text-white/95 focus-visible:outline-none"
                >
                  {track.artist}
                </button>
              ) : (
                <div className="truncate text-xs text-neutral-400">{track.artist}</div>
              )}
            </div>
          )}
        </div>
        {track.source !== "upload" && (
          <div className="shrink-0 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all" onClick={(e) => e.stopPropagation()}>
            <SaveButton
              isSaved={isSaved}
              size="sm"
              onToggle={toggleSave}
              ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
            />
          </div>
        )}
      </div>

      <div className="hidden min-w-0 truncate text-sm text-neutral-400 sm:block">
        {showAlbum ? track.album ?? "Single" : showArtist ? track.artist : rightText ?? ""}
      </div>

      <div className="flex items-center justify-end gap-1">
        <span className="text-xs tabular-nums text-neutral-400">{formatOptionalDuration(track.durationSeconds)}</span>
      </div>
    </div>
  );
});

// JSON-encode the track for the right-click context menu's data-track
// attribute. We strip filePath/audioSrc because they're large and
// the menu never needs them. _labelOrigin is internal queue metadata
// that doesn't belong in the data attribute.
export function encodeTrackForContextMenu(track: MediaTrack): string {
  const { filePath: _filePath, audioSrc: _audioSrc, _labelOrigin: _lo, ...rest } = track;
  void _filePath;
  void _audioSrc;
  void _lo;
  return JSON.stringify(rest);
}

function PlayingBars() {
  return (
    <div className="flex h-4 w-4 items-end justify-center gap-[2px]">
      <span className="inline-block h-2 w-[3px] animate-[pulse_1.1s_ease-in-out_infinite] bg-white" />
      <span
        className="inline-block h-3 w-[3px] animate-[pulse_0.9s_ease-in-out_infinite] bg-white"
        style={{ animationDelay: "0.15s" }}
      />
      <span
        className="inline-block h-1.5 w-[3px] animate-[pulse_1.2s_ease-in-out_infinite] bg-white"
        style={{ animationDelay: "0.3s" }}
      />
    </div>
  );
}

export function Card({
  cover,
  title,
  subtitle,
  subtitleContent,
  onClick,
  onTitleClick,
  onPlay,
  type = "album",
  playing = false,
  playButtonSize = "md",
}: {
  cover?: string | null;
  title: string;
  subtitle?: string;
  subtitleContent?: ReactNode;
  onClick?: () => void;
  onTitleClick?: () => void;
  onPlay?: () => void;
  type?: "album" | "playlist" | "artist";
  playing?: boolean;
  playButtonSize?: "sm" | "md" | "lg";
}) {
  const rounded = getArtworkRoundedClass(type === "artist" ? "circle" : "square");
  const { buttonClass, iconSize } = cardPlayButtonSizing(playButtonSize);
  return (
    <div
      className="group cursor-pointer rounded-xl p-3 transition-colors hover:bg-neutral-900"
      onClick={onClick}
    >
      <div className={`relative aspect-square w-full overflow-hidden bg-neutral-800 shadow-md ${rounded}`}>
        {cover ? (
          <ArtworkImage src={cover} className="h-full w-full object-cover" />
        ) : (
          <DefaultArtwork />
        )}
        {onPlay && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
            className={`absolute bottom-2 right-2 flex ${buttonClass} items-center justify-center rounded-full bg-white text-black shadow-lg hover:scale-105 ${cardHoverPlayTransitionClass} ${cardHoverPlayRevealClass(playing)}`}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause size={iconSize} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={iconSize} fill="currentColor" strokeWidth={0} className="translate-x-[1.5px]" />
            )}
          </button>
        )}
      </div>
      <div className="mt-3 min-w-0">
        {onTitleClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTitleClick();
            }}
            className="block w-full text-left text-sm font-semibold text-neutral-100 transition hover:text-white/85 focus-visible:outline-none animate-none"
          >
            <Marquee className="text-sm font-semibold text-inherit">{title}</Marquee>
          </button>
        ) : (
          <Marquee className="text-sm font-semibold text-neutral-100">{title}</Marquee>
        )}
        {subtitleContent ??
          (subtitle ? <div className="mt-0.5 truncate text-xs text-neutral-400">{subtitle}</div> : null)}
      </div>
    </div>
  );
}

export function Section({
  title,
  action,
  children,
  subtitle,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  cover,
  coverShape = "square",
  meta,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string | null;
  cover?: string | null;
  coverShape?: "square" | "circle";
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const coverClass = getArtworkRoundedClass(coverShape === "circle" ? "circle" : "square");

  return (
    <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
      {cover && (
        <div className={`h-[var(--ui-art-lg)] w-[var(--ui-art-lg)] flex-shrink-0 overflow-hidden bg-neutral-800 shadow-lg ${coverClass}`}>
          <ArtworkImage src={cover} className="h-full w-full object-cover" />
        </div>
      )}
      <div className="flex flex-col justify-end">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <Music2 size={14} /> {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-sm text-neutral-400">{description}</p>}
        {meta && <div className="mt-4 text-sm text-neutral-300">{meta}</div>}
        {actions && <div className="mt-5 flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function PlayButton({
  onClick,
  playing,
  buffering,
}: {
  onClick?: () => void;
  playing?: boolean;
  buffering?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[var(--ui-control)] w-[var(--ui-control)] items-center justify-center rounded-full bg-white text-black shadow-lg transition hover:scale-105"
      aria-label="Play"
    >
      {buffering ? (
        <LoaderCircle size={18} className="animate-spin" />
      ) : playing ? (
        <Pause size={18} />
      ) : (
        <Play size={16} fill="currentColor" />
      )}
    </button>
  );
}

export function GhostButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
    >
      {children}
    </button>
  );
}

export function MoreButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-800 hover:text-white"
      aria-label="More"
    >
      <Ellipsis size={16} />
    </button>
  );
}

export function SavedIconBadge({ isSaved }: { isSaved: boolean }) {
  if (!isSaved) return null;
  return (
    <span className="inline-flex items-center justify-center text-[#1bd760]">
      <Check size={12} strokeWidth={2.5} />
    </span>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  secondaryLabel,
  onSecondary,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-xl border border-white/10 bg-black p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          {message}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700"
          >
            Cancel
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="rounded-lg border border-neutral-600 bg-transparent px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-400"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
