import { createPortal } from "react-dom";
import { useCallback, useState } from "react";
import {
  HardDriveDownload,
  LoaderCircle,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  cancelSaveExport,
  makeSaveExportRequestId,
  savePlaylistToMp3,
} from "../api";
import type { UserPlaylist } from "../playlists";

export function PlaylistContextMenu({
  menuRef,
  position,
  pinned,
  onTogglePin,
  onDelete,
  onClose: _onClose,
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
  playlist,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  position: { x: number; y: number };
  isPinned: boolean;
  onTogglePin?: () => void;
  onDelete: () => void;
  playlist: UserPlaylist | null;
}) {
  // "Save to my device" is async (folder picker → yt-dlp per track →
  // lofty tag writing). We keep the menu open and swap the row to a
  // spinner / error panel so the user gets feedback that the click
  // registered. The menu stays interactive (Dismissible error) until
  // the export resolves or fails, at which point we close.
  const [savingState, setSavingState] = useState<{
    label: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tracks the in-flight export's backend request id so the Cancel
  // button can route to the right cancellation sender. `null` means
  // no export is currently in flight, so the Cancel button is
  // disabled.
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const exportableCount = playlist
    ? playlist.tracks.filter(
        (track) => track.source !== "upload" && (track.videoId || track.id),
      ).length
    : 0;

  const handleSaveToDevice = useCallback(async () => {
    if (!playlist) return;
    if (exportableCount === 0) {
      setSaveError("This playlist has no streamable tracks to export.");
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
      setSaveError(
        error instanceof Error ? error.message : "Could not open the folder picker.",
      );
      return;
    }
    if (!targetDir || Array.isArray(targetDir)) {
      // User cancelled. Keep the menu open so they can pick a
      // different action instead of forcing a hard close.
      return;
    }
    // Mint a fresh request id; the backend registers it in its
    // cancellation registry and the same id is fired at
    // `cancelSaveExport` if the user pulls the ripcord.
    const requestId = makeSaveExportRequestId();
    setActiveRequestId(requestId);
    setSavingState({
      label: `Saving ${exportableCount} track${exportableCount === 1 ? "" : "s"}…`,
    });
    try {
      // We pre-filter to streamable tracks so the backend doesn't have
      // to do it (and so the skip count we render is always accurate
      // for what the user just saw). Upload-sourced tracks are skipped
      // silently — they already live on the user's disk.
      const exportable = playlist.tracks.filter(
        (track) => track.source !== "upload" && (track.videoId || track.id),
      );
      await savePlaylistToMp3({
        requestId,
        playlistName: playlist.title || "Playlist",
        targetDir,
        // The playlist cover is a base64 JPEG data URL the user uploaded
        // (or null). The backend decodes both shapes — data URL and
        // http URL — so we just hand the string through unchanged.
        coverUrl: playlist.cover ?? null,
        tracks: exportable.map((track, idx) => ({
          videoId: track.videoId ?? track.id,
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
        })),
      });
      // Success: dismiss the menu so the row can refresh without
      // fighting the open popout.
      onDelete; // (no-op; intentional)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save the playlist to your device.";
      // Backend "Save cancelled." is a deliberate user action, not
      // a failure — close the menu cleanly instead of showing a
      // red error.
      if (message === "Save cancelled.") {
        onDelete; // (no-op; intentional)
        return;
      }
      setSaveError(message);
      setSavingState(null);
    } finally {
      setActiveRequestId(null);
    }
  }, [playlist, exportableCount, onDelete]);

  // Fire-and-forget cancel. The corresponding save promise rejects
  // on its own when the cancel signal lands; `handleSaveToDevice`
  // recognizes the "Save cancelled." message and closes the menu
  // cleanly.
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
        <div className="flex flex-col gap-1 px-4 py-3 text-sm text-white/72">
          <div className="flex items-center gap-3">
            {saveError ? (
              <span className="shrink-0 text-red-400">
                <X size={16} strokeWidth={1.8} />
              </span>
            ) : (
              <span className="shrink-0 text-white/72">
                <LoaderCircle size={16} className="animate-spin" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-semibold">
              {saveError ? "Couldn't save playlist" : savingState?.label}
            </span>
            {/* Cancel button mirrors the song + album menus: visible
                only while the export is in flight (not after a hard
                error, and not while the cancel is being propagated —
                the parent flips `activeRequestId` to `null` only after
                the backend has either resolved the cancel or the
                export itself has settled). */}
            {activeRequestId !== null && saveError === null && (
              <button
                type="button"
                onClick={handleCancelSave}
                className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/72 transition-colors hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-200"
              >
                Cancel
              </button>
            )}
          </div>
          {saveError && (
            <>
              <p className="pl-7 text-xs leading-relaxed text-red-300/90">
                {saveError}
              </p>
              <button
                type="button"
                onClick={() => {
                  setSaveError(null);
                  setSavingState(null);
                }}
                className="mt-1 self-start rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/72 transition-colors hover:bg-white/10 hover:text-white"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
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

// Lightweight FS-safe sanitizer for the suggested default file name.
// Duplicated from AlbumContextMenu / SongContextMenu (each menu owns
// its own copy because they're independently-rendered entry points);
// all three implementations share the same rules. The Rust side
// re-sanitizes as defense in depth.
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[\s.]+$/g, "")
    .trim();
  return cleaned || "track";
}
