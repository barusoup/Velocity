import { useCallback, useState } from "react";

import {
  cancelSaveExport,
  makeSaveExportRequestId,
} from "../api";
import { formatInvokeError } from "../utils/invoke-error";

/**
 * Status of an in-flight "Save to my device" export. The parent supply a
 * `runExport(activeRequestId)` callback that exercises one of the
 * `saveTrackToMp3` / `saveAlbumToMp3` / `savePlaylistToMp3` Tauri
 * commands; the hook owns the cancellation/error/success state machine
 * and exposes the right handlers. Three menus use this: SongContextMenu,
 * AlbumContextMenu, and PlaylistContextMenu.
 *
 * The hook intentionally does NOT own the dialog lifecycle — the
 * `promptForTarget` slot is a parent-supplied function so the song menu
 * can use a `save` file dialog (single file) while the album & playlist
 * menus use a `directory` picker. The hook just runs whatever the
 * parent returns once the user has picked a target.
 *
 * Backend "Save cancelled." is treated as a deliberate user action and
 * closes cleanly via `onClose` (the same UX across every menu).
 */
export type DeviceExportStatus = {
  /** UI label driving the spinner line, e.g. `Saving "Songtitle"…`. */
  label: string;
};

export type DeviceExportKind = "track" | "album" | "playlist";

export function useDeviceExport({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DeviceExportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const cancel = useCallback(() => {
    const id = activeRequestId;
    if (!id) return;
    setStatus({ label: "Cancelling…" });
    setError(null);
    void cancelSaveExport(id).catch(() => {
      // The cancel command itself is best-effort — if the backend already
      // cleaned up its registry entry (export just finished), the save
      // promise still resolves normally and lands on success / error
      // paths. Swallow so we never double-up.
    });
  }, [activeRequestId]);

  const start = useCallback(
    async <T,>({
      label,
      runExport,
      onNothingToExport,
    }: {
      label: string;
      /**
       * Hook already validated the request id and bumped `setStatus` for
       * the caller. The supplied function should perform the export
       * (calling the relevant `save*ToMp3` command with `requestId`)
       * and resolve once the backend has finished. Any thrown error
       * becomes a `saveError` (except `"Save cancelled."` which closes
       * the menu cleanly).
       */
      runExport: (activeRequestId: string) => Promise<T>;
      /** Optional error to surface when `runExport` decided nothing was exportable. */
      onNothingToExport?: string;
    }): Promise<T | null> => {
      if (onNothingToExport) {
        // Parent's `runExport` may pre-check `exportableCount` and decide
        // there's nothing to write. Surface as an error and skip the
        // actual export call.
        setError(onNothingToExport);
        return null;
      }
      const requestId = makeSaveExportRequestId();
      setActiveRequestId(requestId);
      setError(null);
      setStatus({ label });
      try {
        const result = await runExport(requestId);
        // Success: dismiss the menu so the row can refresh without
        // fighting the open popout.
        onClose();
        return result;
      } catch (err) {
        const message = formatInvokeError(err, "Failed to save to your device.");
        // The backend returns "Save cancelled." when the user aborted;
        // we close the menu silently so the UX feels like a deliberate
        // cancel, not a failure.
        if (message === "Save cancelled.") {
          onClose();
          return null;
        }
        setError(message);
        setStatus(null);
        return null;
      } finally {
        setActiveRequestId(null);
      }
    },
    [onClose],
  );

  const dismiss = useCallback(() => {
    setStatus(null);
    setError(null);
  }, []);

  return {
    /** `null` when not exporting. */
    status,
    /** Backend error message or `null`. */
    error,
    /** Active export's request id, or `null` when nothing is in flight. */
    activeRequestId,
    /** True while the spinner shows AND the user can still cancel. */
    canCancel: activeRequestId !== null && error === null,
    cancel,
    start,
    dismiss,
  };
}
