import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Ellipsis,
  List,
  LoaderCircle,
  Menu,
  Music2,
  Pause,
  Play,
} from "lucide-react";
import { getEntityDetail, peekEntityDetail } from "../api";
import { useCollection, type SavedAlbum } from "../collection";
import { usePlayer, type QueueOrigin } from "../player";
import { AlbumContextMenu } from "./AlbumContextMenu";
import { SaveButton } from "./SaveButton";
import { AnimatedShuffle } from "./PlayerButtonIcons";
import type { EntityDetail, MediaTrack } from "../types";
import { mixRgb, rgbToCss } from "../utils/artwork-color";
import { formatDuration, formatOptionalDuration, formatPlayCount } from "../utils/media";
import { ArtworkImage, MoreButton, TrackRow, encodeTrackForContextMenu } from "./Shared";
import { Marquee } from "./Marquee";
import {
  ALBUM_TRACK_GRID_WITH_PLAYS,
  COMPACT_TRACK_GRID,
  TrackListHeader,
} from "./TrackList";
import type { View } from "./Sidebar";
import {
  ArtistCreditText,
  ErrorPanel,
  LoadingPanel,
  useArtistCover,
  useArtworkAccent,
} from "./PagesShared";
import { getDirectArtistBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import { useSetting, setSetting, type ViewMode } from "../settings";

export function EntityPage({
  browseId,
  onPlayMany,
  onNavigate,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
  createPlaylistAndAddTracks,
}: {
  browseId: string;
  onPlayMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => void;
  onNavigate: (view: View) => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (browseId: string, tracks: MediaTrack[]) => Promise<void> | void;
  resolvePlaylists?: (
    query: string,
  ) => Promise<Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>>;
  createPlaylistAndAddTracks?: (
    tracks: MediaTrack[],
  ) => Promise<{ browseId: string; title: string } | void>;
}) {
  // Seed from the synchronous peek so a Back/Forward navigation to an
  // already-visited album/playlist renders its full content on the very
  // first paint, skipping the loading-panel flash the async `.then` would
  // otherwise produce. The effect below still re-fetches (and re-caches)
  // so a stale peek never traps the page in an outdated state.
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    data?: EntityDetail;
    error?: string;
  }>(() => {
    const cached = peekEntityDetail(browseId);
    if (cached) return { status: "ready", data: cached };
    return { status: "loading" };
  });

  useEffect(() => {
    let cancelled = false;
    if (!peekEntityDetail(browseId)) setState({ status: "loading" });

    getEntityDetail(browseId)
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", data });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Failed to load page.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [browseId]);

  if (state.status === "loading") return <LoadingPanel label="Loading release" />;
  if (state.status === "error") return <ErrorPanel message={state.error ?? "Failed to load page."} />;

  const detail = state.data;
  if (!detail) return <ErrorPanel message="No data available." />;

  if (detail.kind === "album") {
    return (
      <AlbumPage
        detail={detail}
        browseId={browseId}
        onPlayMany={onPlayMany}
        onNavigate={onNavigate}
        onAddAlbumToQueue={onAddAlbumToQueue}
        onAddAlbumToPlaylist={onAddAlbumToPlaylist}
        resolvePlaylists={resolvePlaylists}
        createPlaylistAndAddTracks={createPlaylistAndAddTracks}
      />
    );
  }

  return (
    <PlaylistPage
      detail={detail}
      browseId={browseId}
      onPlayMany={onPlayMany}
      onNavigate={onNavigate}
    />
  );
}

function PlaylistPage({
  detail,
  browseId,
  onPlayMany,
  onNavigate,
}: {
  detail: EntityDetail;
  browseId: string;
  onPlayMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => void;
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();
  const playlistOrigin = player.queueOrigin;
  const playlistBrowseId = browseId;
  const isPlaylistActive =
    playlistOrigin?.kind === "playlist" &&
    playlistOrigin.browseId === playlistBrowseId &&
    player.currentTrack?.albumBrowseId === playlistBrowseId;
  const isPlaylistPlaying = isPlaylistActive && player.isPlaying;
  const isPlaylistBuffering = isPlaylistActive && player.isBuffering;
  const playlistTracks = useMemo(
    () => detail.tracks.map((track) => ({ ...track, albumBrowseId: playlistBrowseId })),
    [playlistBrowseId, detail.tracks],
  );
  const accent = useArtworkAccent(detail.cover, playlistBrowseId);
  const totalSeconds = detail.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const heroTop = mixRgb(accent, { r: 0, g: 0, b: 0 }, 0.34);
  const controlTop = mixRgb(accent, { r: 0, g: 0, b: 0 }, 0.86);
  const playColor = mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.22);
  const trackCount = detail.tracks.length;
  const songLabel = `${trackCount} ${trackCount === 1 ? "song" : "songs"}`;

  const heroStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(heroTop, { r: 12, g: 12, b: 12 }, 0.25)),
  };
  const controlStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(controlTop, { r: 8, g: 8, b: 8 }, 0.2)),
  };

  const formatPlaylistMeta = () => {
    const parts: string[] = [songLabel];
    if (totalSeconds) parts.push(formatDuration(totalSeconds));
    return parts;
  };

  return (
    <div className="overflow-x-hidden bg-black pb-0">
      <section
        className="relative flex min-h-[clamp(17.75rem,26vw,22rem)] items-end px-[var(--ui-page-pad)] pb-[clamp(1.35rem,2.2vw,1.9rem)] pt-[calc(var(--ui-topbar-height)+clamp(0.75rem,1.5vw,1.25rem))]"
        style={heroStyle}
      >
        <div className="flex min-w-0 flex-col gap-[clamp(1.25rem,2vw,1.75rem)] md:flex-row md:items-end">
          <div className="h-[clamp(10rem,16.6vw,13.25rem)] w-[clamp(10rem,16.6vw,13.25rem)] shrink-0 overflow-hidden rounded-[4px] bg-neutral-900">
            {detail.cover ? (
              <ArtworkImage src={detail.cover} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-white/40">
                <Music2 size={34} />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 pb-1">
            <div className="mb-3 text-xs font-bold text-white">Playlist</div>
            <Marquee className="max-w-5xl text-[clamp(2rem,4.5vw,3.6rem)] font-bold leading-[1] text-white">
              {detail.title}
            </Marquee>

            <div className="mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm font-medium text-white/76">
              {detail.byline && (
                <span className="font-semibold text-white/90">{detail.byline}</span>
              )}
              {formatPlaylistMeta().map((part, partIndex) => (
                <span key={`${part}-${partIndex}`} className="flex items-center gap-1.5">
                  {(detail.byline || partIndex > 0) && <span className="text-white/50">•</span>}
                  <span>{part}</span>
                </span>
              ))}
            </div>

            {detail.description && (
              <div className="mt-2 text-sm text-white/50 line-clamp-2">{detail.description}</div>
            )}
          </div>
        </div>
      </section>

      <section
        className="px-[var(--ui-page-pad)] pb-[clamp(1rem,2vw,1.4rem)] pt-[clamp(1.1rem,2.2vw,1.6rem)] transition-opacity duration-150"
        style={controlStyle}
      >
        <div className="flex min-h-[3rem] flex-wrap items-center gap-4 sm:gap-5">
          <button
            type="button"
            onClick={
              isPlaylistActive
                ? player.togglePlay
                : () => void player.playMany(playlistTracks, 0, { kind: "playlist", browseId })
            }
            className="flex h-14 w-14 items-center justify-center rounded-full text-black transition hover:scale-[1.04] animate-none"
            style={{ backgroundColor: rgbToCss(playColor) }}
            aria-label={
              isPlaylistActive
                ? isPlaylistBuffering
                  ? "Loading"
                  : isPlaylistPlaying
                    ? "Pause playlist"
                    : "Resume playlist"
                : "Play playlist"
            }
          >
            {isPlaylistBuffering ? (
              <LoaderCircle size={26} className="animate-spin" />
            ) : isPlaylistPlaying ? (
              <Pause size={26} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={26} fill="currentColor" strokeWidth={0} />
            )}
          </button>

          <MoreButton />
        </div>
      </section>

      <section className="bg-black px-[var(--ui-page-pad)] pb-[clamp(2.5rem,3.125vw,4rem)] pt-[clamp(1.4rem,3vw,2.2rem)]">
        {playlistTracks.map((track, index) => (
          <TrackRow
            key={track.id}
            track={track}
            index={index}
            onPlay={() => onPlayMany(playlistTracks, index, { kind: "playlist", browseId })}
            showArtist
            showAlbum
            onNavigate={onNavigate}
            onNavigateToAlbum={
              track.albumBrowseId
                ? () => onNavigate({ name: "album", browseId: track.albumBrowseId!, context: "default" })
                : undefined
            }
            queueOrigin={{ kind: "playlist", browseId }}
          />
        ))}
      </section>
    </div>
  );
}

function AlbumPage({
  detail,
  browseId,
  onPlayMany,
  onNavigate,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
  createPlaylistAndAddTracks,
}: {
  detail: EntityDetail;
  browseId: string;
  onPlayMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => void;
  onNavigate: (view: View) => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (browseId: string, tracks: MediaTrack[]) => Promise<void> | void;
  resolvePlaylists?: (
    query: string,
  ) => Promise<Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>>;
  createPlaylistAndAddTracks?: (
    tracks: MediaTrack[],
  ) => Promise<{ browseId: string; title: string } | void>;
}) {
  const player = usePlayer();
  const collection = useCollection();
  const albumOrigin = player.queueOrigin;
  const albumBrowseId = browseId;
  const isAlbumActive =
    albumOrigin?.kind === "album" &&
    albumOrigin.browseId === albumBrowseId &&
    player.currentTrack?.albumBrowseId === albumBrowseId;
  const isAlbumPlaying = isAlbumActive && player.isPlaying;
  const isAlbumBuffering = isAlbumActive && player.isBuffering;
  const albumTracks = useMemo(
    () => detail.tracks.map((track) => ({ ...track, albumBrowseId })),
    [albumBrowseId, detail.tracks],
  );
  const accent = useArtworkAccent(detail.cover, albumBrowseId);
  const primaryArtistBrowseId =
    albumTracks.find((track) => track.artistBrowseId)?.artistBrowseId ?? null;
  const primaryArtistCredits = albumTracks[0]?.artistCredits ?? null;
  const artistThumb = useArtistCover(primaryArtistBrowseId);
  const handleResolveArtistName = useCallback((artistName: string) => {
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate]);
  const totalSeconds = albumTracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const heroTop = mixRgb(accent, { r: 0, g: 0, b: 0 }, 0.34);
  const controlTop = mixRgb(accent, { r: 0, g: 0, b: 0 }, 0.86);
  const playColor = mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.22);
  const baseMetaParts = detail.meta
    ? splitAlbumMeta(detail.meta)
    : [formatAlbumSummary(albumTracks.length, totalSeconds)];

  let releaseDate: string | undefined;
  let metaParts = baseMetaParts;

  if (baseMetaParts.length > 0 && /\b(19|20)\d{2}\b/.test(baseMetaParts[0])) {
    releaseDate = baseMetaParts[0];
    metaParts = baseMetaParts.slice(1);
  } else if (detail.subtitle) {
    const subParts = splitAlbumMeta(detail.subtitle);
    for (const part of subParts) {
      const m = /\b(19|20)\d{2}\b/.exec(part);
      if (m) {
        releaseDate = m[0];
        break;
      }
    }
  }
  const [firstTrackHovered, setFirstTrackHovered] = useState(false);
  const firstTrackActive = albumTracks[0] ? isTrackActive(player.currentTrack, albumTracks[0], { kind: "album", browseId }, player.queueOrigin) : false;
  const viewMode = useSetting("viewModeAlbum");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [ellipsisOpen, setEllipsisOpen] = useState(false);
  const [ellipsisPosition, setEllipsisPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const ellipsisButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewMenuScopeRef = useRef<HTMLDivElement | null>(null);
  const savedAlbum = useMemo<SavedAlbum>(() => entityToSavedAlbum(detail), [detail]);
  const isSingle = albumTracks.length === 1;
  const isReleaseSaved = isSingle
    ? (albumTracks[0]?.videoId
        ? collection.isSongSavedByVideo(albumTracks[0].videoId)
        : false)
    : collection.isAlbumSaved(browseId);

  useEffect(() => {
    setViewMenuOpen(false);
    setEllipsisOpen(false);
    setEllipsisPosition(undefined);
  }, [browseId]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || viewMenuScopeRef.current?.contains(target)) return;
      setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [viewMenuOpen]);

  const selectViewMode = (mode: ViewMode) => {
    setSetting("viewModeAlbum", mode);
    setViewMenuOpen(false);
  };

  const heroStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(heroTop, { r: 12, g: 12, b: 12 }, 0.25)),
  };
  const controlStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(controlTop, { r: 8, g: 8, b: 8 }, 0.2)),
  };

  return (
    <div className="overflow-x-hidden bg-black pb-0">
      <section
        className="relative flex min-h-[clamp(17.75rem,26vw,22rem)] items-end px-[var(--ui-page-pad)] pb-[clamp(1.35rem,2.2vw,1.9rem)] pt-[calc(var(--ui-topbar-height)+clamp(0.75rem,1.5vw,1.25rem))]"
        style={heroStyle}
      >
        <div className="flex min-w-0 flex-col gap-[clamp(1.25rem,2vw,1.75rem)] md:flex-row md:items-end">
          <div className="h-[clamp(10rem,16.6vw,13.25rem)] w-[clamp(10rem,16.6vw,13.25rem)] shrink-0 overflow-hidden rounded-[4px] bg-neutral-900">
            {detail.cover ? (
              <ArtworkImage src={detail.cover} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-white/40">
                <Music2 size={34} />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 pb-1">
            <div className="mb-3 text-xs font-bold text-white">
              {albumTracks.length === 1 ? "Single" : "Album"}
            </div>
            <Marquee speed={60} className="max-w-5xl text-[clamp(2rem,4.5vw,3.6rem)] font-bold leading-[1] text-white">
              {detail.title}
            </Marquee>

            <div className="mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm font-medium text-white/76">
              {detail.byline && (
                <div className="flex items-center gap-2">
                  {artistThumb && (
                    <div className="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/5">
                      <ArtworkImage src={artistThumb} className="h-full w-full object-cover" />
                    </div>
                  )}
                  <span className="font-semibold text-white/90">
                    <ArtistCreditText
                      artist={detail.byline}
                      artistBrowseId={primaryArtistBrowseId}
                      artistCredits={primaryArtistCredits}
                      context="default"
                      onNavigate={onNavigate}
                      onResolveArtistName={handleResolveArtistName}
                    />
                  </span>
                </div>
              )}
              {releaseDate && (
                <span className="flex items-center gap-1.5">
                  {detail.byline && <span className="text-white/50">•</span>}
                  <span>{releaseDate}</span>
                </span>
              )}
              {metaParts.map((part, partIndex) => (
                <span key={`${part}-${partIndex}`} className="flex items-center gap-1.5">
                  {(detail.byline || releaseDate || partIndex > 0) && <span className="text-white/50">•</span>}
                  <span>{part}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section
        className="px-[var(--ui-page-pad)] pb-[clamp(1rem,2vw,1.4rem)] pt-[clamp(1.1rem,2.2vw,1.6rem)] transition-opacity duration-150"
        style={controlStyle}
      >
        <div className="flex min-h-[3rem] flex-wrap items-center gap-4 sm:gap-5">
          <button
            type="button"
            onClick={
              isAlbumActive
                ? player.togglePlay
                : () => void player.playMany(albumTracks, 0, { kind: "album", browseId })
            }
            className="flex h-14 w-14 items-center justify-center rounded-full text-black transition hover:scale-[1.04] animate-none"
            style={{ backgroundColor: rgbToCss(playColor) }}
            aria-label={
              isAlbumActive
                ? isAlbumBuffering
                  ? "Loading"
                  : isAlbumPlaying
                    ? "Pause album"
                    : "Resume album"
                : "Play album"
            }
          >
            {isAlbumBuffering ? (
              <LoaderCircle size={26} className="animate-spin" />
            ) : isAlbumPlaying ? (
              <Pause size={26} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={26} fill="currentColor" strokeWidth={0} />
            )}
          </button>

          <button
            type="button"
            onClick={player.toggleShuffle}
            className={`flex h-10 w-10 items-center justify-center transition hover:text-white animate-none ${
              player.shuffle ? "text-white" : "text-white/56"
            }`}
            aria-label="Shuffle album"
          >
            <AnimatedShuffle active={player.shuffle} size={27} />
          </button>

          <SaveButton
            isSaved={isReleaseSaved}
            onToggle={() => {
              if (isSingle && albumTracks[0]) {
                collection.toggleSong(albumTracks[0]);
              } else {
                collection.toggleAlbum(savedAlbum);
              }
            }}
            ariaLabel={isReleaseSaved ? "Remove from collection" : `Save ${isSingle ? "song" : "album"} to collection`}
          />

          <button
            ref={ellipsisButtonRef}
            type="button"
            onClick={(e) => {
              if (!ellipsisOpen) {
                setEllipsisPosition({ x: e.clientX, y: e.clientY });
              }
              setEllipsisOpen((open) => !open);
            }}
            className="flex h-10 w-10 items-center justify-center text-white/60 transition hover:text-white animate-none"
            aria-label="More album options"
          >
            <Ellipsis size={27} />
          </button>

          <div ref={viewMenuScopeRef} className="ml-auto relative">
            <button
              type="button"
              onClick={() => setViewMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={viewMenuOpen}
              className="inline-flex min-h-10 items-center gap-2 px-3 py-2 text-left text-sm font-bold text-white/62 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 animate-none"
            >
              {viewMode === "list" ? "List" : "Compact"}
              {viewMode === "list" ? <List size={17} /> : <Menu size={17} />}
              <ChevronDown
                size={16}
                className={viewMenuOpen ? "rotate-180 transition" : "transition"}
              />
            </button>
            {viewMenuOpen && (
              <MenuPanel className="right-0 top-10 w-48">
                <MenuOption
                  label="List"
                  active={viewMode === "list"}
                  icon={<List size={17} />}
                  onClick={() => selectViewMode("list")}
                />
                <MenuOption
                  label="Compact"
                  active={viewMode === "compact"}
                  icon={<Menu size={17} />}
                  onClick={() => selectViewMode("compact")}
                />
              </MenuPanel>
            )}
          </div>
        </div>
      </section>

      <AlbumContextMenu
        open={ellipsisOpen}
        anchorRef={ellipsisButtonRef}
        position={ellipsisPosition}
        onClose={() => setEllipsisOpen(false)}
        album={savedAlbum}
        tracks={albumTracks}
        onAddAlbumToQueue={onAddAlbumToQueue}
        onAddAlbumToPlaylist={onAddAlbumToPlaylist}
        resolvePlaylists={resolvePlaylists}
        createPlaylistAndAddTracks={createPlaylistAndAddTracks}
      />

      <section className="bg-black px-[var(--ui-page-pad)] pb-[clamp(2.5rem,3.125vw,4rem)] pt-[clamp(1.4rem,3vw,2.2rem)]">
        {viewMode === "compact" ? (
          <TrackListHeader showPlays gridClassName={COMPACT_TRACK_GRID} dividerHidden={firstTrackHovered || firstTrackActive} />
        ) : (
          <TrackListHeader showPlays dividerHidden={firstTrackHovered || firstTrackActive} />
        )}

        <div>
          {albumTracks.map((track, index) =>
            viewMode === "compact" ? (
              <CompactTrackRow
                key={track.id}
                track={track}
                index={index}
                playColor={playColor}
                onPlay={() => onPlayMany(albumTracks, index, { kind: "album", browseId })}
                onHoverChange={index === 0 ? setFirstTrackHovered : undefined}
                queueOrigin={{ kind: "album", browseId }}
              />
            ) : (
              <AlbumTrackRow
                key={track.id}
                track={track}
                index={index}
                playColor={playColor}
                onPlay={() => onPlayMany(albumTracks, index, { kind: "album", browseId })}
                onNavigate={onNavigate}
                onHoverChange={index === 0 ? setFirstTrackHovered : undefined}
                queueOrigin={{ kind: "album", browseId }}
                parentIsSaved={isSingle ? isReleaseSaved : undefined}
              />
            ),
          )}
        </div>
      </section>
    </div>
  );
}

function isTrackActive(
  currentTrack: MediaTrack | null,
  track: MediaTrack,
  contextOrigin?: QueueOrigin | null,
  activeOrigin?: QueueOrigin | null,
): boolean {
  if (!currentTrack) return false;
  if (
    currentTrack.videoId && track.videoId
      ? currentTrack.videoId !== track.videoId
      : currentTrack.id !== track.id
  ) return false;
  if (contextOrigin) {
    if (!activeOrigin) return false;
    if (contextOrigin.kind !== activeOrigin.kind) return false;
    if ("browseId" in contextOrigin && "browseId" in activeOrigin) {
      return contextOrigin.browseId === activeOrigin.browseId;
    }
    if ("id" in contextOrigin && "id" in activeOrigin) {
      return contextOrigin.id === activeOrigin.id;
    }
  }
  return true;
}

function AlbumTrackRow({
  track,
  index,
  playColor,
  onPlay,
  onNavigate,
  onHoverChange,
  queueOrigin,
  parentIsSaved,
}: {
  track: MediaTrack;
  index: number;
  playColor: { r: number; g: number; b: number };
  onPlay: () => void;
  onNavigate: (view: View) => void;
  onHoverChange?: (hovered: boolean) => void;
  queueOrigin?: QueueOrigin | null;
  parentIsSaved?: boolean;
}) {
  const player = usePlayer();
  const collection = useCollection();
  const active = isTrackActive(player.currentTrack, track, queueOrigin, player.queueOrigin);
  const playingActive = active && player.isPlaying;
  const bufferingActive = active && player.isBuffering;
  const contextPayload = useMemo(() => encodeTrackForContextMenu(track), [track]);
  const isSaved = parentIsSaved ?? collection.isSongSaved(track.id);
  const directArtistBrowseId = getDirectArtistBrowseId(track);
  const handleResolveNavigate = useCallback(() => {
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);
  const handleResolveArtistName = useCallback((artistName: string) => {
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate]);

  return (
    <div
      data-song-context-target="true"
      data-track={contextPayload}
      data-track-source={track.source ?? "stream"}
      className={`group grid cursor-pointer ${ALBUM_TRACK_GRID_WITH_PLAYS} gap-3 rounded-lg px-4 py-2 transition-colors ${
        active ? "bg-white/[0.04]" : "hover:bg-neutral-900"
      }`}
      onClick={active ? player.togglePlay : onPlay}
      onContextMenu={(event) => {
        // Right-click should still trigger our custom menu, but the row's
        // primary click handler also opens playback. Stop propagation so the
        // synthetic onClick from the contextmenu key (Enter on Mac) doesn't
        // accidentally fire the play action.
        event.stopPropagation();
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="relative flex items-center justify-center">
        <span
          className={`text-sm tabular-nums transition-opacity ${
            active ? "text-white/78 opacity-0" : "text-white/42 group-hover:opacity-0"
          }`}
        >
          {index + 1}
        </span>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? player.togglePlay : onPlay)();
          }}
          className={`absolute flex h-7 w-7 items-center justify-center text-white animate-none ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={playingActive ? "Pause track" : "Play track"}
        >
          {bufferingActive ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : playingActive ? (
            <Pause size={16} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={14} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2 py-0.5">
        <div className="min-w-0 overflow-hidden">
          <div
            className={`truncate text-[15px] font-semibold ${active ? "" : "text-white/92"}`}
            style={active ? { color: rgbToCss(playColor) } : undefined}
          >
            {track.title}
          </div>
          <div className="mt-1 min-w-0 truncate text-sm text-white/46">
            <ArtistCreditText
              artist={track.artist}
              artistBrowseId={track.artistBrowseId}
              artistCredits={track.artistCredits}
              context="default"
              onNavigate={onNavigate}
              onResolveNavigate={directArtistBrowseId ? null : handleResolveNavigate}
              onResolveArtistName={handleResolveArtistName}
            />
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
              onToggle={() => collection.toggleSong(track)}
              ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
            />
          </div>
        )}
      </div>

      <div className="self-center text-center text-sm tabular-nums text-white/48">
        {formatPlayCount(track.playCount)}
      </div>

      <div className="flex items-center justify-end text-sm tabular-nums text-white/48">
        {formatOptionalDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

function splitAlbumMeta(meta: string): string[] {
  return meta
    .replace(/\u00e2\u20ac\u00a2/g, "\u2022")
    .replace(/\u00c2\u00b7/g, "\u00b7")
    .split(/[\u2022\u00b7]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function CompactTrackRow({
  track,
  index,
  playColor,
  onPlay,
  onHoverChange,
  queueOrigin,
}: {
  track: MediaTrack;
  index: number;
  playColor: { r: number; g: number; b: number };
  onPlay: () => void;
  onHoverChange?: (hovered: boolean) => void;
  queueOrigin?: QueueOrigin | null;
}) {
  const player = usePlayer();
  const active = isTrackActive(player.currentTrack, track, queueOrigin, player.queueOrigin);
  const playingActive = active && player.isPlaying;
  const bufferingActive = active && player.isBuffering;
  const contextPayload = useMemo(() => encodeTrackForContextMenu(track), [track]);

  return (
    <div
      data-song-context-target="true"
      data-track={contextPayload}
      data-track-source={track.source ?? "stream"}
      className={`group grid cursor-pointer ${COMPACT_TRACK_GRID} gap-3 rounded-lg px-4 py-1.5 transition-colors ${
        active ? "bg-white/[0.04]" : "hover:bg-neutral-900"
      }`}
      onClick={active ? player.togglePlay : onPlay}
      onContextMenu={(event) => {
        // Right-click must surface our custom menu, but the row's primary
        // click handler also opens playback. Stop propagation so the
        // synthetic onClick from the contextmenu key (Enter on Mac) doesn't
        // accidentally fire the play action.
        event.stopPropagation();
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="relative flex items-center justify-center">
        <span
          className={`text-sm tabular-nums transition-opacity ${
            active ? "text-white/78 opacity-0" : "text-white/42 group-hover:opacity-0"
          }`}
        >
          {index + 1}
        </span>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? player.togglePlay : onPlay)();
          }}
          className={`absolute flex h-7 w-7 items-center justify-center text-white animate-none ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          aria-label={playingActive ? "Pause track" : "Play track"}
        >
          {bufferingActive ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : playingActive ? (
            <Pause size={16} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={14} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </div>

      <div className="min-w-0 self-center">
        <div
          className={`truncate text-[15px] font-semibold ${active ? "" : "text-white/92"}`}
          style={active ? { color: rgbToCss(playColor) } : undefined}
        >
          {track.title}
        </div>
      </div>

      <div className="flex items-center justify-center text-sm tabular-nums text-white/50">
        {formatPlayCount(track.playCount)}
      </div>

      <div className="flex items-center justify-end text-sm tabular-nums text-white/48">
        {formatOptionalDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

function MenuPanel({ children, className }: { children: ReactNode; className: string }) {
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
  icon?: ReactNode;
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

function formatAlbumSummary(trackCount: number, totalSeconds: number): string {
  const songLabel = `${trackCount} ${trackCount === 1 ? "song" : "songs"}`;
  if (!totalSeconds) return songLabel;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${songLabel}, ${hours} hr ${minutes} min`;
  }

  return `${songLabel}, ${minutes} min ${seconds} sec`;
}

function entityToSavedAlbum(detail: EntityDetail): SavedAlbum {
  const yearMatch = /\b(19|20)\d{2}\b/.exec(detail.meta ?? "");
  const artistBrowseId = detail.tracks.find((t) => t.artistBrowseId)?.artistBrowseId ?? null;
  return {
    browseId: detail.browseId,
    title: detail.title,
    subtitle: detail.subtitle ?? "",
    cover: detail.cover ?? null,
    byline: detail.byline ?? null,
    year: yearMatch?.[0] ?? null,
    artistBrowseId,
  };
}
