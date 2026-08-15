import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveLeadingSilenceSkipSeconds,
  getCachedLeadingSilence,
  setCachedLeadingSilence,
  hasAttemptedLeadingSilenceAnalysis,
  resetLeadingSilenceCacheForTests,
  LEADING_SILENCE_ANALYSIS_VERSION,
  MIN_LEADING_SILENCE_SKIP,
  MAX_LEADING_SILENCE_SKIP,
} from "./leading-silence";

const storage = new Map<string, string>();

describe("leading silence detection and skip resolution", () => {
  beforeEach(() => {
    storage.clear();
    resetLeadingSilenceCacheForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    });
  });

  describe("resolveLeadingSilenceSkipSeconds", () => {
    it("returns 0 when track has no cached entry", () => {
      expect(resolveLeadingSilenceSkipSeconds("unknown-track")).toBe(0);
    });

    it("returns 0 when cached skip is null", () => {
      setCachedLeadingSilence("null-skip", { skipSeconds: null });
      expect(resolveLeadingSilenceSkipSeconds("null-skip")).toBe(0);
    });

    it("returns 0 when skip is below the minimum threshold", () => {
      setCachedLeadingSilence("tiny-skip", { skipSeconds: 0.1 });
      expect(resolveLeadingSilenceSkipSeconds("tiny-skip")).toBe(0);
    });

    it("returns valid skip seconds above or equal to minimum threshold", () => {
      setCachedLeadingSilence("min-skip", { skipSeconds: MIN_LEADING_SILENCE_SKIP });
      expect(resolveLeadingSilenceSkipSeconds("min-skip")).toBe(MIN_LEADING_SILENCE_SKIP);

      setCachedLeadingSilence("typical-skip", { skipSeconds: 1.45 });
      expect(resolveLeadingSilenceSkipSeconds("typical-skip")).toBe(1.45);

      setCachedLeadingSilence("long-skip", { skipSeconds: 5.2 });
      expect(resolveLeadingSilenceSkipSeconds("long-skip")).toBe(5.2);
    });

    it("caps skip seconds at the maximum threshold", () => {
      setCachedLeadingSilence("huge-skip", { skipSeconds: 45.0 });
      expect(resolveLeadingSilenceSkipSeconds("huge-skip")).toBe(MAX_LEADING_SILENCE_SKIP);
    });
  });

  describe("cache versioning and invalidation", () => {
    it("invalidates stale cached entries from older versions", () => {
      localStorage.setItem(
        "velocity-leading-silence-cache",
        JSON.stringify({
          "v5-track": { skipSeconds: 1.0, analysisVersion: 5 },
          "v4-track": { skipSeconds: 0.25, analysisVersion: 4 },
          "old-track": { skipSeconds: null, analysisVersion: 3 },
          "v2-track": { skipSeconds: 2.0, analysisVersion: 2 },
        }),
      );

      expect(getCachedLeadingSilence("v5-track")).toBeNull();
      expect(hasAttemptedLeadingSilenceAnalysis("v5-track")).toBe(false);
      expect(resolveLeadingSilenceSkipSeconds("v5-track")).toBe(0);

      expect(getCachedLeadingSilence("v4-track")).toBeNull();
      expect(hasAttemptedLeadingSilenceAnalysis("v4-track")).toBe(false);
      expect(resolveLeadingSilenceSkipSeconds("v4-track")).toBe(0);

      expect(getCachedLeadingSilence("old-track")).toBeNull();
      expect(hasAttemptedLeadingSilenceAnalysis("old-track")).toBe(false);
      expect(resolveLeadingSilenceSkipSeconds("old-track")).toBe(0);

      expect(getCachedLeadingSilence("v2-track")).toBeNull();
      expect(hasAttemptedLeadingSilenceAnalysis("v2-track")).toBe(false);
    });

    it("stores and retrieves entries with current analysis version", () => {
      setCachedLeadingSilence("fresh-track", { skipSeconds: 2.3 });
      const cached = getCachedLeadingSilence("fresh-track");
      expect(cached).not.toBeNull();
      expect(cached?.skipSeconds).toBe(2.3);
      expect(cached?.analysisVersion).toBe(LEADING_SILENCE_ANALYSIS_VERSION);
      expect(hasAttemptedLeadingSilenceAnalysis("fresh-track")).toBe(true);
    });
  });
});
