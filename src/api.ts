import { invoke } from "@tauri-apps/api/core";
import type {
  ArtistDetail,
  BackendStatus,
  EntityDetail,
  ExtractedMetadata,
  LoudnessData,
  LeadingSilenceData,
  MediaTrack,
  SearchResponse,
  SearchSuggestion,
  SyncedLyricsResponse,
  StreamResponse,
  TrackAlbumResolution,
  WatchPlaylistResponse,
} from "./types";
import { getItem, setItem, removeItem } from "./storage";
import { exportStreamVideoId, streamIdentityVideoIds, withResolvedAudioSrc } from "./utils/media";


declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    };
  }
}

function isDesktopBackendAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopBackendAvailable()) {
    throw new Error(
      "The desktop backend is not connected. Open Velocity through the desktop app, not a browser tab.",
    );
  }
  return invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// MemoCache: an LRU-bounded cache for in-flight promises that also tracks
// resolved values so callers can read them synchronously via `peek`. This
// eliminates the loading-panel flash when navigating back to a page whose
// data is already cached — the component can render with the cached value
// on its very first paint instead of waiting a microtask for the promise
// to resolve. Errors and "no-cache" results (e.g. empty watch playlists,
// null lyrics) evict the entry so the next request re-invokes the backend.
// ---------------------------------------------------------------------------
type CacheEntry<T> = {
  promise: Promise<T>;
  resolved: boolean;
  value: T | undefined;
  error: unknown | undefined;
  insertedAt: number;
};

class MemoCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs?: number,
  ) {}

  // A cache with a configured TTL evicts resolved entries past the
  // wall-clock window from `insertedAt`. In-flight promises are
  // never TTL'd — only the resolved value ages out. The combination
  // of TTL eviction on read AND inline eviction in `peek` keeps TTL'd
  // caches from ever serving a stale value to the player, while
  // non-TTL'd caches behave exactly as before.
  private isExpired(entry: CacheEntry<T>): boolean {
    if (this.ttlMs === undefined) return false;
    if (!entry.resolved) return false;
    return Date.now() - entry.insertedAt > this.ttlMs;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  // Returns the resolved value if (and only if) the cached promise has
  // settled successfully. Returns null for cache misses, pending promises,
  // rejected promises, AND resolved-but-TTL-expired entries (which we
  // evict inline so the next call re-fetches from the backend). The TTL
  // eviction is critical for caches like `streamCache` whose values are
  // short-lived YouTube URLs that 403 once Google rotates the signature.
  peek(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry || !entry.resolved || entry.error !== undefined) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry.value ?? null;
  }

  isPending(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && !entry.resolved;
  }

  // Returns the cached promise if one exists (touching it for LRU order),
  // otherwise invokes `factory`, stores the resulting promise, and tracks
  // its settlement so `peek` can read the value later.
  //
  // `shouldCache` runs after a successful resolve; returning false evicts
  // the entry (used for "empty result" eviction, e.g. watch playlists with
  // zero tracks). Errors always evict.
  getOrCreate(
    key: string,
    factory: () => Promise<T>,
    shouldCache?: (value: T) => boolean,
  ): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      // LRU touch: re-insert at the most-recently-used position.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }

    const promise = factory();
    // Stamp the entry's creation time so `peek` and `getOrCreate`
    // can confidently age it out by the configured TTL. Using
    // wall-clock time means the TTL window remains accurate even
    // across the page being backgrounded; the entry is also
    // bounded by `maxSize`'s LRU eviction policy.
    const entry: CacheEntry<T> = {
      promise,
      resolved: false,
      value: undefined,
      error: undefined,
      insertedAt: Date.now(),
    };
    promise
      .then((value) => {
        // Only record the value if this entry is still the live one for the
        // key. A stale entry (e.g. after forceRefresh deleted and replaced
        // it) must not back-fill a value onto the new entry.
        if (this.entries.get(key) !== entry) return;
        entry.resolved = true;
        entry.value = value;
        if (shouldCache && !shouldCache(value)) {
          this.entries.delete(key);
        }
      })
      .catch((error) => {
        if (this.entries.get(key) !== entry) return;
        entry.resolved = true;
        entry.error = error;
        // Always evict failures so the next call retries from the backend.
        this.entries.delete(key);
      });

    this.entries.set(key, entry);
    this.evictIfNeeded();
    return promise;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  // Insert an already-resolved value into the cache WITHOUT disturbing
  // an existing entry (whether pending, resolved, or TTL'd). Used by
  // the cross-session lyrics snapshot in `getSyncedLyrics` to seed the
  // in-memory cache from a localStorage hit so subsequent `peek` and
  // `get` calls skip both the disk and the backend. Distinct from
  // `getOrCreate`: `getOrCreate` returns a Promise (and rejoins the
  // in-flight promise on cache hit), whereas `prime` is a fast
  // sync-only path used to install a value we already hold
  // synchronously.
  prime(key: string, value: T): void {
    if (this.entries.has(key)) return;
    const entry: CacheEntry<T> = {
      promise: Promise.resolve(value),
      resolved: true,
      value,
      error: undefined,
      insertedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxSize) return;
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}

const searchCache = new MemoCache<SearchResponse>(100);
const searchSuggestionsCache = new MemoCache<SearchSuggestion[]>(100);
const entityCache = new MemoCache<EntityDetail>(200);
const artistCache = new MemoCache<ArtistDetail>(100);
// Stream URLs and watch playlists are short-lived on YouTube Music
// — the Rust backend's STREAM_CACHE_TTL is 45 min and
// WATCH_PLAYLIST_CACHE_TTL is 30 min. We pass slightly shorter TTLs
// here (25 min / 20 min) so the frontend evicts a cached URL/min
// playlist BEFORE the backend would have invalidated it, keeping
// us from ever serving a 403'd URL or stale playlist response
// to the player.
const streamCache = new MemoCache<StreamResponse>(300, 25 * 60 * 1000);
const watchPlaylistCache = new MemoCache<WatchPlaylistResponse>(50, 20 * 60 * 1000);
// Synced lyrics results include provider metadata that's reasonably
// time-stable; we keep them around for a moderate TTL so the LyricsPage
// doesn't repeatedly fetch across the same listening session. The TTL
// is generous (1 h) because lyrics don't have a hard expiry — it's
// purely a memory bound for long sessions where the user explores many
// tracks.
const syncedLyricsCache = new MemoCache<SyncedLyricsResponse | null>(200, 60 * 60 * 1000);

// Session-scoped lyrics exhaustion. Queue prefetch failures accumulate per
// track; after LYRICS_EXHAUSTION_THRESHOLD misses the active-track paths
// short-circuit to "no lyrics" instead of re-hitting the multi-provider
// backend (and the LyricsPage / PlayerBar loading overlays).
const LYRICS_EXHAUSTION_THRESHOLD = 3;
const lyricsFailureCounts = new Map<string, number>();
const lyricsExhaustedKeys = new Set<string>();

// Cross-session persistence for synced lyrics.
//
// Lyrics are the one piece of "derived info" that costs a noticeable
// fetch latency (multi-provider roundtrip through the Rust backend)
// AND is user-visible on the very first paint of the LyricsPage after
// a cold launch. The in-memory `syncedLyricsCache` above dies with the
// app, so we keep a tiny secondary layer in localStorage: at most one
// snapshot per currently-playing stream track. The snapshot is replaced
// (or evicted) as soon as the user moves on, per the user-facing rule
// "don't bother holding it once the user passes the song".
//
//   * Keyed by `velocity-session-lyrics-${videoId}` so the existing
//     `src/storage.ts::clearAll()` `velocity-` prefix filter sweeps it
//     up when the user hits Settings → Clear all user data — no extra
//     tear-down wiring needed.
//   * Eviction on track change lives in `src/player.tsx` via
//     `evictPersistedLyricsExcept(currentVideoId)`. With a typical
//     session the disk holds exactly one snapshot at any moment.
const PERSISTED_LYRICS_PREFIX = "velocity-session-lyrics-";

function persistedLyricsKey(videoId: string): string {
  return `${PERSISTED_LYRICS_PREFIX}${videoId}`;
}

// Read a JSON-encoded lyrics snapshot from localStorage. Returns null
// on miss OR on any decode failure (corrupt entry, schema drift). The
// caller depends on this being non-throwing because the localStorage
// helper can throw on access-denied in some privacy modes — we never
// want a stale key to crash a render.
function readPersistedLyrics(videoId: string): SyncedLyricsResponse | null {
  try {
    const raw = getItem(persistedLyricsKey(videoId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SyncedLyricsResponse | null | undefined;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lines)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedLyrics(videoId: string, lyrics: SyncedLyricsResponse): void {
  try {
    setItem(persistedLyricsKey(videoId), JSON.stringify(lyrics));
  } catch {
    // localStorage disabled, full, or in a privacy mode. Best-effort only.
  }
}

// Removes every `velocity-session-lyrics-*` key whose `videoId` is not
// the supplied `keepVideoId`. Pass `null` to drop ALL of them (used when
// nothing is currently playing).
//
// IMPORTANT: this goes through `removeItem` from `src/storage.ts`
// (NOT raw `localStorage.removeItem`) so the deletion is mirrored to
// the Rust `data_store` via `invoke("delete_user_data", { key })`.
// Skipping that mirror would leave stale lyrics snapshots in the
// backend's coalesced JSON file, and `src/storage.ts::init()` would
// silently rehydrate them on the next launch via `load_all_user_data`
// — defeating the entire eviction strategy.
//
// Walks `localStorage` from end → start so removals during iteration
// don't shift the indexes the next iteration is about to read; this
// matches the pattern already used in `src/storage.ts::clearAll()`.
export function evictPersistedLyricsExcept(keepVideoId: string | null): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PERSISTED_LYRICS_PREFIX)) continue;
    if (keepVideoId && key === persistedLyricsKey(keepVideoId)) continue;
    try {
      removeItem(key);
    } catch {
      // ignore
    }
  }
}

const artworkCache = new MemoCache<string>(500);
const monthlyListenersCache = new MemoCache<string | null>(200);

export async function getBackendStatus(): Promise<BackendStatus> {
  return invokeCommand<BackendStatus>("get_backend_status");
}

export async function ensureStreamingBackend(): Promise<BackendStatus> {
  return invokeCommand<BackendStatus>("ensure_streaming_backend");
}

export async function searchMusic(
  query: string,
  options: { forceRefresh?: boolean } = {},
): Promise<SearchResponse> {
  const key = query.trim().toLowerCase();
  if (!key) return { query, topResult: null, results: [] };
  if (options.forceRefresh) {
    searchCache.delete(key);
  }
  return searchCache.getOrCreate(key, () =>
    invokeCommand<SearchResponse>("search_music", { query }),
  );
}

// Synchronously returns the cached search result for a query if it has
// already resolved in this session, otherwise null. Lets pages that revisit
// a previously-loaded query render without a loading-promise round-trip.
export function peekSearchMusic(query: string): SearchResponse | null {
  const key = query.trim().toLowerCase();
  if (!key) return { query, topResult: null, results: [] };
  return searchCache.peek(key);
}

export async function fetchSearchSuggestions(query: string): Promise<SearchSuggestion[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  return searchSuggestionsCache.getOrCreate(key, () =>
    invokeCommand<SearchSuggestion[]>("search_suggestions", { query: key }),
  );
}

export async function cacheArtwork(url: string): Promise<string> {
  const key = url.trim();
  if (!key) throw new Error("Artwork URL is empty.");
  return artworkCache.getOrCreate(key, () =>
    invokeCommand<string>("cache_artwork", { url: key }),
  );
}

export async function getEntityDetail(browseId: string): Promise<EntityDetail> {
  return entityCache.getOrCreate(browseId, () =>
    invokeCommand<EntityDetail>("get_entity_detail", { browseId }),
  );
}

// Synchronously returns the cached entity detail if available, else null.
// Used to skip the loading-panel flash on Back/Forward navigation.
export function peekEntityDetail(browseId: string): EntityDetail | null {
  return entityCache.peek(browseId);
}

const ARTIST_DETAIL_TIMEOUT_MS = 25_000;

export async function getArtistDetail(browseId: string): Promise<ArtistDetail> {
  return artistCache.getOrCreate(browseId, () =>
    Promise.race([
      invokeCommand<ArtistDetail>("get_artist_detail", { browseId }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Loading this artist took too long. Try again.")),
          ARTIST_DETAIL_TIMEOUT_MS,
        );
      }),
    ]),
  );
}

export async function getArtistTopSongsExtended(browseId: string): Promise<MediaTrack[]> {
  return invokeCommand<MediaTrack[]>("get_artist_top_songs_extended", { browseId });
}

// Synchronously returns the cached artist detail if available, else null.
// Used to skip the loading-panel flash on Back/Forward navigation.
export function peekArtistDetail(browseId: string): ArtistDetail | null {
  return artistCache.peek(browseId);
}

export function invalidateArtistDetail(browseId: string): void {
  artistCache.delete(browseId);
}

/**
 * Fetches the artist's monthly listener count with a built-in retry loop on the
 * backend. Use this when `getArtistDetail` came back without a `monthlyListeners`
 * value (the immersive header field intermittently comes back empty). The Rust
 * side retries the same `browse` endpoint three times with exponential backoff
 * before giving up. A null return means all attempts came back without listener
 * data, not that the request failed entirely.
 *
 * Null results are NOT cached (via `shouldCache`) so a subsequent visit with a
 * better network/API timing profile still gets to re-try.
 */
export async function getArtistMonthlyListeners(browseId: string): Promise<string | null> {
  return monthlyListenersCache.getOrCreate(
    browseId,
    () => invokeCommand<string | null>("get_artist_monthly_listeners", { browseId }),
    (value) => value !== null,
  );
}

// Synchronous reader for the focused monthly-listener fetch. Used so a Back/Forward
// navigation to an artist whose count was already resolved off-band can render
// without waiting for the promise to settle.
export function peekArtistMonthlyListeners(browseId: string): string | null {
  return monthlyListenersCache.peek(browseId);
}

export async function resolveStream(videoId: string): Promise<StreamResponse> {
  return streamCache.getOrCreate(videoId, () =>
    invokeCommand<StreamResponse>("resolve_stream", { videoId }),
  );
}

/**
 * Drops any cached resolution for a stream so the next request re-invokes the
 * backend. Used by the player on load retries to recover from transient IP/network
 * issues without quarantining a track for the rest of the session.
 */
export function invalidateStream(videoId: string): void {
  streamCache.delete(videoId);
}

export function invalidateWatchPlaylist(videoId: string, playlistId?: string | null): void {
  const trimmedPlaylist = playlistId?.trim();
  watchPlaylistCache.delete(`${videoId}|${trimmedPlaylist ?? ""}`);
}

export async function getWatchPlaylist(
  videoId: string,
  playlistId?: string | null,
): Promise<WatchPlaylistResponse> {
  const trimmedPlaylist = playlistId?.trim();
  const key = `${videoId}|${trimmedPlaylist ?? ""}`;
  // Evict empty results so a later visit re-asks the backend instead of
  // caching a no-tracks response for the rest of the session.
  return watchPlaylistCache.getOrCreate(
    key,
    () =>
      invokeCommand<WatchPlaylistResponse>("get_watch_playlist", {
        videoId,
        playlistId:
          trimmedPlaylist && trimmedPlaylist.length > 0 ? trimmedPlaylist : null,
      }),
    (response) => response.tracks.length > 0,
  );
}

type LyricsPrefetchTrack = Pick<
  MediaTrack,
  | "id"
  | "videoId"
  | "resolvedVideoId"
  | "source"
  | "title"
  | "artist"
  | "album"
  | "durationSeconds"
  | "findLyrics"
>;

function lyricsTrackExhaustionKey(track: LyricsPrefetchTrack): string | null {
  if (track.source === "stream") {
    const identityIds = streamIdentityVideoIds(track);
    if (identityIds.length === 0) return null;
    return `stream:${identityIds.sort().join("\0")}`;
  }
  if (track.source === "upload" && track.findLyrics) {
    return `upload:${track.id}`;
  }
  return null;
}

function recordLyricsFailureForTrack(track: LyricsPrefetchTrack): void {
  const key = lyricsTrackExhaustionKey(track);
  if (!key) return;
  const nextCount = (lyricsFailureCounts.get(key) ?? 0) + 1;
  if (nextCount >= LYRICS_EXHAUSTION_THRESHOLD) {
    lyricsFailureCounts.delete(key);
    lyricsExhaustedKeys.add(key);
    return;
  }
  lyricsFailureCounts.set(key, nextCount);
}

function clearLyricsExhaustionForTrack(track: LyricsPrefetchTrack): void {
  const key = lyricsTrackExhaustionKey(track);
  if (!key) return;
  lyricsFailureCounts.delete(key);
  lyricsExhaustedKeys.delete(key);
}

/** Whether repeated prefetch / fetch attempts have given up on this track. */
export function isLyricsExhaustedForTrack(track: LyricsPrefetchTrack): boolean {
  const key = lyricsTrackExhaustionKey(track);
  return key !== null && lyricsExhaustedKeys.has(key);
}

function syncedLyricsMetaCacheKey(fields: {
  title: string;
  artist: string;
  album?: string | null;
  durationSeconds?: number | null;
}): string {
  return [
    fields.title.trim().toLowerCase(),
    fields.artist.trim().toLowerCase(),
    (fields.album ?? "").trim().toLowerCase(),
    fields.durationSeconds ?? "",
  ].join("\0");
}

export async function getSyncedLyricsByMeta(
  fields: {
    title: string;
    artist: string;
    album?: string | null;
    durationSeconds?: number | null;
    videoId?: string | null;
  },
  options?: { exhaustionTrack?: LyricsPrefetchTrack },
): Promise<SyncedLyricsResponse | null> {
  const exhaustionTrack = options?.exhaustionTrack;
  if (exhaustionTrack && isLyricsExhaustedForTrack(exhaustionTrack)) {
    return null;
  }

  const key = syncedLyricsMetaCacheKey(fields);
  try {
    const result = await syncedLyricsCache.getOrCreate(
      key,
      () =>
        invokeCommand<SyncedLyricsResponse | null>("get_synced_lyrics_by_meta", {
          title: fields.title,
          artist: fields.artist,
          album: fields.album,
          durationSeconds: fields.durationSeconds,
          videoId: fields.videoId ?? null,
        }),
      (r) => r !== null,
    );
    if (exhaustionTrack) {
      if (result === null) {
        // Metadata-only misses must not exhaust stream tracks — the active
        // path still roundtrips through get_synced_lyrics (YTM native).
        if (exhaustionTrack.source === "upload") {
          recordLyricsFailureForTrack(exhaustionTrack);
        }
      } else {
        clearLyricsExhaustionForTrack(exhaustionTrack);
        if (exhaustionTrack.source === "stream") {
          primeSyncedLyricsForTrack(exhaustionTrack, result);
        }
      }
    }
    return result;
  } catch (error) {
    if (exhaustionTrack?.source === "upload") recordLyricsFailureForTrack(exhaustionTrack);
    throw error;
  }
}

export async function getSyncedLyrics(
  videoId: string,
  options?: { persist?: boolean },
): Promise<SyncedLyricsResponse | null> {
  // A null result means no provider had lyrics this time. Evict it via
  // shouldCache so a later visit retries the (multi-provider) fetch instead
  // of caching the miss for the whole session.
  //
  // The order below is in-mem → cross-session localStorage snapshot → backend.
  // The disk layer exists so a cold launch with a restored session can
  // skip the multi-provider roundtrip on first paint (LyricsPage shows it
  // for the first ~10s otherwise). Disk reads here are O(1) on a single
  // key; the in-mem `prime` lets the very next `peek` AND `get` skip
  // both disk AND the backend. See `peekPersistedLyrics` /
  // `evictPersistedLyricsExcept` for the parallel "wipe on track change"
  // half of the contract.
  //
  // Active-track / LyricsPage callers pass `persist: true` and always
  // roundtrip through `get_synced_lyrics` so we pick up YouTube Music's
  // native timed lyrics instead of serving a queue-prefetch snapshot that
  // only went through the metadata providers.
  const persist = options?.persist === true;
  if (!persist) {
    const inMem = syncedLyricsCache.peek(videoId);
    if (inMem !== null) return inMem;

    // Cross-session lift. We deliberately skip writing a snapshot on the
    // read path (the prefix is the only invariant) and rely on the
    // BACKEND branch's `result !== null` write below to (re-)persist.
    // That keeps a stale "no lyrics here" miss out of localStorage —
    // re-runs are cheap, and a stale null could mask a lyrics-availability
    // change after the user toggles providers.
    const persisted = readPersistedLyrics(videoId);
    if (persisted !== null) {
      syncedLyricsCache.prime(videoId, persisted);
      return persisted;
    }
  } else {
    syncedLyricsCache.delete(videoId);
  }

  // Backend roundtrip. `getOrCreate` returns the EXISTING in-flight
  // promise if a prefetch already started (e.g., the queue's next-up
  // prefetch at `src/player.tsx`'s lyrics-prefetch effect), so we
  // never double-fire the backend for the same `videoId` from within
  // the same session.
  const result = await syncedLyricsCache.getOrCreate(
    videoId,
    () => invokeCommand<SyncedLyricsResponse | null>("get_synced_lyrics", { videoId }),
    (r) => r !== null,
  );
  // Persist ONLY when the caller explicitly opted in (active-track
  // paths — LyricsPage, PlayerBar's lyricsAvailable effect). The
  // lyrics-prefetch effect and SearchPage click-to-warmboth leave it
  // off so we never accumulate stale snapshots for tracks the user
  // isn't listening to. Combined with the track-change eviction in
  // `src/player.tsx`, this caps disk usage to the currently-playing
  // track at any moment.
  if (persist && result !== null) {
    writePersistedLyrics(videoId, result);
  }
  return result;
}

export function peekSyncedLyrics(videoId: string): SyncedLyricsResponse | null {
  // Two-layer peek: in-mem cache first, then cross-session localStorage.
  // We deliberately do NOT prime the in-mem cache from here — `peek`
  // is by contract synchronous, so any side-effect of mutating the
  // cache mid-render would be a behavior change for callers that
  // expect `peek` to be a pure reader. The next `getSyncedLyrics`
  // picks the disk entry up via `readPersistedLyrics` and primes then.
  const inMem = syncedLyricsCache.peek(videoId);
  if (inMem !== null) return inMem;
  return readPersistedLyrics(videoId);
}

/**
 * Lift cross-session lyrics into the in-mem cache for instant first paint.
 * Safe to call during boot or in effects — not during render.
 */
export function hydratePersistedLyricsForTrack(
  track: Pick<
    MediaTrack,
    | "id"
    | "videoId"
    | "resolvedVideoId"
    | "source"
    | "title"
    | "artist"
    | "album"
    | "durationSeconds"
  >,
): SyncedLyricsResponse | null {
  for (const videoId of streamIdentityVideoIds(track)) {
    const inMem = syncedLyricsCache.peek(videoId);
    if (inMem !== null) return inMem;
    const persisted = readPersistedLyrics(videoId);
    if (persisted !== null) {
      syncedLyricsCache.prime(videoId, persisted);
      return persisted;
    }
  }
  const metaCached = peekSyncedLyricsByMetaForTrack(track);
  if (metaCached !== null && track.source === "stream") {
    primeSyncedLyricsForTrack(track, metaCached);
    return metaCached;
  }
  return null;
}

/** Mirror in-mem lyrics for the active stream track to the cross-session snapshot. */
export function persistCachedLyricsForTrack(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): void {
  if (track.source !== "stream") return;
  const canonicalId = lyricsCacheVideoId(track);
  if (!canonicalId) return;
  for (const videoId of streamIdentityVideoIds(track)) {
    const inMem = syncedLyricsCache.peek(videoId);
    if (inMem !== null) {
      writePersistedLyrics(canonicalId, inMem);
      return;
    }
  }
}

/** Canonical video id for lyrics cache keys — matches stream resolution. */
export function lyricsCacheVideoId(
  track: Pick<MediaTrack, "videoId" | "resolvedVideoId" | "source">,
): string | null {
  if (track.source !== "stream") return null;
  return track.resolvedVideoId ?? track.videoId ?? null;
}

/** Peek every stream identity id so prefetch under `resolvedVideoId` still hits. */
export function peekSyncedLyricsForTrack(
  track: Pick<
    MediaTrack,
    | "id"
    | "videoId"
    | "resolvedVideoId"
    | "source"
    | "title"
    | "artist"
    | "album"
    | "durationSeconds"
  >,
): SyncedLyricsResponse | null {
  for (const videoId of streamIdentityVideoIds(track)) {
    const cached = peekSyncedLyrics(videoId);
    if (cached !== null) return cached;
  }
  return peekSyncedLyricsByMetaForTrack(track);
}

export function isSyncedLyricsPending(videoId: string): boolean {
  return syncedLyricsCache.isPending(videoId);
}

export function isSyncedLyricsPendingForTrack(
  track: Pick<
    MediaTrack,
    | "id"
    | "videoId"
    | "resolvedVideoId"
    | "source"
    | "title"
    | "artist"
    | "album"
    | "durationSeconds"
  >,
): boolean {
  if (streamIdentityVideoIds(track).some((videoId) => isSyncedLyricsPending(videoId))) {
    return true;
  }
  return isSyncedLyricsMetaPendingForTrack(track);
}

function hasLyricsPrefetchMeta(
  track: Pick<MediaTrack, "title" | "artist">,
): boolean {
  return Boolean(track.title.trim() && track.artist.trim());
}

function lyricsPrefetchMetaFields(
  track: Pick<MediaTrack, "title" | "artist" | "album" | "durationSeconds" | "videoId" | "resolvedVideoId" | "source">,
) {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSeconds: track.durationSeconds,
    videoId: track.source === "stream" ? (track.resolvedVideoId ?? track.videoId ?? null) : null,
  };
}

function peekSyncedLyricsByMetaForTrack(
  track: Pick<
    MediaTrack,
    "source" | "title" | "artist" | "album" | "durationSeconds" | "videoId" | "resolvedVideoId"
  >,
): SyncedLyricsResponse | null {
  if (!hasLyricsPrefetchMeta(track)) return null;
  const metaFields = lyricsPrefetchMetaFields(track);
  const metaKey = syncedLyricsMetaCacheKey(metaFields);
  return syncedLyricsCache.peek(metaKey);
}

function isSyncedLyricsMetaPendingForTrack(
  track: Pick<
    MediaTrack,
    "source" | "title" | "artist" | "album" | "durationSeconds" | "videoId" | "resolvedVideoId"
  >,
): boolean {
  if (!hasLyricsPrefetchMeta(track)) return false;
  const metaFields = lyricsPrefetchMetaFields(track);
  const metaKey = syncedLyricsMetaCacheKey(metaFields);
  return syncedLyricsCache.isPending(metaKey);
}

/** Install a lyrics payload under every stream identity id for the track. */
function primeSyncedLyricsForTrack(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
  result: SyncedLyricsResponse,
): void {
  for (const videoId of streamIdentityVideoIds(track)) {
    syncedLyricsCache.prime(videoId, result);
  }
}

/**
 * Best-effort queue prefetch for synced lyrics. Stream tracks with title +
 * artist warm the metadata-provider cache only. The active track's
 * LyricsPage fetch uses `get_synced_lyrics` (incl. YouTube Music native
 * timed lyrics) and bypasses these prefetch snapshots.
 */
export function prefetchSyncedLyricsForTrack(track: LyricsPrefetchTrack): void {
  if (isLyricsExhaustedForTrack(track)) return;
  if (peekSyncedLyricsForTrack(track)) return;
  if (isSyncedLyricsPendingForTrack(track)) return;

  if (track.source === "stream") {
    const identityIds = streamIdentityVideoIds(track);
    if (identityIds.length === 0) return;

    if (hasLyricsPrefetchMeta(track)) {
      const metaFields = lyricsPrefetchMetaFields(track);
      const metaKey = syncedLyricsMetaCacheKey(metaFields);
      if (syncedLyricsCache.isPending(metaKey)) return;
      void getSyncedLyricsByMeta(metaFields, { exhaustionTrack: track });
      return;
    }

    const videoId = lyricsCacheVideoId(track) ?? identityIds[0];
    if (videoId) {
      void getSyncedLyrics(videoId)
        .then((result) => {
          if (result === null) recordLyricsFailureForTrack(track);
          else clearLyricsExhaustionForTrack(track);
        })
        .catch(() => {
          recordLyricsFailureForTrack(track);
        });
    }
    return;
  }

  if (track.source === "upload" && track.findLyrics && hasLyricsPrefetchMeta(track)) {
    const metaFields = lyricsPrefetchMetaFields(track);
    const metaKey = syncedLyricsMetaCacheKey(metaFields);
    if (syncedLyricsCache.isPending(metaKey)) return;
    void getSyncedLyricsByMeta(metaFields, { exhaustionTrack: track });
  }
}

async function fetchSyncedLyricsForStreamTrack(
  track: LyricsPrefetchTrack,
  options?: { persist?: boolean },
): Promise<SyncedLyricsResponse | null> {
  // Rejoin a queue prefetch that keyed the in-flight promise under a
  // sibling identity id (e.g. the pre-resolve `videoId` while the active
  // path prefers `resolvedVideoId`).
  for (const videoId of streamIdentityVideoIds(track)) {
    if (isSyncedLyricsPending(videoId)) {
      try {
        const result = await getSyncedLyrics(videoId, options);
        if (result === null) recordLyricsFailureForTrack(track);
        else clearLyricsExhaustionForTrack(track);
        return result;
      } catch (error) {
        recordLyricsFailureForTrack(track);
        throw error;
      }
    }
  }

  if (hasLyricsPrefetchMeta(track)) {
    const metaFields = lyricsPrefetchMetaFields(track);
    const metaKey = syncedLyricsMetaCacheKey(metaFields);
    if (syncedLyricsCache.isPending(metaKey)) {
      try {
        const result = await getSyncedLyricsByMeta(metaFields, { exhaustionTrack: track });
        if (options?.persist) {
          // Active-track callers still roundtrip through get_synced_lyrics.
        } else if (result !== null) {
          return result;
        }
      } catch (error) {
        if (!options?.persist) throw error;
      }
    } else if (!options?.persist) {
      const metaCached = syncedLyricsCache.peek(metaKey);
      if (metaCached !== null) {
        primeSyncedLyricsForTrack(track, metaCached);
        return metaCached;
      }
    }
  }

  const videoId = lyricsCacheVideoId(track);
  if (!videoId) return null;
  try {
    const result = await getSyncedLyrics(videoId, options);
    if (result === null) recordLyricsFailureForTrack(track);
    else clearLyricsExhaustionForTrack(track);
    return result;
  } catch (error) {
    recordLyricsFailureForTrack(track);
    throw error;
  }
}

export async function getSyncedLyricsForTrack(
  track: LyricsPrefetchTrack,
  options?: { persist?: boolean },
): Promise<SyncedLyricsResponse | null> {
  if (!options?.persist) {
    const cached = hydratePersistedLyricsForTrack(track);
    if (cached !== null) return cached;
  }

  if (isLyricsExhaustedForTrack(track)) return null;

  return fetchSyncedLyricsForStreamTrack(track, options);
}

export async function resolveTrackAlbum(videoId: string): Promise<TrackAlbumResolution> {
  return invokeCommand<TrackAlbumResolution>("resolve_track_album", { videoId });
}

export async function getTrackDuration(videoId: string): Promise<number | null> {
  return invokeCommand<number | null>("get_track_duration", { videoId });
}

export async function listImportedTracks(): Promise<MediaTrack[]> {
  return invokeCommand<MediaTrack[]>("list_imported_tracks");
}

/** Restore stripped upload playback fields after context-menu serialization. */
export async function hydrateUploadTrackForPlayback(track: MediaTrack): Promise<MediaTrack> {
  if (track.source !== "upload") return track;
  if (track.filePath) return withResolvedAudioSrc(track);
  try {
    const tracks = await listImportedTracks();
    const match = tracks.find((row) => row.id === track.id);
    return withResolvedAudioSrc(match ?? track);
  } catch {
    return withResolvedAudioSrc(track);
  }
}

export async function extractFileMetadata(
  bytes: number[],
  name: string,
): Promise<ExtractedMetadata> {
  return invokeCommand<ExtractedMetadata>("extract_file_metadata", { bytes, name });
}

export async function importTracks(
  tracks: Array<{ name: string; bytes: number[]; coverBytes?: number[] }>,
): Promise<MediaTrack[]> {
  return invokeCommand<MediaTrack[]>("import_tracks", { tracks });
}

export async function updateImportedTrackMetadata(
  trackId: string,
  fields: {
    title?: string;
    artist?: string;
    album?: string;
    durationSeconds?: number | null;
    coverBytes?: number[];
    findLyrics?: boolean;
  },
): Promise<MediaTrack> {
  return invokeCommand<MediaTrack>("update_imported_track_metadata", {
    trackId,
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    durationSeconds: fields.durationSeconds,
    coverBytes: fields.coverBytes,
    findLyrics: fields.findLyrics,
  });
}

export async function removeImportedTrack(trackId: string): Promise<void> {
  await invokeCommand("remove_imported_track", { trackId });
}

export async function analyzeLoudness(filePath: string): Promise<LoudnessData> {
  return invokeCommand<LoudnessData>("analyze_loudness", { filePath });
}

export async function analyzeLoudnessChunk(
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<LoudnessData> {
  return invokeCommand<LoudnessData>("analyze_loudness_chunk", {
    filePath,
    startSeconds,
    durationSeconds,
  });
}

export async function detectLeadingSilence(filePath: string): Promise<LeadingSilenceData> {
  return invokeCommand<LeadingSilenceData>("detect_leading_silence", { filePath });
}

export async function saveOffline(videoId: string): Promise<void> {
  await invokeCommand("save_offline", { videoId });
}

export async function removeOffline(videoId: string): Promise<void> {
  await invokeCommand("remove_offline", { videoId });
}

export async function listOfflineSongs(): Promise<string[]> {
  return invokeCommand<string[]>("list_offline");
}

export async function clearAllOffline(): Promise<void> {
  await invokeCommand("clear_all_offline");
}

export async function getOfflinePath(videoId: string): Promise<string | null> {
  return invokeCommand<string | null>("get_offline_path", { videoId });
}

/** Offline files are keyed by videoId — try every identity id on the track. */
export async function getOfflinePathForTrack(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): Promise<string | null> {
  for (const videoId of streamIdentityVideoIds(track)) {
    const path = await getOfflinePath(videoId);
    if (path) return path;
  }
  return null;
}

/**
 * Primary + alternate video ids for a "Save to my device" export.
 * Synchronous — the Rust export path already walks cached audio and
 * every fallback id through yt-dlp, so blocking on YT Music search here
 * only left the Saving panel spinning with no backend work in flight.
 */
export function deviceExportVideoIds(
  track: MediaTrack,
): { videoId: string; fallbackVideoIds: string[] } {
  const videoId = exportStreamVideoId(track);
  if (!videoId) {
    throw new Error("This track has no streamable audio to export.");
  }
  const fallbackVideoIds = streamIdentityVideoIds(track).filter((id) => id !== videoId);
  return { videoId, fallbackVideoIds };
}

// ── Save to my device (right-click "Save to my device" export) ───────────
//
// The right-click context menu lets the user export a single track or an
// entire album to a user-chosen folder as MP3 + ID3-tagged files. The
// pipeline:
//
//   1. Frontend opens a native folder/file picker (`@tauri-apps/plugin-dialog`).
//   2. Frontend hands the picked path + track metadata to one of these
//      two Tauri commands.
//   3. The Rust side downloads the audio via yt-dlp, converts to MP3
//      through ffmpeg, embeds ID3 tags + cover art via `lofty`, and
//      lands the file at the user-chosen path.
//
// Splitting the two endpoints keeps the single-track case responsive
// (songs can land on disk in a few seconds) while the album case can run
// for tens of seconds without forcing the user to wait for an in-flight
// Promise to be polled — the React layer just awaits the album command
// and surfaces a single toast on completion.
export type SaveTrackToMp3Request = {
  /**
   * Opaque id the frontend mints for this export. The backend uses
   * it to register a cancellation token; the same id is fed to
   * `cancelSaveExport` if the user clicks Cancel mid-export. Empty
   * string disables cancellation (kept for symmetry with the
   * backend, which is a no-op when the id is empty).
   */
  requestId?: string;
  videoId: string;
  /** Alternate ids for cached-audio lookup and yt-dlp retries. */
  fallbackVideoIds?: string[];
  title: string;
  artist: string;
  album?: string | null;
  trackNumber?: number | null;
  trackTotal?: number | null;
  year?: number | null;
  coverUrl?: string | null;
  /** Absolute path to the folder the user picked. */
  targetDir: string;
  /** File name WITHOUT `.mp3` extension. Frontend sanitizes for FS safety. */
  fileName: string;
};

export type SaveAlbumTrackEntry = {
  videoId: string;
  fallbackVideoIds?: string[];
  title: string;
  artist: string;
  trackNumber?: number | null;
  fileName: string;
};

export type SaveAlbumToMp3Request = {
  /**
   * Opaque id, see `SaveTrackToMp3Request::requestId`. Wired up to
   * `cancelSaveExport` so the user can abort a multi-track album
   * download midway through. Backend no-ops when empty.
   */
  requestId?: string;
  albumName: string;
  /** Parent folder picked by the user. The album subfolder is created inside. */
  targetDir: string;
  albumArtist?: string | null;
  year?: number | null;
  coverUrl?: string | null;
  tracks: SaveAlbumTrackEntry[];
};

export type SaveAlbumResult = {
  albumDir: string;
  filePaths: string[];
};

export async function saveTrackToMp3(
  request: SaveTrackToMp3Request,
): Promise<string> {
  return invokeCommand<string>("save_track_to_mp3", { request });
}

export async function saveAlbumToMp3(
  request: SaveAlbumToMp3Request,
): Promise<SaveAlbumResult> {
  return invokeCommand<SaveAlbumResult>("save_album_to_mp3", { request });
}

// ── Save playlist to my device (right-click "Save to my device") ──────────
//
// Mirrors the album export but with per-track metadata: each track
// keeps its own `TALB` (album) and `TPE1` (artist), and the cover
// comes from the track's own artwork with a fallback to the playlist's
// user-uploaded cover. The folder name is the playlist title (sanitized
// by the backend).
export type SavePlaylistTrackEntry = {
  videoId: string;
  fallbackVideoIds?: string[];
  title: string;
  artist: string;
  /**
   * Per-track album. Stamped on the file as the ID3 `TALB` frame
   * so the resulting file round-trips through any standard player
   * as the song it actually is.
   */
  album?: string | null;
  /**
   * 1-based position in the playlist. Stamped as `TRCK` along with
   * the total track count so the resulting files sort coherently
   * when grouped by album.
   */
  trackNumber?: number | null;
  /**
   * Per-track cover (http URL or data URL). When `None`, the
   * playlist-level cover (if any) is used as a fallback. Tracks
   * with neither end up without an `APIC` frame.
   */
  coverUrl?: string | null;
  /**
   * File name WITHOUT `.mp3` extension. Frontend sanitizes for FS
   * safety; the backend re-sanitizes as defense in depth.
   */
  fileName: string;
};

export type SavePlaylistToMp3Request = {
  /**
   * Opaque id, see `SaveTrackToMp3Request::requestId`. Wired up to
   * `cancelSaveExport` so the user can abort a multi-track playlist
   * download midway through. Backend no-ops when empty.
   */
  requestId?: string;
  playlistName: string;
  /** Parent folder picked by the user. The playlist subfolder is created inside. */
  targetDir: string;
  /**
   * Playlist-level cover. Accepts an http(s) URL OR a `data:image/...;base64,…`
   * data URL (the latter is what `UserPlaylistsPage` stores when the user
   * uploads their own cover). Used as a fallback for tracks that don't
   * carry their own.
   */
  coverUrl?: string | null;
  tracks: SavePlaylistTrackEntry[];
};

export type SavePlaylistResult = {
  playlistDir: string;
  filePaths: string[];
  /**
   * Number of tracks that were skipped (e.g. local uploads with no
   * `videoId`). Surfaced so the UI can show "Saved N of M" instead of
   * just the success path.
   */
  skipped: number;
};

export async function savePlaylistToMp3(
  request: SavePlaylistToMp3Request,
): Promise<SavePlaylistResult> {
  return invokeCommand<SavePlaylistResult>("save_playlist_to_mp3", { request });
}

/**
 * Signal the backend to abort an in-flight "Save to my device" export.
 *
 * The export command looks up `requestId` in its cancellation
 * registry and signals the corresponding oneshot; the command's
 * `tokio::select!` resolves the race at its next checkpoint (the
 * in-flight yt-dlp call always finishes first, since we can't kill
 * the subprocess mid-flight, but the NEXT step — tag writing, file
 * move, or the next track — never starts).
 *
 * If the id isn't in the registry (the export already finished, or
 * the user just hit Cancel on something that had already completed),
 * the call is a silent no-op. Safe to fire and forget.
 */
export async function cancelSaveExport(requestId: string): Promise<void> {
  return invokeCommand<void>("cancel_save_export", { requestId });
}

/**
 * Mint a fresh request id for a "Save to my device" export.
 *
 * We don't need cryptographic uniqueness — a request id just needs
 * to be unique per *active* export so two consecutive Cancel clicks
 * on the same menu don't stomp each other. A timestamp + a small
 * random suffix is more than enough to avoid collisions even if the
 * user mashes the button.
 */
export function makeSaveExportRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── External playlist import ─────────────────────────────────────────────
//
// yt-dlp can lift track + playlist metadata from public YouTube Music,
// Spotify, and Apple Music playlists. The Rust side shells out to it and
// returns everything the frontend needs to (a) match each track against
// YouTube Music search results, (b) download the cover image into the
// artwork cache, and (c) save the matched tracks into a new user playlist.
//
// `service` is one of "youtube" | "spotify" | "apple" so the UI can show
// a badge for the source the user pasted.
export type ExternalPlaylistService = "youtube" | "spotify" | "apple";

export type ExternalPlaylistTrack = {
  title: string;
  artist: string;
  album?: string | null;
  durationSeconds?: number | null;
};

export type ExternalPlaylistImport = {
  service: ExternalPlaylistService;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  tracks: ExternalPlaylistTrack[];
};

const EXTERNAL_PLAYLIST_IMPORT_TIMEOUT_MS = 130_000;

export async function importExternalPlaylist(url: string): Promise<ExternalPlaylistImport> {
  return Promise.race([
    invokeCommand<ExternalPlaylistImport>("import_external_playlist", { request: { url } }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              "Playlist import timed out. Large playlists can take a minute — wait a moment and try again.",
            ),
          ),
        EXTERNAL_PLAYLIST_IMPORT_TIMEOUT_MS,
      );
    }),
  ]);
}

export type DiscordPresencePayload = {
  enabled: boolean;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  state?: string | null;
  coverUrl?: string | null;
  videoId?: string | null;
  /** Paused or buffering — backend clears the progress bar. */
  paused?: boolean;
  /** Unix milliseconds: when playback effectively started (now − elapsed). */
  startedAt?: number | null;
  /** Unix milliseconds: when the track ends (startedAt + duration). */
  endsAt?: number | null;
  /** Monotonic sync id — stale async invokes are ignored by the Rust worker. */
  generation?: number;
};

export async function syncDiscordPresence(payload: DiscordPresencePayload): Promise<boolean> {
  return invokeCommand<boolean>("sync_discord_presence", { payload });
}
