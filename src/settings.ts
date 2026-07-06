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
  hidePlayerOnLyrics: boolean;
  hideSearchOnLyrics: boolean;
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
};

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
  hidePlayerOnLyrics: false,
  hideSearchOnLyrics: false,
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
};

export function getSettings(): Settings {
  try {
    const raw = getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return getSettings()[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const current = getSettings();
  current[key] = value;
  storeSetItem(SETTINGS_KEY, JSON.stringify(current));
  notifyListeners(key, value);
}

export function resetAllSettings(): void {
  storeSetItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULTS }));
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
// output gain when masterVolume changes, PlayerBar omitting itself when
// hidePlayerOnLyrics is toggled, Sidebar/TopBar suppressing the search
// bar when hideSearchOnLyrics is toggled or keeping it visible when
// alwaysShowSearch is toggled) should
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
    const tracks = await listImportedTracks().catch(() => [] as Awaited<ReturnType<typeof listImportedTracks>>);
    await Promise.all(
      tracks.map((t) => removeImportedTrack(t.id).catch(() => {})),
    );
  } catch {
    // Dynamic import or one of the operations failed — leave whatever
    // did succeed and let the user try again.
  }
}
