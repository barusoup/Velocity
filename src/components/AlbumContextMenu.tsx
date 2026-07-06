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
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCollection, type SavedAlbum } from "../collection";
import { usePlayer } from "../player";
import { cancelSaveExport, getEntityDetail, makeSaveExportRequestId, saveAlbumToMp3 } from "../api";
import type { MediaTrack } from "../types";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSection,
} from "./ContextMenu";
import type { View } from "./Sidebar";

// -----------------------------------------------------------------------
// Album context menu — opens from the Album page's ellipsis (3-dots) button
// OR from any album card (right-click) across the app.
//
// Options:
//   * Go to Album — navigates to the album's detail page. Hidden when
//     `currentAlbumBrowseId` matches the album.
//   * Add to Your Collection — toggles the album's saved state. Label and
//     icon swap to "Saved" + filled check when already saved.
//   * Add to queue — appends the entire track list to the end of the
//     queue in CHRONOLOGICAL order.
//   * Add to playlist — opens a NESTED menu mirroring the song menu's
//     Add-to-Playlist sub-menu, but inserts all tracks.
//
// When triggered from a right-click on an album card (no `tracks` prop),
// tracks are fetched lazily via `getEntityDetail`. A loading indicator
// is shown while the request is in flight.
// -----------------------------------------------------------------------

type PlaylistSearchResult = {
  browseId: string;
  title: string;
  subtitle?: string | null;
  cover?: string | null;
};

type CreatePlaylistAndAddTracks = (
  tracks: MediaTrack[],
) => Promise<{ browseId: string; title: string } | void>;

export type AlbumContextMenuProps = {
  open: boolean;
  anchorRef: { current: HTMLElement | null };
  position?: { x: number; y: number };
  onClose: () => void;
  album: SavedAlbum;
  tracks?: MediaTrack[];
  onAddAlbumToQueue?: (tracks: MediaTrack[], browseId: string, name: string) => void;
  onAddAlbumToPlaylist?: (
    browseId: string,
    tracks: MediaTrack[],
  ) => Promise<void> | void;
  resolvePlaylists?: (query: string) => Promise<PlaylistSearchResult[]>;
  /**
   * Optional handler that spins up a fresh user playlist and seeds it with
   * the supplied tracks in one step. Wired into the submenu's empty-state
   * copy as an inline "Create new playlist" affordance, so a fresh user with
   * no playlists yet (or a single-playlist owner whose only entry is the
   * one currently being viewed) can land the album's tracks into a brand
   * new playlist without detouring to the sidebar.
   */
  createPlaylistAndAddTracks?: CreatePlaylistAndAddTracks;
  onNavigate?: (view: View) => void;
  currentAlbumBrowseId?: string;
  /**
   * When the user is currently viewing one of their own playlists, the
   * "Add to playlist" submenu drops that playlist from its results so
   * the "add to current" line isn't a silent no-op. Mirrors the song
   * menu's `currentUserPlaylistId` filter.
   */
  currentUserPlaylistId?: string;
};

export function AlbumContextMenu({
  open,
  anchorRef,
  position,
  onClose,
  album,
  tracks: tracksProp,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  resolvePlaylists,
  createPlaylistAndAddTracks,
  onNavigate,
  currentAlbumBrowseId,
  currentUserPlaylistId,
}: AlbumContextMenuProps) {
  const collection = useCollection();
  const player = usePlayer();
  const [resolvedTracks, setResolvedTracks] = useState<MediaTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const isCurrentAlbum = currentAlbumBrowseId && album.browseId === currentAlbumBrowseId;
  const tracks = tracksProp ?? resolvedTracks;
  const isSingle = tracks.length === 1;
  const isSaved = isSingle
    ? (tracks[0]?.videoId
        ? collection.isSongSavedByVideo(tracks[0].videoId)
        : false)
    : collection.isAlbumSaved(album.browseId);

  useEffect(() => {
    if (tracksProp) return;
    if (!album.browseId || resolvedTracks.length > 0) return;
    setTracksLoading(true);
    getEntityDetail(album.browseId)
      .then((entity) => {
        setResolvedTracks(
          entity.tracks.map((t) => ({ ...t, albumBrowseId: album.browseId })),
        );
      })
      .catch(() => setResolvedTracks([]))
      .finally(() => setTracksLoading(false));
  }, [tracksProp, album.browseId, resolvedTracks.length]);

  const allTracksInQueue =
    tracks.length > 0 &&
    tracks.every((track) => player.queue.some((qt) => qt.id === track.id));

  const [playlistOpen, setPlaylistOpen] = useState(false);
  const playlistRowRef = useRef<HTMLButtonElement | null>(null);
  // "Save to my device" — opens a native folder picker and then runs
  // the export pipeline for every track in `tracks`. The pipeline can
  // take a while (one yt-dlp invocation per track + tag writing), so
  // we swap the menu's children for an inline status panel while it's
  // running so the user gets feedback.
  const [savingState, setSavingState] = useState<{
    label: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tracks the in-flight export's backend request id so the Cancel
  // button can route to the right cancellation sender. `null` means
  // no export is currently in flight, so the Cancel button is
  // disabled.
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  useEffect(() => {
    // Re-target the menu to a different album? Drop any in-flight
    // saving state so a stale panel doesn't follow the new album.
    setSavingState(null);
    setSaveError(null);
    setActiveRequestId(null);
  }, [album.browseId]);

  const handleGoToAlbum = () => {
    if (album.browseId) {
      onNavigate?.({ name: "album", browseId: album.browseId, context: "default" });
    }
    onClose();
  };

  const handleToggleSave = () => {
    if (isSingle && tracks[0]) {
      collection.toggleSong(tracks[0]);
    } else {
      collection.toggleAlbum(album);
    }
    onClose();
  };

  const handleAddToQueue = () => {
    if (tracks.length > 0) {
      onAddAlbumToQueue?.(tracks.slice(), album.browseId, album.title);
    }
    onClose();
  };

  const handlePickPlaylist = async (playlist: PlaylistSearchResult) => {
    if (!onAddAlbumToPlaylist || tracks.length === 0) return;
    await onAddAlbumToPlaylist(playlist.browseId, tracks.slice());
    onClose();
  };

  // "Save album to my device" — opens a folder picker, then hands the
  // picked directory + every track to the Rust pipeline. We strip
  // upload-sourced tracks from the export because the local file
  // already lives on the user's disk; copying it through yt-dlp would
  // re-encode (and potentially degrade) the audio. Stream tracks go
  // through the standard yt-dlp → ffmpeg → lofty pipeline and land in
  // a folder named after the album.
  const exportableTracks = useCallback(
    () => tracks.filter((track) => track.source !== "upload" && (track.videoId || track.id)),
    [tracks],
  );

  const handleSaveAlbumToDevice = useCallback(async () => {
    const exportable = exportableTracks();
    if (exportable.length === 0) {
      setSaveError("This album has no streamable tracks to export.");
      return;
    }
    let targetDir: string | string[] | null = null;
    try {
      targetDir = await openDialog({
        title: `Choose where to save "${album.title}"`,
        directory: true,
        multiple: false,
      });
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not open the folder picker.",
      );
      return;
    }
    if (!targetDir || Array.isArray(targetDir)) {
      // User cancelled (or, in the unlikely multiple-array case, picked
      // nothing usable). Keep the menu open so they can pick a
      // different action.
      return;
    }
    // Mint a fresh request id for this export. The backend registers
    // it in its cancellation registry; the same id is fired at
    // `cancelSaveExport` if the user pulls the ripcord.
    const requestId = makeSaveExportRequestId();
    setActiveRequestId(requestId);
    setSavingState({ label: `Saving ${exportable.length} track${exportable.length === 1 ? "" : "s"}…` });
    try {
      await saveAlbumToMp3({
        requestId,
        albumName: album.title || "Album",
        targetDir,
        // `byline` on a `SavedAlbum` is the artist string the
        // search/list endpoint already gave us (e.g. "The Beatles").
        // Fall back to undefined so the Rust side just leaves the
        // per-track artist on each file.
        albumArtist: album.byline ?? null,
        year: null,
        coverUrl: album.cover ?? null,
        tracks: exportable.map((track, idx) => ({
          videoId: track.videoId ?? track.id,
          title: track.title,
          artist: track.artist,
          trackNumber: idx + 1,
          fileName: sanitizeFilename(track.title || "track"),
        })),
      });
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save the album to your device.";
      // The backend returns "Save cancelled." on a user-initiated
      // cancel. Match the same UX as the song menu: silently close
      // rather than surface a red error.
      if (message === "Save cancelled.") {
        onClose();
        return;
      }
      setSaveError(message);
      setSavingState(null);
    } finally {
      setActiveRequestId(null);
    }
  }, [album, exportableTracks, onClose]);

  // Fire-and-forget cancel. The corresponding save promise rejects
  // on its own when the cancel signal lands; `handleSaveAlbumToDevice`
  // recognizes the "Save cancelled." message and closes the menu
  // cleanly so the user lands on a normal exit path.
  const handleCancelSave = useCallback(() => {
    const id = activeRequestId;
    if (!id) return;
    setSavingState({ label: "Cancelling…" });
    setSaveError(null);
    void cancelSaveExport(id).catch(() => {
      // The cancel command itself is best-effort. If it fails
      // (export just finished, backend removed the entry), the
      // save promise will still resolve normally and the user
      // lands on a success / error path. Swallow.
    });
  }, [activeRequestId]);

  return (
    <ContextMenu open={open} anchorRef={anchorRef} position={position} onClose={onClose}>
      {savingState ? (
        <AlbumSavingSection
          label={savingState.label}
          error={saveError}
          onClose={onClose}
          canCancel={activeRequestId !== null && saveError === null}
          onCancel={handleCancelSave}
        />
      ) : (
        <>
      {!isCurrentAlbum && album.browseId && onNavigate && (
        <ContextMenuItem
          label="Go to Album"
          icon={<Disc size={16} strokeWidth={1.6} />}
          onClick={handleGoToAlbum}
        />
      )}
      <ContextMenuItem
        label={isSaved ? "Saved to collection" : "Add to Your Collection"}
        icon={isSaved ? <Check size={16} strokeWidth={2.2} /> : <CirclePlus size={16} strokeWidth={1.6} />}
        onClick={handleToggleSave}
      />
      {tracksLoading ? (
        <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-white/40">
          <LoaderCircle size={14} className="animate-spin" />
          <span>Loading tracks…</span>
        </div>
      ) : tracks.length > 0 && !allTracksInQueue ? (
        <ContextMenuItem
          label="Add to queue"
          icon={<List size={16} strokeWidth={1.6} />}
          onClick={handleAddToQueue}
        />
      ) : null}
      {/* "Save to my device" — exports every stream-sourced track in
          this album as MP3 + ID3 tags into a user-chosen folder. The
          Rust side wraps every track in a subfolder named after the
          album and tags each file with the album + cover art. Hidden
          while tracks are still loading or when the album has nothing
          streamable to export. */}
      {!tracksLoading && exportableTracks().length > 0 && (
        <ContextMenuItem
          label="Save to my device"
          icon={<HardDriveDownload size={16} strokeWidth={1.6} />}
          onClick={() => {
            void handleSaveAlbumToDevice();
          }}
        />
      )}
      {(() => {
        const submenuAvailable =
          !!resolvePlaylists &&
          (tracks.length > 0 || !!createPlaylistAndAddTracks);
        if (!submenuAvailable) return null;
        if (tracksLoading) return null;
        const showRow =
          tracks.length > 0
            ? !!resolvePlaylists && !!onAddAlbumToPlaylist
            : !!resolvePlaylists && !!createPlaylistAndAddTracks;
        if (!showRow) return null;
        return (
          <button
            ref={playlistRowRef}
            type="button"
            onClick={() => setPlaylistOpen((value) => !value)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition-colors hover:bg-white/8 hover:text-white animate-none"
            aria-haspopup="menu"
            aria-expanded={playlistOpen}
          >
            <span className="shrink-0 text-white/72">
              <PanelRightOpen size={16} strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1 truncate">Add to playlist</span>
            <span
              className={`shrink-0 text-white/40 transition-transform ${
                playlistOpen ? "rotate-90" : ""
              }`}
            >
              <ChevronRight size={16} strokeWidth={2.25} />
            </span>
          </button>
        );
      })()}
      {playlistOpen && resolvePlaylists && tracks.length > 0 && createPlaylistAndAddTracks && (
        <AlbumPlaylistSubMenu
          anchorRef={playlistRowRef}
          onClose={() => setPlaylistOpen(false)}
          onPick={handlePickPlaylist}
          onCreate={createPlaylistAndAddTracks}
          resolver={async (query) => {
            // Drop the playlist the user is currently viewing (if any)
            // from the submenu so "Add to [current]" isn't a silent
            // no-op. Equivalent gating lives in the song menu.
            const list = await resolvePlaylists(query);
            return currentUserPlaylistId
              ? list.filter((entry) => entry.browseId !== currentUserPlaylistId)
              : list;
          }}
          initialTracks={tracks.slice()}
          initialTracksLabel="Search playlists"
        />
      )}
        </>
      )}
    </ContextMenu>
  );
}

function AlbumPlaylistSubMenu({
  anchorRef,
  onClose,
  onPick,
  onCreate,
  resolver,
  initialTracks,
  initialTracksLabel,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  onPick: (playlist: PlaylistSearchResult) => void;
  onCreate?: CreatePlaylistAndAddTracks;
  resolver: (query: string) => Promise<PlaylistSearchResult[]>;
  initialTracks: MediaTrack[];
  initialTracksLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaylistSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void resolver(query)
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
      <ContextMenuSection label={initialTracksLabel ?? "Search playlists"}>
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
          onCreate ? (
            <>
              <div className="px-4 py-2 text-xs text-white/46">
                No playlists yet.
              </div>
              <ContextMenuItem
                label={creating ? "Creating…" : "Create new playlist"}
                icon={<Plus size={14} strokeWidth={1.8} />}
                onClick={async () => {
                  if (!onCreate || creating) return;
                  setCreating(true);
                  try {
                    await onCreate(initialTracks);
                    onClose();
                  } finally {
                    // Close already fires `onClose` which un-mounts this
                    // submenu, so this `setCreating(false)` is effectively
                    // a no-op on success. Leaving it in place keeps the
                    // component safe in case the parent decides not to
                    // close on a future error path.
                    setCreating(false);
                  }
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
    </NestedSubMenuPanel>
  );
}

// Shared right-of-trigger submenu panel — measures the anchor rect and
// positions the panel to the anchor's right (or flips left when it would
// clip past the viewport). Click-away closes.
function NestedSubMenuPanel({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelWidth = panel?.offsetWidth ?? 220;
      const top = rect.top;
      let left = rect.right + 6;
      if (left + panelWidth > window.innerWidth - 12) {
        left = Math.max(8, rect.left - panelWidth - 6);
      }
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

  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [anchorRef, onClose]);

  return (
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
    </div>
  );
}

// ── "Save to my device" helpers (album) ─────────────────────────────────
//
// Mirrors the song-side helpers. We use a folder picker (not a save
// file dialog) because the album export is a folder-of-tracks, not a
// single file. The Rust pipeline handles the actual on-disk layout.

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[\s.]+$/g, "")
    .trim();
  return cleaned || "track";
}

function AlbumSavingSection({
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
  /** Fires when the user clicks Cancel. */
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
          {error ? "Couldn't save album" : label}
        </span>
        {canCancel && (
          <button
            type="button"
            onClick={onCancel}
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
