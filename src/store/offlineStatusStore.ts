import { create } from "zustand";
import type { MediaTrack } from "../types";
import { streamIdentityVideoIds } from "../utils/media";

/**
 * Offline download status, keyed by the video id that was actually
 * downloaded. A single saved song can have several identity ids
 * (`videoId`, `resolvedVideoId`, ...); the file lands under one of them
 * and the selector resolves a track to its best status across all of
 * them. `missing` (no entry) means "no local file known" — distinct from
 * `failed`, which means "an attempt was made and it errored" (retryable).
 */
export type OfflineStatus = "downloaded" | "downloading" | "failed";

export type OfflineStatusState = {
  /** Status by the videoId that was (or is being) downloaded. */
  byVideoId: Record<string, OfflineStatus>;
  /** Saved-album browseId → track video ids (for "N of M offline" pills). */
  albumTrackVideoIds: Record<string, string[]>;
  setStatus: (videoId: string, status: OfflineStatus) => void;
  setStatuses: (statuses: Record<string, OfflineStatus>) => void;
  clear: (videoId: string) => void;
  clearAll: () => void;
  setAlbumTrackVideoIds: (browseId: string, videoIds: string[]) => void;
  clearAlbum: (browseId: string) => void;
};

export const useOfflineStatusStore = create<OfflineStatusState>((set) => ({
  byVideoId: {},
  albumTrackVideoIds: {},
  setStatus: (videoId, status) =>
    set((state) =>
      state.byVideoId[videoId] === status
        ? state
        : { byVideoId: { ...state.byVideoId, [videoId]: status } },
    ),
  setStatuses: (statuses) =>
    set((state) => {
      let changed = false;
      const next = { ...state.byVideoId };
      for (const [videoId, status] of Object.entries(statuses)) {
        if (next[videoId] !== status) {
          next[videoId] = status;
          changed = true;
        }
      }
      return changed ? { byVideoId: next } : state;
    }),
  clear: (videoId) =>
    set((state) => {
      if (!(videoId in state.byVideoId)) return state;
      const next = { ...state.byVideoId };
      delete next[videoId];
      return { byVideoId: next };
    }),
  clearAll: () => set({ byVideoId: {}, albumTrackVideoIds: {} }),
  setAlbumTrackVideoIds: (browseId, videoIds) =>
    set((state) => {
      const existing = state.albumTrackVideoIds[browseId];
      if (
        existing &&
        existing.length === videoIds.length &&
        existing.every((id, index) => id === videoIds[index])
      ) {
        return state;
      }
      return { albumTrackVideoIds: { ...state.albumTrackVideoIds, [browseId]: videoIds } };
    }),
  clearAlbum: (browseId) =>
    set((state) => {
      if (!(browseId in state.albumTrackVideoIds)) return state;
      const next = { ...state.albumTrackVideoIds };
      delete next[browseId];
      return { albumTrackVideoIds: next };
    }),
}));

/**
 * Best known offline status for a track across all its identity ids.
 * Priority: downloading (in flight) > downloaded > failed > null (missing).
 */
export function selectTrackOfflineStatus(
  state: OfflineStatusState,
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): OfflineStatus | null {
  if (track.source === "upload") return null;
  const statuses = state.byVideoId;
  let sawFailed = false;
  for (const videoId of streamIdentityVideoIds(track)) {
    const status = statuses[videoId];
    if (status === "downloading") return "downloading";
    if (status === "downloaded") return "downloaded";
    if (status === "failed") sawFailed = true;
  }
  return sawFailed ? "failed" : null;
}

/** Count of a saved album's tracks that are downloaded. */
export function selectAlbumDownloadedCount(
  state: OfflineStatusState,
  browseId: string,
): number {
  const videoIds = state.albumTrackVideoIds[browseId];
  if (!videoIds || videoIds.length === 0) return 0;
  let count = 0;
  for (const videoId of videoIds) {
    if (state.byVideoId[videoId] === "downloaded") count += 1;
  }
  return count;
}
