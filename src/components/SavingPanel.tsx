import { LoaderCircle, X } from "lucide-react";

/**
 * Inline status/control panel rendered in place of the context menu's
 * standard row list while a "Save to my device" export is in flight (or
 * after the backend rejects). The parent owns the state machine and
 * passes the current values + handlers down; this component is purely
 * presentational so every "Save to my device" menu across the app looks
 * and behaves identically.
 *
 * Three visual states, driven entirely by props:
 *   - exporting with cancel available      → spinner + label + Cancel
 *   - cancelling (UI hint, no cancel yet)  → spinner + "Cancelling…" (no Cancel)
 *   - failed                                → error icon + label + error msg + Dismiss
 *
 * Object-fit: parent decides whether to wrap this in its own idle panel
 * (when not in any state, return null).
 */
export function SavingPanel({
  status,
  error,
  cancelLabel,
  errorTitle,
  canCancel,
  onCancel,
  onDismiss,
}: {
  /** Label driving the spinner line, e.g. `Saving "Songtitle"…`. */
  status: string;
  /** Backend error message, or null when not in an error state. */
  error: string | null;
  /** Header label used when `errorTitle` isn't overridden by the caller. */
  cancelLabel?: string;
  /** Override the default error header ("Couldn't save track" etc.). */
  errorTitle?: string;
  /** Cancel affordance is only enabled while the export is in-flight. */
  canCancel: boolean;
  /** Fires on Cancel. Parent routes to the backend's cancel command. */
  onCancel: () => void;
  /** Fires on Dismiss (only available when `error !== null`). */
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 text-sm text-white/72">
      <div className="flex items-center gap-3">
        {error ? (
          <span className="shrink-0 text-red-400">
            <X size={16} strokeWidth={1.8} />
          </span>
        ) : (
          <span className="shrink-0 text-white/72">
            <LoaderCircle size={16} className="animate-spin" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-semibold">
          {error ? (errorTitle ?? "Couldn't save to device") : status}
        </span>
        {canCancel && !error && (
          <button
            type="button"
            onClick={onCancel}
            // Matches the destructive-row hover treatment used elsewhere in
            // the menu so the button reads as the "stop" affordance.
            className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/72 transition-colors hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-200"
          >
            {cancelLabel ?? "Cancel"}
          </button>
        )}
      </div>
      {error && (
        <>
          <p className="pl-7 text-xs leading-relaxed text-red-300/90">{error}</p>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-1 self-start rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/72 transition-colors hover:bg-white/10 hover:text-white"
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
