// ---------------------------------------------------------------------------
// Saved collection background repair & healing engine.
//
// Automatically detects and repairs broken, missing, or outdated data for
// saved songs and albums in the user's collection:
//   - Video-to-studio audio resolution: converts music-video saves to true studio
//     song tracks with canonical metadata.
//   - Missing metadata backfill: resolves durations, albums, and album browse IDs.
//   - Lyrics repair: detects missing, unsynced, or dirty multi-provider lyrics
//     snapshots and replaces them with clean LRCLIB synced lyrics.
//   - Audio silence trimming & offline sync: detects untrimmed leading silence
//     in local offline files and physically trims them in-place with ffmpeg, or
//     enqueues missing/corrupted offline downloads through the bounded queue.
//   - Album detail caching: backfills missing album track lists and metadata so
//     saved albums open reliably offline.
//
// Safety & performance guardrails:
//   - Non-blocking: runs quietly in the background at low concurrency (1 at a time).
//   - Granular: ONLY repairs what is broken for each specific track (e.g. if
//     only lyrics are missing, only lyrics are fetched — audio is never redownloaded).
//   - Verified caching: remembers healthy & healed items so large collections
//     (thousands of tracks) are skipped instantly in O(1) on subsequent checks.
// ---------------------------------------------------------------------------

import type { MediaTrack } from "../types";
import type { SavedAlbum, SavedArtist } from "../collection";
import {
  cacheArtwork,
  cacheSavedAlbumDetail,
  getEntityDetail,
  getSyncedLyricsForTrack,
  healOfflineAudio,
  isCleanLyricsSource,
  isUnsyncedLyricsSource,
  peekCachedSavedAlbumDetail,
} from "../api";
import { hasValidLyricSync } from "../lyrics";
import { resolveStreamTrackAudio, songMetadataFromMatch } from "./song-resolution";
import { isLikelyMusicVideoTrack } from "./media";
import { titleLooksLikeMusicVideo } from "./track-titles";
import { isPlaceholderAlbumName } from "./upload-enrichment";
import {
  resolveTrackAlbumMetadata,
  resolveTrackMetadata,
} from "./track-metadata-backfill";
import { useOfflineStatusStore } from "../store/offlineStatusStore";
import { enqueueOfflineSync, type OfflineSyncMetadataUpdates } from "./offline-download-queue";
import { getItem, removeItem, setItem } from "../storage";
import { setCachedLeadingSilence } from "../leading-silence";

export const REPAIR_STATE_KEY = "velocity-collection-repair-state";
export const REPAIR_STATE_VERSION = 1;
export const REPAIR_ITEM_THROTTLE_MS = 180;

export type TrackRepairAction =
  | "resolved_video_to_studio"
  | "backfilled_metadata"
  | "repaired_lyrics"
  | "trimmed_audio_silence"
  | "enqueued_offline_download"
  | "enqueued_offline_redownload";

export type AlbumRepairAction =
  | "cached_album_detail"
  | "backfilled_album_metadata"
  | "synced_album_tracks";

export type TrackRepairNeeds = {
  needsVideoResolution: boolean;
  needsCoreMetadata: boolean;
  needsAlbumMetadata: boolean;
  needsLyrics: boolean;
  needsAudioDownload: boolean;
  needsAudioHeal: boolean;
  effectiveVideoId: string | null;
  hasAnyNeed: boolean;
};

export type AlbumRepairNeeds = {
  needsDetailCache: boolean;
  needsMetadata: boolean;
  needsTrackSync: boolean;
  hasAnyNeed: boolean;
};

export type TrackRepairResult = {
  trackId: string;
  repaired: boolean;
  actions: TrackRepairAction[];
  error?: string;
};

export type AlbumRepairResult = {
  browseId: string;
  repaired: boolean;
  actions: AlbumRepairAction[];
  error?: string;
};

interface RepairStateData {
  version: number;
  verifiedTrackIds: Record<string, number>;
  verifiedAlbumIds: Record<string, number>;
  verifiedArtistIds?: Record<string, number>;
}

let _repairStateCache: RepairStateData | null = null;

export function loadRepairState(): RepairStateData {
  if (_repairStateCache !== null) return _repairStateCache;
  try {
    const raw = getItem(REPAIR_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === REPAIR_STATE_VERSION &&
        typeof parsed.verifiedTrackIds === "object" &&
        typeof parsed.verifiedAlbumIds === "object"
      ) {
        _repairStateCache = parsed as RepairStateData;
        if (!_repairStateCache.verifiedArtistIds || typeof _repairStateCache.verifiedArtistIds !== "object") {
          _repairStateCache.verifiedArtistIds = {};
        }
        return _repairStateCache;
      }
    }
  } catch {
    // Ignore corrupt entries.
  }
  _repairStateCache = {
    version: REPAIR_STATE_VERSION,
    verifiedTrackIds: {},
    verifiedAlbumIds: {},
    verifiedArtistIds: {},
  };
  return _repairStateCache;
}

export function saveRepairState(state: RepairStateData): void {
  _repairStateCache = state;
  try {
    setItem(REPAIR_STATE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort storage persistence.
  }
}

export function clearRepairState(): void {
  _repairStateCache = {
    version: REPAIR_STATE_VERSION,
    verifiedTrackIds: {},
    verifiedAlbumIds: {},
    verifiedArtistIds: {},
  };
  try {
    removeItem(REPAIR_STATE_KEY);
  } catch {
    // Ignore.
  }
}

export function markTrackVerifiedHealthy(trackId: string): void {
  const state = loadRepairState();
  state.verifiedTrackIds[trackId] = Date.now();
  saveRepairState(state);
}

export function markAlbumVerifiedHealthy(browseId: string): void {
  const state = loadRepairState();
  state.verifiedAlbumIds[browseId] = Date.now();
  saveRepairState(state);
}

export function markArtistVerifiedHealthy(browseId: string): void {
  const state = loadRepairState();
  state.verifiedArtistIds = state.verifiedArtistIds || {};
  state.verifiedArtistIds[browseId] = Date.now();
  saveRepairState(state);
}

export function isTrackVerifiedHealthy(trackId: string): boolean {
  const state = loadRepairState();
  return typeof state.verifiedTrackIds[trackId] === "number";
}

export function isAlbumVerifiedHealthy(browseId: string): boolean {
  const state = loadRepairState();
  return typeof state.verifiedAlbumIds[browseId] === "number";
}

export function isArtistVerifiedHealthy(browseId: string): boolean {
  const state = loadRepairState();
  return Boolean(state.verifiedArtistIds && typeof state.verifiedArtistIds[browseId] === "number");
}

/** Check whether persisted lyrics for a given videoId exist and are clean. */
export function isPersistedLyricsMissingOrDirty(videoId: string): boolean {
  try {
    const raw = getItem(`velocity-session-lyrics-${videoId}`);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lines)) {
      return true;
    }
    if (isUnsyncedLyricsSource(parsed.source)) return true;
    if (!isCleanLyricsSource(parsed.source)) return true;
    if (!hasValidLyricSync(parsed.lines)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Evaluate what repairs (if any) a saved song requires.
 */
export function inspectTrackRepairNeeds(
  track: MediaTrack,
  options?: { offlineSyncEnabled?: boolean },
): TrackRepairNeeds {
  if (track.source !== "stream") {
    return {
      needsVideoResolution: false,
      needsCoreMetadata: false,
      needsAlbumMetadata: false,
      needsLyrics: false,
      needsAudioDownload: false,
      needsAudioHeal: false,
      effectiveVideoId: null,
      hasAnyNeed: false,
    };
  }

  const effectiveVideoId = track.resolvedVideoId ?? track.videoId ?? null;
  const isVideoRow =
    track.kind === "video" ||
    isLikelyMusicVideoTrack(track) ||
    titleLooksLikeMusicVideo(track.title);
  const needsVideoResolution =
    isVideoRow && (!track.resolvedVideoId || track.resolvedVideoId === track.videoId);

  const needsCoreMetadata =
    track.durationSeconds == null || track.durationSeconds <= 0;
  const needsAlbumMetadata =
    isPlaceholderAlbumName(track.album) || !track.albumBrowseId?.trim();

  const needsLyrics =
    Boolean(effectiveVideoId) && isPersistedLyricsMissingOrDirty(effectiveVideoId!);

  const offlineSyncEnabled = options?.offlineSyncEnabled ?? false;
  let needsAudioDownload = false;
  let needsAudioHeal = false;

  if (offlineSyncEnabled && effectiveVideoId) {
    const isDownloaded =
      useOfflineStatusStore.getState().byVideoId[effectiveVideoId] === "downloaded";
    if (isDownloaded) {
      needsAudioHeal = true;
    } else {
      needsAudioDownload = true;
    }
  }

  const hasAnyNeed =
    needsVideoResolution ||
    needsCoreMetadata ||
    needsAlbumMetadata ||
    needsLyrics ||
    needsAudioDownload ||
    needsAudioHeal;

  return {
    needsVideoResolution,
    needsCoreMetadata,
    needsAlbumMetadata,
    needsLyrics,
    needsAudioDownload,
    needsAudioHeal,
    effectiveVideoId,
    hasAnyNeed,
  };
}

/**
 * Evaluate what repairs (if any) a saved album requires.
 */
export function inspectAlbumRepairNeeds(
  album: SavedAlbum,
  _options?: { offlineSyncEnabled?: boolean },
): AlbumRepairNeeds {
  const detail = peekCachedSavedAlbumDetail(album.browseId);
  const needsDetailCache =
    !detail || detail.kind !== "album" || !detail.tracks || detail.tracks.length === 0;

  const needsMetadata =
    !album.cover || !album.year || !album.byline || !album.artistBrowseId;

  const needsTrackSync = !needsDetailCache;

  const hasAnyNeed = needsDetailCache || needsMetadata || needsTrackSync;

  return {
    needsDetailCache,
    needsMetadata,
    needsTrackSync,
    hasAnyNeed,
  };
}

export type TrackRepairOptions = {
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void;
  offlineSyncEnabled?: boolean;
};

/**
 * Perform targeted repair for a single saved track.
 */
export async function repairSavedSong(
  track: MediaTrack,
  options?: TrackRepairOptions,
): Promise<TrackRepairResult> {
  const needs = inspectTrackRepairNeeds(track, {
    offlineSyncEnabled: options?.offlineSyncEnabled,
  });

  if (!needs.hasAnyNeed) {
    markTrackVerifiedHealthy(track.id);
    return { trackId: track.id, repaired: false, actions: [] };
  }

  const actions: TrackRepairAction[] = [];
  let currentTrack: MediaTrack = { ...track };
  const metadataUpdates: OfflineSyncMetadataUpdates = {};

  // 1. Video-to-studio audio resolution
  if (needs.needsVideoResolution) {
    try {
      const resolved = await resolveStreamTrackAudio(currentTrack);
      if (resolved && resolved.resolvedVideoId && resolved.resolvedVideoId !== currentTrack.videoId) {
        metadataUpdates.resolvedVideoId = resolved.resolvedVideoId;
        if (resolved.kind && resolved.kind !== "video") {
          metadataUpdates.kind = resolved.kind;
        }
        const enriched = songMetadataFromMatch(resolved);
        Object.assign(metadataUpdates, enriched);
        actions.push("resolved_video_to_studio");
      }
    } catch {
      // Best-effort.
    }
  }

  // 2. Metadata backfill
  if (needs.needsCoreMetadata || needs.needsAlbumMetadata) {
    try {
      const [coreUpdates, albumUpdates] = await Promise.all([
        (needs.needsCoreMetadata || !currentTrack.durationSeconds)
          ? resolveTrackMetadata(currentTrack)
          : null,
        (needs.needsAlbumMetadata || isPlaceholderAlbumName(currentTrack.album) || !currentTrack.albumBrowseId)
          ? resolveTrackAlbumMetadata(currentTrack)
          : null,
      ]);
      if (coreUpdates) Object.assign(metadataUpdates, coreUpdates);
      if (albumUpdates) Object.assign(metadataUpdates, albumUpdates);
      if (coreUpdates || albumUpdates) {
        actions.push("backfilled_metadata");
      }
    } catch {
      // Best-effort.
    }
  }

  if (Object.keys(metadataUpdates).length > 0) {
    currentTrack = { ...currentTrack, ...metadataUpdates };
    options?.updateSongMetadata?.(track.id, metadataUpdates);
  }

  const targetVideoId = currentTrack.resolvedVideoId ?? currentTrack.videoId;

  // 3. Lyrics repair
  if (needs.needsLyrics && targetVideoId) {
    try {
      // Remove dirty or corrupt cached lyrics before fetching clean LRCLIB lyrics
      if (isPersistedLyricsMissingOrDirty(targetVideoId)) {
        removeItem(`velocity-session-lyrics-${targetVideoId}`);
      }
      const lyrics = await getSyncedLyricsForTrack(currentTrack, { persist: true });
      if (lyrics && isCleanLyricsSource(lyrics.source) && hasValidLyricSync(lyrics.lines)) {
        actions.push("repaired_lyrics");
      }
    } catch {
      // Best-effort.
    }
  }

  // 4. Audio silence trimming & offline sync
  if (targetVideoId && options?.offlineSyncEnabled) {
    const isDownloaded =
      useOfflineStatusStore.getState().byVideoId[targetVideoId] === "downloaded";
    if (isDownloaded) {
      try {
        const outcome = await healOfflineAudio(targetVideoId);
        if (outcome === "trimmed") {
          actions.push("trimmed_audio_silence");
          setCachedLeadingSilence(currentTrack.id, { skipSeconds: 0, analysisVersion: 7 });
        } else if (outcome === "corrupt" || outcome === "missing") {
          enqueueOfflineSync(currentTrack, options?.updateSongMetadata);
          actions.push("enqueued_offline_redownload");
        }
      } catch {
        // Best-effort.
      }
    } else {
      enqueueOfflineSync(currentTrack, options?.updateSongMetadata);
      actions.push("enqueued_offline_download");
    }
  }

  if (currentTrack.cover) {
    void cacheArtwork(currentTrack.cover).catch(() => {});
  }

  markTrackVerifiedHealthy(track.id);
  return {
    trackId: track.id,
    repaired: actions.length > 0,
    actions,
  };
}

export type AlbumRepairOptions = {
  offlineSyncEnabled?: boolean;
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void;
};

/**
 * Perform targeted repair for a single saved album.
 */
export async function repairSavedAlbum(
  album: SavedAlbum,
  options?: AlbumRepairOptions,
): Promise<AlbumRepairResult> {
  const actions: AlbumRepairAction[] = [];
  if (album.cover) {
    void cacheArtwork(album.cover).catch(() => {});
  }
  let detail = peekCachedSavedAlbumDetail(album.browseId);

  if (!detail || detail.kind !== "album" || !detail.tracks || detail.tracks.length === 0) {
    try {
      detail = await getEntityDetail(album.browseId);
      if (detail && detail.kind === "album") {
        cacheSavedAlbumDetail(album.browseId, detail);
        actions.push("cached_album_detail");
      }
    } catch {
      // Best-effort.
    }
  }

  if (detail && detail.kind === "album") {
    if (detail.cover) {
      void cacheArtwork(detail.cover).catch(() => {});
    }
    if (detail.tracks && detail.tracks.length > 0) {
      for (const track of detail.tracks) {
        if (track.cover) {
          void cacheArtwork(track.cover).catch(() => {});
        }
      }
      const videoIds = detail.tracks
        .map((track) => track.videoId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      useOfflineStatusStore.getState().setAlbumTrackVideoIds(album.browseId, videoIds);

      if (options?.offlineSyncEnabled) {
        for (const track of detail.tracks) {
          if (track.source === "stream" && track.videoId) {
            enqueueOfflineSync(track, options.updateSongMetadata);
            if (isPersistedLyricsMissingOrDirty(track.videoId)) {
              void getSyncedLyricsForTrack(track, { persist: true }).catch(() => {});
            }
          }
        }
        actions.push("synced_album_tracks");
      }
    }
  }

  markAlbumVerifiedHealthy(album.browseId);
  return {
    browseId: album.browseId,
    repaired: actions.length > 0,
    actions,
  };
}

/**
 * Perform targeted repair/warmup for a single saved artist icon.
 */
export async function repairSavedArtist(artist: SavedArtist): Promise<void> {
  if (artist.cover) {
    void cacheArtwork(artist.cover).catch(() => {});
  }
  if (artist.banner) {
    void cacheArtwork(artist.banner).catch(() => {});
  }
  markArtistVerifiedHealthy(artist.browseId);
}

// ---------------------------------------------------------------------------
// Background repair orchestrator queue
// ---------------------------------------------------------------------------

let _isRepairRunning = false;
let _cancelRequested = false;
let _repairTimer: ReturnType<typeof setTimeout> | null = null;

export function isSavedCollectionRepairRunning(): boolean {
  return _isRepairRunning;
}

export function cancelSavedCollectionRepair(): void {
  _cancelRequested = true;
  if (_repairTimer) {
    clearTimeout(_repairTimer);
    _repairTimer = null;
  }
  _isRepairRunning = false;
}

export function resetSavedCollectionRepairForTests(): void {
  cancelSavedCollectionRepair();
  _repairStateCache = null;
}

export type CollectionRepairOptions = {
  savedSongs: readonly MediaTrack[];
  savedAlbums: readonly SavedAlbum[];
  savedArtists?: readonly SavedArtist[];
  offlineSyncEnabled: boolean;
  updateSongMetadata?: (trackId: string, updates: OfflineSyncMetadataUpdates) => void;
  onComplete?: () => void;
};

/**
 * Start the background repair engine. Iterates saved songs, albums, and artists sequentially
 * with throttling so the app stays responsive and never gets rate-limited.
 */
export function startSavedCollectionRepair(options: CollectionRepairOptions): void {
  if (_isRepairRunning) return;
  _isRepairRunning = true;
  _cancelRequested = false;

  const songsToInspect = options.savedSongs.filter((s) => !isTrackVerifiedHealthy(s.id));
  const albumsToInspect = options.savedAlbums.filter((a) => !isAlbumVerifiedHealthy(a.browseId));
  const artistsToInspect = (options.savedArtists ?? []).filter(
    (a) => !isArtistVerifiedHealthy(a.browseId),
  );

  if (songsToInspect.length === 0 && albumsToInspect.length === 0 && artistsToInspect.length === 0) {
    _isRepairRunning = false;
    options.onComplete?.();
    return;
  }

  let songIdx = 0;
  let albumIdx = 0;
  let artistIdx = 0;

  async function processNext(): Promise<void> {
    if (_cancelRequested) {
      _isRepairRunning = false;
      return;
    }

    if (songIdx < songsToInspect.length) {
      const song = songsToInspect[songIdx++];
      if (song) {
        try {
          await repairSavedSong(song, {
            updateSongMetadata: options.updateSongMetadata,
            offlineSyncEnabled: options.offlineSyncEnabled,
          });
        } catch {
          // Continue to next item on failure.
        }
      }
      _repairTimer = setTimeout(() => void processNext(), REPAIR_ITEM_THROTTLE_MS);
      return;
    }

    if (albumIdx < albumsToInspect.length) {
      const album = albumsToInspect[albumIdx++];
      if (album) {
        try {
          await repairSavedAlbum(album, {
            offlineSyncEnabled: options.offlineSyncEnabled,
            updateSongMetadata: options.updateSongMetadata,
          });
        } catch {
          // Continue to next item on failure.
        }
      }
      _repairTimer = setTimeout(() => void processNext(), REPAIR_ITEM_THROTTLE_MS);
      return;
    }

    if (artistIdx < artistsToInspect.length) {
      const artist = artistsToInspect[artistIdx++];
      if (artist) {
        try {
          await repairSavedArtist(artist);
        } catch {
          // Continue to next item on failure.
        }
      }
      _repairTimer = setTimeout(() => void processNext(), REPAIR_ITEM_THROTTLE_MS);
      return;
    }

    _isRepairRunning = false;
    options.onComplete?.();
  }

  _repairTimer = setTimeout(() => void processNext(), 50);
}
