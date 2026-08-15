import { describe, expect, it } from "vitest";
import type { MediaTrack } from "../types";
import {
  compactQueueForHistorySnapshot,
  PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX,
} from "./playback-history-snapshot";

function track(id: string): MediaTrack {
  return {
    id,
    kind: "song",
    title: id,
    artist: "A",
    album: null,
    videoId: id,
    source: "stream",
    filePath: null,
  };
}

describe("compactQueueForHistorySnapshot", () => {
  it("returns the full queue when under the cap", () => {
    const queue = [track("a"), track("b"), track("c")];
    const result = compactQueueForHistorySnapshot(queue, 1);
    expect(result.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.queueIndex).toBe(1);
  });

  it("windows around the playhead for oversized queues", () => {
    const queue = Array.from({ length: 500 }, (_, i) => track(`t-${i}`));
    const result = compactQueueForHistorySnapshot(queue, 250);
    expect(result.queue.length).toBeLessThanOrEqual(PLAYBACK_HISTORY_QUEUE_SNAPSHOT_MAX);
    expect(result.queue[result.queueIndex]?.id).toBe("t-250");
  });

  it("anchors to the end when the playhead is near the tail", () => {
    const queue = Array.from({ length: 500 }, (_, i) => track(`t-${i}`));
    const result = compactQueueForHistorySnapshot(queue, 490);
    expect(result.queue[result.queueIndex]?.id).toBe("t-490");
    expect(result.queue.at(-1)?.id).toBe("t-499");
  });
});