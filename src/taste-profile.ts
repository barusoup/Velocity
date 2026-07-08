import type { MediaTrack } from "./types";
import { getItem, setItem } from "./storage";
import {
  dedupeTracksBySong,
  isLikelyMusicVideoTrack,
  isSameSongTrack,
  preferStudioSongTrack,
  streamIdentityVideoIds,
} from "./utils/media";
import { isPlaceholderArtist } from "./utils/search";

export const TASTE_PROFILE_KEY = "velocity-taste-profile";

export const TASTE_PROFILE_MAX_ENTRIES = 250;
export const REDISCOVERY_POOL_MAX = 25;
export const LISTEN_QUALIFY_RATIO = 0.75;
export const PROFILE_STALE_DAYS = 14;
export const REDISCOVERY_DORMANT_DAYS = 30;
export const FIRST_DAILY_RECOMMENDATION_THRESHOLD = 5;
/** Max qualified-play timestamps retained per entry (yearly window + headroom). */
export const QUALIFIED_PLAYS_MAX = 400;

export type TopSongsPeriod = "weekly" | "monthly" | "yearly" | "allTime";

export const TOP_SONGS_PERIOD_LIMITS: Record<TopSongsPeriod, number> = {
  weekly: 25,
  monthly: 50,
  yearly: 100,
  allTime: 250,
};

export function getTopSongsPeriodLimit(period: TopSongsPeriod): number {
  return TOP_SONGS_PERIOD_LIMITS[period];
}

export type TasteProfileEntry = {
  videoId: string;
  trackId: string;
  title: string;
  artist: string;
  album?: string | null;
  cover?: string | null;
  albumBrowseId?: string | null;
  artistBrowseId?: string | null;
  artistCredits?: MediaTrack["artistCredits"];
  kind?: MediaTrack["kind"];
  source?: MediaTrack["source"];
  resolvedVideoId?: string | null;
  durationSeconds?: number | null;
  playCount: number;
  lastPlayedAt: number;
  firstPlayedAt: number;
  /** Epoch ms for each qualified listen (75%+ of duration actually played). */
  qualifiedPlays: number[];
};

export type DailyRecommendations = {
  date: string;
  tracks: MediaTrack[];
};

export type TasteProfileState = {
  entries: Record<string, TasteProfileEntry>;
  lastProfileChangeAt: number;
  rediscoveryPool: string[];
  recommendationHistory: string[];
  dailyRecommendations: DailyRecommendations | null;
  lastRecommendationRefreshAt: number | null;
};

const PERIOD_MS: Record<Exclude<TopSongsPeriod, "allTime">, number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const QUALIFIED_PLAYS_RETAIN_MS = 366 * DAY_MS;

type TasteProfileListener = () => void;
const listeners = new Set<TasteProfileListener>();

export function subscribeTasteProfile(listener: TasteProfileListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyTasteProfileListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Listener errors must not break other subscribers.
    }
  }
}

function emptyState(): TasteProfileState {
  return {
    entries: {},
    lastProfileChangeAt: 0,
    rediscoveryPool: [],
    recommendationHistory: [],
    dailyRecommendations: null,
    lastRecommendationRefreshAt: null,
  };
}

function parseState(raw: string | null): TasteProfileState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<TasteProfileState>;
    return {
      entries: parsed.entries ?? {},
      lastProfileChangeAt: parsed.lastProfileChangeAt ?? 0,
      rediscoveryPool: Array.isArray(parsed.rediscoveryPool) ? parsed.rediscoveryPool : [],
      recommendationHistory: Array.isArray(parsed.recommendationHistory)
        ? parsed.recommendationHistory
        : [],
      dailyRecommendations: parsed.dailyRecommendations ?? null,
      lastRecommendationRefreshAt: parsed.lastRecommendationRefreshAt ?? null,
    };
  } catch {
    return emptyState();
  }
}

export function loadTasteProfile(): TasteProfileState {
  return parseState(getItem(TASTE_PROFILE_KEY));
}

export function saveTasteProfile(state: TasteProfileState): void {
  setItem(TASTE_PROFILE_KEY, JSON.stringify(state));
  notifyTasteProfileListeners();
}

export function todayDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function tasteProfileVideoId(track: MediaTrack): string | null {
  return track.resolvedVideoId ?? track.videoId ?? (track.source === "upload" ? track.id : null);
}

function preferTrackMetadata(current: MediaTrack, candidate: MediaTrack): MediaTrack {
  let preferred = preferStudioSongTrack(current, candidate);
  const fallback = preferred === current ? candidate : current;
  if (isPlaceholderArtist(preferred.artist) && !isPlaceholderArtist(fallback.artist)) {
    preferred = { ...preferred, artist: fallback.artist };
  }
  return preferred;
}

function entryToTrack(entry: TasteProfileEntry): MediaTrack {
  return {
    id: entry.trackId,
    kind: entry.kind ?? "song",
    title: entry.title,
    artist: entry.artist,
    album: entry.album ?? null,
    albumBrowseId: entry.albumBrowseId ?? null,
    artistBrowseId: entry.artistBrowseId ?? null,
    artistCredits: entry.artistCredits ?? null,
    durationSeconds: entry.durationSeconds ?? null,
    cover: entry.cover ?? null,
    videoId: entry.source === "upload" ? null : entry.videoId,
    resolvedVideoId: entry.resolvedVideoId ?? null,
    source: entry.source ?? "stream",
    filePath: null,
  };
}

function trimQualifiedPlays(plays: readonly number[], now: number): number[] {
  const cutoff = now - QUALIFIED_PLAYS_RETAIN_MS;
  return plays.filter((ts) => ts >= cutoff).slice(-QUALIFIED_PLAYS_MAX);
}

function entryScore(entry: TasteProfileEntry, now: number): number {
  const recentWindow = 30 * DAY_MS;
  const recentPlays = entry.qualifiedPlays.filter((ts) => now - ts <= recentWindow).length;
  const recencyBoost = Math.max(0, 1 - (now - entry.lastPlayedAt) / (90 * DAY_MS));
  return entry.playCount * 2 + recentPlays * 3 + recencyBoost;
}

function trimEntries(entries: Record<string, TasteProfileEntry>, now: number): Record<string, TasteProfileEntry> {
  const sorted = Object.values(entries).sort((a, b) => entryScore(b, now) - entryScore(a, now));
  const kept = sorted.slice(0, TASTE_PROFILE_MAX_ENTRIES);
  return Object.fromEntries(kept.map((entry) => [entry.videoId, entry]));
}

function isProfileStale(state: TasteProfileState, now: number): boolean {
  if (state.lastProfileChangeAt <= 0) return true;
  return now - state.lastProfileChangeAt >= PROFILE_STALE_DAYS * DAY_MS;
}

function rebuildRediscoveryPool(
  entries: Record<string, TasteProfileEntry>,
  now: number,
): string[] {
  const dormantCutoff = now - REDISCOVERY_DORMANT_DAYS * DAY_MS;
  const candidates = Object.values(entries)
    .filter((entry) => entry.lastPlayedAt < dormantCutoff && entry.playCount >= 2)
    .sort((a, b) => entryScore(b, now) - entryScore(a, now))
    .slice(0, REDISCOVERY_POOL_MAX)
    .map((entry) => entry.videoId);
  return candidates;
}

function findTasteProfileEntryForTrack(
  entries: Record<string, TasteProfileEntry>,
  track: MediaTrack,
  videoId: string,
): { key: string; entry: TasteProfileEntry } | null {
  const direct = entries[videoId];
  if (direct) return { key: videoId, entry: direct };

  for (const [key, entry] of Object.entries(entries)) {
    if (isSameSongTrack(entryToTrack(entry), track)) {
      return { key, entry };
    }

    const entryTitle = entry.title.trim().toLowerCase();
    const trackTitle = track.title.trim().toLowerCase();
    const entryIsPlaceholder = isPlaceholderArtist(entry.artist);
    const trackIsPlaceholder = isPlaceholderArtist(track.artist);
    if (
      entryTitle &&
      entryTitle === trackTitle &&
      entryIsPlaceholder !== trackIsPlaceholder
    ) {
      return { key, entry };
    }
  }
  return null;
}

export function recordQualifiedListen(track: MediaTrack, now = Date.now()): TasteProfileState {
  const playbackVideoId = tasteProfileVideoId(track);
  if (!playbackVideoId) return loadTasteProfile();

  const state = loadTasteProfile();
  const found = findTasteProfileEntryForTrack(state.entries, track, playbackVideoId);
  const existing = found?.entry;
  const mergedTrack = existing
    ? preferTrackMetadata(entryToTrack(existing), track)
    : track;
  const storageKey = tasteProfileVideoId(mergedTrack) ?? playbackVideoId;
  const qualifiedPlays = trimQualifiedPlays([...(existing?.qualifiedPlays ?? []), now], now);

  const nextEntry: TasteProfileEntry = {
    videoId: storageKey,
    trackId: mergedTrack.id,
    title: mergedTrack.title,
    artist: mergedTrack.artist,
    album: mergedTrack.album ?? null,
    cover: mergedTrack.cover ?? null,
    albumBrowseId: mergedTrack.albumBrowseId ?? null,
    artistBrowseId: mergedTrack.artistBrowseId ?? null,
    artistCredits: mergedTrack.artistCredits ?? null,
    kind: mergedTrack.kind ?? "song",
    source: mergedTrack.source,
    resolvedVideoId: mergedTrack.resolvedVideoId ?? null,
    durationSeconds: mergedTrack.durationSeconds ?? null,
    playCount: (existing?.playCount ?? 0) + 1,
    firstPlayedAt: existing?.firstPlayedAt ?? now,
    lastPlayedAt: now,
    qualifiedPlays,
  };

  const entries = { ...state.entries };
  if (found && found.key !== storageKey) {
    delete entries[found.key];
  }
  const trimmedEntries = trimEntries({ ...entries, [storageKey]: nextEntry }, now);
  const rediscoveryPool = isProfileStale({ ...state, entries: trimmedEntries, lastProfileChangeAt: now }, now)
    ? rebuildRediscoveryPool(entries, now)
    : state.rediscoveryPool;

  const hasEnoughDistinctTracks = Object.keys(trimmedEntries).length >= FIRST_DAILY_RECOMMENDATION_THRESHOLD;
  const hasNoRealRecommendations =
    !state.dailyRecommendations || state.dailyRecommendations.tracks.length === 0;

  const next: TasteProfileState = {
    ...state,
    entries: trimmedEntries,
    lastProfileChangeAt: now,
    rediscoveryPool,
    recommendationHistory: state.recommendationHistory.slice(-500),
    ...(hasEnoughDistinctTracks && hasNoRealRecommendations
      ? { dailyRecommendations: null, lastRecommendationRefreshAt: null }
      : {}),
  };
  saveTasteProfile(next);
  return next;
}

export function countPlaysInPeriod(entry: TasteProfileEntry, period: TopSongsPeriod, now = Date.now()): number {
  if (period === "allTime") return entry.playCount;
  const windowMs = PERIOD_MS[period];
  const cutoff = now - windowMs;
  return entry.qualifiedPlays.filter((ts) => ts >= cutoff).length;
}

export type TopSongRow = {
  track: MediaTrack;
  plays: number;
};

type RankedTopSongRow = TopSongRow & { lastPlayedAt: number };

function compareRankedTopSongRows(a: RankedTopSongRow, b: RankedTopSongRow): number {
  if (b.plays !== a.plays) return b.plays - a.plays;
  return b.lastPlayedAt - a.lastPlayedAt;
}

function rankEntriesForPeriod(
  entries: Record<string, TasteProfileEntry>,
  period: TopSongsPeriod,
  now: number,
): RankedTopSongRow[] {
  const ranked: RankedTopSongRow[] = [];

  for (const entry of Object.values(entries)) {
    const plays = countPlaysInPeriod(entry, period, now);
    if (plays <= 0) continue;

    const track = entryToTrack(entry);
    const existingIndex = ranked.findIndex((row) => isSameSongTrack(row.track, track));
    if (existingIndex >= 0) {
      const existing = ranked[existingIndex]!;
      const preferredTrack = preferTrackMetadata(existing.track, track);
      ranked[existingIndex] = {
        track: preferredTrack,
        plays: existing.plays + plays,
        lastPlayedAt: Math.max(existing.lastPlayedAt, entry.lastPlayedAt),
      };
      continue;
    }

    ranked.push({
      track,
      plays,
      lastPlayedAt: entry.lastPlayedAt,
    });
  }

  ranked.sort(compareRankedTopSongRows);
  return ranked;
}

export function getTopSongRows(period: TopSongsPeriod, limit = 10, now = Date.now()): TopSongRow[] {
  const state = loadTasteProfile();
  const effectiveLimit = Math.min(limit, TOP_SONGS_PERIOD_LIMITS[period]);
  return rankEntriesForPeriod(state.entries, period, now)
    .slice(0, effectiveLimit)
    .map(({ track, plays }) => ({ track, plays }));
}

/** Video ids for every song that appears in any Top Songs period shelf. */
export function getTopSongExclusionVideoIds(now = Date.now()): Set<string> {
  const state = loadTasteProfile();
  const periods = Object.keys(TOP_SONGS_PERIOD_LIMITS) as TopSongsPeriod[];
  const excluded = new Set<string>();

  for (const period of periods) {
    const ranked = rankEntriesForPeriod(state.entries, period, now).slice(
      0,
      TOP_SONGS_PERIOD_LIMITS[period],
    );
    for (const row of ranked) {
      for (const videoId of streamIdentityVideoIds(row.track)) {
        excluded.add(videoId);
      }
    }
  }
  return excluded;
}

export function getTopSongs(period: TopSongsPeriod, limit = 10, now = Date.now()): MediaTrack[] {
  return getTopSongRows(period, limit, now).map((row) => row.track);
}

export function getTasteSeeds(limit = 8, now = Date.now()): TasteProfileEntry[] {
  const state = loadTasteProfile();
  const stale = isProfileStale(state, now);
  const core = Object.values(state.entries)
    .sort((a, b) => entryScore(b, now) - entryScore(a, now))
    .slice(0, Math.max(3, limit - (stale ? 2 : 0)));

  if (!stale) return core.slice(0, limit);

  const rediscovery = state.rediscoveryPool
    .map((videoId) => state.entries[videoId])
    .filter((entry): entry is TasteProfileEntry => Boolean(entry))
    .slice(0, 2);

  const merged = [...core, ...rediscovery];
  const seen = new Set<string>();
  const unique: TasteProfileEntry[] = [];
  for (const entry of merged) {
    if (seen.has(entry.videoId)) continue;
    seen.add(entry.videoId);
    unique.push(entry);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function needsDailyRecommendationRefresh(now = Date.now()): boolean {
  const state = loadTasteProfile();
  const today = todayDateKey(now);
  return state.dailyRecommendations?.date !== today;
}

export function storeDailyRecommendations(tracks: MediaTrack[], now = Date.now()): TasteProfileState {
  const state = loadTasteProfile();
  const dedupedTracks = dedupeTracksBySong(tracks);
  const videoIds = dedupedTracks
    .map((track) => tasteProfileVideoId(track))
    .filter((id): id is string => Boolean(id));

  const next: TasteProfileState = {
    ...state,
    dailyRecommendations: {
      date: todayDateKey(now),
      tracks: dedupedTracks,
    },
    lastRecommendationRefreshAt: now,
    recommendationHistory: [...state.recommendationHistory, ...videoIds].slice(-400),
  };
  saveTasteProfile(next);
  return next;
}

export function getCachedDailyRecommendations(now = Date.now()): MediaTrack[] | null {
  const state = loadTasteProfile();
  if (state.dailyRecommendations?.date !== todayDateKey(now)) return null;
  return dedupeTracksBySong(state.dailyRecommendations.tracks).filter(
    (track) => !isLikelyMusicVideoTrack(track),
  );
}

/** Video ids from the immediately previous day's Today's Picks shelf, if any. */
export function getYesterdayDailyRecommendationVideoIds(now = Date.now()): Set<string> {
  const state = loadTasteProfile();
  const yesterday = todayDateKey(now - DAY_MS);
  const daily = state.dailyRecommendations;
  if (!daily || daily.date !== yesterday) return new Set();

  const ids = new Set<string>();
  for (const track of daily.tracks) {
    const videoId = tasteProfileVideoId(track);
    if (videoId) ids.add(videoId);
  }
  return ids;
}

export function isKnownTasteSong(videoId: string | null | undefined): boolean {
  if (!videoId) return false;
  const entries = loadTasteProfile().entries;
  if (entries[videoId]) return true;
  return Object.values(entries).some((entry) =>
    streamIdentityVideoIds(entryToTrack(entry)).includes(videoId),
  );
}

export function getRecentRecommendationVideoIds(days = 7, now = Date.now()): Set<string> {
  const state = loadTasteProfile();
  const known = new Set(Object.keys(state.entries));
  state.recommendationHistory.forEach((id) => known.add(id));
  void days;
  void now;
  return known;
}

export function isTasteProfileEmpty(): boolean {
  const state = loadTasteProfile();
  return (
    Object.keys(state.entries).length === 0 &&
    state.rediscoveryPool.length === 0 &&
    state.recommendationHistory.length === 0 &&
    !state.dailyRecommendations
  );
}

export function clearTasteProfile(): void {
  saveTasteProfile(emptyState());
}