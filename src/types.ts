export type SearchItemKind = "song" | "album" | "artist" | "playlist" | "video";

export type ArtistCredit = {
  name: string;
  browseId: string;
};

export type SearchItem = {
  id: string;
  kind: SearchItemKind;
  title: string;
  subtitle: string;
  cover?: string | null;
  browseId?: string | null;
  videoId?: string | null;
  durationSeconds?: number | null;
  playCount?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: string | null;
  albumBrowseId?: string | null;
  artistBrowseId?: string | null;
  artistCredits?: ArtistCredit[] | null;
};

export type SearchResponse = {
  query: string;
  topResult?: SearchItem | null;
  results: SearchItem[];
};

export type SearchSuggestion = {
  text: string;
  fromHistory: boolean;
};

export type QueueOrigin =
  | { kind: "artist"; browseId: string; name?: string }
  | { kind: "album"; browseId: string; name?: string }
  | { kind: "playlist"; browseId: string; name?: string }
  | { kind: "user-playlist"; id: string; name?: string };

export type MediaTrack = {
  id: string;
  /**
   * The YouTube Music track kind when the source page identified one
   * (`"song"`, `"video"`, ...). Drives autoplay filtering/substitution;
   * `undefined` for uploaded tracks.
   */
  kind?: "song" | "video" | string | null;
  title: string;
  artist: string;
  album?: string | null;
  albumBrowseId?: string | null;
  artistBrowseId?: string | null;
  artistCredits?: ArtistCredit[] | null;
  durationSeconds?: number | null;
  playCount?: string | null;
  cover?: string | null;
  /** On-disk cover path for uploads, preserved before `convertFileSrc`. */
  coverFilePath?: string | null;
  videoId?: string | null;
  /**
   * The canonical audio-only Topic-upload videoId, set by
   * `resolveTrackAudio` when a search finds a different (audio-only)
   * videoId for a track whose `videoId` points at a music video.
   *
   * Crucially, `videoId` and `id` are NOT changed — they preserve the
   * track's release-scoped id so list rows keep a stable row identity.
   * Play-button active-state checks (`isSameSongTrack`, `isItemPlaying`)
   * match by underlying video id across search, album, playlist, and
   * artist views. The load effect and prefetch logic use
   * `resolvedVideoId ?? videoId` for actual stream resolution.
   */
  resolvedVideoId?: string | null;
  source: "stream" | "upload";
  audioSrc?: string | null;
  filePath?: string | null;
  findLyrics?: boolean;
  /**
   * Set by `appendToQueue` when the track is added via a context-menu
   * origin (e.g. an album). Used by QueuePanel to render section
   * headers ("Next from [Album]") and to keep individually-queued
   * tracks under "Up next".
   */
  _labelOrigin?: QueueOrigin | null;
  /**
   * Epoch ms timestamp set when the track is added to a user playlist.
   * Only meaningful in the context of `UserPlaylist.tracks`.
   */
  dateAdded?: number;
};

export type EntityDetail = {
  kind: "album" | "playlist";
  browseId: string;
  title: string;
  subtitle: string;
  description?: string | null;
  cover?: string | null;
  byline?: string | null;
  meta?: string | null;
  tracks: MediaTrack[];
};

export type ArtistShelf = {
  title: string;
  items: SearchItem[];
};

export type ArtistDetail = {
  browseId: string;
  title: string;
  description?: string | null;
  cover?: string | null;
  banner?: string | null;
  monthlyListeners?: string | null;
  topSongs: MediaTrack[];
  /** True when YT Music signals more top tracks exist beyond the first page. */
  topSongsHasMore?: boolean;
  shelves: ArtistShelf[];
};

export type StreamResponse = {
  url?: string | null;
  filePath?: string | null;
};

export type WatchPlaylistResponse = {
  tracks: MediaTrack[];
  playlistId?: string | null;
};

export type TrackAlbumResolution = {
  albumBrowseId?: string | null;
  album?: string | null;
  artistBrowseId?: string | null;
};

export type LoudnessData = {
  integratedLufs: number | null;
  truePeak: number | null;
  loudnessRange?: number | null;
  threshold?: number | null;
  targetOffset?: number | null;
  analysisVersion?: number | null;
};

export type LeadingSilenceData = {
  skipSeconds: number | null;
  analysisVersion?: number | null;
};

export type TimedLyricWord = {
  text: string;
  startTimeMs: number;
  endTimeMs: number;
};

export type TimedLyricLine = {
  id: number;
  text: string;
  startTimeMs: number;
  endTimeMs?: number | null;
  words?: TimedLyricWord[];
};

export type SyncedLyricsResponse = {
  lines: TimedLyricLine[];
  source?: string | null;
  hasPerWordSync?: boolean;
};

export type BackendStatus = {
  ytDlpReady: boolean;
  ytDlpPath?: string | null;
  ytDlpVersion?: string | null;
};

export type ExtractedMetadata = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
  coverBytes?: number[] | null;
};
