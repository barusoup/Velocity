import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  analyzeLoudness,
  analyzeLoudnessChunk,
  detectLeadingSilence,
  evictPersistedLyricsExcept,
  hydratePersistedLyricsForTrack,
  persistCachedLyricsForTrack,
  prefetchSyncedLyricsForTrack,
  getWatchPlaylist,
  getOfflinePathForTrack,
  hydrateUploadTrackForPlayback,
  invalidateStream,
  invalidateWatchPlaylist,
  resolveStream,
} from "./api";
import type { MediaTrack, QueueOrigin } from "./types";
import { useCollectionStore } from "./store/collectionStore";
import { usePlayerUiStore } from "./store/playerUiStore";
import {
  DEFAULT_VOLUME,
  subscribeTransport,
  usePlayerTransportStore,
} from "./store/playerTransportStore";
import {
  getCachedLoudness,
  isUsableLoudness,
  loadTargetLufs,
  setCachedLoudness,
  computeLinearGain,
  getInitialGain,
  hasAttemptedAnalysis,
} from "./normalization";
import {
  hasAttemptedLeadingSilenceAnalysis,
  LEADING_SILENCE_DETECT_TIMEOUT_MS,
  setCachedLeadingSilence,
} from "./leading-silence";
import { getSetting, setSetting, SETTINGS_KEY, useSetting } from "./settings";
import { getItem, setItem, removeItem } from "./storage";
import { enrichUploadMetadataFromYtm } from "./utils/upload-enrichment";
import {
  exportStreamVideoId,
  filterQueueableTracks,
  isQueueableTrack,
  readLiveMediaDuration,
  readDuration,
  remapQueueStartIndex,
  resolveFileMediaSrc,
  streamIdentityVideoIds,
} from "./utils/media";
import {
  mergeTrackMetadata,
  resolveTrackMetadata,
} from "./utils/track-metadata-backfill";
import {
  resolveAutoplayEntryToSong,
  resolveStreamTrackAudio,
  resolveStreamTrackAudioFallback,
} from "./utils/song-resolution";
import { resolveAutoplayAdditions } from "./utils/autoplayResolver";
import { createSemaphore } from "./utils/concurrency";
import {
  addVisitedQueueTrack,
  findPreviousVisitedQueueIndex,
  removeVisitedQueueTrack,
  resetVisitedQueueTracks,
  resolveHistoryVisitedTrackIds,
  restoreVisitedQueueTracks,
} from "./player/queue-visited";
import {
  compactQueueForHistorySnapshot
} from "./player/playback-history-snapshot";
import {
  bootAutoplaySeed,
  buildLoudnessPreviewStarts,
  buildRecentlyPlayedSet,
  buildSeenIndex,
  clampVolume,
  describeMediaError,
  findPreviousSessionHistoryIndex,
  getAudioCacheKey,
  historyRestoreWouldDropAppendedTracks,
  isInRecentlyPlayed,
  isPlaybackIdleLongEnough,
  isRedoingQueueAdvance,
  isStaleLoadError,
  isUsefulPreviewLoudness,
  parseSavedSessionRaw,
  playbackEntryMatchesQueueSession,
  playbackNeedsSourceRefresh,
  prependPlaybackHistoryEntry,
  queueOriginEquals,
  readAudioElementDuration,
  readMuted,
  readVolume,
  shuffledCopy,
  waitForMediaReady,
  withTimeout,
  type PlaybackHistoryEntry,
  type SavedSession,
} from "./player/helpers";

export const currentAudio: { current: HTMLAudioElement | null } = { current: null };
// While the music-video watch page is open, the video element owns the
// audible audio. This flag keeps the player's audio element silent even when
// the user drags the volume slider or toggles mute — those actions are
// mirrored onto the video instead of unmuting the background track and
// playing it on top of the video.
export const audioMuteOverride: { current: boolean } = { current: false };

type RepeatMode = "off" | "all" | "one";

type AutoplaySeed = { videoId: string; playlistId: string | null };

export type { QueueOrigin } from "./types";

type RecentPlaybackTrack = {
  track: MediaTrack;
  /** Index into `playbackHistory`, or `-1` when the row comes from the current queue. */
  historyIndex: number;
  /** Set when `historyIndex === -1` — click restores via `playQueueIndex`. */
  queueIndex?: number;
};

type PlayerState = {
  currentTrack: MediaTrack | null;
  queue: MediaTrack[];
  queueIndex: number;
  queueOrigin: QueueOrigin | null;
  autoplayTrackIds: ReadonlySet<string>;
  recentlyPlayed: RecentPlaybackTrack[];
  isPlaying: boolean;
  isBuffering: boolean;
  isReloadingAutoplay: boolean;
  /** Bumps on every `seek()` so consumers (e.g. Discord RPC) can force-sync. */
  seekRevision: number;
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
  playQueueIndex: (index: number, trackId?: string) => void;
  restoreHistoryEntry: (index: number) => void;
  moveQueueItem: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  clearPlaybackHistory: () => void;
  removeTrackFromQueue: (trackId: string) => void;
  appendToQueue: (tracks: MediaTrack[], origin?: QueueOrigin) => void;
  /**
   * Best-effort stream warm-up for a track the user is *likely* to play
   * next (row hover, top search result). Kicks off the same resolve +
   * download as the queue prefetch so a manual pick is already cached by
   * the time play is requested. Rate-limited and deduped; never rejects.
   */
  warm: (track: MediaTrack) => void;
  togglePlay: () => void;
  next: (recordRecentlyPlayed?: boolean) => void;
  prev: () => void;
  seek: (seconds: number) => void;
  beginSeekScrub: () => boolean;
  finishSeekScrub: (seconds: number | null, resume: boolean) => void;
  updateSeekScrubPreview: (seconds: number | null) => void;
  setVolume: (value: number) => void;
  setLiveVolume: (value: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setAutoplay: (enabled: boolean) => void;
  reloadAutoplay: () => void;
  ensureAutoplayTopUp: (waitForInFlight?: boolean) => void;
  clearError: () => void;
  retry: () => void;
  getAnalyser: () => AnalyserNode | null;
  setEqualizerBand: (index: number, gain: number) => void;
};

type PlayerContextValue = PlayerState & PlayerActions;

// HMR-stable contexts. Split state from actions so list rows can subscribe
// to `usePlayerActions()` (stable across playback ticks) and
// `useTrackPlaybackState()` without re-rendering on every queue mutation.
const playerActionsContextSlot = globalThis as {
  __VelocityPlayerActionsContext?: Context<PlayerActions | null>;
};
const playerStateContextSlot = globalThis as {
  __VelocityPlayerStateContext?: Context<PlayerState | null>;
};
const PlayerActionsContext = (playerActionsContextSlot.__VelocityPlayerActionsContext ??=
  createContext<PlayerActions | null>(null));
const PlayerStateContext = (playerStateContextSlot.__VelocityPlayerStateContext ??=
  createContext<PlayerState | null>(null));
const VOLUME_KEY = "velocity-volume";
const MUTED_KEY = "velocity-muted";
const AUTOPLAY_KEY = "velocity-autoplay";
const AUTOPLAY_QUEUE_TARGET = 10;
const AUTOPLAY_QUEUE_BATCH_LIMIT = 20;
const PREFETCH_AHEAD = 5;
const LOUDNESS_PREVIEW_CHUNK_SECONDS = 16;
// Total attempts = 1 initial + (MAX_LOAD_ATTEMPTS - 1) retries, spaced by RETRY_DELAY_MS.
// The retry budget must be generous enough for the Rust backend's yt-dlp to
// finish and cache its result on a cold start (can take 10-15+ seconds).
// Giving up too early causes the "first attempt fails, retry succeeds" pattern
// because the backend's disk cache (45-min TTL) serves the retry instantly.
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = [700, 1500, 3500];
// The Rust backend bounds a single yt-dlp download at STREAM_RESOLVE_TIMEOUT
// (90s). On cold start — and especially on macOS, where Rosetta plus a cold
// yt-dlp/deno spawn adds seconds — a real download can take 10-30s. A 12s
// frontend timeout made every slow first load "fail" and then retry, which
// spawned *more* concurrent yt-dlp jobs and compounded the macOS freeze.
// 45s covers slow links too; the backend also dedupes in-flight downloads
// per video id, so a retry waits on the same yt-dlp run instead of spawning
// a second one.
const STREAM_RESOLVE_TIMEOUT_MS = 45_000;
// At most this many yt-dlp stream downloads run at once across prefetch +
// active-track resolution, so a hung backend can't wedge the whole queue.
const STREAM_PREFETCH_CONCURRENCY = 2;
const streamPrefetchSemaphore = createSemaphore(STREAM_PREFETCH_CONCURRENCY);
// How long to wait for a YT Music watch-playlist response before treating
// the attempt as a failed autoplay fetch and trigging a retry. Keeps the
// first song of a session (slow cold start) from leaving the queue empty.
const AUTOPLAY_FETCH_TIMEOUT_MS = 3_000;
// Base delay between auto-retries of a failed autoplay fetch. After the
// 3rd retry the delay begins doubling per subsequent retry.
const AUTOPLAY_RETRY_BASE_DELAY_MS = 3_000;
// Re-resolve stream audio before resuming if the element has been idle longer
// than this. Slightly under the Rust STREAM_CACHE_TTL (45 min) so a cached
// file deleted server-side while the app sat paused cannot leave the media
// element reading a ghost path and skipping mid-track.
const SESSION_KEY = "velocity-session";

type BootRestorePending = {
  trackId: string;
  progress: number;
};

let cachedBootSession: SavedSession | null | undefined;

/** One-shot read used to seed player state before the first paint on cold boot. */
function getBootSession(): SavedSession | null {
  if (cachedBootSession === undefined) {
    if (getSetting("saveTimestamp")) {
      const raw = getItem(SESSION_KEY);
      cachedBootSession = parseSavedSessionRaw(raw);
      if (raw && !cachedBootSession) removeItem(SESSION_KEY);
    } else {
      cachedBootSession = null;
    }
    if (cachedBootSession) {
      hydratePersistedLyricsForTrack(cachedBootSession.track);
      // Seed the UI store synchronously so the player bar can paint the
      // saved timestamp on the first frame — the mount effect runs too late.
      usePlayerUiStore.getState().resetProgress(cachedBootSession.progress);
    }
  }
  return cachedBootSession;
}

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

// Single source of truth for the audio gain applied to the gain node /
// audio element. Encapsulates the full factor chain:
//
//   effective = normGain(when enabled) * clamp(volume) * 10^(masterVolume / 20)
//
// `normGain` is the linearized loudness-normalization factor (`1` if the
// user has disabled audio normalization or the cached gain hasn't been
// derived yet). `10^(masterVolume / 20)` is the master scaling expressed
// in dB so users twiddle a UI slider in familiar dB units.
//
// Reads of `audioNormalization` and `masterVolume` are awaited synchronously
// from localStorage-backed settings — they cannot fail and are safe inside
// any of the 4 callsites that used to copy this formula by hand (see the
// audio load effect, `applyOutputLevels`, `setLiveVolume`, and `togglePlay`).
function computeAppliedGain(volume: number, normGain: number): number {
  const cleanVolume = clampVolume(volume);
  const cleanGain = Number.isFinite(normGain) && normGain > 0 ? normGain : 1;
  const masterVolumeDb = getSetting("masterVolume");
  const masterVolumeGain = Math.pow(10, masterVolumeDb / 20);
  const normalizationEnabled = getSetting("audioNormalization");
  const effectiveGain = normalizationEnabled ? cleanGain : 1;
  return effectiveGain * cleanVolume * masterVolumeGain;
}

// Audio analysis (loudness, leading silence) is a property of the
// underlying audio file, so it should be cached by the underlying stream
// videoId and ignore release/album context. `MediaTrack.id` encodes the
// source album when known so identical song rows on different releases are
// distinguishable in the UI; using the raw id here would force redundant
// per-release re-analysis (and re-run the detector pipeline) for tracks
// that share their audio across singles, EPs, and parent albums.


export function PlayerProvider({ children }: { children: ReactNode }) {
  const bootSession = getBootSession();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Blob object URLs created via `resolveFileMediaSrc` for the active track's
  // audio. Revoked when a new track loads or playback stops so we don't leak.
  const activeMediaObjectUrlRef = useRef<string | null>(null);
  const revokeActiveMediaObjectUrl = () => {
    if (activeMediaObjectUrlRef.current) {
      URL.revokeObjectURL(activeMediaObjectUrlRef.current);
      activeMediaObjectUrlRef.current = null;
    }
  };
  // Resolve a local file path to a playable audio src (blob URL, bypassing the
  // asset protocol's 1 MB Range cap that breaks `<audio>` decode), revoking the
  // previous track's blob URL.
  const mediaSrcFromFilePath = async (filePath: string): Promise<string> => {
    revokeActiveMediaObjectUrl();
    const src = await resolveFileMediaSrc(filePath);
    if (src.startsWith("blob:")) activeMediaObjectUrlRef.current = src;
    return src;
  };
  const [currentTrack, setCurrentTrack] = useState<MediaTrack | null>(
    () => bootSession?.track ?? null,
  );
  const [queue, setQueue] = useState<MediaTrack[]>(
    () => (bootSession ? [bootSession.track] : []),
  );
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueOrigin, setQueueOrigin] = useState<QueueOrigin | null>(null);
  const [autoplayTrackIds, setAutoplayTrackIds] = useState<Set<string>>(() => new Set());
  const [playbackHistory, setPlaybackHistory] = useState<PlaybackHistoryEntry[]>([]);
  const [queueVisitedTrackIds, setQueueVisitedTrackIds] = useState<ReadonlySet<string>>(
    () => (bootSession?.track ? resetVisitedQueueTracks(bootSession.track.id) : new Set()),
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [seekRevision, setSeekRevision] = useState(0);
  const [duration, setDuration] = useState(
    () => bootSession?.track.durationSeconds ?? 0,
  );
  const volume = usePlayerTransportStore((state) => state.volume);
  const muted = usePlayerTransportStore((state) => state.muted);
  const normGain = usePlayerTransportStore((state) => state.normGain);
  const setVolumeTransport = usePlayerTransportStore((state) => state.setVolume);
  const setMutedTransport = usePlayerTransportStore((state) => state.setMuted);
  const setNormGainTransport = usePlayerTransportStore((state) => state.setNormGain);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  // Autoplay preference lives in the unified settings blob (atomic
  // per-tick write) instead of the historical per-key
  // `velocity-autoplay` localStorage echo. `useSetting` is reactive:
  // any other call site that fires `setSetting("autoplay", …)` — e.g.
  // a future Settings page toggle, `resetAllSettings()`, or the
  // `__all__` broadcast fired by `clearAllUserData()` — re-renders this
  // component automatically. The legacy `velocity-autoplay` echo had
  // to round-trip through the IPC channel per-write and could lose a
  // write when the coalesced flush raced with shutdown; keeping the
  // preference next to the other settings on the same write removes
  // that window and matches the persistence shape of every other
  // user-tunable field.
  const autoplay = useSetting("autoplay");
  const [autoplaySeed, setAutoplaySeed] = useState<AutoplaySeed | null>(
    () => (bootSession ? bootAutoplaySeed(bootSession) : null),
  );
  const [isReloadingAutoplay, setIsReloadingAutoplay] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [currentAudioPath, setCurrentAudioPath] = useState<string | null>(null);

  useEffect(() => {
    currentAudioPathRef.current = currentAudioPath;
  }, [currentAudioPath]);
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
  const autoplaySeedRef = useRef<AutoplaySeed | null>(
    bootSession ? bootAutoplaySeed(bootSession) : null,
  );
  const autoplayTrackIdsRef = useRef<Set<string>>(new Set());
  const autoplayRef = useRef(autoplay);
  const playbackHistoryRef = useRef<PlaybackHistoryEntry[]>([]);
  const queueVisitedTrackIdsRef = useRef(queueVisitedTrackIds);
  const nextRef = useRef<((recordRecentlyPlayed?: boolean) => void) | null>(null);
  const fetchingAutoplayRef = useRef(false);
  const fetchAndAppendAutoplayRef = useRef<
    (overrideSeed?: AutoplaySeed | null) => Promise<void>
  >(async () => {});
  const ensureAutoplayTopUpRef = useRef<(waitForInFlight?: boolean) => void>(() => {});
  const autoplayAdvancePendingRef = useRef(false);
  // Tracks how many auto-retries the in-flight autoplay attempt has
  // already consumed. Used to compute the next retry delay so that, after
  // the 3rd retry, the gap begins to double per subsequent retry.
  const autoplayRetryCountRef = useRef(0);
  // Holds the pending retry timer so seed-change actions (play, playMany,
  // reloadAutoplay, setAutoplay(false), etc.) can cancel it cleanly
  // before the prior retry fires and overwrites new state.
  const autoplayRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever the user advances the playhead or replaces the autoplay
  // seed so an in-flight watch-playlist fetch can bail out immediately
  // instead of holding the guard (and retry backoff) while the queue has
  // already moved on.
  const autoplayFetchGenerationRef = useRef(0);
  const invalidateAutoplayFetchRef = useRef<() => void>(() => {});
  // Dedupes in-flight stream prefetch work so effect re-runs and queue
  // metadata patches don't cancel downloads/analysis already underway.
  const streamPrefetchInFlightRef = useRef(new Map<string, Promise<void>>());
  const playVersionRef = useRef(0);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by the load effect while it owns the audio element (loading or
  // retrying) so the global error handler doesn't undo the buffering state.
  const loadInProgressRef = useRef(false);
  // Survives load-effect re-runs (e.g. React Strict Mode) until the user
  // explicitly starts playback. Any load of this track without a user
  // play() / playMany() / togglePlay() intent must start paused.
  const bootRestorePendingRef = useRef<BootRestorePending | null>(
    bootSession
      ? { trackId: bootSession.track.id, progress: bootSession.progress }
      : null,
  );
  // Wall-clock time when playback last went idle (paused or loaded-but-not-
  // playing). Used to decide whether the cached stream file must be
  // re-resolved before the next play() call.
  const lastPlaybackIdleAtRef = useRef(0);
  const streamSourceRefreshNeededRef = useRef(false);
  const sourceRefreshInProgressRef = useRef(false);
  const userSeekInProgressRef = useRef(false);
  const userSeekClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeekTargetRef = useRef<number | null>(null);
  const resumeAfterSeekRef = useRef(false);
  const progressRef = useRef(bootSession?.progress ?? 0);
  const seekScrubProgressRef = useRef<number | null>(null);

  const writeProgress = useCallback((value: number) => {
    progressRef.current = value;
    usePlayerUiStore.getState().setProgress(value);
  }, []);

  const writeSeekScrub = useCallback((value: number | null) => {
    seekScrubProgressRef.current = value;
    usePlayerUiStore.getState().setSeekScrubProgress(value);
  }, []);
  // User play/pause intent captured while the load effect still owns the audio
  // element. `null` = no preference (normal play()/playMany() loads still auto-play);
  // `true`/`false` = the user explicitly toggled during load, or navigation captured
  // whether the prior track was playing.
  const playWhenReadyRef = useRef<boolean | null>(null);
  // Set by navigation stops that tear down audio without changing the active
  // queue slot (e.g. removing a duplicate of the current track). Consumed by
  // setQueueState to bump loadToken so the load effect re-runs.
  const pendingForceReloadRef = useRef(false);
  const currentAudioPathRef = useRef<string | null>(null);

  // Debounce timer for persisting the playback session to localStorage.
  const sessionSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    queueVisitedTrackIdsRef.current = queueVisitedTrackIds;
  }, [queueVisitedTrackIds]);

  useEffect(() => {
    usePlayerUiStore.getState().resetProgress(bootSession?.progress ?? 0);
    usePlayerUiStore.getState().syncPlaybackIdentity({
      currentTrack: bootSession?.track ?? null,
      isPlaying: false,
      isBuffering: false,
      queueOrigin: null,
    });
  }, []);

  useEffect(() => {
    usePlayerUiStore.getState().syncPlaybackIdentity({
      currentTrack,
      isPlaying,
      isBuffering,
      queueOrigin,
    });
  }, [currentTrack, isPlaying, isBuffering, queueOrigin]);

  const applyDurationFromAudio = useCallback((audio: HTMLAudioElement) => {
    const fromAudio = readAudioElementDuration(audio);
    if (fromAudio !== null) {
      setDuration(fromAudio);
      return;
    }
    const trackDuration = trackRef.current?.durationSeconds;
    if (
      typeof trackDuration === "number" &&
      Number.isFinite(trackDuration) &&
      trackDuration > 0
    ) {
      setDuration(trackDuration);
      return;
    }
    setDuration(0);
  }, []);
  const applyDurationFromAudioRef = useRef(applyDurationFromAudio);
  useEffect(() => {
    applyDurationFromAudioRef.current = applyDurationFromAudio;
  }, [applyDurationFromAudio]);

  // Autoplay is now persisted through the unified settings blob
  // (`setSetting("autoplay", ...)` from the `value` setter below) rather
  // than the per-key `velocity-autoplay` IPC echo. The settings blob is
  // one atomic write per tick, so a coalesced flush on the backend
  // can never lose the autoplay value while a different setting key
  // is being flushed at the same time. The legacy effect below
  // migrates the old `velocity-autoplay` localStorage entry into the
  // settings blob on first mount for users upgrading from a prior
  // build, then removes the legacy key so subsequent boots read from
  // the unified source of truth.
  useEffect(() => {
    // Only inherit from the legacy key when the user has never touched
    // the new `autoplay` setting on this machine. `getSetting` spreads
    // `DEFAULTS` over the saved blob, so it can't distinguish a
    // user-toggled value from a default-fallback — we have to peek at
    // the raw `velocity-settings` payload to detect "the user has
    // never set this on the new code path". A user who toggled off in
    // the new build and then somehow still has a stale legacy entry
    // would otherwise have their newer choice silently overwritten by
    // old data from the per-key echo.
    try {
      const settingsRaw = getItem(SETTINGS_KEY);
      const parsedSettings = settingsRaw ? JSON.parse(settingsRaw) : null;
      const autoplayExplicit =
        parsedSettings &&
        typeof parsedSettings === "object" &&
        Object.prototype.hasOwnProperty.call(parsedSettings, "autoplay");
      if (autoplayExplicit) {
        // New code's choice wins — strip the legacy entry so it can't
        // ever fight back, even on a hypothetical future bug.
        removeItem(AUTOPLAY_KEY);
        return;
      }
      const legacyRaw = getItem(AUTOPLAY_KEY);
      if (legacyRaw !== null) {
        const parsed = JSON.parse(legacyRaw);
        const migrated: boolean | null =
          typeof parsed === "boolean" ? parsed : null;
        if (migrated !== null) {
          setSetting("autoplay", migrated);
        }
        // Remove the legacy entry regardless of value so the migration
        // runs exactly once per install.
        removeItem(AUTOPLAY_KEY);
      }
    } catch {
      // Corrupt JSON in either blob — drop the legacy entry so the
      // next read cycle can't surface a parse error and re-fall-through
      // forever. The settings blob's own defaults will fill in.
      try {
        removeItem(AUTOPLAY_KEY);
      } catch {
        // localStorage can throw in private-browsing modes; swallow.
      }
    }
  // Run once on mount; subsequent toggles go through `setSetting` from
  // the `setAutoplay` callback below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const savedVolume = readVolume();
    const savedMuted = readMuted();
    const useDefault =
      savedVolume === null || Number.isNaN(savedVolume) || savedMuted || savedVolume === 0;
    const transport = usePlayerTransportStore.getState();
    transport.setVolume(useDefault ? DEFAULT_VOLUME : savedVolume!);
    transport.setMuted(useDefault ? false : (savedMuted ?? false));
    transport.setNormGain(1);
    volumeRef.current = transport.volume;
    mutedRef.current = transport.muted;
    normGainRef.current = transport.normGain;
    return subscribeTransport(({ volume: nextVolume, muted: nextMuted, normGain: nextNormGain }) => {
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      normGainRef.current = nextNormGain;
    });
  }, []);

  const recentlyPlayed = useMemo(() => {
    const seen = new Set<string>();
    const rows: RecentPlaybackTrack[] = [];

    for (let index = queueIndex - 1; index >= 0; index -= 1) {
      const track = queue[index];
      if (!track || seen.has(track.id)) continue;
      if (!queueVisitedTrackIds.has(track.id)) continue;
      seen.add(track.id);
      rows.push({ track, historyIndex: -1, queueIndex: index });
    }

    for (let historyIndex = 0; historyIndex < playbackHistory.length; historyIndex += 1) {
      const entry = playbackHistory[historyIndex];
      if (seen.has(entry.track.id)) continue;
      if (
        entry.track.id === currentTrack?.id &&
        entry.queueIndex === queueIndex &&
        playbackEntryMatchesQueueSession(entry, queue, queueOrigin)
      ) {
        continue;
      }
      seen.add(entry.track.id);
      rows.push({ track: entry.track, historyIndex });
    }

    return rows;
  }, [playbackHistory, currentTrack?.id, queue, queueIndex, queueOrigin, queueVisitedTrackIds]);

  const invalidateAutoplayFetch = useCallback(() => {
    autoplayFetchGenerationRef.current += 1;
    if (autoplayRetryTimerRef.current) {
      clearTimeout(autoplayRetryTimerRef.current);
      autoplayRetryTimerRef.current = null;
    }
    autoplayRetryCountRef.current = 0;
    fetchingAutoplayRef.current = false;
  }, []);
  invalidateAutoplayFetchRef.current = invalidateAutoplayFetch;

  const setQueueState = useCallback((next: {
    queue: MediaTrack[];
    queueIndex: number;
    queueOrigin: QueueOrigin | null;
    autoplayTrackIds?: Iterable<string>;
    autoplaySeed: AutoplaySeed | null;
    shuffle?: boolean;
  }) => {
    const sanitizedQueue = filterQueueableTracks(next.queue);
    const normalizedQueue = sanitizedQueue;
    let normalizedIndex = normalizedQueue.length === 0
      ? 0
      : Math.max(0, Math.min(next.queueIndex, normalizedQueue.length - 1));
    if (sanitizedQueue.length !== next.queue.length) {
      const activeId = next.queue[next.queueIndex]?.id;
      const remapped = activeId
        ? sanitizedQueue.findIndex((track) => track.id === activeId)
        : -1;
      if (remapped >= 0) normalizedIndex = remapped;
    }
    const normalizedAutoplayIds = new Set(next.autoplayTrackIds ?? autoplayTrackIdsRef.current);

    // Capture the prior seed before mutation so we can detect an explicit
    // replacement (play/playMany/reloadAutoplay/restoreHistoryEntry all
    // change the seed; queue reorders and appends do not).
    const prevAutoplaySeed = autoplaySeedRef.current;
    const priorTrackId = trackRef.current?.id ?? null;
    const priorIndex = queueIndexRef.current;

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

    // Keep `currentTrack` in lockstep with the queue index so the player
    // bar updates on the same commit as navigation — a follow-up effect
    // would paint one or more frames (or seconds, when `play()` awaits
    // resolution) with stale metadata while the new audio is already
    // loading.
    if (normalizedQueue.length === 0) {
      trackRef.current = null;
      setCurrentTrack(null);
      writeProgress(0);
      setDuration(0);
    } else {
      const activeTrack = normalizedQueue[normalizedIndex] ?? normalizedQueue[0];
      trackRef.current = activeTrack;
      setCurrentTrack(activeTrack);
      setDuration(activeTrack.durationSeconds ?? 0);
      const navigationChanged =
        activeTrack.id !== priorTrackId || normalizedIndex !== priorIndex;
      if (navigationChanged || pendingForceReloadRef.current) {
        pendingForceReloadRef.current = false;
        setLoadToken((token) => token + 1);
      }
    }

    if (normalizedQueue.length === 0) {
      pendingForceReloadRef.current = false;
    }

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
      invalidateAutoplayFetchRef.current();
    }

    if (typeof next.shuffle === "boolean") {
      shuffleRef.current = next.shuffle;
      setShuffle(next.shuffle);
    }
  }, []);

  // Patch queue resolution metadata without touching React queue state.
  // Prefetch writes here so it doesn't re-trigger the prefetch effect
  // (which keys off upcoming track ids, not resolvedVideoId). Navigation
  // always reads queueRef, so the enriched track is visible on load.
  const patchQueueTrackInRef = useCallback((trackId: string, nextTrack: MediaTrack) => {
    const activeQueue = queueRef.current.slice();
    const index = activeQueue.findIndex((entry) => entry.id === trackId);
    if (index < 0) return;
    activeQueue[index] = nextTrack;
    queueRef.current = activeQueue;
    // Keep the React snapshot in sync as well. QueuePanel renders `queue`,
    // while playback navigation reads `queueRef`; updating only the ref made
    // durations resolved during autoplay prefetch invisible in the queue menu.
    setQueue((currentQueue) => {
      const currentIndex = currentQueue.findIndex((entry) => entry.id === trackId);
      if (currentIndex < 0) return currentQueue;
      const nextQueue = currentQueue.slice();
      nextQueue[currentIndex] = nextTrack;
      return nextQueue;
    });
    if (index === queueIndexRef.current) {
      trackRef.current = nextTrack;
      setCurrentTrack(nextTrack);
    }
  }, []);

  const prefetchStreamTrack = useCallback(async (track: MediaTrack) => {
    const inFlight = streamPrefetchInFlightRef.current.get(track.id);
    if (inFlight) return inFlight;

    // Phase 1: resolve and download the stream (required for playback).
    // We await this so the load effect can use the cached stream path.
    // The download runs inside the prefetch semaphore so at most
    // STREAM_PREFETCH_CONCURRENCY yt-dlp jobs race the active track, and a
    // hung backend can't wedge the prefetch queue forever.
    const streamWork = streamPrefetchSemaphore.run(async () => {
      const catalogVideoId = exportStreamVideoId(track);
      if (!catalogVideoId) return null;

      const trackForResolve =
        track.videoId != null ? track : { ...track, videoId: catalogVideoId };
      const resolved = await resolveStreamTrackAudio(trackForResolve);

      let trackForStream = resolved ?? trackForResolve;
      if (resolved?.resolvedVideoId && resolved.resolvedVideoId !== track.resolvedVideoId) {
        const audioResolved = {
          ...resolved,
          id: track.id,
          videoId: track.videoId ?? catalogVideoId,
        };
        patchQueueTrackInRef(track.id, audioResolved);
        trackForStream = audioResolved;
      }

      const effectiveVideoId = exportStreamVideoId(trackForStream);
      if (!effectiveVideoId) return null;

      const stream = await resolveStream(effectiveVideoId);
      if (!stream.filePath) return null;

      return { trackForStream, stream, effectiveVideoId };
    });

    // Phase 2: background analysis (fire-and-forget, must not delay playback).
    // The load effect picks up cached results if analysis finishes in time.
    // This is a background observer of the same promise the load effect
    // awaits below. It must handle the rejection itself: the load effect can
    // recover from a yt-dlp 403, but an unhandled rejection from this
    // fire-and-forget branch still replaces the whole webview with the fatal
    // error page.
    void streamWork
      .then(async (result) => {
        if (!result) return;
        const { trackForStream, stream } = result;
        if (!stream.filePath) return;
        const cacheKey = getAudioCacheKey(trackForStream);
        if (!getCachedLoudness(cacheKey) && !hasAttemptedAnalysis(cacheKey)) {
          analyzeLoudness(stream.filePath)
            .then((data) => setCachedLoudness(cacheKey, data))
            .catch((error) => console.warn("Prefetch loudness analysis failed:", error));
        }
        if (!hasAttemptedLeadingSilenceAnalysis(cacheKey)) {
          detectLeadingSilence(stream.filePath)
            .then((data) => setCachedLeadingSilence(cacheKey, data))
            .catch((error) => {
              console.warn("Prefetch leading silence detection failed:", error);
            });
        }
      })
      .catch((error) => {
        // Playback owns the user-facing error/retry handling. Prefetch is
        // best-effort and must never create a second unhandled rejection.
        console.warn("Stream prefetch failed:", error);
      });

    // Store the resolved stream promise so the load effect can wait for it,
    // but NOT for analysis.
    const resolvedPromise = (async () => { await streamWork; })();
    streamPrefetchInFlightRef.current.set(track.id, resolvedPromise);
    try {
      await resolvedPromise;
    } catch (error) {
      // This helper is intentionally used as a fire-and-forget prefetch.  A
      // failed yt-dlp request (403s are common for expiring YouTube URLs)
      // must never reject the promise returned to the effect below: callers
      // cannot recover from a prefetch failure and an unobserved rejection
      // replaces the whole Tauri webview with its fatal error page.
      console.warn("Stream prefetch failed:", error);
    } finally {
      streamPrefetchInFlightRef.current.delete(track.id);
    }
  }, [patchQueueTrackInRef]);

  // Rate budget for hover / search-result warm prefetches. These start real
  // yt-dlp downloads ahead of a possible play, so cap how many can begin per
  // minute — a browsing spree must not become a download stampede that makes
  // YouTube raise the per-IP stream throttle (the `available_at` gate grows
  // with download frequency). Deduped warm-ups (track already in flight)
  // don't consume budget.
  const WARM_PREFETCH_MAX_PER_MINUTE = 12;
  const warmStartsRef = useRef<number[]>([]);

  const warm = useCallback(
    (track: MediaTrack) => {
      if (track.source !== "stream") return;
      // The active track is already being resolved by the load path.
      if (trackRef.current?.id === track.id) return;
      // Already warming / downloading: prefetchStreamTrack dedupes by id.
      if (streamPrefetchInFlightRef.current.has(track.id)) return;
      const now = Date.now();
      const windowStart = now - 60_000;
      warmStartsRef.current = warmStartsRef.current.filter((t) => t > windowStart);
      if (warmStartsRef.current.length >= WARM_PREFETCH_MAX_PER_MINUTE) return;
      warmStartsRef.current.push(now);
      void prefetchStreamTrack(track);
    },
    [prefetchStreamTrack],
  );

  const upcomingPrefetchKey = useMemo(
    () =>
      queue
        .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
        .map((track) => track.id)
        .join("\0"),
    [queue, queueIndex],
  );

  const capturePlaybackHistoryEntry = useCallback((): PlaybackHistoryEntry | null => {
    const currentQueue = queueRef.current;
    const activeTrack = trackRef.current;
    if (!activeTrack) return null;

    const rawQueue = currentQueue.length > 0 ? currentQueue : [activeTrack];
    const rawIndex = rawQueue.length === 0
      ? 0
      : Math.max(0, Math.min(queueIndexRef.current, rawQueue.length - 1));
    const { queue: snapshotQueue, queueIndex: snapshotIndex } =
      compactQueueForHistorySnapshot(rawQueue, rawIndex);

    return {
      track: activeTrack,
      queue: snapshotQueue,
      queueIndex: snapshotIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: Array.from(autoplayTrackIdsRef.current),
      autoplaySeed: autoplaySeedRef.current,
      shuffle: shuffleRef.current,
      queueVisitedTrackIds: Array.from(queueVisitedTrackIdsRef.current),
    };
  }, []);

  const markQueueTrackVisited = useCallback((trackId: string) => {
    setQueueVisitedTrackIds((current) => addVisitedQueueTrack(current, trackId));
  }, []);

  const resetQueueVisitedToTrack = useCallback((trackId: string) => {
    const next = resetVisitedQueueTracks(trackId);
    queueVisitedTrackIdsRef.current = next;
    setQueueVisitedTrackIds(next);
  }, []);

  const restoreQueueVisitedTrackIds = useCallback((ids: readonly string[]) => {
    const next = restoreVisitedQueueTracks(ids);
    queueVisitedTrackIdsRef.current = next;
    setQueueVisitedTrackIds(next);
  }, []);

  const rememberPlaybackHistory = useCallback(() => {
    const entry = capturePlaybackHistoryEntry();
    if (!entry) return;

    setPlaybackHistory((current) => prependPlaybackHistoryEntry(current, entry));
  }, [capturePlaybackHistoryEntry]);

  const applyPlaybackHistoryEntry = useCallback((entry: PlaybackHistoryEntry) => {
    restoreQueueVisitedTrackIds(resolveHistoryVisitedTrackIds(entry));
    setQueueState({
      queue: entry.queue,
      queueIndex: entry.queueIndex,
      queueOrigin: entry.queueOrigin,
      autoplayTrackIds: entry.autoplayTrackIds,
      autoplaySeed: entry.autoplaySeed,
      shuffle: entry.shuffle,
    });
  }, [setQueueState, restoreQueueVisitedTrackIds]);

  const applyOutputLevels = useCallback((nextVolume: number, nextMuted: boolean, nextGain: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const target = computeAppliedGain(nextVolume, nextGain);
    const gainNode = gainNodeRef.current;

    if (gainNode && audioContextRef.current) {
      const now = audioContextRef.current.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(target, now, 0.15);
      // When the gain node is the master, keep the audio element at 1 so
      // it doesn't double-attenuate the signal. The fallback branch below
      // computes an equivalent single-stage attenuation when the WebAudio
      // graph isn't available.
      audio.volume = 1;
    } else {
      audio.volume = clampVolume(target);
    }
    audio.muted = audioMuteOverride.current || nextMuted;
  }, []);

  const stopCurrentPlayback = useCallback((options?: {
    capturePlayIntent?: boolean;
    forceReload?: boolean;
  }) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (options?.capturePlayIntent) {
      // Always continue playback on queue navigation when audio is actively
      // playing. A stale `false` left over from pause-during-load must not
      // force the next track to load paused.
      if (!audio.paused) {
        playWhenReadyRef.current = true;
      } else if (playWhenReadyRef.current === null) {
        playWhenReadyRef.current = false;
      }
      if (options.forceReload) {
        pendingForceReloadRef.current = true;
      }
    } else {
      playWhenReadyRef.current = null;
    }
    audio.pause();
    audio.removeAttribute("src");
    audio.currentTime = 0;
    writeProgress(0);
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
      analyserNode.fftSize = 1024;
      analyserNode.smoothingTimeConstant = 0;
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

  const ensureAudioGraphRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshStaleAudioSourceRef = useRef<() => Promise<void>>(async () => undefined);
  const proactiveSourceRefreshRef = useRef<() => void>(() => undefined);

  const refreshStaleAudioSource = useCallback(async () => {
    const track = trackRef.current;
    const audio = audioRef.current;
    if (!track || !audio || track.source !== "stream") return;

    const effectiveVideoId = track.resolvedVideoId ?? track.videoId;
    if (!effectiveVideoId) return;

    const offlinePath = await getOfflinePathForTrack(track);
    if (offlinePath) {
      setCurrentAudioPath(offlinePath);
      const src = await mediaSrcFromFilePath(offlinePath);
      audio.src = src;
      audio.load();
      await waitForMediaReady(audio);
      return;
    }

    const idleLongEnough = isPlaybackIdleLongEnough(lastPlaybackIdleAtRef.current);
    const existingPath = currentAudioPathRef.current;
    if (!idleLongEnough && existingPath) {
      try {
        setCurrentAudioPath(existingPath);
        const src = await mediaSrcFromFilePath(existingPath);
        audio.src = src;
        audio.load();
        await waitForMediaReady(audio);
        return;
      } catch {
        // Fall through to a full re-resolve below.
      }
    }

    if (idleLongEnough) {
      invalidateStream(effectiveVideoId);
    }
    const stream = await withTimeout(
      resolveStream(effectiveVideoId),
      STREAM_RESOLVE_TIMEOUT_MS,
      "Refreshing this track's audio took too long.",
    );
    const src = stream.filePath
      ? await mediaSrcFromFilePath(stream.filePath)
      : (stream.url ?? null);
    if (!src) throw new Error("No audio source is available for this track.");

    setCurrentAudioPath(stream.filePath ?? null);
    audio.src = src;
    audio.load();
    await waitForMediaReady(audio);
  }, []);

  useEffect(() => {
    ensureAudioGraphRef.current = ensureAudioGraph;
  }, [ensureAudioGraph]);

  useEffect(() => {
    refreshStaleAudioSourceRef.current = refreshStaleAudioSource;
  }, [refreshStaleAudioSource]);

  const markUserSeekInProgress = useCallback(() => {
    userSeekInProgressRef.current = true;
    if (userSeekClearTimerRef.current) {
      clearTimeout(userSeekClearTimerRef.current);
    }
    userSeekClearTimerRef.current = setTimeout(() => {
      userSeekInProgressRef.current = false;
      userSeekClearTimerRef.current = null;
    }, 2000);
  }, []);

  const clearUserSeekInProgress = useCallback(() => {
    userSeekInProgressRef.current = false;
    if (userSeekClearTimerRef.current) {
      clearTimeout(userSeekClearTimerRef.current);
      userSeekClearTimerRef.current = null;
    }
  }, []);

  const ensureLeadingSilenceAnalyzed = useCallback(async (cacheKey: string, filePath: string | null) => {
    if (!filePath || hasAttemptedLeadingSilenceAnalysis(cacheKey)) return;

    try {
      const data = await withTimeout(
        detectLeadingSilence(filePath),
        LEADING_SILENCE_DETECT_TIMEOUT_MS,
        "Leading silence detection timed out.",
      );
      if (trackRef.current && getAudioCacheKey(trackRef.current) !== cacheKey) return;
      setCachedLeadingSilence(cacheKey, data);
    } catch (error) {
      console.warn("Leading silence detection failed:", error);
    }
  }, []);

  const applySeekTarget = useCallback((target: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    markUserSeekInProgress();
    try {
      audio.currentTime = target;
    } catch {
      // currentTime can throw when the element has no seekable range yet.
    }
    progressRef.current = target;
    writeProgress(target);
    setSeekRevision((n) => n + 1);
  }, [markUserSeekInProgress]);

  const drainPendingSeek = useCallback(() => {
    const pending = pendingSeekTargetRef.current;
    if (pending === null) return;
    pendingSeekTargetRef.current = null;
    applySeekTarget(pending);
    tryResumeAfterSeekScrubRef.current();
  }, [applySeekTarget]);

  const drainPendingSeekRef = useRef(drainPendingSeek);
  const tryResumeAfterSeekScrubRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    drainPendingSeekRef.current = drainPendingSeek;
  }, [drainPendingSeek]);

  const proactiveSourceRefresh = useCallback(() => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (
      !audio?.paused ||
      !track ||
      loadInProgressRef.current ||
      sourceRefreshInProgressRef.current
    ) {
      return;
    }
    if (
      !playbackNeedsSourceRefresh(
        track,
        lastPlaybackIdleAtRef.current,
        streamSourceRefreshNeededRef.current,
      )
    ) {
      return;
    }

    const savedTime = audio.currentTime;
    sourceRefreshInProgressRef.current = true;
    void (async () => {
      try {
        await ensureAudioGraphRef.current();
        await refreshStaleAudioSourceRef.current();
        streamSourceRefreshNeededRef.current = false;
        if (Number.isFinite(savedTime) && savedTime > 0) {
          audio.currentTime = savedTime;
          progressRef.current = savedTime;
          writeProgress(savedTime);
        }
      } catch {
        streamSourceRefreshNeededRef.current = true;
      } finally {
        sourceRefreshInProgressRef.current = false;
        drainPendingSeekRef.current();
      }
    })();
  }, []);

  useEffect(() => {
    proactiveSourceRefreshRef.current = proactiveSourceRefresh;
  }, [proactiveSourceRefresh]);

  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.volume = clampVolume(volume);
    audio.muted = muted;
    audioRef.current = audio;
    currentAudio.current = audio;

    const syncProgress = () => {
      const currentTime = audio.currentTime || 0;
      // While a session-restore load is still resolving audio, keep showing
      // the saved position instead of flashing 0:00 on every timeupdate.
      const bootPending = bootRestorePendingRef.current;
      if (
        loadInProgressRef.current &&
        bootPending &&
        bootPending.trackId === trackRef.current?.id &&
        bootPending.progress > 0 &&
        currentTime === 0
      ) {
        return;
      }
      writeProgress(currentTime);
    };
    const syncDuration = () => {
      applyDurationFromAudioRef.current(audio);
    };

    const handlePlay = () => {
      const bootPending = bootRestorePendingRef.current;
      if (
        bootPending &&
        bootPending.trackId === trackRef.current?.id &&
        playWhenReadyRef.current !== true
      ) {
        audio.pause();
        setIsPlaying(false);
        return;
      }
      if (sourceRefreshInProgressRef.current) {
        setIsPlaying(true);
        if (!audio.readyState || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          setIsBuffering(true);
        }
        return;
      }
      if (
        playbackNeedsSourceRefresh(
          trackRef.current,
          lastPlaybackIdleAtRef.current,
          streamSourceRefreshNeededRef.current,
        )
      ) {
        sourceRefreshInProgressRef.current = true;
        const savedTime = audio.currentTime;
        lastPlaybackIdleAtRef.current = 0;
        audio.pause();
        setIsBuffering(true);
        void (async () => {
          try {
            await ensureAudioGraphRef.current();
            await refreshStaleAudioSourceRef.current();
            streamSourceRefreshNeededRef.current = false;
            if (Number.isFinite(savedTime) && savedTime > 0) {
              audio.currentTime = savedTime;
            }
            await audio.play();
          } catch (error) {
            setIsPlaying(false);
            setIsBuffering(false);
            setLastError(
              error instanceof Error ? error.message : "Playback could not resume after refreshing the audio.",
            );
          } finally {
            sourceRefreshInProgressRef.current = false;
            drainPendingSeekRef.current();
          }
        })();
        return;
      }
      lastPlaybackIdleAtRef.current = 0;
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
      if (sourceRefreshInProgressRef.current) return;
      // The load effect drives buffering state while it owns the audio
      // element (initial load + automatic retries). It calls `audio.pause()`
      // as part of tearing down the previous track; without this guard the
      // async `pause` event would stomp the load's isBuffering(true), so the
      // play/pause button flashes the paused (Play) icon instead of the
      // loading spinner for the whole resolve/load window. Mirrors the
      // loadInProgressRef guard in handleError.
      if (loadInProgressRef.current) return;
      lastPlaybackIdleAtRef.current = Date.now();
      setIsPlaying(false);
      setIsBuffering(false);
    };
    const handleWaiting = () => {
      setIsBuffering(true);
      // Seeking fires `waiting` while the decoder buffers the new position.
      // Treating that as a stale stream would re-resolve mid-scrub and error.
      if (userSeekInProgressRef.current) return;
      if (!audio.paused && audio.currentTime > 3) {
        streamSourceRefreshNeededRef.current = true;
      }
    };
    const handleStalled = () => {
      if (userSeekInProgressRef.current) return;
      if (!audio.paused && audio.currentTime > 3) {
        streamSourceRefreshNeededRef.current = true;
      }
    };
    const handleSeeked = () => {
      clearUserSeekInProgress();
    };
    const handleEnded = () => {
      if (repeatRef.current === "one") {
        audio.currentTime = 0;
        progressRef.current = 0;
        writeProgress(0);
        void audio.play().catch(() => {
          setIsPlaying(false);
        });
        return;
      }
      writeProgress(0);
      const queue = queueRef.current;
      const index = queueIndexRef.current;
      const hasMore = queue.length > 0 && (
        (index + 1 < queue.length) ||
        repeatRef.current === "all" ||
        (autoplayRef.current && autoplaySeedRef.current?.videoId)
      );
      if (hasMore) {
        // Ended tracks report `paused === true`; seed play intent before
        // next() captures from the audio element so queue advance keeps going.
        playWhenReadyRef.current = true;
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
      if (userSeekInProgressRef.current) {
        const code = audio.error?.code;
        if (
          code === MediaError.MEDIA_ERR_ABORTED ||
          code === MediaError.MEDIA_ERR_NETWORK
        ) {
          setIsBuffering(true);
          return;
        }
      }
      if (audio.paused && trackRef.current?.source === "stream") {
        streamSourceRefreshNeededRef.current = true;
        setIsBuffering(false);
        return;
      }
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
    audio.addEventListener("stalled", handleStalled);
    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.pause();
      audio.src = "";
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
        fadeTimeoutRef.current = null;
      }
      if (userSeekClearTimerRef.current) {
        clearTimeout(userSeekClearTimerRef.current);
        userSeekClearTimerRef.current = null;
      }
      void audioContextRef.current?.close().catch(() => undefined);
      audio.removeEventListener("timeupdate", syncProgress);
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("stalled", handleStalled);
      audio.removeEventListener("seeked", handleSeeked);
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

  // High-frequency progress sync for the active track. Progress lives in
  // `playerUiStore` — not React context — so list rows and the app shell
  // are not re-rendered ~60×/sec. The loop parks while paused (no scrub).
  useEffect(() => {
    if (!currentTrack) return;
    const audio = audioRef.current;
    if (!audio) return;

    let rafId = 0;
    let running = true;
    let lastMediaSessionAt = 0;

    const tick = () => {
      if (!running) return;

      const scrubbing = seekScrubProgressRef.current !== null;
      if (audio.paused && !scrubbing) return;

      rafId = window.requestAnimationFrame(tick);
      if (scrubbing) return;

      const currentTime = audio.currentTime;
      if (!Number.isFinite(currentTime)) return;
      const bootPending = bootRestorePendingRef.current;
      if (
        loadInProgressRef.current &&
        bootPending &&
        bootPending.trackId === trackRef.current?.id &&
        bootPending.progress > 0 &&
        currentTime === 0
      ) {
        return;
      }
      if (Math.abs(currentTime - progressRef.current) >= 0.008) {
        progressRef.current = currentTime;
        usePlayerUiStore.getState().setProgress(currentTime);
      }

      const liveDuration = readLiveMediaDuration(
        audio,
        trackRef.current?.durationSeconds,
      );
      if (liveDuration > 0) {
        setDuration((prev) => (Math.abs(prev - liveDuration) > 0.5 ? liveDuration : prev));
        const session = navigator.mediaSession;
        const now = Date.now();
        if (session && now - lastMediaSessionAt >= 1000) {
          lastMediaSessionAt = now;
          session.setPositionState({
            duration: liveDuration,
            playbackRate: 1,
            position: Math.min(currentTime, liveDuration),
          });
        }
      }
    };

    const schedule = () => {
      if (!running) return;
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(tick);
    };

    const onWake = () => schedule();

    audio.addEventListener("play", onWake);
    audio.addEventListener("seeking", onWake);
    audio.addEventListener("seeked", onWake);

    const unsubScrub = usePlayerUiStore.subscribe(
      (state) => state.seekScrubProgress,
      (scrub) => {
        if (scrub !== null) schedule();
      },
    );

    if (!audio.paused || seekScrubProgressRef.current !== null) {
      schedule();
    }

    return () => {
      running = false;
      window.cancelAnimationFrame(rafId);
      audio.removeEventListener("play", onWake);
      audio.removeEventListener("seeking", onWake);
      audio.removeEventListener("seeked", onWake);
      unsubScrub();
    };
  }, [currentTrack?.id]);

  // When stream metadata omits duration, hydrate from the backend or by
  // probing the cached audio file so the seek bar can render and scrub.
  useEffect(() => {
    const track = currentTrack;
    if (!track) return;

    let cancelled = false;

    const applyResolvedDuration = (seconds: number) => {
      if (cancelled || !(seconds > 0)) return;
      setDuration(seconds);
      const active = trackRef.current;
      if (active?.id === track.id && active.durationSeconds !== seconds) {
        patchQueueTrackInRef(track.id, mergeTrackMetadata(active, { durationSeconds: seconds }));
      }
    };

    const audio = audioRef.current;
    if (audio) {
      const fromAudio = readLiveMediaDuration(audio, track.durationSeconds);
      if (fromAudio > 0) {
        applyResolvedDuration(fromAudio);
        return;
      }
    }

    if (typeof track.durationSeconds === "number" && track.durationSeconds > 0) {
      applyResolvedDuration(track.durationSeconds);
      return;
    }

    void (async () => {
      if (track.videoId) {
        const updates = await resolveTrackMetadata(track, {
          needsDuration: true,
          needsPlayCount: false,
        });
        if (updates?.durationSeconds) {
          applyResolvedDuration(updates.durationSeconds);
          return;
        }
      }

      const filePath =
        currentAudioPathRef.current ??
        (track.source === "upload" ? track.filePath ?? null : null);
      if (!filePath) return;

      const probed = await readDuration(convertFileSrc(filePath, "stream"));
      if (probed) applyResolvedDuration(probed);
    })();

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, currentTrack?.durationSeconds, currentAudioPath, patchQueueTrackInRef]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const audio = audioRef.current;
        if (audio?.paused) {
          streamSourceRefreshNeededRef.current = true;
        }
        return;
      }
      void audioContextRef.current?.resume().catch(() => undefined);
      proactiveSourceRefreshRef.current();
    };

    const onWindowFocus = () => {
      void audioContextRef.current?.resume().catch(() => undefined);
      proactiveSourceRefreshRef.current();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  // While a stream track sits paused, re-resolve its audio source once the
  // idle window passes so the media element isn't still pointed at a cache
  // file the backend deleted while the user was away.
  useEffect(() => {
    const id = window.setInterval(() => {
      proactiveSourceRefreshRef.current();
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

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
    if (!currentTrack) return;
    if (!isQueueableTrack(currentTrack)) {
      void nextRef.current?.(true);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;
    // Number of retries still allowed AFTER the initial attempt. We try once,
    // then schedule up to MAX_LOAD_ATTEMPTS - 1 retries spaced by RETRY_DELAY_MS
    // before giving up.
    let retriesLeft = MAX_LOAD_ATTEMPTS - 1;
    let activeRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAttemptError: unknown = null;
    // Video ids whose stream already failed for THIS load. Accumulated across
    // retries so the same-song alternate walk keeps advancing instead of
    // bouncing off the same dead ids.
    const triedStreamIds = new Set<string>();

    setLastError(null);
    setIsBuffering(true);
    const bootPending = bootRestorePendingRef.current;
    const pendingRestoreProgress =
      bootPending && bootPending.trackId === currentTrack.id
        ? bootPending.progress
        : 0;
    progressRef.current = pendingRestoreProgress;
    writeProgress(pendingRestoreProgress);
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
      const mediaErrorDesc = describeMediaError(audio.error);
      if (mediaErrorDesc !== "Playback failed for this track." && mediaErrorDesc !== "Playback could not start.") {
        setLastError(mediaErrorDesc);
      } else {
        setLastError(
          lastAttemptError instanceof Error ? lastAttemptError.message : "Playback could not start.",
        );
      }
    };

    const attempt = async () => {
      if (cancelled) return;

      try {
        await ensureAudioGraph();
        const loadTrackId = currentTrack.id;
        const prefetchWait = streamPrefetchInFlightRef.current.get(loadTrackId);
        if (prefetchWait) {
          try {
            await prefetchWait;
          } catch {
            // Prefetch is best-effort; load still runs if it failed.
          }
        }
        // Prefer queueRef — prefetch may have already resolved/downloaded
        // the next track without touching React queue state.
        let trackForLoad =
          queueRef.current[queueIndexRef.current]?.id === loadTrackId
            ? queueRef.current[queueIndexRef.current]!
            : currentTrack;
        const catalogVideoId = exportStreamVideoId(trackForLoad);
        if (
          trackForLoad.source === "stream" &&
          catalogVideoId &&
          !trackForLoad.resolvedVideoId
        ) {
          const trackForResolve =
            trackForLoad.videoId != null
              ? trackForLoad
              : { ...trackForLoad, videoId: catalogVideoId };
          const resolved = await resolveTrackAudio(trackForResolve);
          if (cancelled || trackRef.current?.id !== loadTrackId) return;
          if (!resolved) {
            loadInProgressRef.current = false;
            setIsBuffering(false);
            void nextRef.current?.(true);
            return;
          }
          if (resolved.resolvedVideoId && resolved.resolvedVideoId !== trackForLoad.videoId) {
            const audioResolved = {
              ...resolved,
              id: trackForLoad.id,
              videoId: trackForLoad.videoId ?? catalogVideoId,
            };
            patchQueueTrackInRef(trackForLoad.id, audioResolved);
            trackForLoad = audioResolved;
            // Keep the autoplay seed on the canonical Topic-upload id. A
            // fetch started from the pre-resolve music-video id will abort
            // against the updated seed, so release it and re-kick below.
            const currentSeed = autoplaySeedRef.current;
            if (
              currentSeed &&
              (currentSeed.videoId === trackForLoad.videoId ||
                currentSeed.videoId === resolved.resolvedVideoId)
            ) {
              const nextSeed = {
                videoId: resolved.resolvedVideoId,
                playlistId: currentSeed.playlistId,
              };
              if (currentSeed.videoId !== nextSeed.videoId) {
                if (
                  fetchingAutoplayRef.current &&
                  currentSeed.videoId === trackForLoad.videoId
                ) {
                  invalidateAutoplayFetchRef.current();
                }
                autoplaySeedRef.current = nextSeed;
                setAutoplaySeed(nextSeed);
                ensureAutoplayTopUpRef.current(true);
              }
            }
          } else {
            trackForLoad = resolved;
          }
        }

        if (
          trackForLoad.source === "upload" &&
          !trackForLoad.filePath &&
          !trackForLoad.audioSrc
        ) {
          trackForLoad = await hydrateUploadTrackForPlayback(trackForLoad);
          if (cancelled || trackRef.current?.id !== loadTrackId) return;
          patchQueueTrackInRef(trackForLoad.id, trackForLoad);
        }

        let src: string | null = null;
        let resolvedFilePath: string | null = null;
        if (trackForLoad.source === "upload") {
          resolvedFilePath = trackForLoad.filePath ?? null;
          setCurrentAudioPath(resolvedFilePath);
          src = resolvedFilePath
            ? await mediaSrcFromFilePath(resolvedFilePath)
            : (trackForLoad.audioSrc ?? null);
        } else {
          // Use the resolved videoId (canonical Topic upload) when
          // available, falling back to the original videoId. This is
          // essential for tracks that `playMany` queued without
          // pre-resolving (all tracks except the first).
          const effectiveVideoId = exportStreamVideoId(trackForLoad);
          if (effectiveVideoId) {
          // Check for an offline-downloaded file first
          const offlinePath = await getOfflinePathForTrack(trackForLoad);
          if (offlinePath) {
            if (cancelled || trackRef.current?.id !== loadTrackId) return;
            resolvedFilePath = offlinePath;
            setCurrentAudioPath(offlinePath);
            src = await mediaSrcFromFilePath(offlinePath);
          } else {
            // On retries, drop the cached resolution so the backend can
            // re-derive a working URL — a transient network glitch can leave
            // a poisoned entry in `streamCache` that would otherwise fail
            // identically on every attempt.
            if (retriesLeft < MAX_LOAD_ATTEMPTS - 1) invalidateStream(effectiveVideoId);
            let stream;
            try {
              stream = await withTimeout(
                resolveStream(effectiveVideoId),
                STREAM_RESOLVE_TIMEOUT_MS,
                "Resolving this track's audio took too long.",
              );
            } catch (streamError) {
              // ANY resolve-stream failure for the current id can be the
              // "this id will never play" signal (age gate, 403, "sign in to
              // confirm you're not a bot", a yt-dlp extractor error, or a
              // frontend timeout). Some studio uploads fail every time while a
              // different same-song studio upload loads fine — so walk the
              // ordered alternate list within THIS attempt. Music videos are
              // never offered as alternates. Every failed alternate is added
              // to `triedStreamIds` (persisted across retries), so a later
              // retry continues the walk instead of re-trying dead ids.
              if (effectiveVideoId !== exportStreamVideoId(trackForLoad)) throw streamError;
              triedStreamIds.add(effectiveVideoId);
              let lastStreamError: unknown = streamError;
              while (true) {
                if (cancelled || trackRef.current?.id !== loadTrackId) return;
                const fallback = await resolveStreamTrackAudioFallback(trackForLoad, {
                  excludeVideoIds: [...triedStreamIds],
                });
                if (cancelled || trackRef.current?.id !== loadTrackId) return;
                const fallbackVideoId = fallback?.resolvedVideoId;
                if (
                  !fallbackVideoId ||
                  triedStreamIds.has(fallbackVideoId) ||
                  fallbackVideoId === effectiveVideoId
                ) {
                  throw lastStreamError;
                }
                const audioResolved = fallback
                  ? {
                      ...fallback,
                      id: trackForLoad.id,
                      videoId: trackForLoad.videoId ?? catalogVideoId,
                    }
                  : {
                      ...trackForLoad,
                      resolvedVideoId: fallbackVideoId,
                    };
                patchQueueTrackInRef(trackForLoad.id, audioResolved);
                trackForLoad = audioResolved;
                invalidateStream(fallbackVideoId);
                try {
                  stream = await withTimeout(
                    resolveStream(fallbackVideoId),
                    STREAM_RESOLVE_TIMEOUT_MS,
                    "Resolving this track's audio took too long.",
                  );
                  break;
                } catch (fallbackError) {
                  if (cancelled || trackRef.current?.id !== loadTrackId) return;
                  triedStreamIds.add(fallbackVideoId);
                  lastStreamError = fallbackError;
                }
              }
            }
            // Compare against the actual queue-track id here, not the audio-cache
            // key. Stream tracks may intentionally include an album suffix in
            // `id` (for release-specific UI identity) while still sharing the
            // shorter `yt:<videoId>` cache key for audio analysis.
            if (cancelled || trackRef.current?.id !== loadTrackId) return;
            resolvedFilePath = stream.filePath ?? null;
            setCurrentAudioPath(resolvedFilePath);
            src = stream.filePath
              ? await mediaSrcFromFilePath(stream.filePath)
              : (stream.url ?? null);
          }
          }
        }

        if (!src) throw new Error("No audio source is available for this track.");
        if (cancelled) return;
        // Kick off the leading-silence analysis BEFORE the audio element
        // starts decoding so its result is more likely to be ready by the
        // time playback begins. Starting it after `load()` meant the very
        // first play of a track always heard the silence — the analysis
        // couldn't finish before `play()` read the still-empty skip.
        const loudnessCacheKey = getAudioCacheKey(trackForLoad);
        if (resolvedFilePath) {
          void ensureLeadingSilenceAnalyzed(loudnessCacheKey, resolvedFilePath);
        }
        audio.src = src;
        audio.load();
        const isStaleLoad = () =>
          cancelled || trackRef.current?.id !== loadTrackId;
        await waitForMediaReady(audio, isStaleLoad);
        if (cancelled || trackRef.current?.id !== loadTrackId) return;
        applyDurationFromAudio(audio);

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
            const target = computeAppliedGain(volumeRef.current, normGainRef.current);
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(target, now);
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
        // carried by bootRestorePendingRef (survives load-effect re-runs).
        if (bootPending && bootPending.trackId === loadTrackId) {
          const savedPos = bootPending.progress;
          if (savedPos > 0) {
            audio.currentTime = savedPos;
            progressRef.current = savedPos;
            writeProgress(savedPos);
          } else {
            audio.currentTime = 0;
            progressRef.current = 0;
            writeProgress(0);
          }
          const shouldPlay = playWhenReadyRef.current === true;
          playWhenReadyRef.current = null;
          lastPlaybackIdleAtRef.current = shouldPlay ? 0 : Date.now();
          loadInProgressRef.current = false;
          setLastError(null);
          if (shouldPlay) {
            bootRestorePendingRef.current = null;
            await audio.play();
            if (cancelled) return;
            setIsPlaying(true);
          } else {
            audio.pause();
            setIsPlaying(false);
            setIsBuffering(false);
          }
          // Cached/preloaded streams often finish while the session-restore
          // autoplay fetch is still in flight. Defer a top-up pass that waits
          // for that fetch to settle before deciding whether to re-kick.
          ensureAutoplayTopUpRef.current(true);
          return;
        }

        const userIntent = playWhenReadyRef.current;
        playWhenReadyRef.current = null;
        const shouldPlay = userIntent !== false;
        if (shouldPlay) {
          try {
            await audio.play();
          } catch (playError) {
            if (cancelled || trackRef.current?.id !== loadTrackId) return;
            throw playError;
          }
          if (cancelled || trackRef.current?.id !== loadTrackId) return;
          setIsPlaying(true);
          if (!audio.readyState || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            setIsBuffering(true);
          }
        } else {
          audio.pause();
          setIsPlaying(false);
          setIsBuffering(false);
        }
        // Successful load — clear the in-flight flag so the global error
        // handler resumes normal behavior, and wipe any stale error message
        // captured during earlier failed attempts.
        if (cancelled) return;
        loadInProgressRef.current = false;
        setLastError(null);
      } catch (err) {
        if (cancelled || isStaleLoadError(err)) return;
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
          void attempt().catch((error) => {
            // Keep a rejected retry from reaching the browser/Tauri global
            // unhandled-rejection handler. The normal attempt catch already
            // reports ordinary load failures through the player state.
            if (!cancelled) {
              lastAttemptError = error;
              finalize();
            }
          });
        }, delay);
      }
    };

    void attempt().catch((error) => {
      if (!cancelled) {
        lastAttemptError = error;
        finalize();
      }
    });

    return () => {
      cancelled = true;
      loadInProgressRef.current = false;
      if (activeRetryTimer) clearTimeout(activeRetryTimer);
      audio.pause();
      audio.currentTime = 0;
      revokeActiveMediaObjectUrl();
    };
  }, [currentTrack?.id, queueIndex, ensureAudioGraph, loadToken, patchQueueTrackInRef, applyDurationFromAudio]);

  useEffect(() => {
    if (!currentTrack) {
      setNormGainTransport(1);
      setCurrentAudioPath(null);
      return;
    }
    const trackForAnalysis =
      queueRef.current[queueIndexRef.current]?.id === currentTrack.id
        ? queueRef.current[queueIndexRef.current]!
        : currentTrack;
    const targetLufs = loadTargetLufs();
    const loudnessCacheKey = getAudioCacheKey(trackForAnalysis);
    const loudness = getCachedLoudness(loudnessCacheKey);
    if (loudness) {
      setNormGainTransport(computeLinearGain(loudness, targetLufs));
    } else if (hasAttemptedAnalysis(loudnessCacheKey)) {
      setNormGainTransport(1);
    } else {
      setNormGainTransport(getInitialGain(targetLufs));
    }

    const filePath =
      currentAudioPath ??
      (trackForAnalysis.source === "upload" ? trackForAnalysis.filePath : null);
    if (filePath) {
      void ensureLeadingSilenceAnalyzed(loudnessCacheKey, filePath);
    }

    if (!filePath || loudness) return;

    let cancelled = false;
    const analysisTrackId = currentTrack.id;
    void (async () => {
      let previewApplied = false;

      const previewStarts = buildLoudnessPreviewStarts(trackForAnalysis.durationSeconds);
      for (const startSeconds of previewStarts) {
        try {
          const preview = await analyzeLoudnessChunk(filePath, startSeconds, LOUDNESS_PREVIEW_CHUNK_SECONDS);
          if (cancelled || trackRef.current?.id !== analysisTrackId) return;
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
            setNormGainTransport(previewGain);
          }
          break;
        } catch (error) {
          console.warn("Preview loudness analysis failed:", error);
          break;
        }
      }

      try {
        const data = await analyzeLoudness(filePath);
        if (cancelled || trackRef.current?.id !== analysisTrackId) return;

        // Cache the analysis result even if unusable/empty, to prevent repeated analyze_loudness calls.
        setCachedLoudness(loudnessCacheKey, data);

        if (isUsableLoudness(data)) {
          setNormGainTransport(computeLinearGain(data, targetLufs));
        } else if (!previewApplied) {
          setNormGainTransport(1);
        }
      } catch (error) {
        console.warn("Loudness analysis failed:", error);
        if (cancelled || trackRef.current?.id !== analysisTrackId) return;
        // Cache empty data on error so we don't retry
        setCachedLoudness(loudnessCacheKey, { integratedLufs: null, truePeak: null });
        if (!previewApplied) {
          setNormGainTransport(1);
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
    const upcoming = queueRef.current
      .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
      .filter((track) => track.source === "stream" && exportStreamVideoId(track));
    for (const track of upcoming) {
      // Keep this guard at the call site as well as inside the helper. This
      // protects this fire-and-forget effect if the helper gains a new
      // rejection path in the future.
      void prefetchStreamTrack(track).catch((error) => {
        console.warn("Stream prefetch scheduling failed:", error);
      });
    }
  }, [queueIndex, upcomingPrefetchKey, prefetchStreamTrack]);

  // Prefetch synced lyrics for the current track first, then stagger
  // upcoming tracks so rapid skipping doesn't flood the backend with
  // concurrent multi-provider fetches that delay the active song.
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const current = queue[queueIndex];
    if (current) prefetchSyncedLyricsForTrack(current);

    const upcoming = queue
      .slice(queueIndex + 1, queueIndex + 1 + PREFETCH_AHEAD)
      .filter(
        (track) =>
          (track.source === "stream" && streamIdentityVideoIds(track).length > 0) ||
          (track.source === "upload" && track.findLyrics),
      );

    upcoming.forEach((track, index) => {
      const timer = setTimeout(() => {
        if (cancelled) return;
        prefetchSyncedLyricsForTrack(track);
      }, 400 * (index + 1));
      timers.push(timer);
    });

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [queue, queueIndex]);

  // Single-song lyrics-snapshot eviction. After every track change (and
  // also on the initial mount with the restored session), drop any
  // cross-session lyrics snapshot in localStorage whose videoId isn't
  // the one we're now playing. The companion writer lives in
  // `src/api.ts::getSyncedLyrics`, which persists the active track's
  // lyrics on a backend-success. Together the two keep at most one
  // entry on disk at any moment, satisfying the user-facing rule
  // "don't bother holding it once the user passes the song". Sessions
  // restore falls back to the in-memory `syncedLyricsCache.peek` plus
  // this disk layer (see the augmented `peekSyncedLyrics` in api.ts).
  //
  // Effect runs on mount AND on every videoId change:
  //   * on mount, it sweeps any prior-session debris except the freshly
  //     restored videoId's entry (which we keep so the just-restored
  //     LyricsPage can render from disk);
  //   * on every change, it evicts the now-superseded snapshot before
  //     the next track's prefetch effect writes its replacement.
  //
  // SAVED SONGS are exempt from eviction: their lyrics were persisted
  // (with `persist: true`) specifically so offline playback works, and
  // wiping them on the next track change would force a network re-fetch
  // every time the user replays a downloaded song. The keep-set therefore
  // starts with every saved song's identity ids and adds the current
  // stream track's id on top. Upload tracks have no videoId/snapshot, so
  // the effect still runs (the keep-set is just the saved songs).
  //
  // Subscribing to the collection store's entries means the eviction also
  // re-runs the moment the saved set changes (save/unsave), not just on
  // track change — so a snapshot written for a freshly-saved song is
  // never wiped by a stale keep-set computed before the save landed.
  const savedSongEntries = useCollectionStore((state) => state.songLookup.entries);
  useEffect(() => {
    const keepVideoIds = new Set<string>();
    const track = currentTrack;
    if (track?.source === "stream") {
      const effectiveVideoId = track.resolvedVideoId ?? track.videoId;
      if (effectiveVideoId) keepVideoIds.add(effectiveVideoId);
    }
    for (const saved of savedSongEntries) {
      if (saved.source !== "stream") continue;
      for (const videoId of streamIdentityVideoIds(saved)) {
        keepVideoIds.add(videoId);
      }
    }
    evictPersistedLyricsExcept(keepVideoIds);
  }, [currentTrack?.resolvedVideoId, currentTrack?.videoId, currentTrack?.source, savedSongEntries]);

  const resolveTrackAudio = useCallback(async (track: MediaTrack): Promise<MediaTrack | null> => {
    if (!isQueueableTrack(track)) {
      if (track.source === "stream" && track.videoId) {
        return resolveStreamTrackAudio(track);
      }
      return null;
    }
    return resolveStreamTrackAudio(track);
  }, []);

  const play = useCallback(async (track: MediaTrack) => {
    if (!isQueueableTrack(track)) {
      // Saved collection rows can carry `kind: "video"` from the source page.
      // They should still play — resolution/offline/stream fallbacks handle it.
      if (track.source !== "stream" || !track.videoId) return;
    }
    // Record the previous track in history before any async work so that
    // navigating away while a track is still loading still registers it.
    if (trackRef.current) rememberPlaybackHistory();
    bootRestorePendingRef.current = null;
    const version = ++playVersionRef.current;
    stopCurrentPlayback();
    autoplayAdvancePendingRef.current = false;
    let trackToPlay = track;
    if (track.source === "upload" && !track.filePath && !track.audioSrc) {
      trackToPlay = await hydrateUploadTrackForPlayback(track);
      if (version !== playVersionRef.current) return;
    }
    // Commit the requested track immediately so the player bar doesn't keep
    // showing the prior song while stream resolution runs.
    resetQueueVisitedToTrack(trackToPlay.id);
    setQueueState({
      queue: [trackToPlay],
      queueIndex: 0,
      queueOrigin: null,
      autoplayTrackIds: [],
      autoplaySeed: null,
    });
    const resolved = await resolveTrackAudio(trackToPlay);
    // A newer play() call has superseded this one — bail out so we don't
    // overwrite the queue with stale state.
    if (version !== playVersionRef.current) return;
    if (!resolved) return;
    let seedVideoId = resolved.resolvedVideoId ?? resolved.videoId;
    if (!seedVideoId && resolved.source === "upload") {
      const enrichment = await enrichUploadMetadataFromYtm({
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
      });
      if (version !== playVersionRef.current) return;
      seedVideoId = enrichment?.videoId ?? null;
    }
    const nextSeed = seedVideoId
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
  }, [rememberPlaybackHistory, stopCurrentPlayback, resolveTrackAudio, setQueueState, resetQueueVisitedToTrack]);

  const playMany = useCallback(async (tracks: MediaTrack[], startIndex = 0, origin?: QueueOrigin) => {
    const queueable = filterQueueableTracks(tracks);
    if (queueable.length === 0) return;
    // Record the previous track in history before any async work.
    if (trackRef.current) rememberPlaybackHistory();
    bootRestorePendingRef.current = null;
    const version = ++playVersionRef.current;
    stopCurrentPlayback();
    autoplayAdvancePendingRef.current = false;

    // Only the track at `startIndex` (the one about to play) needs to be
    // resolved BEFORE the queue is committed — resolving every track upfront
    // would issue N concurrent search API calls and block the play button
    // until they all settle. The remaining tracks are kept in the queue as-is
    // and are lazily resolved one-at-a-time by the load effect's
    // `resolveTrackAudio` when each becomes current.
    let playIndex = remapQueueStartIndex(tracks, queueable, startIndex);
    const startTrackId = queueable[playIndex]?.id;
    if (startTrackId) resetQueueVisitedToTrack(startTrackId);
    // Commit the queue immediately so metadata tracks the user's selection
    // while the start track is being resolved.
    setQueueState({
      queue: queueable,
      queueIndex: playIndex,
      queueOrigin: origin ?? null,
      autoplayTrackIds: [],
      autoplaySeed: null,
    });
    let startTrack = queueable[playIndex];
    if (
      startTrack &&
      startTrack.source === "upload" &&
      !startTrack.filePath &&
      !startTrack.audioSrc
    ) {
      startTrack = await hydrateUploadTrackForPlayback(startTrack);
      if (version !== playVersionRef.current) return;
      queueable[playIndex] = startTrack;
    }
    const resolvedFirst = await resolveTrackAudio(queueable[playIndex]);
    if (version !== playVersionRef.current) return;
    if (!resolvedFirst) return;
    const resolved = queueable.slice();
    resolved[playIndex] = resolvedFirst;
    let finalQueue = resolved;

    if (shuffleRef.current && finalQueue.length > 1) {
      const current = finalQueue[playIndex];
      finalQueue = [
        current,
        ...shuffledCopy([
          ...finalQueue.slice(0, playIndex),
          ...finalQueue.slice(playIndex + 1),
        ]),
      ];
      playIndex = 0;
    }

    const lastTrack = finalQueue[finalQueue.length - 1];
    let lastSeedVideoId = lastTrack ? (lastTrack.resolvedVideoId ?? lastTrack.videoId) : null;
    if (lastTrack && !lastSeedVideoId && lastTrack.source === "upload") {
      const enrichment = await enrichUploadMetadataFromYtm({
        title: lastTrack.title,
        artist: lastTrack.artist,
        album: lastTrack.album,
      });
      if (version !== playVersionRef.current) return;
      lastSeedVideoId = enrichment?.videoId ?? null;
    }
    const nextSeed = lastTrack && lastSeedVideoId
      ? { videoId: lastSeedVideoId, playlistId: null }
      : null;
    setQueueState({
      queue: finalQueue,
      queueIndex: playIndex,
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
  }, [rememberPlaybackHistory, stopCurrentPlayback, resolveTrackAudio, setQueueState, resetQueueVisitedToTrack]);

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

    if (loadInProgressRef.current) {
      const nextIntent = playWhenReadyRef.current !== true;
      playWhenReadyRef.current = nextIntent;
      setIsPlaying(nextIntent);
      setIsBuffering(nextIntent);
      return;
    }

    // `computeAppliedGain` returns the same scalar `applyOutputLevels`
    // would set, so toggling play here doesn't drift away from the
    // steady-state gain — the crossfade ramps are anchored to the same
    // value the rest of the audio graph already knows.
    const target = computeAppliedGain(volumeRef.current, normGainRef.current);
    const crossfadeOn = getSetting("crossfade");

    if (audio.paused) {
      bootRestorePendingRef.current = null;
      setIsPlaying(true);
      setIsBuffering(!audio.readyState || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
      void ensureAudioGraph();

      const gain = gainNodeRef.current;
      const ctx = audioContextRef.current;
      if (ctx && gain) {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0, now);
        if (crossfadeOn) {
          gain.gain.linearRampToValueAtTime(target, now + 0.1);
        } else {
          gain.gain.setValueAtTime(target, now);
        }
      }

      const needsRefresh = playbackNeedsSourceRefresh(
        currentTrack,
        lastPlaybackIdleAtRef.current,
        streamSourceRefreshNeededRef.current,
      );
      if (needsRefresh) {
        sourceRefreshInProgressRef.current = true;
        setIsBuffering(true);
        const savedTime = audio.currentTime;
        lastPlaybackIdleAtRef.current = 0;
        void (async () => {
          try {
            await ensureAudioGraph();
            await refreshStaleAudioSource();
            streamSourceRefreshNeededRef.current = false;
            if (Number.isFinite(savedTime) && savedTime > 0) {
              audio.currentTime = savedTime;
            }
            await audio.play();
          } catch (error) {
            setIsPlaying(false);
            setIsBuffering(false);
            setLastError(
              error instanceof Error ? error.message : "Playback could not resume after refreshing the audio.",
            );
          } finally {
            sourceRefreshInProgressRef.current = false;
            drainPendingSeekRef.current();
          }
        })();
        return;
      }

      lastPlaybackIdleAtRef.current = 0;
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
  }, [currentTrack, ensureAudioGraph, refreshStaleAudioSource]);

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
    const generation = autoplayFetchGenerationRef.current;
    let appended = false;
    let retryScheduled = false;
    let shouldRetry = true;

    const abortIfStale = (): boolean => {
      if (generation === autoplayFetchGenerationRef.current) return false;
      shouldRetry = false;
      return true;
    };

    const releaseFetchGuardIfCurrent = () => {
      if (generation === autoplayFetchGenerationRef.current) {
        fetchingAutoplayRef.current = false;
      }
    };

    // Schedule an auto-retry with exponential backoff. The first three
    // retries wait AUTOPLAY_RETRY_BASE_DELAY_MS each; after the 3rd retry
    // the delay begins doubling per subsequent retry (retry 4 → 6s,
    // retry 5 → 12s, retry 6 → 24s, ...).
    const tryScheduleRetry = () => {
      if (
        retryScheduled ||
        !autoplayRef.current ||
        !seed.videoId ||
        generation !== autoplayFetchGenerationRef.current ||
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
      const retryGeneration = generation;
      autoplayRetryTimerRef.current = setTimeout(() => {
        autoplayRetryTimerRef.current = null;
        if (retryGeneration !== autoplayFetchGenerationRef.current) return;
        // Briefly release the in-flight guard so the retry can re-enter
        // fetchAndAppendAutoplay (its own guard would otherwise block it).
        fetchingAutoplayRef.current = false;
        void fetchAndAppendAutoplay();
      }, delay);
    };

    // Watchdog: if we haven't appended anything within
    // AUTOPLAY_FETCH_TIMEOUT_MS, treat the attempt as a failure and
    // trigger an auto-retry. The retry delay itself is computed by
    // tryScheduleRetry using the retry counter (which handles the
    // first-three-fixed-then-doubling schedule).
    const watchdog = setTimeout(() => {
      if (appended || !fetchingAutoplayRef.current) return;
      if (generation !== autoplayFetchGenerationRef.current) return;
      tryScheduleRetry();
    }, AUTOPLAY_FETCH_TIMEOUT_MS);

    try {
    // Capture the queue snapshot BEFORE the async resolve so we can detect
    // stale-request writes after the await. The previous implementation
    // captured `queueRef.current` after await and compared it against itself
    // (always passing), which let old autoplay results leak into a replacement
    // queue the user had already started.
    const currentIndex = queueIndexRef.current;
    const autoplayIds = autoplayTrackIdsRef.current;
    const queueSnapshot = queueRef.current.slice();
    const queueSnapshotOrigin = queueOriginRef.current;
    const queueSnapshotSeed = autoplaySeedRef.current;

    const result = await resolveAutoplayAdditions(
      {
        seed: { videoId: seed.videoId, playlistId: seed.playlistId ?? null },
        queue: queueSnapshot,
        currentIndex,
        autoplayIds,
        autoplayEnabled: () => autoplayRef.current,
        seedStillCurrent: () => generation === autoplayFetchGenerationRef.current,
        batchLimit: AUTOPLAY_QUEUE_BATCH_LIMIT,
        queueTarget: AUTOPLAY_QUEUE_TARGET,
      },
      {
        getWatchPlaylist,
        resolveAutoplayEntryToSong,
        buildSeenIndex,
        isInRecentlyPlayed: (entry) => {
          const recentPlayedSet = buildRecentlyPlayedSet(
            playbackHistoryRef.current.slice(0, 10),
          );
          return isInRecentlyPlayed(entry, recentPlayedSet);
        },
      },
    );

    if (
      abortIfStale() ||
      !autoplayRef.current ||
      autoplaySeedRef.current?.videoId !== seed.videoId
    ) {
      return;
    }

    const additions = result.additions;
    if (additions.length === 0) {
      tryScheduleRetry();
      return;
    }

    // play()/playMany() can replace the queue while autoplay fetches are
    // in flight. Re-check the snapshot vs. the current queue head through
    // the captured playhead is unchanged before commit; otherwise we'd
    // append stale results into a replacement queue.
    const latestQueue = queueRef.current;
    if (latestQueue.length < currentIndex + 1) return;
    for (let i = 0; i <= currentIndex; i += 1) {
      if (latestQueue[i]?.id !== queueSnapshot[i]?.id) return;
    }
    // Also verify the queue origin and seed haven't been replaced.
    if (!queueOriginEquals(latestQueue.length > 0 ? queueOriginRef.current : null, queueSnapshotOrigin)) return;
    if ((autoplaySeedRef.current?.videoId ?? null) !== (queueSnapshotSeed?.videoId ?? null)) return;
    if ((autoplaySeedRef.current?.playlistId ?? null) !== (queueSnapshotSeed?.playlistId ?? null)) return;

      appended = true;
      autoplayRetryCountRef.current = 0;
      const nextQueue = [...queueRef.current, ...additions];
      const nextAutoplayIds = new Set(autoplayIds);
      additions.forEach((track) => nextAutoplayIds.add(track.id));

      const nextSeed = result.nextSeed;

      setQueueState({
        queue: nextQueue,
        queueIndex: queueIndexRef.current,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: nextAutoplayIds,
        autoplaySeed: autoplaySeedRef.current,
      });
      if (nextSeed) {
        autoplaySeedRef.current = nextSeed;
        setAutoplaySeed(nextSeed);
      }

      if (autoplayAdvancePendingRef.current) {
        autoplayAdvancePendingRef.current = false;
        const nextIndex = queueIndexRef.current + 1;
        if (nextIndex < nextQueue.length) {
          const advancedTrack = nextQueue[nextIndex];
          if (advancedTrack) {
            queueVisitedTrackIdsRef.current = addVisitedQueueTrack(
              queueVisitedTrackIdsRef.current,
              advancedTrack.id,
            );
            setQueueVisitedTrackIds(queueVisitedTrackIdsRef.current);
          }
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
      if (shouldRetry) {
        tryScheduleRetry();
      }
    } finally {
      clearTimeout(watchdog);
      releaseFetchGuardIfCurrent();
    }
  }, [setQueueState]);

  const ensureAutoplayTopUp = useCallback(function ensureAutoplayTopUp(waitForInFlight = false) {
    const attempt = (inFlightWaitsLeft: number) => {
      if (!autoplayRef.current) return;
      const seed = autoplaySeedRef.current;
      if (!seed?.videoId) return;
      const autoplayAhead = queueRef.current
        .slice(queueIndexRef.current + 1)
        .filter((track) => autoplayTrackIdsRef.current.has(track.id)).length;
      if (autoplayAhead >= AUTOPLAY_QUEUE_TARGET) return;
      if (fetchingAutoplayRef.current) {
        if (waitForInFlight && inFlightWaitsLeft > 0) {
          window.setTimeout(
            () => attempt(inFlightWaitsLeft - 1),
            AUTOPLAY_FETCH_TIMEOUT_MS + 250,
          );
        }
        return;
      }
      void fetchAndAppendAutoplay(seed);
    };

    queueMicrotask(() => attempt(waitForInFlight ? 2 : 0));
  }, [fetchAndAppendAutoplay]);

  fetchAndAppendAutoplayRef.current = fetchAndAppendAutoplay;
  ensureAutoplayTopUpRef.current = ensureAutoplayTopUp;

  const next = useCallback((recordRecentlyPlayed = false) => {
    const currentQueue = queueRef.current;
    const currentIndex = queueIndexRef.current;
    if (currentQueue.length === 0) return;
    if (currentIndex + 1 < currentQueue.length) {
      autoplayAdvancePendingRef.current = false;
      const redoingForward = isRedoingQueueAdvance(
        playbackHistoryRef.current,
        currentQueue,
        currentIndex,
        queueOriginRef.current,
      );
      if (recordRecentlyPlayed && !redoingForward) rememberPlaybackHistory();
      const nextTrack = currentQueue[currentIndex + 1];
      if (nextTrack) markQueueTrackVisited(nextTrack.id);
      stopCurrentPlayback({ capturePlayIntent: true });
      invalidateAutoplayFetch();
      setQueueState({
        queue: currentQueue,
        queueIndex: currentIndex + 1,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      if (autoplayRef.current) ensureAutoplayTopUp(false);
      return;
    }
    if (repeatRef.current === "all") {
      autoplayAdvancePendingRef.current = false;
      if (recordRecentlyPlayed) rememberPlaybackHistory();
      const wrapTrack = currentQueue[0];
      if (wrapTrack) markQueueTrackVisited(wrapTrack.id);
      stopCurrentPlayback({ capturePlayIntent: true });
      invalidateAutoplayFetch();
      setQueueState({
        queue: currentQueue,
        queueIndex: 0,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      if (autoplayRef.current) ensureAutoplayTopUp(false);
      return;
    }
    if (autoplayRef.current && autoplaySeedRef.current?.videoId) {
      if (recordRecentlyPlayed) rememberPlaybackHistory();
      stopCurrentPlayback({ capturePlayIntent: true });
      autoplayAdvancePendingRef.current = true;
      invalidateAutoplayFetch();
      void fetchAndAppendAutoplay();
    }
  }, [rememberPlaybackHistory, fetchAndAppendAutoplay, stopCurrentPlayback, setQueueState, ensureAutoplayTopUp, invalidateAutoplayFetch, markQueueTrackVisited]);

  useEffect(() => {
    nextRef.current = next;
  }, [next]);

  const playQueueIndex = useCallback((index: number, trackId?: string) => {
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) return;
    let nextIndex = Math.max(0, Math.min(index, currentQueue.length - 1));
    if (trackId) {
      const atIndex = currentQueue[nextIndex];
      if (atIndex?.id !== trackId) {
        const byId = currentQueue.findIndex((track) => track.id === trackId);
        if (byId >= 0) nextIndex = byId;
      }
    }
    if (nextIndex === queueIndexRef.current) {
      togglePlay();
      return;
    }
    autoplayAdvancePendingRef.current = false;
    if (
      nextIndex > queueIndexRef.current &&
      !isRedoingQueueAdvance(
        playbackHistoryRef.current,
        currentQueue,
        queueIndexRef.current,
        queueOriginRef.current,
      )
    ) {
      rememberPlaybackHistory();
    }
    const targetTrack = currentQueue[nextIndex];
    if (targetTrack) markQueueTrackVisited(targetTrack.id);
    stopCurrentPlayback({ capturePlayIntent: true });
    invalidateAutoplayFetch();
    setQueueState({
      queue: currentQueue,
      queueIndex: nextIndex,
      queueOrigin: queueOriginRef.current,
      autoplayTrackIds: autoplayTrackIdsRef.current,
      autoplaySeed: autoplaySeedRef.current,
    });
    if (autoplayRef.current) ensureAutoplayTopUp(false);
  }, [rememberPlaybackHistory, stopCurrentPlayback, togglePlay, setQueueState, ensureAutoplayTopUp, invalidateAutoplayFetch, markQueueTrackVisited]);

  const restoreHistoryEntry = useCallback((historyIndex: number) => {
    const entry = playbackHistoryRef.current[historyIndex];
    if (!entry) return;

    autoplayAdvancePendingRef.current = false;
    stopCurrentPlayback({ capturePlayIntent: true });
    // A fetch started for the queue we are leaving must not append into the
    // restored snapshot. This is needed even when the seed is unchanged:
    // setQueueState's seed comparison cannot detect that session boundary.
    invalidateAutoplayFetch();

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
  }, [stopCurrentPlayback, applyPlaybackHistoryEntry, invalidateAutoplayFetch]);

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
    if (currentQueue.length === 0) return;
    if (currentIndex >= 0) {
      const head = currentQueue.slice(0, currentIndex + 1);
      const autoplayTail = currentQueue.slice(currentIndex + 1).filter((t) => autoplayIds.has(t.id));
      const retainedAutoplayIds = new Set<string>();
      for (const t of autoplayTail) {
        retainedAutoplayIds.add(t.id);
      }
      setQueueState({
        queue: [...head, ...autoplayTail],
        queueIndex: currentIndex,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: retainedAutoplayIds,
        autoplaySeed: autoplaySeedRef.current,
      });
    } else {
      const autoplayTail = currentQueue.filter((t) => autoplayIds.has(t.id));
      const retainedAutoplayIds = new Set<string>();
      for (const t of autoplayTail) {
        retainedAutoplayIds.add(t.id);
      }
      setQueueState({
        queue: autoplayTail,
        queueIndex: -1,
        queueOrigin: null,
        autoplayTrackIds: retainedAutoplayIds,
        autoplaySeed: autoplaySeedRef.current,
      });
    }
  }, [setQueueState]);

  const clearPlaybackHistory = useCallback(() => {
    setPlaybackHistory([]);
    playbackHistoryRef.current = [];
    if (trackRef.current) {
      resetQueueVisitedToTrack(trackRef.current.id);
    } else {
      setQueueVisitedTrackIds(new Set());
      queueVisitedTrackIdsRef.current = new Set();
    }
  }, [resetQueueVisitedToTrack]);

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
      stopCurrentPlayback({ capturePlayIntent: true, forceReload: true });
    }

    setQueueVisitedTrackIds((current) => removeVisitedQueueTrack(current, trackId));
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
    void (async () => {
    const hydrated = await Promise.all(tracks.map(hydrateUploadTrackForPlayback));
    const queueable = filterQueueableTracks(hydrated);
    if (queueable.length === 0) return;
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
    for (const track of queueable) {
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
    })();
  }, [setQueueState]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    autoplayAdvancePendingRef.current = false;
    // Restart the current track if past the 5-second threshold.
    if (audio.currentTime > 5) {
      const track = trackRef.current;
      const needsRefresh = playbackNeedsSourceRefresh(
        track,
        lastPlaybackIdleAtRef.current,
        streamSourceRefreshNeededRef.current,
      );
      if (needsRefresh) {
        const wasPlaying = !audio.paused;
        sourceRefreshInProgressRef.current = true;
        setIsBuffering(true);
        void (async () => {
          try {
            lastPlaybackIdleAtRef.current = 0;
            await ensureAudioGraph();
            await refreshStaleAudioSource();
            streamSourceRefreshNeededRef.current = false;
            audio.currentTime = 0;
            progressRef.current = 0;
            writeProgress(0);
            if (wasPlaying) {
              await audio.play();
            } else {
              setIsBuffering(false);
            }
          } catch (error) {
            setIsBuffering(false);
            audio.currentTime = 0;
            progressRef.current = 0;
            writeProgress(0);
            setLastError(
              error instanceof Error ? error.message : "Could not restart this track.",
            );
          } finally {
            sourceRefreshInProgressRef.current = false;
            drainPendingSeekRef.current();
          }
        })();
        return;
      }
      audio.currentTime = 0;
      progressRef.current = 0;
      writeProgress(0);
      return;
    }
    // Move backward within the queue only to tracks the user actually started.
    const previousVisitedIndex = findPreviousVisitedQueueIndex(
      queueRef.current,
      queueIndex,
      queueVisitedTrackIdsRef.current,
    );
    if (previousVisitedIndex >= 0) {
      stopCurrentPlayback({ capturePlayIntent: true });
      setQueueState({
        queue: queueRef.current,
        queueIndex: previousVisitedIndex,
        queueOrigin: queueOriginRef.current,
        autoplayTrackIds: autoplayTrackIdsRef.current,
        autoplaySeed: autoplaySeedRef.current,
      });
      return;
    }
    // At the queue head, jump to the prior listening session (Spotify-style)
    // without mutating history. Skip entries for tracks still queued ahead —
    // those are forward skips the user backed over, not prior sessions.
    const historyIndex = findPreviousSessionHistoryIndex(
      playbackHistoryRef.current,
      queueRef.current,
      queueIndex,
      trackRef.current,
      queueOriginRef.current,
    );
    if (historyIndex >= 0) {
      const historyEntry = playbackHistoryRef.current[historyIndex];
      if (
        historyEntry &&
        !historyRestoreWouldDropAppendedTracks(queueRef.current, historyEntry)
      ) {
        restoreHistoryEntry(historyIndex);
        return;
      }
    }
    audio.currentTime = 0;
    progressRef.current = 0;
    writeProgress(0);
  }, [queueIndex, stopCurrentPlayback, restoreHistoryEntry, setQueueState, ensureAudioGraph, refreshStaleAudioSource]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (!audio) return;
    // Clamp against the live resolved duration rather than the possibly
    // stale `duration` state. The two can diverge while paused (the tick
    // that refreshes `duration` early-returns when paused) or while a
    // stream is still buffering, which let a seek land short of the
    // position the seek bar painted and left the thumb/fill offset from
    // the cursor.
    const resolved =
      readLiveMediaDuration(audio, track?.durationSeconds) ||
      duration ||
      track?.durationSeconds ||
      0;
    const target = Math.max(0, Math.min(resolved, seconds));
    if (sourceRefreshInProgressRef.current) {
      pendingSeekTargetRef.current = target;
      progressRef.current = target;
      writeProgress(target);
      return;
    }
    const isActivelyPlaying = !audio.paused;
    const needsRefresh =
      !isActivelyPlaying &&
      playbackNeedsSourceRefresh(
        track,
        lastPlaybackIdleAtRef.current,
        streamSourceRefreshNeededRef.current,
      );
    if (needsRefresh && track?.source === "stream") {
      const wasPlaying = !audio.paused;
      sourceRefreshInProgressRef.current = true;
      setIsBuffering(true);
      if (wasPlaying) {
        lastPlaybackIdleAtRef.current = 0;
      }
      void (async () => {
        try {
          await ensureAudioGraph();
          await refreshStaleAudioSource();
          streamSourceRefreshNeededRef.current = false;
          applySeekTarget(target);
          if (wasPlaying) {
            await audio.play();
          }
        } catch (error) {
          setIsPlaying(false);
          setIsBuffering(false);
          setLastError(
            error instanceof Error ? error.message : "Could not seek after refreshing the audio.",
          );
        } finally {
          sourceRefreshInProgressRef.current = false;
          if (audio.paused) {
            setIsBuffering(false);
          }
          drainPendingSeek();
          tryResumeAfterSeekScrubRef.current();
        }
      })();
      return;
    }
    applySeekTarget(target);
    tryResumeAfterSeekScrubRef.current();
  }, [duration, ensureAudioGraph, refreshStaleAudioSource, applySeekTarget, drainPendingSeek]);

  const tryResumeAfterSeekScrub = useCallback(() => {
    if (!resumeAfterSeekRef.current) return;
    resumeAfterSeekRef.current = false;
    const audio = audioRef.current;
    if (!audio || !trackRef.current || !audio.paused) return;
    togglePlay();
  }, [togglePlay]);

  useEffect(() => {
    tryResumeAfterSeekScrubRef.current = tryResumeAfterSeekScrub;
  }, [tryResumeAfterSeekScrub]);

  const beginSeekScrub = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return false;
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }
    const wasPlaying = !audio.paused;
    if (!wasPlaying) return false;

    lastPlaybackIdleAtRef.current = 0;
    setIsPlaying(false);
    setIsBuffering(false);
    audio.pause();

    const gain = gainNodeRef.current;
    const ctx = audioContextRef.current;
    if (ctx && gain) {
      const target = computeAppliedGain(volumeRef.current, normGainRef.current);
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(target, now);
    }
    return true;
  }, [currentTrack]);

  const updateSeekScrubPreview = useCallback((seconds: number | null) => {
    writeSeekScrub(seconds);
  }, []);

  const finishSeekScrub = useCallback((seconds: number | null, resume: boolean) => {
    // Apply the seek first so audio.currentTime reflects the new position
    // before we clear the live scrub preview. Seek internally unpauses via
    // tryResumeAfterSeekScrub, so audio is already resumed when downstream
    // subscribers react to the cleared preview. If we cleared the preview
    // first, listeners (e.g. LyricsPage’s `displayProgress`) would briefly
    // see the pre-scrub timestamp and react-scroll the lyrics back to the
    // previously active line.
    resumeAfterSeekRef.current = resume;
    if (seconds !== null) {
      seek(seconds);
    } else {
      tryResumeAfterSeekScrub();
    }
    writeSeekScrub(null);
  }, [seek, tryResumeAfterSeekScrub]);

  const setVolume = useCallback((value: number) => {
    setVolumeTransport(value);
    setMutedTransport(false);
  }, [setMutedTransport, setVolumeTransport]);

  const setLiveVolume = useCallback((value: number) => {
    // Publish the in-progress value so external audio mirrors (the
    // music-video page's video element) follow the slider live during the
    // drag, not just on mouseup when `setVolume` commits. `liveVolume` is
    // separate from `volume` on purpose: the store publish must not trigger
    // the player's own `applyOutputLevels` effect (which depends on
    // `volume`/`muted`/`normGain`), or the drag would fight the gain ramp.
    usePlayerTransportStore.getState().setLiveVolume(value);
    const audio = audioRef.current;
    if (!audio) return;
    // Route through `computeAppliedGain` so the slider uses the same
    // factor chain (norm-gain × volume × master-dB) as `applyOutputLevels`.
    // The 0.015s ramp is a bit faster than `applyOutputLevels`' 0.15s
    // because this fires on every onChange event while dragging — a tight
    // ramp keeps the slider feeling responsive without audible zipper noise.
    const target = computeAppliedGain(value, normGainRef.current);
    const gainNode = gainNodeRef.current;

    if (gainNode && audioContextRef.current) {
      const now = audioContextRef.current.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(target, now, 0.015);
      audio.volume = 1;
    } else {
      audio.volume = clampVolume(target);
    }
    audio.muted = audioMuteOverride.current;
  }, []);

  const toggleMute = useCallback(() => {
    usePlayerTransportStore.getState().toggleMuted();
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
    // Persist through the unified settings blob (atomic per-tick
    // write) so a coalesced flush on the backend can never drop the
    // autoplay value mid-write the way the previous per-key `velocity-autoplay` IPC echo could. The React state is owned by `useSetting("autoplay")` above, which subscribes to the settings-notification broadcast and re-renders this provider automatically when `setSetting` fires, so we don’t need a parallel `setAutoplayState` call here.
    setSetting("autoplay", value);
    if (value) {
      const current = trackRef.current;
      if (!autoplaySeedRef.current && current?.source === "stream" && current.videoId) {
        const effectiveVideoId = current.resolvedVideoId ?? current.videoId;
        const nextSeed = { videoId: effectiveVideoId, playlistId: null };
        autoplaySeedRef.current = nextSeed;
        setAutoplaySeed(nextSeed);
      }
      ensureAutoplayTopUp(false);
      return;
    }

    invalidateAutoplayFetch();

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
  }, [ensureAutoplayTopUp, setQueueState, invalidateAutoplayFetch]);

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

  // Session restore on first mount — queue/progress are seeded synchronously
  // via getBootSession() so the player bar can paint the saved timestamp
  // immediately. This effect only kicks off the autoplay fetch.
  useEffect(() => {
    const data = getBootSession();
    if (!data) return;

    const nextSeed = bootAutoplaySeed(data);
    if (!nextSeed) return;

    // Proactively kick off the autoplay fetch in lockstep with the queue
    // being seeded — same race closure as play()/playMany(). Relying solely
    // on the toppings effect is unreliable on startup, especially when the
    // restored track's stream is already cached and the load effect finishes
    // before the deferred toppings pass runs.
    void fetchAndAppendAutoplay(nextSeed);
    // Belt-and-suspenders: if the first fetch loses the startup race or
    // aborts after audio resolution, the deferred pass still refills.
    ensureAutoplayTopUp(true);
  }, [fetchAndAppendAutoplay, ensureAutoplayTopUp]);

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
      persistCachedLyricsForTrack(currentTrack);
    };

    sessionSaveTimerRef.current = setInterval(save, 10_000);

    return () => {
      if (sessionSaveTimerRef.current) {
        clearInterval(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      if (currentTrack?.source === "stream") {
        persistCachedLyricsForTrack(currentTrack);
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

  const actionsValue = useMemo<PlayerActions>(
    () => ({
      play,
      playMany,
      playShuffled,
      playQueueIndex,
      restoreHistoryEntry,
      moveQueueItem,
      clearQueue,
      clearPlaybackHistory,
      removeTrackFromQueue,
      appendToQueue,
      warm,
      togglePlay,
      next,
      prev,
      seek,
      beginSeekScrub,
      finishSeekScrub,
      updateSeekScrubPreview,
      setVolume,
      setLiveVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
      setAutoplay,
      reloadAutoplay,
      ensureAutoplayTopUp,
      clearError,
      retry,
      getAnalyser,
      setEqualizerBand,
    }),
    [
      appendToQueue,
      beginSeekScrub,
      clearError,
      clearPlaybackHistory,
      clearQueue,
      cycleRepeat,
      ensureAutoplayTopUp,
      finishSeekScrub,
      getAnalyser,
      moveQueueItem,
      next,
      play,
      playMany,
      playQueueIndex,
      playShuffled,
      prev,
      reloadAutoplay,
      removeTrackFromQueue,
      restoreHistoryEntry,
      retry,
      seek,
      setAutoplay,
      setEqualizerBand,
      setLiveVolume,
      setVolume,
      toggleMute,
      togglePlay,
      toggleShuffle,
      updateSeekScrubPreview,
      warm,
    ],
  );

  const stateValue = useMemo<PlayerState>(
    () => ({
      currentTrack,
      queue,
      queueIndex,
      queueOrigin,
      autoplayTrackIds,
      recentlyPlayed,
      isPlaying,
      isBuffering,
      isReloadingAutoplay,
      seekRevision,
      duration,
      volume,
      muted,
      shuffle,
      repeat,
      autoplay,
      autoplaySeed,
      lastError,
      normGain,
    }),
    [
      autoplay,
      autoplaySeed,
      autoplayTrackIds,
      currentTrack,
      duration,
      isBuffering,
      isPlaying,
      isReloadingAutoplay,
      lastError,
      muted,
      normGain,
      queue,
      queueIndex,
      queueOrigin,
      recentlyPlayed,
      repeat,
      seekRevision,
      shuffle,
      volume,
    ],
  );

  return (
    <PlayerActionsContext.Provider value={actionsValue}>
      <PlayerStateContext.Provider value={stateValue}>
        {children}
      </PlayerStateContext.Provider>
    </PlayerActionsContext.Provider>
  );
}

export function usePlayerActions(): PlayerActions {
  const ctx = useContext(PlayerActionsContext);
  if (!ctx) throw new Error("usePlayerActions must be used within PlayerProvider");
  return ctx;
}

export function usePlayerState(): PlayerState {
  const ctx = useContext(PlayerStateContext);
  if (!ctx) throw new Error("usePlayerState must be used within PlayerProvider");
  return ctx;
}

export function usePlayer(): PlayerContextValue {
  const state = usePlayerState();
  const actions = usePlayerActions();
  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}

export { getPlayerProgress, getPlayerSeekScrubProgress } from "./store/playerUiStore";
