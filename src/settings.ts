import { useEffect, useState } from "react";
import { getItem, setItem as storeSetItem, clearAll } from "./storage";

export type ViewMode = "list" | "compact";
export type DiscographyViewMode = "list" | "grid";

export type Settings = {
  launchOnStartup: boolean;
  startMinimized: boolean;
  alwaysShowSearch: boolean;
  searchSuggestions: boolean;
  audioNormalization: boolean;
  crossfade: boolean;
  masterVolume: number;
  equalizerBands: number[];
  // Hide the sidebar on the lyrics page (revealed on left-edge hover /
  // Ctrl+B). The media player is never hidden there.
  hideSidebarOnLyrics: boolean;
  // Hide the Now Playing menu on the lyrics page (revealed on right-edge hover
  // or toggle button).
  hideNowPlayingOnLyrics: boolean;
  saveTimestamp: boolean;
  offlineSync: boolean;
  lyricsDistanceFade: boolean;
  discordRichPresence: boolean;
  showHomeMenu: boolean;
  showHomeTopSongs: boolean;
  showHomeTodaysPicks: boolean;
  // Consolidated into the settings blob instead of a per-key
  // `velocity-autoplay` echo so the persistence is atomic per-tick
  // (one IPC write per settings change rather than a fire-and-forget
  // per-key race). Default is `true` so fresh installs ship autoplay
  // ON out of the box — if no saved value is present, `getSettings()`
  // spreads `DEFAULTS` and serves `autoplay: true`.
  autoplay: boolean;
  viewModeCollectionSongs: ViewMode;
  viewModeCollectionLocal: ViewMode;
  viewModeAlbum: ViewMode;
  viewModePlaylist: ViewMode;
  viewModeDiscography: DiscographyViewMode;
  compactDownloads: boolean;
  exportFormat: ExportFormat;
  sidebarOpen: boolean;
  nowPlayingOpen: boolean;
};

export type ExportFormat = "native" | "opus" | "mp3";

// Exported so callers (e.g. `player.tsx`'s autoplay migration) can
// distinguish between "the saved-settings blob has its own autoplay
// key" and "getSettings()'s DEFAULTS spread is masking the absence
// of a user-saved value". `getSettings()` always returns a fully
// populated object (DEFAULTS + saved), so it can't tell those two
// states apart on its own.
export const SETTINGS_KEY = "velocity-settings";

const DEFAULTS: Settings = {
  launchOnStartup: false,
  startMinimized: false,
  alwaysShowSearch: false,
  searchSuggestions: true,
  audioNormalization: true,
  crossfade: true,
  masterVolume: 0,
  equalizerBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  hideSidebarOnLyrics: false,
  hideNowPlayingOnLyrics: true,
  saveTimestamp: true,
  offlineSync: true,
  lyricsDistanceFade: true,
  discordRichPresence: true,
  showHomeMenu: true,
  showHomeTopSongs: true,
  showHomeTodaysPicks: true,
  viewModeCollectionSongs: "list",
  viewModeCollectionLocal: "list",
  viewModeAlbum: "list",
  viewModePlaylist: "list",
  viewModeDiscography: "list",
  autoplay: true,
  compactDownloads: false,
  exportFormat: "opus",
  sidebarOpen: false,
  nowPlayingOpen: true,
};

let _cachedSettings: Settings | null = null;
let _cachedRaw: string | null = null;

export function getSettings(): Settings {
  try {
    const raw = getItem(SETTINGS_KEY);
    if (raw === _cachedRaw && _cachedSettings) return _cachedSettings!;
    if (!raw) {
      _cachedRaw = null;
      _cachedSettings = { ...DEFAULTS };
      return _cachedSettings!;
    }
    if (raw === _cachedRaw && _cachedSettings) return _cachedSettings!;
    const parsed = JSON.parse(raw);
    _cachedRaw = raw;
    // The lyrics-page chrome settings were consolidated over time: the old
    // per-element toggles (hidePlayerOnLyrics / hideSearchOnLyrics) became
    // hideControlsOnLyrics, and that is now a sidebar-only toggle
    // (hideSidebarOnLyrics — the media player is never hidden on lyrics).
    // Carry over the intermediate key so a user who had the toggle on
    // keeps it; the player/search preferences are obsolete and dropped.
    const merged: Settings = { ...DEFAULTS, ...parsed };
    if (parsed.hideSidebarOnLyrics === undefined && parsed.hideControlsOnLyrics === true) {
      merged.hideSidebarOnLyrics = true;
    }
    _cachedSettings = merged;
    return merged;
  } catch {
    _cachedRaw = null;
    _cachedSettings = { ...DEFAULTS };
    return _cachedSettings!;
  }
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return getSettings()[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const current = { ...getSettings(), [key]: value };
  const serialized = JSON.stringify(current);
  _cachedRaw = serialized;
  _cachedSettings = current;
  storeSetItem(SETTINGS_KEY, serialized);
  notifyListeners(key, value);
}

export function resetAllSettings(): void {
  const serialized = JSON.stringify({ ...DEFAULTS });
  _cachedRaw = serialized;
  _cachedSettings = { ...DEFAULTS };
  storeSetItem(SETTINGS_KEY, serialized);
  notifyListeners("__all__", null);
}

type Listener = (key: string, value: unknown) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(key: string, value: unknown): void {
  for (const listener of listeners) {
    try {
      listener(key, value);
    } catch {
      // Listener errors must not break other listeners or the writer.
    }
  }
}

// Reactive variant of getSetting: subscribes to local changes so the
// consuming component re-renders with the up-to-date value. Components
// that need to react to setting changes (e.g. player.tsx re-applying the
// output gain when masterVolume changes, App/Sidebar re-hiding the
// sidebar when hideSidebarOnLyrics is toggled, or TopBar keeping the
// search bar visible when alwaysShowSearch is toggled) should
// use this hook instead of `getSetting`, which only returns a snapshot.
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  const [value, setValue] = useState<Settings[K]>(() => getSettings()[key]);

  useEffect(() => {
    // Re-sync on mount in case settings changed between the initial state
    // lazy initializer and this effect running (e.g. from another tab or
    // from a settings reset that fired while the component was suspended).
    setValue(getSettings()[key]);
    return subscribe((changedKey, _value) => {
      // "__all__" is the broadcast key used by `resetAllSettings` (which
      // re-publishes every key at once so consumers can re-sync without
      // listening to one setting at a time) and by `clearAllUserData`
      // (which wrecks the saved-songs / albums stores independently from
      // the settings object but still emits a broadcast so the player and
      // Sidebar settle back to defaults). Either way, re-read from
      // getSettings() so any subscribed component trusts the same source
      // of truth as `setSetting`.
      if (changedKey === key || changedKey === "__all__") {
        setValue(getSettings()[key]);
      }
    });
  }, [key]);

  return value;
}

export async function clearAllUserData(): Promise<void> {
  await clearAll();

  notifyListeners("__all__", null);

  // The previous implementation fired-and-forgot these async deletes,
  // which let callers like SettingsPage immediately call
  // `window.location.reload()` and orphan the in-flight filesystem
  // operations. Awaiting guarantees the imports / offline files are
  // fully removed before the window tears down. Errors are swallowed
  // (matching the previous swallowing) because a partial wipe is still
  // safer than blocking the user from exiting the dialog.
  try {
    const { listImportedTracks, removeImportedTrack, clearAllOffline } = await import("./api");
    await clearAllOffline().catch(() => {});
    // Files are gone — drop every "downloaded" badge too, and cancel any
    // queued / retry-pending background download so it can't re-create
    // files after the wipe.
    const { useOfflineStatusStore } = await import("./store/offlineStatusStore");
    useOfflineStatusStore.getState().clearAll();
    const { cancelAllOfflineSync } = await import("./utils/offline-download-queue");
    cancelAllOfflineSync();
    const { cancelSavedCollectionRepair, clearRepairState } = await import("./utils/saved-collection-repair");
    cancelSavedCollectionRepair();
    clearRepairState();
    const tracks = await listImportedTracks().catch(() => [] as Awaited<ReturnType<typeof listImportedTracks>>);
    await Promise.all(
      tracks.map((t) => removeImportedTrack(t.id).catch(() => {})),
    );
  } catch {
    // Dynamic import or one of the operations failed — leave whatever
    // did succeed and let the user try again.
  }
}
