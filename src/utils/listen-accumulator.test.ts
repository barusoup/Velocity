import { describe, expect, it } from "vitest";
import {
  createListenSession,
  sampleListenProgress,
} from "./listen-accumulator";

const DURATION = 200;
const RATIO = 0.75;
const THRESHOLD = DURATION * RATIO;

describe("sampleListenProgress", () => {
  it("does not qualify from a single seek past the threshold", () => {
    let session = createListenSession("t1", 0);
    const result = sampleListenProgress(session, {
      trackId: "t1",
      progress: 170,
      duration: DURATION,
      isPlaying: true,
      qualifyRatio: RATIO,
    });
    expect(result.newlyQualified).toBe(false);
    expect(result.session.accumulatedSeconds).toBe(0);
  });

  it("qualifies after enough continuous listening", () => {
    let session = createListenSession("t1", 0);
    let qualified = false;

    for (let progress = 1; progress <= THRESHOLD + 1; progress += 1) {
      const result = sampleListenProgress(session, {
        trackId: "t1",
        progress,
        duration: DURATION,
        isPlaying: true,
        qualifyRatio: RATIO,
      });
      session = result.session;
      if (result.newlyQualified) qualified = true;
    }

    expect(qualified).toBe(true);
    expect(session.accumulatedSeconds).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("does not count seek-forward gaps toward accumulated time", () => {
    let session = createListenSession("t1", 0);

    for (let progress = 1; progress <= 40; progress += 1) {
      session = sampleListenProgress(session, {
        trackId: "t1",
        progress,
        duration: DURATION,
        isPlaying: true,
        qualifyRatio: RATIO,
      }).session;
    }

    session = sampleListenProgress(session, {
      trackId: "t1",
      progress: 160,
      duration: DURATION,
      isPlaying: true,
      qualifyRatio: RATIO,
    }).session;

    expect(session.accumulatedSeconds).toBe(40);

    for (let progress = 161; progress <= 200; progress += 1) {
      session = sampleListenProgress(session, {
        trackId: "t1",
        progress,
        duration: DURATION,
        isPlaying: true,
        qualifyRatio: RATIO,
      }).session;
    }

    expect(session.qualified).toBe(false);
    expect(session.accumulatedSeconds).toBe(80);
  });

  it("does not accumulate while paused", () => {
    let session = createListenSession("t1", 0);

    session = sampleListenProgress(session, {
      trackId: "t1",
      progress: 50,
      duration: DURATION,
      isPlaying: false,
      qualifyRatio: RATIO,
    }).session;

    expect(session.accumulatedSeconds).toBe(0);
    expect(session.lastProgress).toBe(50);
  });
});