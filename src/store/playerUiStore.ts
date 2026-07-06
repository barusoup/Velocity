import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { MediaTrack, QueueOrigin } from "../types";

/** Minimal track identity for row active-state checks without full MediaTrack. */
export type TrackIdentity = Pick<
  MediaTrack,
  "id" | "videoId" | "resolvedVideoId" | "source"
>;

export type QueueOriginSnapshot = {
  kind: QueueOrigin["kind"];
  browseId: string;
} | null;

export interface PlayerUiState {
  /** High-frequency playback position — subscribe only where needed. */
  progress: number;
  /** Live scrubber preview while dragging; null when idle. */
  seekScrubProgress: number | null;
  currentTrack: TrackIdentity | null;
  currentTrackCover: string | null;
  albumBrowseId: string | null;
  artistBrowseId: string | null;
  queueOrigin: QueueOriginSnapshot;
  isPlaying: boolean;
  isBuffering: boolean;
}

export interface PlayerUiActions {
  setProgress: (progress: number) => void;
  setSeekScrubProgress: (value: number | null) => void;
  syncPlaybackIdentity: (payload: {
    currentTrack: MediaTrack | null;
    isPlaying: boolean;
    isBuffering: boolean;
    queueOrigin: QueueOrigin | null;
  }) => void;
  resetProgress: (progress: number) => void;
}

export type PlayerUiStore = PlayerUiState & PlayerUiActions;

function trackIdentityEqual(
  a: TrackIdentity | null,
  b: TrackIdentity | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.videoId === b.videoId &&
    a.resolvedVideoId === b.resolvedVideoId &&
    a.source === b.source
  );
}

function toTrackIdentity(track: MediaTrack | null): TrackIdentity | null {
  if (!track) return null;
  return {
    id: track.id,
    videoId: track.videoId,
    resolvedVideoId: track.resolvedVideoId,
    source: track.source,
  };
}

function toQueueOriginSnapshot(origin: QueueOrigin | null): QueueOriginSnapshot {
  if (!origin) return null;
  if (origin.kind === "user-playlist") {
    return { kind: origin.kind, browseId: origin.id };
  }
  return { kind: origin.kind, browseId: origin.browseId };
}

function queueOriginEqual(a: QueueOriginSnapshot, b: QueueOriginSnapshot): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.browseId === b.browseId;
}

export const usePlayerUiStore = create<PlayerUiStore>()(
  subscribeWithSelector((set, get) => ({
    progress: 0,
    seekScrubProgress: null,
    currentTrack: null,
    currentTrackCover: null,
    albumBrowseId: null,
    artistBrowseId: null,
    queueOrigin: null,
    isPlaying: false,
    isBuffering: false,
    setProgress: (progress) => {
      if (!Number.isFinite(progress)) return;
      if (get().progress === progress) return;
      set({ progress });
    },
    setSeekScrubProgress: (seekScrubProgress) => {
      if (get().seekScrubProgress === seekScrubProgress) return;
      set({ seekScrubProgress });
    },
    resetProgress: (progress) => {
      const safe = Number.isFinite(progress) ? progress : 0;
      set({ progress: safe, seekScrubProgress: null });
    },
    syncPlaybackIdentity: ({
      currentTrack,
      isPlaying,
      isBuffering,
      queueOrigin,
    }) => {
      const nextTrack = toTrackIdentity(currentTrack);
      const nextCover = currentTrack?.cover ?? null;
      const nextAlbumBrowseId = currentTrack?.albumBrowseId ?? null;
      const nextArtistBrowseId = currentTrack?.artistBrowseId ?? null;
      const nextQueueOrigin = toQueueOriginSnapshot(queueOrigin);
      const prev = get();
      if (
        prev.isPlaying === isPlaying &&
        prev.isBuffering === isBuffering &&
        prev.currentTrackCover === nextCover &&
        prev.albumBrowseId === nextAlbumBrowseId &&
        prev.artistBrowseId === nextArtistBrowseId &&
        queueOriginEqual(prev.queueOrigin, nextQueueOrigin) &&
        trackIdentityEqual(prev.currentTrack, nextTrack)
      ) {
        return;
      }
      set({
        currentTrack: nextTrack,
        currentTrackCover: nextCover,
        albumBrowseId: nextAlbumBrowseId,
        artistBrowseId: nextArtistBrowseId,
        queueOrigin: nextQueueOrigin,
        isPlaying,
        isBuffering,
      });
    },
  })),
);

export function getPlayerProgress(): number {
  return usePlayerUiStore.getState().progress;
}

export function getPlayerSeekScrubProgress(): number | null {
  return usePlayerUiStore.getState().seekScrubProgress;
}