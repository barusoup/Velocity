import type { LoudnessData, MediaTrack, QueueOrigin } from "../types";
import { exportStreamVideoId, readLiveMediaDuration } from "../utils/media";
import { isUsableLoudness } from "../normalization";
import { getItem } from "../storage";

// Extracted from player.tsx to reduce the god-object file from 3709 lines.
// Pure helpers only — no React, no side effects — so they are easy to test
// and reuse across queue UI, history, and autoplay.

export const DEFAULT_CLAMPED_VOLUME = 0.8;
export const RECENTLY_PLAYED_LIMIT = 50;
export const STALE_PLAYBACK_MS = 40 * 60 * 1000;
export const LOUDNESS_PREVIEW_CHUNK_SECONDS = 16;
export const LOUDNESS_PREVIEW_MIN_PEAK_DB = -35;
export const LOUDNESS_PREVIEW_MIN_LUFS = -45;

export const VOLUME_KEY = "velocity-volume";
export const MUTED_KEY = "velocity-muted";

export function readVolume(): number | null {
  try {
    const raw = getItem(VOLUME_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readMuted(): boolean | null {
  try {
    const raw = getItem(MUTED_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

export type SavedSession = {
  track: MediaTrack;
  progress: number;
  savedAt: number;
};

export const SESSION_KEY = "velocity-session";
export const SESSION_MAX_AGE_MS = 86_400_000;

export function parseSavedSessionRaw(raw: string | null): SavedSession | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SavedSession;
    if (!data?.track?.id || typeof data.progress !== "number") return null;
    if (Date.now() - data.savedAt > SESSION_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function bootAutoplaySeed(session: SavedSession): AutoplaySeed | null {
  const restored = session.track;
  const seedVideoId =
    restored.source === "stream"
      ? restored.resolvedVideoId ?? restored.videoId ?? null
      : null;
  return seedVideoId ? { videoId: seedVideoId, playlistId: null } : null;
}

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_CLAMPED_VOLUME;
}

export function readAudioElementDuration(audio: HTMLAudioElement): number | null {
  const value = readLiveMediaDuration(audio);
  return value > 0 ? value : null;
}

export function waitForMediaReady(
  audio: HTMLAudioElement,
  isStale?: () => boolean,
): Promise<void> {
  if (isStale?.()) return Promise.reject(new Error("STALE_LOAD"));
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      if (isStale?.()) { reject(new Error("STALE_LOAD")); return; }
      resolve();
    };
    const onError = () => {
      cleanup();
      if (isStale?.()) { reject(new Error("STALE_LOAD")); return; }
      reject(new Error(describeMediaError(audio.error) ?? "The audio could not be reloaded."));
    };
    const cleanup = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("canplay", onReady);
    audio.addEventListener("error", onError);
  });
}

export function isStaleLoadError(error: unknown): boolean {
  return error instanceof Error && error.message === "STALE_LOAD";
}

export function describeMediaError(error: MediaError | null): string {
  if (!error) return "Playback failed for this track.";
  switch (error.code) {
    case 1: return "Playback was stopped before the track could load.";
    case 2: return "The music stream could not be loaded over the network.";
    case 3: return "This track loaded, but the audio could not be decoded.";
    case 4: return "This track's audio format is not supported here.";
    default: return "Playback failed for this track.";
  }
}

export function shuffledCopy<T>(items: readonly T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// Audio analysis (loudness, leading silence) is a property of the
// underlying audio file, so it should be cached by the underlying stream
// videoId and ignore release/album context. `MediaTrack.id` encodes the
// source album when known so identical song rows on different releases are
// distinguishable in the UI; using the raw id here would force redundant
// per-release re-analysis (and re-run the detector pipeline) for tracks
// that share their audio across singles, EPs, and parent albums.
export function getAudioCacheKey(track: MediaTrack): string {
  if (track.source === "stream") {
    const effectiveVideoId = exportStreamVideoId(track);
    if (effectiveVideoId) return `yt:${effectiveVideoId}`;
  }
  return track.id;
}

export function queueOriginEquals(left: QueueOrigin | null, right: QueueOrigin | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  // User playlists carry their own `id` field rather than the YTM-era
  // `browseId` namespace — distinct equality branch so a YTM `playlist`
  // origin with a coincidentally shape-matching browseId can never be
  // treated as the same as a user-create playlist (which would otherwise
  // collapse queue/playback history across the two distinct entities).
  if (left.kind === "user-playlist" && right.kind === "user-playlist") {
    return left.id === right.id;
  }
  // After the user-playlist guard, both sides are one of the browseId-based
  // kinds. TypeScript can't narrow this through the && above, so extract
  // browseId via a helper that works on all union members.
  const leftBrowseId = "browseId" in left ? left.browseId : null;
  const rightBrowseId = "browseId" in right ? right.browseId : null;
  return leftBrowseId === rightBrowseId;
}

export type AutoplaySeed = { videoId: string; playlistId: string | null };

export function isPlaybackIdleLongEnough(idleSinceMs: number): boolean {
  return idleSinceMs > 0 && Date.now() - idleSinceMs >= STALE_PLAYBACK_MS;
}

export function playbackNeedsSourceRefresh(
  track: MediaTrack | null | undefined,
  idleSinceMs: number,
  refreshFlag: boolean,
): boolean {
  return (
    track?.source === "stream" &&
    (refreshFlag || isPlaybackIdleLongEnough(idleSinceMs))
  );
}

export function buildLoudnessPreviewStarts(durationSeconds?: number | null): number[] {
  const duration = Number.isFinite(durationSeconds ?? NaN) ? Math.max(0, durationSeconds ?? 0) : 0;
  if (duration <= 0) return [0, 30, 75];

  const candidates = [0, duration * 0.18, duration * 0.45];

  const maxStart = Math.max(0, duration - LOUDNESS_PREVIEW_CHUNK_SECONDS);
  const starts: number[] = [];
  for (const candidate of candidates) {
    const start = Math.round(Math.min(Math.max(0, candidate), maxStart));
    if (!starts.some((existing) => Math.abs(existing - start) < LOUDNESS_PREVIEW_CHUNK_SECONDS / 2)) {
      starts.push(start);
    }
  }

  return starts;
}

export function isUsefulPreviewLoudness(loudness: LoudnessData): boolean {
  if (!isUsableLoudness(loudness)) return false;
  if (typeof loudness.integratedLufs === "number" && loudness.integratedLufs < LOUDNESS_PREVIEW_MIN_LUFS) return false;
  if (typeof loudness.truePeak === "number" && loudness.truePeak < LOUDNESS_PREVIEW_MIN_PEAK_DB) return false;
  return true;
}

export type PlaybackHistoryEntry = {
  track: MediaTrack;
  queue: MediaTrack[];
  queueIndex: number;
  queueOrigin: QueueOrigin | null;
  autoplayTrackIds: string[];
  autoplaySeed: AutoplaySeed | null;
  shuffle: boolean;
  /** Track ids the user actually started in this queue session. */
  queueVisitedTrackIds: string[];
};

export function playbackHistoryEntriesEqual(left: PlaybackHistoryEntry, right: PlaybackHistoryEntry): boolean {
  if (
    left.track.id !== right.track.id ||
    left.queueIndex !== right.queueIndex ||
    left.shuffle !== right.shuffle ||
    !queueOriginEquals(left.queueOrigin, right.queueOrigin) ||
    left.autoplaySeed?.videoId !== right.autoplaySeed?.videoId ||
    left.autoplaySeed?.playlistId !== right.autoplaySeed?.playlistId ||
    left.autoplayTrackIds.length !== right.autoplayTrackIds.length ||
    left.queue.length !== right.queue.length ||
    left.queueVisitedTrackIds.length !== right.queueVisitedTrackIds.length
  ) {
    return false;
  }

  for (let index = 0; index < left.autoplayTrackIds.length; index += 1) {
    if (left.autoplayTrackIds[index] !== right.autoplayTrackIds[index]) return false;
  }

  for (let index = 0; index < left.queue.length; index += 1) {
    if (left.queue[index]?.id !== right.queue[index]?.id) return false;
  }

  for (let index = 0; index < left.queueVisitedTrackIds.length; index += 1) {
    if (left.queueVisitedTrackIds[index] !== right.queueVisitedTrackIds[index]) return false;
  }

  return true;
}

export function playbackHistorySessionKey(
  entry: Pick<PlaybackHistoryEntry, "track" | "queueIndex" | "queueOrigin" | "shuffle">,
): string {
  const origin = entry.queueOrigin;
  let originKey = "";
  if (origin) {
    originKey = origin.kind === "user-playlist"
      ? `user:${origin.id}`
      : `browse:${"browseId" in origin ? origin.browseId : ""}`;
  }
  return `${entry.track.id}\0${entry.queueIndex}\0${entry.shuffle ? 1 : 0}\0${originKey}`;
}

export function prependPlaybackHistoryEntry(
  current: PlaybackHistoryEntry[],
  entry: PlaybackHistoryEntry,
): PlaybackHistoryEntry[] {
  const sessionKey = playbackHistorySessionKey(entry);
  const withoutDuplicate = current.filter(
    (existing) => playbackHistorySessionKey(existing) !== sessionKey,
  );
  if (
    withoutDuplicate[0] &&
    playbackHistoryEntriesEqual(withoutDuplicate[0], entry)
  ) {
    return withoutDuplicate;
  }
  return [entry, ...withoutDuplicate].slice(0, RECENTLY_PLAYED_LIMIT);
}

export function playbackEntryMatchesQueueSession(
  entry: PlaybackHistoryEntry,
  activeQueue: readonly MediaTrack[],
  activeOrigin: QueueOrigin | null,
): boolean {
  if (!queueOriginEquals(entry.queueOrigin, activeOrigin)) return false;
  if (entry.queue.length > activeQueue.length) return false;
  for (let index = 0; index < entry.queue.length; index += 1) {
    if (entry.queue[index]?.id !== activeQueue[index]?.id) return false;
  }
  return true;
}

export function historyRestoreWouldDropAppendedTracks(
  currentQueue: readonly MediaTrack[],
  historyEntry: PlaybackHistoryEntry,
): boolean {
  const historyQueue = historyEntry.queue;
  if (currentQueue.length <= historyQueue.length) return false;
  return historyQueue.every((track, index) => currentQueue[index]?.id === track.id);
}

export function findPreviousSessionHistoryIndex(
  history: readonly PlaybackHistoryEntry[],
  currentQueue: readonly MediaTrack[],
  currentIndex: number,
  currentTrack: MediaTrack | null,
  activeOrigin: QueueOrigin | null,
): number {
  if (!currentTrack) return -1;
  const aheadIds = new Set(
    currentQueue.slice(currentIndex + 1).map((track) => track.id),
  );
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry.track.id === currentTrack.id) continue;
    // Tracks still queued ahead of the playhead were skipped past — not "previous".
    if (aheadIds.has(entry.track.id)) continue;
    if (
      playbackEntryMatchesQueueSession(entry, currentQueue, activeOrigin) &&
      entry.queueIndex > currentIndex
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

export function isRedoingQueueAdvance(
  history: readonly PlaybackHistoryEntry[],
  currentQueue: readonly MediaTrack[],
  currentIndex: number,
  activeOrigin: QueueOrigin | null,
): boolean {
  const nextTrack = currentQueue[currentIndex + 1];
  const currentTrack = currentQueue[currentIndex];
  if (!nextTrack || !currentTrack) return false;
  return history.some(
    (entry) =>
      entry.track.id === nextTrack.id &&
      entry.queueIndex === currentIndex + 1 &&
      playbackEntryMatchesQueueSession(entry, currentQueue, activeOrigin),
  );
}

export type RecentlyPlayedSet = {
  ids: Set<string>;
  videoIds: Set<string>;
  artistTitles: Set<string>;
};

export function buildRecentlyPlayedSet(entries: PlaybackHistoryEntry[]): RecentlyPlayedSet {
  const ids = new Set<string>();
  const videoIds = new Set<string>();
  const artistTitles = new Set<string>();
  for (const e of entries) {
    ids.add(e.track.id);
    if (e.track.videoId) videoIds.add(e.track.videoId);
    artistTitles.add(`${e.track.artist}\0${e.track.title}`.toLowerCase());
  }
  return { ids, videoIds, artistTitles };
}

export function isInRecentlyPlayed(track: MediaTrack, set: RecentlyPlayedSet): boolean {
  if (set.ids.has(track.id)) return true;
  if (track.videoId && set.videoIds.has(track.videoId)) return true;
  return set.artistTitles.has(`${track.artist}\0${track.title}`.toLowerCase());
}

export function buildSeenIndex(queue: readonly MediaTrack[]) {
  const ids = new Set<string>();
  const videoIds = new Set<string>();
  const artistTitles = new Set<string>();
  for (const entry of queue) {
    ids.add(entry.id);
    if (entry.videoId) videoIds.add(entry.videoId);
    artistTitles.add(`${entry.artist}\0${entry.title}`.toLowerCase());
  }
  return { ids, videoIds, artistTitles };
}
