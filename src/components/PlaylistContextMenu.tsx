import { createPortal } from "react-dom";
import { useCallback } from "react";
import {
  HardDriveDownload,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { deviceExportVideoIds, savePlaylistToMp3 } from "../api";
import { useDeviceExport } from "../hooks/useDeviceExport";
import { exportStreamVideoId, sanitizeFilename } from "../utils/media";
import { SavingPanel } from "./SavingPanel";
import type { UserPlaylist } from "../playlists";

/**
 * Playlist right-click context menu. Renders to document.body via
 * createPortal so the menu z-index wins against any z-indexed page
 * container (especially Album/Artist page heroes, which can sit at
 * a high stacking context).
 *
 * `useDeviceExport` plus `<SavingPanel>` keeps the in-flight export
 * UX consistent with the song and album menus. `sanitizeFilename`
 * comes from utils/media so all three "Save to my device" menus
 * use the same pre-fill rule.
 */
export function PlaylistContextMenu({
  menuRef,
  position,
  pinned,
  onTogglePin,
  onDelete,
  onClose,
  playlist,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  position: { x: number; y: number } | undefined;
  /** Whether the playlist is currently pinned. Drives the label + icon swap. */
  pinned?: boolean;
  /** Toggle the playlist's pinned state. Closes the menu after firing. */
  onTogglePin?: () => void;
  onDelete: () => void;
  onClose?: () => void;
  /**
   * The playlist this menu operates on. Required so the "Save to my
   * device" row can read its tracks + cover. When the parent can't
   * surface the playlist (shouldn't happen, but defended against
   * here), the save row is hidden.
   */
  playlist: UserPlaylist | null;
}) {
  if (!position) return null;
  const isPinned = pinned ?? false;
  return createPortal(
    <PlaylistContextMenuContent
      menuRef={menuRef}
      position={position}
      isPinned={isPinned}
      onTogglePin={onTogglePin}
      onDelete={onDelete}
      onClose={onClose}
      playlist={playlist}
    />,
    document.body,
  );
}

function PlaylistContextMenuContent({
  menuRef,
  position,
  isPinned,
  onTogglePin,
  onDelete,
  onClose,
  playlist,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  position: { x: number; y: number };
  isPinned: boolean;
  onTogglePin?: () => void;
  onDelete: () => void;
  onClose?: () => void;
  playlist: UserPlaylist | null;
}) {
  // `useDeviceExport` provides a single onClose; PlaylistContextMenu
  // receives `onClose?` because the Sidebar may mount it without a
  // close handler (in which case we pass-through via a no-op closure).
  const handleClose = onClose ?? (() => {});
  const deviceExport = useDeviceExport({ onClose: handleClose });
  const {
    status: savingState,
    error: saveError,
    canCancel,
    cancel: handleCancelSave,
    start: startDeviceExport,
    dismiss: dismissDeviceExport,
  } = deviceExport;

  const exportableCount = playlist
    ? playlist.tracks.filter((track) => exportStreamVideoId(track) !== null).length
    : 0;

  const handleSaveToDevice = useCallback(async () => {
    if (!playlist) return;
    if (exportableCount === 0) {
      await startDeviceExport({
        label: "",
        runExport: () => {
          throw new Error("This playlist has no streamable tracks to export.");
        },
      }).catch(() => {});
      return;
    }
    let targetDir: string | string[] | null = null;
    try {
      targetDir = await openDialog({
        title: `Choose where to save "${playlist.title}"`,
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
      // User cancelled. Keep the menu open so they can pick a
      // different action instead of forcing a hard close.
      return;
    }
    await startDeviceExport({
      label: `Saving ${exportableCount} track${exportableCount === 1 ? "" : "s"}…`,
      runExport: async (requestId) => {
        // We pre-filter to streamable tracks so the backend doesn't have
        // to do it (and so the skip count we render is always accurate
        // for what the user just saw). Upload-sourced tracks are skipped
        // silently — they already live on the user's disk.
        const exportable = playlist.tracks.filter(
          (track) => exportStreamVideoId(track) !== null,
        );
        const resolvedTracks = exportable.map((track, idx) => {
          const { videoId, fallbackVideoIds } = deviceExportVideoIds(track);
          return {
            videoId,
            fallbackVideoIds,
            title: track.title,
            artist: track.artist,
            // Per-track album/artist stays untouched so each file
            // round-trips through any standard player as the song it
            // actually is. The playlist itself isn't a real "album",
            // so we deliberately don't synthesize an album artist.
            album: track.album ?? null,
            trackNumber: idx + 1,
            coverUrl: track.cover ?? null,
            fileName: sanitizeFilename(track.title || "track"),
          };
        });
        return savePlaylistToMp3({
          requestId,
          playlistName: playlist.title || "Playlist",
          targetDir,
          // The playlist cover is a base64 JPEG data URL the user uploaded
          // (or null). The backend decodes both shapes — data URL and
          // http URL — so we just hand the string through unchanged.
          coverUrl: playlist.cover ?? null,
          tracks: resolvedTracks,
        });
      },
    }).catch(() => {});
  }, [playlist, exportableCount, startDeviceExport]);

  // While we're mid-export, swap the menu body to a single status
  // panel so the user can't accidentally click "Delete" while their
  // tracks are still being written.
  if (savingState || saveError) {
    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        style={{
          position: "fixed",
          top: position.y,
          left: position.x,
          zIndex: 60,
        }}
        className="artist-menu-pop mt-1 flex min-w-[16rem] flex-col overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] animate-none"
      >
        <SavingPanel
          status={savingState?.label ?? ""}
          error={saveError}
          canCancel={canCancel}
          onCancel={handleCancelSave}
          onDismiss={dismissDeviceExport}
          errorTitle="Couldn't save playlist"
        />
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        top: position.y,
        left: position.x,
        zIndex: 60,
      }}
      className="artist-menu-pop mt-1 flex min-w-[12rem] flex-col overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] animate-none"
    >
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          className="flex items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition-colors hover:bg-white/8 hover:text-white animate-none"
        >
          {isPinned ? (
            <PinOff size={16} strokeWidth={1.6} className="translate-y-[1.5px] text-green-500" />
          ) : (
            <Pin size={16} strokeWidth={1.6} className="translate-y-[1.5px]" />
          )}
          <span>{isPinned ? "Unpin playlist" : "Pin playlist"}</span>
        </button>
      )}
      {/* "Save to my device" — opens a native folder picker and exports
          every stream-sourced track as MP3 + ID3 tags. We hide the row
          when the playlist is empty / has nothing streamable, since
          the export would just produce an empty folder. We also hide
          it when no playlist was passed (defensive — the parent
          should always supply one). */}
      {playlist && exportableCount > 0 && (
        <button
          type="button"
          onClick={() => {
            void handleSaveToDevice();
          }}
          className="flex items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition-colors hover:bg-white/8 hover:text-white animate-none"
        >
          <HardDriveDownload size={16} strokeWidth={1.6} className="translate-y-[1.5px]" />
          <span>Save to my device</span>
        </button>
      )}
      {onTogglePin && (
        <div className="border-t border-white/5" aria-hidden />
      )}
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-red-300 transition-colors hover:bg-white/8 hover:text-red-200 animate-none"
      >
        <Trash2 size={16} strokeWidth={1.6} />
        <span>Delete playlist</span>
      </button>
    </div>,
    document.body,
  );
}
