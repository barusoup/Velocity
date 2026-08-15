import { describe, expect, it } from "vitest";
import { lookupContextTrack, registerContextTrack } from "./track-context-registry";
import type { MediaTrack } from "../types";

function sampleTrack(overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: "yt:track-1",
    title: "Track 1",
    artist: "Artist 1",
    durationSeconds: 180,
    source: "stream",
    ...overrides,
  };
}

describe("track-context-registry", () => {
  it("registers and looks up tracks by id", () => {
    const track = sampleTrack({ id: "yt:single-1" });
    const unregister = registerContextTrack(track);

    expect(lookupContextTrack("yt:single-1")).toBe(track);

    unregister();
    expect(lookupContextTrack("yt:single-1")).toBeNull();
  });

  it("handles concurrent multi-registrations of the same track id without losing the remaining registration", () => {
    const pageTrack = sampleTrack({ id: "yt:shared-1", title: "Page Track" });
    const queueTrack = sampleTrack({ id: "yt:shared-1", title: "Queue Track" });

    const unregisterPage = registerContextTrack(pageTrack);
    const unregisterQueue = registerContextTrack(queueTrack);

    expect(lookupContextTrack("yt:shared-1")).toBeDefined();

    // When the queue unmounts / unregisters, the page registration should remain available
    unregisterQueue();
    expect(lookupContextTrack("yt:shared-1")).toBe(pageTrack);

    // When the page unregisters, the registry entry should be completely removed
    unregisterPage();
    expect(lookupContextTrack("yt:shared-1")).toBeNull();
  });
});
