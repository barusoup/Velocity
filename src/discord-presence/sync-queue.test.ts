import { describe, expect, it } from "vitest";

import {
  collapseQueuedSync,
  isStaleIpcGeneration,
  isSupersededQueuedSync,
} from "./sync-queue";

describe("presence sync queue", () => {
  it("collapseQueuedSync keeps the newer generation", () => {
    const older = {
      payload: { enabled: true, title: "Older" },
      generation: 3,
    };
    const newer = {
      payload: { enabled: true, title: "Newer" },
      generation: 7,
    };

    expect(collapseQueuedSync(older, newer)).toEqual(newer);
    expect(collapseQueuedSync(newer, older)).toEqual(newer);
  });

  it("isSupersededQueuedSync flags stale queued generations", () => {
    expect(isSupersededQueuedSync(4, 6)).toBe(true);
    expect(isSupersededQueuedSync(6, 6)).toBe(false);
    expect(isSupersededQueuedSync(8, 6)).toBe(false);
  });

  it("isStaleIpcGeneration only matches exact engine head", () => {
    expect(isStaleIpcGeneration(5, 6)).toBe(true);
    expect(isStaleIpcGeneration(6, 6)).toBe(false);
  });
});