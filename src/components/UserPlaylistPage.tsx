import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  Ellipsis,
  List,
  LoaderCircle,
  Menu,
  Pause,
  Pencil,
  Play,
} from "lucide-react";
import { CoverImageCropper } from "./CoverImageCropper";
import {
  PLAYLIST_TRACK_GRID,
  TrackListHeader,
} from "./TrackList";
import { DefaultArtwork, ConfirmDialog, encodeTrackForContextMenu } from "./Shared";
import { PlaylistContextMenu } from "./PlaylistContextMenu";
import { SaveButton } from "./SaveButton";
import { useCollection } from "../collection";
import { Marquee } from "./Marquee";
import { usePlaylists, DESCRIPTION_MAX_LENGTH, PLAYLIST_TITLE_MAX_LENGTH } from "../playlists";
import { usePlayer, type QueueOrigin } from "../player";
import type { MediaTrack } from "../types";
import { ArtistCreditText, useArtworkAccent } from "./PagesShared";
import { formatOptionalDuration, withResolvedAudioSrc } from "../utils/media";
import { mixRgb, rgbToCss } from "../utils/artwork-color";
import type { View } from "./Sidebar";
import { getDirectArtistBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import { AnimatedShuffle } from "./PlayerButtonIcons";
import { useSetting, setSetting } from "../settings";

// ---------------------------------------------------------------------------
// UserPlaylistPage
//
// A "custom album" page for user-created playlists. Mirrors AlbumPage's
// layout and behavior closely enough that the same right-click / queue /
// save / more / view-mode (list vs. compact) affordances all work without
// special casing. The only differences:
//
//   * Banner background — uses `DEFAULT_ALBUM_ACCENT` (grey) as the
//     fallback. Once the user uploads a cover the banner picks up an
//     extracted accent via `useArtworkAccent`, so the whole banner tints
//     with the cover's dominant color. We deliberately DON'T seed the
//     accent into a fallback color of an album-shaped hue when there's
//     no cover — that keeps an empty playlist visually empty.
//   * Cover thumbnail — uses `DefaultArtwork` (the Velocity icon) until
//     the user uploads their own image. Clicking opens the OS file
//     picker. We downscale uploaded images via canvas (max 480px,
//     quality 0.7 JPEG) before storing the base64 data URL — keeping
//     the localStorage impact of each cover around 10-30 KB instead of
//     the 1-2 MB a raw photo would be.
//   * Title + description — the album page reads these from the entity
//     detail; user playlists instead carry an in-memory editable copy
//     rendered as transparent inline `<input>` / `<textarea>` controls
//     inside the banner. Same visual treatment as the Local song
//     importing menu's row text fields, so the page reads as a
//     continuous "edit me" surface instead of an ABM detail page.
//   * More menu — replaces "Save to collection" with "Delete playlist"
//     (the user owns the playlist; the only destructive action worth
//     surfacing is dropping it). Also keeps Shuffle, View, and the
//     shared add-to-queue action so this still feels like an album.
// ---------------------------------------------------------------------------

// `StorageQuotaExceededError` thresholds vary by browser but every browser
// in 2024 enforces a ~5 MB per-origin budget. 4 MB is a conservative
// pre-downscale limit so the canvas pipeline still has room to land well
// under quota.
const COVER_INPUT_MAX_BYTES = 4 * 1024 * 1024;

export function UserPlaylistPage({
  playlistId,
  onPlayMany,
  onNavigate,
  onAddAlbumToQueue,
  onDeletePlaylist,
  onTogglePinPlaylist,
}: {
  playlistId: string;
  onPlayMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => void;
  onNavigate: (view: View) => void;
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onDeletePlaylist?: (id: string) => void;
  onTogglePinPlaylist?: (id: string) => void;
}) {
  const playlistsCtx = usePlaylists();
  const playlist = playlistsCtx.getPlaylist(playlistId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset transient UI when navigating between two user playlists. Without
  // this regression, leaving playlist A's page for playlist B would keep
  // the old ellipsis-open state from A on first paint, which
  // mousetraps the new page user since the previously-open ellipsis panel
  // has no anchor in B's DOM.
  useEffect(() => {
    setViewMenuOpen(false);
    setEllipsisOpen(false);
    setEllipsisPosition(undefined);
  }, [playlistId]);

  // Tracks are stored across the full media-track shape so the row layout
  // and play-many path both have everything they need without re-hydrating
  // anything. Upload tracks need their `asset://` audio URL rebuilt on
  // session restore; map them through `withResolvedAudioSrc` lazily on
  // read so a freshly-restarted app can still play its locally-uploaded
  // tracks from a playlist (the provider stored just the filePath in
  // localStorage, not the asset URL).
  const tracks = useMemo<MediaTrack[]>(
    () => (playlist?.tracks ?? []).map(withResolvedAudioSrc),
    [playlist?.tracks],
  );

  const accent = useArtworkAccent(playlist?.cover ?? null, `${playlistId}:${playlist?.cover ?? "default"}`);

  const totalSeconds = tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const trackCount = tracks.length;
  const hasTracks = trackCount > 0;

  const player = usePlayer();
  const queueOrigin = player.queueOrigin;
  const playlistOrigin: QueueOrigin | null = playlist
    ? { kind: "user-playlist", id: playlist.id, name: playlist.title }
    : null;
  const currentTrackInPlaylist = useMemo(() => {
    if (!player.currentTrack || !tracks.length) return false;
    return tracks.some((t) =>
      t.videoId && player.currentTrack!.videoId
        ? t.videoId === player.currentTrack!.videoId
        : t.id === player.currentTrack!.id,
    );
  }, [player.currentTrack, tracks]);
  const isPlaylistActive = Boolean(
    playlist &&
      queueOrigin?.kind === "user-playlist" &&
      queueOrigin.id === playlist.id &&
      currentTrackInPlaylist,
  );
  const isPlaylistPlaying = isPlaylistActive && player.isPlaying;
  const isPlaylistBuffering = isPlaylistActive && player.isBuffering;

  const viewMode = useSetting("viewModePlaylist");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [ellipsisOpen, setEllipsisOpen] = useState(false);
  const [ellipsisPosition, setEllipsisPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  const ellipsisButtonRef = useRef<HTMLButtonElement | null>(null);
  const ellipsisMenuRef = useRef<HTMLDivElement | null>(null);
  const viewMenuScopeRef = useRef<HTMLDivElement | null>(null);

  // ── Click-outside dismissal for the two inline popovers ──────────
  //
  // Both the View menu (List / Compact) and the ellipsis More menu
  // close on outside pointerdown. We attach a single document listener
  // while either is open and bail on the listener cleanup when both
  // close — keeps the effect cost bounded to "open menu" lifetimes.
  useEffect(() => {
    if (!viewMenuOpen && !ellipsisOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (viewMenuOpen && viewMenuScopeRef.current?.contains(target)) return;
      if (ellipsisOpen && ellipsisMenuRef.current?.contains(target)) return;
      if (ellipsisOpen && ellipsisButtonRef.current?.contains(target)) return;
      setViewMenuOpen(false);
      setEllipsisOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [viewMenuOpen, ellipsisOpen]);

  const handleCoverClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Read the picked file, downscale via canvas to a JPEG thumb, then
  // hand the resulting data URL to the playlist store. Catches:
  //   * non-image selections (the `accept` filter is a hint, not a
  //     guarantee — some pickers let users bypass it);
  //   * quota-exceeded errors from `updatePlaylist`'s persist pass;
  //   * canvas tainting from CORS — we read the file via createObjectURL
  //     and revoke the URL on load, and the file picker is OS-native
  //     so any cross-origin fetch rule doesn't apply.
  const handleCoverFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input value so picking the same file twice still fires.
      event.target.value = "";
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setCoverError("Cover must be an image file.");
        return;
      }
      if (file.size > COVER_INPUT_MAX_BYTES) {
        setCoverError("Cover file is too large (max 4 MB).");
        return;
      }
      setCoverError(null);
      setPendingCoverFile(file);
    },
    [playlist, playlistsCtx],
  );

  const handlePlayClick = useCallback(() => {
    if (!hasTracks) return;
    if (isPlaylistActive) {
      player.togglePlay();
      return;
    }
    void player.playMany(tracks, 0, playlistOrigin ?? undefined);
  }, [hasTracks, isPlaylistActive, player, playlistOrigin, tracks]);

  const handleDeleteClick = useCallback(() => {
    if (!playlist) return;
    setEllipsisOpen(false);
    setShowDeleteConfirm(true);
  }, [playlist]);

  const handleTogglePinClick = useCallback(() => {
    if (!playlist) return;
    onTogglePinPlaylist?.(playlist.id);
    setEllipsisOpen(false);
  }, [playlist, onTogglePinPlaylist]);

  const handleConfirmDelete = useCallback(() => {
    if (!playlist) return;
    setShowDeleteConfirm(false);
    if (onDeletePlaylist) {
      onDeletePlaylist(playlist.id);
    } else {
      playlistsCtx.deletePlaylist(playlist.id);
    }
  }, [playlist, playlistsCtx, onDeletePlaylist]);

  const handleShuffleClick = player.toggleShuffle;

  const handleTrackPlay = useCallback(
    (index: number) => {
      if (!hasTracks) return;
      onPlayMany(tracks, index, playlistOrigin ?? undefined);
    },
    [hasTracks, onPlayMany, playlistOrigin, tracks],
  );

  const controlTop = mixRgb(accent, { r: 0, g: 0, b: 0 }, 0.86);
  const playColor = mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.22);
  const controlStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(controlTop, { r: 8, g: 8, b: 8 }, 0.2)),
  };
  const [firstTrackHovered, setFirstTrackHovered] = useState(false);
  const firstTrackActive = useMemo(() => {
    const first = tracks[0];
    if (!first || !player.currentTrack || !playlist) return false;
    return player.currentTrack.id === first.id && (
      !playlistOrigin ||
      (player.queueOrigin?.kind === "user-playlist" && player.queueOrigin.id === playlist.id)
    );
  }, [player.currentTrack, player.queueOrigin, tracks, playlistOrigin, playlist]);

  if (!playlist) {
    return (
      <div className="pt-[var(--ui-topbar-height)] px-[var(--ui-page-pad)] pb-12">
        <div className="mx-auto max-w-[var(--ui-content-max)]">
          <EmptyPlaylistState />
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-hidden bg-black pb-0">
      <PlaylistHero
        playlist={playlist}
        accent={accent}
        onTitleChange={(title) =>
          playlistsCtx.updatePlaylist(playlist.id, { title })
        }
        onDescriptionChange={(description) =>
          playlistsCtx.updatePlaylist(playlist.id, { description })
        }
        onCoverClick={handleCoverClick}
        trackCount={trackCount}
        totalSeconds={totalSeconds}
        coverError={coverError}
      />

      <section
        className="px-[var(--ui-page-pad)] pb-[clamp(1rem,2vw,1.4rem)] pt-[clamp(1.1rem,2.2vw,1.6rem)] transition-opacity duration-150"
        style={controlStyle}
      >
        <div className="flex min-h-[3rem] flex-wrap items-center gap-4 sm:gap-5">
          <button
            type="button"
            onClick={handlePlayClick}
            disabled={!hasTracks}
            aria-label={
              isPlaylistBuffering
                ? "Loading"
                : isPlaylistActive
                  ? isPlaylistPlaying
                    ? "Pause playlist"
                    : "Resume playlist"
                  : "Play playlist"
            }
            className="flex h-14 w-14 items-center justify-center rounded-full text-black transition hover:scale-[1.04] disabled:opacity-40 disabled:hover:scale-100 animate-none"
            style={{ backgroundColor: rgbToCss(playColor) }}
          >
            {isPlaylistBuffering ? (
              <LoaderCircle size={26} className="animate-spin" />
            ) : isPlaylistPlaying ? (
              <Pause size={26} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={26} fill="currentColor" strokeWidth={0} />
            )}
          </button>

          <button
            type="button"
            onClick={handleShuffleClick}
            className={`flex h-10 w-10 items-center justify-center transition hover:text-white animate-none ${
              player.shuffle ? "text-white" : "text-white/56"
            }`}
            aria-label="Shuffle playlist"
          >
            <AnimatedShuffle active={player.shuffle} size={27} />
          </button>

          <button
            ref={ellipsisButtonRef}
            type="button"
            onClick={(event) => {
              if (!ellipsisOpen) {
                setEllipsisPosition({ x: event.clientX, y: event.clientY });
              }
              setEllipsisOpen((open) => !open);
            }}
            className="flex h-10 w-10 items-center justify-center text-white/60 transition hover:text-white -ml-1 animate-none"
            aria-label="More playlist options"
            aria-haspopup="menu"
            aria-expanded={ellipsisOpen}
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
                  onClick={() => {
                    setSetting("viewModePlaylist", "list");
                    setViewMenuOpen(false);
                  }}
                />
                <MenuOption
                  label="Compact"
                  active={viewMode === "compact"}
                  icon={<Menu size={17} />}
                  onClick={() => {
                    setSetting("viewModePlaylist", "compact");
                    setViewMenuOpen(false);
                  }}
                />
              </MenuPanel>
            )}
          </div>
        </div>
      </section>

      {ellipsisOpen && (
        <PlaylistContextMenu
          menuRef={ellipsisMenuRef}
          position={ellipsisPosition}
          pinned={playlist.pinned ?? false}
          onTogglePin={handleTogglePinClick}
          onDelete={handleDeleteClick}
          playlist={playlist}
        />
      )}

      <section className="bg-black px-[var(--ui-page-pad)] pb-[clamp(2.5rem,3.125vw,4rem)] pt-[clamp(1.4rem,3vw,2.2rem)]">
        <TrackListHeader showAlbum showDateAdded dividerHidden={firstTrackHovered || firstTrackActive} />

        {tracks.length === 0 ? (
          <EmptyPlaylistTracksState onAddToQueue={onAddAlbumToQueue} />
        ) : (
          <div>
            {tracks.map((track, index) =>
              viewMode === "compact" ? (
                <CompactTrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  playColor={playColor}
                  onPlay={() => handleTrackPlay(index)}
                  onNavigateToAlbum={
                    track.albumBrowseId
                      ? () =>
                          onNavigate({
                            name: "album",
                            browseId: track.albumBrowseId!,
                            context: "default",
                          })
                      : undefined
                  }
                  onHoverChange={index === 0 ? setFirstTrackHovered : undefined}
                  queueOrigin={playlistOrigin}
                />
              ) : (
                <AlbumTrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  playColor={playColor}
                  onPlay={() => handleTrackPlay(index)}
                  onNavigate={onNavigate}
                  onNavigateToAlbum={
                    track.albumBrowseId
                      ? () =>
                          onNavigate({
                            name: "album",
                            browseId: track.albumBrowseId!,
                            context: "default",
                          })
                      : undefined
                  }
                  onHoverChange={index === 0 ? setFirstTrackHovered : undefined}
                  queueOrigin={playlistOrigin}
                />
              ),
            )}
          </div>
        )}
      </section>

      {/* Hidden image picker — the cover button uses its `htmlFor`-less
         label-input pattern but in this case the button is a plain
         `<button>`, so the input has to be hidden and referenced by
         ref. The input is positioned offscreen + opacity 0 so it still
         receives focus when keyboard-navigated to via the button's
         `aria-label`. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only h-0 w-0 opacity-0"
        onChange={(event) => {
          void handleCoverFile(event);
        }}
        aria-hidden
        tabIndex={-1}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        title={`Delete playlist "${playlist.title}"?`}
        message="This action cannot be undone. The playlist and all its tracks will be permanently removed."
        confirmLabel="Delete playlist"
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {pendingCoverFile && (
        <CoverImageCropper
          file={pendingCoverFile}
          onConfirm={(dataUrl) => {
            setPendingCoverFile(null);
            playlistsCtx.updatePlaylist(playlist.id, { cover: dataUrl });
          }}
          onCancel={() => setPendingCoverFile(null)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Hero — banner with editable title, editable description, clickable cover
// ===========================================================================

function PlaylistHero({
  playlist,
  accent: _accent,
  onTitleChange,
  onDescriptionChange,
  onCoverClick,
  trackCount,
  totalSeconds,
  coverError,
}: {
  playlist: { id: string; title: string; description: string; cover: string | null };
  accent: { r: number; g: number; b: number };
  onTitleChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onCoverClick: () => void;
  trackCount: number;
  totalSeconds: number;
  coverError: string | null;
}) {
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const heroTop = mixRgb(_accent, { r: 0, g: 0, b: 0 }, 0.34);
  const heroStyle: CSSProperties = {
    backgroundColor: rgbToCss(mixRgb(heroTop, { r: 12, g: 12, b: 12 }, 0.25)),
  };

  // Auto-resize the description textarea to fit its content so multi-line
  // descriptions don't scroll within the box. The reset-to-auto-then-set
  // dance trims any height leftover from a prior longer value when the
  // user clears their description.
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [playlist.description]);

  const summaryParts = formatPlaylistSummary(trackCount, totalSeconds);

  return (
    <section
      className="relative flex min-h-[clamp(17.75rem,26vw,22rem)] items-end px-[var(--ui-page-pad)] pb-[clamp(1.35rem,2.2vw,1.9rem)] pt-[calc(var(--ui-topbar-height)+clamp(0.75rem,1.5vw,1.25rem))]"
      style={heroStyle}
    >
      <div className="flex min-w-0 flex-col gap-[clamp(1.25rem,2vw,1.75rem)] md:flex-row md:items-end">
        <PlaylistCoverButton
          playlistId={playlist.id}
          cover={playlist.cover}
          onClick={onCoverClick}
        />

        <div className="min-w-0 flex-1 pb-1">
          <div className="mb-3 text-xs font-bold text-white">Playlist</div>

          {/* Editable title. Same inline-edit pattern as the Local song
             importing menu's title field: no border, no bg, no padding
             offset, no focus highlight. Hovering lifts an otherwise
             invisible caret-less state so users know they can click it. */}
          <input
            value={playlist.title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Playlist name"
            aria-label="Playlist name"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            maxLength={PLAYLIST_TITLE_MAX_LENGTH}
            className="user-playlist-title-input bg-transparent text-[clamp(2.5rem,5.2vw,4.4rem)] font-bold leading-[1] text-white caret-white outline-none placeholder:text-white/24 hover:placeholder:text-white/40 focus:placeholder:text-white/30"
          />

          {/* Editable description. Auto-grows to fit content. Up to 2
             lines of placeholder text are visually understated the same
             way the title caret is — only the focus ring sticks around
             so a brief flash on click surfaces the interactive area
             without polluting idle frames. The textarea's
             `rows={1}` is the native minimum; useLayoutEffect overrides
             it on every value change to expand to scrollHeight. */}
          <div className="mt-3 max-w-2xl">
            <textarea
              ref={descriptionRef}
              value={playlist.description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                }
              }}
              placeholder="Add an optional description"
              aria-label="Playlist description"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              rows={1}
              maxLength={DESCRIPTION_MAX_LENGTH}
              className="user-playlist-description-input block w-full resize-none bg-transparent text-white/64 caret-white outline-none placeholder:text-white/32 hover:placeholder:text-white/48 focus:placeholder:text-white/40"
            />
          </div>

          <div className="mt-5 flex items-center gap-1.5 text-sm font-medium text-white/76">
            {summaryParts.map((part, partIndex) => (
              <span key={partIndex} className="flex items-center gap-1.5">
                {partIndex > 0 && <span className="text-white/50">•</span>}
                <span>{part}</span>
              </span>
            ))}
          </div>
          {coverError && (
            <div className="mt-3 text-xs font-semibold text-red-300">{coverError}</div>
          )}
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Cover button — clickable square with hover tint + pencil/icon overlay
// ===========================================================================

function PlaylistCoverButton({
  playlistId: _playlistId,
  cover,
  onClick,
}: {
  playlistId: string;
  cover: string | null;
  onClick: () => void;
}) {
  // The button keeps its native semantics (Enter / Space activation,
  // focus ring, aria-label) so a screen-reader user can both trigger the
  // file picker AND hear "Change playlist cover". The actual <input> is
  // a separate hidden element forwarded to via `fileInputRef` from the
  // parent — clicking the button imperatively clicks the input.
  //
  // Hover treatment: a black/55 layer + a centered Pencil glyph fades
  // in. We only animate the overlay (not the underlying image) so it
  // doesn't disturb the homepage-banneer's pre-existing accent tint.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Change playlist cover"
      className="user-playlist-cover-button group relative h-[clamp(10rem,16.6vw,13.25rem)] w-[clamp(10rem,16.6vw,13.25rem)] shrink-0 overflow-hidden rounded-[4px] bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 animate-none"
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          className="block h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <DefaultArtwork />
      )}
      <span
        aria-hidden="true"
        className="user-playlist-cover-overlay pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Pencil size={36} strokeWidth={1.6} className="text-white" />
      </span>
    </button>
  );
}

// ===========================================================================
// Track rows — list and compact variants matching the album page styling
// ===========================================================================

function AlbumTrackRow({
  track,
  index,
  playColor,
  onPlay,
  onNavigate,
  onNavigateToAlbum,
  onHoverChange,
  queueOrigin,
}: {
  track: MediaTrack;
  index: number;
  playColor: { r: number; g: number; b: number };
  onPlay: () => void;
  onNavigate?: (view: View) => void;
  onNavigateToAlbum?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  queueOrigin?: QueueOrigin | null;
}) {
  const player = usePlayer();
  const collection = useCollection();
  const active = (
    player.currentTrack?.videoId && track.videoId
      ? player.currentTrack.videoId === track.videoId
      : player.currentTrack?.id === track.id
  ) && (
    !queueOrigin ||
    (player.queueOrigin?.kind === "user-playlist" && player.queueOrigin.id === (queueOrigin as { kind: "user-playlist"; id: string }).id)
  );
  const playingActive = active && player.isPlaying;
  const bufferingActive = active && player.isBuffering;
  const contextPayload = useMemo(() => encodeTrackForContextMenu(track), [track]);
  const isSaved = collection.isSongSaved(track.id);
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
      data-song-context-target="true"
      data-track={contextPayload}
      data-track-source={track.source ?? "stream"}
      className={`group grid cursor-pointer ${PLAYLIST_TRACK_GRID} gap-3 rounded-lg px-4 py-2 transition-colors animate-none ${
        active ? "bg-white/[0.04]" : "hover:bg-neutral-900"
      }`}
      onClick={active ? player.togglePlay : onPlay}
      onContextMenu={(event) => {
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
          <Marquee
            className={`text-[15px] font-semibold ${active ? "" : "text-white/92"}`}
          >
            <span style={active ? { color: rgbToCss(playColor) } : undefined}>
              {track.title}
            </span>
          </Marquee>
          <div className="mt-1 min-w-0 text-sm text-white/46">
            <Marquee>
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
              ) : (
                track.artist
              )}
            </Marquee>
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

      <div className="min-w-0 self-center text-sm text-white/48">
        {onNavigateToAlbum && track.album ? (
          <Marquee>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToAlbum();
              }}
              className="transition hover:text-white/95 focus-visible:outline-none animate-none"
            >
              {track.album}
            </button>
          </Marquee>
        ) : (
          <Marquee>
            <span>{track.album || "—"}</span>
          </Marquee>
        )}
      </div>

      <div className="self-center text-sm tabular-nums text-white/48">
        {formatDateAdded(track.dateAdded)}
      </div>

      <div className="flex items-center justify-end text-sm tabular-nums text-white/48">
        {formatOptionalDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

function CompactTrackRow({
  track,
  index,
  playColor,
  onPlay,
  onNavigateToAlbum,
  onHoverChange,
  queueOrigin,
}: {
  track: MediaTrack;
  index: number;
  playColor: { r: number; g: number; b: number };
  onPlay: () => void;
  onNavigateToAlbum?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  queueOrigin?: QueueOrigin | null;
}) {
  const player = usePlayer();
  const active = (
    player.currentTrack?.videoId && track.videoId
      ? player.currentTrack.videoId === track.videoId
      : player.currentTrack?.id === track.id
  ) && (
    !queueOrigin ||
    (player.queueOrigin?.kind === "user-playlist" && player.queueOrigin.id === (queueOrigin as { kind: "user-playlist"; id: string }).id)
  );
  const playingActive = active && player.isPlaying;
  const bufferingActive = active && player.isBuffering;
  const contextPayload = useMemo(() => encodeTrackForContextMenu(track), [track]);

  return (
    <div
      data-song-context-target="true"
      data-track={contextPayload}
      data-track-source={track.source ?? "stream"}
      className={`group grid cursor-pointer ${PLAYLIST_TRACK_GRID} gap-3 rounded-lg px-4 py-1.5 transition-colors animate-none ${
        active ? "bg-white/[0.04]" : "hover:bg-neutral-900"
      }`}
      onClick={active ? player.togglePlay : onPlay}
      onContextMenu={(event) => {
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
        <Marquee
          className={`text-[15px] font-semibold ${active ? "" : "text-white/92"}`}
        >
          <span style={active ? { color: rgbToCss(playColor) } : undefined}>
            {track.title}
          </span>
        </Marquee>
      </div>

      <div className="min-w-0 self-center text-sm text-white/48">
        {onNavigateToAlbum && track.album ? (
          <Marquee>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToAlbum();
              }}
              className="transition hover:text-white/95 focus-visible:outline-none animate-none"
            >
              {track.album}
            </button>
          </Marquee>
        ) : (
          <Marquee>
            <span>{track.album || "—"}</span>
          </Marquee>
        )}
      </div>

      <div className="self-center text-sm tabular-nums text-white/48">
        {formatDateAdded(track.dateAdded)}
      </div>

      <div className="flex items-center justify-end text-sm tabular-nums text-white/48">
        {formatOptionalDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

// ===========================================================================
// Helpers + small presentation primitives
// ===========================================================================

function EmptyPlaylistState() {
  return (
    <div className="rounded-2xl bg-black p-12 text-center">
      <p className="text-base font-semibold text-white">This playlist no longer exists.</p>
      <p className="mt-2 text-sm text-neutral-400">
        It may have been deleted. Pick another from the sidebar or create a new one.
      </p>
    </div>
  );
}

function EmptyPlaylistTracksState({
  onAddToQueue: _onAddToQueue,
}: {
  onAddToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-base font-semibold text-white">No songs yet</p>
      <p className="text-sm text-neutral-400">
        Right-click any song or album elsewhere in the app and pick "Add to playlist" to drop it here.
      </p>
    </div>
  );
}

function formatPlaylistSummary(trackCount: number, totalSeconds: number): string[] {
  if (trackCount === 0) return ["0 songs"];
  const songLabel = `${trackCount} song${trackCount === 1 ? "" : "s"}`;
  if (!totalSeconds) return [songLabel];
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const timeLabel = hours > 0
    ? `${hours} hr ${minutes} min`
    : `${minutes} min ${seconds} sec`;
  return [songLabel, timeLabel];
}

function formatDateAdded(epochMs?: number): string {
  if (!epochMs) return "—";
  const date = new Date(epochMs);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function MenuPanel({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
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
  icon: ReactNode;
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
      <span className={active ? "text-white" : "text-white/72"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={16} />}
    </button>
  );
}


