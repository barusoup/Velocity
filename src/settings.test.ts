import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, getSettings, resetAllSettings, setSetting, SETTINGS_KEY } from "./settings";

const storage = new Map<string, string>();

describe("settings persistence and defaults", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
    resetAllSettings();
  });

  it("factory default has sidebar collapsed, now playing menu open, and hide now playing on lyrics enabled", () => {
    // With no localStorage key set
    storage.clear();
    const settings = getSettings();
    expect(settings.sidebarOpen).toBe(false);
    expect(settings.nowPlayingOpen).toBe(true);
    expect(settings.hideNowPlayingOnLyrics).toBe(true);
    expect(getSetting("sidebarOpen")).toBe(false);
    expect(getSetting("nowPlayingOpen")).toBe(true);
    expect(getSetting("hideNowPlayingOnLyrics")).toBe(true);
  });

  it("persists user adjustments to sidebar and now playing menu across reads", () => {
    setSetting("sidebarOpen", true);
    setSetting("nowPlayingOpen", false);
    setSetting("hideNowPlayingOnLyrics", false);

    expect(getSetting("sidebarOpen")).toBe(true);
    expect(getSetting("nowPlayingOpen")).toBe(false);
    expect(getSetting("hideNowPlayingOnLyrics")).toBe(false);

    // Verify stored JSON has the new values
    const raw = storage.get(SETTINGS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.sidebarOpen).toBe(true);
    expect(parsed.nowPlayingOpen).toBe(false);
    expect(parsed.hideNowPlayingOnLyrics).toBe(false);

    // Re-read settings object
    const fresh = getSettings();
    expect(fresh.sidebarOpen).toBe(true);
    expect(fresh.nowPlayingOpen).toBe(false);
    expect(fresh.hideNowPlayingOnLyrics).toBe(false);
  });

  it("resetAllSettings restores sidebar to collapsed and now playing to open", () => {
    setSetting("sidebarOpen", true);
    setSetting("nowPlayingOpen", false);
    setSetting("hideNowPlayingOnLyrics", false);

    resetAllSettings();

    expect(getSetting("sidebarOpen")).toBe(false);
    expect(getSetting("nowPlayingOpen")).toBe(true);
    expect(getSetting("hideNowPlayingOnLyrics")).toBe(true);
  });
});
