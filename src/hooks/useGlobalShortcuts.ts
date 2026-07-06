import { useCallback, useEffect } from "react";

import { getPlayerProgress } from "../store/playerUiStore";
import { usePlayer } from "../player";
import { toggleFullscreenWithBoundsRestore } from "../utils/window-fullscreen";

/**
 * Global keyboard shortcuts hook.
 *
 * Mounts a single document-level `keydown` listener that handles
 * transport + sidebar controls:
 *   - Space                                                            →  togglePlay
 *   - Ctrl+B / Cmd+B                                                   →  sidebar toggle
 *   - ArrowLeft                                                        →  seek back 5s
 *   - ArrowRight                                                       →  seek forward 5s
 *   - ArrowUp / ArrowDown                                              →  volume ±5%
 *   - S                                                                →  toggleShuffle
 *   - L                                                                →  cycleRepeat
 *   - M                                                                →  toggleMute
 *   - F11                                                              →  OS fullscreen toggle
 *
 * Targets inside `input / textarea / select / contenteditable` are
 * ignored so typing in the search bar doesn't toggle the player.
 */
export function useGlobalShortcuts({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}): void {
  const player = usePlayer();

  const handler = useCallback(
    (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalKeyShortcut(event.target, event.defaultPrevented)) return;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (player.currentTrack) player.togglePlay();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === "b" || event.key === "B")) {
        event.preventDefault();
        onToggleSidebar();
        return;
      }
      if (event.key === "ArrowLeft") {
        // Ignore modified arrows — Win+Shift+Left/Right (monitor snap) and
        // other OS shortcuts can still deliver ArrowLeft/Right to the webview.
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (player.currentTrack) player.seek(getPlayerProgress() - 5);
        return;
      }
      if (event.key === "ArrowRight") {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (player.currentTrack) player.seek(getPlayerProgress() + 5);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        player.setVolume(player.volume + 0.05);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        player.setVolume(player.volume - 0.05);
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        player.toggleShuffle();
        return;
      }
      if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        player.cycleRepeat();
        return;
      }
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        player.toggleMute();
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        void toggleFullscreenWithBoundsRestore();
      }
    },
    [onToggleSidebar, player],
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}

function shouldIgnoreGlobalKeyShortcut(
  target: EventTarget | null,
  defaultPrevented: boolean,
): boolean {
  if (defaultPrevented) return true;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
