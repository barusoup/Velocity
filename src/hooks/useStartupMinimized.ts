import { useEffect } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { getSetting } from "../settings";

/**
 * Start-minimized on startup.
 *
 * When the user's `startMinimized` setting is enabled, minimize the OS
 * window after the splash screen has actually painted. We wait two
 * animation frames so the minimize request doesn't race the splash
 * teardown (which itself defers via double-rAF); without this the
 * splash is briefly visible in the taskbar pre-minimize state.
 */
export function useStartupMinimized(): void {
  useEffect(() => {
    if (!getSetting("startMinimized")) return;
    let raf1: number | null = null;
    let raf2: number | null = null;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        getCurrentWindow()
          .minimize()
          .catch((error) => console.warn("Failed to minimize on startup:", error));
      });
    });
    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  }, []);
}
