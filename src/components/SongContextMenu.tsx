import {
  Check,
  ChevronRight,
  CirclePlus,
  Disc,
  HardDriveDownload,
  List,
  LoaderCircle,
  PanelRightOpen,
  Plus,
  Trash2,
  User,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCollection } from "../collection";
import { usePlayer } from "../player";
import type { MediaTrack } from "../types";
import { cancelSaveExport, makeSaveExportRequestId, saveTrackToMp3 } from "../api";
import { getDirectAlbumBrowseId, getDirectArtistBrowseId } from "../utils/navigation";
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
  /**
   * Optional: spin up a fresh user playlist and seed it with the supplied
   * tracks in one step. Surfaced as an inline "Create new playlist" affordance
   * inside the submenu's empty-state copy so a fresh user can land their
   * first track into a brand-new playlist without detouring to the sidebar.
   * Returning the new playlist's `browseId` lets callers confirm the add.
   */
  createPlaylistAndAddTracks?: (
    tracks: MediaTrack[],
  ) => Promise<{ browseId: string; title: string }>;
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
  onRemoveFromPlaylist,
  onClose,
  currentAlbumBrowseId,
  currentArtistBrowseId,
  currentUserPlaylistId,
}: { track: MediaTrack; position: { x: number; y: number } } & Omit<SongContextMenuProps, "track" | "position">) {
  const player = usePlayer();
  const collection = useCollection();
  const directAlbumId = getDirectAlbumBrowseId(track);
  const directArtistId = getDirectArtistBrowseId(track);
  const isSaved = collection.isSongSaved(track.id);
  const isCurrentAlbum = directAlbumId && currentAlbumBrowseId && directAlbumId === currentAlbumBrowseId;
  const isCurrentArtist = directArtistId && currentArtistBrowseId && directArtistId === currentArtistBrowseId;
  const isInQueue = player.queue.some((t) => t.id === track.id);
  // Confirmation state for the destructive Delete option. Only meaningful
  // for upload-sourced tracks. When true, the menu's children swap to a
  // two-button confirmation panel instead of the standard row list.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmPosition, setDeleteConfirmPosition] = useState<{ x: number; y: number } | null>(null);
  // "Save to my device" runs through yt-dlp + ffmpeg, which can take a
  // few seconds. We swap the menu rows to a "saving…" panel with a
  // spinner + cancel so the right-click site itself stays interactive
  // (the user can still see the menu, just not click any other item
  // until the export finishes or fails).
  const [savingState, setSavingState] = useState<{
    label: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tracks the in-flight export's backend request id so the Cancel
  // button can route to the right cancellation sender. `null` means
  // no export is currently in flight, so the Cancel button is
  // disabled.
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  // Reset the confirmation any time the menu re-targets a different row.
  // Without this, prop-only re-renders (the parent keeps the same
  // SongContextMenu instance and just swaps `track`) would leave
  // `confirmingDelete` true across targets — so confirming would delete
  // whichever track the closure currently sees, not the one the user
  // agreed to delete.
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteConfirmPosition(null);
    setSavingState(null);
    setSaveError(null);
    setActiveRequestId(null);
  }, [track.id]);

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
    player.appendToQueue([track]);
    onClose();
  };

  const handleToggleSave = () => {
    collection.toggleSong(track);
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

  // "Save to my device" — opens a native save dialog, then hands the
  // chosen path + track metadata to the Rust pipeline. The dialog
  // returns `null` when the user cancels, in which case we just close
  // the menu without doing anything. The export itself happens
  // in-flight (the spinner is shown until the Rust command resolves).
  const handleSaveToDevice = useCallback(async () => {
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
      setSaveError(
        error instanceof Error ? error.message : "Could not open the save dialog.",
      );
      return;
    }
    if (!targetPath) {
      // User cancelled the dialog. Keep the menu open so they can pick
      // a different action instead of forcing a hard close.
      return;
    }
    const split = splitDirAndName(targetPath);
    if (!split) {
      setSaveError("That save location isn't valid. Please pick a folder on your computer.");
      return;
    }
    const { dir, stem } = split;
    const requestId = makeSaveExportRequestId();
    setActiveRequestId(requestId);
    setSavingState({ label: `Saving "${track.title || "track"}"…` });
    try {
      await saveTrackToMp3({
        requestId,
        videoId: track.videoId ?? track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? null,
        trackNumber: null,
        trackTotal: null,
        year: null,
        coverUrl: track.cover ?? null,
        targetDir: dir,
        fileName: stem,
      });
      // Success: dismiss the menu so the row can refresh without
      // fighting the open popout.
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save the track to your device.";
      // The backend returns a friendly "Save cancelled." when the
      // user aborted; we don't want that to surface as a red error
      // — just close the menu silently like a successful completion
      // so the UX feels like a deliberate cancel, not a failure.
      if (message === "Save cancelled.") {
        onClose();
        return;
      }
      setSaveError(message);
      setSavingState(null);
    } finally {
      setActiveRequestId(null);
    }
  }, [track, onClose]);

  // Pull the ripcord on the in-flight save. We don't await the
  // `cancelSaveExport` call — the backend command is fire-and-forget
  // and the corresponding save command will reject on its own when
  // the cancellation signal lands (which `handleSaveToDevice`
  // recognizes and uses to close the menu cleanly).
  const handleCancelSave = useCallback(() => {
    const id = activeRequestId;
    if (!id) return;
    setSavingState({ label: "Cancelling…" });
    setSaveError(null);
    void cancelSaveExport(id).catch(() => {
      // The cancel command itself is best-effort. If it fails (e.g.
      // the backend already removed the entry because the export
      // just finished), the save promise will still resolve
      // normally and the user lands on a normal success / error
      // path. Swallow the cancel error so we don't double up.
    });
  }, [activeRequestId]);

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
      ) : savingState ? (
        <SavingSection
          label={savingState.label}
          error={saveError}
          onClose={onClose}
          // The cancel button is enabled while the export is in
          // flight (i.e. the active request id is set). Once the
          // user clicks it we set `savingState` to a "Cancelling…"
          // variant that swaps the label but keeps the cancel
          // button hidden so the user can't double-cancel.
          canCancel={activeRequestId !== null && saveError === null}
          onCancel={handleCancelSave}
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
          track={track}
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
  track,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  onPick: (playlist: { browseId: string; title: string }) => void;
  resolver: AddToPlaylistResolver;
  track: MediaTrack;
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
    <NestedMenuMount anchorRef={anchorRef} onClose={onClose}>
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
          resolver.createPlaylistAndAddTracks ? (
            <>
              <div className="px-4 py-2 text-xs text-white/46">
                No playlists yet.
              </div>
              <ContextMenuItem
                label="Create new playlist"
                icon={<Plus size={14} strokeWidth={1.8} />}
                onClick={async () => {
                  if (!resolver.createPlaylistAndAddTracks) return;
                  await resolver.createPlaylistAndAddTracks([track]);
                  onClose();
                }}
              />
            </>
          ) : (
            <div className="px-4 py-3 text-xs text-white/40">
              No playlists yet. Create one from the sidebar.
            </div>
          )
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
    </NestedMenuMount>
  );
}

function NestedMenuMount({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelWidth = panel?.offsetWidth ?? 220;
      const panelHeight = panel?.offsetHeight ?? 220;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let top = rect.top;
      let left = rect.right + 6;
      if (left + panelWidth > viewportW - 12) {
        left = Math.max(8, rect.left - panelWidth - 6);
      }
      if (top + panelHeight > viewportH - 8) {
        top = Math.max(8, viewportH - panelHeight - 8);
      }
      if (top < 8) top = 8;
      setCoords({ top, left });
    };
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef]);

  const closeIfOutside = useCallback(
    (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    },
    [anchorRef, onClose],
  );

  useEffect(() => {
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [closeIfOutside]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      data-context-menu="true"
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        zIndex: 65,
      }}
      className="artist-menu-pop overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] min-w-[14rem] max-w-[18rem]"
    >
      {children}
    </div>,
    document.body,
  );
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

// Lightweight FS-safe sanitizer for the suggested default file name.
// We duplicate a thin version of the Rust-side rule so the dialog's
// pre-filled name is readable; the Rust side still applies its own
// sanitizer as a defense in depth.
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[\s.]+$/g, "")
    .trim();
  return cleaned || "track";
}

// Inline "Saving…" panel. We swap the menu's children for a
// spinner + status so the user gets feedback the click did something
// while the (potentially slow) yt-dlp + ffmpeg pipeline runs. If the
// backend rejects, the same panel turns into an error message + dismiss
// button.
function SavingSection({
  label,
  error,
  onClose,
  canCancel,
  onCancel,
}: {
  label: string;
  error: string | null;
  onClose: () => void;
  /**
   * Whether the Cancel button is enabled. The parent flips this on
   * while the export is in flight and off once cancellation is in
   * progress (so the user can't double-cancel) or after the export
   * has settled.
   */
  canCancel: boolean;
  /**
   * Fires when the user clicks Cancel. The parent is responsible
   * for routing this to the backend's `cancelSaveExport` command.
   */
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 text-sm text-white/72">
      <div className="flex items-center gap-3">
        {error ? (
          <span className="shrink-0 text-red-400">
            <Trash2 size={16} strokeWidth={1.6} />
          </span>
        ) : (
          <span className="shrink-0 text-white/72">
            <LoaderCircle size={16} className="animate-spin" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-semibold">
          {error ? "Couldn't save track" : label}
        </span>
        {canCancel && (
          <button
            type="button"
            onClick={onCancel}
            // The Cancel button sits in the same row as the status
            // label so the user can pull the ripcord without
            // re-reading any copy. Hover matches the destructive
            // row treatment used elsewhere in the menu so it reads
            // as the "stop" affordance.
            className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/72 transition-colors hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-200"
          >
            Cancel
          </button>
        )}
      </div>
      {error && (
        <>
          <p className="pl-7 text-xs leading-relaxed text-red-300/90">
            {error}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-1 self-start rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/72 transition-colors hover:bg-white/10 hover:text-white"
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
