import { describe, expect, it } from "vitest";
import {
  addVisitedQueueTrack,
  findPreviousVisitedQueueIndex,
  resetVisitedQueueTracks,
  resolveHistoryVisitedTrackIds,
} from "./queue-visited";

const queue = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "d" },
  { id: "e" },
];

describe("findPreviousVisitedQueueIndex", () => {
  it("skips unvisited tracks before the playhead", () => {
    const visited = resetVisitedQueueTracks("e");
    expect(findPreviousVisitedQueueIndex(queue, 4, visited)).toBe(-1);
  });

  it("returns the nearest visited track below the playhead", () => {
    let visited = resetVisitedQueueTracks("a");
    visited = addVisitedQueueTrack(visited, "b");
    visited = addVisitedQueueTrack(visited, "e");
    expect(findPreviousVisitedQueueIndex(queue, 4, visited)).toBe(1);
  });
});

describe("resolveHistoryVisitedTrackIds", () => {
  it("falls back to the entry track when no snapshot exists", () => {
    expect(
      resolveHistoryVisitedTrackIds({ track: { id: "song" } }),
    ).toEqual(["song"]);
  });

  it("restores the stored visited snapshot", () => {
    expect(
      resolveHistoryVisitedTrackIds({
        track: { id: "song" },
        queueVisitedTrackIds: ["one", "two"],
      }),
    ).toEqual(["one", "two"]);
  });
});