import { beforeEach, describe, expect, it } from "vitest";
import type { MediaTrack } from "../types";
import {
  selectAlbumDownloadedCount,
  selectTrackOfflineStatus,
  useOfflineStatusStore,
} from "./offlineStatusStore";

function streamTrack(
  overrides: Partial<MediaTrack> & Pick<MediaTrack, "id">,
): MediaTrack {
  return {
    kind: "song",
    title: "Song",
    artist: "Artist",
    source: "stream",
    filePath: null,
    ...overrides,
  };
}

describe("offlineStatusStore", () => {
  beforeEach(() => {
    useOfflineStatusStore.getState().clearAll();
  });

  it("tracks per-videoId status and clears individual ids", () => {
    const store = useOfflineStatusStore.getState();
    store.setStatus("video-1", "downloaded");
    store.setStatus("video-2", "downloading");
    expect(useOfflineStatusStore.getState().byVideoId).toEqual({
      "video-1": "downloaded",
      "video-2": "downloading",
    });

    store.clear("video-1");
    expect(useOfflineStatusStore.getState().byVideoId["video-1"]).toBeUndefined();
    expect(useOfflineStatusStore.getState().byVideoId["video-2"]).toBe("downloading");
  });

  it("merges bulk statuses and clears everything", () => {
    useOfflineStatusStore.getState().setStatuses({
      "video-1": "downloaded",
      "video-2": "failed",
    });
    expect(useOfflineStatusStore.getState().byVideoId).toEqual({
      "video-1": "downloaded",
      "video-2": "failed",
    });
    useOfflineStatusStore.getState().clearAll();
    expect(useOfflineStatusStore.getState().byVideoId).toEqual({});
  });

  it("resolves a track across every identity id", () => {
    useOfflineStatusStore.getState().setStatus("resolved-id", "downloaded");
    const track = streamTrack({
      id: "yt:video-1",
      videoId: "video-1",
      resolvedVideoId: "resolved-id",
    });
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), track)).toBe(
      "downloaded",
    );
  });

  it("prioritizes downloading over downloaded", () => {
    useOfflineStatusStore.getState().setStatuses({
      "video-1": "downloading",
      "video-2": "downloaded",
    });
    const track = streamTrack({
      id: "yt:video-1",
      videoId: "video-1",
      resolvedVideoId: "video-2",
    });
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), track)).toBe(
      "downloading",
    );
  });

  it("reports failed only when nothing else is known", () => {
    useOfflineStatusStore.getState().setStatus("video-1", "failed");
    expect(
      selectTrackOfflineStatus(useOfflineStatusStore.getState(), streamTrack({
        id: "yt:video-1",
        videoId: "video-1",
      })),
    ).toBe("failed");
  });

  it("returns null for tracks with no known status (missing)", () => {
    const track = streamTrack({ id: "yt:unknown", videoId: "unknown" });
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), track)).toBeNull();
  });

  it("returns null for uploads even when a videoId collision exists", () => {
    useOfflineStatusStore.getState().setStatus("upload:1", "downloaded");
    const upload = {
      id: "upload:1",
      title: "Local",
      artist: "Me",
      source: "upload" as const,
      filePath: "/tmp/song.mp3",
      videoId: null,
    };
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), upload)).toBeNull();
  });

  it("counts a saved album's downloaded tracks", () => {
    const store = useOfflineStatusStore.getState();
    store.setAlbumTrackVideoIds("MPREb_album", ["a", "b", "c"]);
    store.setStatuses({ a: "downloaded", b: "failed" });
    expect(selectAlbumDownloadedCount(useOfflineStatusStore.getState(), "MPREb_album")).toBe(1);
  });

  it("reports downloaded when the resolved id holds the file even if the catalog id was left downloading", () => {
    // Regression: `scheduleOfflineSyncForTrack` sets "downloading" on the
    // pre-resolution id, then reconciles the full identity set on success.
    // The selector must never return a stuck "downloading" when a sibling
    // identity id is downloaded.
    useOfflineStatusStore.getState().setStatuses({
      "catalog-id": "downloaded",
      "resolved-id": "downloaded",
    });
    const track = streamTrack({
      id: "yt:catalog-id",
      videoId: "catalog-id",
      resolvedVideoId: "resolved-id",
    });
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), track)).toBe(
      "downloaded",
    );
  });

  it("reports failed when every identity id failed", () => {
    useOfflineStatusStore.getState().setStatuses({
      "catalog-id": "failed",
      "resolved-id": "failed",
    });
    const track = streamTrack({
      id: "yt:catalog-id",
      videoId: "catalog-id",
      resolvedVideoId: "resolved-id",
    });
    expect(selectTrackOfflineStatus(useOfflineStatusStore.getState(), track)).toBe("failed");
  });

  it("album count sees downloads when the resolved id holds the file", () => {
    const store = useOfflineStatusStore.getState();
    // The album registry holds catalog video ids. `scheduleOfflineSyncForTrack`
    // reconciles the full identity set on success (catalog id included), so a
    // download that physically lands under the resolved id still counts.
    store.setAlbumTrackVideoIds("MPREb_album", ["catalog-id"]);
    store.setStatuses({
      "catalog-id": "downloaded",
      "resolved-id": "downloaded",
    });
    expect(selectAlbumDownloadedCount(useOfflineStatusStore.getState(), "MPREb_album")).toBe(1);
  });

  it("clears an album's registry without touching other entries", () => {
    const store = useOfflineStatusStore.getState();
    store.setAlbumTrackVideoIds("MPREb_album-a", ["a"]);
    store.setAlbumTrackVideoIds("MPREb_album-b", ["b"]);
    store.clearAlbum("MPREb_album-a");
    const state = useOfflineStatusStore.getState();
    expect(state.albumTrackVideoIds["MPREb_album-a"]).toBeUndefined();
    expect(state.albumTrackVideoIds["MPREb_album-b"]).toEqual(["b"]);
  });

  it("clearAll drops both statuses and album registries", () => {
    const store = useOfflineStatusStore.getState();
    store.setStatus("a", "downloaded");
    store.setAlbumTrackVideoIds("MPREb_album", ["a"]);
    store.clearAll();
    const state = useOfflineStatusStore.getState();
    expect(state.byVideoId).toEqual({});
    expect(state.albumTrackVideoIds).toEqual({});
  });
});
