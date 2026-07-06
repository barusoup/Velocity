import { useEffect } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { installFullscreenBoundsRestore } from "../utils/window-fullscreen";

/**
 * Pin `--app-height` to the actual window height.
 *
 * Tauri 2 on Windows has been observed to leave `100dvh` stuck at the
 * pre-toggle value when the user enters or leaves OS fullscreen, so
 * the bottom of the app ends up clipped against the new (larger)
 * viewport. We track the real height in a CSS custom property,
 * refreshed on both the DOM `resize` event and Tauri's `onResized`
 * (which fires reliably for OS fullscreen transitions).
 */
export function useViewportHeightTracker(): void {
  useEffect(() => {
    const updateAppHeight = () => {
      document.documentElement.style.setProperty(
        "--app-height",
        `${window.innerHeight}px`,
      );
    };

    updateAppHeight();

    const handleWindowResize = () => updateAppHeight();
    window.addEventListener("resize", handleWindowResize);

    let unlistenTauriResize: (() => void) | undefined;
    let unlistenFullscreenRestore: (() => void) | undefined;

    getCurrentWindow()
      .onResized(() => updateAppHeight())
      .then((unlisten) => {
        unlistenTauriResize = unlisten;
      })
      .catch(() => {
        // Tauri's onResized isn't critical — fallback to the DOM resize
        // event which covers the same cases minus OS fullscreen.
      });

    void installFullscreenBoundsRestore().then((unlisten) => {
      unlistenFullscreenRestore = unlisten;
    });

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      unlistenTauriResize?.();
      unlistenFullscreenRestore?.();
    };
  }, []);
}
