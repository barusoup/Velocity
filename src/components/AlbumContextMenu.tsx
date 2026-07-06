import {
  Check,
  ChevronRight,
  CirclePlus,
  Disc,
  HardDriveDownload,
  List,
  LoaderCircle,
  PanelRightOpen,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { type SavedAlbum } from "../collection";
import { useCollectionActions } from "../collection";
import { usePlayerState } from "../player";
import { useIsAlbumSaved, useIsSongSavedByVideo } from "../hooks/useCollectionSelectors";
import { deviceExportVideoIds, getEntityDetail, saveAlbumToMp3 } from "../api";
import { useDeviceExport } from "../hooks/useDeviceExport";
import { exportStreamVideoId, filterQueueableTracks, sanitizeFilename } from "../utils/media";
import type { MediaTrack } from "../types";
import { NestedSubMenuPanel } from "./NestedSubMenuPanel";
import { SavingPanel } from "./SavingPanel";
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
  onNavigate,
  currentAlbumBrowseId,
  currentUserPlaylistId,
}: AlbumContextMenuProps) {
  const { toggleSong, toggleAlbum } = useCollectionActions();
  const player = usePlayerState();
  const [resolvedTracks, setResolvedTracks] = useState<MediaTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const isCurrentAlbum = currentAlbumBrowseId && album.browseId === currentAlbumBrowseId;
  const tracks = tracksProp ?? resolvedTracks;
  const isSingle = tracks.length === 1;
  const singleVideoSaved = useIsSongSavedByVideo(isSingle ? tracks[0]?.videoId : null);
  const albumSaved = useIsAlbumSaved(isSingle ? null : album.browseId);
  const isSaved = isSingle ? singleVideoSaved : albumSaved;

  useEffect(() => {
    if (tracksProp) return;
    if (!album.browseId || resolvedTracks.length > 0) return;
    setTracksLoading(true);
    getEntityDetail(album.browseId)
      .then((entity) => {
        setResolvedTracks(
          filterQueueableTracks(
            entity.tracks.map((t) => ({ ...t, albumBrowseId: album.browseId })),
          ),
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

  // "Save to my device" shared hook — see SongContextMenu's
  // `useDeviceExport` for the full rationale. The hook keeps the
  // status/error/cancel state machine in one place so album + track +
  // playlist menus behave identically and any future UX change ships
  // across all three simultaneously.
  const deviceExport = useDeviceExport({ onClose });
  const {
    status: savingState,
    error: saveError,
    canCancel,
    cancel: handleCancelSave,
    start: startDeviceExport,
    dismiss: dismissDeviceExport,
  } = deviceExport;

  const handleGoToAlbum = () => {
    if (album.browseId) {
      onNavigate?.({ name: "album", browseId: album.browseId, context: "default" });
    }
    onClose();
  };

  const handleToggleSave = () => {
    if (isSingle && tracks[0]) {
      toggleSong(tracks[0]);
    } else {
      toggleAlbum(album);
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
    () => tracks.filter((track) => exportStreamVideoId(track) !== null),
    [tracks],
  );

  const handleSaveAlbumToDevice = useCallback(async () => {
    const exportable = exportableTracks();
    if (exportable.length === 0) {
      await startDeviceExport({
        label: "",
        runExport: () => {
          throw new Error("This album has no streamable tracks to export.");
        },
      }).catch(() => {});
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
      await startDeviceExport({
        label: "",
        runExport: () => {
          throw error instanceof Error ? error : new Error("Could not open the folder picker.");
        },
      }).catch(() => {});
      return;
    }
    if (!targetDir || Array.isArray(targetDir)) {
      // User cancelled (or picked nothing usable). Keep the menu open
      // so they can pick a different action.
      return;
    }
    await startDeviceExport({
      label: `Saving ${exportable.length} track${exportable.length === 1 ? "" : "s"}…`,
      runExport: async (requestId) => {
        const resolvedTracks = exportable.map((track, idx) => {
          const { videoId, fallbackVideoIds } = deviceExportVideoIds(track);
          return {
            videoId,
            fallbackVideoIds,
            title: track.title,
            artist: track.artist,
            trackNumber: idx + 1,
            fileName: sanitizeFilename(track.title || "track"),
          };
        });
        return saveAlbumToMp3({
          requestId,
          albumName: album.title || "Album",
          targetDir,
          // `byline` on a `SavedAlbum` is the artist string the
          // search/list endpoint already gave us (e.g. "The Beatles").
          // Fall back to null so the Rust side just leaves the
          // per-track artist on each file.
          albumArtist: album.byline ?? null,
          year: null,
          coverUrl: album.cover ?? null,
          tracks: resolvedTracks,
        });
      },
    }).catch(() => {});
  }, [album, exportableTracks, startDeviceExport]);

  return (
    <ContextMenu open={open} anchorRef={anchorRef} position={position} onClose={onClose}>
      {savingState || saveError ? (
        <SavingPanel
          status={savingState?.label ?? ""}
          error={saveError}
          canCancel={canCancel}
          onCancel={handleCancelSave}
          onDismiss={dismissDeviceExport}
          errorTitle="Couldn't save album"
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
            const showRow =
              !!resolvePlaylists &&
              tracks.length > 0 &&
              !!onAddAlbumToPlaylist;
            if (!showRow) return null;
            if (tracksLoading) return null;
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
          {playlistOpen && resolvePlaylists && tracks.length > 0 && onAddAlbumToPlaylist && (
            <AlbumPlaylistSubMenu
              anchorRef={playlistRowRef}
              onClose={() => setPlaylistOpen(false)}
              onPick={handlePickPlaylist}
              resolver={async (query) => {
                // Drop the playlist the user is currently viewing (if any)
                // from the submenu so "Add to [current]" isn't a silent
                // no-op. Equivalent gating lives in the song menu.
                const list = await resolvePlaylists(query);
                return currentUserPlaylistId
                  ? list.filter((entry) => entry.browseId !== currentUserPlaylistId)
                  : list;
              }}
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
  resolver,
  initialTracksLabel,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  onPick: (playlist: PlaylistSearchResult) => void;
  resolver: (query: string) => Promise<PlaylistSearchResult[]>;
  initialTracksLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaylistSearchResult[]>([]);
  const [loading, setLoading] = useState(true);

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
