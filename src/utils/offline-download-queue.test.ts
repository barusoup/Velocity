import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTrack } from "../types";

vi.mock("../api", () => ({
  saveOffline: vi.fn(),
  getSyncedLyricsForTrack: vi.fn(),
}));

vi.mock("./song-resolution", () => ({
  resolveStreamTrackAudio: vi.fn(),
  songMetadataFromMatch: vi.fn(),
}));

import { getSyncedLyricsForTrack, saveOffline } from "../api";
import { resolveStreamTrackAudio, songMetadataFromMatch } from "./song-resolution";
import { useOfflineStatusStore } from "../store/offlineStatusStore";
import {
  cancelAllOfflineSync,
  cancelOfflineSyncForVideoIds,
  enqueueOfflineSync,
  enqueueOfflineSyncForSavedSongs,
} from "./offline-download-queue";

const mockedSaveOffline = vi.mocked(saveOffline);
const mockedResolve = vi.mocked(resolveStreamTrackAudio);
const mockedLyrics = vi.mocked(getSyncedLyricsForTrack);

function streamTrack(videoId: string, overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: `yt:${videoId}`,
    title: `Song ${videoId}`,
    artist: "Artist",
    kind: "song",
    source: "stream",
    videoId,
    filePath: null,
    ...overrides,
  };
}

/** Wait until every given video id settles into `downloaded` (or the timeout hits). */
async function waitForDownloaded(videoIds: string[]): Promise<void> {
  await vi.waitFor(
    () => {
      const state = useOfflineStatusStore.getState().byVideoId;
      for (const id of videoIds) {
        expect(state[id]).toBe("downloaded");
      }
    },
    { timeout: 2_000, interval: 5 },
  );
}

/** Wait until `saveOffline` has been called `count` times. */
async function waitForCalls(count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(mockedSaveOffline.mock.calls.length).toBe(count);
    },
    { timeout: 2_000, interval: 5 },
  );
}

function makeSuccessfulDownload(ms = 20): void {
  mockedSaveOffline.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), ms);
      }),
  );
}

describe("offline-download-queue", () => {
  beforeEach(() => {
    cancelAllOfflineSync();
    useOfflineStatusStore.getState().clearAll();
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedResolve.mockImplementation(async (track) => track);
    mockedSongMetadataFromMatch.mockReturnValue({});
    mockedLyrics.mockResolvedValue(null);
  });

  afterEach(() => {
    cancelAllOfflineSync();
    useOfflineStatusStore.getState().clearAll();
    vi.useRealTimers();
  });

  it("runs at most DOWNLOAD_CONCURRENCY downloads at once and drains the whole queue", async () => {
    let active = 0;
    let peak = 0;
    mockedSaveOffline.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active -= 1;
            resolve();
          }, 30);
        }),
    );

    const ids = ["v1", "v2", "v3", "v4", "v5"];
    for (const id of ids) {
      enqueueOfflineSync(streamTrack(id));
    }

    await waitForCalls(5);
    await waitForDownloaded(ids);

    // Never more than 2 yt-dlp downloads in flight at once.
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    // Every track landed on disk and reconciled its status.
    for (const id of ids) {
      expect(useOfflineStatusStore.getState().byVideoId[id]).toBe("downloaded");
    }
  });

  it("dedupes a track enqueued twice (and by a sibling identity id)", async () => {
    makeSuccessfulDownload();

    const track = streamTrack("v1", { resolvedVideoId: "resolved-1" });
    enqueueOfflineSync(track);
    // Same object shape again — must be a no-op.
    enqueueOfflineSync({ ...track });
    // A different track object that resolves to the same underlying video id.
    enqueueOfflineSync(streamTrack("v1"));

    await waitForCalls(1);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(1);
  });

  it("skips tracks whose file is already on disk", async () => {
    makeSuccessfulDownload();
    useOfflineStatusStore.getState().setStatus("v1", "downloaded");

    enqueueOfflineSync(streamTrack("v1"));

    // Give the queue a chance to (wrongly) start a download.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockedSaveOffline).not.toHaveBeenCalled();
  });

  it("retries a failed download silently with backoff and clears the failure on success", async () => {
    vi.useFakeTimers();
    // First attempt fails; second succeeds.
    mockedSaveOffline.mockRejectedValueOnce(new Error("HTTP error 403"));
    mockedSaveOffline.mockResolvedValueOnce(undefined);

    enqueueOfflineSync(streamTrack("v1"));

    // Let the first attempt settle (microtasks + the rejection).
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(1);
    expect(useOfflineStatusStore.getState().byVideoId["v1"]).toBe("failed");

    // No manual action — the queue schedules a silent retry. Advance past
    // the first backoff window and the second attempt should succeed.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(useOfflineStatusStore.getState().byVideoId["v1"]).toBe("downloaded");
  });

  it("keeps retrying with growing backoff while the failure persists", async () => {
    vi.useFakeTimers();
    mockedSaveOffline.mockRejectedValue(new Error("rate limited"));

    enqueueOfflineSync(streamTrack("v1"));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(1);

    // 8s → 30s → 120s → 600s backoff. Walk ~3 retries.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(4);
    expect(useOfflineStatusStore.getState().byVideoId["v1"]).toBe("failed");
  });

  it("cancels retry-pending downloads when the song is unsaved", async () => {
    vi.useFakeTimers();
    mockedSaveOffline.mockRejectedValue(new Error("boom"));

    enqueueOfflineSync(streamTrack("v1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(1);

    cancelOfflineSyncForVideoIds(["v1"]);

    // Well past several backoff windows — the retry must never fire.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockedSaveOffline).toHaveBeenCalledTimes(1);
    expect(useOfflineStatusStore.getState().byVideoId["v1"]).toBe("failed");
  });

  it("sweep enqueues only saved songs missing a local file", async () => {
    makeSuccessfulDownload();
    useOfflineStatusStore.getState().setStatus("v2", "downloaded");

    enqueueOfflineSyncForSavedSongs([
      streamTrack("v1"),
      streamTrack("v2"),
      {
        id: "upload:1",
        title: "Local",
        artist: "Me",
        source: "upload",
        filePath: "/tmp/song.mp3",
        videoId: null,
      },
    ]);

    await waitForCalls(1);
    expect(mockedSaveOffline).toHaveBeenCalledWith("v1", false);
  });
});

// Referenced only inside the mock setup above — declared here so the mock
// factory can share it without a hoisting complaint.
const mockedSongMetadataFromMatch = vi.mocked(songMetadataFromMatch);
