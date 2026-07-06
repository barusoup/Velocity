import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  analyzeLoudness,
  analyzeLoudnessChunk,
  getSyncedLyrics,
  getWatchPlaylist,
  getOfflinePath,
  invalidateStream,
  invalidateWatchPlaylist,
  resolveStream,
  searchMusic,
} from "./api";
import type { LoudnessData, MediaTrack, QueueOrigin } from "./types";
import {
  getCachedLoudness,
  isUsableLoudness,
  loadTargetLufs,
  setCachedLoudness,
  computeLinearGain,
  getInitialGain,
  hasAttemptedAnalysis,
} from "./normalization";
import { getSetting, useSetting } from "./settings";
import type { SearchItem } from "./types";
import { getItem, setItem, removeItem } from "./storage";

export const currentAudio: { current: HTMLAudioElement | null } = { current: null };

type RepeatMode = "off" | "all" | "one";

type AutoplaySeed = { videoId: string; playlistId: string | null };

export type { QueueOrigin } from "./types";

type QueueHistoryTrack = {
  track: MediaTrack;
  queueIndex: number;
};

type RecentPlaybackTrack = {
  track: MediaTrack;
  historyIndex: number;
};

type PlayerState = {
  currentTrack: MediaTrack | null;
  queue: MediaTrack[];
  queueIndex: number;
  queueOrigin: QueueOrigin | null;
  autoplayTrackIds: ReadonlySet<string>;
  previousQueue: QueueHistoryTrack[];
  recentlyPlayed: RecentPlaybackTrack[];
  isPlaying: boolean;
  isBuffering: boolean;
  isReloadingAutoplay: boolean;
  progress: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  autoplay: boolean;
  autoplaySeed: AutoplaySeed | null;
  lastError: string | null;
  normGain: number;
};

type PlayerActions = {
  play: (track: MediaTrack) => Promise<void>;
  playMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => Promise<void>;
  playShuffled: (tracks: MediaTrack[], origin?: QueueOrigin) => Promise<void>;
  playQueueIndex: (index: number) => void;
  restoreHistoryEntry: (index: number) => void;
  moveQueueItem: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  removeTrackFromQueue: (trackId: string) => void;
  appendToQueue: (tracks: MediaTrack[], origin?: QueueOrigin) => void;
  togglePlay: () => void;
  next: (recordRecentlyPlayed?: boolean) => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  setLiveVolume: (value: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setAutoplay: (enabled: boolean) => void;
  reloadAutoplay: () => void;
  clearError: () => void;
  retry: () => void;
  getAnalyser: () => AnalyserNode | null;
  setEqualizerBand: (index: number, gain: number) => void;
};

type PlayerContextValue = PlayerState & PlayerActions;

const PlayerContext = createContext<PlayerContextValue | null>(null);
const VOLUME_KEY = "velocity-volume";
const MUTED_KEY = "velocity-muted";
const AUTOPLAY_KEY = "velocity-autoplay";
const DEFAULT_VOLUME = 0.8;
const AUTOPLAY_QUEUE_TARGET = 10;
const AUTOPLAY_QUEUE_BATCH_LIMIT = 20;
const PREFETCH_AHEAD = 5;
const LOUDNESS_PREVIEW_CHUNK_SECONDS = 16;
const LOUDNESS_PREVIEW_MIN_PEAK_DB = -35;
const LOUDNESS_PREVIEW_MIN_LUFS = -45;
const RECENTLY_PLAYED_LIMIT = 50;
// Total attempts = 1 initial + (MAX_LOAD_ATTEMPTS - 1) retries, spaced by RETRY_DELAY_MS.
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = [700, 1500, 3500];
const SEARCH_MATCH_TIMEOUT_MS = 4_000;
const STREAM_RESOLVE_TIMEOUT_MS = 12_000;
// How long to wait for a YT Music watch-playlist response before treating
// the attempt as a failed autoplay fetch and trigging a retry. Keeps the
// first song of a session (slow cold start) from leaving the queue empty.
const AUTOPLAY_FETCH_TIMEOUT_MS = 3_000;
// Base delay between auto-retries of a failed autoplay fetch. After the
// 3rd retry the delay begins doubling per subsequent retry.
const AUTOPLAY_RETRY_BASE_DELAY_MS = 3_000;

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_VOLUME;
}

function shuffledCopy<T>(items: readonly T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

// Common YouTube video-title decorations that hurt song search matching.
// Strip them so a search like "Artist Song (Official Music Video)" still
// resolves to a clean title match in the search results.
const VIDEO_TITLE_SUFFIX_REGEX = new RegExp(
  "[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video|official\\s+visualizer|visualizer|audio|video|lyrics?|lyric\\s+video|clip|m\\/v|hd|4k|hq|remastered(?:\\s+\\d{4})?)[\\)\\]]?\\s*$",
  "i",
);
const VIDEO_TITLE_PREFIX_REGEX = new RegExp(
  "^[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video)[\\)\\]]?\\s*[-–—:]?\\s*",
  "i",
);

function cleanAutoplaySearchTitle(title: string): string {
  return title
    .replace(VIDEO_TITLE_PREFIX_REGEX, "")
    .replace(VIDEO_TITLE_SUFFIX_REGEX, "")
    .replace(/\s*[-–—]\s*topic\s*$/i, "")
    .trim();
}

const AUTOPLAY_MIN_ARTIST_OVERLAP = 0.25;
const AUTOPLAY_MIN_TITLE_OVERLAP = 0.25;

function normalizeAutoplayMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(normalizeAutoplayMatchText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeAutoplayMatchText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

// When swapping a track's underlying videoId (e.g. a music video → Topic upload,
// or an album-track mislabel), require the candidate's runtime to match the
// original within a tolerance. This blocks mislabeled uploads that claim the
// right title/artist but actually contain a different song (observed: a
// "Paranoid Android" result that played "2 + 2 = 5"). We require a candidate
// duration whenever the source has one; if the source has no duration we can't
// validate, so we fall back to the title/artist checks alone.
function isDurationMatchForAutoplaySwap(
  sourceSeconds: number | null | undefined,
  candidateSeconds: number | null | undefined,
): boolean {
  const hasSource =
    sourceSeconds != null && Number.isFinite(sourceSeconds) && sourceSeconds > 0;
  const hasCandidate =
    candidateSeconds != null && Number.isFinite(candidateSeconds) && candidateSeconds > 0;
  if (!hasSource) return true;
  if (!hasCandidate) return false;
  const diff = Math.abs(sourceSeconds - candidateSeconds);
  const tolerance = Math.max(15, sourceSeconds * 0.15);
  return diff <= tolerance;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function findClosestSongForVideoTrack(
  video: MediaTrack,
): Promise<MediaTrack | null> {
  const cleanedTitle = cleanAutoplaySearchTitle(video.title);
  const query = `${video.artist} ${cleanedTitle || video.title}`.trim();
  if (!query) return null;

  try {
    const response = await withTimeout(
      searchMusic(query),
      SEARCH_MATCH_TIMEOUT_MS,
      "Song lookup took too long.",
    );
    const candidates: SearchItem[] = [];
    if (response.topResult) candidates.push(response.topResult);
    for (const item of response.results) {
      if (!candidates.some((existing) => existing.id === item.id)) {
        candidates.push(item);
      }
    }

    const songs = candidates.filter(
      (item) => item.kind === "song" && !!item.videoId,
    );
    if (songs.length === 0) return null;

    const candidateArtist = video.artist;
    const candidateTitle = cleanedTitle || video.title;
    const ranked = songs
      .map((song, index) => {
        const songArtist = song.artist ?? "";
        // Route exact-match checks through the same normalize-token pipeline
        // the overlap scorer uses so diacritics/whitespace don't block the
        // bypass (e.g. "Café" vs "Cafe").
        const exactArtist =
          normalizeAutoplayMatchText(candidateArtist) ===
          normalizeAutoplayMatchText(songArtist);
        const exactTitle =
          normalizeAutoplayMatchText(candidateTitle) ===
          normalizeAutoplayMatchText(song.title);
        const artistScore = tokenOverlap(candidateArtist, songArtist);
        const titleScore = tokenOverlap(candidateTitle, song.title);
        // Exact (artist, title) hits always outrank partial overlaps so a
        // close-fuzzy match can't outvote a true equivalent. Otherwise we
        // rank by weighted overlap (artist more important than title) and
        // fall back to the original index to keep ties deterministic.
        const exactPair = exactArtist && exactTitle ? 1 : 0;
        const score = exactPair + artistScore * 0.6 + titleScore * 0.4;
        return { song, score, index, exactArtist, exactTitle, artistScore, titleScore };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const best = ranked[0];
    if (!best) return null;
    // Both axes must clear an overlap floor to avoid substituting a same-
    // artist different track or a same-title track by a cover artist.
    const meetsArtist =
      best.exactArtist || best.artistScore >= AUTOPLAY_MIN_ARTIST_OVERLAP;
    const meetsTitle =
      best.exactTitle || best.titleScore >= AUTOPLAY_MIN_TITLE_OVERLAP;
    if (!meetsArtist || !meetsTitle) return null;
    // Runtime guard: a title/artist match isn't enough if the candidate's
    // length is wildly different — it may be a mislabeled upload.
    if (!isDurationMatchForAutoplaySwap(video.durationSeconds, best.song.durationSeconds)) {
      return null;
    }

    const matched = best.song;
    const matchedVideoId = matched.videoId!;
    return {
      ...video,
      id: `yt:${matchedVideoId}`,
      videoId: matchedVideoId,
      title: matched.title,
      artist: matched.artist ?? video.artist,
      album: matched.album ?? video.album ?? null,
      albumBrowseId: matched.albumBrowseId ?? video.albumBrowseId ?? null,
      artistBrowseId: matched.artistBrowseId ?? video.artistBrowseId ?? null,
      artistCredits: matched.artistCredits ?? video.artistCredits ?? null,
      durationSeconds: matched.durationSeconds ?? video.durationSeconds ?? null,
      playCount: matched.playCount ?? video.playCount ?? null,
      cover: matched.cover ?? video.cover ?? null,
      kind: "song",
    };
  } catch (error) {
    console.warn("Autoplay song-match lookup failed:", error);
    return null;
  }
}

// Search for the canonical "song" (Topic upload) version of a track and return
// its videoId. Used by `resolveTrackAudio` to swap a music-video videoId that
// landed on a song-kind track. YouTube Music sometimes returns a music-video
// videoId for album/playlist tracks when the music video is the more popular
// result; this finds the audio-only Topic upload's videoId instead.
//
// Only the videoId is returned — the caller preserves the track's display
// metadata (title, artist, album, cover) so the UI is unaffected.
//
// Key: iterates ALL song-kind search results, skipping any with the same
// videoId as the track (which would be the music video itself, possibly
// misclassified as "song" by the backend's normalize_kind fallback). The
// actual Topic upload has a DIFFERENT videoId and will be found further down
// the ranked list.
async function findCanonicalSongVideoId(
  track: MediaTrack,
): Promise<string | null> {
  const query = `${track.artist} ${track.title}`.trim();
  if (!query || !track.videoId) return null;

  try {
    const response = await withTimeout(
      searchMusic(query),
      SEARCH_MATCH_TIMEOUT_MS,
      "Song lookup took too long.",
    );
    const candidates: SearchItem[] = [];
    if (response.topResult) candidates.push(response.topResult);
    for (const item of response.results) {
      if (!candidates.some((existing) => existing.id === item.id)) {
        candidates.push(item);
      }
    }

    const songs = candidates.filter(
      (item) => item.kind === "song" && !!item.videoId,
    );
    if (songs.length === 0) return null;

    const candidateArtist = track.artist;
    const candidateTitle = track.title;
    const ranked = songs
      .map((song, index) => {
        const songArtist = song.artist ?? "";
        const exactArtist =
          normalizeAutoplayMatchText(candidateArtist) ===
          normalizeAutoplayMatchText(songArtist);
        const exactTitle =
          normalizeAutoplayMatchText(candidateTitle) ===
          normalizeAutoplayMatchText(song.title);
        const artistScore = tokenOverlap(candidateArtist, songArtist);
        const titleScore = tokenOverlap(candidateTitle, song.title);
        const exactPair = exactArtist && exactTitle ? 1 : 0;
        const score = exactPair + artistScore * 0.6 + titleScore * 0.4;
        return { song, score, index, exactArtist, exactTitle };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);

    // Iterate ALL ranked results — the top result may be the music video
    // itself (misclassified as "song" by the backend's normalize_kind
    // fallback) with the SAME videoId as the track. Skip it and keep looking
    // for a result with a DIFFERENT videoId, which is the Topic upload.
    // Require exact (artist, title) match to avoid swapping to a different
    // track (remix, live version, etc.), and verify runtime so a mislabeled
    // upload cannot sneak through with the right metadata but wrong audio.
    for (const entry of ranked) {
      if (!entry.exactArtist || !entry.exactTitle) continue;
      if (!isDurationMatchForAutoplaySwap(track.durationSeconds, entry.song.durationSeconds)) {
        continue;
      }
      const matchedVideoId = entry.song.videoId!;
      if (matchedVideoId === track.videoId) continue;
      return matchedVideoId;
    }
    return null;
  } catch (error) {
    console.warn("Canonical song videoId lookup failed:", error);
    return null;
  }
}

function describeMediaError(error: MediaError | null): string {
  if (!error) return "Playback failed for this track.";
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was stopped before the track could load.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "The music stream could not be loaded over the network.";
    case MediaError.MEDIA_ERR_DECODE:
      return "This track loaded, but the audio could not be decoded.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This track's audio format is not supported here.";
    default:
      return "Playback failed for this track.";
  }
}

function buildLoudnessPreviewStarts(durationSeconds?: number | null): number[] {
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

function isUsefulPreviewLoudness(loudness: LoudnessData): boolean {
  if (!isUsableLoudness(loudness)) return false;
  if (typeof loudness.integratedLufs === "number" && loudness.integratedLufs < LOUDNESS_PREVIEW_MIN_LUFS) return false;
  if (typeof loudness.truePeak === "number" && loudness.truePeak < LOUDNESS_PREVIEW_MIN_PEAK_DB) return false;
  return true;
}

function readVolume(): number | null {
  try {
    const raw = getItem(VOLUME_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMuted(): boolean | null {
  try {
    const raw = getItem(MUTED_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

function readAutoplayPref(): boolean {
  try {
    const raw = getItem(AUTOPLAY_KEY);
    if (raw === null) return true;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : true;
  } catch {
    return true;
  }
}

// Audio analysis (loudness, leading silence) is a property of the
// underlying audio file, so it should be cached by the underlying stream
// videoId and ignore release/album context. `MediaTrack.id` encodes the
// source album when known so identical song rows on different releases are
// distinguishable in the UI; using the raw id here would force redundant
// per-release re-analysis (and re-run the detector pipeline) for tracks
// that share their audio across singles, EPs, and parent albums.
function getAudioCacheKey(track: MediaTrack): string {
  const effectiveVideoId = track.resolvedVideoId ?? track.videoId;
  if (track.source === "stream" && effectiveVideoId) return `yt:${effectiveVideoId}`;
  return track.id;
}

type PlaybackHistoryEntry = {
  track: MediaTrack;
  queue: MediaTrack[];
  queueIndex: number;
  queueOrigin: QueueOrigin | null;
  autoplayTrackIds: string[];
  autoplaySeed: AutoplaySeed | null;
  shuffle: boolean;
};

function queueOriginEquals(left: QueueOrigin | null, right: QueueOrigin | null): boolean {
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

function playbackHistoryEntriesEqual(left: PlaybackHistoryEntry, right: PlaybackHistoryEntry): boolean {
  if (
    left.track.id !== right.track.id ||
    left.queueIndex !== right.queueIndex ||
    left.shuffle !== right.shuffle ||
    !queueOriginEquals(left.queueOrigin, right.queueOrigin) ||
    left.autoplaySeed?.videoId !== right.autoplaySeed?.videoId ||
    left.autoplaySeed?.playlistId !== right.autoplaySeed?.playlistId ||
    left.autoplayTrackIds.length !== right.autoplayTrackIds.length ||
    left.queue.length !== right.queue.length
  ) {
    return false;
  }

  for (let index = 0; index < left.autoplayTrackIds.length; index += 1) {
    if (left.autoplayTrackIds[index] !== right.autoplayTrackIds[index]) return false;
  }

  for (let index = 0; index < left.queue.length; index += 1) {
    if (left.queue[index]?.id !== right.queue[index]?.id) return false;
  }

  return true;
}

function queueTracksEqual(left: readonly MediaTrack[], right: readonly MediaTrack[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) return false;
  }
  return true;
}

function playbackEntryMatchesQueueSession(
  entry: PlaybackHistoryEntry,
  activeQueue: readonly MediaTrack[],
  activeOrigin: QueueOrigin | null,
): boolean {
  return queueOriginEquals(entry.queueOrigin, activeOrigin) && queueTracksEqual(entry.queue, activeQueue);
}

type RecentlyPlayedSet = {
  ids: Set<string>;
  videoIds: Set<string>;
  artistTitles: Set<string>;
};

function buildRecentlyPlayedSet(entries: PlaybackHistoryEntry[]): RecentlyPlayedSet {
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

function isInRecentlyPlayed(track: MediaTrack, set: RecentlyPlayedSet): boolean {
  if (set.ids.has(track.id)) return true;
  if (track.videoId && set.videoIds.has(track.videoId)) return true;
  return set.artistTitles.has(`${track.artist}\0${track.title}`.toLowerCase());
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<MediaTrack | null>(null);
  const [queue, setQueue] = useState<MediaTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueOrigin, setQueueOrigin] = useState<QueueOrigin | null>(null);
  const [autoplayTrackIds, setAutoplayTrackIds] = useState<Set<string>>(() => new Set());
  const [playbackHistory, setPlaybackHistory] = useState<PlaybackHistoryEntry[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const savedVolume = readVolume();
  const savedMuted = readMuted();
  const useDefault = savedVolume === null || Number.isNaN(savedVolume) || savedMuted || savedVolume === 0;
  const [volume, setVolumeState] = useState(useDefault ? DEFAULT_VOLUME : savedVolume!);
  const [muted, setMuted] = useState<boolean>(useDefault ? false : (savedMuted ?? false));
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [autoplay, setAutoplayState] = useState<boolean>(() => readAutoplayPref());
  const [autoplaySeed, setAutoplaySeed] = useState<AutoplaySeed | null>(null);
  const [isReloadingAutoplay, setIsReloadingAutoplay] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [normGain, setNormGain] = useState(1);
  const [currentAudioPath, setCurrentAudioPath] = useState<string | null>(null);
  // Bumped by `retry()` to force the load effect to re-run with a fresh
  // set of attempts without otherwise changing the current track.
  const [loadToken, setLoadToken] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const eqFiltersRef = useRef<BiquadFilterNode[]>([]);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const normGainRef = useRef(normGain);
  const queueRef = useRef(queue);
  const queueOriginRef = useRef<QueueOrigin | null>(queueOrigin);
  const repeatRef = useRef(repeat);
  const shuffleRef = useRef(shuffle);
  const queueIndexRef = useRef(queueIndex);
  const trackRef = useRef<MediaTrack | null>(currentTrack);
  const autoplaySeedRef = useRef<AutoplaySeed | null>(null);
  const autoplayTrackIdsRef = useRef<Set<string>>(new Set());
  const autoplayRef = useRef(autoplay);
  const playbackHistoryRef = useRef<PlaybackHistoryEntry[]>([]);
  const nextRef = useRef<((recordRecentlyPlayed?: boolean) => void) | null>(null);
  const fetchingAutoplayRef = useRef(false);
  const autoplayAdvancePendingRef = useRef(false);
  // Tracks how many auto-retries the in-flight autoplay attempt has
  // already consumed. Used to compute the next retry delay so that, after
  // the 3rd retry, the gap begins to double per subsequent retry.
  const autoplayRetryCountRef = useRef(0);
  // Holds the pending retry timer so seed-change actions (play, playMany,
  // reloadAutoplay, setAutoplay(false), etc.) can cancel it cleanly
  // before the prior retry fires and overwrites new state.
  const autoplayRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playVersionRef = useRef(0);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by the load effect while it owns the audio element (loading or
  // retrying) so the global error handler doesn't undo the buffering state.
  const loadInProgressRef = useRef(false);
  // Guards the very first track load of the session: any track that is set
  // without an explicit user-initiated play() / playMany() call (e.g. a
  // session restore from saveTimestamp) starts paused so the user is never
  // surprised by auto-playing audio on app launch. The flag is cleared
  // before the first user-driven play() runs so normal playback is
  // unaffected.
  const isSessionRestoreRef = useRef(true);
  // When restoring a session, carry the saved seek position so the load
  // effect can jump to it before the first paint.
  const seekOnNextLoadRef = useRef(0);
  // Debounce timer for persisting the playback session to localStorage.
  const sessionSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const SESSION_KEY = "velocity-session";

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    queueOriginRef.current = queueOrigin;
  }, [queueOrigin]);

  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);

  useEffect(() => {
    queueIndexRef.current = queueIndex;
  }, [queueIndex]);

  useEffect(() => {
    trackRef.current = currentTrack;
  }, [currentTrack]);

  useEffect(() => {
    autoplaySeedRef.current = autoplaySeed;
  }, [autoplaySeed]);

  useEffect(() => {
    autoplayTrackIdsRef.current = autoplayTrackIds;
  }, [autoplayTrackIds]);

  useEffect(() => {
    autoplayRef.current = autoplay;
  }, [autoplay]);

  useEffect(() => {
    playbackHistoryRef.current = playbackHistory;
  }, [playbackHistory]);

  useEffect(() => {
    setItem(AUTOPLAY_KEY, JSON.stringify(autoplay));
  }, [autoplay]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    normGainRef.current = normGain;
  }, [normGain]);

  const previousQueue = useMemo(
    () =>
      queue
        .slice(0, queueIndex)
        .map((track, index) => ({ track, queueIndex: index }))
        .reverse(),
    [queue, queueIndex],
  );
  const recentlyPlayed = useMemo(
    () =>
      playbackHistory
        .map((entry, historyIndex) => ({ entry, historyIndex }))
        .filter(({ entry }) => {
          if (queueIndex <= 0) return true;
          return !(
            entry.queueIndex < queueIndex &&
            playbackEntryMatchesQueueSession(entry, queue, queueOrigin)
          );
        })
        .reverse()
        .map(({ entry, historyIndex }) => ({ track: entry.track, historyIndex })),
    [playbackHistory, queue, queueIndex, queueOrigin],
  );

  const setQueueState = useCallback((next: {
    queue: MediaTrack[];
    queueIndex: number;
    queueOrigin: QueueOrigin | null;
    autoplayTrackIds?: Iterable<string>;
    autoplaySeed: AutoplaySeed | null;
    shuffle?: boolean;
  }) => {
    const normalizedQueue = next.queue.slice();
    const normalizedIndex = normalizedQueue.length === 0
      ? 0
      : Math.max(0, Math.min(next.queueIndex, normalizedQueue.length - 1));
    const normalizedAutoplayIds = new Set(next.autoplayTrackIds ?? autoplayTrackIdsRef.current);

    // Capture the prior seed before mutation so we can detect an explicit
    // replacement (play/playMany/reloadAutoplay/restoreHistoryEntry all
    // change the seed; queue reorders and appends do not).
    const prevAutoplaySeed = autoplaySeedRef.current;

    queueRef.current = normalizedQueue;
    queueIndexRef.current = normalizedIndex;
    queueOriginRef.current = next.queueOrigin;
    autoplayTrackIdsRef.current = normalizedAutoplayIds;
    autoplaySeedRef.current = next.autoplaySeed;

    setQueue(normalizedQueue);
    setQueueIndex(normalizedIndex);
    setQueueOrigin(next.queueOrigin);
    setAutoplayTrackIds(normalizedAutoplayIds);
    setAutoplaySeed(next.autoplaySeed);

    // If the autoplay seed has just been replaced, cancel any pending
    // auto-retry timer so an older retry for the prior seed doesn't
    // accidentally re-overwrite the new state when it eventually fires.
    // Also release the in-flight guard so the follow-up
    // `fetchAndAppendAutoplay` call from play()/reloadAutoplay() can
    // re-enter through the guard.
    const prevSeedVideoId = prevAutoplaySeed?.videoId ?? null;
    const prevSeedPlaylistId = prevAutoplaySeed?.playlistId ?? null;
    const nextSeedVideoId = next.autoplaySeed?.videoId ?? null;
    const nextSeedPlaylistId = next.autoplaySeed?.playlistId ?? null;
    if (
      prevSeedVideoId !== nextSeedVideoId ||
      prevSeedPlaylistId !== nextSeedPlaylistId
    ) {
      if (autoplayRetryTimerRef.current) {
        clearTimeout(autoplayRetryTimerRef.current);
        autoplayRetryTimerRef.current = null;
      }
      autoplayRetryCountRef.current = 0;
      if (fetchingAutoplayRef.current) {
        fetchingAutoplayRef.current = false;
      }
    }

    if (typeof next.shuffle === "boolean") {
      shuffleRef.current = next.shuffle;
      setShuffle(next.shuffle);
    }
  }, []);

  const capturePlaybackHistoryEntry = useCallback((): PlaybackHistoryEntry | null => {
    const currentQueue = queueRef.current;
    const activeTrack = trackRef.current;
    if (!activeTrack) return null;

    const snapshotQueue = currentQueue.length > 0 ? currentQueue.slice() : [activeTrack];
    const snapshotIndex = snapshotQueue.length === 0
      ? 0
      : Math.max(0, Math.min(queueIndexRef.current, snapshotQueue.length - 1));

    return {
      track: activeTrack,
      queue: snapshotQueue,
      queueIndex: snapshotIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: Array.from(autoplayTrackIdsRef.current),
      autoplaySeed: autoplaySeedRef.current,
      shuffle: shuffleRef.current,
    };
  }, []);

  const rememberPlaybackHistory = useCallback(() => {
    const entry = capturePlaybackHistoryEntry();
    if (!entry) return;

    setPlaybackHistory((current) => {
      if (current[0] && playbackHistoryEntriesEqual(current[0], entry)) {
        return current;
      }
      return [entry, ...current].slice(0, RECENTLY_PLAYED_LIMIT);
    });
  }, [capturePlaybackHistoryEntry]);

  const applyPlaybackHistoryEntry = useCallback((entry: PlaybackHistoryEntry) => {
    setQueueState({
      queue: entry.queue,
      queueIndex: entry.queueIndex,
      queueOrigin: entry.queueOrigin,
      autoplayTrackIds: entry.autoplayTrackIds,
      autoplaySeed: entry.autoplaySeed,
      shuffle: entry.shuffle,
    });
  }, [setQueueState]);

  const applyOutputLevels = useCallback((nextVolume: number, nextMuted: boolean, nextGain: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const cleanVolume = clampVolume(nextVolume);
    const cleanGain = Number.isFinite(nextGain) && nextGain > 0 ? nextGain : 1;
    const gainNode = gainNodeRef.current;

    const masterVolumeDb = getSetting("masterVolume");
    const masterVolumeGain = Math.pow(10, masterVolumeDb / 20);
    const normalizationEnabled = getSetting("audioNormalization");
    const effectiveGain = normalizationEnabled ? cleanGain : 1;

    if (gainNode && audioContextRef.current) {
      const now = audioContextRef.current.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(effectiveGain * cleanVolume * masterVolumeGain, now, 0.15);
      audio.volume = 1;
    } else {
      audio.volume = clampVolume(cleanVolume * effectiveGain * masterVolumeGain);
    }
    audio.muted = nextMuted;
  }, []);

  const stopCurrentPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.currentTime = 0;
    setProgress(0);
    setIsPlaying(false);
    setIsBuffering(false);
  }, []);

  const ensureAudioGraph = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || gainNodeRef.current) {
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume().catch(() => undefined);
      }
      return;
    }

    const AudioContextConstructor = window.AudioContext ?? (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) {
      applyOutputLevels(volumeRef.current, mutedRef.current, normGainRef.current);
      return;
    }

    try {
      const context = new AudioContextConstructor();
      const source = context.createMediaElementSource(audio);
      const gainNode = context.createGain();
      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.8;
      const limiterNode = context.createDynamicsCompressor();

      // Configure DynamicsCompressorNode as a brickwall limiter to protect from digital clipping.
      limiterNode.threshold.setValueAtTime(-1.0, context.currentTime);
      limiterNode.knee.setValueAtTime(0, context.currentTime);
      limiterNode.ratio.setValueAtTime(20, context.currentTime);
      limiterNode.attack.setValueAtTime(0.003, context.currentTime);
      limiterNode.release.setValueAtTime(0.1, context.currentTime);

      source.connect(gainNode);

      // Build equalizer filter chain between gain and analyser.
      const eqFrequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      const eqBands = getSetting("equalizerBands");
      const eqFilters: BiquadFilterNode[] = eqFrequencies.map((freq, i) => {
        const filter = context.createBiquadFilter();
        filter.type = "peaking";
        filter.frequency.value = freq;
        filter.Q.value = 1.41;
        filter.gain.value = eqBands[i] ?? 0;
        return filter;
      });

      // Chain: gainNode -> eq[0] -> ... -> eq[9] -> analyserNode
      gainNode.connect(eqFilters[0]);
      for (let i = 0; i < eqFilters.length - 1; i++) {
        eqFilters[i].connect(eqFilters[i + 1]);
      }
      eqFilters[eqFilters.length - 1].connect(analyserNode);

      analyserNode.connect(limiterNode);
      limiterNode.connect(context.destination);

      audioContextRef.current = context;
      audioSourceRef.current = source;
      gainNodeRef.current = gainNode;
      analyserRef.current = analyserNode;
      eqFiltersRef.current = eqFilters;
      applyOutputLevels(volumeRef.current, mutedRef.current, normGainRef.current);
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }
    } catch (error) {
      console.warn("Audio normalization graph could not be created:", error);
      gainNodeRef.current = null;
      audioSourceRef.current = null;
      audioContextRef.current = null;
      analyserRef.current = null;
      eqFiltersRef.current = [];
      applyOutputLevels(volumeRef.current, mutedRef.current, normGainRef.current);
    }
  }, [applyOutputLevels]);

  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.volume = clampVolume(volume);
    audio.muted = muted;
    audioRef.current = audio;
    currentAudio.current = audio;

    const syncProgress = () => setProgress(audio.currentTime || 0);
    const syncDuration = () => {
      const nextDuration = Number.isFinite(audio.duration) ? audio.duration : trackRef.current?.durationSeconds ?? 0;
      setDuration(nextDuration || 0);
    };

    const handlePlay = () => {
      if (isSessionRestoreRef.current) {
        audio.pause();
        return;
      }
      setIsPlaying(true);
      // Mirror the readyState gate togglePlay uses so resuming a
      // pre-buffered track doesn't transiently flash the loading
      // spinner before the first paint. Without this guard the native
      // `play` event flips isBuffering back to true a moment after
      // togglePlay cleared it, racing the React batch and reading as a
      // press-and-wait delay on the play/pause button.
      if (!audio.readyState || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        setIsBuffering(true);
      }
    };
    const handlePlaying = () => {
      setIsBuffering(false);
    };
    const handlePause = () => {
      setIsPlaying(false);
      setIsBuffering(false);
    };
    const handleWaiting = () => setIsBuffering(true);
    const handleEnded = () => {
      setProgress(0);
      if (repeatRef.current === "one") {
        void audio.play().catch(() => {
          setIsPlaying(false);
        });
        return;
      }
      const queue = queueRef.current;
      const index = queueIndexRef.current;
      const hasMore = queue.length > 0 && (
        (index + 1 < queue.length) ||
        repeatRef.current === "all" ||
        (autoplayRef.current && autoplaySeedRef.current?.videoId)
      );
      if (hasMore) {
        void nextRef.current?.(true);
      } else {
        setIsPlaying(false);
      }
    };
    const handleError = () => {
      // The load effect drives buffering state when it owns the audio
      // element (initial load + automatic retries). If the global error
      // handler stomped on that, the UI would flicker between load and
      // failure on every retry attempt.
      if (loadInProgressRef.current) return;
      setIsBuffering(false);
      setIsPlaying(false);
      setLastError(describeMediaError(audio.error));
    };

    audio.addEventListener("timeupdate", syncProgress);
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.pause();
      audio.src = "";
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
        fadeTimeoutRef.current = null;
      }
      void audioContextRef.current?.close().catch(() => undefined);
      audio.removeEventListener("timeupdate", syncProgress);
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      audioRef.current = null;
      currentAudio.current = null;
      audioContextRef.current = null;
      audioSourceRef.current = null;
      gainNodeRef.current = null;
      analyserRef.current = null;
      eqFiltersRef.current = [];
    };
  }, []);

  // `masterVolume` and `audioNormalization` are settings the user toggles
  // from SettingsPage. Subscribe to them via the reactive `useSetting`
  // hook and add them as deps here so flipping either one in SettingsPage
  // re-applies the gain node immediately, instead of waiting for the user
  // to nudge the volume slider again. Without these deps, the toggle only
  // persists to localStorage and the audio output stays on the previous
  // gain until the next `volume / muted / normGain` mutation. Kept merged
  // with the existing volume/muted/normGain effects so every change goes
  // through a single applyOutputLevels call.
  const masterVolumeDb = useSetting("masterVolume");
  const audioNormalizationEnabled = useSetting("audioNormalization");
  useEffect(() => {
    applyOutputLevels(volume, muted, normGain);
  }, [applyOutputLevels, volume, muted, normGain, masterVolumeDb, audioNormalizationEnabled]);

  // Apply equalizer band gains to the BiquadFilterNode chain when bands change.
  const equalizerBands = useSetting("equalizerBands");
  useEffect(() => {
    const filters = eqFiltersRef.current;
    if (filters.length === 0) return;
    for (let i = 0; i < filters.length; i++) {
      filters[i].gain.value = equalizerBands[i] ?? 0;
    }
  }, [equalizerBands]);

  useEffect(() => {
    setItem(VOLUME_KEY, JSON.stringify(volume));
  }, [volume]);

  useEffect(() => {
    setItem(MUTED_KEY, JSON.stringify(muted));
  }, [muted]);

  useEffect(() => {
    if (queue.length === 0) {
      setCurrentTrack(null);
      setProgress(0);
      setDuration(0);
      return;
    }
    const nextTrack = queue[queueIndex] ?? queue[0];
    setCurrentTrack(nextTrack);
  }, [queue, queueIndex]);

  useEffect(() => {
    if (!currentTrack) return;
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;
    // Number of retries still allowed AFTER the initial attempt. We try once,
    // then schedule up to MAX_LOAD_ATTEMPTS - 1 retries spaced by RETRY_DELAY_MS
    // before giving up.
    let retriesLeft = MAX_LOAD_ATTEMPTS - 1;
    let activeRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAttemptError: unknown = null;

    setLastError(null);
    setIsBuffering(true);
    setProgress(0);
    setDuration(currentTrack.durationSeconds ?? 0);
    setCurrentAudioPath(null);

    // Clear the audio element's source so the audio state tracks the UI:
    // the previous track stops emitting while we attempt to load the new one.
    // Without this, a failed `resolveStream` would leave the audio element
    // playing the prior URL while the UI advertised a different track.
    audio.removeAttribute("src");
    audio.currentTime = 0;
    audio.pause();
    loadInProgressRef.current = true;

    const finalize = () => {
      if (cancelled) return;
      loadInProgressRef.current = false;
      setIsBuffering(false);
      setIsPlaying(false);
      // Prefer the more specific MediaError description (e.g. NETWORK vs.
      // DECODE) when the audio element flagged one, otherwise surface the
      // raw error we captured during the last attempt.
      setLastError(
        describeMediaError(audio.error) ??
          (lastAttemptError instanceof Error ? lastAttemptError.message : "Playback could not start."),
      );
    };

    const attempt = async () => {
      if (cancelled) return;
      try {
        await ensureAudioGraph();
        let src: string | null = null;
        if (currentTrack.source === "upload") {
          setCurrentAudioPath(currentTrack.filePath ?? null);
          src = currentTrack.audioSrc ?? null;
        } else {
          // Use the resolved videoId (canonical Topic upload) when
          // available, falling back to the original videoId. This is
          // essential for tracks that `playMany` queued without
          // pre-resolving (all tracks except the first).
          const effectiveVideoId = currentTrack.resolvedVideoId ?? currentTrack.videoId;
          if (effectiveVideoId) {
          // Check for an offline-downloaded file first
          const offlinePath = await getOfflinePath(effectiveVideoId);
          if (offlinePath) {
            if (cancelled || trackRef.current?.id !== currentTrack.id) return;
            setCurrentAudioPath(offlinePath);
            src = convertFileSrc(offlinePath);
          } else {
            // On retries, drop the cached resolution so the backend can
            // re-derive a working URL — a transient network glitch can leave
            // a poisoned entry in `streamCache` that would otherwise fail
            // identically on every attempt.
            if (retriesLeft < MAX_LOAD_ATTEMPTS - 1) invalidateStream(effectiveVideoId);
            const stream = await withTimeout(
              resolveStream(effectiveVideoId),
              STREAM_RESOLVE_TIMEOUT_MS,
              "Resolving this track's audio took too long.",
            );
            // Compare against the actual queue-track id here, not the audio-cache
            // key. Stream tracks may intentionally include an album suffix in
            // `id` (for release-specific UI identity) while still sharing the
            // shorter `yt:<videoId>` cache key for audio analysis.
            if (cancelled || trackRef.current?.id !== currentTrack.id) return;
            setCurrentAudioPath(stream.filePath ?? null);
            src = stream.filePath ? convertFileSrc(stream.filePath) : stream.url ?? null;
          }
          }
        }

        if (!src) throw new Error("No audio source is available for this track.");
        if (cancelled) return;
        audio.src = src;

        // Re-apply the output gain so a new track loaded after a pause
        // doesn't inherit the gain=0 that togglePlay's pause branch set
        // on the previous track. Without this, the new track plays
        // silently until the user nudges the volume slider or
        // pause+unpauses (both of which re-trigger applyOutputLevels).
        // We use a hard setValueAtTime (not applyOutputLevels' 0.15s
        // exponential ramp) so the first frame of a fresh track plays
        // at the correct level rather than ramping up from silence.
        {
          const gainNode = gainNodeRef.current;
          const ctx = audioContextRef.current;
          if (gainNode && ctx) {
            const now = ctx.currentTime;
            const masterVolumeDb = getSetting("masterVolume");
            const masterVolumeGain = Math.pow(10, masterVolumeDb / 20);
            const normalizationEnabled = getSetting("audioNormalization");
            const effectiveGain = normalizationEnabled
              ? (Number.isFinite(normGainRef.current) && normGainRef.current > 0
                ? normGainRef.current
                : 1)
              : 1;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(
              effectiveGain * clampVolume(volumeRef.current) * masterVolumeGain,
              now,
            );
            // Mirror applyOutputLevels: when the gain node is the master,
            // keep the audio element at 1 so it doesn't double-attenuate
            // the signal. Defensive against setLiveVolume (the slider's
            // onChange) having run between the previous track's
            // applyOutputLevels and this block.
            audio.volume = 1;
          }
          audio.muted = mutedRef.current;
        }

        // On initial app boot, any track that was loaded without an explicit
        // user play() call (session restore, etc.) must start paused so the
        // app never auto-plays on launch. Also seek to the saved position
        // carried by seekOnNextLoadRef.
        if (isSessionRestoreRef.current) {
          const savedPos = seekOnNextLoadRef.current;
          seekOnNextLoadRef.current = 0;
          if (savedPos > 0) audio.currentTime = savedPos;
          audio.pause();
          isSessionRestoreRef.current = false;
          setIsPlaying(false);
          setIsBuffering(false);
          loadInProgressRef.current = false;
          setLastError(null);
          return;
        }

        await audio.play();
        // Successful playback — clear the in-flight flag so the global error
        // handler resumes normal behavior, and wipe any stale error message
        // captured during earlier failed attempts.
        if (cancelled) return;
        loadInProgressRef.current = false;
        setLastError(null);
      } catch (err) {
        if (cancelled) return;
        lastAttemptError = err;
        if (retriesLeft <= 0) {
          finalize();
          return;
        }
        const delayIdx = MAX_LOAD_ATTEMPTS - 1 - retriesLeft;
        const delay = RETRY_DELAY_MS[Math.min(delayIdx, RETRY_DELAY_MS.length - 1)] ?? 1500;
        retriesLeft--;
        activeRetryTimer = setTimeout(() => {
          if (cancelled) return;
          void attempt();
        }, delay);
      }
    };

    void attempt();

    return () => {
      cancelled = true;
      loadInProgressRef.current = false;
      if (activeRetryTimer) clearTimeout(activeRetryTimer);
      audio.pause();
      audio.currentTime = 0;
    };
  }, [currentTrack, ensureAudioGraph, loadToken]);

  useEffect(() => {
    if (!currentTrack) {
      setNormGain(1);
      setCurrentAudioPath(null);
      return;
    }
    const targetLufs = loadTargetLufs();
    const loudnessCacheKey = getAudioCacheKey(currentTrack);
    const loudness = getCachedLoudness(loudnessCacheKey);
    if (loudness) {
      setNormGain(computeLinearGain(loudness, targetLufs));
    } else if (hasAttemptedAnalysis(loudnessCacheKey)) {
      setNormGain(1);
    } else {
      setNormGain(getInitialGain(targetLufs));
    }

    const filePath = currentAudioPath ?? (currentTrack.source === "upload" ? currentTrack.filePath : null);
    if (!filePath || loudness) return;

    let cancelled = false;
    void (async () => {
      let previewApplied = false;

      const previewStarts = buildLoudnessPreviewStarts(currentTrack.durationSeconds);
      for (const startSeconds of previewStarts) {
        try {
          const preview = await analyzeLoudnessChunk(filePath, startSeconds, LOUDNESS_PREVIEW_CHUNK_SECONDS);
          if (cancelled || trackRef.current?.id !== currentTrack.id) return;
          if (!isUsefulPreviewLoudness(preview)) continue;

          const previewGain = computeLinearGain(preview, targetLufs);
          previewApplied = true;

          // Apply preview gain in either direction. The 150ms target-at-time
          // ramp on the gain node (called by `applyOutputLevels`) smooths the
          // mid-play transition, so a quiet track can be boosted up to its
          // final level within ~16 seconds of playback instead of waiting
          // for the slower full-track analysis. The 0.01 threshold is a
          // float-noise guard — anything smaller is treated as "no change"
          // to avoid pointless React re-renders.
          if (Math.abs(previewGain - normGainRef.current) > 0.01) {
            setNormGain(previewGain);
          }
          break;
        } catch (error) {
          console.warn("Preview loudness analysis failed:", error);
          break;
        }
      }

      try {
        const data = await analyzeLoudness(filePath);
        if (cancelled || trackRef.current?.id !== currentTrack.id) return;

        // Cache the analysis result even if unusable/empty, to prevent repeated analyze_loudness calls.
        setCachedLoudness(loudnessCacheKey, data);

        if (isUsableLoudness(data)) {
          setNormGain(computeLinearGain(data, targetLufs));
        } else if (!previewApplied) {
          setNormGain(1);
        }
      } catch (error) {
        console.warn("Loudness analysis failed:", error);
        if (cancelled || trackRef.current?.id !== currentTrack.id) return;
        // Cache empty data on error so we don't retry
        setCachedLoudness(loudnessCacheKey, { integratedLufs: null, truePeak: null });
        if (!previewApplied) {
          setNormGain(1);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, currentTrack?.source, currentTrack?.filePath, currentTrack?.durationSeconds, currentAudioPath]);

  // Prefetch audio for the next several stream tracks and pre-analyze their
  // loudness AND leading silence so playback is seamless.
  useEffect(() => {
    let cancelled = false;
    const upcoming = queue
      .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
      .filter((track) => track.source === "stream" && (track.resolvedVideoId ?? track.videoId));
    for (const track of upcoming) {
      void (async () => {
        try {
          const effectiveVideoId = track.resolvedVideoId ?? track.videoId!;
          const stream = await resolveStream(effectiveVideoId);
          if (cancelled || !stream.filePath) return;

          const cacheKey = getAudioCacheKey(track);
          if (!getCachedLoudness(cacheKey) && !hasAttemptedAnalysis(cacheKey)) {
            try {
              const data = await analyzeLoudness(stream.filePath);
              if (cancelled) return;
              setCachedLoudness(cacheKey, data);
            } catch (error) {
              console.warn("Prefetch loudness analysis failed:", error);
            }
          }

        } catch (error) {
          console.warn("Prefetch stream resolve failed:", error);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [queue, queueIndex]);

  // Prefetch synced lyrics for the next several tracks so the lyrics page
  // opens instantly instead of showing a loading spinner.
  useEffect(() => {
    let cancelled = false;
    const upcoming = queue
      .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
      .filter((track) => track.source === "stream" && (track.resolvedVideoId ?? track.videoId));
    for (const track of upcoming) {
      void getSyncedLyrics(track.resolvedVideoId ?? track.videoId!).then(() => {
        if (cancelled) return;
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [queue, queueIndex]);

  const resolveTrackAudio = useCallback(async (track: MediaTrack): Promise<MediaTrack> => {
    if (track.source !== "stream" || !track.videoId) return track;
    // Substitute music-video entries (kind === "video") with the audio-only
    // song found via search. Instead of changing the track's `videoId`/
    // `id` (which would break `isTrackActive` matching against the original
    // track still shown in track lists), we set `resolvedVideoId` to the
    // canonical Topic-upload videoId. The load effect and prefetch logic
    // use `resolvedVideoId ?? videoId` for actual stream resolution.
    // Display metadata (title, artist, album, cover) is preserved as-is.
    if (track.kind === "video") {
      try {
        const matched = await findClosestSongForVideoTrack(track);
        if (matched && matched.videoId && matched.videoId !== track.videoId) {
          return { ...track, resolvedVideoId: matched.videoId };
        }
        return track;
      } catch {
        return track;
      }
    }
    // For song and undefined-kind entries (album tracks typically have no
    // type label, so `kind` is undefined), check whether the videoId actually
    // points to a music video instead of the canonical Topic upload. YouTube
    // Music sometimes assigns a music-video videoId to song-kind entries,
    // especially when the music video is the top result. If the search finds
    // a different song-kind videoId for the same (artist, title), set
    // `resolvedVideoId` to the canonical videoId — all display metadata
    // (title, artist, album, cover, browse ids, videoId, id) is preserved
    // so the UI and active-state checks are unaffected.
    if (track.kind !== "episode" && track.kind !== "podcast") {
      try {
        const canonicalVideoId = await findCanonicalSongVideoId(track);
        if (canonicalVideoId && canonicalVideoId !== track.videoId) {
          return { ...track, resolvedVideoId: canonicalVideoId };
        }
      } catch {
        // Ignore search errors — play with the original videoId.
      }
    }
    return track;
  }, []);

  const play = useCallback(async (track: MediaTrack) => {
    // Record the previous track in history before any async work so that
    // navigating away while a track is still loading still registers it.
    if (trackRef.current) rememberPlaybackHistory();
    isSessionRestoreRef.current = false;
    const version = ++playVersionRef.current;
    stopCurrentPlayback();
    autoplayAdvancePendingRef.current = false;
    const resolved = await resolveTrackAudio(track);
    // A newer play() call has superseded this one — bail out so we don't
    // overwrite the queue with stale state.
    if (version !== playVersionRef.current) return;
    const seedVideoId = resolved.resolvedVideoId ?? resolved.videoId;
    const nextSeed = resolved.source === "stream" && seedVideoId
      ? { videoId: seedVideoId, playlistId: null }
      : null;
    setQueueState({
      queue: [resolved],
      queueIndex: 0,
      queueOrigin: null,
      autoplayTrackIds: [],
      autoplaySeed: nextSeed,
    });
    // Proactively kick off the autoplay fetch in lockstep with the queue
    // being seeded so the "up next" tracks begin streaming immediately,
    // mirroring the pattern `reloadAutoplay` already uses. Relying solely
    // on the toppings effect to pick up the new seed left the FIRST song
    // of a session vulnerable to a race in which the seed never fired a
    // fetch (and the queue sat empty), forcing a manual Reload click to
    // recover. Firing here — guarded by `fetchingAutoplayRef` inside
    // fetchAndAppendAutoplay so it never double-fetches — closes the gap.
    if (nextSeed) {
      void fetchAndAppendAutoplay(nextSeed);
    }
  }, [rememberPlaybackHistory, stopCurrentPlayback, resolveTrackAudio, setQueueState]);

  const playMany = useCallback(async (tracks: MediaTrack[], startIndex = 0, origin?: QueueOrigin) => {
    if (tracks.length === 0) return;
    // Record the previous track in history before any async work.
    if (trackRef.current) rememberPlaybackHistory();
    isSessionRestoreRef.current = false;
    const version = ++playVersionRef.current;
    stopCurrentPlayback();
    autoplayAdvancePendingRef.current = false;

    // Only the track at `startIndex` (the one about to play) needs to be
    // resolved BEFORE the queue is committed — resolving every track upfront
    // would issue N concurrent search API calls and block the play button
    // until they all settle. The remaining tracks are kept in the queue as-is
    // and are lazily resolved one-at-a-time by the load effect's
    // `resolveTrackAudio` when each becomes current.
    const clampedStart = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const resolvedFirst = await resolveTrackAudio(tracks[clampedStart]);
    if (version !== playVersionRef.current) return;
    const resolved = tracks.slice();
    resolved[clampedStart] = resolvedFirst;
    const clampedIndex = Math.max(0, Math.min(startIndex, resolved.length - 1));
    const lastTrack = resolved[resolved.length - 1];
    const lastSeedVideoId = lastTrack ? (lastTrack.resolvedVideoId ?? lastTrack.videoId) : null;
    const nextSeed = lastTrack && lastTrack.source === "stream" && lastSeedVideoId
      ? { videoId: lastSeedVideoId, playlistId: null }
      : null;
    setQueueState({
      queue: resolved,
      queueIndex: clampedIndex,
      queueOrigin: origin ?? null,
      autoplayTrackIds: [],
      autoplaySeed: nextSeed,
    });
    // Proactively kick off the autoplay fetch in lockstep with the queue
    // being seeded so the "up next" tracks begin streaming immediately,
    // mirroring the pattern `reloadAutoplay` already uses. See `play` for
    // the full rationale behind closing the first-session race.
    if (nextSeed) {
      void fetchAndAppendAutoplay(nextSeed);
    }
  }, [rememberPlaybackHistory, stopCurrentPlayback, resolveTrackAudio, setQueueState]);

  const playShuffled = useCallback(async (tracks: MediaTrack[], origin?: QueueOrigin) => {
    if (tracks.length === 0) return;
    const shuffled = shuffledCopy(tracks);
    shuffleRef.current = true;
    setShuffle(true);
    await playMany(shuffled, 0, origin);
  }, [playMany]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }

    const masterVolumeDb = getSetting("masterVolume");
    const masterVolumeGain = Math.pow(10, masterVolumeDb / 20);
    const normalizationEnabled = getSetting("audioNormalization");
    const effectiveNormGain = normalizationEnabled ? normGainRef.current : 1;
    const crossfadeOn = getSetting("crossfade");

    if (audio.paused) {
      setIsPlaying(true);
      setIsBuffering(!audio.readyState || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
      void ensureAudioGraph();

      const gain = gainNodeRef.current;
      const ctx = audioContextRef.current;
      if (ctx && gain) {
        const now = ctx.currentTime;
        const target = effectiveNormGain * volumeRef.current * masterVolumeGain;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0, now);
        if (crossfadeOn) {
          gain.gain.linearRampToValueAtTime(target, now + 0.1);
        } else {
          gain.gain.setValueAtTime(target, now);
        }
      }

      void audio.play().catch((error) => {
        setIsPlaying(false);
        setIsBuffering(false);
        setLastError(error instanceof Error ? error.message : "Playback could not resume.");
      });
    } else {
      setIsPlaying(false);
      setIsBuffering(false);

      const gain = gainNodeRef.current;
      const ctx = audioContextRef.current;
      if (ctx && gain) {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        if (crossfadeOn) {
          gain.gain.linearRampToValueAtTime(0, now + 0.1);
        } else {
          gain.gain.setValueAtTime(0, now);
        }
      }

      if (crossfadeOn) {
        fadeTimeoutRef.current = setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.pause();
          }
          fadeTimeoutRef.current = null;
        }, 100);
      } else {
        audio.pause();
      }
    }
  }, [currentTrack, ensureAudioGraph]);

  const fetchAndAppendAutoplay = useCallback(async (overrideSeed?: AutoplaySeed | null) => {
    const seed = overrideSeed ?? autoplaySeedRef.current;
    if (!seed?.videoId || !autoplayRef.current) {
      autoplayAdvancePendingRef.current = false;
      // Cancel any pending auto-retry so disabling autoplay doesn't leave
      // the in-flight guard stuck (the toppings useEffect would otherwise
      // see `fetchingAutoplayRef.current === true` forever).
      if (fetchingAutoplayRef.current) {
        fetchingAutoplayRef.current = false;
      }
      if (autoplayRetryTimerRef.current) {
        clearTimeout(autoplayRetryTimerRef.current);
        autoplayRetryTimerRef.current = null;
      }
      autoplayRetryCountRef.current = 0;
      return;
    }
    if (fetchingAutoplayRef.current) return;
    fetchingAutoplayRef.current = true;
    let appended = false;
    let retryScheduled = false;
    let shouldRetry = true;

    // Schedule an auto-retry with exponential backoff. The first three
    // retries wait AUTOPLAY_RETRY_BASE_DELAY_MS each; after the 3rd retry
    // the delay begins doubling per subsequent retry (retry 4 → 6s,
    // retry 5 → 12s, retry 6 → 24s, ...).
    const tryScheduleRetry = () => {
      if (
        retryScheduled ||
        !autoplayRef.current ||
        !seed.videoId ||
        // If the seed has been replaced mid-fetch (e.g. user chained
        // play(A) → play(B) before the 3s watchdog fired), skip the
        // retry with the now-stale seed: it would just bounce off the
        // body's `autoplaySeedRef.current?.videoId !== seed.videoId`
        // guard and reschedule itself indefinitely.
        seed.videoId !== autoplaySeedRef.current?.videoId
      ) return;
      retryScheduled = true;
      const retryCount = autoplayRetryCountRef.current;
      autoplayRetryCountRef.current = retryCount + 1;
      const delay = retryCount < 3
        ? AUTOPLAY_RETRY_BASE_DELAY_MS
        : AUTOPLAY_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 2);
      if (autoplayRetryTimerRef.current) {
        clearTimeout(autoplayRetryTimerRef.current);
      }
      autoplayRetryTimerRef.current = setTimeout(() => {
        autoplayRetryTimerRef.current = null;
        // Briefly release the in-flight guard so the retry can re-enter
        // fetchAndAppendAutoplay (its own guard would otherwise block it).
        fetchingAutoplayRef.current = false;
        void fetchAndAppendAutoplay(seed);
      }, delay);
    };

    // Watchdog: if we haven't appended anything within
    // AUTOPLAY_FETCH_TIMEOUT_MS, treat the attempt as a failure and
    // trigger an auto-retry. The retry delay itself is computed by
    // tryScheduleRetry using the retry counter (which handles the
    // first-three-fixed-then-doubling schedule).
    const watchdog = setTimeout(() => {
      if (appended || !fetchingAutoplayRef.current) return;
      tryScheduleRetry();
    }, AUTOPLAY_FETCH_TIMEOUT_MS);

    try {
      const current = queueRef.current;
      const currentIndex = queueIndexRef.current;
      const autoplayIds = autoplayTrackIdsRef.current;
      const autoplayAhead = current
        .slice(currentIndex + 1)
        .filter((track) => autoplayIds.has(track.id)).length;
      const missingTracks = Math.max(0, AUTOPLAY_QUEUE_TARGET - autoplayAhead);
      if (missingTracks === 0) {
        // Queue already topped up — no point in scheduling a retry.
        shouldRetry = false;
        return;
      }

      const response = await getWatchPlaylist(seed.videoId, seed.playlistId ?? undefined);
      if (!autoplayRef.current || autoplaySeedRef.current?.videoId !== seed.videoId) return;
      if (response.playlistId) {
        const refreshedSeed = { videoId: seed.videoId, playlistId: response.playlistId ?? null };
        autoplaySeedRef.current = refreshedSeed;
        setAutoplaySeed(refreshedSeed);
      }
      if (response.tracks.length === 0) return;

      const incoming = response.tracks.filter(
        (entry) => entry.kind !== "episode" && entry.kind !== "podcast",
      );

      const transformed = await Promise.all(
        incoming.map(async (entry) => {
          if (entry.kind === "video") {
            const matched = await findClosestSongForVideoTrack(entry);
            return matched ?? null;
          }
          return entry;
        }),
      );
      const candidates = transformed.filter(
        (entry): entry is MediaTrack => entry !== null,
      );

      if (!autoplayRef.current || autoplaySeedRef.current?.videoId !== seed.videoId) return;

      const latestQueue = queueRef.current;
      // Build a rich dedup index from the queue: same song can appear with
      // different IDs (video vs song track), so we match on id, videoId,
      // and artist+title.
      const seenIds = new Set<string>();
      const seenVideoIds = new Set<string>();
      const seenArtistTitles = new Set<string>();
      for (const entry of latestQueue) {
        seenIds.add(entry.id);
        if (entry.videoId) seenVideoIds.add(entry.videoId);
        const key = `${entry.artist}\0${entry.title}`.toLowerCase();
        seenArtistTitles.add(key);
      }
      // Also mark manually queued songs so they never appear in autoplay.
      const manualVideoIds = new Set<string>();
      const manualArtistTitles = new Set<string>();
      for (const entry of latestQueue) {
        if (autoplayIds.has(entry.id)) continue;
        if (entry.videoId) manualVideoIds.add(entry.videoId);
        const key = `${entry.artist}\0${entry.title}`.toLowerCase();
        manualArtistTitles.add(key);
      }
      function isDuplicate(entry: MediaTrack): boolean {
        if (seenIds.has(entry.id)) return true;
        if (entry.videoId && (seenVideoIds.has(entry.videoId) || manualVideoIds.has(entry.videoId))) return true;
        const key = `${entry.artist}\0${entry.title}`.toLowerCase();
        if (seenArtistTitles.has(key) || manualArtistTitles.has(key)) return true;
        return false;
      }
      // Deduplicate within candidates themselves (same song can appear twice in
      // a watch playlist) before slicing.
      const uniqueCandidates: MediaTrack[] = [];
      for (const entry of candidates) {
        if (isDuplicate(entry)) continue;
        if (uniqueCandidates.some((c) => c.id === entry.id)) continue;
        seenIds.add(entry.id);
        if (entry.videoId) seenVideoIds.add(entry.videoId);
        const key = `${entry.artist}\0${entry.title}`.toLowerCase();
        seenArtistTitles.add(key);
        uniqueCandidates.push(entry);
      }
      let additions = uniqueCandidates.slice(0, Math.min(AUTOPLAY_QUEUE_BATCH_LIMIT, missingTracks));

      // If filtering left us under target, try a second fetch seeded from a
      // different song in the queue — bias toward the last songs so the
      // radio mood matches where the queue is heading.
      let secondAdditions: MediaTrack[] = [];
      let secondPlaylistId: string | null | undefined;
      const remaining = missingTracks - additions.length;
      if (remaining > 0 && latestQueue.length > 0) {
        const manualSongs = latestQueue.filter(
          (track) => !autoplayIds.has(track.id) && track.kind !== "video",
        );
        const secondCandidate = manualSongs[manualSongs.length - 1]
          ?? latestQueue[latestQueue.length - 1];
        if (secondCandidate?.videoId && secondCandidate.videoId !== seed.videoId) {
          try {
            const secondResponse = await getWatchPlaylist(secondCandidate.videoId);
            if (autoplayRef.current) {
              secondPlaylistId = secondResponse.playlistId;
              const secondIncoming = secondResponse.tracks.filter(
                (entry) => entry.kind !== "episode" && entry.kind !== "podcast",
              );
              const secondTransformed = await Promise.all(
                secondIncoming.map(async (entry) => {
                  if (entry.kind === "video") {
                    const matched = await findClosestSongForVideoTrack(entry);
                    return matched ?? null;
                  }
                  return entry;
                }),
              );
              const secondCandidates = secondTransformed.filter(
                (entry): entry is MediaTrack => entry !== null,
              );
              for (const entry of secondCandidates) {
                if (isDuplicate(entry)) continue;
                if (secondAdditions.some((c) => c.id === entry.id)) continue;
                seenIds.add(entry.id);
                if (entry.videoId) seenVideoIds.add(entry.videoId);
                const key = `${entry.artist}\0${entry.title}`.toLowerCase();
                seenArtistTitles.add(key);
                secondAdditions.push(entry);
                if (secondAdditions.length >= remaining) break;
              }
            }
          } catch {
            // Second fetch is best-effort; continue with what we have.
          }
        }
      }

      const allAdditions = [...additions, ...secondAdditions].slice(0, missingTracks);
      additions = allAdditions;
      if (additions.length === 0) return;

      // Exclude tracks found in the last 10 recently-played entries, then
      // compensate for any removed by fetching from the next manually-queued
      // song in the queue.
      const recentPlayedSet = buildRecentlyPlayedSet(playbackHistoryRef.current.slice(0, 10));
      const beforeFilter = additions.length;
      additions = additions.filter((t) => !isInRecentlyPlayed(t, recentPlayedSet));
      const filteredCount = beforeFilter - additions.length;

      if (filteredCount > 0 && latestQueue.length > 0) {
        const nextSeedTrack = latestQueue
          .slice(currentIndex + 1)
          .find((t) => !autoplayIds.has(t.id))
          ?? latestQueue[currentIndex + 1];
        if (nextSeedTrack?.videoId && nextSeedTrack.videoId !== seed.videoId) {
          try {
            const compResp = await getWatchPlaylist(nextSeedTrack.videoId);
            if (autoplayRef.current) {
              const compIncoming = compResp.tracks.filter(
                (e) => e.kind !== "episode" && e.kind !== "podcast",
              );
              const compTransformed = await Promise.all(
                compIncoming.map(async (entry) => {
                  if (entry.kind === "video") {
                    const matched = await findClosestSongForVideoTrack(entry);
                    return matched ?? null;
                  }
                  return entry;
                }),
              );
              const compCandidates = compTransformed.filter(
                (e): e is MediaTrack => e !== null,
              );
              const compAdditions: MediaTrack[] = [];
              for (const entry of compCandidates) {
                if (isDuplicate(entry)) continue;
                if (isInRecentlyPlayed(entry, recentPlayedSet)) continue;
                if (compAdditions.some((c) => c.id === entry.id)) continue;
                seenIds.add(entry.id);
                if (entry.videoId) seenVideoIds.add(entry.videoId);
                const key = `${entry.artist}\0${entry.title}`.toLowerCase();
                seenArtistTitles.add(key);
                compAdditions.push(entry);
                if (compAdditions.length >= filteredCount) break;
              }
              if (compAdditions.length > 0) {
                additions = [...additions, ...compAdditions];
              }
            }
          } catch {
            // Compensatory fetch is best-effort; continue with what we have.
          }
        }
      }

      appended = true;
      const nextQueue = [...latestQueue, ...additions];
      const nextAutoplayIds = new Set(autoplayIds);
      additions.forEach((track) => nextAutoplayIds.add(track.id));

      const songAdditions = additions.filter((track) => track.kind !== "video");
      const seedAdvance = songAdditions[songAdditions.length - 1] ?? additions[additions.length - 1];
      if (seedAdvance?.videoId) {
        const nextSeed = {
          videoId: seedAdvance.videoId,
          playlistId: secondPlaylistId ?? response.playlistId ?? seed.playlistId ?? null,
        };
        // Commit the queue members via setQueueState using the CURRENT
        // autoplaySeed (so the seed-change cleanup branch doesn't fire and
        // release `fetchingAutoplayRef` mid-execution, which would let the
        // toppings useEffect kick off a parallel fetch on commit). Then
        // bump the autoplaySeed directly through `autoplaySeedRef` +
        // `setAutoplaySeed` — mirroring the response handler's playlist-id
        // update path on the line above — which doesn't run cleanup, so
        // the in-flight guard stays held throughout this body's success path.
        setQueueState({
          queue: nextQueue,
          queueIndex: queueIndexRef.current,
          queueOrigin: queueOriginRef.current,
          autoplayTrackIds: nextAutoplayIds,
          autoplaySeed: autoplaySeedRef.current,
        });
        autoplaySeedRef.current = nextSeed;
        setAutoplaySeed(nextSeed);
      } else {
        setQueueState({
          queue: nextQueue,
          queueIndex: queueIndexRef.current,
          queueOrigin: queueOriginRef.current,
          autoplayTrackIds: nextAutoplayIds,
          autoplaySeed: autoplaySeedRef.current,
        });
      }

      if (autoplayAdvancePendingRef.current) {
        autoplayAdvancePendingRef.current = false;
        const nextIndex = queueIndexRef.current + 1;
        if (nextIndex < nextQueue.length) {
          setQueueState({
            queue: nextQueue,
            queueIndex: nextIndex,
            queueOrigin: queueOriginRef.current,
            autoplayTrackIds: nextAutoplayIds,
            autoplaySeed: autoplaySeedRef.current,
          });
        }
      }
    } catch (error) {
      console.warn("YT Music autoplay fetch failed:", error);
    } finally {
      clearTimeout(watchdog);
      if (appended) {
        // Success — clear retry state and release the in-flight flag so the
        // toppings useEffect can re-fire if more additions are still needed.
        autoplayRetryCountRef.current = 0;
        autoplayAdvancePendingRef.current = false;
        fetchingAutoplayRef.current = false;
        if (autoplayRetryTimerRef.current) {
          clearTimeout(autoplayRetryTimerRef.current);
          autoplayRetryTimerRef.current = null;
        }
      } else if (shouldRetry && !retryScheduled) {
        // Fast-failure (response empty, all-dedup'd, network error from the
        // watch-playlist backend) bypassed the AUTOPLAY_FETCH_TIMEOUT_MS
        // watchdog — schedule the retry now.
        tryScheduleRetry();
      }
      // else: retry was scheduled by the watchdog, or shouldRetry is false
      // (queue was already topped up). Either way the next attempt will
      // reset the in-flight flag when it actually runs.
    }
  }, [setQueueState]);

  const next = useCallback((recordRecentlyPlayed = false) => {
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    if (currentQueue.length === 0) return;
    if (currentIndex + 1 < currentQueue.length) {
      if (recordRecentlyPlayed) rememberPlaybackHistory();
      stopCurrentPlayback();
      setQueueState({
        queue: currentQueue,
        queueIndex: currentIndex + 1,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      return;
    }
    if (repeatRef.current === "all") {
      if (recordRecentlyPlayed) rememberPlaybackHistory();
      stopCurrentPlayback();
      setQueueState({
        queue: currentQueue,
        queueIndex: 0,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      return;
    }
    if (autoplayRef.current && autoplaySeedRef.current?.videoId) {
      if (recordRecentlyPlayed) rememberPlaybackHistory();
      stopCurrentPlayback();
      autoplayAdvancePendingRef.current = true;
      if (!fetchingAutoplayRef.current) void fetchAndAppendAutoplay();
    }
  }, [rememberPlaybackHistory, fetchAndAppendAutoplay, stopCurrentPlayback, setQueueState]);

  useEffect(() => {
    nextRef.current = next;
  }, [next]);

  const playQueueIndex = useCallback((index: number) => {
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) return;
    const nextIndex = Math.max(0, Math.min(index, currentQueue.length - 1));
    if (nextIndex === queueIndexRef.current) {
      togglePlay();
      return;
    }
    autoplayAdvancePendingRef.current = false;
    rememberPlaybackHistory();
    stopCurrentPlayback();
    setQueueState({
      queue: currentQueue,
      queueIndex: nextIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: autoplayTrackIdsRef.current,
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [rememberPlaybackHistory, stopCurrentPlayback, togglePlay, setQueueState]);

  const restoreHistoryEntry = useCallback((historyIndex: number) => {
    const entry = playbackHistoryRef.current[historyIndex];
    if (!entry) return;

    const currentEntry = capturePlaybackHistoryEntry();
    autoplayAdvancePendingRef.current = false;
    stopCurrentPlayback();
    setPlaybackHistory((current) => {
      const remaining = current.filter((_, index) => index !== historyIndex);
      if (!currentEntry || playbackHistoryEntriesEqual(currentEntry, entry)) {
        return remaining;
      }
      return [currentEntry, ...remaining].slice(0, RECENTLY_PLAYED_LIMIT);
    });

    let restoredEntry = entry;
    if (entry.queueOrigin) {
      const nonAutoplayIds = entry.queue
        .filter((track) => !entry.autoplayTrackIds.includes(track.id))
        .map((track) => track.id);
      if (nonAutoplayIds.length > 0) {
        const playedAfter = new Set<string>();
        const hist = playbackHistoryRef.current;
        for (let i = historyIndex + 1; i < hist.length; i += 1) {
          const hEntry = hist[i];
          playedAfter.add(hEntry.track.id);
          for (let j = hEntry.queueIndex; j < hEntry.queue.length; j += 1) {
            playedAfter.add(hEntry.queue[j].id);
          }
        }
        const allPlayed = nonAutoplayIds.every((id) => playedAfter.has(id));
        if (allPlayed) {
          restoredEntry = { ...entry, queueOrigin: null };
        }
      }
    }

    applyPlaybackHistoryEntry(restoredEntry);
  }, [capturePlaybackHistoryEntry, stopCurrentPlayback, applyPlaybackHistoryEntry]);

  const moveQueueItem = useCallback((fromIndex: number, toIndex: number) => {
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    if (
      fromIndex <= currentIndex ||
      toIndex <= currentIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= currentQueue.length ||
      toIndex >= currentQueue.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const nextQueue = currentQueue.slice();
    const [movedTrack] = nextQueue.splice(fromIndex, 1);
    if (!movedTrack) return;
    nextQueue.splice(toIndex, 0, movedTrack);
    setQueueState({
      queue: nextQueue,
      queueIndex: currentIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: autoplayTrackIdsRef.current,
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [setQueueState]);

  const clearQueue = useCallback(() => {
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    const autoplayIds = autoplayTrackIdsRef.current;
    if (currentQueue.length === 0 || currentIndex < 0) return;
    const head = currentQueue.slice(0, currentIndex + 1);
    const autoplayTail = currentQueue.slice(currentIndex + 1).filter(t => autoplayIds.has(t.id));
    setQueueState({
      queue: [...head, ...autoplayTail],
      queueIndex: currentIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: autoplayIds,
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [setQueueState]);

  // Remove a track from the active queue without disturbing the rest of
  // the session. Used when a locally uploaded track is deleted from disk
  // while it (or a later copy of it) is in the queue.
  //
  //   * If the removed track is the current one AND the last in the
  //     queue, the queue is cleared entirely. The effect that derives
  //     `currentTrack` from the queue then sets it to `null`, which
  //     hides the player bar until the user plays something new.
  //   * If the removed track is the current one but NOT the last, the
  //     queue index is kept where it is — the new queue[queueIndex] is
  //     the next track, which the load effect will pick up and play.
  //   * If the removed track is BEFORE the current one, the index
  //     shifts down by 1 so the same track keeps playing.
  //   * If the removed track is AFTER the current one, the index is
  //     unchanged and playback continues uninterrupted.
  //
  // The audio is paused before the state mutation when the current
  // track itself is being removed, so the deleted file doesn't keep
  // playing for a frame between the queue update and the load effect
  // resolving the new current track.
  const removeTrackFromQueue = useCallback((trackId: string) => {
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    const removeIndex = currentQueue.findIndex((t) => t.id === trackId);
    if (removeIndex < 0) return;

    const isCurrent = removeIndex === currentIndex;
    const wasLast = removeIndex === currentQueue.length - 1;

    let finalQueue: MediaTrack[];
    let finalIndex: number;
    if (isCurrent && wasLast) {
      finalQueue = [];
      finalIndex = 0;
    } else {
      finalQueue = currentQueue.filter((t) => t.id !== trackId);
      finalIndex = removeIndex < currentIndex ? currentIndex - 1 : currentIndex;
      if (finalIndex >= finalQueue.length) {
        finalIndex = Math.max(0, finalQueue.length - 1);
      }
    }

    const autoplayIds = autoplayTrackIdsRef.current;
    const nextAutoplayIds = autoplayIds.has(trackId)
      ? new Set(Array.from(autoplayIds).filter((id) => id !== trackId))
      : autoplayIds;

    if (isCurrent) {
      stopCurrentPlayback();
    }

    setQueueState({
      queue: finalQueue,
      queueIndex: finalIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: nextAutoplayIds,
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [setQueueState, stopCurrentPlayback]);

  // Append tracks to the end of the queue while preserving the
  // user-queued/autoplay boundary: existing items stay in their slots,
  // newly-added tracks go BEHIND the user's manually-queued tail and
  // AHEAD of any autoplay tail. Tracks already in the autoplay section
  // are pulled forward into the manual section. When an `origin` is
  // provided (e.g. an album context-menu "Add to queue"), each added
  // track is tagged with it so QueuePanel can render per-origin section
  // headers. `queueOrigin` is NOT changed — that only tracks the active
  // playback session and controls the play-button state.
  const appendToQueue = useCallback((tracks: MediaTrack[], origin?: QueueOrigin) => {
    if (tracks.length === 0) return;
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    const autoplayIds = autoplayTrackIdsRef.current;

    // Find the boundary where the manually-queued tail meets the
    // autoplay tail. Anything from `splitAfter` onward is autoplay.
    let splitAfter = currentQueue.length;
    if (autoplayIds.size > 0) {
      for (let i = currentIndex + 1; i < currentQueue.length; i += 1) {
        if (autoplayIds.has(currentQueue[i]?.id ?? "")) {
          splitAfter = i;
          break;
        }
      }
    }

    const manualIds = new Set(currentQueue.slice(0, splitAfter).map((e) => e.id));
    const autoplayIdSet = new Set(currentQueue.slice(splitAfter).map((e) => e.id));

    // Walk the incoming list in order. Skip tracks already in the manual
    // section (dedup). Pull forward tracks that are in the autoplay
    // section. Append new tracks.
    const tracksToAdd: MediaTrack[] = [];
    const removedAutoplayIds = new Set<string>();
    for (const track of tracks) {
      if (manualIds.has(track.id)) continue;
      if (autoplayIdSet.has(track.id)) {
        removedAutoplayIds.add(track.id);
        tracksToAdd.push(origin ? { ...track, _labelOrigin: origin } : track);
        continue;
      }
      tracksToAdd.push(origin ? { ...track, _labelOrigin: origin } : track);
    }
    if (tracksToAdd.length === 0) return;

    const head = currentQueue.slice(0, splitAfter);
    const tail = currentQueue.slice(splitAfter).filter((t) => !removedAutoplayIds.has(t.id));
    const nextQueue = [...head, ...tracksToAdd, ...tail];

    const nextAutoplayIds = new Set(autoplayIds);
    for (const id of removedAutoplayIds) nextAutoplayIds.delete(id);

    setQueueState({
      queue: nextQueue,
      queueIndex: currentIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: nextAutoplayIds,
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [setQueueState]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Restart the current track if past the 5-second threshold.
    if (audio.currentTime > 5) {
      audio.currentTime = 0;
      setProgress(0);
      return;
    }
    // Move backward within the queue if possible.
    if (queueIndex > 0) {
      stopCurrentPlayback();
      setQueueState({
        queue: queueRef.current,
        queueIndex: queueIndex - 1,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      return;
    }
    // At queue start, restore the most recent playback context instead of
    // flattening it into a one-song queue.
    if (playbackHistoryRef.current[0]) {
      restoreHistoryEntry(0);
    } else {
      // No history — just restart the current track.
      audio.currentTime = 0;
      setProgress(0);
    }
  }, [queueIndex, stopCurrentPlayback, restoreHistoryEntry, setQueueState]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration || 0, seconds));
    setProgress(audio.currentTime);
  }, [duration]);

  const setVolume = useCallback((value: number) => {
    setVolumeState(Math.max(0, Math.min(1, value)));
    setMuted(false);
  }, []);

  const setLiveVolume = useCallback((value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const cleanVolume = clampVolume(value);
    const cleanGain = Number.isFinite(normGainRef.current) && normGainRef.current > 0 ? normGainRef.current : 1;
    const gainNode = gainNodeRef.current;

    const masterVolumeDb = getSetting("masterVolume");
    const masterVolumeGain = Math.pow(10, masterVolumeDb / 20);
    const normalizationEnabled = getSetting("audioNormalization");
    const effectiveGain = normalizationEnabled ? cleanGain : 1;

    if (gainNode && audioContextRef.current) {
      const now = audioContextRef.current.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(effectiveGain * cleanVolume * masterVolumeGain, now, 0.015);
      audio.volume = 1;
    } else {
      audio.volume = clampVolume(cleanVolume * effectiveGain * masterVolumeGain);
    }
    audio.muted = false;
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((value) => !value);
  }, []);

  const toggleShuffle = useCallback(() => {
    const enabled = !shuffleRef.current;
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    if (!enabled) {
      setQueueState({
        queue: currentQueue,
        queueIndex: currentIndex,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
        shuffle: false,
      });
      return;
    }

    const nextQueue = currentQueue.length - currentIndex <= 2
      ? currentQueue
      : [
        ...currentQueue.slice(0, currentIndex + 1),
        ...shuffledCopy(currentQueue.slice(currentIndex + 1)),
      ];
    setQueueState({
      queue: nextQueue,
      queueIndex: currentIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: autoplayTrackIdsRef.current,
      autoplaySeed: autoplaySeedRef.current,
      shuffle: true,
    });
  }, [setQueueState]);

  const cycleRepeat = useCallback(() => {
    setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"));
  }, []);

  const setAutoplay = useCallback((value: boolean) => {
    autoplayRef.current = value;
    setAutoplayState(value);
    if (value) {
      const current = trackRef.current;
      if (!autoplaySeedRef.current && current?.source === "stream" && current.videoId) {
        const nextSeed = { videoId: current.videoId, playlistId: null };
        autoplaySeedRef.current = nextSeed;
        setAutoplaySeed(nextSeed);
      }
      return;
    }

    // Cancel any pending auto-retry and release the in-flight guard so
    // re-enabling autoplay later starts from a clean state (otherwise the
    // toppings useEffect could see `fetchingAutoplayRef.current === true`
    // and short-circuit).
    if (fetchingAutoplayRef.current) {
      fetchingAutoplayRef.current = false;
    }
    if (autoplayRetryTimerRef.current) {
      clearTimeout(autoplayRetryTimerRef.current);
      autoplayRetryTimerRef.current = null;
    }
    autoplayRetryCountRef.current = 0;

    autoplayAdvancePendingRef.current = false;
    const sourceIds = autoplayTrackIdsRef.current;
    const currentIndex = queueIndexRef.current;
    const nextQueue = sourceIds.size > 0
      ? queueRef.current.filter((track, index) => index <= currentIndex || !sourceIds.has(track.id))
      : queueRef.current;
    setQueueState({
      queue: nextQueue,
      queueIndex: Math.min(currentIndex, Math.max(0, nextQueue.length - 1)),
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: [],
      autoplaySeed: autoplaySeedRef.current,
    });
  }, [setQueueState]);

  const reloadAutoplay = useCallback(async () => {
    const current = trackRef.current;
    if (!current?.videoId) return;
    if (!autoplayRef.current) return;
    setIsReloadingAutoplay(true);
    try {
      const sourceIds = autoplayTrackIdsRef.current;
      const currentIndex = queueIndexRef.current;
      const nextQueue = sourceIds.size > 0
        ? queueRef.current.filter((track, index) => index <= currentIndex || !sourceIds.has(track.id))
        : queueRef.current;
      const nextSeed: AutoplaySeed = { videoId: current.videoId, playlistId: null };
      setQueueState({
        queue: nextQueue,
        queueIndex: Math.min(currentIndex, Math.max(0, nextQueue.length - 1)),
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: [],
        autoplaySeed: nextSeed,
      });
      invalidateWatchPlaylist(current.videoId);
      await fetchAndAppendAutoplay(nextSeed);
    } finally {
      setIsReloadingAutoplay(false);
    }
  }, [fetchAndAppendAutoplay, setQueueState]);

  const clearError = useCallback(() => setLastError(null), []);

  const retry = useCallback(() => {
    // Bumping the load token re-runs the load effect from scratch on the
    // current `currentTrack`, including clearing the audio src + retrying up
    // to MAX_LOAD_ATTEMPTS times. The effect itself clears lastError and
    // resets buffering when it starts.
    if (!currentTrack) return;
    setLoadToken((token) => token + 1);
  }, [currentTrack]);

  // ── MediaSession API ────────────────────────────────────────────────
  // Exposes the current track and playback controls to the OS so media
  // keys, headphone buttons, Bluetooth remotes, and the system media
  // overlay (notification centre, lock screen) work as expected.

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;

    const track = trackRef.current;
    if (!track) {
      session.metadata = null;
      return;
    }

    const artwork: MediaImage[] = track.cover
      ? [{ src: track.cover, sizes: "512x512", type: "image/jpeg" }]
      : [];

    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album ?? undefined,
      artwork,
    });
  }, [currentTrack]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    session.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    if (duration > 0 && Number.isFinite(duration)) {
      session.setPositionState({
        duration: duration,
        playbackRate: 1,
        position: Math.min(progress, duration),
      });
    }
  }, [progress, duration]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;

    session.setActionHandler("play", () => {
      togglePlay();
    });
    session.setActionHandler("pause", () => {
      togglePlay();
    });
    session.setActionHandler("previoustrack", () => {
      prev();
    });
    session.setActionHandler("nexttrack", () => {
      next();
    });
    session.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") {
        seek(details.seekTime);
      }
    });
    session.setActionHandler("stop", () => {
      stopCurrentPlayback();
    });

    return () => {
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
      session.setActionHandler("previoustrack", null);
      session.setActionHandler("nexttrack", null);
      session.setActionHandler("seekto", null);
      session.setActionHandler("stop", null);
    };
  }, [togglePlay, prev, next, seek, stopCurrentPlayback]);

  // When autoplay is on, keep the autoplay-backed queue topped back up to 10.
  useEffect(() => {
    if (!autoplay) return;
    const seed = autoplaySeed;
    if (!seed?.videoId) return;
    const autoplayAhead = queue
      .slice(queueIndex + 1)
      .filter((track) => autoplayTrackIds.has(track.id)).length;
    if (autoplayAhead >= AUTOPLAY_QUEUE_TARGET) return;
    if (fetchingAutoplayRef.current) return;
    void fetchAndAppendAutoplay(seed);
  }, [autoplay, autoplaySeed, autoplayTrackIds, queue, queueIndex, fetchAndAppendAutoplay]);

  // ── Session persistence (saveTimestamp) ─────────────────────────────
  // Persists the current track and playback position so the user can
  // resume where they left off after restarting the app.

  // Session restore on first mount.
  useEffect(() => {
    const isOn = getSetting("saveTimestamp");
    if (!isOn) return;

    const raw = getItem(SESSION_KEY);
    if (!raw) return;

    let data: { track: MediaTrack; progress: number; savedAt: number } | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      removeItem(SESSION_KEY);
      return;
    }
    if (!data?.track?.id || typeof data.progress !== "number") {
      removeItem(SESSION_KEY);
      return;
    }
    // Stale after 24 hours — discard silently.
    if (Date.now() - data.savedAt > 86_400_000) {
      removeItem(SESSION_KEY);
      return;
    }

    isSessionRestoreRef.current = true;

    const restored = data.track;
    setQueueState({
      queue: [restored],
      queueIndex: 0,
      queueOrigin: null,
      autoplayTrackIds: [],
      autoplaySeed:
        restored.source === "stream" && restored.videoId
          ? { videoId: restored.videoId, playlistId: null }
          : null,
    });

    // Carry the saved position so the load effect can seek before the
    // first paint instead of flashing at 0:00.
    seekOnNextLoadRef.current = data.progress;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic session save while a track is active. Toggling
  // `saveTimestamp` mid-session must take effect immediately (otherwise
  // the interval keeps writing saves until the next track change), so
  // we read the setting via the reactive `useSetting` hook and add it
  // to the deps array.
  const saveTimestampEnabled = useSetting("saveTimestamp");
  useEffect(() => {
    if (!currentTrack || !saveTimestampEnabled) {
      if (sessionSaveTimerRef.current) {
        clearInterval(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      return;
    }

    const save = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused || !currentTrack) return;
      const ct = audio.currentTime;
      if (!Number.isFinite(ct) || ct <= 0) return;

      setItem(
        SESSION_KEY,
        JSON.stringify({ track: currentTrack, progress: ct, savedAt: Date.now() }),
      );
    };

    sessionSaveTimerRef.current = setInterval(save, 10_000);

    return () => {
      if (sessionSaveTimerRef.current) {
        clearInterval(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, [currentTrack?.id, saveTimestampEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const getAnalyser = useCallback(() => analyserRef.current, []);

  const setEqualizerBand = useCallback((index: number, gain: number) => {
    const filters = eqFiltersRef.current;
    if (filters[index]) {
      filters[index].gain.value = gain;
    }
  }, []);

  const value = useMemo<PlayerContextValue>(
    () => ({
      currentTrack,
      queue,
      queueIndex,
      queueOrigin,
      autoplayTrackIds,
      previousQueue,
      recentlyPlayed,
      isPlaying,
      isBuffering,
      isReloadingAutoplay,
      progress,
      duration,
      volume,
      muted,
      shuffle,
      repeat,
      autoplay,
      autoplaySeed,
      lastError,
      normGain,
      play,
      playMany,
      playShuffled,
      playQueueIndex,
      restoreHistoryEntry,
      moveQueueItem,
      clearQueue,
      removeTrackFromQueue,
      appendToQueue,
      togglePlay,
      next,
      prev,
      seek,
      setVolume,
      setLiveVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
      setAutoplay,
      reloadAutoplay,
      clearError,
      retry,
      getAnalyser,
      setEqualizerBand,
    }),
    [
      clearError,
      currentTrack,
      duration,
      getAnalyser,
      isBuffering,
      isPlaying,
      isReloadingAutoplay,
      lastError,
      muted,
      moveQueueItem,
      clearQueue,
      removeTrackFromQueue,
      appendToQueue,
      next,
      normGain,
      play,
      playMany,
      playShuffled,
      playQueueIndex,
      restoreHistoryEntry,
      prev,
      progress,
      queue,
      queueIndex,
      queueOrigin,
      autoplayTrackIds,
      previousQueue,
      recentlyPlayed,
      reloadAutoplay,
      repeat,
      retry,
      seek,
      setAutoplay,
      setEqualizerBand,
      setVolume,
      setLiveVolume,
      shuffle,
      toggleMute,
      togglePlay,
      toggleShuffle,
      cycleRepeat,
      volume,
      autoplay,
      autoplaySeed,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
