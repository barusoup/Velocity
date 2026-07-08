import { useShallow } from "zustand/react/shallow";
import { usePlayerUiStore } from "../store/playerUiStore";
import type { MediaTrack, SearchItem } from "../types";
import { isSameSongTrack, isSameStreamPlayback } from "../utils/media";

/** Re-renders only when a track is loaded or unloaded. */
export function usePlayerHasTrack(): boolean {
  return usePlayerUiStore((state) => state.currentTrack !== null);
}

/** Re-renders only when the active track's cover changes. */
export function usePlayerCover(): string | null {
  return usePlayerUiStore((state) => state.currentTrackCover);
}

type PlaybackFlags = {
  active: boolean;
  playingActive: boolean;
  bufferingActive: boolean;
};

function toPlaybackFlags(active: boolean, isPlaying: boolean, isBuffering: boolean): PlaybackFlags {
  return {
    active,
    playingActive: active && isPlaying,
    bufferingActive: active && isBuffering,
  };
}

/** Re-renders only when this row's active/playing/buffering state changes. */
export function useTrackPlaybackState(track: MediaTrack): PlaybackFlags {
  return usePlayerUiStore(
    useShallow((state) =>
      toPlaybackFlags(
        isSameStreamPlayback(state.currentTrack, track),
        state.isPlaying,
        state.isBuffering,
      ),
    ),
  );
}

/** Re-renders only when this search item's active/playing/buffering state changes. */
export function useSearchItemPlaybackState(item: SearchItem): PlaybackFlags {
  return usePlayerUiStore(useShallow((state) => {
    const active = isSearchItemActive(item, state);
    return toPlaybackFlags(active, state.isPlaying, state.isBuffering);
  }));
}

/** Re-renders when an album queue origin matches this browse id. */
export function useAlbumQueuePlaybackState(
  albumBrowseId: string | null | undefined,
): PlaybackFlags {
  return usePlayerUiStore(useShallow((state) => {
    const active =
      Boolean(albumBrowseId) &&
      state.queueOrigin?.kind === "album" &&
      state.queueOrigin.browseId === albumBrowseId;
    return toPlaybackFlags(active, state.isPlaying, state.isBuffering);
  }));
}

/** Re-renders only when this release's active/playing/buffering state changes. */
export function useReleasePlaybackState(
  releaseBrowseId: string | null | undefined,
  artistBrowseId?: string | null,
): PlaybackFlags {
  return usePlayerUiStore(useShallow((state) => {
    const active =
      Boolean(releaseBrowseId) &&
      state.albumBrowseId === releaseBrowseId &&
      (!artistBrowseId ||
        (state.queueOrigin?.kind === "artist" &&
          state.queueOrigin.browseId === artistBrowseId));
    return toPlaybackFlags(active, state.isPlaying, state.isBuffering);
  }));
}

function isSearchItemActive(
  item: SearchItem,
  state: {
    currentTrack: Parameters<typeof isSameSongTrack>[0];
    albumBrowseId: string | null;
    artistBrowseId: string | null;
    queueOrigin: { kind: string; browseId: string } | null;
  },
): boolean {
  if (!state.currentTrack) return false;

  if (item.kind === "song") {
    if (!item.videoId) return false;
    return isSameSongTrack(state.currentTrack, {
      id: item.id,
      videoId: item.videoId,
      artist: item.artist,
      title: item.title,
      source: "stream",
    });
  }

  if (item.kind === "album" || item.kind === "playlist") {
    const expectedKind = item.kind === "album" ? "album" : "playlist";
    return (
      state.queueOrigin?.kind === expectedKind &&
      state.queueOrigin.browseId === item.browseId &&
      state.albumBrowseId === item.browseId
    );
  }

  if (item.kind === "artist") {
    return (
      state.queueOrigin?.kind === "artist" &&
      state.queueOrigin.browseId === item.browseId &&
      state.artistBrowseId === item.browseId
    );
  }

  return false;
}

/** Subscribe to high-frequency progress — use only in player chrome / lyrics. */
export function usePlayerProgress(): number {
  return usePlayerUiStore((state) => state.progress);
}

/** Subscribe to seek-scrub preview position. */
export function usePlayerSeekScrubProgress(): number | null {
  return usePlayerUiStore((state) => state.seekScrubProgress);
}
