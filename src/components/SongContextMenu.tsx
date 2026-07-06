import {
  Check,
  ChevronRight,
  CirclePlus,
  Disc,
  HardDriveDownload,
  List,
  ListMusic,
  PanelRightOpen,
  Trash2,
  User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCollectionActions } from "../collection";
import { usePlayerActions, usePlayerState } from "../player";
import { useIsTrackSaved } from "../hooks/useCollectionSelectors";
import type { MediaTrack } from "../types";
import { deviceExportVideoIds, hydrateUploadTrackForPlayback, saveTrackToMp3 } from "../api";
import { useDeviceExport } from "../hooks/useDeviceExport";
import { getDirectAlbumBrowseId, getDirectArtistBrowseId } from "../utils/navigation";
import { isSameSongTrack, sanitizeFilename } from "../utils/media";
import { NestedSubMenuPanel } from "./NestedSubMenuPanel";
import { SavingPanel } from "./SavingPanel";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSection,
} from "./ContextMenu";
import type { View } from "./Sidebar";

// -----------------------------------------------------------------------
// SongContextMenu — pure render component.
//
// The App shell owns the global contextmenu event listener. When a row
// declares `data-song-context-target` AND carries a JSON-encoded
// `data-track`, the App handler reads those attributes and renders this
// component near the cursor. The component itself owns no global state.
// -----------------------------------------------------------------------

export type AddToPlaylistResolver = {
  resolvePlaylists: (query: string) => Promise<
    Array<{ browseId: string; title: string; subtitle?: string | null; cover?: string | null }>
  >;
  addTracksToPlaylist: (browseId: string, tracks: MediaTrack[]) => Promise<void>;
};

type SongContextMenuProps = {
  track: MediaTrack | null;
  position?: { x: number; y: number };
  anchorRef: { current: HTMLElement | null };
  onNavigate: (view: View) => void;
  addToPlaylistResolver?: AddToPlaylistResolver;
  /**
   * Invoked with the track id when the user confirms a destructive
   * delete from the confirmation menu. Only mounted by App for tracks
   * whose source is uploaded — stream tracks never expose the option.
   */
  onRemoveTrack?: (trackId: string) => void;
  /**
   * Invoked when the user flips the per-track \"Find lyrics\" toggle on
   * a locally uploaded song. The new value is passed as the second
   * argument (true = lyrics fetching enabled). Only mounted by App for
   * `source === "upload"` rows; stream tracks never expose the option
   * because lyrics fetching is already implicit for them.
   */
  onToggleUploadLyrics?: (trackId: string, nextValue: boolean) => void;
  onRemoveFromPlaylist?: (playlistId: string, trackId: string) => void;
  onClose: () => void;
  /**
   * The browseId of the album currently being viewed. When provided,
   * the "Go to Album" option is hidden if the track belongs to this album.
   */
  currentAlbumBrowseId?: string;
  /**
   * The browseId of the artist whose page is currently being viewed.
   * When provided, the "Go to Artist" option is hidden if the track's
   * artist matches this page.
   */
  currentArtistBrowseId?: string;
  /**
   * When the user is currently viewing one of their own playlists, the
   * "Add to playlist" submenu drops that playlist from its results — the
   * duplicate-add path is a silent no-op in the provider, but listing it
   * gives the user a non-action. Also used to surface "Remove from this
   * playlist" when onRemoveFromPlaylist is provided.
   */
  currentUserPlaylistId?: string;
};

export function SongContextMenu({
  track,
  position,
  anchorRef,
  onNavigate,
  addToPlaylistResolver,
  onRemoveTrack,
  onToggleUploadLyrics,
  onRemoveFromPlaylist,
  onClose,
  currentAlbumBrowseId,
  currentArtistBrowseId,
  currentUserPlaylistId,
}: SongContextMenuProps) {
  if (!track || !position) return null;
  return (
    <SongContextMenuContent
      track={track}
      position={position}
      anchorRef={anchorRef}
      onNavigate={onNavigate}
      addToPlaylistResolver={addToPlaylistResolver}
      onRemoveTrack={onRemoveTrack}
      onToggleUploadLyrics={onToggleUploadLyrics}
      onRemoveFromPlaylist={onRemoveFromPlaylist}
      onClose={onClose}
      currentAlbumBrowseId={currentAlbumBrowseId}
      currentArtistBrowseId={currentArtistBrowseId}
      currentUserPlaylistId={currentUserPlaylistId}
    />
  );
}

function SongContextMenuContent({
  track,
  position,
  anchorRef,
  onNavigate,
  addToPlaylistResolver,
  onRemoveTrack,
  onToggleUploadLyrics,
  onRemoveFromPlaylist,
  onClose,
  currentAlbumBrowseId,
  currentArtistBrowseId,
  currentUserPlaylistId,
}: { track: MediaTrack; position: { x: number; y: number } } & Omit<SongContextMenuProps, "track" | "position">) {
  const playerState = usePlayerState();
  const playerActions = usePlayerActions();
  const { toggleSong } = useCollectionActions();
  const directAlbumId = getDirectAlbumBrowseId(track);
  const directArtistId = getDirectArtistBrowseId(track);
  const isSaved = useIsTrackSaved(track);
  const isCurrentAlbum = directAlbumId && currentAlbumBrowseId && directAlbumId === currentAlbumBrowseId;
  const isCurrentArtist = directArtistId && currentArtistBrowseId && directArtistId === currentArtistBrowseId;
  const isInQueue = playerState.queue.some((t) => t.id === track.id);
  // Confirmation state for the destructive Delete option. Only meaningful
  // for upload-sourced tracks. When true, the menu's children swap to a
  // two-button confirmation panel instead of the standard row list.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmPosition, setDeleteConfirmPosition] = useState<{ x: number; y: number } | null>(null);

  // Re-target the menu to a different row? Drop the delete-confirmation
  // state so a stale panel doesn't follow the new row. The device-export
  // hook manages its own cross-row cleanup, so no state reset is needed
  // for that slice here.
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteConfirmPosition(null);
  }, [track.id]);

  const handleToggleFindLyrics = () => {
    onToggleUploadLyrics?.(track.id, !track.findLyrics);
    onClose();
  };

  const handleGoToAlbum = () => {
    if (directAlbumId) {
      onNavigate({ name: "album", browseId: directAlbumId, context: "default" });
      onClose();
    }
  };

  const handleGoToArtist = () => {
    if (directArtistId) {
      onNavigate({ name: "artist", browseId: directArtistId, context: "default" });
      onClose();
    }
  };

  const handleAddToQueue = () => {
    void hydrateUploadTrackForPlayback(track)
      .then((hydrated) => {
        playerActions.appendToQueue([hydrated]);
        onClose();
      })
      .catch(() => onClose());
  };

  const handleToggleSave = () => {
    toggleSong(track);
    onClose();
  };

  const handleStartDeleteConfirm = () => {
    const menuPanel = document.querySelector('[role="menu"]');
    if (menuPanel) {
      const rect = menuPanel.getBoundingClientRect();
      const buttons = menuPanel.querySelectorAll("button");
      const deleteButton = buttons[buttons.length - 1];
      if (deleteButton) {
        const deleteRect = deleteButton.getBoundingClientRect();
        setDeleteConfirmPosition({ x: rect.left, y: deleteRect.top - deleteRect.height });
      } else {
        setDeleteConfirmPosition({ x: rect.left, y: rect.bottom });
      }
    }
    setConfirmingDelete(true);
  };

  const handleCancelDelete = () => {
    setConfirmingDelete(false);
    setDeleteConfirmPosition(null);
  };

  const handleConfirmDelete = () => {
    const id = track.id;
    // Close first so the redirect happens before the local state mutation
    // observably un-mounts our row; row teardown racing with the menu close
    // animation can otherwise flash.
    onClose();
    onRemoveTrack?.(id);
  };

  const exportTrack = enrichTrackForDeviceExport(track, playerState.currentTrack, playerState.queue);
  const deviceExport = useDeviceExport({ onClose });
  const {
    status: savingState,
    error: saveError,
    canCancel,
    cancel: handleCancelSave,
    start: startDeviceExport,
    dismiss: dismissDeviceExport,
  } = deviceExport;

  // "Save to my device" — opens a native save dialog, then hands the
  // chosen path + track metadata to the Rust pipeline. The dialog
  // returns `null` when the user cancels, in which case we leave the
  // menu untouched (no save started).
  const handleSaveToDevice = async () => {
    const safeTitle = sanitizeFilename(track.title || "track");
    const defaultName = `${safeTitle}.mp3`;
    let targetPath: string | null = null;
    try {
      targetPath = await saveDialog({
        title: `Save "${track.title || "track"}" to your device`,
        defaultPath: defaultName,
        filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
      });
    } catch (error) {
      // Surface dialog errors through the same panel state machine as
      // export failures so the user gets one consistent error UI.
      await startDeviceExport({
        label: "",
        runExport: () => {
          throw error instanceof Error ? error : new Error("Could not open the save dialog.");
        },
      }).catch(() => {});
      return;
    }
    if (!targetPath) {
      // User cancelled the dialog. Keep the menu open so they can pick
      // a different action instead of forcing a hard close.
      return;
    }
    const split = splitDirAndName(targetPath);
    if (!split) {
      await startDeviceExport({
        label: "",
        runExport: () => {
          throw new Error("That save location isn't valid. Please pick a folder on your computer.");
        },
      }).catch(() => {});
      return;
    }
    const { dir, stem } = split;
    await startDeviceExport({
      label: `Saving "${track.title || "track"}"…`,
      runExport: async (requestId) => {
        const { videoId, fallbackVideoIds } = deviceExportVideoIds(exportTrack);
        return saveTrackToMp3({
          requestId,
          videoId,
          fallbackVideoIds,
          title: exportTrack.title,
          artist: exportTrack.artist,
          album: exportTrack.album ?? null,
          trackNumber: null,
          trackTotal: null,
          year: null,
          coverUrl: exportTrack.cover ?? null,
          targetDir: dir,
          fileName: stem,
        });
      },
    }).catch(() => {});
  };

  const effectivePosition = confirmingDelete && deleteConfirmPosition ? deleteConfirmPosition : position;

  return (
    <ContextMenu
      open
      position={effectivePosition}
      anchorRef={anchorRef}
      onClose={onClose}
    >
      {confirmingDelete ? (
        <DeleteConfirmationSection
          onCancel={handleCancelDelete}
          onConfirm={handleConfirmDelete}
        />
      ) : savingState || saveError ? (
        <SavingPanel
          status={savingState?.label ?? ""}
          error={saveError}
          // The cancel button is enabled while the export is in
          // flight (the active request id is set). Once the user
          // clicks it we set the panel's status to "Cancelling…"
          // and hide the Cancel button so the user can't double-cancel.
          canCancel={canCancel}
          onCancel={handleCancelSave}
          onDismiss={dismissDeviceExport}
          errorTitle="Couldn't save track"
        />
      ) : (
        <>
          {addToPlaylistResolver && (
            <AddToPlaylistRow
              resolver={{
                ...addToPlaylistResolver,
                resolvePlaylists: async (query) => {
                  const results = await addToPlaylistResolver.resolvePlaylists(query);
                  // Drop the playlist the user is currently on from the
                  // add-list so the "Add to [current]" entry isn't a
                  // silent no-op. Empty list collapses the menu row in
                  // the consumer below.
                  return currentUserPlaylistId
                    ? results.filter((entry) => entry.browseId !== currentUserPlaylistId)
                    : results;
                },
              }}
              track={track}
              onClose={onClose}
            />
          )}
          {currentUserPlaylistId && onRemoveFromPlaylist && (
            <ContextMenuItem
              label="Remove from this playlist"
              icon={<Trash2 size={16} strokeWidth={1.6} />}
              onClick={() => {
                onRemoveFromPlaylist(currentUserPlaylistId, track.id);
                onClose();
              }}
            />
          )}
          {!isCurrentAlbum && directAlbumId && (
            <ContextMenuItem
              label="Go to Album"
              icon={<Disc size={16} strokeWidth={1.6} />}
              onClick={handleGoToAlbum}
            />
          )}
          {!isCurrentArtist && directArtistId && (
            <ContextMenuItem
              label="Go to Artist"
              icon={<User size={16} strokeWidth={1.6} />}
              onClick={handleGoToArtist}
            />
          )}
          {!isInQueue && (
            <ContextMenuItem
              label="Add to queue"
              icon={<List size={16} strokeWidth={1.6} />}
              onClick={handleAddToQueue}
            />
          )}
          {/* "Save to my device" — exports the track as MP3 + ID3 tags
              into a user-chosen location. The Rust side is identical to
              the offline-save pipeline (yt-dlp → ffmpeg → lofty) but
              lands the file at a custom path instead of the offline
              cache. We hide the row for upload-sourced tracks because
              the local file already exists on disk; the user can copy
              it from their filesystem directly. */}
          {track.source !== "upload" && (
            <ContextMenuItem
              label="Save to my device"
              icon={<HardDriveDownload size={16} strokeWidth={1.6} />}
              onClick={() => {
                void handleSaveToDevice();
              }}
            />
          )}
          {/* Locally uploaded tracks can't be saved to the collection —
              they live in the Local tab and surface a Delete option here
              instead. Hide the Save row so the menu doesn't advertise an
              action that the toggle boundary would no-op anyway. */}
          {track.source !== "upload" && (
            <ContextMenuItem
              label={isSaved ? "Saved to collection" : "Save to collection"}
              icon={isSaved ? <Check size={16} strokeWidth={2.2} /> : <CirclePlus size={16} strokeWidth={1.6} />}
              onClick={handleToggleSave}
            />
          )}
          {track.source === "upload" && onToggleUploadLyrics && (
            <ContextMenuItem
              label="Find lyrics"
              icon={<ListMusic size={16} strokeWidth={1.6} />}
              active={track.findLyrics === true}
              onClick={handleToggleFindLyrics}
            />
          )}
          {track.source === "upload" && onRemoveTrack && (
            <ContextMenuItem
              label="Delete"
              variant="destructive"
              icon={<Trash2 size={16} strokeWidth={1.6} />}
              onClick={handleStartDeleteConfirm}
            />
          )}
        </>
      )}
    </ContextMenu>
  );
}

function DeleteConfirmationSection({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Inline confirmation pattern: instead of opening a modal, swap the
  // existing menu's children for a two-row confirmation panel. This keeps
  // the interaction local to the right-click site (no mouse travel, no
  // portal-jump) and matches the user's "menu"-shaped expectation.
  return (
    <>
      <ContextMenuItem
        label="Delete permanently"
        variant="destructive"
        icon={<Trash2 size={16} strokeWidth={1.6} />}
        onClick={onConfirm}
      />
      <ContextMenuItem
        label="Cancel"
        onClick={onCancel}
      />
    </>
  );
}

function AddToPlaylistRow({
  resolver,
  track,
  onClose,
}: {
  resolver: AddToPlaylistResolver;
  track: MediaTrack;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition-colors hover:bg-white/8 hover:text-white animate-none"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="shrink-0">
          <PanelRightOpen size={16} strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1 truncate">Add to playlist</span>
        <span
          className={`shrink-0 text-white/40 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          <ChevronRight size={16} strokeWidth={2.25} />
        </span>
      </button>
      {open && (
        <PlaylistSearchSubMenu
          anchorRef={rowRef}
          onClose={() => setOpen(false)}
          onPick={(playlist) => {
            onClose();
            resolver.addTracksToPlaylist(playlist.browseId, [track]);
          }}
          resolver={resolver}
        />
      )}
    </>
  );
}

function PlaylistSearchSubMenu({
  anchorRef,
  onClose,
  onPick,
  resolver,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  onPick: (playlist: { browseId: string; title: string }) => void;
  resolver: AddToPlaylistResolver;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Awaited<ReturnType<AddToPlaylistResolver["resolvePlaylists"]>>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void resolver
      .resolvePlaylists(query)
      .then((list) => {
        if (cancelled) return;
        setResults(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResults([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, resolver]);

  return (
    <NestedSubMenuPanel anchorRef={anchorRef} onClose={onClose}>
      <ContextMenuSection label="Search playlists">
        <div className="px-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a playlist name…"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/40 outline-none transition-colors focus:border-white/20 focus:bg-white/10"
          />
        </div>
      </ContextMenuSection>
      <div className="max-h-64 overflow-y-auto">
        {loading && results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-white/40">Searching…</div>
        ) : results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-white/40">
            No playlists yet. Create one from the sidebar.
          </div>
        ) : (
          results.map((playlist) => (
            <ContextMenuItem
              key={playlist.browseId + playlist.title}
              label={playlist.title}
              onClick={() => onPick(playlist)}
            />
          ))
        )}
      </div>
    </NestedSubMenuPanel>
  );
}

/** Borrow resolved playback ids from the player when this row is the same song. */
function enrichTrackForDeviceExport(
  track: MediaTrack,
  currentTrack: MediaTrack | null,
  queue: readonly MediaTrack[],
): MediaTrack {
  const candidates = [currentTrack, ...queue].filter(
    (entry): entry is MediaTrack => entry != null,
  );
  for (const candidate of candidates) {
    if (!candidate.resolvedVideoId || !isSameSongTrack(candidate, track)) continue;
    return { ...track, resolvedVideoId: candidate.resolvedVideoId };
  }
  return track;
}

// ── "Save to my device" helpers ────────────────────────────────────────
//
// The native save dialog returns the FULL path (e.g. `C:\Music\foo.mp3`).
// We hand the path to the Rust command as `targetDir` + `fileName` (the
// stem without the extension) so the backend can:
//   * re-apply non-clobber naming if the user picks a filename that
//     already exists,
//   * keep the parent folder opaque to the FS layer, and
//   * add the `.mp3` extension itself so we never write a file the OS
//     can't identify.

function splitDirAndName(path: string): { dir: string; stem: string } | null {
  // Cross-platform: prefer forward/back slashes both as separators.
  const lastSep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (lastSep < 0) {
    // No separator: treat the whole thing as a stem in the current dir.
    return { dir: ".", stem: stripExtension(path) };
  }
  const dir = path.slice(0, lastSep);
  const name = path.slice(lastSep + 1);
  if (!dir || !name) return null;
  return { dir, stem: stripExtension(name) };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  // Strip the extension only when it's not the entire filename (e.g.
  // ".gitignore" or a dotfile). Also skip when there's no dot at all.
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

