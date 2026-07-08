import { describe, expect, it } from "vitest";
import { findActiveLyricIndex, hasValidLyricSync } from "./lyrics";
import type { TimedLyricLine } from "./types";

function line(startTimeMs: number, text: string): TimedLyricLine {
  return {
    id: startTimeMs,
    text,
    startTimeMs,
    endTimeMs: startTimeMs + 1000,
  };
}

describe("hasValidLyricSync", () => {
  it("accepts monotonic lyrics with distinct timestamps", () => {
    expect(
      hasValidLyricSync([
        line(0, "one"),
        line(2000, "two"),
        line(4000, "three"),
      ]),
    ).toBe(true);
  });

  it("rejects lyrics that share a single timestamp", () => {
    expect(
      hasValidLyricSync([
        line(0, "one"),
        line(0, "two"),
        line(0, "three"),
      ]),
    ).toBe(false);
  });

  it("rejects non-monotonic timestamps", () => {
    expect(
      hasValidLyricSync([
        line(0, "one"),
        line(5000, "two"),
        line(3000, "three"),
      ]),
    ).toBe(false);
  });
});

describe("findActiveLyricIndex", () => {
  it("tracks the latest line whose start time has passed", () => {
    const lines = [
      line(0, "one"),
      line(2000, "two"),
      line(4000, "three"),
    ];
    expect(findActiveLyricIndex(lines, 0)).toBe(0);
    expect(findActiveLyricIndex(lines, 2.5)).toBe(1);
    expect(findActiveLyricIndex(lines, 5)).toBe(2);
  });
});