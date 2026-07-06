import { invoke } from "@tauri-apps/api/core";
import type {
  ArtistDetail,
  BackendStatus,
  EntityDetail,
  ExtractedMetadata,
  LoudnessData,
  MediaTrack,
  SearchResponse,
  SyncedLyricsResponse,
  StreamResponse,
  TrackAlbumResolution,
  WatchPlaylistResponse,
} from "./types";

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
};

class MemoCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxSize: number) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  // Returns the resolved value if (and only if) the cached promise has
  // settled successfully. Returns null for cache misses, pending promises,
  // and rejected promises so callers can fall back to a loading state.
  peek(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry || !entry.resolved || entry.error !== undefined) return null;
    return entry.value ?? null;
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
    const entry: CacheEntry<T> = { promise, resolved: false, value: undefined, error: undefined };
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

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxSize) return;
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}

const searchCache = new MemoCache<SearchResponse>(100);
const entityCache = new MemoCache<EntityDetail>(200);
const artistCache = new MemoCache<ArtistDetail>(100);
const streamCache = new MemoCache<StreamResponse>(300);
const watchPlaylistCache = new MemoCache<WatchPlaylistResponse>(50);
const syncedLyricsCache = new MemoCache<SyncedLyricsResponse | null>(200);
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

export async function getArtistDetail(browseId: string): Promise<ArtistDetail> {
  return artistCache.getOrCreate(browseId, () =>
    invokeCommand<ArtistDetail>("get_artist_detail", { browseId }),
  );
}

// Synchronously returns the cached artist detail if available, else null.
// Used to skip the loading-panel flash on Back/Forward navigation.
export function peekArtistDetail(browseId: string): ArtistDetail | null {
  return artistCache.peek(browseId);
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

export async function getSyncedLyricsByMeta(fields: {
  title: string;
  artist: string;
  album?: string | null;
  durationSeconds?: number | null;
}): Promise<SyncedLyricsResponse | null> {
  return invokeCommand<SyncedLyricsResponse | null>("get_synced_lyrics_by_meta", {
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    durationSeconds: fields.durationSeconds,
  });
}

export async function getSyncedLyrics(videoId: string): Promise<SyncedLyricsResponse | null> {
  // A null result means no provider had lyrics this time. Evict it via
  // shouldCache so a later visit retries the (multi-provider) fetch instead
  // of caching the miss for the whole session.
  return syncedLyricsCache.getOrCreate(
    videoId,
    () => invokeCommand<SyncedLyricsResponse | null>("get_synced_lyrics", { videoId }),
    (result) => result !== null,
  );
}

export function peekSyncedLyrics(videoId: string): SyncedLyricsResponse | null {
  return syncedLyricsCache.peek(videoId);
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

export async function importExternalPlaylist(url: string): Promise<ExternalPlaylistImport> {
  return invokeCommand<ExternalPlaylistImport>("import_external_playlist", { request: { url } });
}
