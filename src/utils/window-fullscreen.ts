import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  type PhysicalPosition,
  type PhysicalSize,
} from "@tauri-apps/api/window";

type SavedWindowBounds = {
  size: PhysicalSize;
  position: PhysicalPosition;
};

let savedBounds: SavedWindowBounds | null = null;
let osWasFullscreen = false;
let appPseudoFullscreen = false;
let listenerInstalled = false;

async function saveBounds(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  const [size, position] = await Promise.all([win.outerSize(), win.outerPosition()]);
  savedBounds = { size, position };
  try {
    await invoke("remember_window_bounds");
  } catch (error) {
    console.warn("Could not persist window bounds for drag-restore:", error);
  }
}

async function restoreBounds(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  if (!savedBounds) return;
  const bounds = savedBounds;
  savedBounds = null;
  try {
    await win.setSize(bounds.size);
    await win.setPosition(bounds.position);
  } catch (error) {
    console.warn("Could not restore window bounds after fullscreen:", error);
  }
}

async function syncOsFullscreenState(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  const fs = await win.isFullscreen();
  if (!osWasFullscreen && fs) {
    await saveBounds(win);
  }
  if (osWasFullscreen && !fs && !appPseudoFullscreen) {
    await restoreBounds(win);
  }
  osWasFullscreen = fs;
}

/** Call once at app boot so any OS fullscreen exit path restores prior bounds. */
export async function installFullscreenBoundsRestore(): Promise<() => void> {
  if (listenerInstalled) return () => undefined;
  listenerInstalled = true;

  const win = getCurrentWindow();
  osWasFullscreen = await win.isFullscreen();
  if (osWasFullscreen) {
    await saveBounds(win);
  }

  try {
    appPseudoFullscreen = await invoke<boolean>("is_app_fullscreen");
  } catch {
    appPseudoFullscreen = false;
  }

  const unlisteners: Array<() => void> = [];

  const attach = async (
    subscribe: (
      handler: () => void,
    ) => Promise<() => void>,
  ) => {
    try {
      const unlisten = await subscribe(() => {
        void syncOsFullscreenState(win);
      });
      unlisteners.push(unlisten);
    } catch {
      // Optional listeners — ignore if unavailable on this platform/build.
    }
  };

  await attach((handler) => win.onResized(handler));
  await attach((handler) => win.onMoved(handler));
  await attach((handler) => win.onFocusChanged(handler));
  await attach((handler) => win.onScaleChanged(handler));

  return () => {
    listenerInstalled = false;
    for (const unlisten of unlisteners) unlisten();
  };
}

export async function toggleFullscreenWithBoundsRestore(): Promise<void> {
  const win = getCurrentWindow();

  try {
    let inAppFs = appPseudoFullscreen;
    try {
      inAppFs = await invoke<boolean>("is_app_fullscreen");
    } catch {
      // Fall back to the last known pseudo-fullscreen state.
    }

    const enabled = await invoke<boolean>("toggle_app_fullscreen");
    appPseudoFullscreen = enabled;

    if (!enabled) {
      // Windows restores bounds (and re-maximizes when needed) in Rust.
      savedBounds = null;
    }
    return;
  } catch (error) {
    console.warn("toggle_app_fullscreen failed, falling back:", error);
  }

  const fs = await win.isFullscreen();
  if (!fs) {
    await saveBounds(win);
    await win.setFullscreen(true);
    osWasFullscreen = true;
    return;
  }
  await win.setFullscreen(false);
  osWasFullscreen = false;
  await restoreBounds(win);
}