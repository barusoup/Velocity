import { useCallback, useEffect, useRef, useState } from "react";
import { useCollection } from "../collection";
import { usePlayer } from "../player";
import {
  type Settings,
  getSetting,
  getSettings,
  setSetting,
  resetAllSettings,
  clearAllUserData,
  subscribe,
} from "../settings";
import { clearAllOffline, saveOffline } from "../api";
import { ConfirmDialog } from "./Shared";

type ConfirmAction = "configs" | "data" | "offline" | null;

const EQ_FREQUENCIES = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"] as const;

function ToggleRow({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string;
  description?: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-neutral-400">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`group relative h-7 w-[3.25rem] shrink-0 rounded-full transition-colors duration-300 ease-out outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
          enabled
            ? "bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.08),0_0_18px_rgba(255,255,255,0.18)]"
            : "bg-white/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)] hover:bg-white/[0.13]"
        }`}
      >
        <span
          className={`absolute top-[3px] block h-[22px] w-[22px] rounded-full shadow-[0_2px_6px_rgba(0,0,0,0.45),0_1px_2px_rgba(0,0,0,0.25)] transition-[translate,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            enabled
              ? "translate-x-[27px] bg-neutral-900"
              : "translate-x-[3px] bg-white"
          }`}
        />
      </button>
    </div>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <div className="border-b border-white/8 pb-2">
      <h2 className="text-xs font-bold tracking-[0.06em] text-neutral-500">
        {children}
      </h2>
    </div>
  );
}

function DangerButton({
  label,
  description,
  onClick,
}: {
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-neutral-400">{description}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClick}
        className="shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-1.5 text-sm font-medium text-red-400 transition hover:bg-red-500/20 hover:text-red-300"
      >
        {label}
      </button>
    </div>
  );
}

export function SettingsPage() {
  const collection = useCollection();
  const player = usePlayer();
  const [settings, setSettingsState] = useState<Settings>(getSettings);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [masterVolumeLabel, setMasterVolumeLabel] = useState(() => {
    const v = getSettings().masterVolume;
    return formatMasterVolume(v);
  });

  // Kept as a ref so the ref-capturing callback below can read the
  // current collection without re-creating on every save/unsave. Without
  // this the archive-on-toggle would force `updateSetting` to a fresh
  // function identity on each `savedSongs` mutation, which then re-renders
  // every ToggleRow in this page even though nothing about the toggles
  // actually changed.
  const savedSongsRef = useRef(collection.savedSongs);
  savedSongsRef.current = collection.savedSongs;

  useEffect(() => {
    const unsub = subscribe((key, _value) => {
      if (key === "__all__" || key === "masterVolume" || key === "equalizerBands") {
        const s = getSettings();
        setSettingsState(s);
        if (key === "__all__" || key === "masterVolume") {
          setMasterVolumeLabel(formatMasterVolume(s.masterVolume));
        }
      }
    });
    return unsub;
  }, []);

  const updateSetting = useCallback(<K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => {
    setSetting(key, value);
    setSettingsState((prev) => ({ ...prev, [key]: value }));
    if (key === "masterVolume") {
      setMasterVolumeLabel(formatMasterVolume(value as number));
      // Apply the new master volume to the live audio graph immediately.
      // The reactive `useSetting` path in player.tsx re-runs the
      // applyOutputLevels effect on a state change, but that round-trip is
      // async to a user dragging a slider: the volume state updates on the
      // next React commit, and the gainNode/audio.volume update follows
      // after. Calling `player.setLiveVolume(player.volume)` here re-applies
      // the gain synchronously, using `getSetting("masterVolume")` to read
      // the value we just wrote. This is the same path PlayerBar uses for
      // its own live-drag handler, so the audio output tracks the slider
      // with no perceptible delay on every tick.
      player.setLiveVolume(player.volume);
    }
    if (key === "launchOnStartup") {
      setLaunchOnStartup(value as boolean);
    }
    // When the user enables offline sync, retroactively backfill offline
    // files for every track already in the collection. Without this fire
    // the toggle only affected future saves (each individual Save action
    // reads the setting), and the user had to unsave/resave every song
    // they wanted offline. Fired with `.catch(() => {})` so a failed
    // download for one track can't take the rest down with it. Uses the
    // ref snapshot above so the callback can stay referentially stable
    // across saves.
    if (key === "offlineSync" && value === true) {
      for (const track of savedSongsRef.current) {
        if (track.source === "stream" && track.videoId) {
          saveOffline(track.videoId).catch(() => {});
        }
      }
    }
  }, []);

  const handleClearConfigs = useCallback(() => {
    resetAllSettings();
    setConfirmAction(null);
    const s = getSettings();
    setSettingsState(s);
    setMasterVolumeLabel(formatMasterVolume(s.masterVolume));
    // Re-apply the live audio gain with the (now-defaulted) master volume so
    // a reset from settings reflects in the audio output immediately,
    // rather than waiting for the next volume/muted/normGain mutation.
    player.setLiveVolume(player.volume);
  }, [player]);

  const handleClearAllData = useCallback(async () => {
    setConfirmAction(null);
    // clearAllUserData is now async — it awaits the dynamic-imported
    // api.ts calls to remove imported tracks and offline files before
    // resolving. The previous fire-and-forget behavior let
    // `window.location.reload()` race the in-flight filesystem deletes
    // and orphan them, leaving user data on disk. Awaiting guarantees
    // the wipe completes before the webview tears down.
    try {
      await clearAllUserData();
    } catch {
      // Even if the async wipe failed, the localStorage side of the
      // operation already happened (clearAllUserData clears keys before
      // awaiting any backend calls), so a reload still gives the user a
      // clean app shell to retry from.
    }
    const s = getSettings();
    setSettingsState(s);
    setMasterVolumeLabel(formatMasterVolume(s.masterVolume));
    window.location.reload();
  }, []);

  const handleDisableOfflineSync = useCallback(() => {
    clearAllOffline().catch(() => {});
    updateSetting("offlineSync", false);
    setConfirmAction(null);
  }, [updateSetting]);

  const handleKeepOfflineFiles = useCallback(() => {
    updateSetting("offlineSync", false);
    setConfirmAction(null);
  }, [updateSetting]);

  const handleEqBandChange = useCallback((index: number, gain: number) => {
    const bands = [...(getSetting("equalizerBands") ?? Array(10).fill(0))];
    bands[index] = gain;
    updateSetting("equalizerBands", bands);
    player.setEqualizerBand(index, gain);
  }, [updateSetting, player]);

  const handleEqReset = useCallback(() => {
    updateSetting("equalizerBands", Array(10).fill(0));
    for (let i = 0; i < 10; i++) {
      player.setEqualizerBand(i, 0);
    }
  }, [updateSetting, player]);

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Configure app behavior and manage your data
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <SectionHeader>General</SectionHeader>
          <div className="divide-y divide-white/5">
            <ToggleRow
              label="Launch on startup"
              description="Automatically start the app when your computer boots up"
              enabled={settings.launchOnStartup}
              onChange={(v) => updateSetting("launchOnStartup", v)}
            />
            <ToggleRow
              label="Start minimized"
              description="Launch the app minimized to the system tray"
              enabled={settings.startMinimized}
              onChange={(v) => updateSetting("startMinimized", v)}
            />
            <ToggleRow
              label="Always show search bar"
              description="Keep the search bar visible instead of hiding when not in use"
              enabled={settings.alwaysShowSearch}
              onChange={(v) => updateSetting("alwaysShowSearch", v)}
            />
          </div>
        </section>

        <section>
          <SectionHeader>Playback</SectionHeader>
          <div className="divide-y divide-white/5">
            <ToggleRow
              label="Audio normalization"
              description="Automatically balance volume across different tracks"
              enabled={settings.audioNormalization}
              onChange={(v) => updateSetting("audioNormalization", v)}
            />
            <ToggleRow
              label="Play/pause crossfade"
              description="Smoothly fade between tracks when playing or pausing"
              enabled={settings.crossfade}
              onChange={(v) => updateSetting("crossfade", v)}
            />

            <div className="py-3">
              <div className="mb-2 text-sm font-medium text-white">
                Master volume
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={settings.masterVolume}
                  onChange={(event) =>
                    updateSetting("masterVolume", Number(event.target.value))
                  }
                  className="slider slider-volume flex-1"
                />
                <span className="w-20 shrink-0 text-right text-sm tabular-nums text-neutral-300">
                  {masterVolumeLabel}
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Offset from default volume. Adjusts the overall output level of
                the app.
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between border-b border-white/8 pb-2">
            <h2 className="text-xs font-bold tracking-[0.06em] text-neutral-500">
              Equalizer
            </h2>
            <button
              type="button"
              onClick={handleEqReset}
              className="rounded-full border border-neutral-700 px-4 py-1.5 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
            >
              Reset
            </button>
          </div>
          <div className="py-3">
            <div className="flex items-end justify-center gap-0 px-2">
              {EQ_FREQUENCIES.map((freq, i) => {
                const gain = settings.equalizerBands?.[i] ?? 0;
                return (
                  <div key={freq} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] tabular-nums text-neutral-500">
                      {gain > 0 ? `+${gain}` : gain}
                    </span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={1}
                      value={gain}
                      onChange={(e) => handleEqBandChange(i, Number(e.target.value))}
                      className="slider-eq h-32 w-full"
                      style={{
                        writingMode: "vertical-lr",
                        direction: "rtl",
                      }}
                    />
                    <span className="text-[10px] text-neutral-500">{freq}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section>
          <SectionHeader>Display</SectionHeader>
          <div className="divide-y divide-white/5">
            <ToggleRow
              label="Hide media player on lyrics"
              description="Auto-hide the player bar when viewing the lyrics page"
              enabled={settings.hidePlayerOnLyrics}
              onChange={(v) => updateSetting("hidePlayerOnLyrics", v)}
            />
            <ToggleRow
              label="Remember playback position"
              description="Save the elapsed time of the current song between sessions"
              enabled={settings.saveTimestamp}
              onChange={(v) => updateSetting("saveTimestamp", v)}
            />
          </div>
        </section>

        <section>
          <SectionHeader>Offline</SectionHeader>
          <div className="divide-y divide-white/5">
            <ToggleRow
              label="Save songs for offline playback"
              description="When enabled, songs added to your collection are automatically downloaded for offline listening. Disabling will prompt to remove downloaded files."
              enabled={settings.offlineSync}
              onChange={(v) => {
                if (!v) {
                  setConfirmAction("offline");
                } else {
                  updateSetting("offlineSync", true);
                }
              }}
            />
          </div>
        </section>

        <section>
          <SectionHeader>Data Management</SectionHeader>
          <div className="divide-y divide-white/5">
            <DangerButton
              label="Clear all configs"
              description="Reset all settings to their defaults without removing your songs"
              onClick={() => setConfirmAction("configs")}
            />
            <DangerButton
              label="Clear all user data"
              description="Factory reset — removes all local songs, configs, and preferences"
              onClick={() => setConfirmAction("data")}
            />
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmAction === "configs"}
        title="Reset all configs?"
        message="This will reset every setting to its default value. Your saved songs, albums, and uploaded tracks will not be affected."
        confirmLabel="Reset configs"
        onConfirm={handleClearConfigs}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={confirmAction === "data"}
        title="Clear all user data?"
        message="This will permanently delete all local songs, uploaded tracks, saved albums, playlists, and every app setting. This action cannot be undone."
        confirmLabel="Delete everything"
        onConfirm={handleClearAllData}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={confirmAction === "offline"}
        title="Disable offline sync?"
        message="Turning off offline sync will delete all downloaded songs from your local machine. Your saved songs in the collection will NOT be unsaved — only the local audio files will be removed. Locally uploaded songs are not affected."
        confirmLabel="Delete local files"
        onConfirm={handleDisableOfflineSync}
        onCancel={() => {
          setConfirmAction(null);
        }}
        secondaryLabel="Keep files"
        onSecondary={() => {
          handleKeepOfflineFiles();
        }}
      />
    </div>
  );
}

async function setLaunchOnStartup(enabled: boolean): Promise<void> {
  try {
    const { enable, disable } = await import("@tauri-apps/plugin-autostart");
    if (enabled) {
      await enable();
    } else {
      await disable();
    }
  } catch {
    // Plugin not available — preference is still saved locally.
  }
}

function formatMasterVolume(value: number): string {
  if (value === 0) return "0 dB";
  return value > 0 ? `+${value} dB` : `${value} dB`;
}
