// Hide the Windows console window for release builds so launching
// the app never produces an extra terminal/cmd window on top of the
// GUI. The attribute is gated on not(debug_assertions) so debug
// builds (cargo tauri dev, plain cargo run) still get a console
// for development logging; only shipped installer builds suppress it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

mod data_store;
mod discord_cover_publish;
mod discord_presence;
mod lyrics;
mod text_utils;
mod window_drag;

use base64::Engine;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::id3::v2::{Frame, FrameId, Id3v2Tag, TextInformationFrame};
use lofty::mpeg::MpegFile;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::Accessor;
use lofty::probe::Probe;
use lofty::TextEncoding;
use once_cell::sync::Lazy;

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_LANGUAGE, CONTENT_TYPE, ORIGIN, REFERER};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::{
    process::Command,
    sync::{oneshot, Mutex},
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const YT_DLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/// Static Windows ffmpeg/ffprobe pair used by yt-dlp's MP3 postprocessor.
/// Playback only needs yt-dlp; exports also need this bundle.
#[cfg(target_os = "windows")]
const FFMPEG_WIN_ZIP_URL: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const CLIENT_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 6);
const STREAM_CACHE_TTL: Duration = Duration::from_secs(60 * 45);
/// Per-invocation bound for yt-dlp audio fetches (offline save + export).
/// Without this, a rate-limited or wedged child process left the Saving
/// panel spinning indefinitely with no error to dismiss.
const YT_DLP_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const WATCH_PLAYLIST_CACHE_TTL: Duration = Duration::from_secs(60 * 30);
const TRACK_DURATION_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 7);
const PREFERRED_THUMBNAIL_WIDTH: u64 = 640;
const ARTIST_AVATAR_SIZE: u64 = 640;
const ARTIST_BANNER_WIDTH: u64 = 2880;
const ARTIST_BANNER_HEIGHT: u64 = 1200;
const MAX_CACHED_ARTWORK_BYTES: usize = 8 * 1024 * 1024;
const ARTIST_TOP_SONG_LIMIT: usize = 10;
// Imported playlists may be arbitrarily long; paginate until the shelf
// runs out or we hit a generous safety bound.
const PLAYLIST_IMPORT_TRACK_LIMIT: usize = 10_000;
// Spotify's public embed page inlines at most this many tracks per fetch.
const SPOTIFY_EMBED_TRACK_PAGE_CAP: usize = 100;
const ARTIST_MONTHLY_LISTENERS_MAX_ATTEMPTS: u32 = 3;
// Exponential-ish backoff (in milliseconds) between focused retry attempts.
// The Rust side handles the retry loop so each retry hits YouTube Music with
// a fresh API request — the `monthlyListenerCount` field is intermittently
// absent from a single response, so a retry with a different timing profile
// is more reliable than re-parsing the cached payload.
const ARTIST_MONTHLY_LISTENERS_RETRY_BACKOFF_MS: [u64; 2] = [250, 750];

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
});

static HTTP_NO_REDIRECT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client no-redirect")
});

static API_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""INNERTUBE_API_KEY":"([^"]+)""#).expect("api key regex"));
static CLIENT_VERSION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#""INNERTUBE_CLIENT_VERSION":"([^"]+)""#).expect("client version regex")
});
static VISITOR_DATA_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""VISITOR_DATA":"([^"]+)""#).expect("visitor data regex"));

// Extract the `list` query parameter from a YT Music playlist URL. Used
// to seed the InnerTube `next` call (which needs both a videoId and a
// playlistId to return the full queue) and to build the browseId for the
// playlist header (browseId = "VL" + playlistId).
static YT_PLAYLIST_ID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"[?&]list=([A-Za-z0-9_-]+)"#).expect("yt playlist id regex")
});



#[derive(Default)]
struct AppState {
    client_config: Mutex<Option<InnerTubeConfig>>,
    stream_cache: Mutex<HashMap<String, CachedStream>>,
    watch_playlist_cache: Mutex<HashMap<String, CachedWatchPlaylist>>,
    track_duration_cache: Mutex<HashMap<String, CachedTrackDuration>>,
    import_library: Mutex<()>,
    musixmatch_token: Mutex<Option<lyrics::MusixmatchTokenCache>>,
    /// Active "Save to my device" exports, keyed by the frontend's
    /// `request_id`. When the user clicks Cancel the frontend fires
    /// `cancel_save_export(request_id)`, which pulls the sender out
    /// of this map and signals the in-flight save command to abort
    /// at the next checkpoint. Entries are removed on completion so
    /// a stale id from a previous session can never be canceled.
    active_save_exports: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

struct InnerTubeConfig {
    api_key: String,
    client_version: String,
    visitor_data: String,
    fetched_at: Instant,
}
pub(crate) struct CachedStream {
    source: String,
    fetched_at: Instant,
}

struct CachedWatchPlaylist {
    tracks: Vec<MediaTrack>,
    playlist_id: Option<String>,
    fetched_at: Instant,
}

struct CachedTrackDuration {
    duration: Option<u32>,
    fetched_at: Instant,
}

type SyncedLyricsResponse = lyrics::SyncedLyricsResponse;
type LyricTrack = lyrics::LyricTrack;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistCredit {
    name: String,
    browse_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchItem {
    id: String,
    kind: String,
    title: String,
    subtitle: String,
    cover: Option<String>,
    browse_id: Option<String>,
    video_id: Option<String>,
    duration_seconds: Option<u32>,
    play_count: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    year: Option<String>,
    album_browse_id: Option<String>,
    artist_browse_id: Option<String>,
    artist_credits: Option<Vec<ArtistCredit>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    query: String,
    top_result: Option<SearchItem>,
    results: Vec<SearchItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSuggestion {
    text: String,
    from_history: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTrack {
    id: String,
    /// The YouTube Music track kind when the source page identifies one
    /// (`"song"`, `"video"`, `"episode"`, ...). `None` for uploads where the
    /// classification isn't applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    album_browse_id: Option<String>,
    artist_browse_id: Option<String>,
    artist_credits: Option<Vec<ArtistCredit>>,
    duration_seconds: Option<u32>,
    play_count: Option<String>,
    cover: Option<String>,
    video_id: Option<String>,
    source: &'static str,
    audio_src: Option<String>,
    file_path: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    find_lyrics: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntityDetail {
    kind: String,
    browse_id: String,
    title: String,
    subtitle: String,
    description: Option<String>,
    cover: Option<String>,
    byline: Option<String>,
    meta: Option<String>,
    tracks: Vec<MediaTrack>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistShelf {
    title: String,
    items: Vec<SearchItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistDetail {
    browse_id: String,
    title: String,
    description: Option<String>,
    cover: Option<String>,
    banner: Option<String>,
    monthly_listeners: Option<String>,
    top_songs: Vec<MediaTrack>,
    #[serde(default, skip_serializing_if = "is_false")]
    top_songs_has_more: bool,
    shelves: Vec<ArtistShelf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamResponse {
    url: Option<String>,
    file_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchPlaylistResponse {
    tracks: Vec<MediaTrack>,
    playlist_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackAlbumResolution {
    album_browse_id: Option<String>,
    album: Option<String>,
    artist_browse_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStatus {
    yt_dlp_ready: bool,
    yt_dlp_path: Option<String>,
    yt_dlp_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudnessData {
    integrated_lufs: Option<f64>,
    true_peak: Option<f64>,
    loudness_range: Option<f64>,
    threshold: Option<f64>,
    target_offset: Option<f64>,
    analysis_version: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeadingSilenceData {
    skip_seconds: Option<f64>,
    analysis_version: u8,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedTrackRecord {
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    duration_seconds: Option<u32>,
    file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover_file: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    find_lyrics: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingImportTrack {
    name: String,
    bytes: Vec<u8>,
    #[serde(default)]
    cover_bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_seconds: Option<u32>,
    cover_bytes: Option<Vec<u8>>,
}

// ── Save track / album to device ────────────────────────────────────────
//
// "Save to my device" pipeline:
//   1. The frontend opens a native folder picker (songs: file save dialog,
//      albums: directory picker) and resolves the destination.
//   2. The frontend hands the resulting path + track metadata to one of
//      these Tauri commands.
//   3. We shell out to yt-dlp to grab the bestaudio stream and convert it
//      to MP3 (postprocessor chain: extract-audio → mp3). yt-dlp
//      embeds whatever metadata it can read from the watch page, but the
//      title / artist / album from the live YT Music page is sometimes
//      mis-cased or split awkwardly, so we always overwrite the relevant
//      ID3 frames with the frontend-supplied values via lofty after the
//      download finishes.
//   4. We also download the cover thumbnail (if any) and embed it as
//      `PictureType::CoverFront` so the resulting MP3 displays artwork in
//      any standard player.
//   5. For albums we just iterate the per-track command — the folder is
//      created up front and a single "Album Artist"/"Album" tag set on
//      every file so the album metadata round-trips intact.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTrackToMp3Request {
    /// Opaque request id the frontend generates for this export. Used
    /// by the `cancel_save_export` command to interrupt the in-flight
    /// save at the next cancellation checkpoint. Frontend should use
    /// a fresh id (e.g. `Date.now()` + a random suffix) for every
    /// export so the same user can kick off two in a row without the
    /// second one's id stomping the first.
    #[serde(default)]
    request_id: String,
    /// The YouTube Music `videoId` — passed to yt-dlp to grab the audio.
    video_id: String,
    /// Alternate ids to consult when looking up cached playback/offline
    /// audio or when the primary id fails yt-dlp (music-video vs Topic
    /// upload, album-shelf remaster rows, etc.).
    #[serde(default)]
    fallback_video_ids: Vec<String>,
    /// Authoritative title for the ID3 tag. May differ from yt-dlp's view.
    title: String,
    /// Authoritative artist for the ID3 tag.
    artist: String,
    /// Album name. Optional because the YouTube Music page doesn't always
    /// expose one (e.g. some singles, loose uploads).
    album: Option<String>,
    /// 1-based position on the album. Drives the `TRCK` frame.
    track_number: Option<u32>,
    /// Total track count on the album. Drives the second value of `TRCK`.
    track_total: Option<u32>,
    /// Release year. Drives the `TYER`/`TDRC` frame.
    year: Option<u32>,
    /// HTTP(S) URL of the cover thumbnail. Optional — older uploads or
    /// podcast-style tracks frequently don't have one.
    cover_url: Option<String>,
    /// Absolute path to the destination directory. The user picks this
    /// through the native folder/file picker on the frontend.
    target_dir: String,
    /// File name WITHOUT extension. The frontend builds this from the
    /// track title (sanitized for the local FS). The command always
    /// appends `.mp3`.
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAlbumToMp3Request {
    /// Opaque request id, see `SaveTrackToMp3Request::request_id`.
    #[serde(default)]
    request_id: String,
    /// Album display name. Drives the created subfolder and the
    /// `Album` ID3 frame on every track.
    album_name: String,
    /// Parent directory. The album subfolder is created inside it.
    target_dir: String,
    /// Album artist (optional but strongly recommended). When set, every
    /// track's ID3 `AlbumArtist` frame is populated with it, which is the
    /// only thing that lets music players group the tracks into a single
    /// album entry alongside mixed "Artist" values.
    album_artist: Option<String>,
    /// Release year applied to every track.
    year: Option<u32>,
    /// Cover URL applied to every track as the front-cover artwork.
    cover_url: Option<String>,
    /// Ordered list of tracks to export. The order here defines the
    /// track numbers stamped on the files (1-based) when the request
    /// itself doesn't carry a `trackNumber`.
    tracks: Vec<SaveAlbumTrackEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAlbumTrackEntry {
    video_id: String,
    #[serde(default)]
    fallback_video_ids: Vec<String>,
    title: String,
    artist: String,
    track_number: Option<u32>,
    file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAlbumResult {
    /// Absolute path to the created album folder.
    album_dir: String,
    /// Final on-disk paths for every track, in export order.
    file_paths: Vec<String>,
}

// ── Save playlist to device ────────────────────────────────────────────
//
// Right-click "Save to my device" on a user playlist. Mirrors the album
// export but with per-track metadata + cover, since a playlist's tracks
// are typically drawn from many albums and many artists.
//
//   * Folder name = playlist title (sanitized).
//   * Each track keeps its own `TALB` (album) and `TPE1` (artist) so
//     the file round-trips through any standard player as the song it
//     actually is, not a copy with the playlist's name slapped on.
//   * Cover art is per-track: we use the track's own `cover` URL when
//     the entry carries one, and fall back to the playlist's overall
//     cover (the user-uploaded image) when a track doesn't have one.
//     Tracks with no cover at all end up with no `APIC` frame — that's
//     strictly better than stamping the playlist's mosaic on every
//     individual file.
//   * We do NOT set `TPE2` (album-artist) because the tracks don't
//     share an album in the playlist sense — slapping "Various Artists"
//     on a file the user tagged with the real performing artist would
//     make a mess of any later "group by album-artist" view.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePlaylistToMp3Request {
    /// Opaque request id, see `SaveTrackToMp3Request::request_id`.
    #[serde(default)]
    request_id: String,
    /// Display name for the playlist. Drives the created subfolder.
    playlist_name: String,
    /// Parent directory picked by the user. The playlist folder is
    /// created inside it.
    target_dir: String,
    /// Playlist-level cover (data URL or http URL). Used as a fallback
    /// for tracks that don't carry their own. Pass `None` for a
    /// cover-less playlist.
    cover_url: Option<String>,
    /// Ordered list of tracks to export. Order here is the order on
    /// disk (and drives the track-number stamp when the entry omits
    /// one).
    tracks: Vec<SavePlaylistTrackEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePlaylistTrackEntry {
    video_id: String,
    #[serde(default)]
    fallback_video_ids: Vec<String>,
    title: String,
    artist: String,
    /// Per-track album. Stamped on the file as `TALB`.
    album: Option<String>,
    /// 1-based position in the playlist. Stamped on the file as
    /// `TRCK` (the second value is the total track count so the
    /// resulting files look like one coherent set when sorted).
    track_number: Option<u32>,
    /// Per-track cover (http URL or data URL). When `None`, the
    /// playlist-level cover is used as a fallback.
    cover_url: Option<String>,
    /// File name WITHOUT extension. The frontend builds this from the
    /// track title (sanitized for the local FS).
    file_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePlaylistResult {
    /// Absolute path to the created playlist folder.
    playlist_dir: String,
    /// Final on-disk paths for every track, in export order.
    file_paths: Vec<String>,
    /// Number of tracks that were skipped (e.g. because they had no
    /// streamable source). Surfaced for the toast/UI.
    skipped: u32,
}

// ── External playlist import ─────────────────────────────────────────────
//
// A lightweight DTO for the "import from Spotify / YT Music / Apple"
// flow: the user pastes a URL, yt-dlp dumps the playlist's tracks as
// flat JSON lines, and we lift out the title / description / cover URL
// plus every track we can identify. The frontend matches each track to
// a YouTube Music equivalent via `searchMusic`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPlaylistTrack {
    title: String,
    artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<u32>,
}




#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPlaylistImport {
    /// Service that the URL resolved to, mostly so the UI can show it
    /// back to the user in logs/errors.
    service: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover_url: Option<String>,
    tracks: Vec<ExternalPlaylistTrack>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPlaylistImportRequest {
    url: String,
}

#[tauri::command]
async fn get_backend_status(app: AppHandle) -> Result<BackendStatus, String> {
    backend_status(&app).await
}

// Detect which music service a URL belongs to. We lean on substrings
// rather than parsing the URL strictly so paste-with-extra-query-string
// or share-card wrappers still land in the right bucket. Each branch
// returns a short slug used for display + telemetry.
fn detect_playlist_service(url: &str) -> Result<&'static str, String> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("music.youtube.com")
        || lower.contains("youtube.com/playlist")
        || lower.contains("youtu.be/playlist")
    {
        return Ok("youtube");
    }
    if lower.contains("open.spotify.com/") && lower.contains("/playlist/") {
        return Ok("spotify");
    }
    if lower.contains("music.apple.com/") && lower.contains("/playlist/") {
        return Ok("apple");
    }
    Err("That doesn't look like a YouTube Music, Spotify, or Apple Music playlist URL.".to_string())
}

fn pick_best_thumbnail_url(value: &Value) -> Option<String> {
    let thumbnails = value.get("thumbnails")?.as_array()?;
    // yt-dlp returns thumbnails sorted by width (ascending). Take the
    // last entry as the highest-resolution candidate. Fall back to any
    // entry that carries an `url` if shape differs.
    let mut best: Option<String> = None;
    let mut best_width: u64 = 0;
    for entry in thumbnails {
        let Some(url) = entry.get("url").and_then(Value::as_str) else {
            continue;
        };
        let width = entry
            .get("width")
            .and_then(Value::as_u64)
            .or_else(|| entry.get("height").and_then(Value::as_u64))
            .unwrap_or(0);
        // Skip known low-res placeholders (Spotify's 60x60 etc).
        if width >= 240 && (best.is_none() || width > best_width) {
            best = Some(url.to_string());
            best_width = width;
        }
    }
    if best.is_some() {
        return best;
    }
    thumbnails
        .iter()
        .find_map(|entry| entry.get("url").and_then(Value::as_str).map(str::to_string))
}

#[tauri::command]
async fn import_external_playlist(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExternalPlaylistImportRequest,
) -> Result<ExternalPlaylistImport, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a playlist link to import.".to_string());
    }
    let service = detect_playlist_service(&url)?;

    match service {
        // YouTube Music: InnerTube `browse` (`VL` + playlistId) is the
        // primary import path; yt-dlp flat-playlist + InnerTube `next`
        // are the fallback. Spotify and Apple Music are scraped from
        // the public web player.
        "youtube" => import_youtube_playlist(&app, &state, &url).await,
        "spotify" => scrape_spotify_playlist(&url).await,
        "apple" => scrape_apple_music_playlist(&url).await,
        _ => Err(format!("Unsupported playlist service: {service}")),
    }
}

// Lightweight header dump used by the YT Music import path. yt-dlp's
// `--flat-playlist --dump-single-json` returns the playlist shell
// (title, thumbnails[], entries[].id) without paying the per-track
// extraction cost — empirically a sub-second call even on large
// playlists where `--dump-json` itself takes tens of seconds (or
// hangs outright; see `import_youtube_playlist`). Two reasons we
// still need a subprocess here:
//   1. We need ONE videoId from the playlist to seed the InnerTube
//      `next` call (the API takes `{videoId, playlistId}` and won't
//      resolve a playlistId on its own).
//   2. When InnerTube `browse` fails or returns an unknown header
//      shape, the flat-playlist dump is the most reliable fallback
//      for the playlist-level title and cover.
async fn run_yt_dlp_playlist_header_dump(
    yt_dlp: &Path,
    url: &str,
) -> Result<String, String> {
    // 15s is plenty for the flat-playlist header call (empirically
    // sub-second on healthy connections). A short bound keeps a stuck
    // header from blocking the import for the full 30s window.
    run_command_with_timeout(
        yt_dlp,
        [
            "--yes-playlist",
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings",
            url,
        ],
        Duration::from_secs(15),
    )
    .await
}

// Fast per-track dump used as the InnerTube fallback in
// `import_youtube_playlist`. `yt-dlp --flat-playlist --print` walks
// the playlist shell (no per-track page extraction, so it never
// hangs) and emits one line per track with id/title/uploader/index.
// This is the same data the old `--dump-json` path produced for
// non-hanging URLs, minus the full per-track page metadata
// (artist/album/duration). The frontend's title+artist matcher can
// fill those in later from search results.
//
// Output format per line: `<id>|||<title>|||<uploader>|||<index>`
// `|||` is chosen because it's vanishingly rare in track metadata
// and won't collide with the separator. Lines that don't parse are
// silently dropped so a malformed line from one track doesn't kill
// the whole import.
//
// 20s upper bound. This call is empirically sub-second on healthy
// connections, but we keep a generous bound so a slow CDN doesn't
// surface as a "Failed to import" error during the InnerTube
// fallback path (which only runs when InnerTube itself failed, so
// the user is already seeing an error — we want to maximize the
// chance the fallback succeeds).
async fn run_yt_dlp_playlist_tracks_dump(
    yt_dlp: &Path,
    url: &str,
) -> Result<String, String> {
    run_command_with_timeout(
        yt_dlp,
        [
            "--yes-playlist",
            "--flat-playlist",
            "--no-warnings",
            "--print",
            "%(id)s|||%(title)s|||%(uploader)s|||%(playlist_index)d",
            url,
        ],
        Duration::from_secs(20),
    )
    .await
}

// Parse the per-track output of `run_yt_dlp_playlist_tracks_dump`
// into `MediaTrack`s. Each non-empty line is shaped
// `<id>|||<title>|||<uploader>|||<playlist_index>`.
//
// `<uploader>` is the field where YT Music flat-playlist mode has
// a known pathology: for every track yt-dlp returns the literal
// string `"NA"` because the per-track channel isn't resolved at
// the playlist API level (verified against `?list=PLJNrpU5NGP0Y`;
// the same applies to `channel`, `artist`, `creator`, etc. — only
// the top-level `playlist_uploader`/`playlist_title`/`playlist_id`
// are populated). Treat `"NA"` as unknown (empty artist) rather
// than dropping the track: the frontend's title-only lenient
// matcher relies on `topArtist.includes("")` being true for an
// empty `targetArtist`, which is what unlocks a match for the
// YT Music topResult when no real artist survives the flat-mode
// uploader normalization. Leaving the bogus `"NA"` in place makes
// `"na".includes("radiohead")` false and drops every track —
// which is the actual user-visible "YT Music playlists fail to
// load" bug this fixes.
fn parse_flat_playlist_tracks(raw: &str) -> Vec<MediaTrack> {
    let mut tracks: Vec<MediaTrack> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split("|||").collect();
        if parts.len() < 4 {
            continue;
        }
        let id = parts[0].trim();
        let title = parts[1].trim();
        let uploader = parts[2].trim();
        if id.is_empty() || title.is_empty() {
            continue;
        }
        // Strip the trailing " - Topic" / " - VEVO" / " - Vevo" /
        // " - Official" suffix from the uploader to get the artist
        // name. YT Music channels follow the "<Artist> - Topic"
        // convention; non-music uploads use " - VEVO" / " - Official".
        // The function is a no-op for uploaders that don't match the
        // pattern. The YT Music flat-mode "NA" is normalized to empty
        // above — see the function-level comment for why.
        let artist = normalize_flat_uploader(uploader);
        let track_id = id.to_string();
        tracks.push(MediaTrack {
            id: track_id.clone(),
            kind: Some("song".to_string()),
            title: title.to_string(),
            artist,
            album: None,
            album_browse_id: None,
            artist_browse_id: None,
            artist_credits: None,
            duration_seconds: None,
            play_count: None,
            cover: None,
            video_id: Some(track_id),
            source: "stream",
            audio_src: None,
            file_path: None,
            find_lyrics: false,
        });
    }
    tracks
}

fn normalize_flat_uploader(uploader: &str) -> String {
    let trimmed = uploader.trim();
    if trimmed.eq_ignore_ascii_case("na") || trimmed.eq_ignore_ascii_case("n/a") {
        return String::new();
    }
    text_utils::strip_artist_noise(trimmed)
}

fn first_video_id_from_playlist_header(value: &Value) -> Option<String> {
    value
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries.iter().find_map(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
            })
        })
}

fn first_video_id_from_tracks_dump(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        trimmed
            .split("|||")
            .next()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    })
}

fn flat_playlist_tracks_from_dump(dump_result: &Result<String, String>) -> Vec<MediaTrack> {
    match dump_result {
        Ok(raw) => parse_flat_playlist_tracks(raw),
        Err(_) => Vec::new(),
    }
}

// Load every track from a YT Music playlist via InnerTube `browse`
// (`browseId = "VL" + playlistId`). This is the native playlist page
// API — no yt-dlp subprocess and no seed videoId required.
async fn fetch_ytm_playlist_via_browse(
    state: &State<'_, AppState>,
    playlist_id: &str,
) -> Result<Option<EntityDetail>, String> {
    let browse_id = format!("VL{playlist_id}");
    let response = post_ytmusic(state, "browse", json!({ "browseId": &browse_id })).await?;
    let mut detail = parse_entity_detail(&browse_id, &response)?;
    if detail.tracks.is_empty() {
        return Ok(None);
    }

    if let Some(shelf) = find_track_shelf_in_browse_response(&response) {
        let fallback_artist = detail
            .byline
            .as_deref()
            .and_then(|value| infer_artist_from_text(value, false));
        let tracks = fetch_playlist_shelf_tracks_with_continuations(
            state,
            shelf,
            &detail.title,
            fallback_artist.as_deref(),
            detail.cover.as_deref(),
            PLAYLIST_IMPORT_TRACK_LIMIT,
        )
        .await?;
        if tracks.len() > detail.tracks.len() {
            detail.tracks = tracks;
        }
    }

    Ok(Some(detail))
}

// YouTube Music playlist import.
//
//   1. InnerTube `browse` with `browseId = "VL" + playlistId` — the
//      native playlist shelf (primary; no yt-dlp required).
//   2. yt-dlp `--flat-playlist` header + `--print` tracks dump, plus
//      InnerTube `next` with `watch_next_payload`, when browse fails.
//   3. Never `yt-dlp --dump-json` — it can stall on large playlists.
async fn import_youtube_playlist(
    app: &AppHandle,
    state: &State<'_, AppState>,
    url: &str,
) -> Result<ExternalPlaylistImport, String> {
    let playlist_id = YT_PLAYLIST_ID_RE
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| {
            "That YouTube Music URL didn't include a playlist ID. Paste a link like https://music.youtube.com/playlist?list=..."
                .to_string()
        })?;

    let mut title: Option<String> = None;
    let mut cover_url: Option<String> = None;
    let mut media_tracks: Vec<MediaTrack> = Vec::new();
    let mut last_error: Option<String> = None;

    match fetch_ytm_playlist_via_browse(state, &playlist_id).await {
        Ok(Some(detail)) => {
            title = Some(detail.title);
            cover_url = detail.cover;
            media_tracks = detail.tracks;
        }
        Ok(None) => {}
        Err(error) => last_error = Some(error),
    }

    if media_tracks.is_empty() {
        let yt_dlp = ensure_yt_dlp(app).await?;
        let (header_result, tracks_dump_result) = tokio::join!(
            run_yt_dlp_playlist_header_dump(&yt_dlp, url),
            run_yt_dlp_playlist_tracks_dump(&yt_dlp, url),
        );

        let mut header_stderr = String::new();
        let mut tracks_stderr = String::new();
        let mut first_video_id: Option<String> = None;

        match header_result {
            Ok(raw) => {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    title = title.or_else(|| {
                        value
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                    cover_url = cover_url.or_else(|| pick_best_thumbnail_url(&value));
                    first_video_id = first_video_id_from_playlist_header(&value);
                }
            }
            Err(stderr_msg) => header_stderr = stderr_msg,
        }

        if first_video_id.is_none() {
            if let Ok(ref raw) = tracks_dump_result {
                first_video_id = first_video_id_from_tracks_dump(raw);
            }
        }
        if let Err(stderr_msg) = &tracks_dump_result {
            tracks_stderr = stderr_msg.clone();
        }

        media_tracks = if let Some(seed_video_id) = first_video_id {
            match post_ytmusic(
                state,
                "next",
                watch_next_payload(&seed_video_id, Some(playlist_id.as_str())),
            )
            .await
            {
                Ok(response) => {
                    let (tracks, _) = extract_watch_playlist(&response, None);
                    if tracks.is_empty() {
                        flat_playlist_tracks_from_dump(&tracks_dump_result)
                    } else {
                        tracks
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                    flat_playlist_tracks_from_dump(&tracks_dump_result)
                }
            }
        } else {
            flat_playlist_tracks_from_dump(&tracks_dump_result)
        };

        if media_tracks.is_empty() {
            last_error = Some(if !tracks_stderr.is_empty() {
                tracks_stderr
            } else if !header_stderr.is_empty() {
                header_stderr
            } else {
                last_error.unwrap_or_else(|| {
                    "We couldn't read any songs from that YouTube Music playlist. Check that the link is public and try again."
                        .to_string()
                })
            });
        }
    }

    if media_tracks.is_empty() {
        return Err(last_error.unwrap_or_else(|| {
            "We couldn't read any songs from that YouTube Music playlist. Check that the link is public and try again."
                .to_string()
        }));
    }

    let tracks: Vec<ExternalPlaylistTrack> = media_tracks
        .into_iter()
        .map(|track| ExternalPlaylistTrack {
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration_seconds: track.duration_seconds,
        })
        .collect();

    Ok(ExternalPlaylistImport {
        service: "youtube".to_string(),
        title: title.unwrap_or_else(|| "Imported playlist".to_string()),
        description: None,
        cover_url,
        tracks,
    })
}


// ── Spotify web scrape ────────────────────────────────────────────────────
//
// Spotify removed their embeddable playlist JSON in mid-2024, and the
// upstream yt-dlp Spotify extractor was retired for DRM reasons, so we
// read the public web player HTML directly. The page is server-rendered
// when we present a non-browser User-Agent — that gives us:
//   * <meta property="og:title">       — playlist name
//   * <meta property="og:image">       — 300x300 cover art
//
// HOWEVER, Spotify's SSR only returns the first ~30 tracks. To get the
// full playlist (tested on 305-song playlists), we extract an anonymous
// access token from the page and call the Spotify Web API with pagination.
// The token is embedded in the HTML as:
//   window.__spotify_webplayer_access_token = "BQC...";
//
// If the token extraction fails (Spotify changed the pattern), we fall
// back to the old SSR track-row scraping which gets at least the first
// page of tracks.
//
// KNOWN GAPS:
//   * `description` is dropped — the og:description above is a hard-coded
//     template, not the user's actual playlist description.
static SPOTIFY_OG_TITLE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?is)<meta\s+property="og:title"\s+content="([^"]+)"#).expect("spotify og:title"));
// (SPOTIFY_OG_DESCRIPTION_RE removed: Spotify's og:description is a hard-coded
// template "Playlist · owner · N items · M saves", not the user's actual
// playlist description, so reading it would echo that metadata template back
// into the imported playlist's description field. The real user description
// lives only on auth-protected api-partner.spotify.com, which we avoid.)
static SPOTIFY_OG_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta\s+property="og:image"\s+content="([^"]+)"#)
        .expect("spotify og:image")
});
static SPOTIFY_ACCESS_TOKEN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"window\.__spotify_webplayer_access_token\s*=\s*"([^"]+)""#)
        .expect("spotify access token")
});
static SPOTIFY_JSON_ACCESS_TOKEN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#""accessToken":"([^"]+)""#).expect("spotify json access token")
});
static SPOTIFY_OG_ITEM_COUNT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta\s+property="og:description"\s+content="[^"]*?\b(\d+)\s+items?\b"#)
        .expect("spotify og item count")
});
// `<script id="initialState">` holds a base64 JSON blob carrying the
// full playlist state (entities keyed by `spotify:track:` and
// `spotify:playlist:` URIs). Used as the *primary* Spotify import
// path because the anonymous /get_access_token endpoint is currently
// 403-blocked upstream, which kills the older API pagination path.
static SPOTIFY_INITIAL_STATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<script[^>]+id="initialState"[^>]*>(.+?)</script>"#)
        .expect("spotify initialState")
});
// The Spotify EMBED page (open.spotify.com/embed/playlist/<id>)
// ships up to ~100 tracks inside a Next.js <script id="__NEXT_DATA__">
// JSON blob. Larger playlists require the public Web API with the
// anonymous session token embedded in that same payload (or the main
// web-player page). The main web-player's initialState blob only
// inlines the first ~30 tracks.
static SPOTIFY_NEXT_DATA_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<script[^>]+id="__NEXT_DATA__"[^>]*>(.+?)</script>"#)
        .expect("spotify next data")
});
static SPOTIFY_PLAYLIST_ID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"/playlist/([a-zA-Z0-9]+)"#).expect("spotify playlist id")
});
static SPOTIFY_TRACK_ROW_MARKER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"data-testid="track-row""#).expect("spotify track row marker"));
static SPOTIFY_TRACK_TITLE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<a\s[^>]*href="/track/[A-Za-z0-9]+"[^>]*>.*?<span[^>]*>([^<]+)</span>"#)
        .expect("spotify track title")
});
static SPOTIFY_ARTIST_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)data-testid="internal-artist-link">[^<]*<a[^>]*>([^<]+)</a>"#)
        .expect("spotify artist")
});

fn spotify_token_looks_usable(access_token: &str) -> bool {
    !access_token.is_empty()
        && access_token != "null"
        && access_token != "undefined"
        && access_token.len() >= 40
        && access_token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// Pull an anonymous session token out of any Spotify HTML we already
// fetched (main web player or embed). The embed page currently stores
// the token both inline in __NEXT_DATA__ and in the serialized session
// settings blob.
fn spotify_access_token_from_html(html: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(token) = SPOTIFY_ACCESS_TOKEN_RE
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
    {
        candidates.push(token);
    }
    if let Some(token) = SPOTIFY_JSON_ACCESS_TOKEN_RE
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
    {
        candidates.push(token);
    }
    if let Some(token) = decode_spotify_next_data(html).and_then(|root| {
        root.pointer("/props/pageProps/state/settings/session/accessToken")
            .and_then(Value::as_str)
            .map(str::to_string)
    }) {
        candidates.push(token);
    }

    candidates
        .into_iter()
        .find(|token| spotify_token_looks_usable(token))
}

// Spotify's og:description is a template ("Playlist · owner · N items ·
// M saves") but the item count is accurate enough to tell when the
// embed page handed us a capped first page.
fn parse_spotify_og_track_count(html: &str) -> Option<usize> {
    SPOTIFY_OG_ITEM_COUNT_RE
        .captures(html)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .filter(|count| *count > 0)
}

fn spotify_import_track_count_sufficient(fetched: usize, expected: Option<usize>) -> bool {
    match expected {
        Some(total) => fetched + 5 >= total,
        None => fetched < SPOTIFY_EMBED_TRACK_PAGE_CAP,
    }
}

// Hit the Spotify anonymous-token endpoint and return a sanitized
// token, or `None` for any failure (network, non-2xx, malformed body,
// missing `accessToken` key). Centralized so the upfront fallback and
// the mid-loop 401 retry share the same extraction logic.
async fn fetch_spotify_access_token() -> Option<String> {
    let token_response = HTTP
        .get("https://open.spotify.com/get_access_token?reason=transport&productType=web_player")
        .header(ORIGIN, HeaderValue::from_static("https://open.spotify.com"))
        .header(REFERER, HeaderValue::from_static("https://open.spotify.com/"))
        .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
        .send()
        .await
        .ok()?;
    if !token_response.status().is_success() {
        return None;
    }
    let token_body: Value = token_response.json().await.ok()?;
    let token = token_body.get("accessToken")?.as_str()?.trim();
    spotify_token_looks_usable(token).then(|| token.to_string())
}

// Decode Spotify's `initialState` base64 JSON blob to a `Value`.
// `None` for any decode failure so the caller can silently fall
// through to the next import path.
fn decode_spotify_initial_state(html: &str) -> Option<Value> {
    let raw = SPOTIFY_INITIAL_STATE_RE
        .captures(html)?
        .get(1)?
        .as_str()
        .trim();
    if raw.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .ok()?;
    let text = std::str::from_utf8(bytes.as_slice()).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

// Fetch ALL tracks from a Spotify public playlist via the Spotify Web
// API using an anonymous access token. Pagination handles playlists
// of any length. Returns `Some(tracks)` on success, `None` for any
// failure that the caller should treat as "try the next path".
async fn fetch_spotify_tracks_via_api(
    url: &str,
    html_sources: &[&str],
) -> Option<Vec<ExternalPlaylistTrack>> {
    let playlist_id = SPOTIFY_PLAYLIST_ID_RE.captures(url)?.get(1)?.as_str().to_string();

    // Extract anonymous token from every HTML source we already
    // fetched (main web player + embed page). A miss must fall through
    // to `fetch_spotify_access_token()` below, not abort the whole
    // function.
    let mut access_token = html_sources
        .iter()
        .find_map(|html| spotify_access_token_from_html(html))
        .unwrap_or_default();

    if !spotify_token_looks_usable(&access_token) {
        access_token = match fetch_spotify_access_token().await {
            Some(token) => token,
            None => return None,
        };
    }

    let api_base = format!("https://api.spotify.com/v1/playlists/{playlist_id}/tracks");
    let mut all_tracks: Vec<ExternalPlaylistTrack> = Vec::new();
    let limit: u32 = 50;
    let mut offset: u32 = 0;
    // Per-page refresh guard. The retry path `continue`s back to the
    // top of the same page, so this counter must be declared OUTSIDE
    // the loop to actually cap retries. We reset it to 0 right after
    // each successful `offset += limit;` so every page gets a fresh
    // budget of one token refresh+retry.
    let mut refresh_attempts: u8 = 0;

    loop {
        if offset > 0 {
            // Gentle pacing between pages so anonymous imports on large
            // playlists don't trip Spotify's rate limiter mid-pagination.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        let page_url = format!("{api_base}?limit={limit}&offset={offset}");
        let response = HTTP
            .get(&page_url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header(ORIGIN, HeaderValue::from_static("https://open.spotify.com"))
            .header(REFERER, HeaderValue::from_static("https://open.spotify.com/"))
            .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
            .send()
            .await
            .ok()?;

        // 401 = token expired; 429 = Spotify rate-limited us. Either
        // is worth a single refresh+retry per page; 429 we back off
        // briefly so the rate limiter doesn't escalate.
        //
        // We deliberately do NOT set a "this page already retried"
        // flag before `continue`ing. The flag was only ever silencing
        // retries on every subsequent page after the first one -- the
        // retry path jumps past the post-block reset, and the next
        // iteration's check would then see `flag = true` and bail.
        // Each iteration is a fresh HTTP call on a new offset, so the
        // flag was guarding nothing useful and just suppressing
        // recoveries from token rotations that hit mid-import.
        let is_401 = response.status() == reqwest::StatusCode::UNAUTHORIZED;
        let is_429 = response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS;
        if (is_401 || is_429) && refresh_attempts < 1 {
            if is_429 {
                // Short backoff before retrying so the rate limiter
                // doesn't escalate.
                tokio::time::sleep(Duration::from_millis(750)).await;
            }
            if let Some(refreshed) = fetch_spotify_access_token().await {
                access_token = refreshed;
                refresh_attempts += 1;
                continue;
            }
            return None;
        }

        if !response.status().is_success() {
            return None;
        }

        let body: Value = response.json().await.ok()?;
        let items = body.get("items")?.as_array()?;
        let items_on_page = items.len();

        for item in items {
            let Some(track) = item.get("track") else { continue };
            let Some(name) = track.get("name").and_then(Value::as_str).map(|s| s.to_string()) else { continue };
            let artist = track
                .get("artists")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_default();
            if artist.is_empty() { continue; }

            let album = track
                .get("album")
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());

            let duration_seconds = track
                .get("duration_ms")
                .and_then(Value::as_f64)
                .map(|ms| (ms / 1000.0) as u32)
                .filter(|d| *d > 0);

            all_tracks.push(ExternalPlaylistTrack {
                title: name,
                artist,
                album,
                duration_seconds,
            });
        }

        let total = body.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
        offset += limit;
        // Reset the per-page refresh budget now that this page is
        // fully processed. The next iteration starts a fresh page.
        refresh_attempts = 0;

        // Stop when we've fetched everything or the last page was empty.
        if all_tracks.len() >= total || items_on_page == 0 {
            break;
        }
    }

    if all_tracks.is_empty() { None } else { Some(all_tracks) }
}

const SPOTIFY_PATHFINDER_PLAYLIST_HASH: &str =
    "91d4c2bc3e0cd1bc672281c4f1f59f43ff55ba726ca04a45810d99bd091f3f0e";
const SPOTIFY_PATHFINDER_PAGE_LIMIT: u32 = 100;
const SPOTIFY_PLAYLIST_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);
const SPOTIFY_EXTEND_BEYOND_EMBED_TIMEOUT: Duration = Duration::from_secs(75);
const SPOTIFY_EMBED_TRACK_FETCH_CHUNK_DELAY_MS: u64 = 120;
const SPOTIFY_EMBED_TRACK_FETCH_MAX_DURATION: Duration = Duration::from_secs(70);
const SPOTIFY_EMBED_TRACK_FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const SPOTIFY_EMBED_TRACK_429_BACKOFF_MS: [u64; 2] = [400, 1200];
const SPOTIFY_API_429_BACKOFF_MS: [u64; 4] = [500, 1200, 2500, 5000];

fn spotify_api_request_headers(access_token: &str) -> Vec<(reqwest::header::HeaderName, HeaderValue)> {
    vec![
        (
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {access_token}"))
                .unwrap_or_else(|_| HeaderValue::from_static("Bearer ")),
        ),
        (
            ORIGIN,
            HeaderValue::from_static("https://open.spotify.com"),
        ),
        (
            REFERER,
            HeaderValue::from_static("https://open.spotify.com/"),
        ),
        (
            ACCEPT_LANGUAGE,
            HeaderValue::from_static("en-US,en;q=0.9"),
        ),
    ]
}

fn parse_spotify_pathfinder_playlist_items(body: &Value) -> Vec<(String, Option<u32>)> {
    let Some(items) = body
        .pointer("/data/playlistV2/content/items")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let data = item.pointer("/itemV2/data")?;
            let uri = data.get("uri").and_then(Value::as_str)?.to_string();
            let duration_seconds = data
                .pointer("/trackDuration/totalMilliseconds")
                .and_then(Value::as_f64)
                .map(|ms| (ms / 1000.0) as u32)
                .filter(|seconds| *seconds > 0);
            Some((uri, duration_seconds))
        })
        .collect()
}

async fn fetch_spotify_pathfinder_playlist_items(
    playlist_id: &str,
    access_token: &str,
    expected_total: Option<usize>,
) -> Option<Vec<(String, Option<u32>)>> {
    let mut all_items: Vec<(String, Option<u32>)> = Vec::new();
    let mut offset: u32 = 0;

    loop {
        if offset > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        let remaining = expected_total
            .map(|total| total.saturating_sub(all_items.len()))
            .unwrap_or(SPOTIFY_PATHFINDER_PAGE_LIMIT as usize)
            .min(PLAYLIST_IMPORT_TRACK_LIMIT.saturating_sub(all_items.len()));
        if remaining == 0 {
            break;
        }
        let page_limit = (remaining as u32).clamp(1, SPOTIFY_PATHFINDER_PAGE_LIMIT);

        let variables = json!({
            "uri": format!("spotify:playlist:{playlist_id}"),
            "offset": offset,
            "limit": page_limit,
        });
        let extensions = json!({
            "persistedQuery": {
                "version": 1,
                "sha256Hash": SPOTIFY_PATHFINDER_PLAYLIST_HASH,
            }
        });
        let query = format!(
            "https://api-partner.spotify.com/pathfinder/v1/query?operationName=fetchPlaylistMetadata&variables={}&extensions={}",
            urlencoding::encode(&variables.to_string()),
            urlencoding::encode(&extensions.to_string()),
        );

        let mut request = HTTP.get(&query).header(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json"),
        );
        for (name, value) in spotify_api_request_headers(access_token) {
            request = request.header(name, value);
        }

        let response = request.send().await.ok()?;
        if !response.status().is_success() {
            break;
        }

        let body: Value = response.json().await.ok()?;
        let page = parse_spotify_pathfinder_playlist_items(&body);
        if page.is_empty() {
            break;
        }

        let page_count = page.len();
        all_items.extend(page);
        if page_count == 0 {
            break;
        }
        offset += page_count as u32;

        if expected_total.is_some_and(|total| all_items.len() >= total) {
            break;
        }
        if page_count < page_limit as usize {
            break;
        }
    }

    if all_items.is_empty() {
        None
    } else {
        Some(all_items)
    }
}

fn parse_spotify_embed_track_entity(entity: &Value) -> Option<ExternalPlaylistTrack> {
    let title = entity
        .get("name")
        .or_else(|| entity.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)?;
    let artist = entity
        .get("artists")
        .and_then(Value::as_array)
        .and_then(|artists| artists.first())
        .and_then(|entry| entry.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)?;
    let duration_seconds = entity
        .get("duration")
        .and_then(Value::as_f64)
        .map(|ms| (ms / 1000.0) as u32)
        .filter(|seconds| *seconds > 0);
    Some(ExternalPlaylistTrack {
        title,
        artist,
        album: None,
        duration_seconds,
    })
}

async fn fetch_spotify_track_metadata_from_embed_page(
    track_id: &str,
) -> Option<ExternalPlaylistTrack> {
    let url = format!("https://open.spotify.com/embed/track/{track_id}");

    for attempt in 0..=SPOTIFY_EMBED_TRACK_429_BACKOFF_MS.len() {
        if attempt > 0 {
            let backoff = SPOTIFY_EMBED_TRACK_429_BACKOFF_MS[attempt - 1];
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }

        let response = HTTP
            .get(&url)
            .header(reqwest::header::USER_AGENT, HeaderValue::from_static(USER_AGENT))
            .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
            .timeout(SPOTIFY_EMBED_TRACK_FETCH_TIMEOUT)
            .send()
            .await
            .ok()?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            continue;
        }
        if !response.status().is_success() {
            return None;
        }

        let html = response.text().await.ok()?;
        let root = decode_spotify_next_data(&html)?;
        let entity = root.pointer("/props/pageProps/state/data/entity")?;
        return parse_spotify_embed_track_entity(entity);
    }

    None
}

async fn fetch_spotify_tracks_metadata_from_embed_pages(
    track_ids: &[String],
) -> std::collections::HashMap<String, ExternalPlaylistTrack> {
    let mut tracks_by_id = std::collections::HashMap::new();
    let started = Instant::now();

    // Fetch one track at a time on the Tauri command task. Concurrent
    // `tokio::spawn`/`join_all` batches hung forever at "Calling Spotify…"
    // for playlists past the 100-track embed cap because nested tasks never
    // got polled inside the command future. Sequential awaits keep every
    // request on the same task and let us bail once the extend budget elapses,
    // returning a partial playlist instead of blocking the modal indefinitely.
    for (index, track_id) in track_ids.iter().enumerate() {
        if started.elapsed() >= SPOTIFY_EMBED_TRACK_FETCH_MAX_DURATION {
            break;
        }
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(
                SPOTIFY_EMBED_TRACK_FETCH_CHUNK_DELAY_MS,
            ))
            .await;
        }

        let metadata = match tokio::time::timeout(
            SPOTIFY_EMBED_TRACK_FETCH_TIMEOUT,
            fetch_spotify_track_metadata_from_embed_page(track_id),
        )
        .await
        {
            Ok(track) => track,
            Err(_) => None,
        };
        if let Some(track) = metadata {
            tracks_by_id.insert(track_id.clone(), track);
        }
    }

    tracks_by_id
}

async fn extend_spotify_tracks_beyond_embed_cap(
    embed_tracks: &[ExternalPlaylistTrack],
    playlist_id: &str,
    access_token: &str,
    expected_total: Option<usize>,
    pathfinder_items: Option<&[(String, Option<u32>)]>,
) -> Option<Vec<ExternalPlaylistTrack>> {
    if spotify_import_track_count_sufficient(embed_tracks.len(), expected_total) {
        return None;
    }

    let pathfinder_items = match pathfinder_items {
        Some(items) if !items.is_empty() => items.to_vec(),
        _ => fetch_spotify_pathfinder_playlist_items(playlist_id, access_token, expected_total)
            .await?,
    };
    if pathfinder_items.len() <= embed_tracks.len() {
        return None;
    }

    let missing_ids: Vec<String> = pathfinder_items
        .iter()
        .skip(embed_tracks.len())
        .filter_map(|(uri, _)| uri.strip_prefix("spotify:track:").map(str::to_string))
        .collect();
    // The anonymous Web API is aggressively rate-limited during large
    // imports. Embed track pages carry the same title/artist metadata
    // without burning the API quota we need for pathfinder pagination.
    let fetched_by_id = fetch_spotify_tracks_metadata_from_embed_pages(&missing_ids).await;
    if fetched_by_id.is_empty() {
        return None;
    }

    let mut rebuilt = Vec::with_capacity(pathfinder_items.len().max(embed_tracks.len()));
    for (index, (uri, duration)) in pathfinder_items.iter().enumerate() {
        if index < embed_tracks.len() {
            rebuilt.push(embed_tracks[index].clone());
            continue;
        }
        let Some(id) = uri.strip_prefix("spotify:track:") else {
            continue;
        };
        let Some(mut track) = fetched_by_id.get(id).cloned() else {
            continue;
        };
        if track.duration_seconds.is_none() {
            track.duration_seconds = *duration;
        }
        rebuilt.push(track);
    }

    if rebuilt.len() > embed_tracks.len() {
        Some(rebuilt)
    } else {
        None
    }
}

// --- Spotify initialState helpers ---------------------------------

// Walk the playlist entity's track-list of choice. Spotify's
// hydration shape has shifted across web-player rollouts; we try
// the most common keys in order (`tracksV2` -> `contents` ->
// `tracks`) and return whichever is the first non-empty array.
fn spotify_playlist_track_items(playlist: &Value) -> Option<&Vec<Value>> {
    let candidates = [
        playlist.get("tracksV2").and_then(|v| v.get("items")),
        playlist
            .get("contents")
            .and_then(|v| v.get("items"))
            .or_else(|| playlist.get("contents")),
        playlist.get("tracks"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|value| value.as_array().filter(|arr| !arr.is_empty()))
}

// Extract a track URI from one entry in the playlist entity's track-
// list array. Spotify ships it directly (`uri`), nested under
// `trackItem.v2.data.uri`, or wrapped under `track.uri`; we try
// all three so a hydration-blob shape rotation doesn't drop tracks.
fn spotify_track_item_uri(item: &Value) -> Option<String> {
    const URI_KEYS: [&str; 3] = ["uri", "track_uri", "trackUri"];
    for key in URI_KEYS {
        if let Some(s) = item.get(key).and_then(Value::as_str) {
            if s.starts_with("spotify:track:") {
                return Some(s.to_string());
            }
        }
    }
    if let Some(s) = item
        .get("trackItem")
        .and_then(|t| t.get("v2"))
        .and_then(|t| t.get("data"))
        .and_then(|d| d.get("uri"))
        .and_then(Value::as_str)
    {
        if s.starts_with("spotify:track:") {
            return Some(s.to_string());
        }
    }
    item.get("track")
        .and_then(|t| t.get("uri"))
        .and_then(Value::as_str)
        .filter(|s| s.starts_with("spotify:track:"))
        .map(str::to_string)
}

// Largest cover URL from the playlist entity's `images` array. The
// shape has rotated a few times, so this is deliberately permissive.
fn spotify_playlist_cover(playlist: &Value) -> Option<String> {
    let images = playlist.get("images").and_then(Value::as_array)?;
    let mut best_width: u64 = 0;
    let mut best_url: Option<String> = None;
    for entry in images {
        let url = entry
            .as_str()
            .map(str::to_string)
            .or_else(|| entry.get("url").and_then(Value::as_str).map(str::to_string))
            .or_else(|| {
                entry.as_array().and_then(|inner| {
                    inner
                        .last()
                        .and_then(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .or_else(|| v.get("url").and_then(Value::as_str).map(str::to_string))
                        })
                        .or_else(|| {
                            inner.first().and_then(|v| {
                                v.as_str()
                                    .map(str::to_string)
                                    .or_else(|| v.get("url").and_then(Value::as_str).map(str::to_string))
                            })
                        })
                })
            });
        let width = entry
            .get("maxWidth")
            .and_then(Value::as_u64)
            .or_else(|| entry.get("width").and_then(Value::as_u64))
            .unwrap_or(0);
        if let Some(url) = url {
            if width > best_width || best_url.is_none() {
                best_url = Some(url);
                best_width = width;
            }
        }
    }
    best_url
}

// ── Spotify embed page helpers ──────────────────────────────────

// Fetch the public embed page for a playlist ID. The embed page
// (open.spotify.com/embed/playlist/<id>) is less rate-limited than
// the main web player and does not require a session cookie, so it
// works for anonymous imports. We use a 10s timeout (shorter than the
// default 15s) so a slow embed page does not block the import path
// for the full 15s when the primary path will end up timing out.
async fn fetch_spotify_embed_html(playlist_id: &str) -> Option<String> {
    let url = format!("https://open.spotify.com/embed/playlist/{playlist_id}");
    let response = HTTP
        .get(&url)
        .header(reqwest::header::USER_AGENT, HeaderValue::from_static(USER_AGENT))
        .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

// Decode the embed page's <script id="__NEXT_DATA__"> body to a
// `Value`. Returns `None` for any decode failure so the caller can
// silently fall through to the next import path.
fn decode_spotify_next_data(html: &str) -> Option<Value> {
    let raw = SPOTIFY_NEXT_DATA_RE
        .captures(html)?
        .get(1)?
        .as_str()
        .trim();
    if raw.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(raw).ok()
}

// Walk a `state.data.entity` JSON tree looking for the playlist
// entity (a dict with a non-empty `trackList` array). The embed
// page's Next.js payload nests the playlist under a few possible
// paths; we probe them in order. Returns the entity dict and the
// resolved trackList array length so the caller can decide whether
// the find was useful.
fn find_embed_playlist_entity(root: &Value) -> Option<(&Value, usize)> {
    let state = root.pointer("/props/pageProps/state")?;
    let data = state.get("data")?;
    let entity = data.get("entity")?;
    if let Some(tl) = entity.get("trackList").and_then(Value::as_array) {
        if !tl.is_empty() {
            return Some((entity, tl.len()));
        }
    }
    // Older embed rollouts nested the entity directly under
    // `pageProps.data.entity` (no `state` wrapper). Fallback probe.
    if let Some(data) = root.pointer("/props/pageProps/data") {
        if let Some(entity) = data.get("entity") {
            if let Some(tl) = entity.get("trackList").and_then(Value::as_array) {
                if !tl.is_empty() {
                    return Some((entity, tl.len()));
                }
            }
        }
    }
    None
}

// Convert one trackList entry to our internal `ExternalPlaylistTrack`.
// Embed trackList items have a flat shape: `title` (the song name),
// `subtitle` (the artist, already a string), `duration` (ms),
// and `uri` (the Spotify track URI). Album info is NOT present on
// the embed trackList; the initialState path enriches it where both
// sides overlap (see `enrich_tracks_with_album_info` below).
fn parse_embed_track(item: &Value) -> Option<ExternalPlaylistTrack> {
    let title = item.get("title").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artist = item
        .get("subtitle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    if artist.is_empty() {
        return None;
    }
    let duration_seconds = item
        .get("duration")
        .and_then(Value::as_f64)
        .map(|ms| (ms / 1000.0) as u32)
        .filter(|d| *d > 0);
    Some(ExternalPlaylistTrack {
        title,
        artist,
        album: None,
        duration_seconds,
    })
}

// Find the best cover URL on the embed entity, preferring the
// `coverArt.sources[0].url` Spotify ships in the Next.js payload.
fn embed_entity_cover(entity: &Value) -> Option<String> {
    if let Some(url) = entity
        .pointer("/coverArt/sources/0/url")
        .and_then(Value::as_str)
    {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(images) = entity
        .pointer("/visualIdentity/image")
        .and_then(Value::as_array)
    {
        for entry in images {
            if let Some(url) = entry.get("url").and_then(Value::as_str) {
                let trimmed = url.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

// Pull the full track list out of the embed page's __NEXT_DATA__
// JSON. Returns `None` if the embed fetch fails, the script tag is
// missing, or the playlist entity has no trackList. The caller is
// expected to fall back to the initialState/API/SSR paths in that
// case.
async fn scrape_playlist_via_embed_page(
    url: &str,
    embed_html: Option<&str>,
) -> Option<ExternalPlaylistImport> {
    let playlist_id = SPOTIFY_PLAYLIST_ID_RE.captures(url)?.get(1)?.as_str();
    let embed_html = match embed_html {
        Some(html) => html.to_string(),
        None => fetch_spotify_embed_html(playlist_id).await?,
    };
    let root = decode_spotify_next_data(&embed_html)?;
    let (entity, _track_list_len) = find_embed_playlist_entity(&root)?;

    let track_list = entity.get("trackList").and_then(Value::as_array)?;
    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::with_capacity(track_list.len());
    for item in track_list.iter() {
        if let Some(track) = parse_embed_track(item) {
            tracks.push(track);
        }
    }
    if tracks.is_empty() {
        return None;
    }

    let title = entity
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Imported playlist".to_string());
    // The embed entity does not expose the user-entered playlist
    // description; leave it None for the caller to fall through to
    // og:description.
    let description: Option<String> = None;
    let cover_url = embed_entity_cover(entity);

    Some(ExternalPlaylistImport {
        service: "spotify".to_string(),
        title,
        description,
        cover_url,
        tracks,
    })
}

// Enrich the embed-page tracks (which lack album info) with the
// album metadata from the main page's initialState blob, where the
// two sides overlap. Matches by (title, artist) case-insensitively.
// Tracks that appear ONLY in the embed list (the 31st..Nth) keep
// `album = None`.
fn enrich_tracks_with_album_info(
    tracks: &mut [ExternalPlaylistTrack],
    initial_state: Option<&ExternalPlaylistImport>,
) {
    let Some(import) = initial_state else {
        return;
    };
    for track in tracks.iter_mut() {
        if track.album.is_some() {
            continue;
        }
        if let Some(matched) = import.tracks.iter().find(|t| {
            t.title.eq_ignore_ascii_case(&track.title)
                && t.artist.eq_ignore_ascii_case(&track.artist)
        }) {
            track.album = matched.album.clone();
        }
    }
}

// Pull every track out of Spotify's hydration blob without going
// through the auth path. Returns `None` if the blob is missing,
// the playlist entity isn't present, or no tracks can be
// resolved -- in those cases the caller is expected to fall back
// to the API/SSR paths.
fn scrape_playlist_via_initial_state(
    url: &str,
    html: &str,
) -> Option<ExternalPlaylistImport> {
    let blob = decode_spotify_initial_state(html)?;
    let playlist_id = SPOTIFY_PLAYLIST_ID_RE
        .captures(url)?
        .get(1)?
        .as_str()
        .to_ascii_uppercase();
    let entities = blob.get("entities").and_then(Value::as_object)?;

    // Compare URI keys case-insensitively (modern builds lowercase,
    // older rollouts keep the original case).
    let playlist = entities.iter().find_map(|(key, value)| {
        key.strip_prefix("spotify:playlist:")
            .filter(|rest| rest.eq_ignore_ascii_case(&playlist_id))
            .map(|_| value)
    })?;

    let items = spotify_playlist_track_items(playlist)?;

    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::with_capacity(items.len());
    for item in items.iter() {
        let Some(uri) = spotify_track_item_uri(item) else {
            continue;
        };
        let Some(track_entity) = entities.get(&uri) else {
            continue;
        };
        let title = track_entity
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let artist = {
            let arr = track_entity.get("artists").and_then(Value::as_array);
            let names: Vec<String> = arr
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|a| {
                            a.get("profile")
                                .and_then(|p| p.get("name"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| a.get("name").and_then(Value::as_str).map(str::to_string))
                                .or_else(|| {
                                    a.get("uri")
                                        .and_then(Value::as_str)
                                        .filter(|s| s.starts_with("spotify:artist:"))
                                        .and_then(|uri| entities.get(uri))
                                        .and_then(|ent| ent.get("name").and_then(Value::as_str))
                                        .map(str::to_string)
                                })
                        })
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if names.is_empty() {
                String::new()
            } else {
                names.join(", ")
            }
        };
        let album = track_entity
            .get("albumOfTrack")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                track_entity.get("album").and_then(|a| {
                    a.get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            a.get("uri")
                                .and_then(Value::as_str)
                                .filter(|s| s.starts_with("spotify:album:"))
                                .and_then(|uri| entities.get(uri))
                                .and_then(|ent| ent.get("name").and_then(Value::as_str))
                                .map(str::to_string)
                        })
                })
            });
        let duration_seconds = track_entity
            .get("duration")
            .and_then(|d| d.get("totalMilliseconds"))
            .and_then(Value::as_f64)
            .map(|ms| (ms / 1000.0) as u32)
            .filter(|d| *d > 0);

        let (Some(title), false) = (title, artist.is_empty()) else {
            continue;
        };
        tracks.push(ExternalPlaylistTrack {
            title,
            artist,
            album,
            duration_seconds,
        });
    }

    if tracks.is_empty() {
        return None;
    }

    let title = playlist
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Imported playlist".to_string());
    let description = playlist.get("description").and_then(|d| match d {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Object(_) => d
            .get("text")
            .and_then(Value::as_str)
            .map(|s| text_utils::decode_html_entities(s).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                d.get("html")
                    .and_then(Value::as_str)
                    .map(|s| text_utils::decode_html_entities(s).trim().to_string())
                    .filter(|s| !s.is_empty())
            }),
        _ => None,
    });
    let cover_url = spotify_playlist_cover(playlist);

    Some(ExternalPlaylistImport {
        service: "spotify".to_string(),
        title,
        description,
        cover_url,
        tracks,
    })
}

// Fallback SSR track-row extraction. Spotify's server-rendered page
// typically only includes the first ~30 tracks, so this is a last resort
// when the API approach fails.
fn extract_spotify_tracks_from_ssr(html: &str) -> Vec<ExternalPlaylistTrack> {
    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::new();
    let marker_offsets: Vec<usize> = SPOTIFY_TRACK_ROW_MARKER_RE
        .find_iter(html)
        .map(|m| m.start())
        .collect();

    for window in marker_offsets.windows(2) {
        let row = &html[window[0]..window[1]];
        let track_title = SPOTIFY_TRACK_TITLE_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| text_utils::decode_html_entities(m.as_str()));
        let artist = SPOTIFY_ARTIST_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| text_utils::decode_html_entities(m.as_str()));
        if let (Some(title), Some(artist)) = (track_title, artist) {
            let trimmed_title = title.trim();
            let trimmed_artist = artist.trim();
            if !trimmed_title.is_empty() && !trimmed_artist.is_empty() {
                tracks.push(ExternalPlaylistTrack {
                    title: trimmed_title.to_string(),
                    artist: trimmed_artist.to_string(),
                    album: None,
                    duration_seconds: None,
                });
            }
        }
    }

    if let Some(last_offset) = marker_offsets.last() {
        let tail_end = html[*last_offset..]
            .find("</body>")
            .map(|offset| *last_offset + offset)
            .unwrap_or(html.len());
        let row = &html[*last_offset..tail_end];
        let track_title = SPOTIFY_TRACK_TITLE_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| text_utils::decode_html_entities(m.as_str()));
        let artist = SPOTIFY_ARTIST_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| text_utils::decode_html_entities(m.as_str()));
        if let (Some(title), Some(artist)) = (track_title, artist) {
            let trimmed_title = title.trim();
            let trimmed_artist = artist.trim();
            if !trimmed_title.is_empty() && !trimmed_artist.is_empty() {
                tracks.push(ExternalPlaylistTrack {
                    title: trimmed_title.to_string(),
                    artist: trimmed_artist.to_string(),
                    album: None,
                    duration_seconds: None,
                });
            }
        }
    }

    tracks
}

async fn fetch_spotify_main_page_html(url: &str) -> String {
    for attempt in 0..=SPOTIFY_API_429_BACKOFF_MS.len() {
        if attempt > 0 {
            let backoff = SPOTIFY_API_429_BACKOFF_MS[attempt - 1];
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }

        let Ok(response) = HTTP_NO_REDIRECT
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                HeaderValue::from_static("Mozilla/5.0"),
            )
            .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
            .send()
            .await
        else {
            continue;
        };

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            continue;
        }
        if !response.status().is_success() {
            break;
        }
        if let Ok(html) = response.text().await {
            if !html.is_empty() {
                return html;
            }
        }
    }

    String::new()
}

async fn scrape_spotify_playlist(url: &str) -> Result<ExternalPlaylistImport, String> {
    match tokio::time::timeout(
        SPOTIFY_PLAYLIST_IMPORT_TIMEOUT,
        scrape_spotify_playlist_inner(url),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(
            "Spotify playlist import timed out. Wait a moment and try again.".to_string(),
        ),
    }
}

async fn scrape_spotify_playlist_inner(url: &str) -> Result<ExternalPlaylistImport, String> {
    // A barebones User-Agent triggers Spotify's server-side rendering
    // branch which embeds the playlist metadata in OG tags and often
    // includes the anonymous access token in a script tag.
    let html = fetch_spotify_main_page_html(url).await;

    let mut title = SPOTIFY_OG_TITLE_RE
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| text_utils::decode_html_entities(m.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported playlist".to_string());

    // Spotify's `<meta property="og:description">` is a templated string
    // ("Playlist · <owner> · <N> items · <M> saves") — NOT the user's actual
    // description. The real user-entered description lives only behind
    // `api-partner.spotify.com`, which requires a logged-in bearer token.
    // Returning the template here made the imported playlist's description a
    // wall of metadata noise, so we deliberately return None.
    let description: Option<String> = None;

    let cover_url = SPOTIFY_OG_IMAGE_RE
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.is_empty());

    // Fallback chain for the first page of tracks. The embed page caps
    // at ~100 tracks, so once we have a candidate list we compare it
    // against the og:description item count and upgrade via the
    // paginated Web API when the list looks incomplete.
    //   1. Embed page __NEXT_DATA__ (fast, up to 100 tracks).
    //   2. initialState blob (album metadata + up to ~30 tracks).
    //   3. Spotify Web API pagination (complete list when token works).
    //   4. SSR scrape. Last resort.
    let playlist_id = SPOTIFY_PLAYLIST_ID_RE
        .captures(url)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string());
    let embed_html = if let Some(ref id) = playlist_id {
        fetch_spotify_embed_html(id).await
    } else {
        None
    };
    let expected_total = parse_spotify_og_track_count(&html);
    let html_sources: Vec<&str> = {
        let mut sources = vec![html.as_str()];
        if let Some(ref embed) = embed_html {
            sources.push(embed.as_str());
        }
        sources
    };

    let mut tracks: Vec<ExternalPlaylistTrack>;
    let mut last_error: Option<String> = None;
    let mut embed_import: Option<ExternalPlaylistImport> = None;
    let mut initial_state_import: Option<ExternalPlaylistImport> = None;

    if let Some(mut import) =
        scrape_playlist_via_embed_page(url, embed_html.as_deref()).await
    {
        // `mem::take` moves the `tracks` Vec out of `import` without
        // cloning it. `import` itself stays owned, just with an empty
        // tracks Vec -- that's what gets stored in `embed_import` for
        // the cover-url fallback below.
        tracks = std::mem::take(&mut import.tracks);
        if title == "Imported playlist" {
            title = import.title.clone();
        }
        embed_import = Some(import);
        // Cross-enrich the embed tracks (which lack album info) with
        // whatever the initialState happens to also know. Reuse the
        // `initial_state_import` binding so we don't pay for a Vec
        // clone of the first 30 tracks.
        initial_state_import = scrape_playlist_via_initial_state(url, &html);
        enrich_tracks_with_album_info(&mut tracks, initial_state_import.as_ref());
    } else if let Some(mut import) = scrape_playlist_via_initial_state(url, &html) {
        tracks = std::mem::take(&mut import.tracks);
        initial_state_import = Some(import);
    } else if let Some(api_tracks) = fetch_spotify_tracks_via_api(url, &html_sources).await {
        tracks = api_tracks;
    } else {
        tracks = extract_spotify_tracks_from_ssr(&html);
        if tracks.is_empty() {
            last_error = Some(
                "We couldn't read any songs from that Spotify playlist. Some playlists require sign-in or are region-locked."
                    .to_string(),
            );
        }
    }

    if !spotify_import_track_count_sufficient(tracks.len(), expected_total)
        && embed_import.is_none()
    {
        if let Some(api_tracks) = fetch_spotify_tracks_via_api(url, &html_sources).await {
            if api_tracks.len() > tracks.len() {
                tracks = api_tracks;
                enrich_tracks_with_album_info(&mut tracks, initial_state_import.as_ref());
            }
        }
    }

    if !spotify_import_track_count_sufficient(tracks.len(), expected_total) {
        if let (Some(playlist_id), Some(access_token)) = (
            playlist_id.as_deref(),
            html_sources
                .iter()
                .find_map(|html| spotify_access_token_from_html(html)),
        ) {
            let pathfinder_items = fetch_spotify_pathfinder_playlist_items(
                playlist_id,
                &access_token,
                expected_total,
            )
            .await;
            let extend_expected = expected_total.or_else(|| {
                pathfinder_items
                    .as_ref()
                    .map(|items| items.len())
            });
            if let Ok(Some(extended)) = tokio::time::timeout(
                SPOTIFY_EXTEND_BEYOND_EMBED_TIMEOUT,
                extend_spotify_tracks_beyond_embed_cap(
                    &tracks,
                    playlist_id,
                    &access_token,
                    extend_expected,
                    pathfinder_items.as_deref(),
                ),
            )
            .await
            {
                tracks = extended;
                enrich_tracks_with_album_info(&mut tracks, initial_state_import.as_ref());
            }
        }
    }

    if let Some(error) = last_error {
        return Err(error);
    }

    if tracks.is_empty() {
        return Err(
            "We couldn't read any songs from that Spotify playlist. Some playlists require sign-in or are region-locked."
                .to_string(),
        );
    }

    // Prefer the highest-resolution cover available. The embed page's
    // `coverArt.sources` typically ships the largest variant
    // (~640x640); the initialState blob's playlist entity and the
    // og:image tag are fallbacks when the embed path didn't run.
    let cover_url = embed_import
        .and_then(|i| i.cover_url)
        .or_else(|| initial_state_import.and_then(|i| i.cover_url))
        .or(cover_url);

    Ok(ExternalPlaylistImport {
        service: "spotify".to_string(),
        title,
        description,
        cover_url,
        tracks,
    })
}

// ── Apple Music web scrape ────────────────────────────────────────────────
//
// Apple Music's `applemusic` extractor in yt-dlp only knows about
// canonical `pl.<id>` URLs, not the `pl.u-<token>` Universal Link share
// tokens that show up in copy-paste flows. The web player at
// music.apple.com, on the other hand, is happy to serve either, and
// the page embeds the full playlist data as a server-rendered JSON blob
// inside <script type="application/json" id="serialized-server-data">.
// We parse that JSON to walk the track list directly.
static APPLE_SSD_SCRIPT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<script\s+type="application/json"\s+id="serialized-server-data">(.+?)</script>"#)
        .expect("apple serialized-server-data")
});

async fn scrape_apple_music_playlist(url: &str) -> Result<ExternalPlaylistImport, String> {
    let response = HTTP
        .get(url)
        .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
        .send()
        .await
        .map_err(|error| format!("Apple Music request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Apple Music returned HTTP {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|error| format!("Apple Music response read failed: {error}"))?;

    let json_str = APPLE_SSD_SCRIPT_RE
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .ok_or_else(|| {
            "Apple Music page didn't include playlist data. Make sure it's a public playlist."
                .to_string()
        })?;

    let root: Value = serde_json::from_str(json_str)
        .map_err(|error| format!("Apple Music data was malformed: {error}"))?;

    // Apple Music always wraps the response in a top-level `data` array,
    // even though the page we land on only ever shows one entry.
    let data = root
        .get("data")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .ok_or_else(|| "Apple Music page didn't include any playlist sections.".to_string())?;

    let inner = data.get("data").ok_or_else(|| {
        "Apple Music page didn't include the playlist payload. Make sure it's a public playlist."
            .to_string()
    })?;

    let sections = inner
        .get("sections")
        .and_then(Value::as_array)
        .ok_or_else(|| "Apple Music playlist payload didn't include sections.".to_string())?;

    // The header section is always first; the track list lives in the
    // first section whose `itemKind` is `trackLockup`. Apple has started
    // inserting unrelated sections (artist recommendations, "featured
    // artists", etc.) after the tracks, so we can't just take section[1].
    let mut header: Option<&Value> = None;
    let mut track_section: Option<&Value> = None;
    for section in sections {
        let kind = section.get("itemKind").and_then(Value::as_str);
        match kind {
            Some("containerDetailHeaderLockup") if header.is_none() => header = Some(section),
            Some("trackLockup") if track_section.is_none() => track_section = Some(section),
            _ => {}
        }
    }

    let title = header
        .and_then(|section| section.get("items"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("title"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported playlist".to_string());

    let cover_url = header
        .and_then(|section| section.get("items"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("artwork"))
        .and_then(|art| art.get("dictionary"))
        .and_then(|dict| dict.get("url"))
        .and_then(Value::as_str)
        .map(|template| {
            // The artwork URL ships as a template: .../{w}x{h}bb.{f}.
            // Substitute a fixed 600x600 so the existing artwork cache
            // picks a single, reasonable resolution regardless of how
            // many hits the CDN might have.
            template
                .replace("{w}", "600")
                .replace("{h}", "600")
                .replace("{f}", "jpg")
        });

    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::new();
    if let Some(section) = track_section {
        if let Some(items) = section.get("items").and_then(Value::as_array) {
            for item in items {
                let Some(track_title) = item
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let artists: Vec<String> = item
                    .get("subtitleLinks")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|link| link.get("title").and_then(Value::as_str))
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                let artist = if artists.is_empty() {
                    // Some Apple Music tracks omit subtitleLinks but keep
                    // a flat `artistName` field. Fall back to that before
                    // dropping the track entirely.
                    item.get("artistName")
                        .and_then(Value::as_str)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                } else {
                    Some(artists.join(", "))
                };
                let Some(artist) = artist else { continue };
                let album = item
                    .get("tertiaryLinks")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|link| link.get("title"))
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                // Apple Music's `serialized-server-data` JSON ships `trackLockup`
                // durations in MILLISECONDS (e.g. 208000 for a 3:28 song, 101748
                // for a 1:41 song). Feeding that value straight into
                // `duration_seconds` produced absurd running times on import
                // (3:28 -> 3466:40, 1:41 -> 1695:48, 3:44 -> 3730:54). Divide by
                // 1000 before the cast so a 4-min track reads as 240 seconds = 4:00.
                let duration_seconds = item
                    .get("duration")
                    .and_then(Value::as_f64)
                    .map(|value| (value / 1000.0) as u32)
                    .filter(|value| *value > 0);
                tracks.push(ExternalPlaylistTrack {
                    title: track_title,
                    artist,
                    album,
                    duration_seconds,
                });
            }
        }
    }

    if tracks.is_empty() {
        return Err(
            "We couldn't read any songs from that Apple Music playlist. Some playlists require sign-in or are region-locked."
                .to_string(),
        );
    }

    Ok(ExternalPlaylistImport {
        service: "apple".to_string(),
        title,
        description: None,
        cover_url,
        tracks,
    })
}
// yt-dlp's `uploader` for YT Music channels often reads
#[tauri::command]
async fn ensure_streaming_backend(app: AppHandle) -> Result<BackendStatus, String> {
    let path = ensure_yt_dlp(&app).await?;
    // MP3 exports need ffmpeg; warming it during backend setup avoids a
    // long "Saving…" stall on the user's first right-click export while
    // the portable bundle downloads.
    let _ = ensure_ffmpeg(&app).await;
    let version = yt_dlp_version(&path).await.ok();
    Ok(BackendStatus {
        yt_dlp_ready: true,
        yt_dlp_path: Some(path.to_string_lossy().to_string()),
        yt_dlp_version: version,
    })
}

#[tauri::command]
async fn search_music(state: State<'_, AppState>, query: String) -> Result<SearchResponse, String> {
    let payload = json!({ "query": query });
    let response = post_ytmusic(&state, "search", payload).await?;
    Ok(parse_search_response(&query, &response))
}

#[tauri::command]
async fn search_suggestions(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchSuggestion>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let payload = json!({ "input": trimmed });
    let response = post_ytmusic(&state, "music/get_search_suggestions", payload).await?;
    Ok(parse_search_suggestions(&response))
}

#[tauri::command]
async fn cache_artwork(app: AppHandle, url: String) -> Result<String, String> {
    cache_remote_artwork(&app, &url).await
}

#[tauri::command]
async fn get_entity_detail(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<EntityDetail, String> {
    let response = post_ytmusic(&state, "browse", json!({ "browseId": browse_id })).await?;
    Ok(parse_entity_detail(&browse_id, &response)?)
}

fn parse_playlist_panel_video(value: &Value) -> Option<MediaTrack> {
    let video = value.get("playlistPanelVideoRenderer")?;
    let video_id = video.get("videoId").and_then(Value::as_str)?.to_string();
    let title = video.get("title").and_then(text_from_value)?;
    let byline_value = video
        .get("longBylineText")
        .or_else(|| video.get("shortBylineText"))?;
    let parsed_runs = extract_run_meta_from_runs(byline_value);
    // Drop podcast episodes and other non-music media at parse time. Music
    // videos (`kind == "video"`) are kept; the React layer resolves them to
    // studio song uploads by name.
    let byline = text_from_value(byline_value).unwrap_or_default();
    let meta_parts = split_bullets_fixed(&byline);
    let kind_label = effective_type_label(
        parsed_runs.type_label.as_deref(),
        meta_parts.first().map(String::as_str),
    );
    let normalized_kind = normalize_kind(kind_label, false, true);
    if normalized_kind == "unknown" {
        return None;
    }
    let artist = parsed_runs.artist_text.unwrap_or_else(|| {
        infer_artist_from_text(&byline, true).unwrap_or_else(|| "Unknown artist".to_string())
    });
    let album = parsed_runs.album_text.filter(|value| parse_duration(value).is_none()).or_else(|| {
        let parts = &meta_parts;
        // Reject any bullet-segment that looks like a duration ("3:45", "12:30:01")
        // so the Album column never inherits a track's running time when the
        // structured byline didn't carry an album link. Without this filter the
        // fallback `parts.get(1)` happily grabbed "3:45" for songs whose byline
        // shape was "Artist • 3:45", producing the visible "duration duplicated
        // into the Album column" bug on imported playlists.
        match parts.get(1).cloned() {
            Some(value) if parse_duration(&value).is_some() => None,
            other => other,
        }
    });
    let artist_browse_id = parsed_runs
        .artist_browse_id
        .clone()
        .or_else(|| extract_artist_browse_id_from_menu(video, Some(&artist)));
    let duration_seconds = video
        .get("lengthText")
        .and_then(text_from_value)
        .and_then(|value| parse_duration(&value));
    let play_count = extract_play_count_from_row(video);
    let album_browse_id = parsed_runs
        .album_browse_id
        .or_else(|| extract_album_browse_id_from_menu(video));

    Some(MediaTrack {
        id: track_id(&video_id, album_browse_id.as_deref()),
        kind: Some(normalized_kind),
        title,
        artist,
        album,
        album_browse_id,
        artist_browse_id,
        artist_credits: (!parsed_runs.artist_credits.is_empty())
            .then_some(parsed_runs.artist_credits),
        duration_seconds,
        play_count,
        cover: best_thumbnail(video),
        video_id: Some(video_id),
        source: "stream",
        audio_src: None,
        file_path: None,
        find_lyrics: false,
    })
}

fn extract_watch_playlist(value: &Value, seed_video_id: Option<&str>) -> (Vec<MediaTrack>, Option<String>) {
    // The queue has appeared under more than one watch-page layout. Find the
    // renderer itself instead of depending on one brittle wrapper path.
    fn find_panel(value: &Value) -> Option<&Value> {
        if let Some(panel) = value.get("playlistPanelRenderer") {
            return Some(panel);
        }
        match value {
            Value::Array(items) => items.iter().find_map(find_panel),
            Value::Object(map) => map.values().find_map(find_panel),
            _ => None,
        }
    }

    let panel = match find_panel(value) {
        Some(panel) => panel,
        None => return (Vec::new(), None),
    };

    let playlist_id = panel
        .get("playlistId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());

    let items = panel
        .get("contents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // The watch-page queue and the import path both consume this
    // function. The watch-page use case wants to drop the currently-
    // playing seed video so the autoplay queue doesn't start with the
    // track the user is already listening to. The import use case
    // wants every track in the playlist, INCLUDING the seed (which
    // is just the playlist's first video). `Some(seed)` filters;
    // `None` keeps everything.
    let mut tracks: Vec<MediaTrack> = items
        .iter()
        .filter_map(parse_playlist_panel_video)
        .collect();
    if let Some(seed) = seed_video_id {
        tracks.retain(|track| track.video_id.as_deref() != Some(seed));
    }

    (tracks, playlist_id)
}

#[tauri::command]
async fn get_artist_detail(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<ArtistDetail, String> {
    let response = post_ytmusic(&state, "browse", json!({ "browseId": browse_id })).await?;
    let mut detail = parse_artist_detail(&browse_id, &response)?;
    let has_more_hint = extract_top_songs_continuation(&response).is_some()
        || artist_overview_sections(&response)
            .and_then(top_songs_shelf)
            .and_then(top_songs_playlist_browse_id)
            .is_some();
    let extended =
        load_extended_artist_top_songs(&state, &response, &detail.title, detail.cover.as_deref())
            .await?;
    if extended.len() > detail.top_songs.len() {
        detail.top_songs = extended;
    }
    detail.top_songs.truncate(ARTIST_TOP_SONG_LIMIT);
    detail.top_songs_has_more = detail.top_songs.len() < ARTIST_TOP_SONG_LIMIT && has_more_hint;
    Ok(detail)
}

#[tauri::command]
async fn get_artist_top_songs_extended(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<Vec<MediaTrack>, String> {
    let response = post_ytmusic(&state, "browse", json!({ "browseId": browse_id })).await?;
    let detail = parse_artist_detail(&browse_id, &response)?;
    let mut tracks =
        load_extended_artist_top_songs(&state, &response, &detail.title, detail.cover.as_deref())
            .await?;
    tracks.truncate(ARTIST_TOP_SONG_LIMIT);
    Ok(tracks)
}

async fn load_extended_artist_top_songs(
    state: &State<'_, AppState>,
    artist_response: &Value,
    artist_title: &str,
    cover: Option<&str>,
) -> Result<Vec<MediaTrack>, String> {
    let sections = match artist_overview_sections(artist_response) {
        Some(sections) => sections,
        None => return Ok(Vec::new()),
    };
    let shelf = match top_songs_shelf(sections) {
        Some(shelf) => shelf,
        None => return Ok(Vec::new()),
    };

    let mut tracks =
        fetch_shelf_tracks_with_continuations(state, shelf, artist_title, cover, ARTIST_TOP_SONG_LIMIT)
            .await?;

    if tracks.len() < ARTIST_TOP_SONG_LIMIT {
        if let Some(playlist_browse_id) = top_songs_playlist_browse_id(shelf) {
            let playlist_response =
                post_ytmusic(state, "browse", json!({ "browseId": playlist_browse_id })).await?;
            if let Some(playlist_shelf) = find_track_shelf_in_browse_response(&playlist_response) {
                let playlist_tracks = fetch_shelf_tracks_with_continuations(
                    state,
                    playlist_shelf,
                    artist_title,
                    cover,
                    ARTIST_TOP_SONG_LIMIT,
                )
                .await?;
                merge_top_songs(&mut tracks, playlist_tracks, ARTIST_TOP_SONG_LIMIT);
            }
        }
    }

    Ok(tracks)
}

#[tauri::command]
async fn get_artist_monthly_listeners(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<Option<String>, String> {
    for attempt in 0..ARTIST_MONTHLY_LISTENERS_MAX_ATTEMPTS {
        let is_last_attempt = attempt + 1 == ARTIST_MONTHLY_LISTENERS_MAX_ATTEMPTS;
        match fetch_artist_monthly_listeners_once(&state, &browse_id).await {
            Ok(Some(value)) => {
                // Reject empty/whitespace-only results so a malformed response
                // doesn't masquerade as a real count.
                if !value.trim().is_empty() {
                    return Ok(Some(value));
                }
            }
            Ok(None) => {
                // No listener count parsed from this response; fall through to
                // the next attempt unless we're out of attempts.
            }
            Err(error) => {
                if is_last_attempt {
                    return Err(error);
                }
            }
        }
        if !is_last_attempt {
            let delay_ms = ARTIST_MONTHLY_LISTENERS_RETRY_BACKOFF_MS[attempt as usize];
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
    }
    Ok(None)
}

async fn fetch_artist_monthly_listeners_once(
    state: &State<'_, AppState>,
    browse_id: &str,
) -> Result<Option<String>, String> {
    let response = post_ytmusic(state, "browse", json!({ "browseId": browse_id })).await?;
    Ok(extract_monthly_listeners_from_response(&response))
}

fn extract_monthly_listeners_from_response(value: &Value) -> Option<String> {
    // Strategy 1: the well-known immersive header field. Most responses put
    // the count directly under `header.musicImmersiveHeaderRenderer`.
    if let Some(s) = value
        .get("header")
        .and_then(|h| h.get("musicImmersiveHeaderRenderer"))
        .and_then(|h| h.get("monthlyListenerCount"))
        .and_then(text_from_value)
        .filter(|s| !s.trim().is_empty())
    {
        return Some(s);
    }
    // Strategy 2: walk the response looking for any text leaf that contains
    // "X monthly listener(s)" or "X monthly audience". YouTube Music has
    // shifted this field across InnerTube layout releases, so the canonical
    // path isn't always present. Capped by the retry loop above.
    if let Some(s) = find_monthly_listener_phrase_in_response(value) {
        return Some(s);
    }
    None
}

fn find_monthly_listener_phrase_in_response(value: &Value) -> Option<String> {
    let mut out: Option<String> = None;
    visit_for_monthly_listener(value, &mut out);
    out
}

fn visit_for_monthly_listener(value: &Value, out: &mut Option<String>) {
    if out.is_some() {
        return;
    }
    if let Some(text) = text_from_value(value) {
        if let Some(extracted) = parse_monthly_listener_phrase(&text) {
            *out = Some(extracted);
            return;
        }
    }
    match value {
        Value::Array(items) => {
            for item in items {
                if out.is_some() {
                    return;
                }
                visit_for_monthly_listener(item, out);
            }
        }
        Value::Object(map) => {
            for (_, item) in map {
                if out.is_some() {
                    return;
                }
                visit_for_monthly_listener(item, out);
            }
        }
        _ => {}
    }
}

fn parse_monthly_listener_phrase(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let needles = ["monthly listeners", "monthly audience", "monthly listener"];
    let idx = needles.iter().filter_map(|needle| lower.find(needle)).min()?;
    // Walk left from the needle to extract the leading number (e.g. "85.7M",
    // "758K", "5,890,348"). Stop at the first non-numeric character.
    let prefix = text[..idx].trim_end();
    let mut start: Option<usize> = None;
    let end = prefix.len();
    for (i, ch) in prefix.char_indices().rev() {
        let is_count_char = matches!(
            ch,
            '0'..='9' | '.' | ',' | 'K' | 'k' | 'M' | 'm' | 'B' | 'b'
        );
        if is_count_char {
            start = Some(i);
        } else {
            break;
        }
    }
    let start = start?;
    let token = &prefix[start..end];
    if token.trim().is_empty() {
        return None;
    }
    Some(format!("{token} monthly listeners"))
}

async fn fetch_track_duration(
    state: &State<'_, AppState>,
    video_id: &str,
) -> Result<Option<u32>, String> {
    {
        let cache = state.track_duration_cache.lock().await;
        if let Some(entry) = cache.get(video_id) {
            if entry.fetched_at.elapsed() < TRACK_DURATION_CACHE_TTL {
                return Ok(entry.duration);
            }
        }
    }

    let response = post_ytmusic(state, "next", watch_next_payload(video_id, None)).await?;
    let (tracks, _) = extract_watch_playlist(&response, Some(video_id));
    let duration = tracks
        .iter()
        .find(|t| t.video_id.as_deref() == Some(video_id))
        .or(tracks.first())
        .and_then(|t| t.duration_seconds);

    let mut cache = state.track_duration_cache.lock().await;
    cache.retain(|_, entry| entry.fetched_at.elapsed() < TRACK_DURATION_CACHE_TTL);
    cache.insert(
        video_id.to_string(),
        CachedTrackDuration {
            duration,
            fetched_at: Instant::now(),
        },
    );
    Ok(duration)
}

#[tauri::command]
async fn get_track_duration(
    state: State<'_, AppState>,
    video_id: String,
) -> Result<Option<u32>, String> {
    fetch_track_duration(&state, &video_id).await
}

fn find_playlist_panel_video_renderer<'a>(value: &'a Value, video_id: &str) -> Option<&'a Value> {
    if value
        .get("playlistPanelVideoRenderer")
        .and_then(|renderer| renderer.get("videoId"))
        .and_then(Value::as_str)
        == Some(video_id)
    {
        return Some(value);
    }

    match value {
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_playlist_panel_video_renderer(item, video_id)),
        Value::Object(map) => map
            .values()
            .find_map(|item| find_playlist_panel_video_renderer(item, video_id)),
        _ => None,
    }
}

fn watch_playlist_cache_key(video_id: &str, playlist_id: Option<&str>) -> String {
    match playlist_id {
        Some(id) if !id.is_empty() => format!("{video_id}|{id}"),
        _ => video_id.to_string(),
    }
}

fn cleanup_expired_stream_cache(cache: &mut HashMap<String, CachedStream>) {
    cache.retain(|_, entry| {
        entry.fetched_at.elapsed() < STREAM_CACHE_TTL && Path::new(&entry.source).exists()
    });
}

fn cleanup_expired_watch_playlist_cache(cache: &mut HashMap<String, CachedWatchPlaylist>) {
    cache.retain(|_, entry| entry.fetched_at.elapsed() < WATCH_PLAYLIST_CACHE_TTL);
}

async fn find_disk_stream_cache(cache_dir: &Path, video_id: &str) -> Option<String> {
    let mut entries = tokio::fs::read_dir(cache_dir).await.ok()?;
    let prefix = format!("{video_id}.");
    let cutoff = SystemTime::now() - STREAM_CACHE_TTL;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            continue;
        }
        return Some(path.to_string_lossy().to_string());
    }
    None
}

async fn cleanup_old_stream_cache_files(cache_dir: &Path) -> Result<(), String> {
    let mut entries = tokio::fs::read_dir(cache_dir)
        .await
        .map_err(|error| format!("Failed to read stream cache folder: {error}"))?;
    let cutoff = SystemTime::now() - STREAM_CACHE_TTL;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to inspect stream cache entry: {error}"))?
    {
        let path = entry.path();
        let Ok(metadata) = entry.metadata().await else { continue };
        if metadata.is_file()
            && metadata
                .modified()
                .map(|modified| modified < cutoff)
                .unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_watch_playlist(
    state: State<'_, AppState>,
    video_id: String,
    playlist_id: Option<String>,
) -> Result<WatchPlaylistResponse, String> {
    let key = watch_playlist_cache_key(&video_id, playlist_id.as_deref());
    {
        let cache = state.watch_playlist_cache.lock().await;
        if let Some(entry) = cache.get(&key) {
            if entry.fetched_at.elapsed() < WATCH_PLAYLIST_CACHE_TTL {
                return Ok(WatchPlaylistResponse {
                    tracks: entry.tracks.clone(),
                    playlist_id: entry.playlist_id.clone(),
                });
            }
        }
    }

    let payload = watch_next_payload(&video_id, playlist_id.as_deref());

    let response = post_ytmusic(&state, "next", payload).await?;
    let (tracks, next_playlist_id) = extract_watch_playlist(&response, Some(&video_id));

    let trimmed_tracks: Vec<MediaTrack> = tracks.into_iter().take(25).collect();

    let resolved_playlist_id = next_playlist_id.or(playlist_id);

    if !trimmed_tracks.is_empty() {
        let mut cache = state.watch_playlist_cache.lock().await;
        cleanup_expired_watch_playlist_cache(&mut cache);
        cache.insert(
            key,
            CachedWatchPlaylist {
                tracks: trimmed_tracks.clone(),
                playlist_id: resolved_playlist_id.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(WatchPlaylistResponse {
        tracks: trimmed_tracks,
        playlist_id: resolved_playlist_id,
    })
}

#[tauri::command]
async fn resolve_track_album(
    state: State<'_, AppState>,
    video_id: String,
) -> Result<TrackAlbumResolution, String> {
    let payload = watch_next_payload(&video_id, None);
    let response = post_ytmusic(&state, "next", payload).await?;
    let track = find_playlist_panel_video_renderer(&response, &video_id)
        .and_then(parse_playlist_panel_video);
    Ok(TrackAlbumResolution {
        album_browse_id: track.as_ref().and_then(|t| t.album_browse_id.clone()),
        album: track.as_ref().and_then(|t| t.album.clone()),
        artist_browse_id: track.as_ref().and_then(|t| t.artist_browse_id.clone()),
    })
}

#[tauri::command]
async fn get_synced_lyrics(
    app: AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> Result<Option<SyncedLyricsResponse>, String> {
    let cached_meta = find_cached_lyric_track(&state, &video_id).await;

    // Always hit `next` for stream tracks so we can reach YouTube Music's
    // native timed lyrics (same clock as playback). Metadata still comes
    // from the watch-playlist cache when available.
    let next_response = post_ytmusic(&state, "next", watch_next_payload(&video_id, None)).await.ok();

    let seed_meta = cached_meta.clone().or_else(|| {
        next_response
            .as_ref()
            .and_then(|response| extract_seed_lyric_track(response, &video_id))
    });

    let meta = seed_meta.as_ref().filter(|meta| {
        !meta.title.trim().is_empty() && !meta.artist.trim().is_empty()
    });

    let Some(meta) = meta else {
        return Ok(None);
    };

    let mut ctx = lyrics::build_resolve_context(
        &app,
        &state.stream_cache,
        STREAM_CACHE_TTL,
        Some(&video_id),
    )
    .await;
    ctx.next_response = next_response.clone();

    let ytm_lyrics = match next_response.as_ref().and_then(lyrics::extract_lyrics_browse_id_from_next) {
        Some(browse_id) => fetch_ytm_timed_lyrics_browse(&state, &browse_id).await.ok(),
        None => None,
    };

    Ok(lyrics::resolve_synced_lyrics(&lyrics_deps(&state), meta, &ctx, ytm_lyrics).await)
}

#[tauri::command]
async fn get_synced_lyrics_by_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
    artist: String,
    album: Option<String>,
    duration_seconds: Option<u32>,
    video_id: Option<String>,
) -> Result<Option<SyncedLyricsResponse>, String> {
    let meta = LyricTrack {
        title,
        artist,
        album,
        duration_seconds,
    };

    if meta.title.trim().is_empty() || meta.artist.trim().is_empty() {
        return Ok(None);
    }

    let ctx = lyrics::build_resolve_context(
        &app,
        &state.stream_cache,
        STREAM_CACHE_TTL,
        video_id.as_deref(),
    )
    .await;

    Ok(lyrics::resolve_synced_lyrics(&lyrics_deps(&state), &meta, &ctx, None).await)
}

fn lyrics_deps<'a>(state: &'a State<'_, AppState>) -> lyrics::LyricsDeps<'a> {
    lyrics::LyricsDeps {
        http: &HTTP,
        http_no_redirect: &HTTP_NO_REDIRECT,
        user_agent: USER_AGENT,
        musixmatch_token: &state.musixmatch_token,
    }
}

async fn fetch_ytm_timed_lyrics_browse(
    state: &State<'_, AppState>,
    browse_id: &str,
) -> Result<SyncedLyricsResponse, String> {
    let response = post_ytmusic_with_client(
        state,
        "browse",
        json!({ "browseId": browse_id }),
        "ANDROID_MUSIC",
        lyrics::ANDROID_MUSIC_CLIENT_VERSION,
        None,
    )
    .await?;
    lyrics::parse_ytm_timed_lyrics_response(&response)
        .ok_or_else(|| "YouTube Music returned no timed lyrics.".to_string())
}

async fn find_cached_lyric_track(
    state: &State<'_, AppState>,
    video_id: &str,
) -> Option<LyricTrack> {
    let cache = state.watch_playlist_cache.lock().await;
    for entry in cache.values() {
        if let Some(track) = entry
            .tracks
            .iter()
            .find(|track| track.video_id.as_deref() == Some(video_id))
        {
            return Some(lyric_track_from_media(track));
        }
    }
    None
}

fn extract_seed_lyric_track(value: &Value, video_id: &str) -> Option<LyricTrack> {
    let renderer = find_playlist_panel_video_renderer(value, video_id)?;
    let track = parse_playlist_panel_video(renderer)?;
    Some(lyric_track_from_media(&track))
}

fn lyric_track_from_media(track: &MediaTrack) -> LyricTrack {
    LyricTrack {
        title: track.title.clone(),
        artist: track.artist.clone(),
        album: track.album.clone(),
        duration_seconds: track.duration_seconds,
    }
}

#[tauri::command]
async fn resolve_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> Result<StreamResponse, String> {
    {
        let cache = state.stream_cache.lock().await;
        if let Some(entry) = cache.get(&video_id) {
            if entry.fetched_at.elapsed() < STREAM_CACHE_TTL && Path::new(&entry.source).exists() {
                return Ok(StreamResponse {
                    url: None,
                    file_path: Some(entry.source.clone()),
                });
            }
        }
    }

    let yt_dlp = ensure_yt_dlp(&app).await?;
    let watch_url = format!("https://music.youtube.com/watch?v={video_id}");
    let cache_dir = stream_cache_dir(&app)?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("Failed to create stream cache folder: {error}"))?;
    // Best-effort janitor: purge stale files and in-memory entries before
    // downloading so the cache can't grow without bound over a long session.
    let _ = cleanup_old_stream_cache_files(&cache_dir).await;
    {
        let mut cache = state.stream_cache.lock().await;
        cleanup_expired_stream_cache(&mut cache);
    }

    if let Some(file_path) = find_disk_stream_cache(&cache_dir, &video_id).await {
        let mut cache = state.stream_cache.lock().await;
        cleanup_expired_stream_cache(&mut cache);
        cache.insert(
            video_id.clone(),
            CachedStream {
                source: file_path.clone(),
                fetched_at: Instant::now(),
            },
        );
        return Ok(StreamResponse {
            url: None,
            file_path: Some(file_path),
        });
    }

    remove_cached_streams(&cache_dir, &video_id).await?;

    let output_template = cache_dir.join(format!("{video_id}.%(ext)s"));
    let output_template = output_template.to_string_lossy().to_string();
    let output = run_command(
        &yt_dlp,
        [
            "-f",
            "bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--no-progress",
            "--no-part",
            "--force-overwrites",
            "--print",
            "after_move:filepath",
            "-o",
            &output_template,
            &watch_url,
        ],
    )
    .await?;
    let file_path = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .filter(|line| Path::new(line).exists())
        .ok_or_else(|| "yt-dlp did not return a playable audio file.".to_string())?
        .to_string();

    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|error| format!("Failed to inspect cached audio: {error}"))?;
    if metadata.len() == 0 {
        return Err("The downloaded audio file was empty.".to_string());
    }

    {
        let mut cache = state.stream_cache.lock().await;
        cleanup_expired_stream_cache(&mut cache);
        cache.insert(
            video_id,
            CachedStream {
                source: file_path.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(StreamResponse {
        url: None,
        file_path: Some(file_path),
    })
}

async fn remove_cached_streams(cache_dir: &Path, video_id: &str) -> Result<(), String> {
    let mut entries = tokio::fs::read_dir(cache_dir)
        .await
        .map_err(|error| format!("Failed to read stream cache folder: {error}"))?;
    let prefix = format!("{video_id}.");
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to inspect stream cache entry: {error}"))?
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to clear old cached audio {}: {error}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

pub(crate) fn stream_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("streams"))
}

fn offline_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("offline"))
}

async fn find_offline_file(dir: &Path, video_id: &str) -> Option<PathBuf> {
    let prefix = format!("{video_id}.");
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    while let Some(entry) = entries.next_entry().await.ok()? {
        let path = entry.path();
        let name = path.file_name().and_then(|v| v.to_str())?;
        if name.starts_with(&prefix) && path.is_file() {
            return Some(path);
        }
    }
    None
}

async fn remove_offline_video(dir: &Path, video_id: &str) -> Result<(), String> {
    let prefix = format!("{video_id}.");
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|error| format!("Failed to read offline folder: {error}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to inspect offline entry: {error}"))?
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!("Failed to remove offline file {}: {e}", path.display()))
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn save_offline(app: AppHandle, video_id: String) -> Result<(), String> {
    let offline = offline_dir(&app)?;
    tokio::fs::create_dir_all(&offline)
        .await
        .map_err(|error| format!("Failed to create offline folder: {error}"))?;

    // Already downloaded — skip.
    if find_offline_file(&offline, &video_id).await.is_some() {
        return Ok(());
    }

    let yt_dlp = ensure_yt_dlp(&app).await?;
    let watch_url = format!("https://music.youtube.com/watch?v={video_id}");
    remove_offline_video(&offline, &video_id).await?;

    let output_template = offline.join(format!("{video_id}.%(ext)s"));
    let output_template = output_template.to_string_lossy().to_string();
    let output = run_command_with_timeout(
        &yt_dlp,
        [
            "-f",
            "bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--no-progress",
            "--no-part",
            "--force-overwrites",
            "--print",
            "after_move:filepath",
            "-o",
            &output_template,
            &watch_url,
        ],
        YT_DLP_DOWNLOAD_TIMEOUT,
    )
    .await?;

    let file_path = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .filter(|line| Path::new(line).exists())
        .ok_or_else(|| "yt-dlp did not return a playable audio file.".to_string())?;

    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|error| format!("Failed to inspect downloaded audio: {error}"))?;
    if metadata.len() == 0 {
        return Err("The downloaded audio file was empty.".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn remove_offline(app: AppHandle, video_id: String) -> Result<(), String> {
    let offline = offline_dir(&app)?;
    remove_offline_video(&offline, &video_id).await
}

#[tauri::command]
async fn load_all_user_data(
    app: AppHandle,
) -> Result<HashMap<String, String>, String> {
    data_store::load_all(&app).await
}

#[tauri::command]
async fn write_user_data(
    app: AppHandle,
    key: String,
    data: String,
) -> Result<(), String> {
    data_store::write(&app, &key, &data).await
}

#[tauri::command]
async fn delete_user_data(
    app: AppHandle,
    key: String,
) -> Result<(), String> {
    data_store::delete(&app, &key).await
}

#[tauri::command]
async fn clear_all_user_data_backend(
    app: AppHandle,
) -> Result<(), String> {
    data_store::clear_all(&app).await
}

#[tauri::command]
async fn get_offline_path(app: AppHandle, video_id: String) -> Result<Option<String>, String> {
    let offline = offline_dir(&app)?;
    if !offline.exists() {
        return Ok(None);
    }
    let path = find_offline_file(&offline, &video_id).await;
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn list_offline(app: AppHandle) -> Result<Vec<String>, String> {
    let offline = offline_dir(&app)?;
    if !offline.exists() {
        return Ok(Vec::new());
    }
    let mut entries = tokio::fs::read_dir(&offline)
        .await
        .map_err(|error| format!("Failed to read offline folder: {error}"))?;
    let mut ids = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to inspect offline entry: {error}"))?
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        // Extract videoId from "{videoId}.ext"
        if let Some(dot) = name.rfind('.') {
            let id = &name[..dot];
            if !id.is_empty() {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

#[tauri::command]
async fn clear_all_offline(app: AppHandle) -> Result<(), String> {
    let offline = offline_dir(&app)?;
    if !offline.exists() {
        return Ok(());
    }
    let mut entries = tokio::fs::read_dir(&offline)
        .await
        .map_err(|error| format!("Failed to read offline folder: {error}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to inspect offline entry: {error}"))?
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!("Failed to remove offline file {}: {e}", path.display()))
            }
        }
    }
    Ok(())
}

// ── Save-to-device exports ───────────────────────────────────────────────
//
// The two commands below let the right-click context menu export a track
// or full album as MP3 + ID3-tagged files into a user-chosen location.
//
// The track command is the atomic unit — the album command just calls it
// once per track after building the album folder. Both end up at
// `save_track_to_mp3_inner` (a free async fn rather than a `#[command]`
// command) so the album path can re-use it without re-entering through
// Tauri's IPC layer.
//
// Why an inner function instead of just calling the `#[command]` directly?
// Tauri's `#[command]` macro only generates the IPC bridge; the body is
// still a regular async fn. But we want the album flow to call this from
// Rust without paying the cost (and noise) of going through `app.run`
// again. The split keeps the public command surface clean and the inner
// helper testable / composable.

/// Sanitize a file/folder name for cross-platform FS safety. Strips path
/// separators and reserved characters and trims trailing dots/spaces
/// (Windows hates both). Returns `"Untitled"` for empty input.
fn sanitize_filename(name: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut out: String = name
        .chars()
        .filter(|c| !invalid.contains(c) && (*c as u32) > 0x1F)
        .collect();
    while out.ends_with(' ') || out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        out = "Untitled".to_string();
    }
    // Windows reserves a few whole names regardless of case; prefixing
    // avoids accidentally shadowing CON / PRN / NUL etc.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&out)) {
        out.push('_');
    }
    // Cap at a reasonable length so a 4KB title doesn't blow the FS limit.
    if out.len() > 200 {
        out.truncate(200);
    }
    out
}

/// Ensure `dir` exists. Creates intermediate directories as needed.
async fn ensure_dir(dir: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| format!("Failed to create folder {}: {error}", dir.display()))
}

/// Find a non-clobbering destination filename inside `dir`. If
/// `{stem}.mp3` already exists, appends ` (2)`, ` (3)`, etc. Also strips
/// any existing extension on `stem` and forces `.mp3`.
async fn unique_mp3_path(dir: &Path, stem: &str) -> Result<PathBuf, String> {
    let cleaned_stem = sanitize_filename(stem);
    let mut candidate = dir.join(format!("{cleaned_stem}.mp3"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for n in 2.. {
        candidate = dir.join(format!("{cleaned_stem} ({n}).mp3"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    // Unreachable: the loop always returns. Still, keep the compiler happy.
    Err("Could not allocate a unique file name.".to_string())
}

fn collect_export_video_ids(primary: &str, fallbacks: &[String]) -> Vec<String> {
    let mut ids = Vec::new();
    let mut push = |id: &str| {
        if !id.is_empty() && !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    };
    push(primary);
    for id in fallbacks {
        push(id);
    }
    ids
}

async fn cached_audio_file_valid(path: &Path) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    metadata.is_file() && metadata.len() > 0
}

/// Reuse audio Velocity already downloaded for playback (stream cache or
/// offline save) before shelling out to yt-dlp again.
async fn find_cached_audio_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    video_ids: &[String],
) -> Option<PathBuf> {
    {
        let cache = state.stream_cache.lock().await;
        for id in video_ids {
            if let Some(entry) = cache.get(id) {
                if entry.fetched_at.elapsed() < STREAM_CACHE_TTL {
                    let path = PathBuf::from(&entry.source);
                    if cached_audio_file_valid(&path).await {
                        return Some(path);
                    }
                }
            }
        }
    }

    if let Ok(offline) = offline_dir(app) {
        if offline.exists() {
            for id in video_ids {
                if let Some(path) = find_offline_file(&offline, id).await {
                    if cached_audio_file_valid(&path).await {
                        return Some(path);
                    }
                }
            }
        }
    }

    if let Ok(cache_dir) = stream_cache_dir(app) {
        for id in video_ids {
            if let Some(path) = find_disk_stream_cache(&cache_dir, id).await {
                let path = PathBuf::from(path);
                if cached_audio_file_valid(&path).await {
                    return Some(path);
                }
            }
        }
    }

    None
}

async fn convert_cached_audio_to_mp3(
    app: &AppHandle,
    source: &Path,
    target_path: &Path,
) -> Result<PathBuf, String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| "Target path has no parent directory.".to_string())?;
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Could not derive a file stem from the target path.".to_string())?;
    let temp_mp3 = parent.join(format!(".velocity-export-{stem}.tmp.mp3"));

    let is_mp3 = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("mp3"))
        .unwrap_or(false);
    if is_mp3 {
        tokio::fs::copy(source, &temp_mp3)
            .await
            .map_err(|error| format!("Failed to copy cached audio: {error}"))?;
        return Ok(temp_mp3);
    }

    let ffmpeg = ensure_ffmpeg(app).await?;
    let source_arg = source.to_string_lossy().to_string();
    let output_arg = temp_mp3.to_string_lossy().to_string();
    let mut command = Command::new(&ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        &source_arg,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "0",
        &output_arg,
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&temp_mp3).await;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffmpeg failed to convert cached audio to MP3.".to_string()
        } else {
            stderr
        });
    }
    if !cached_audio_file_valid(&temp_mp3).await {
        let _ = tokio::fs::remove_file(&temp_mp3).await;
        return Err("ffmpeg produced an empty MP3 file.".to_string());
    }
    Ok(temp_mp3)
}

/// Produce a tagged-ready MP3 temp file for export. Consults cached
/// playback/offline audio first, then walks the supplied video ids
/// through yt-dlp until one succeeds.
async fn acquire_export_mp3(
    app: &AppHandle,
    state: &State<'_, AppState>,
    video_ids: &[String],
    target: &Path,
    cancel_rx: &mut Option<&mut oneshot::Receiver<()>>,
) -> Result<PathBuf, String> {
    if !video_ids.is_empty() {
        if let Some(source) = find_cached_audio_source(app, state, video_ids).await {
            if let Ok(produced) = convert_cached_audio_to_mp3(app, &source, target).await {
                return Ok(produced);
            }
        }
    }

    let yt_dlp = ensure_yt_dlp(app).await?;
    let mut last_error = "No streamable video id was provided.".to_string();
    for video_id in video_ids {
        let attempt = download_track_mp3(app, &yt_dlp, video_id, target);
        let result = if let Some(rx) = cancel_rx.as_mut() {
            tokio::select! {
                result = attempt => result,
                _ = &mut **rx => return Err("Save cancelled.".to_string()),
            }
        } else {
            attempt.await
        };
        match result {
            Ok(produced) => return Ok(produced),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Pull a single track through yt-dlp into an MP3 at `target_path`. Used
/// by both the song and album exports.
///
/// The output template yt-dlp uses is intentionally a placeholder name;
/// after yt-dlp returns we don't care about the literal name it used —
/// we re-tag the file with lofty and rename to `target_path` at the end.
async fn download_track_mp3(
    app: &AppHandle,
    yt_dlp: &Path,
    video_id: &str,
    target_path: &Path,
) -> Result<PathBuf, String> {
    let ffmpeg = ensure_ffmpeg(app).await?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "Bundled ffmpeg has no parent directory.".to_string())?
        .to_string_lossy()
        .to_string();
    let watch_url = format!("https://music.youtube.com/watch?v={video_id}");
    let parent = target_path
        .parent()
        .ok_or_else(|| "Target path has no parent directory.".to_string())?;
    // The temp output is named after `target_path`'s stem + `.tmp.mp3`
    // (yt-dlp needs the `.%(ext)s` placeholder in the template to write
    // the post-processed file). We re-tag + rename at the end so the
    // user-visible file lands exactly where they expect.
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Could not derive a file stem from the target path.".to_string())?;
    let temp_template = parent.join(format!(".velocity-export-{stem}-%(ext)s"));
    let temp_template = temp_template.to_string_lossy().to_string();
    // `-x` (extract-audio) plus `--audio-format mp3` walks the standard
    // format postprocessor chain. yt-dlp picks ffmpeg when available
    // (which is the typical case) and falls back to its own remuxer for
    // MP3-in-source cases. `--audio-quality 0` requests best quality.
    // `--no-playlist` because the URL is a single watch URL.
    // `--no-progress` keeps the spawned process quiet so we can capture
    // stdout for the final-path line.
    // `--force-overwrites` lets re-exports land in the same target.
    // We deliberately do NOT pass `--embed-metadata` or
    // `--embed-thumbnail` — we re-tag with lofty afterwards so the
    // user-supplied (and possibly enriched) metadata wins over whatever
    // yt-dlp scraped from the page.
    let output = run_command_with_timeout(
        yt_dlp,
        [
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--ffmpeg-location",
            &ffmpeg_dir,
            "--no-playlist",
            "--no-progress",
            "--no-part",
            "--force-overwrites",
            "--print",
            "after_move:filepath",
            "-o",
            &temp_template,
            &watch_url,
        ],
        YT_DLP_DOWNLOAD_TIMEOUT,
    )
    .await?;
    let produced = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .filter(|line| Path::new(line).exists())
        .ok_or_else(|| {
            "yt-dlp did not produce an MP3 file. Try again in a moment — Velocity may still be setting up ffmpeg."
                .to_string()
        })?
        .to_string();
    Ok(PathBuf::from(produced))
}

/// Apply our authoritative ID3 tag set + cover art to the produced MP3.
/// Reads the freshly-downloaded file, mutates the ID3v2 tag in-place,
/// then writes the result back. We do this in a blocking task because
/// lofty's file ops are sync (and CPU-bound for the thumbnail embed).
async fn tag_mp3(
    produced: &Path,
    title: &str,
    artist: &str,
    album: Option<&str>,
    album_artist: Option<&str>,
    track_number: Option<u32>,
    track_total: Option<u32>,
    year: Option<u32>,
    cover_bytes: Option<Vec<u8>>,
) -> Result<(), String> {
    // The spawned task needs owned data ('static). Copy the small string
    // fields into owned `String`s so the closure can move them in. The
    // cover bytes are already owned.
    let produced = produced.to_path_buf();
    let title = title.to_string();
    let artist = artist.to_string();
    let album = album.map(str::to_string);
    let album_artist = album_artist.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        tag_mp3_blocking(
            &produced,
            &title,
            &artist,
            album.as_deref(),
            album_artist.as_deref(),
            track_number,
            track_total,
            year,
            cover_bytes,
        )
    })
    .await
    .map_err(|error| format!("Tagging task failed to run: {error}"))?
}

fn tag_mp3_blocking(
    path: &Path,
    title: &str,
    artist: &str,
    album: Option<&str>,
    album_artist: Option<&str>,
    track_number: Option<u32>,
    track_total: Option<u32>,
    year: Option<u32>,
    cover_bytes: Option<Vec<u8>>,
) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut mp3 = MpegFile::read_from(&mut file, ParseOptions::new())
        .map_err(|error| format!("Failed to parse MP3 {}: {error}", path.display()))?;
    // Build a fresh ID3v2 tag with the authoritative metadata. Starting
    // from `Id3v2Tag::new()` instead of preserving yt-dlp's own frames
    // means our (possibly enriched) title/artist/album always wins.
    let mut tag = Id3v2Tag::new();
    if !title.is_empty() {
        tag.set_title(title.to_string());
    }
    if !artist.is_empty() {
        tag.set_artist(artist.to_string());
    }
    if let Some(album) = album.filter(|value| !value.is_empty()) {
        tag.set_album(album.to_string());
    }
    // `album_artist` (the TPE2 frame) is the tag most players key off
    // when grouping an album's tracks together under one entry. The
    // generic `Accessor` trait in lofty 0.22 doesn't expose a setter
    // for it, so we hand-insert a `TextInformationFrame` with id
    // `TPE2`. UTF-8 is the ID3v2.4 default and what we want for any
    // modern player.
    if let Some(album_artist) = album_artist.filter(|value| !value.is_empty()) {
        let frame_id = FrameId::new("TPE2")
            .map_err(|error| format!("Failed to build TPE2 frame id: {error}"))?;
        let frame = TextInformationFrame::new(frame_id, TextEncoding::UTF8, album_artist.to_string());
        tag.insert(Frame::Text(frame));
    }
    if let Some(year) = year {
        tag.set_year(year);
    }
    if let Some(track) = track_number {
        tag.set_track(track);
    }
    if let Some(total) = track_total {
        tag.set_track_total(total);
    }
    if let Some(bytes) = cover_bytes {
        // `Picture::new_unchecked` skips the strict validation so we
        // can embed bytes from a non-`http`-served source (we already
        // downloaded them via `cache_remote_artwork` or the HTTP
        // client, so the MIME guess is best-effort). The signature
        // takes `Option<MimeType>`, so wrap our best-effort guess in
        // `Some`. When the signature bytes don't match JPEG/PNG we
        // pass `None` and let lofty try to auto-detect from the data.
        let mime = match infer_cover_mime(&bytes) {
            Some(MimeType::Jpeg) => Some(MimeType::Jpeg),
            Some(MimeType::Png) => Some(MimeType::Png),
            _ => None,
        };
        let picture = Picture::new_unchecked(PictureType::CoverFront, mime, None, bytes);
        tag.insert_picture(picture);
    }
    // Drop any pre-existing ID3v2 tag before re-applying ours so a
    // re-export doesn't keep frames the user removed (e.g. when they
    // re-save without a cover image). The returned `Option` is the
    // removed tag, which we ignore.
    let _ = mp3.remove_id3v2();
    mp3.set_id3v2(tag);
    mp3.save_to_path(path, WriteOptions::default())
        .map_err(|error| format!("Failed to write ID3 tags to {}: {error}", path.display()))?;
    Ok(())
}

fn infer_cover_mime(bytes: &[u8]) -> Option<MimeType> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'] {
        Some(MimeType::Png)
    } else if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        Some(MimeType::Jpeg)
    } else {
        None
    }
}

/// Move the produced temp file to its final destination. If the target
/// already exists we surface a clear error rather than overwriting.
async fn move_to_target(produced: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        // Clean up the temp file before bailing so we don't leak.
        let _ = tokio::fs::remove_file(produced).await;
        return Err(format!(
            "Destination already exists: {}",
            target.display()
        ));
    }
    tokio::fs::rename(produced, target)
        .await
        .map_err(|error| {
            let _ = tokio::fs::remove_file(produced);
            format!(
                "Failed to move exported file to {}: {error}",
                target.display()
            )
        })
}

/// Fetch a cover image into memory, returning the raw bytes.
///
/// Accepts two input shapes:
///   * `https://...` (or `http://...`) URL — we download through the
///     shared HTTP client. The same YouTube-Music-friendly Referer
///     header that `cache_remote_artwork` uses is attached when the
///     source host is `music.youtube.com`, since the CDN rejects
///     requests with the wrong (or no) Referer.
///   * `data:image/...;base64,<...>` data URL — the playlist cover is
///     stored locally as a base64 JPEG by `UserPlaylistsPage`, and
///     re-uploading through the HTTP client would be silly. We just
///     decode the base64 portion here.
///
/// Anything else (relative path, `file://`, etc.) is rejected so we
/// don't accidentally try to read a non-existent local file. Returns
/// `Ok(None)` when the input is `Ok(None)` from the caller (handled
/// by the `Option<String>` ergonomics at the call site).
async fn fetch_cover_bytes(url: &str) -> Result<Option<Vec<u8>>, String> {
    let bytes = fetch_cover_bytes_inner(url).await?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_CACHED_ARTWORK_BYTES {
        return Err("Cover image was too large.".to_string());
    }
    Ok(Some(bytes))
}

async fn fetch_cover_bytes_inner(url: &str) -> Result<Vec<u8>, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    // Data URL — decode the base64 payload directly. We accept any
    // media type the user might have uploaded; lofty's MimeType guess
    // runs after we get here so a non-image bytes will just land
    // without an APIC frame on the track.
    if let Some(stripped) = trimmed
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(','))
    {
        let (meta, payload) = stripped;
        if !meta.contains("base64") {
            return Err("Only base64-encoded data URLs are supported.".to_string());
        }
        return base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|error| format!("Cover data URL was not valid base64: {error}"));
    }
    // Otherwise, treat it as a regular URL. We use `Url::parse` so
    // protocol-relative `//host/...` inputs still get a sane parse
    // after a fallback to https.
    let candidate = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    };
    let parsed = reqwest::Url::parse(&candidate).map_err(|_| "Invalid cover URL.".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Unsupported cover URL.".to_string());
    }
    // YouTube's CDN returns 403 to bare reqwest requests when the
    // Referer doesn't match the music.youtube.com origin. The
    // artwork cache already sends a Referer in that case; mirror the
    // behavior here so "Save to my device" cover fetches don't
    // silently fail on tracks whose cover lives on the YT CDN.
    let needs_youtube_referer = parsed
        .host_str()
        .map(|host| {
            host == "music.youtube.com"
                || host == "youtube.com"
                || host.ends_with(".youtube.com")
                || host.ends_with(".ytimg.com")
                || host.ends_with(".googleusercontent.com")
        })
        .unwrap_or(false);
    let mut request = HTTP.get(parsed);
    if needs_youtube_referer {
        request = request.header(REFERER, HeaderValue::from_static("https://music.youtube.com/"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Cover request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Cover returned HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read cover: {error}"))?
        .to_vec();
    Ok(bytes)
}

async fn save_track_to_mp3_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: SaveTrackToMp3Request,
) -> Result<String, String> {
    let target_dir = PathBuf::from(&request.target_dir);
    if !target_dir.exists() {
        return Err(format!(
            "Destination folder does not exist: {}",
            target_dir.display()
        ));
    }
    if !target_dir.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            target_dir.display()
        ));
    }
    let stem = sanitize_filename(&request.file_name);
    let target = unique_mp3_path(&target_dir, &stem).await?;
    let video_ids = collect_export_video_ids(&request.video_id, &request.fallback_video_ids);

    // Register a cancellation sender for this request. The frontend
    // can interrupt the in-flight work at the next checkpoint by
    // firing `cancel_save_export(request_id)`. We always pop the
    // entry back out on completion (success OR error OR cancel) so
    // the map only ever holds senders for live requests.
    let request_id = request.request_id.clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let cancellable = !request_id.is_empty();
    if cancellable {
        state
            .active_save_exports
            .lock()
            .await
            .insert(request_id.clone(), cancel_tx);
    }

    let mut cancel_rx_slot = if cancellable {
        Some(&mut cancel_rx)
    } else {
        None
    };
    let work = async {
        let produced = acquire_export_mp3(
            app,
            state,
            &video_ids,
            &target,
            &mut cancel_rx_slot,
        )
        .await?;

        // Pull the cover bytes in parallel with the tagging download
        // so the slowest leg wins. If the cover download fails (no
        // cover, network error, etc.) we still tag without artwork
        // instead of failing the whole export — losing the cover is
        // strictly less bad than losing the audio.
        let cover_future = async {
            match request.cover_url.as_deref() {
                Some(url) => fetch_cover_bytes(url).await.unwrap_or(None),
                None => None,
            }
        };
        let track_total = request.track_total;
        let (cover_bytes, ()) = tokio::join!(cover_future, async {});

        tag_mp3(
            &produced,
            &request.title,
            &request.artist,
            request.album.as_deref(),
            // Single-track exports don't get an album-artist
            // override; the per-track `artist` IS the album-artist
            // in that case (e.g. a single off a "Various Artists"
            // compilation).
            None,
            request.track_number,
            track_total,
            request.year,
            cover_bytes,
        )
        .await?;

        move_to_target(&produced, &target).await?;
        Ok(target.to_string_lossy().to_string())
    };

    let result = work.await;

    // Always unregister the sender, regardless of outcome.
    if cancellable {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(path) => Ok(path),
        Err(error) if error == "Save cancelled." => {
            sweep_cancel_artifacts(&target).await;
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Best-effort cleanup of the temp file yt-dlp drops in the target
/// directory and the final target file, in case the user cancelled
/// while we were mid-write. yt-dlp names its output
/// `.velocity-export-{stem}.%(ext)s`; we look for any file in
/// `target.parent()` whose stem starts with `.velocity-export-` AND
/// whose stem is also the temp stem for this track (so a sibling
/// track in the same album folder doesn't get clobbered).
async fn sweep_cancel_artifacts(target: &Path) {
    let Some(parent) = target.parent() else { return };
    let Some(target_name) = target.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    // Best-effort: remove the final target first (if `move_to_target`
    // already completed) and then any leftover temp file for this
    // track. We don't surface errors — the user has already
    // cancelled and we don't want a "cleanup failed" error to
    // override the cancellation acknowledgement.
    let _ = tokio::fs::remove_file(target).await;
    let temp_prefix = format!(".velocity-export-{target_name}.");
    if let Ok(mut entries) = tokio::fs::read_dir(parent).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with(&temp_prefix) {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
    }
}

#[tauri::command]
async fn save_track_to_mp3(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SaveTrackToMp3Request,
) -> Result<String, String> {
    save_track_to_mp3_inner(&app, &state, request).await
}

/// Frontend-fired "Cancel" handler for any in-flight "Save to my
/// device" export. Looks up the cancellation sender for the supplied
/// `request_id` and signals it; the corresponding save command
/// resolves the race at its next checkpoint and returns
/// `Err("Save cancelled.")`. If the id isn't in the map (the export
/// has already finished, or the user just navigated away from the
/// menu), the call is a silent no-op.
#[tauri::command]
async fn cancel_save_export(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let mut map = state.active_save_exports.lock().await;
    if let Some(sender) = map.remove(&request_id) {
        // Drop the receiver by sending. We deliberately ignore the
        // send error (the receiver might already have been dropped
        // because the export finished between the user's click and
        // this call landing). Either way the export is no longer
        // cancellable.
        let _ = sender.send(());
    }
    // If the id isn't in the map, the export has already finished.
    // That's a no-op, not an error — the user clicked Cancel after
    // the work resolved, which is a valid race we just silently
    // absorb.
    Ok(())
}

async fn save_album_to_mp3_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: SaveAlbumToMp3Request,
) -> Result<SaveAlbumResult, String> {
    let target_dir = PathBuf::from(&request.target_dir);
    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!(
            "Destination folder does not exist: {}",
            target_dir.display()
        ));
    }
    if request.tracks.is_empty() {
        return Err("Album has no tracks to export.".to_string());
    }
    let album_folder_name = sanitize_filename(&request.album_name);
    // Don't reuse an existing album folder to avoid clobbering a
    // previous export. If a folder with this name already exists, fall
    // back to a ` (2)` suffix so the user doesn't lose their old files.
    let album_dir = unique_album_dir(&target_dir, &album_folder_name).await?;
    ensure_dir(&album_dir).await?;

    // Cancellation registry entry. Same pattern as the track command
    // — the work loop checks the receiver between tracks so the user
    // can pull the ripcord mid-album. We also unregister on every
    // exit path so a stale id from a previous run can never be
    // signaled.
    let request_id = request.request_id.clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let cancellable = !request_id.is_empty();
    if cancellable {
        state
            .active_save_exports
            .lock()
            .await
            .insert(request_id.clone(), cancel_tx);
    }

    // Download the cover ONCE so the per-track tagging doesn't each
    // re-fetch the same thumbnail. We surface the cover failure as a
    // soft warning: every track still gets tagged + exported without
    // artwork.
    let cover_bytes = match request.cover_url.as_deref() {
        Some(url) => fetch_cover_bytes(url).await.unwrap_or(None),
        None => None,
    };

    let mut cancel_rx_slot = if cancellable {
        Some(&mut cancel_rx)
    } else {
        None
    };
    let work = async {
        // Pre-compute each track's stem (front-end-supplied, but we
        // sanitize for the FS) and its unique on-disk path. The
        // unique-file lookup also avoids the per-track command
        // clobbering itself if two tracks somehow share a name.
        let track_total: u32 = request.tracks.len() as u32;
        let mut file_paths: Vec<String> = Vec::with_capacity(track_total as usize);
        for (idx, track) in request.tracks.iter().enumerate() {
            let track_number = track
                .track_number
                .unwrap_or_else(|| (idx + 1) as u32);
            let stem = sanitize_filename(&track.file_name);
            let target = unique_mp3_path(&album_dir, &stem).await?;
            let video_ids =
                collect_export_video_ids(&track.video_id, &track.fallback_video_ids);
            let produced = acquire_export_mp3(
                app,
                state,
                &video_ids,
                &target,
                &mut cancel_rx_slot,
            )
            .await?;
            // Album name + album-artist are stamped on every track so
            // the resulting folder round-trips through any standard
            // player.
            let album = Some(request.album_name.as_str());
            tag_mp3(
                &produced,
                &track.title,
                &track.artist,
                album,
                request.album_artist.as_deref(),
                Some(track_number),
                Some(track_total),
                request.year,
                cover_bytes.clone(),
            )
            .await?;
            move_to_target(&produced, &target).await?;
            file_paths.push(target.to_string_lossy().to_string());
        }
        Ok(SaveAlbumResult {
            album_dir: album_dir.to_string_lossy().to_string(),
            file_paths,
        })
    };

    let result = work.await;

    if cancellable {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(value) => Ok(value),
        Err(error) if error == "Save cancelled." => {
            // The current track (if any) may have already landed on
            // disk before the cancel signal landed — yt-dlp is
            // synchronous from our side. Walk the album directory
            // and remove every `.velocity-export-*.mp3` left behind,
            // plus any `*.mp3` we ourselves moved into the folder
            // (those are the tracks that DID complete before the
            // cancel). Leaving partially-written tracks would be
            // worse than losing the few that did finish — the user
            // explicitly asked to abort, so honor that.
            sweep_cancel_album_artifacts(&album_dir).await;
            // If the album directory is now empty, remove it too so
            // a cancelled export doesn't leave a stray empty
            // "Album Name/" folder in the user's pick.
            if let Ok(mut entries) = tokio::fs::read_dir(&album_dir).await {
                let mut any = false;
                while let Ok(Some(_)) = entries.next_entry().await {
                    any = true;
                    break;
                }
                if !any {
                    let _ = tokio::fs::remove_dir(&album_dir).await;
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Best-effort cleanup of an album export that the user cancelled.
/// Removes every `.velocity-export-*.mp3` and every already-landed
/// `*.mp3` in the album directory. Best-effort: errors are swallowed
/// because the user has already cancelled and a "cleanup failed"
/// error would override the cancellation acknowledgement.
async fn sweep_cancel_album_artifacts(album_dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(album_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        // `file_name()` returns a borrowed `OsString`; bind it to
        // a local so the temporary doesn't get dropped while
        // `to_str()` is still using it (the borrowed `&OsString`
        // would otherwise outlive the temporary).
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        // Both the in-flight temp file (`.velocity-export-...mp3`)
        // and any fully-landed track (any other `.mp3`) get cleaned
        // up. The user pulled the ripcord, so we don't leave any
        // partial state behind.
        if name.ends_with(".mp3") {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// Find a non-clobbering destination album folder inside `parent`. Mirrors
/// `unique_mp3_path` but for directories.
async fn unique_album_dir(parent: &Path, stem: &str) -> Result<PathBuf, String> {
    let cleaned = sanitize_filename(stem);
    let mut candidate = parent.join(&cleaned);
    if !candidate.exists() {
        return Ok(candidate);
    }
    for n in 2.. {
        candidate = parent.join(format!("{cleaned} ({n})"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not allocate a unique album folder name.".to_string())
}

#[tauri::command]
async fn save_album_to_mp3(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SaveAlbumToMp3Request,
) -> Result<SaveAlbumResult, String> {
    save_album_to_mp3_inner(&app, &state, request).await
}

async fn save_playlist_to_mp3_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: SavePlaylistToMp3Request,
) -> Result<SavePlaylistResult, String> {
    let target_dir = PathBuf::from(&request.target_dir);
    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!(
            "Destination folder does not exist: {}",
            target_dir.display()
        ));
    }
    if request.tracks.is_empty() {
        return Err("Playlist has no tracks to export.".to_string());
    }
    let folder_name = sanitize_filename(&request.playlist_name);
    // Don't clobber a previous export. `unique_album_dir` is named
    // after its original caller but the same logic applies — the
    // playlist folder gets ` (2)`, ` (3)`, ... if a folder with
    // the playlist's name already exists in the chosen directory.
    let playlist_dir = unique_album_dir(&target_dir, &folder_name).await?;
    ensure_dir(&playlist_dir).await?;

    // Cancellation registry entry, same shape as the track and album
    // commands. The cancel signal races the whole playlist export —
    // granularity is "the in-flight track finishes first, then we
    // abort", which is the natural unit since yt-dlp is synchronous
    // from our side.
    let request_id = request.request_id.clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let cancellable = !request_id.is_empty();
    if cancellable {
        state
            .active_save_exports
            .lock()
            .await
            .insert(request_id.clone(), cancel_tx);
    }

    // Pre-fetch the playlist-level cover once. Tracks that don't carry
    // their own cover fall back to this one. Soft-fails: if the cover
    // download errors, every track still exports without an APIC frame.
    let fallback_cover = match request.cover_url.as_deref() {
        Some(url) => fetch_cover_bytes(url).await.unwrap_or(None),
        None => None,
    };

    let mut cancel_rx_slot = if cancellable {
        Some(&mut cancel_rx)
    } else {
        None
    };
    let work = async {
        let track_total: u32 = request.tracks.len() as u32;
        let mut file_paths: Vec<String> = Vec::with_capacity(track_total as usize);
        let mut skipped: u32 = 0;

        for (idx, track) in request.tracks.iter().enumerate() {
            // Stream tracks have a `videoId`; locally uploaded tracks
            // don't. The latter already live on the user's disk so the
            // export path doesn't make sense for them — silently skip
            // and surface a `skipped` count in the result so the UI
            // can show "Exported N tracks, skipped M" if it wants to.
            if track.video_id.is_empty() {
                skipped += 1;
                continue;
            }
            // Per-track cover wins; the playlist cover is the fallback
            // for tracks the search/list endpoint didn't enrich with
            // one.
            let track_cover = match track.cover_url.as_deref() {
                Some(url) => fetch_cover_bytes(url)
                    .await
                    .unwrap_or_else(|_| fallback_cover.clone()),
                None => fallback_cover.clone(),
            };
            let track_number = track.track_number.unwrap_or_else(|| (idx + 1) as u32);
            let stem = sanitize_filename(&track.file_name);
            let target = unique_mp3_path(&playlist_dir, &stem).await?;
            let video_ids =
                collect_export_video_ids(&track.video_id, &track.fallback_video_ids);
            let produced = match acquire_export_mp3(
                app,
                state,
                &video_ids,
                &target,
                &mut cancel_rx_slot,
            )
            .await
            {
                Ok(produced) => produced,
                Err(error) if error == "Save cancelled." => return Err(error),
                Err(error) => {
                    // One bad track shouldn't sink the whole export.
                    // We surface the error to the caller so the toast
                    // can say "Saved N of M tracks" and the user can
                    // retry just the missing ones.
                    return Err(format!(
                        "Failed to download track {} ({}): {error}",
                        track.title, track.video_id
                    ));
                }
            };
            // `album_artist` stays `None` for playlists — a "playlist
            // album artist" would only ever be "Various Artists" and
            // that tag is more confusing than helpful when applied to
            // a single track from a real album.
            tag_mp3(
                &produced,
                &track.title,
                &track.artist,
                track.album.as_deref(),
                None,
                Some(track_number),
                Some(track_total),
                None,
                track_cover,
            )
            .await?;
            move_to_target(&produced, &target).await?;
            file_paths.push(target.to_string_lossy().to_string());
        }
        Ok(SavePlaylistResult {
            playlist_dir: playlist_dir.to_string_lossy().to_string(),
            file_paths,
            skipped,
        })
    };

    let result = work.await;

    if cancellable {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(value) => Ok(value),
        Err(error) if error == "Save cancelled." => {
            // Same shape as the album cancel cleanup: drop every MP3
            // already in the playlist folder, then remove the folder
            // itself if it ended up empty.
            sweep_cancel_album_artifacts(&playlist_dir).await;
            if let Ok(mut entries) = tokio::fs::read_dir(&playlist_dir).await {
                let mut any = false;
                while let Ok(Some(_)) = entries.next_entry().await {
                    any = true;
                    break;
                }
                if !any {
                    let _ = tokio::fs::remove_dir(&playlist_dir).await;
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn save_playlist_to_mp3(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SavePlaylistToMp3Request,
) -> Result<SavePlaylistResult, String> {
    save_playlist_to_mp3_inner(&app, &state, request).await
}

fn artwork_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("artwork"))
}

async fn cache_remote_artwork(app: &AppHandle, url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid artwork URL.".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Unsupported artwork URL.".to_string());
    }

    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let cache_key = hasher.finish();
    let cache_dir = artwork_cache_dir(app)?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("Failed to create artwork cache folder: {error}"))?;

    for extension in ["jpg", "png", "webp"] {
        let cached_path = cache_dir.join(format!("{cache_key:016x}.{extension}"));
        if cached_path.exists() {
            return Ok(cached_path.to_string_lossy().to_string());
        }
    }

    // Only mint a YouTube Music Referer for YouTube/Google image/CDN hosts.
    // Spotify (i.scdn.co) and Apple Music (mzstatic.com) CDNs reject requests
    // with a wrong-referrer header, which previously caused non-YTM playlist
    // cover downloads to silently fail.
    let needs_youtube_referer = parsed
        .host_str()
        .map(|host| {
            host == "music.youtube.com"
                || host == "youtube.com"
                || host.ends_with(".youtube.com")
                || host.ends_with(".ytimg.com")
                || host.ends_with(".googleusercontent.com")
        })
        .unwrap_or(false);
    let mut request = HTTP.get(parsed);
    if needs_youtube_referer {
        request = request.header(REFERER, HeaderValue::from_static("https://music.youtube.com/"));
    }
    let response = request
        .header(
            ORIGIN,
            HeaderValue::from_static("https://music.youtube.com"),
        )
        .send()
        .await
        .map_err(|error| format!("Artwork request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Artwork returned HTTP {}", response.status()));
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let extension = artwork_extension(url, content_type.as_deref());
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read artwork: {error}"))?;

    if bytes.is_empty() {
        return Err("Artwork download was empty.".to_string());
    }
    if bytes.len() > MAX_CACHED_ARTWORK_BYTES {
        return Err("Artwork download was too large.".to_string());
    }

    let cached_path = cache_dir.join(format!("{cache_key:016x}.{extension}"));
    tokio::fs::write(&cached_path, &bytes)
        .await
        .map_err(|error| format!("Failed to cache artwork: {error}"))?;

    Ok(cached_path.to_string_lossy().to_string())
}

fn artwork_extension(url: &str, content_type: Option<&str>) -> &'static str {
    if let Some(content_type) = content_type {
        let content_type = content_type.to_ascii_lowercase();
        if content_type.contains("png") {
            return "png";
        }
        if content_type.contains("webp") {
            return "webp";
        }
    }

    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if path.ends_with(".png") {
        "png"
    } else if path.ends_with(".webp") {
        "webp"
    } else {
        "jpg"
    }
}

#[tauri::command]
fn extract_file_metadata(bytes: Vec<u8>, name: String) -> Result<ExtractedMetadata, String> {
    let meta = extract_metadata_from_bytes(&bytes, &name);
    Ok(ExtractedMetadata {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration_seconds: meta.duration_seconds,
        cover_bytes: meta.cover_bytes,
    })
}

#[tauri::command]
async fn list_imported_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<MediaTrack>, String> {
    let _guard = state.import_library.lock().await;
    let records = load_import_library(&app).await?;
    records
        .iter()
        .map(|record| record_to_media_track(&app, record))
        .collect()
}

#[tauri::command]
async fn import_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    tracks: Vec<IncomingImportTrack>,
) -> Result<Vec<MediaTrack>, String> {
    let _guard = state.import_library.lock().await;
    let files_dir = import_files_dir(&app)?;
    tokio::fs::create_dir_all(&files_dir)
        .await
        .map_err(|error| format!("Failed to create import folder: {error}"))?;

    let mut library = load_import_library(&app).await?;
    let mut imported = Vec::new();

    for track in tracks {
        if track.bytes.is_empty() {
            continue;
        }

        let extracted = extract_metadata_from_bytes(&track.bytes, &track.name);

        let id = generate_import_id();
        let extension = file_extension(&track.name);
        let file_name = if extension.is_empty() {
            id.clone()
        } else {
            format!("{id}.{extension}")
        };
        let stored_path = files_dir.join(&file_name);
        tokio::fs::write(&stored_path, &track.bytes)
            .await
            .map_err(|error| format!("Failed to save imported audio: {error}"))?;

        let mut cover_file = None;

        // Save user-provided cover first (from the modal or sibling detection).
        if let Some(ref cover_bytes) = track.cover_bytes {
            if !cover_bytes.is_empty() {
                let covers_dir = import_covers_dir(&app)?;
                tokio::fs::create_dir_all(&covers_dir)
                    .await
                    .map_err(|error| format!("Failed to create covers folder: {error}"))?;
                let cover_name = format!("{id}.jpg");
                let cover_path = covers_dir.join(&cover_name);
                tokio::fs::write(&cover_path, cover_bytes)
                    .await
                    .map_err(|error| format!("Failed to save cover image: {error}"))?;
                cover_file = Some(cover_name);
            }
        }

        // Fall back to embedded cover art if the user didn't provide one.
        if cover_file.is_none() {
            if let Some(ref embedded_cover) = extracted.cover_bytes {
                if !embedded_cover.is_empty() {
                    let covers_dir = import_covers_dir(&app)?;
                    tokio::fs::create_dir_all(&covers_dir)
                        .await
                        .map_err(|error| format!("Failed to create covers folder: {error}"))?;
                    let cover_name = format!("{id}.jpg");
                    let cover_path = covers_dir.join(&cover_name);
                    tokio::fs::write(&cover_path, embedded_cover)
                        .await
                        .map_err(|error| format!("Failed to save cover image: {error}"))?;
                    cover_file = Some(cover_name);
                }
            }
        }

        let title = extracted
            .title
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| display_title(&track.name));
        let artist = extracted
            .artist
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "Imported audio".to_string());
        let album = extracted.album.filter(|v| !v.trim().is_empty());

        let record = ImportedTrackRecord {
            id: id.clone(),
            title,
            artist,
            album,
            duration_seconds: extracted.duration_seconds,
            file_name,
            cover_file,
            find_lyrics: false,
        };
        library.push(record.clone());
        imported.push(record_to_media_track(&app, &record)?);
    }

    save_import_library(&app, &library).await?;
    Ok(imported)
}

#[tauri::command]
async fn update_imported_track_metadata(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_seconds: Option<u32>,
    cover_bytes: Option<Vec<u8>>,
    find_lyrics: Option<bool>,
) -> Result<MediaTrack, String> {
    let _guard = state.import_library.lock().await;
    let mut library = load_import_library(&app).await?;
    let record = library
        .iter_mut()
        .find(|entry| entry.id == track_id)
        .ok_or_else(|| "Imported track not found.".to_string())?;

    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        record.title = title;
    }
    if let Some(artist) = artist.filter(|value| !value.trim().is_empty()) {
        record.artist = artist;
    }
    if let Some(album) = album.filter(|value| !value.trim().is_empty()) {
        record.album = Some(album);
    }
    if let Some(duration_seconds) = duration_seconds {
        record.duration_seconds = Some(duration_seconds);
    }
    if let Some(ref cover) = cover_bytes {
        if !cover.is_empty() {
            let covers_dir = import_covers_dir(&app)?;
            tokio::fs::create_dir_all(&covers_dir)
                .await
                .map_err(|error| format!("Failed to create covers folder: {error}"))?;
            let cover_name = format!("{}.jpg", record.id);
            let cover_path = covers_dir.join(&cover_name);
            tokio::fs::write(&cover_path, cover)
                .await
                .map_err(|error| format!("Failed to save cover image: {error}"))?;
            record.cover_file = Some(cover_name);
        }
    }

    if let Some(find_lyrics) = find_lyrics {
        record.find_lyrics = find_lyrics;
    }

    let response = record_to_media_track(&app, record)?;
    save_import_library(&app, &library).await?;
    Ok(response)
}

#[tauri::command]
async fn remove_imported_track(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: String,
) -> Result<(), String> {
    let _guard = state.import_library.lock().await;
    let mut library = load_import_library(&app).await?;
    let index = library
        .iter()
        .position(|entry| entry.id == track_id)
        .ok_or_else(|| "Imported track not found.".to_string())?;
    let record = library.remove(index);
    save_import_library(&app, &library).await?;

    let stored_path = import_files_dir(&app)?.join(record.file_name);
    let _ = tokio::fs::remove_file(&stored_path).await;

    if let Some(ref cover_name) = record.cover_file {
        let cover_path = import_covers_dir(&app)?.join(cover_name);
        let _ = tokio::fs::remove_file(&cover_path).await;
    }

    Ok(())
}

#[tauri::command]
async fn analyze_loudness(file_path: String) -> Result<LoudnessData, String> {
    analyze_loudness_slice(file_path, None, None).await
}

#[tauri::command]
async fn analyze_loudness_chunk(
    file_path: String,
    start_seconds: f64,
    duration_seconds: f64,
) -> Result<LoudnessData, String> {
    analyze_loudness_slice(
        file_path,
        Some(start_seconds.max(0.0)),
        Some(duration_seconds.clamp(1.0, 45.0)),
    )
    .await
}

async fn analyze_loudness_slice(
    file_path: String,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
) -> Result<LoudnessData, String> {
    const LOUDNESS_ANALYSIS_VERSION: u8 = 2;

    fn empty_loudness_data() -> LoudnessData {
        LoudnessData {
            integrated_lufs: None,
            true_peak: None,
            loudness_range: None,
            threshold: None,
            target_offset: None,
            analysis_version: LOUDNESS_ANALYSIS_VERSION,
        }
    }

    fn parse_loudnorm_number(json: &Value, key: &str) -> Option<f64> {
        json.get(key)
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
            })
            .filter(|value| value.is_finite())
    }

    async fn check_ffmpeg() -> Option<PathBuf> {
        let name = if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let mut cmd = Command::new(name);
        cmd.arg("-version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().await.ok().filter(|o| o.status.success())?;
        Some(PathBuf::from(name))
    }

    let ffmpeg = check_ffmpeg().await;
    let ffmpeg = match ffmpeg {
        Some(path) => path,
        None => return Ok(empty_loudness_data()),
    };

    let null_device = if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    };

    let mut command = Command::new(&ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-nostats", "-vn"]);

    if let Some(start_seconds) = start_seconds {
        command.args(["-ss", &format!("{start_seconds:.3}")]);
    }

    command.args(["-i", &file_path]);

    if let Some(duration_seconds) = duration_seconds {
        command.args(["-t", &format!("{duration_seconds:.3}")]);
    }

    command.args([
        "-af",
        "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json",
        "-f",
        "null",
        null_device,
        "-y",
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;

    if !output.status.success() {
        return Ok(empty_loudness_data());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let Some(json_end) = stderr.rfind('}') else {
        return Ok(empty_loudness_data());
    };
    let Some(json_start) = stderr[..=json_end].rfind('{') else {
        return Ok(empty_loudness_data());
    };
    let json_str = &stderr[json_start..=json_end];

    if let Ok(json) = serde_json::from_str::<Value>(json_str) {
        return Ok(LoudnessData {
            integrated_lufs: parse_loudnorm_number(&json, "input_i"),
            true_peak: parse_loudnorm_number(&json, "input_tp"),
            loudness_range: parse_loudnorm_number(&json, "input_lra"),
            threshold: parse_loudnorm_number(&json, "input_thresh"),
            target_offset: parse_loudnorm_number(&json, "target_offset"),
            analysis_version: LOUDNESS_ANALYSIS_VERSION,
        });
    }

    Ok(empty_loudness_data())
}

#[tauri::command]
async fn detect_leading_silence(file_path: String) -> Result<LeadingSilenceData, String> {
    const LEADING_SILENCE_ANALYSIS_VERSION: u8 = 2;
    const ANALYSIS_MAX_SECONDS: f64 = 45.0;
    const SILENCE_NOISE_DB: f64 = -35.0;
    const SILENCE_MIN_DURATION: f64 = 0.75;
    const MIN_SKIP_SECONDS: f64 = 1.0;
    const MAX_SKIP_SECONDS: f64 = 30.0;
    const LEADING_SILENCE_START_TOLERANCE: f64 = 0.05;

    fn empty_leading_silence_data() -> LeadingSilenceData {
        LeadingSilenceData {
            skip_seconds: None,
            analysis_version: LEADING_SILENCE_ANALYSIS_VERSION,
        }
    }

    fn parse_silence_value(line: &str, key: &str) -> Option<f64> {
        let marker = format!("{key}:");
        let start = line.find(&marker)? + marker.len();
        let raw = line[start..].trim();
        let token = raw.split_whitespace().next()?;
        token.parse::<f64>().ok().filter(|value| value.is_finite())
    }

    async fn check_ffmpeg() -> Option<PathBuf> {
        let name = if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let mut cmd = Command::new(name);
        cmd.arg("-version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().await.ok().filter(|o| o.status.success())?;
        Some(PathBuf::from(name))
    }

    let ffmpeg = match check_ffmpeg().await {
        Some(path) => path,
        None => return Ok(empty_leading_silence_data()),
    };

    let null_device = if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    };

    let filter = format!(
        "silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DURATION}"
    );

    let mut command = Command::new(&ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-vn",
        "-t",
        &format!("{ANALYSIS_MAX_SECONDS:.3}"),
        "-i",
        &file_path,
        "-af",
        &filter,
        "-f",
        "null",
        null_device,
        "-y",
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;

    if !output.status.success() {
        return Ok(empty_leading_silence_data());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut current_silence_start: Option<f64> = None;
    let mut leading_skip: Option<f64> = None;

    for line in stderr.lines() {
        if line.contains("silence_start:") {
            current_silence_start = parse_silence_value(line, "silence_start");
            continue;
        }
        if line.contains("silence_end:") {
            let silence_end = parse_silence_value(line, "silence_end");
            if let (Some(start), Some(end)) = (current_silence_start, silence_end) {
                if start <= LEADING_SILENCE_START_TOLERANCE {
                    leading_skip = Some(end);
                    break;
                }
            }
            current_silence_start = None;
        }
    }

    let skip_seconds = leading_skip.and_then(|seconds| {
        if seconds < MIN_SKIP_SECONDS {
            None
        } else {
            Some(seconds.min(MAX_SKIP_SECONDS))
        }
    });

    Ok(LeadingSilenceData {
        skip_seconds,
        analysis_version: LEADING_SILENCE_ANALYSIS_VERSION,
    })
}

async fn backend_status(app: &AppHandle) -> Result<BackendStatus, String> {
    let path = yt_dlp_path(app)?;
    if !path.exists() {
        return Ok(BackendStatus {
            yt_dlp_ready: false,
            yt_dlp_path: None,
            yt_dlp_version: None,
        });
    }

    let version = yt_dlp_version(&path).await.ok();
    Ok(BackendStatus {
        yt_dlp_ready: true,
        yt_dlp_path: Some(path.to_string_lossy().to_string()),
        yt_dlp_version: version,
    })
}

async fn ensure_yt_dlp(app: &AppHandle) -> Result<PathBuf, String> {
    let path = yt_dlp_path(app)?;
    if path.exists() {
        return Ok(path);
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Failed to determine yt-dlp directory.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;

    let response = HTTP
        .get(YT_DLP_URL)
        .send()
        .await
        .map_err(|error| format!("Failed to download yt-dlp: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download yt-dlp: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read yt-dlp download: {error}"))?;

    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|error| format!("Failed to save yt-dlp: {error}"))?;

    Ok(path)
}

fn app_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("bin"))
}

fn yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_bin_dir(app)?.join("yt-dlp.exe"))
}

fn ffmpeg_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn ffprobe_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    }
}

async fn ffmpeg_bundle_ready(bin_dir: &Path) -> bool {
    let ffmpeg = bin_dir.join(ffmpeg_executable_name());
    let ffprobe = bin_dir.join(ffprobe_executable_name());
    cached_audio_file_valid(&ffmpeg).await && cached_audio_file_valid(&ffprobe).await
}

async fn ffmpeg_on_path() -> Option<PathBuf> {
    let name = ffmpeg_executable_name();
    let mut cmd = Command::new(name);
    cmd.arg("-version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output()
        .await
        .ok()
        .filter(|output| output.status.success())?;
    Some(PathBuf::from(name))
}

#[cfg(target_os = "windows")]
async fn extract_ffmpeg_zip(bytes: &[u8], bin_dir: &Path) -> Result<(), String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Downloaded ffmpeg archive was invalid: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read ffmpeg archive entry: {error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let file_name = enclosed
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if file_name != ffmpeg_executable_name() && file_name != ffprobe_executable_name() {
            continue;
        }
        let out_path = bin_dir.join(file_name);
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|error| format!("Failed to create {}: {error}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|error| format!("Failed to extract {}: {error}", out_path.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn download_bundled_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = app_bin_dir(app)?;
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|error| format!("Failed to create bin folder: {error}"))?;

    let response = HTTP
        .get(FFMPEG_WIN_ZIP_URL)
        .send()
        .await
        .map_err(|error| format!("Failed to download ffmpeg: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download ffmpeg: HTTP {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read ffmpeg download: {error}"))?;
    extract_ffmpeg_zip(&bytes, &bin_dir).await?;

    let ffmpeg = bin_dir.join(ffmpeg_executable_name());
    if !ffmpeg_bundle_ready(&bin_dir).await {
        return Err(
            "ffmpeg download finished but ffmpeg/ffprobe were not found in the archive.".to_string(),
        );
    }
    Ok(ffmpeg)
}

/// Resolve ffmpeg for MP3 export. Windows downloads a portable bundle
/// beside yt-dlp on first use; other platforms fall back to PATH.
async fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = app_bin_dir(app)?;
    if ffmpeg_bundle_ready(&bin_dir).await {
        return Ok(bin_dir.join(ffmpeg_executable_name()));
    }
    if let Some(path) = ffmpeg_on_path().await {
        return Ok(path);
    }

    #[cfg(target_os = "windows")]
    {
        return download_bundled_ffmpeg(app).await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(
            "ffmpeg is required to export MP3 files. Install ffmpeg and make sure it is on PATH."
                .to_string(),
        )
    }
}

fn import_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("imports"))
}

fn import_files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(import_root_dir(app)?.join("files"))
}

fn import_covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(import_root_dir(app)?.join("covers"))
}

fn import_library_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(import_root_dir(app)?.join("library.json"))
}

async fn yt_dlp_version(path: &Path) -> Result<String, String> {
    run_command(path, ["--version"])
        .await
        .map(|value| value.trim().to_string())
}

async fn run_command<'a, I>(program: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run {}: {error}", program.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited with {}", program.display(), output.status)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// Bounded variant of `run_command` for callers that can hang
// indefinitely if the child process stalls (yt-dlp against a
// rate-limited or malformed playlist URL, for example). Spawns the
// child with `kill_on_drop(true)` and wraps `wait_with_output` in
// `tokio::time::timeout`; on timeout the inner future is dropped,
// which kills the OS process via `kill_on_drop` so we don't leak a
// zombie. Returns a clear error so the caller can surface it to the
// user instead of hanging the import dialog.
async fn run_command_with_timeout<'a, I>(
    program: &Path,
    args: I,
    timeout: Duration,
) -> Result<String, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    // Spawn the child so we own the `Child` handle and can explicitly
    // bound the wait. `wait_with_output()` consumes the child and
    // reads stdout/stderr to completion; dropping that future on
    // timeout is what triggers the `kill_on_drop` reaper.
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to run {}: {error}", program.display()))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(error)) => {
            return Err(format!("Failed to run {}: {error}", program.display()));
        }
        Err(_elapsed) => {
            return Err(format!(
                "{} didn't respond within {}s. The playlist might be unusually large or the service is rate-limiting anonymous requests. Try again in a few minutes.",
                program.display(),
                timeout.as_secs()
            ));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited with {}", program.display(), output.status)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn load_import_library(app: &AppHandle) -> Result<Vec<ImportedTrackRecord>, String> {
    let library_path = import_library_path(app)?;
    let parent = library_path
        .parent()
        .ok_or_else(|| "Failed to resolve import library folder.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create import library folder: {error}"))?;

    match tokio::fs::read_to_string(&library_path).await {
        Ok(contents) => serde_json::from_str::<Vec<ImportedTrackRecord>>(&contents)
            .map_err(|error| format!("Failed to read import library: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Failed to load import library: {error}")),
    }
}

async fn save_import_library(
    app: &AppHandle,
    library: &[ImportedTrackRecord],
) -> Result<(), String> {
    let library_path = import_library_path(app)?;
    let parent = library_path
        .parent()
        .ok_or_else(|| "Failed to resolve import library folder.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create import library folder: {error}"))?;
    let json = serde_json::to_string_pretty(library)
        .map_err(|error| format!("Failed to encode import library: {error}"))?;
    tokio::fs::write(&library_path, json)
        .await
        .map_err(|error| format!("Failed to save import library: {error}"))
}

fn record_to_media_track(
    app: &AppHandle,
    record: &ImportedTrackRecord,
) -> Result<MediaTrack, String> {
    let file_path = import_files_dir(app)?.join(&record.file_name);
    let cover = record
        .cover_file
        .as_ref()
        .and_then(|name| {
            let cover_path = import_covers_dir(app).ok()?.join(name);
            Some(cover_path.to_string_lossy().to_string())
        });
    Ok(MediaTrack {
        id: record.id.clone(),
        kind: None,
        title: record.title.clone(),
        artist: record.artist.clone(),
        album: record
            .album
            .as_ref()
            .filter(|value| !value.trim().eq_ignore_ascii_case("collection"))
            .cloned(),
        album_browse_id: None,
        artist_browse_id: None,
        artist_credits: None,
        duration_seconds: record.duration_seconds,
        play_count: None,
        cover,
        video_id: None,
        source: "upload",
        audio_src: None,
        file_path: Some(file_path.to_string_lossy().to_string()),
        find_lyrics: record.find_lyrics,
    })
}

fn generate_import_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("import-{nanos}")
}

fn file_extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn display_title(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| name.to_string())
}

struct ExtractedAudioMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_seconds: Option<u32>,
    cover_bytes: Option<Vec<u8>>,
}

fn extract_metadata_from_bytes(bytes: &[u8], name: &str) -> ExtractedAudioMetadata {
    let empty = ExtractedAudioMetadata {
        title: None,
        artist: None,
        album: None,
        duration_seconds: None,
        cover_bytes: None,
    };

    if bytes.is_empty() {
        return empty;
    }

    let mut cursor = Cursor::new(bytes);
    let probe = match Probe::new(&mut cursor).guess_file_type() {
        Ok(p) => p,
        Err(_) => {
            cursor.set_position(0);
            let ext = file_extension(name);
            let file_type = match ext.as_str() {
                "mp3" => lofty::file::FileType::Mpeg,
                "m4a" | "aac" => lofty::file::FileType::Mp4,
                "flac" => lofty::file::FileType::Flac,
                "ogg" => lofty::file::FileType::Vorbis,
                "opus" => lofty::file::FileType::Opus,
                "wav" => lofty::file::FileType::Wav,
                "wma" => lofty::file::FileType::Aac,
                "alac" => lofty::file::FileType::Mp4,
                _ => return empty,
            };
            Probe::new(&mut cursor).set_file_type(file_type)
        }
    };

    let tagged_file = match probe.read() {
        Ok(f) => f,
        Err(_) => return empty,
    };

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let title = tag.and_then(|t| t.title().map(|s| s.to_string()));
    let artist = tag.and_then(|t| t.artist().map(|s| s.to_string()));
    let album = tag.and_then(|t| t.album().map(|s| s.to_string()));

    let duration_seconds = {
        let duration = tagged_file.properties().duration();
        if duration.is_zero() {
            None
        } else {
            Some(duration.as_secs() as u32)
        }
    };

    let cover_bytes = tag
        .and_then(|t| t.pictures().first().map(|pic| pic.data().to_vec()));

    ExtractedAudioMetadata {
        title,
        artist,
        album,
        duration_seconds,
        cover_bytes,
    }
}

async fn post_ytmusic(
    state: &State<'_, AppState>,
    endpoint: &str,
    payload: Value,
) -> Result<Value, String> {
    let config = get_client_config(state).await?;
    post_ytmusic_with_client(
        state,
        endpoint,
        payload,
        "WEB_REMIX",
        &config.client_version,
        None,
    )
    .await
}

async fn post_ytmusic_continuation(
    state: &State<'_, AppState>,
    token: &str,
) -> Result<Value, String> {
    let config = get_client_config(state).await?;
    let encoded = urlencoding::encode(token);
    let query_suffix = format!("&ctoken={encoded}&continuation={encoded}");
    let with_query = post_ytmusic_with_client(
        state,
        "browse",
        json!({ "continuation": token }),
        "WEB_REMIX",
        &config.client_version,
        Some(query_suffix.as_str()),
    )
    .await?;
    if parse_shelf_continuation_items(&with_query).is_some() {
        return Ok(with_query);
    }

    post_ytmusic_with_client(
        state,
        "browse",
        json!({ "continuation": token }),
        "WEB_REMIX",
        &config.client_version,
        None,
    )
    .await
}

async fn post_ytmusic_with_client(
    state: &State<'_, AppState>,
    endpoint: &str,
    payload: Value,
    client_name: &str,
    client_version: &str,
    query_suffix: Option<&str>,
) -> Result<Value, String> {
    let config = get_client_config(state).await?;
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(
        ORIGIN,
        HeaderValue::from_static("https://music.youtube.com"),
    );
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://music.youtube.com/"),
    );
    headers.insert(
        "x-goog-visitor-id",
        HeaderValue::from_str(&config.visitor_data).map_err(|error| error.to_string())?,
    );

    let mut body = match payload {
        Value::Object(map) => map,
        _ => return Err("Invalid request payload.".to_string()),
    };
    let mut client = json!({
        "clientName": client_name,
        "clientVersion": client_version,
        "hl": "en",
        "gl": "US"
    });
    if client_name != "ANDROID_MUSIC" {
        client["platform"] = json!("DESKTOP");
        client["clientFormFactor"] = json!("UNKNOWN_FORM_FACTOR");
    }
    client["visitorData"] = json!(config.visitor_data);
    body.insert(
        "context".to_string(),
        json!({
            "client": client,
            "capabilities": {},
            "request": {
                "useSsl": true
            },
            "user": {
                "lockedSafetyMode": false
            }
        }),
    );

    let url = format!(
        "https://music.youtube.com/youtubei/v1/{endpoint}?key={}{}",
        config.api_key,
        query_suffix.unwrap_or_default()
    );

    let response = HTTP
        .post(url)
        .headers(headers)
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|error| format!("YouTube Music request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("YouTube Music returned HTTP {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to decode YouTube Music response: {error}"))
}

async fn get_client_config(state: &State<'_, AppState>) -> Result<InnerTubeConfig, String> {
    {
        let cache = state.client_config.lock().await;
        if let Some(config) = cache.as_ref() {
            if config.fetched_at.elapsed() < CLIENT_CACHE_TTL {
                return Ok(InnerTubeConfig {
                    api_key: config.api_key.clone(),
                    client_version: config.client_version.clone(),
                    visitor_data: config.visitor_data.clone(),
                    fetched_at: config.fetched_at,
                });
            }
        }
    }

    let html = HTTP
        .get("https://music.youtube.com/")
        .send()
        .await
        .map_err(|error| format!("Failed to load YouTube Music shell: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Failed to read YouTube Music shell: {error}"))?;

    let api_key = API_KEY_RE
        .captures(&html)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "Could not find the YouTube Music API key.".to_string())?;
    let client_version = CLIENT_VERSION_RE
        .captures(&html)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "Could not find the YouTube Music client version.".to_string())?;
    let visitor_data = VISITOR_DATA_RE
        .captures(&html)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "Could not find the YouTube Music visitor data.".to_string())?;

    let config = InnerTubeConfig {
        api_key,
        client_version,
        visitor_data,
        fetched_at: Instant::now(),
    };

    let mut cache = state.client_config.lock().await;
    *cache = Some(InnerTubeConfig {
        api_key: config.api_key.clone(),
        client_version: config.client_version.clone(),
        visitor_data: config.visitor_data.clone(),
        fetched_at: config.fetched_at,
    });

    Ok(config)
}

fn parse_search_suggestions(value: &Value) -> Vec<SearchSuggestion> {
    let raw_suggestions = value
        .get("contents")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("searchSuggestionsSectionRenderer"))
        .and_then(|section| section.get("contents"))
        .and_then(Value::as_array);

    let Some(raw_suggestions) = raw_suggestions else {
        return Vec::new();
    };

    let mut suggestions = Vec::new();
    for raw in raw_suggestions {
        let (suggestion_content, from_history) =
            if let Some(history) = raw.get("historySuggestionRenderer") {
                (history, true)
            } else if let Some(search) = raw.get("searchSuggestionRenderer") {
                (search, false)
            } else {
                continue;
            };

        let text = suggestion_content
            .get("navigationEndpoint")
            .and_then(|endpoint| endpoint.get("searchEndpoint"))
            .and_then(|endpoint| endpoint.get("query"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Some(text) = text {
            suggestions.push(SearchSuggestion {
                text: text.to_string(),
                from_history,
            });
        }
    }

    suggestions
}

fn parse_search_response(query: &str, value: &Value) -> SearchResponse {
    let contents = value
        .get("contents")
        .and_then(|value| value.get("tabbedSearchResultsRenderer"))
        .and_then(|value| value.get("tabs"))
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|value| value.get("tabRenderer"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.get("sectionListRenderer"))
        .and_then(|value| value.get("contents"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let top_result = contents
        .iter()
        .find_map(|item| item.get("musicCardShelfRenderer"))
        .and_then(parse_top_result)
        .filter(should_include_search_item);

    let top_id = top_result.as_ref().map(|item| item.id.clone());
    let mut seen = HashMap::<String, bool>::new();
    if let Some(id) = &top_id {
        seen.insert(id.clone(), true);
    }

    let mut results = Vec::new();
    for item in contents {
        if let Some(section_items) = item
            .get("itemSectionRenderer")
            .and_then(|value| value.get("contents"))
            .and_then(Value::as_array)
        {
            for entry in section_items {
                if let Some(parsed) = parse_search_row(entry) {
                    if !should_include_search_item(&parsed) {
                        continue;
                    }
                    if !seen.contains_key(&parsed.id) {
                        seen.insert(parsed.id.clone(), true);
                        results.push(parsed);
                    }
                }
            }
        }
    }

    let top_result = top_result.or_else(|| {
        if results.is_empty() {
            return None;
        }
        Some(results.remove(0))
    });

    SearchResponse {
        query: query.to_string(),
        top_result,
        results,
    }
}

fn should_include_search_item(item: &SearchItem) -> bool {
    item.kind != "playlist" && item.kind != "video"
}

fn effective_type_label<'a>(
    structured_label: Option<&'a str>,
    meta_label: Option<&'a str>,
) -> Option<&'a str> {
    structured_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(meta_label)
}

fn parse_top_result(value: &Value) -> Option<SearchItem> {
    let title_runs = value.get("title")?.get("runs")?.as_array()?;
    let first_run = title_runs.first()?;
    let title = first_run.get("text")?.as_str()?.to_string();
    let subtitle = text_from_value(value.get("subtitle")?)?;
    let browse_id = first_run
        .get("navigationEndpoint")
        .and_then(|value| value.get("browseEndpoint"))
        .and_then(|value| value.get("browseId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let video_id = as_str_path(
        value,
        &[
            "thumbnailOverlay",
            "musicItemThumbnailOverlayRenderer",
            "content",
            "musicPlayButtonRenderer",
            "playNavigationEndpoint",
            "watchEndpoint",
            "videoId",
        ],
    )
    .map(str::to_string);

    let subtitle_val = value.get("subtitle");
    let parsed_runs = subtitle_val
        .map(extract_run_meta_from_runs)
        .unwrap_or_default();
    let meta = split_bullets_fixed(&subtitle);
    let kind_label = effective_type_label(
        parsed_runs.type_label.as_deref(),
        meta.first().map(String::as_str),
    );
    let kind = normalize_kind(kind_label, browse_id.is_some(), video_id.is_some());

    let has_type_label = kind_label
        .map(|value| is_type_label(&value.to_ascii_lowercase()))
        .unwrap_or(false);

    let artist = parsed_runs
        .artist_text
        .clone()
        .or_else(|| fallback_artist_from_meta(&meta, has_type_label));

    let album = if kind == "song" || kind == "video" {
        parsed_runs.album_text.clone().filter(|value| parse_duration(value).is_none()).or_else(|| {
            let candidate = if has_type_label {
                meta.get(2).cloned()
            } else {
                meta.get(1).cloned()
            };
            // Reject duration strings masquerading as album names. Without this
            // filter, songs whose subtitle holds no album got `meta[1]` like "3:45"
            // assigned as the album, which then printed into the Album column on the
            // imported playlist and read as "the duration leaked into both columns".
            match candidate {
                Some(value) if parse_duration(&value).is_some() => None,
                other => other,
            }
        })
    } else {
        Some(title.clone())
    };

    let year = if kind == "album" {
        if has_type_label {
            meta.get(2).cloned()
        } else {
            meta.get(1).cloned()
        }
    } else {
        None
    };
    let duration_seconds = parse_duration_from_text(&subtitle);
    let play_count = extract_play_count_from_text(&subtitle);

    let album_browse_id = parsed_runs
        .album_browse_id
        .or_else(|| extract_album_browse_id_from_menu(value));
    let artist_browse_id = parsed_runs
        .artist_browse_id
        .or_else(|| extract_artist_browse_id_from_menu(value, artist.as_deref()));

    Some(SearchItem {
        id: item_id(&kind, browse_id.as_deref(), video_id.as_deref(), &title),
        kind,
        title,
        subtitle,
        cover: best_thumbnail(value),
        browse_id,
        video_id,
        duration_seconds,
        play_count,
        artist,
        album,
        year,
        album_browse_id,
        artist_browse_id,
        artist_credits: (!parsed_runs.artist_credits.is_empty())
            .then_some(parsed_runs.artist_credits),
    })
}

fn parse_search_row(value: &Value) -> Option<SearchItem> {
    let row = value.get("musicResponsiveListItemRenderer")?;
    let flex_columns = row.get("flexColumns")?.as_array()?;

    let flex = flex_columns
        .iter()
        .filter_map(|column| {
            column
                .get("musicResponsiveListItemFlexColumnRenderer")
                .and_then(|value| value.get("text"))
                .and_then(text_from_value)
        })
        .collect::<Vec<_>>();

    let title = flex.first()?.clone();
    let meta = flex.get(1).cloned().unwrap_or_default();
    let tertiary = flex.get(2).cloned();
    let subtitle = tertiary
        .as_ref()
        .map(|value| format!("{meta} • {value}"))
        .unwrap_or_else(|| meta.clone());
    let meta_parts = split_bullets_fixed(&meta);

    let col1_text = flex_columns
        .get(1)
        .and_then(|col| col.get("musicResponsiveListItemFlexColumnRenderer"))
        .and_then(|v| v.get("text"));

    let parsed_runs = col1_text
        .map(extract_run_meta_from_runs)
        .unwrap_or_default();

    let browse_id =
        as_str_path(row, &["navigationEndpoint", "browseEndpoint", "browseId"]).map(str::to_string);
    let video_id = as_str_path(
        row,
        &[
            "overlay",
            "musicItemThumbnailOverlayRenderer",
            "content",
            "musicPlayButtonRenderer",
            "playNavigationEndpoint",
            "watchEndpoint",
            "videoId",
        ],
    )
    .map(str::to_string)
    .or_else(|| as_str_path(row, &["playlistItemData", "videoId"]).map(str::to_string));

    let kind_label = effective_type_label(
        parsed_runs.type_label.as_deref(),
        meta_parts.first().map(String::as_str),
    );
    if kind_label.is_some_and(|label| is_excluded_type_label(label)) {
        return None;
    }
    let kind = normalize_kind(kind_label, browse_id.is_some(), video_id.is_some());
    if kind == "unknown" {
        return None;
    }

    let duration_seconds = row
        .get("fixedColumns")
        .and_then(Value::as_array)
        .and_then(|columns| columns.first())
        .and_then(|column| column.get("musicResponsiveListItemFixedColumnRenderer"))
        .and_then(|value| value.get("text"))
        .and_then(text_from_value)
        .and_then(|value| parse_duration(&value))
        .or_else(|| extract_duration_from_row(row));
    let play_count =
        extract_play_count_from_row(row).or_else(|| extract_play_count_from_text(&meta));

    let has_type_label = kind_label
        .map(|value| is_type_label(&value.to_ascii_lowercase()))
        .unwrap_or(false);

    let artist = parsed_runs
        .artist_text
        .clone()
        .or_else(|| fallback_artist_from_meta(&meta_parts, has_type_label));

    let album = if kind == "song" || kind == "video" {
        parsed_runs.album_text.clone().filter(|value| parse_duration(value).is_none()).or_else(|| {
            let candidate = if has_type_label {
                meta_parts.get(2).cloned()
            } else {
                meta_parts.get(1).cloned()
            };
            // Reject duration strings masquerading as album names. Without this
            // filter, songs whose byline holds no album got `meta_parts[1]` like
            // "3:45" assigned as the album, which then printed into the Album
            // column on the imported playlist and read as "the duration leaked
            // into both columns".
            match candidate {
                Some(value) if parse_duration(&value).is_some() => None,
                other => other,
            }
        })
    } else {
        Some(title.clone())
    };

    let year = if kind == "album" {
        if has_type_label {
            meta_parts.get(2).cloned()
        } else {
            meta_parts.get(1).cloned()
        }
    } else {
        None
    };

    let artist_browse_id = parsed_runs
        .artist_browse_id
        .or_else(|| extract_artist_browse_id_from_menu(row, artist.as_deref()));

    Some(SearchItem {
        id: item_id(&kind, browse_id.as_deref(), video_id.as_deref(), &title),
        kind,
        title,
        subtitle,
        cover: best_thumbnail(row),
        browse_id,
        video_id,
        duration_seconds,
        play_count,
        artist,
        album,
        year,
        album_browse_id: parsed_runs
            .album_browse_id
            .or_else(|| extract_album_browse_id_from_menu(row)),
        artist_browse_id,
        artist_credits: (!parsed_runs.artist_credits.is_empty())
            .then_some(parsed_runs.artist_credits),
    })
}

fn parse_entity_detail(browse_id: &str, value: &Value) -> Result<EntityDetail, String> {
    let root = value
        .get("contents")
        .and_then(|value| value.get("twoColumnBrowseResultsRenderer"))
        .ok_or_else(|| "This detail page did not contain album or playlist data.".to_string())?;

    let header = root
        .get("tabs")
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|value| value.get("tabRenderer"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.get("sectionListRenderer"))
        .and_then(|value| value.get("contents"))
        .and_then(Value::as_array)
        .and_then(|contents| contents.first())
        .and_then(|value| value.get("musicResponsiveHeaderRenderer"))
        .ok_or_else(|| "Missing detail header.".to_string())?;

    let secondary = root
        .get("secondaryContents")
        .and_then(|value| value.get("sectionListRenderer"))
        .and_then(|value| value.get("contents"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing detail body.".to_string())?;

    let title = text_from_value(
        header
            .get("title")
            .ok_or_else(|| "Missing detail title.".to_string())?,
    )
    .ok_or_else(|| "Missing detail title.".to_string())?;
    let subtitle =
        text_from_value(header.get("subtitle").unwrap_or(&Value::Null)).unwrap_or_default();
    let cover = best_thumbnail(header);
    let description = header
        .get("description")
        .and_then(|value| value.get("musicDescriptionShelfRenderer"))
        .and_then(|value| value.get("description"))
        .and_then(text_from_value);
    let byline = header
        .get("straplineTextOne")
        .and_then(text_from_value)
        .or_else(|| {
            header
                .get("facepile")
                .and_then(|value| value.get("avatarStackViewModel"))
                .and_then(|value| value.get("text"))
                .and_then(|value| value.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let fallback_artist = byline
        .as_deref()
        .and_then(|value| infer_artist_from_text(value, false));
    let meta = header.get("secondSubtitle").and_then(text_from_value);

    let track_container = secondary
        .iter()
        .find_map(|section| {
            section
                .get("musicShelfRenderer")
                .and_then(|value| value.get("contents"))
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| {
                    section
                        .get("musicPlaylistShelfRenderer")
                        .and_then(|value| value.get("contents"))
                        .and_then(Value::as_array)
                        .cloned()
                })
        })
        .ok_or_else(|| "No tracks were returned for this page.".to_string())?;

    let tracks = track_container
        .iter()
        .filter_map(|item| {
            parse_track(
                item,
                Some(&title),
                fallback_artist.as_deref(),
                cover.as_deref(),
            )
        })
        .collect::<Vec<_>>();

    let kind = if subtitle.to_lowercase().contains("playlist") {
        "playlist"
    } else {
        "album"
    };

    Ok(EntityDetail {
        kind: kind.to_string(),
        browse_id: browse_id.to_string(),
        title,
        subtitle,
        description,
        cover,
        byline,
        meta,
        tracks,
    })
}

fn artist_overview_sections(value: &Value) -> Option<&[Value]> {
    value
        .get("contents")
        .and_then(|v| v.get("singleColumnBrowseResultsRenderer"))
        .and_then(|v| v.get("tabs"))
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|v| v.get("tabRenderer"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.get("sectionListRenderer"))
        .and_then(|v| v.get("contents"))
        .and_then(Value::as_array)
        .map(|sections| sections.as_slice())
}

fn shelf_section_title(shelf: &Value) -> Option<String> {
    // Artist overview shelves often expose `title` directly on the renderer
    // (no nested `header.musicShelfHeaderRenderer`).
    if let Some(title) = shelf.get("title").and_then(text_from_value) {
        return Some(title);
    }

    shelf
        .get("header")
        .and_then(|h| {
            h.get("musicShelfHeaderRenderer")
                .or(h.get("musicPlaylistShelfHeaderRenderer"))
        })
        .and_then(|h| h.get("title"))
        .and_then(text_from_value)
}

fn is_top_songs_section_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    (lower.contains("top") && (lower.contains("song") || lower.contains("track")))
        || lower == "songs"
        || lower.contains("popular")
}

fn top_songs_shelf_index(sections: &[Value]) -> Option<usize> {
    let mut best_index: Option<usize> = None;
    let mut fallback_index: Option<usize> = None;

    for (index, section) in sections.iter().enumerate() {
        let Some(shelf) = section
            .get("musicShelfRenderer")
            .or_else(|| section.get("musicPlaylistShelfRenderer"))
        else {
            continue;
        };

        if fallback_index.is_none() {
            fallback_index = Some(index);
        }

        if let Some(section_title) = shelf_section_title(shelf) {
            if is_top_songs_section_title(&section_title) {
                best_index = Some(index);
                break;
            }
        }
    }

    best_index.or(fallback_index)
}

fn top_songs_shelf<'a>(sections: &'a [Value]) -> Option<&'a Value> {
    let index = top_songs_shelf_index(sections)?;
    sections[index]
        .get("musicShelfRenderer")
        .or_else(|| sections[index].get("musicPlaylistShelfRenderer"))
}

fn continuation_token_from_item(item: &Value) -> Option<String> {
    let renderer = item.get("continuationItemRenderer")?;
    if let Some(token) = renderer
        .get("continuationEndpoint")
        .and_then(|endpoint| endpoint.get("continuationCommand"))
        .and_then(|command| command.get("token"))
        .and_then(Value::as_str)
    {
        return Some(token.to_string());
    }

    renderer
        .get("continuationEndpoint")
        .and_then(|endpoint| endpoint.get("commandExecutorCommand"))
        .and_then(|executor| executor.get("commands"))
        .and_then(Value::as_array)
        .and_then(|commands| {
            commands.iter().find_map(|command| {
                let request = command
                    .get("continuationCommand")
                    .and_then(|value| value.get("request"))
                    .and_then(Value::as_str);
                if request != Some("CONTINUATION_REQUEST_TYPE_BROWSE") {
                    return None;
                }
                command
                    .get("continuationCommand")
                    .and_then(|value| value.get("token"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
}

fn continuation_token_from_shelf_contents(contents: &[Value]) -> Option<String> {
    let last = contents.last()?;
    continuation_token_from_item(last)
}

fn shelf_continuation_token(shelf: &Value) -> Option<String> {
    shelf
        .get("continuations")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("nextContinuationData"))
        .and_then(|c| c.get("continuation"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            shelf
                .get("contents")
                .and_then(Value::as_array)
                .and_then(|contents| continuation_token_from_shelf_contents(contents.as_slice()))
        })
        .or_else(|| find_continuation_token(shelf))
}

fn parse_shelf_continuation_items(response: &Value) -> Option<Vec<Value>> {
    if let Some(actions) = response.get("onResponseReceivedActions").and_then(Value::as_array) {
        for action in actions {
            if let Some(items) = action
                .get("appendContinuationItemsAction")
                .and_then(|value| value.get("continuationItems"))
                .and_then(Value::as_array)
            {
                if !items.is_empty() {
                    return Some(items.to_vec());
                }
            }
        }
    }

    response
        .get("continuationContents")
        .and_then(|contents| {
            contents
                .get("musicShelfContinuation")
                .or(contents.get("musicPlaylistShelfContinuation"))
        })
        .and_then(|shelf| shelf.get("contents").or_else(|| shelf.get("items")))
        .and_then(Value::as_array)
        .map(|items| items.to_vec())
}

fn continuation_token_from_continuation_response(response: &Value) -> Option<String> {
    if let Some(items) = response
        .get("onResponseReceivedActions")
        .and_then(Value::as_array)
        .and_then(|actions| actions.first())
        .and_then(|action| action.get("appendContinuationItemsAction"))
        .and_then(|action| action.get("continuationItems"))
        .and_then(Value::as_array)
    {
        if let Some(token) = continuation_token_from_shelf_contents(items) {
            return Some(token);
        }
    }

    response
        .get("continuationContents")
        .and_then(|contents| {
            contents
                .get("musicShelfContinuation")
                .or(contents.get("musicPlaylistShelfContinuation"))
        })
        .and_then(shelf_continuation_token)
}

fn extract_top_songs_continuation(value: &Value) -> Option<String> {
    let sections = artist_overview_sections(value)?;
    let shelf = top_songs_shelf(sections)?;
    shelf_continuation_token(shelf)
}

fn top_songs_playlist_browse_id(shelf: &Value) -> Option<String> {
    if let Some(browse_id) = as_str_path(
        shelf,
        &["bottomEndpoint", "browseEndpoint", "browseId"],
    ) {
        return Some(browse_id.to_string());
    }

    if let Some(runs) = shelf
        .get("title")
        .and_then(|title| title.get("runs"))
        .and_then(Value::as_array)
    {
        for run in runs {
            if let Some(browse_id) =
                as_str_path(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
            {
                return Some(browse_id.to_string());
            }
        }
    }

    if let Some(header) = shelf.get("header") {
        let header_renderer = header
            .get("musicShelfHeaderRenderer")
            .or_else(|| header.get("musicPlaylistShelfHeaderRenderer"))?;

        if let Some(runs) = header_renderer
            .get("title")
            .and_then(|title| title.get("runs"))
            .and_then(Value::as_array)
        {
            for run in runs {
                if let Some(browse_id) =
                    as_str_path(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
                {
                    return Some(browse_id.to_string());
                }
            }
        }

        if let Some(buttons) = header_renderer.get("buttons").and_then(Value::as_array) {
            for button in buttons {
                for path in [
                    &["buttonRenderer", "navigationEndpoint", "browseEndpoint", "browseId"][..],
                    &[
                        "musicPlayButtonRenderer",
                        "playNavigationEndpoint",
                        "watchPlaylistEndpoint",
                        "playlistId",
                    ][..],
                ] {
                    if let Some(id) = as_str_path(button, path) {
                        let browse_id = if path.last() == Some(&"playlistId") {
                            format!("VL{id}")
                        } else {
                            id.to_string()
                        };
                        return Some(browse_id);
                    }
                }
            }
        }
    }

    as_str_path(
        shelf,
        &["bottomText", "runs", "0", "navigationEndpoint", "browseEndpoint", "browseId"],
    )
    .map(str::to_string)
}

fn find_track_shelf_in_browse_response(value: &Value) -> Option<&Value> {
    if let Some(sections) = value
        .get("contents")
        .and_then(|contents| contents.get("twoColumnBrowseResultsRenderer"))
        .and_then(|renderer| renderer.get("secondaryContents"))
        .and_then(|secondary| secondary.get("sectionListRenderer"))
        .and_then(|section_list| section_list.get("contents"))
        .and_then(Value::as_array)
    {
        for section in sections {
            if let Some(shelf) = section
                .get("musicPlaylistShelfRenderer")
                .or_else(|| section.get("musicShelfRenderer"))
            {
                if shelf
                    .get("contents")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
                {
                    return Some(shelf);
                }
            }
        }
    }

    if let Some(sections) = value
        .get("contents")
        .and_then(|contents| contents.get("twoColumnBrowseResultsRenderer"))
        .and_then(|renderer| renderer.get("tabs"))
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|tab| tab.get("tabRenderer"))
        .and_then(|tab_renderer| tab_renderer.get("content"))
        .and_then(|content| content.get("sectionListRenderer"))
        .and_then(|section_list| section_list.get("contents"))
        .and_then(Value::as_array)
    {
        for section in sections {
            if let Some(shelf) = section
                .get("musicPlaylistShelfRenderer")
                .or_else(|| section.get("musicShelfRenderer"))
            {
                if shelf
                    .get("contents")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
                {
                    return Some(shelf);
                }
            }
        }
    }

    artist_overview_sections(value).and_then(top_songs_shelf)
}

fn parse_tracks_from_shelf_items(
    items: &[Value],
    artist: &str,
    cover: Option<&str>,
) -> Vec<MediaTrack> {
    items
        .iter()
        .filter_map(|item| parse_track(item, None, Some(artist), cover))
        .collect()
}

fn parse_playlist_tracks_from_shelf_items(
    items: &[Value],
    playlist_title: &str,
    fallback_artist: Option<&str>,
    cover: Option<&str>,
) -> Vec<MediaTrack> {
    items
        .iter()
        .filter_map(|item| parse_track(item, Some(playlist_title), fallback_artist, cover))
        .collect()
}

fn merge_playlist_tracks(tracks: &mut Vec<MediaTrack>, extra: Vec<MediaTrack>, limit: usize) {
    let mut seen = tracks
        .iter()
        .map(|track| track_identity_key(track))
        .collect::<std::collections::HashSet<_>>();
    for track in extra {
        if tracks.len() >= limit {
            break;
        }
        let key = track_identity_key(&track);
        if seen.insert(key) {
            tracks.push(track);
        }
    }
}

async fn fetch_playlist_shelf_tracks_with_continuations(
    state: &State<'_, AppState>,
    shelf: &Value,
    playlist_title: &str,
    fallback_artist: Option<&str>,
    cover: Option<&str>,
    limit: usize,
) -> Result<Vec<MediaTrack>, String> {
    let mut tracks = shelf
        .get("contents")
        .and_then(Value::as_array)
        .map(|items| {
            parse_playlist_tracks_from_shelf_items(items, playlist_title, fallback_artist, cover)
        })
        .unwrap_or_default();
    tracks.truncate(limit);
    if tracks.len() >= limit {
        return Ok(tracks);
    }

    let mut continuation_token = shelf_continuation_token(shelf);
    while let Some(token) = continuation_token {
        if tracks.len() >= limit {
            break;
        }

        let cont_response = post_ytmusic_continuation(state, &token).await?;
        let Some(items) = parse_shelf_continuation_items(&cont_response) else {
            break;
        };

        let batch =
            parse_playlist_tracks_from_shelf_items(&items, playlist_title, fallback_artist, cover);
        if batch.is_empty() {
            break;
        }

        merge_playlist_tracks(&mut tracks, batch, limit);
        continuation_token = continuation_token_from_shelf_contents(&items)
            .or_else(|| continuation_token_from_continuation_response(&cont_response));
    }

    Ok(tracks)
}

fn merge_top_songs(tracks: &mut Vec<MediaTrack>, extra: Vec<MediaTrack>, limit: usize) {
    let mut seen = tracks
        .iter()
        .map(|track| track_identity_key(track))
        .collect::<std::collections::HashSet<_>>();
    for track in extra {
        if tracks.len() >= limit {
            break;
        }
        let key = track_identity_key(&track);
        if seen.insert(key) {
            tracks.push(track);
        }
    }
}

fn track_identity_key(track: &MediaTrack) -> String {
    track
        .video_id
        .as_deref()
        .or(Some(track.id.as_str()))
        .unwrap_or("")
        .to_string()
}

async fn fetch_shelf_tracks_with_continuations(
    state: &State<'_, AppState>,
    shelf: &Value,
    artist: &str,
    cover: Option<&str>,
    limit: usize,
) -> Result<Vec<MediaTrack>, String> {
    let mut tracks = shelf
        .get("contents")
        .and_then(Value::as_array)
        .map(|items| parse_tracks_from_shelf_items(items, artist, cover))
        .unwrap_or_default();
    tracks.truncate(limit);
    if tracks.len() >= limit {
        return Ok(tracks);
    }

    let mut continuation_token = shelf_continuation_token(shelf);
    while let Some(token) = continuation_token {
        if tracks.len() >= limit {
            break;
        }

        let cont_response = post_ytmusic_continuation(state, &token).await?;
        let Some(items) = parse_shelf_continuation_items(&cont_response) else {
            break;
        };

        let batch = parse_tracks_from_shelf_items(&items, artist, cover);
        if batch.is_empty() {
            break;
        }

        merge_top_songs(&mut tracks, batch, limit);
        continuation_token = continuation_token_from_shelf_contents(&items)
            .or_else(|| continuation_token_from_continuation_response(&cont_response));
    }

    Ok(tracks)
}

fn find_continuation_token(value: &Value) -> Option<String> {
    if let Some(token) = value
        .get("nextContinuationData")
        .and_then(|data| data.get("continuation"))
        .and_then(Value::as_str)
    {
        return Some(token.to_string());
    }

    if let Some(token) = value
        .get("continuationCommand")
        .and_then(|data| data.get("token"))
        .and_then(Value::as_str)
    {
        return Some(token.to_string());
    }

    match value {
        Value::Array(items) => items.iter().find_map(find_continuation_token),
        Value::Object(map) => map.values().find_map(find_continuation_token),
        _ => None,
    }
}

fn parse_artist_detail(browse_id: &str, value: &Value) -> Result<ArtistDetail, String> {
    let header = value
        .get("header")
        .and_then(|value| value.get("musicImmersiveHeaderRenderer"))
        .ok_or_else(|| "This artist page did not contain a header.".to_string())?;

    let sections = artist_overview_sections(value)
        .ok_or_else(|| "This artist page did not contain sections.".to_string())?;

    let title = text_from_value(
        header
            .get("title")
            .ok_or_else(|| "Artist title missing.".to_string())?,
    )
    .ok_or_else(|| "Artist title missing.".to_string())?;
    let banner = best_banner_thumbnail(header)
        .or_else(|| best_thumbnail(header))
        .map(|url| banner_artist_thumbnail_url(&url));
    let cover = banner.as_deref().map(square_artist_thumbnail_url);
    let description = header.get("description").and_then(text_from_value);
    let monthly_listeners = header.get("monthlyListenerCount").and_then(text_from_value);

    let top_songs = top_songs_shelf(sections)
        .and_then(|shelf| shelf.get("contents"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| parse_track(item, None, Some(title.as_str()), cover.as_deref()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let shelves = sections
        .iter()
        .filter_map(|section| section.get("musicCarouselShelfRenderer"))
        .filter_map(parse_artist_shelf)
        .collect::<Vec<_>>();

    Ok(ArtistDetail {
        browse_id: browse_id.to_string(),
        title,
        description,
        cover,
        banner,
        monthly_listeners,
        top_songs,
        top_songs_has_more: false,
        shelves,
    })
}

fn parse_artist_shelf(value: &Value) -> Option<ArtistShelf> {
    let title = value
        .get("header")
        .and_then(|value| value.get("musicCarouselShelfBasicHeaderRenderer"))
        .and_then(|value| value.get("title"))
        .and_then(text_from_value)?;

    let items = value
        .get("contents")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| {
            let row = item.get("musicTwoRowItemRenderer")?;
            let title = row.get("title").and_then(text_from_value)?;
            let subtitle = row
                .get("subtitle")
                .and_then(text_from_value)
                .unwrap_or_default();
            let browse_id = as_str_path(row, &["navigationEndpoint", "browseEndpoint", "browseId"])
                .map(str::to_string)?;
            let page_type = as_str_path(
                row,
                &[
                    "navigationEndpoint",
                    "browseEndpoint",
                    "browseEndpointContextSupportedConfigs",
                    "browseEndpointContextMusicConfig",
                    "pageType",
                ],
            )
            .unwrap_or("MUSIC_PAGE_TYPE_ALBUM");
            let kind = if page_type.contains("PLAYLIST") {
                "playlist"
            } else {
                "album"
            };
            Some(SearchItem {
                id: item_id(kind, Some(&browse_id), None, &title),
                kind: kind.to_string(),
                title,
                subtitle: if kind == "playlist" {
                    format!("Playlist • {subtitle}")
                } else {
                    format!("Album • {subtitle}")
                },
                cover: best_thumbnail(row),
                browse_id: Some(browse_id),
                video_id: None,
                duration_seconds: None,
                play_count: None,
                artist: None,
                album: None,
                album_browse_id: None,
                artist_browse_id: None,
                artist_credits: None,
                year: if kind == "album" {
                    Some(subtitle)
                } else {
                    None
                },
            })
        })
        .collect::<Vec<_>>();

    if items.is_empty() {
        None
    } else {
        Some(ArtistShelf { title, items })
    }
}

#[derive(Default)]
struct RunSegment {
    text: String,
    links: Vec<ArtistCredit>,
}

#[derive(Default)]
struct ParsedRunMeta {
    /// The leading type label when the byline starts with one of
    /// `is_type_label` values (e.g. "Song", "Video", "Episode"). Empty when
    /// the byline has no label so callers can fall back to other heuristics.
    type_label: Option<String>,
    artist_text: Option<String>,
    album_text: Option<String>,
    artist_browse_id: Option<String>,
    album_browse_id: Option<String>,
    artist_credits: Vec<ArtistCredit>,
}

#[allow(dead_code)]
fn extract_text_and_browse_from_runs(value: &Value) -> ParsedRunMeta {
    let runs = match value.get("runs").and_then(Value::as_array) {
        Some(runs) => runs,
        None => return ParsedRunMeta::default(),
    };
    let mut artist_text: Option<String> = None;
    let mut album_text: Option<String> = None;
    let mut artist_id: Option<String> = None;
    let mut album_id: Option<String> = None;
    for run in runs {
        let text = match run.get("text").and_then(Value::as_str) {
            Some(t) => t.trim().to_string(),
            None => continue,
        };
        if text.is_empty() || text == "•" {
            continue;
        }
        if let Some(browse_id) =
            as_str_path(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
        {
            if artist_text.is_none() {
                artist_text = Some(text);
                artist_id = Some(browse_id.to_string());
            } else if album_text.is_none() {
                album_text = Some(text);
                album_id = Some(browse_id.to_string());
            }
        }
    }
    ParsedRunMeta {
        type_label: None,
        artist_text,
        album_text,
        artist_browse_id: artist_id,
        album_browse_id: album_id,
        artist_credits: Vec::new(),
    }
}

#[allow(dead_code)]
fn extract_browse_ids_from_runs(value: &Value) -> (Option<String>, Option<String>) {
    let runs = match value.get("runs").and_then(Value::as_array) {
        Some(runs) => runs,
        None => return (None, None),
    };
    let mut ids: Vec<String> = Vec::new();
    for run in runs {
        if let Some(browse_id) =
            as_str_path(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
        {
            ids.push(browse_id.to_string());
        }
    }
    (ids.first().cloned(), ids.get(1).cloned())
}

fn extract_run_meta_from_runs(value: &Value) -> ParsedRunMeta {
    let runs = match value.get("runs").and_then(Value::as_array) {
        Some(runs) => runs,
        None => return ParsedRunMeta::default(),
    };

    let mut segments = vec![RunSegment::default()];
    for run in runs {
        let Some(raw_text) = run.get("text").and_then(Value::as_str) else {
            continue;
        };
        if raw_text.is_empty() {
            continue;
        }

        let normalized_text = normalize_bullet_text(raw_text);
        let browse_id = as_str_path(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
            .map(str::to_string);
        let pieces = normalized_text.split('\u{2022}').collect::<Vec<_>>();

        for (index, piece) in pieces.iter().enumerate() {
            if index > 0 {
                segments.push(RunSegment::default());
            }

            if piece.is_empty() {
                continue;
            }

            if let Some(current) = segments.last_mut() {
                current.text.push_str(piece);

                if let Some(id) = browse_id.as_ref() {
                    let name = piece.trim();
                    if !name.is_empty() {
                        current.links.push(ArtistCredit {
                            name: name.to_string(),
                            browse_id: id.clone(),
                        });
                    }
                }
            }
        }
    }

    let segments = segments
        .into_iter()
        .filter_map(|mut segment| {
            segment.text = segment.text.trim().to_string();
            if segment.text.is_empty() && segment.links.is_empty() {
                None
            } else {
                Some(segment)
            }
        })
        .collect::<Vec<_>>();

    if segments.is_empty() {
        return ParsedRunMeta::default();
    }

    let start_index = segments
        .first()
        .map(|segment| is_type_label(&segment.text.to_ascii_lowercase()))
        .unwrap_or(false) as usize;

    let type_label = if start_index > 0 {
        Some(segments[0].text.trim().to_string())
    } else {
        None
    };

    let artist_index = segments
        .iter()
        .enumerate()
        .skip(start_index)
        .find(|(_, segment)| {
            !segment.links.is_empty() || !looks_like_non_artist_meta(&segment.text)
        })
        .map(|(index, _)| index);

    let Some(artist_index) = artist_index else {
        return ParsedRunMeta {
            type_label,
            ..ParsedRunMeta::default()
        };
    };

    let artist_segment = &segments[artist_index];
    let artist_credits = artist_segment
        .links
        .iter()
        .fold(Vec::new(), |mut credits, credit| {
            if !credit.name.trim().is_empty()
                && !credit.browse_id.trim().is_empty()
                && !credits
                    .iter()
                    .any(|existing: &ArtistCredit| existing.browse_id == credit.browse_id)
            {
                credits.push(credit.clone());
            }
            credits
        });

    let album_segment = segments
        .iter()
        .skip(artist_index + 1)
        .find(|segment| !segment.links.is_empty());

    let album_text_segment = album_segment.or_else(|| {
        segments
            .iter()
            .skip(artist_index + 1)
            .find(|segment| !segment.text.is_empty())
    });

    ParsedRunMeta {
        type_label,
        artist_text: Some(artist_segment.text.clone()).filter(|value| !value.is_empty()),
        album_text: album_text_segment
            .map(|segment| segment.text.clone())
            .filter(|value| !value.is_empty()),
        artist_browse_id: artist_credits
            .first()
            .map(|credit| credit.browse_id.clone()),
        album_browse_id: album_segment
            .and_then(|segment| segment.links.first())
            .map(|credit| credit.browse_id.clone()),
        artist_credits,
    }
}

fn extract_album_browse_id_from_menu(renderer: &Value) -> Option<String> {
    let items = renderer
        .get("menu")
        .and_then(|m| m.get("menuRenderer"))
        .and_then(|r| r.get("items"))
        .and_then(Value::as_array)?;
    for item in items {
        let Some(nav) = item
            .get("menuNavigationItemRenderer")
            .or_else(|| item.get("menuServiceItemRenderer"))
        else {
            continue;
        };
        let Some(browse_id) = as_str_path(nav, &["navigationEndpoint", "browseEndpoint", "browseId"]) else {
            continue;
        };
        let page_type = as_str_path(
            nav,
            &[
                "navigationEndpoint",
                "browseEndpoint",
                "browseEndpointContextSupportedConfigs",
                "browseEndpointContextMusicConfig",
                "pageType",
            ],
        )
        .unwrap_or("");
        if page_type == "MUSIC_PAGE_TYPE_ALBUM" {
            return Some(browse_id.to_string());
        }
        let icon_type = nav
            .get("icon")
            .and_then(|i| i.get("iconType"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = nav
            .get("text")
            .and_then(|t| t.get("runs"))
            .and_then(Value::as_array)
            .and_then(|runs| runs.first())
            .and_then(|run| run.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if icon_type == "ALBUM" || text.to_ascii_lowercase().contains("album") {
            return Some(browse_id.to_string());
        }
    }
    None
}

fn extract_artist_browse_id_from_menu(
    renderer: &Value,
    artist_name: Option<&str>,
) -> Option<String> {
    let items = renderer
        .get("menu")
        .and_then(|m| m.get("menuRenderer"))
        .and_then(|r| r.get("items"))
        .and_then(Value::as_array)?;
    let normalized_artist_name = artist_name
        .map(normalize_menu_text)
        .filter(|value| !value.is_empty());

    for item in items {
        let Some(nav) = item
            .get("menuNavigationItemRenderer")
            .or_else(|| item.get("menuServiceItemRenderer"))
        else {
            continue;
        };
        let Some(browse_id) = as_str_path(nav, &["navigationEndpoint", "browseEndpoint", "browseId"]) else {
            continue;
        };
        let page_type = as_str_path(
            nav,
            &[
                "navigationEndpoint",
                "browseEndpoint",
                "browseEndpointContextSupportedConfigs",
                "browseEndpointContextMusicConfig",
                "pageType",
            ],
        )
        .unwrap_or("");
        if page_type == "MUSIC_PAGE_TYPE_ARTIST" {
            return Some(browse_id.to_string());
        }

        let icon_type = nav
            .get("icon")
            .and_then(|i| i.get("iconType"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = nav
            .get("text")
            .and_then(text_from_value)
            .unwrap_or_default();
        let normalized_text = normalize_menu_text(&text);

        if icon_type == "ARTIST"
            || icon_type == "PERSON"
            || normalized_text.contains("artist")
            || normalized_artist_name
                .as_ref()
                .is_some_and(|artist| normalized_text == *artist)
        {
            return Some(browse_id.to_string());
        }
    }

    None
}

fn parse_track(
    value: &Value,
    album: Option<&str>,
    fallback_artist: Option<&str>,
    fallback_cover: Option<&str>,
) -> Option<MediaTrack> {
    let row = value.get("musicResponsiveListItemRenderer")?;
    let flex_columns = row.get("flexColumns")?.as_array()?;

    let flex = flex_columns
        .iter()
        .filter_map(|column| {
            column
                .get("musicResponsiveListItemFlexColumnRenderer")
                .and_then(|value| value.get("text"))
                .and_then(text_from_value)
        })
        .collect::<Vec<_>>();

    let title = flex.first()?.clone();

    let col1_text = flex_columns
        .get(1)
        .and_then(|col| col.get("musicResponsiveListItemFlexColumnRenderer"))
        .and_then(|v| v.get("text"));
    let parsed_runs = col1_text
        .map(extract_run_meta_from_runs)
        .unwrap_or_default();
    if parsed_runs
        .type_label
        .as_deref()
        .is_some_and(is_excluded_type_label)
    {
        return None;
    }
    let artist = parsed_runs.artist_text.unwrap_or_else(|| {
        let meta = flex.get(1).cloned().unwrap_or_default();
        let parts = split_bullets_fixed(&meta);
        let has_type_label = parts
            .first()
            .map(|part| is_type_label(&part.to_ascii_lowercase()))
            .unwrap_or(false);
        fallback_artist_from_meta(&parts, has_type_label)
            .or_else(|| fallback_artist.map(str::to_string))
            .unwrap_or_else(|| "Unknown artist".to_string())
    });
    let artist_browse_id = parsed_runs
        .artist_browse_id
        .clone()
        .or_else(|| extract_artist_browse_id_from_menu(row, Some(&artist)));

    let duration_seconds = extract_duration_from_row(row);
    let play_count = extract_play_count_from_row(row)
        .or_else(|| {
            flex.get(2)
                .and_then(|value| extract_play_count_from_text(value))
        })
        .or_else(|| {
            flex.get(1)
                .and_then(|value| extract_play_count_from_text(value))
        });

    let video_id = as_str_path(row, &["playlistItemData", "videoId"])
        .or_else(|| {
            as_str_path(
                row,
                &[
                    "overlay",
                    "musicItemThumbnailOverlayRenderer",
                    "content",
                    "musicPlayButtonRenderer",
                    "playNavigationEndpoint",
                    "watchEndpoint",
                    "videoId",
                ],
            )
        })?
        .to_string();
    let album_browse_id = parsed_runs
        .album_browse_id
        .or_else(|| extract_album_browse_id_from_menu(row));

    Some(MediaTrack {
        id: track_id(&video_id, album_browse_id.as_deref()),
        kind: parsed_runs
            .type_label
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .filter(|value| !is_excluded_type_label(value)),
        title,
        artist,
        album: album.map(str::to_string),
        album_browse_id,
        artist_browse_id,
        artist_credits: (!parsed_runs.artist_credits.is_empty())
            .then_some(parsed_runs.artist_credits),
        duration_seconds,
        play_count,
        cover: best_thumbnail(row).or_else(|| fallback_cover.map(str::to_string)),
        video_id: Some(video_id),
        source: "stream",
        audio_src: None,
        file_path: None,
        find_lyrics: false,
    })
}



fn item_id(kind: &str, browse_id: Option<&str>, video_id: Option<&str>, title: &str) -> String {
    if let Some(browse_id) = browse_id {
        return format!("browse:{browse_id}");
    }
    if let Some(video_id) = video_id {
        return format!("video:{video_id}");
    }
    format!("{}:{}", kind, title.to_lowercase())
}

/// Build the canonical `MediaTrack.id` for a YouTube Music stream track.
///
/// The same underlying video is often distributed under multiple releases
/// (e.g. a single and its parent album). To let the UI distinguish those
/// rows we append the source album's browse id when one is known — when it
/// isn't, we keep the id stable so audio-analysis caches still hit.
fn track_id(video_id: &str, album_browse_id: Option<&str>) -> String {
    match album_browse_id {
        Some(album_id) if !album_id.is_empty() => format!("yt:{video_id}:{album_id}"),
        _ => format!("yt:{video_id}"),
    }
}

fn normalize_menu_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn text_from_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("simpleText").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        return Some(content.to_string());
    }
    if let Some(text) = value.get("text") {
        return text_from_value(text);
    }
    if let Some(runs) = value.get("runs").and_then(Value::as_array) {
        let joined = runs
            .iter()
            .filter_map(|run| run.get("text").and_then(Value::as_str))
            .collect::<String>();
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    None
}

#[allow(dead_code)]
fn split_bullets(value: &str) -> Vec<String> {
    value
        .split('•')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_excluded_type_label(label: &str) -> bool {
    matches!(
        label.trim().to_ascii_lowercase().as_str(),
        "episode" | "podcast" | "mix"
    )
}

fn normalize_kind(label: Option<&str>, has_browse: bool, has_video: bool) -> String {
    match label.map(|value| value.to_lowercase()) {
        Some(label) if is_excluded_type_label(&label) => "unknown".to_string(),
        Some(label) if label == "artist" => "artist".to_string(),
        Some(label) if label == "album" || label == "single" || label == "ep" => {
            "album".to_string()
        }
        Some(label) if label == "playlist" || label == "podcast" || label == "episode" => {
            "playlist".to_string()
        }
        Some(label) if label == "video" => "video".to_string(),
        Some(label) if label == "song" => "song".to_string(),
        _ if has_video => "song".to_string(),
        _ if has_browse => "playlist".to_string(),
        _ => "unknown".to_string(),
    }
}

fn normalize_bullet_text(value: &str) -> String {
    value
        .replace("â€¢", "\u{2022}")
        .replace("Ã¢â‚¬Â¢", "\u{2022}")
        .replace("ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢", "\u{2022}")
}

fn split_bullets_fixed(value: &str) -> Vec<String> {
    value
        .replace("â€¢", "\u{2022}")
        .replace("Ã¢â‚¬Â¢", "\u{2022}")
        .split('\u{2022}')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_type_label(value: &str) -> bool {
    matches!(
        value,
        "song"
            | "artist"
            | "album"
            | "single"
            | "ep"
            | "playlist"
            | "podcast"
            | "episode"
            | "mix"
            | "video"
    )
}

fn looks_like_non_artist_meta(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }

    let lower = trimmed.to_ascii_lowercase();
    if is_type_label(&lower) || lower == "explicit" {
        return true;
    }

    if parse_duration(trimmed).is_some() {
        return true;
    }

    if trimmed.len() == 4 && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return true;
    }

    if lower.contains("monthly listener") {
        return true;
    }

    let has_digits = trimmed.chars().any(|ch| ch.is_ascii_digit());
    has_digits
        && lower
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|token| {
                matches!(
                    token,
                    "play"
                        | "plays"
                        | "view"
                        | "views"
                        | "stream"
                        | "streams"
                        | "listener"
                        | "listeners"
                        | "subscriber"
                        | "subscribers"
                )
            })
}

fn fallback_artist_from_meta(meta_parts: &[String], has_type_label: bool) -> Option<String> {
    meta_parts
        .iter()
        .skip(usize::from(has_type_label))
        .find(|part| !looks_like_non_artist_meta(part))
        .cloned()
}

fn infer_artist_from_text(value: &str, has_type_label: bool) -> Option<String> {
    let parts = split_bullets_fixed(value);
    fallback_artist_from_meta(&parts, has_type_label)
}

fn fixed_column_texts(row: &Value) -> Vec<String> {
    row.get("fixedColumns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(|column| {
                    column
                        .get("musicResponsiveListItemFixedColumnRenderer")
                        .and_then(|value| value.get("text"))
                        .and_then(text_from_value)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn flex_column_texts(row: &Value) -> Vec<String> {
    row.get("flexColumns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(|column| {
                    column
                        .get("musicResponsiveListItemFlexColumnRenderer")
                        .and_then(|value| value.get("text"))
                        .and_then(text_from_value)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_duration_from_text(value: &str) -> Option<u32> {
    parse_duration(value).or_else(|| {
        split_bullets_fixed(value)
            .into_iter()
            .rev()
            .find_map(|part| parse_duration(&part))
    })
}

fn extract_duration_from_row(row: &Value) -> Option<u32> {
    fixed_column_texts(row)
        .iter()
        .rev()
        .find_map(|value| parse_duration_from_text(value))
        .or_else(|| {
            row.get("lengthText")
                .or_else(|| row.get("durationText"))
                .and_then(text_from_value)
                .and_then(|value| parse_duration_from_text(&value))
        })
        .or_else(|| {
            flex_column_texts(row)
                .iter()
                .skip(1)
                .rev()
                .find_map(|value| parse_duration_from_text(value))
        })
}

fn strip_count_word(value: &str) -> String {
    let mut current = value.trim().to_string();
    loop {
        let lower = current.to_ascii_lowercase();
        let Some(word) = [
            "plays",
            "play",
            "views",
            "view",
            "streams",
            "stream",
            "listeners",
            "listener",
        ]
        .iter()
        .find(|word| lower.ends_with(**word)) else {
            break;
        };

        let next = current[..current.len() - word.len()]
            .trim_end_matches(|ch: char| ch.is_whitespace() || ch == '-' || ch == ':')
            .trim()
            .to_string();
        if next == current {
            break;
        }
        current = next;
    }
    current
}

fn parse_play_count_candidate(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || parse_duration(trimmed).is_some() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    let has_count_word = [
        "play",
        "plays",
        "view",
        "views",
        "stream",
        "streams",
        "listener",
        "listeners",
    ]
    .iter()
    .any(|word| lower.contains(word));
    let stripped = strip_count_word(trimmed);
    let compact = stripped
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != ',')
        .collect::<String>();
    let has_digit = compact.chars().any(|ch| ch.is_ascii_digit());
    if !has_digit {
        return None;
    }

    let looks_plain_number = compact.len() >= 5 && compact.chars().all(|ch| ch.is_ascii_digit());
    let looks_comma_number =
        stripped.contains(',') && compact.chars().all(|ch| ch.is_ascii_digit());
    let looks_abbreviated = compact
        .chars()
        .last()
        .is_some_and(|ch| matches!(ch.to_ascii_uppercase(), 'K' | 'M' | 'B'))
        && compact[..compact.len().saturating_sub(1)]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.');

    if has_count_word || looks_comma_number || looks_plain_number || looks_abbreviated {
        Some(stripped)
    } else {
        None
    }
}

fn extract_play_count_from_text(value: &str) -> Option<String> {
    split_bullets_fixed(value)
        .into_iter()
        .find_map(|part| parse_play_count_candidate(&part))
        .or_else(|| parse_play_count_candidate(value))
}

fn extract_play_count_from_row(row: &Value) -> Option<String> {
    row.get("playCountText")
        .or_else(|| row.get("viewCountText"))
        .and_then(text_from_value)
        .and_then(|value| extract_play_count_from_text(&value))
        .or_else(|| {
            fixed_column_texts(row)
                .iter()
                .find_map(|value| parse_play_count_candidate(value))
        })
        .or_else(|| {
            flex_column_texts(row)
                .iter()
                .skip(1)
                .find_map(|value| extract_play_count_from_text(value))
        })
}

fn parse_duration(value: &str) -> Option<u32> {
    let parts = value
        .split(':')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    match parts.as_slice() {
        [minutes, seconds] => Some(minutes * 60 + seconds),
        [hours, minutes, seconds] => Some(hours * 3600 + minutes * 60 + seconds),
        _ => None,
    }
}

fn best_thumbnail(value: &Value) -> Option<String> {
    let paths = [
        [
            "thumbnail",
            "musicThumbnailRenderer",
            "thumbnail",
            "thumbnails",
        ]
        .as_slice(),
        [
            "thumbnailRenderer",
            "musicThumbnailRenderer",
            "thumbnail",
            "thumbnails",
        ]
        .as_slice(),
        ["musicThumbnailRenderer", "thumbnail", "thumbnails"].as_slice(),
        ["thumbnail", "thumbnails"].as_slice(),
    ];

    for path in paths {
        if let Some(url) = get_path(value, path)
            .and_then(Value::as_array)
            .and_then(|thumbnails| select_thumbnail_url(thumbnails))
        {
            return Some(url);
        }
    }
    None
}

fn best_banner_thumbnail(value: &Value) -> Option<String> {
    let paths = [
        [
            "thumbnail",
            "musicThumbnailRenderer",
            "thumbnail",
            "thumbnails",
        ]
        .as_slice(),
        [
            "thumbnailRenderer",
            "musicThumbnailRenderer",
            "thumbnail",
            "thumbnails",
        ]
        .as_slice(),
        ["musicThumbnailRenderer", "thumbnail", "thumbnails"].as_slice(),
        ["thumbnail", "thumbnails"].as_slice(),
    ];

    for path in paths {
        if let Some(url) = get_path(value, path)
            .and_then(Value::as_array)
            .and_then(|thumbnails| select_largest_thumbnail_url(thumbnails))
        {
            return Some(url);
        }
    }
    None
}

fn select_thumbnail_url(thumbnails: &[Value]) -> Option<String> {
    let normalized = thumbnails
        .iter()
        .filter_map(|thumb| {
            let url = thumb.get("url").and_then(Value::as_str)?;
            Some((
                normalize_thumbnail_url(url),
                thumb.get("width").and_then(Value::as_u64).unwrap_or(0),
            ))
        })
        .collect::<Vec<_>>();

    normalized
        .iter()
        .find(|(_, width)| *width >= PREFERRED_THUMBNAIL_WIDTH)
        .map(|(url, _)| url.clone())
        // YouTube doesn't always emit a thumbnail at or above our preferred
        // width (e.g. some album art tops out at 544×544). Don't assume the
        // array is sorted — explicitly pick the largest available so we never
        // accidentally serve a tiny placeholder.
        .or_else(|| {
            normalized
                .iter()
                .max_by_key(|(_, width)| *width)
                .map(|(url, _)| url.clone())
        })
}

fn select_largest_thumbnail_url(thumbnails: &[Value]) -> Option<String> {
    thumbnails
        .iter()
        .filter_map(|thumb| {
            let url = thumb.get("url").and_then(Value::as_str)?;
            let width = thumb.get("width").and_then(Value::as_u64).unwrap_or(0);
            let height = thumb.get("height").and_then(Value::as_u64).unwrap_or(0);
            Some((normalize_thumbnail_url(url), width.saturating_mul(height)))
        })
        .max_by_key(|(_, area)| *area)
        .map(|(url, _)| url)
}

fn normalize_thumbnail_url(url: &str) -> String {
    if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url.to_string()
    }
}

fn square_artist_thumbnail_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return square_artist_thumbnail_base(url);
    };
    format!("{}?{query}", square_artist_thumbnail_base(base))
}

fn banner_artist_thumbnail_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return banner_artist_thumbnail_base(url);
    };
    format!("{}?{query}", banner_artist_thumbnail_base(base))
}

fn square_artist_thumbnail_base(url: &str) -> String {
    let Some((prefix, suffix)) = url.rsplit_once('=') else {
        return url.to_string();
    };

    if !suffix.starts_with('w') {
        return url.to_string();
    }

    format!("{prefix}=w{ARTIST_AVATAR_SIZE}-h{ARTIST_AVATAR_SIZE}-p-l90-rj")
}

fn banner_artist_thumbnail_base(url: &str) -> String {
    let Some((prefix, suffix)) = url.rsplit_once('=') else {
        return url.to_string();
    };

    if !suffix.starts_with('w') {
        return url.to_string();
    }

    format!("{prefix}=w{ARTIST_BANNER_WIDTH}-h{ARTIST_BANNER_HEIGHT}-p-l90-rj")
}

fn as_str_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    get_path(value, path).and_then(Value::as_str)
}

fn watch_next_payload(video_id: &str, playlist_id: Option<&str>) -> Value {
    let mut payload = json!({
        "enablePersistentPlaylistPanel": true,
        "isAudioOnly": true,
        "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
        "videoId": video_id,
        "playlistId": format!("RDAMVM{video_id}"),
        "watchEndpointMusicSupportedConfigs": {
            "watchEndpointMusicConfig": {
                "hasPersistentPlaylistPanel": true,
                "musicVideoType": "MUSIC_VIDEO_TYPE_ATV"
            }
        }
    });

    if let Some(playlist_id) = playlist_id.filter(|value| !value.is_empty()) {
        payload["playlistId"] = json!(playlist_id);
    }

    payload
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn append_updater_log(app: &AppHandle, message: &str) {
    use std::io::Write;

    eprintln!("[updater] {message}");
    if let Ok(dir) = app.path().app_local_data_dir() {
        let path = dir.join("updater.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{message}");
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn spawn_startup_updater(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let current = handle.package_info().version.to_string();
        let updater = match handle.updater() {
            Ok(updater) => updater,
            Err(error) => {
                append_updater_log(&handle, &format!("failed to initialize updater: {error}"));
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                append_updater_log(
                    &handle,
                    &format!(
                        "update available: {current} -> {}",
                        update.version
                    ),
                );
                match update
                    .download_and_install(|_chunk, _total| {}, || {})
                    .await
                {
                    Ok(()) => {
                        append_updater_log(&handle, "update installed; restarting");
                        // Windows NSIS install exits the process before this returns.
                        #[cfg(not(target_os = "windows"))]
                        let _ = handle.restart();
                    }
                    Err(error) => {
                        append_updater_log(
                            &handle,
                            &format!("update install failed: {error}"),
                        );
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                append_updater_log(&handle, &format!("update check failed: {error}"));
            }
        }
    });
}


fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main").map(|w| w.set_focus());
        }))
        .invoke_handler(tauri::generate_handler![
            get_backend_status,
            ensure_streaming_backend,
            search_music,
            search_suggestions,
            cache_artwork,
            get_entity_detail,
            get_artist_detail,
            get_artist_top_songs_extended,
            get_watch_playlist,
            resolve_track_album,
            get_synced_lyrics,
            get_synced_lyrics_by_meta,
            resolve_stream,
            extract_file_metadata,
            list_imported_tracks,
            import_tracks,
            update_imported_track_metadata,
            remove_imported_track,
            analyze_loudness,
            analyze_loudness_chunk,
            detect_leading_silence,
            get_track_duration,
            get_artist_monthly_listeners,
            save_offline,
            remove_offline,
            list_offline,
            clear_all_offline,
            get_offline_path,
            save_track_to_mp3,
            save_album_to_mp3,
            save_playlist_to_mp3,
            cancel_save_export,
            load_all_user_data,
            write_user_data,
            delete_user_data,
            clear_all_user_data_backend,
            import_external_playlist,
            window_drag::remember_window_bounds,
            window_drag::is_app_fullscreen,
            window_drag::toggle_app_fullscreen,
            discord_presence::sync_discord_presence
        ])
        .setup(|app| {
            let default_panic_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                discord_presence::shutdown_discord_presence();
                default_panic_hook(info);
            }));
            window_drag::init(app.handle().clone());

            // Eagerly install the in-memory data store before the
            // React tree mounts and storage.ts fires its first
            // IPC call. block_on stalls the main thread for <1ms
            // (single local JSON read).
            let store = tauri::async_runtime::block_on(async {
                data_store::DataStore::init(app.handle()).await
            })
            .expect("datastore init failed");
            data_store::install(store).expect("datastore install failed");

            #[cfg(any(target_os = "windows", target_os = "macos"))]
            spawn_startup_updater(app.handle());

            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(error) = window_drag::install_drag_hook(&main_window) {
                    eprintln!("[window_drag] failed to install drag hook: {error}");
                }

                main_window.on_window_event(|event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        discord_presence::shutdown_discord_presence();
                    }
                });

                let _ = main_window.with_webview(|webview| {
                    #[cfg(windows)]
                    unsafe {
                        if let Ok(webview2) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = webview2.Settings() {
                                let _ = settings.SetAreDefaultContextMenusEnabled(false);
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                discord_presence::shutdown_discord_presence();
                if let Ok(store) = data_store::current_store() {
                    tauri::async_runtime::block_on(async {
                        if let Err(e) = store.flush_blocking().await { eprintln!("[data_store] shutdown flush failed: {e}"); }
                    });
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_autoplay_queue_from_nested_watch_layout() {
        let response = json!({
            "contents": {
                "singleColumnMusicWatchNextResultsRenderer": {
                    "tabbedRenderer": {
                        "watchNextTabbedResultsRenderer": {
                            "tabs": [{
                                "tabRenderer": {
                                    "content": {
                                        "musicQueueRenderedContent": {
                                            "playlistPanelRenderer": {
                                                "playlistId": "RDAMVMseed",
                                                "contents": [
                                                    { "playlistPanelVideoRenderer": {
                                                        "videoId": "seed",
                                                        "title": { "runs": [{ "text": "Current song" }] },
                                                        "longBylineText": { "runs": [{ "text": "Current artist" }] }
                                                    }},
                                                    { "playlistPanelVideoRenderer": {
                                                        "videoId": "next-song",
                                                        "title": { "runs": [{ "text": "Suggested song" }] },
                                                        "longBylineText": { "runs": [{ "text": "Suggested artist" }] }
                                                    }}
                                                ]
                                            }
                                        }
                                    }
                                }
                            }]
                        }
                    }
                }
            }
        });

        let (tracks, playlist_id) = extract_watch_playlist(&response, Some("seed"));
        assert_eq!(playlist_id.as_deref(), Some("RDAMVMseed"));
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].video_id.as_deref(), Some("next-song"));
    }

    #[test]
    fn picks_first_thumbnail_large_enough_for_ui() {
        let value = json!({
            "thumbnail": {
                "musicThumbnailRenderer": {
                    "thumbnail": {
                        "thumbnails": [
                            { "url": "https://example.com/120.jpg", "width": 120, "height": 120 },
                            { "url": "https://example.com/540.jpg", "width": 540, "height": 225 },
                            { "url": "https://example.com/816.jpg", "width": 816, "height": 340 },
                            { "url": "https://example.com/2880.jpg", "width": 2880, "height": 1200 }
                        ]
                    }
                }
            }
        });

        assert_eq!(
            best_thumbnail(&value),
            Some("https://example.com/816.jpg".to_string())
        );
    }

    #[test]
    fn falls_back_to_largest_when_everything_is_small() {
        let value = json!({
            "thumbnail": {
                "musicThumbnailRenderer": {
                    "thumbnail": {
                        "thumbnails": [
                            { "url": "https://example.com/60.jpg", "width": 60, "height": 60 },
                            { "url": "https://example.com/120.jpg", "width": 120, "height": 120 }
                        ]
                    }
                }
            }
        });

        assert_eq!(
            best_thumbnail(&value),
            Some("https://example.com/120.jpg".to_string())
        );
    }

    #[test]
    fn normalizes_protocol_relative_thumbnail_urls() {
        let value = json!({
            "thumbnail": {
                "musicThumbnailRenderer": {
                    "thumbnail": {
                        "thumbnails": [
                            { "url": "//example.com/image.jpg", "width": 800, "height": 800 }
                        ]
                    }
                }
            }
        });

        assert_eq!(
            best_thumbnail(&value),
            Some("https://example.com/image.jpg".to_string())
        );
    }

    #[test]
    fn turns_artist_header_thumbnail_into_square_avatar() {
        assert_eq!(
            square_artist_thumbnail_url(
                "https://lh3.googleusercontent.com/example=w816-h340-p-l90-rj"
            ),
            "https://lh3.googleusercontent.com/example=w640-h640-p-l90-rj"
        );
    }

    #[test]
    fn preserves_artist_thumbnail_query_string() {
        assert_eq!(
            square_artist_thumbnail_url(
                "https://www.gstatic.com/youtube/media/ytm/images/artist_avatar@1200.png?sqp=abc"
            ),
            "https://www.gstatic.com/youtube/media/ytm/images/artist_avatar@1200.png?sqp=abc"
        );
    }

    #[test]
    fn upscales_artist_banner_thumbnail() {
        assert_eq!(
            banner_artist_thumbnail_url(
                "https://lh3.googleusercontent.com/example=w544-h225-p-l90-rj"
            ),
            "https://lh3.googleusercontent.com/example=w2880-h1200-p-l90-rj"
        );
    }

    #[test]
    fn parse_search_suggestions_reads_history_and_query_suggestions() {
        let value = json!({
            "contents": [{
                "searchSuggestionsSectionRenderer": {
                    "contents": [
                        {
                            "historySuggestionRenderer": {
                                "navigationEndpoint": {
                                    "searchEndpoint": { "query": "faded" }
                                },
                                "suggestion": { "runs": [{ "text": "fade", "bold": true }, { "text": "d" }] }
                            }
                        },
                        {
                            "searchSuggestionRenderer": {
                                "navigationEndpoint": {
                                    "searchEndpoint": { "query": "faded alan walker" }
                                },
                                "suggestion": { "runs": [{ "text": "fade", "bold": true }, { "text": "d alan walker" }] }
                            }
                        }
                    ]
                }
            }]
        });

        let suggestions = parse_search_suggestions(&value);
        assert_eq!(suggestions.len(), 2);
        assert_eq!(suggestions[0].text, "faded");
        assert!(suggestions[0].from_history);
        assert_eq!(suggestions[1].text, "faded alan walker");
        assert!(!suggestions[1].from_history);
    }

    #[test]
    fn excludes_video_and_playlist_search_items() {
        let song = SearchItem {
            id: "song".to_string(),
            kind: "song".to_string(),
            title: "Song".to_string(),
            subtitle: "Song".to_string(),
            cover: None,
            browse_id: None,
            video_id: Some("song123".to_string()),
            duration_seconds: None,
            play_count: None,
            artist: None,
            album: None,
            year: None,
            album_browse_id: None,
            artist_browse_id: None,
            artist_credits: None,
        };
        let video = SearchItem {
            kind: "video".to_string(),
            ..song.clone()
        };
        let playlist = SearchItem {
            kind: "playlist".to_string(),
            ..song.clone()
        };

        assert!(should_include_search_item(&song));
        assert!(!should_include_search_item(&video));
        assert!(!should_include_search_item(&playlist));
    }

    #[test]
    fn fallback_artist_skips_play_counts_and_years() {
        let meta = vec![
            "Song".to_string(),
            "2.4M plays".to_string(),
            "2024".to_string(),
        ];

        assert_eq!(fallback_artist_from_meta(&meta, true), None);
    }

    #[test]
    fn fallback_artist_keeps_real_artist_names() {
        let meta = vec![
            "Song".to_string(),
            "Little Simz".to_string(),
            "Drop 7".to_string(),
        ];

        assert_eq!(
            fallback_artist_from_meta(&meta, true),
            Some("Little Simz".to_string())
        );
    }

    #[test]
    fn does_not_treat_coldplay_as_stats_text() {
        assert!(!looks_like_non_artist_meta("Coldplay"));
    }

    #[test]
    fn infer_artist_from_album_byline_picks_artist_name() {
        assert_eq!(
            infer_artist_from_text("Radiohead • 1997 • 12 songs", false),
            Some("Radiohead".to_string())
        );
    }
    #[test]
    fn parse_search_row_reads_duration_and_plays_from_flex_columns() {
        let value = json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Let Down" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Song â€¢ Radiohead â€¢ 5:00" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "176M plays" }] }
                        }
                    }
                ],
                "playlistItemData": { "videoId": "track123" }
            }
        });

        let item = parse_search_row(&value).expect("search row");
        assert_eq!(item.duration_seconds, Some(300));
        assert_eq!(item.play_count, Some("176M".to_string()));
        assert_eq!(item.artist, Some("Radiohead".to_string()));
    }

    #[test]
    fn parse_track_keeps_artist_top_song_plays_without_fake_duration() {
        let value = json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Creep" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Radiohead" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "2.1B plays" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Pablo Honey" }] }
                        }
                    }
                ],
                "playlistItemData": { "videoId": "track456" }
            }
        });

        let track = parse_track(&value, None, Some("Radiohead"), None).expect("track");
        assert_eq!(track.duration_seconds, None);
        assert_eq!(track.play_count, Some("2.1B".to_string()));
    }

    #[test]
    fn parse_track_uses_menu_browse_ids_when_meta_has_plain_text_only() {
        let value = json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Karma Police" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Radiohead • OK Computer" }] }
                        }
                    }
                ],
                "fixedColumns": [
                    {
                        "musicResponsiveListItemFixedColumnRenderer": {
                            "text": { "runs": [{ "text": "4:21" }] }
                        }
                    }
                ],
                "playlistItemData": { "videoId": "track123" },
                "menu": {
                    "menuRenderer": {
                        "items": [
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Radiohead" }] },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "artist123",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Go to album" }] },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "album123",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ALBUM"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        });

        let track = parse_track(&value, None, None, None).expect("track");
        assert_eq!(track.artist_browse_id, Some("artist123".to_string()));
        assert_eq!(track.album_browse_id, Some("album123".to_string()));
    }

    #[test]
    fn parse_playlist_panel_video_uses_menu_artist_browse_id() {
        let value = json!({
            "playlistPanelVideoRenderer": {
                "videoId": "track123",
                "title": { "runs": [{ "text": "Everything in Its Right Place" }] },
                "longBylineText": { "runs": [{ "text": "Radiohead • Kid A" }] },
                "lengthText": { "runs": [{ "text": "4:11" }] },
                "menu": {
                    "menuRenderer": {
                        "items": [
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Radiohead" }] },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "artist456",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        });

        let track = parse_playlist_panel_video(&value).expect("playlist panel track");
        assert_eq!(track.artist_browse_id, Some("artist456".to_string()));
    }

    #[test]
    fn parse_playlist_panel_video_extracts_album_browse_id_when_menu_leads_with_service_items() {
        let value = json!({
            "playlistPanelVideoRenderer": {
                "videoId": "track123",
                "title": { "runs": [{ "text": "Everything in Its Right Place" }] },
                "longBylineText": { "runs": [{ "text": "Radiohead \u{2022} Kid A" }] },
                "lengthText": { "runs": [{ "text": "4:11" }] },
                "menu": {
                    "menuRenderer": {
                        "items": [
                            {
                                "menuServiceItemRenderer": {
                                    "text": { "runs": [{ "text": "Start radio" }] },
                                    "icon": { "iconType": "MIX" },
                                    "navigationEndpoint": {
                                        "watchEndpoint": { "videoId": "mixroot", "playlistId": "RDAMVMtrack123" }
                                    }
                                }
                            },
                            {
                                "menuServiceItemRenderer": {
                                    "text": { "runs": [{ "text": "Play next" }] },
                                    "icon": { "iconType": "QUEUE_PLAY_NEXT" },
                                    "navigationEndpoint": {
                                        "queueAddEndpoint": { "queueTarget": { "videoId": "track123" } }
                                    }
                                }
                            },
                            {
                                "toggleMenuItemRenderer": {
                                    "text": { "runs": [{ "text": "Save to library" }] },
                                    "icon": { "iconType": "LIBRARY_SAVED" }
                                }
                            },
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Go to artist" }] },
                                    "icon": { "iconType": "ARTIST" },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "artist456",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Go to album" }] },
                                    "icon": { "iconType": "ALBUM" },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "album456",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ALBUM"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        });

        let track = parse_playlist_panel_video(&value).expect("playlist panel track");
        assert_eq!(track.artist_browse_id, Some("artist456".to_string()));
        assert_eq!(track.album_browse_id, Some("album456".to_string()));
    }

    #[test]
    fn parse_search_row_uses_menu_artist_browse_id_when_byline_is_plain_text() {
        let value = json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Let Down" }] }
                        }
                    },
                    {
                        "musicResponsiveListItemFlexColumnRenderer": {
                            "text": { "runs": [{ "text": "Song \u{2022} Radiohead \u{2022} OK Computer \u{2022} 5:00" }] }
                        }
                    }
                ],
                "playlistItemData": { "videoId": "track123" },
                "menu": {
                    "menuRenderer": {
                        "items": [
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Go to artist" }] },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "artist789",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                "menuNavigationItemRenderer": {
                                    "text": { "runs": [{ "text": "Go to album" }] },
                                    "navigationEndpoint": {
                                        "browseEndpoint": {
                                            "browseId": "album789",
                                            "browseEndpointContextSupportedConfigs": {
                                                "browseEndpointContextMusicConfig": {
                                                    "pageType": "MUSIC_PAGE_TYPE_ALBUM"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        });

        let item = parse_search_row(&value).expect("search row");
        assert_eq!(item.artist_browse_id, Some("artist789".to_string()));
        assert_eq!(item.album_browse_id, Some("album789".to_string()));
    }

    #[test]
    fn parse_top_result_uses_menu_browse_ids_when_subtitle_is_plain_text() {
        let value = json!({
            "title": { "runs": [{ "text": "Let Down" }] },
            "subtitle": { "runs": [{ "text": "Song \u{2022} Radiohead \u{2022} OK Computer \u{2022} 5:00" }] },
            "thumbnailOverlay": {
                "musicItemThumbnailOverlayRenderer": {
                    "content": {
                        "musicPlayButtonRenderer": {
                            "playNavigationEndpoint": {
                                "watchEndpoint": { "videoId": "track123" }
                            }
                        }
                    }
                }
            },
            "menu": {
                "menuRenderer": {
                    "items": [
                        {
                            "menuNavigationItemRenderer": {
                                "text": { "runs": [{ "text": "Go to artist" }] },
                                "navigationEndpoint": {
                                    "browseEndpoint": {
                                        "browseId": "artist000",
                                        "browseEndpointContextSupportedConfigs": {
                                            "browseEndpointContextMusicConfig": {
                                                "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        {
                            "menuNavigationItemRenderer": {
                                "text": { "runs": [{ "text": "Go to album" }] },
                                "navigationEndpoint": {
                                    "browseEndpoint": {
                                        "browseId": "album000",
                                        "browseEndpointContextSupportedConfigs": {
                                            "browseEndpointContextMusicConfig": {
                                                "pageType": "MUSIC_PAGE_TYPE_ALBUM"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        let item = parse_top_result(&value).expect("top result");
        assert_eq!(item.artist_browse_id, Some("artist000".to_string()));
        assert_eq!(item.album_browse_id, Some("album000".to_string()));
    }

    #[test]
    fn effective_type_label_prefers_structured_labels() {
        assert_eq!(
            effective_type_label(Some("Video"), Some("Song")),
            Some("Video")
        );
        assert_eq!(
            effective_type_label(Some("Episode"), Some("Song")),
            Some("Episode")
        );
        assert_eq!(
            effective_type_label(None, Some("Song")),
            Some("Song")
        );
        assert_eq!(effective_type_label(Some("   "), Some("Song")), Some("Song"));
        assert_eq!(effective_type_label(None, None), None);
    }

    #[test]
    fn parse_lrc_handles_basic_synced_lines() {
        let lrc = "[00:12.34]First line\n[00:15.67]Second line\n[00:20.00]Third line";
        let lines = lyrics::parse_lrc(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[0].start_time_ms, 12_340);
        assert_eq!(lines[0].end_time_ms, Some(15_670));
        assert_eq!(lines[2].text, "Third line");
        assert_eq!(lines[2].start_time_ms, 20_000);
        assert_eq!(lines[2].end_time_ms, None);
    }

    #[test]
    fn parse_lrc_expands_multi_timestamp_lines() {
        let lrc = "[00:10.00][00:40.00]Repeat me";
        let lines = lyrics::parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Repeat me");
        assert_eq!(lines[0].start_time_ms, 10_000);
        assert_eq!(lines[1].text, "Repeat me");
        assert_eq!(lines[1].start_time_ms, 40_000);
        assert_eq!(lines[0].end_time_ms, Some(40_000));
    }

    #[test]
    fn parse_lrc_applies_offset_tag_and_skips_metadata() {
        let lrc = "[ti:Song]\n[ar:Artist]\n[offset:+250]\n[00:10.00]Hello\n[00:14.00]World";
        let lines = lyrics::parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_time_ms, 10_250);
        assert_eq!(lines[1].start_time_ms, 14_250);
        assert_eq!(lines[0].end_time_ms, Some(14_250));
    }

    #[test]
    fn parse_lrc_ignores_plain_text_without_timestamps() {
        let lrc = "Plain lyrics line\n[00:05.00]Synced line";
        let lines = lyrics::parse_lrc(lrc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Synced line");
        assert_eq!(lines[0].start_time_ms, 5_000);
    }

    #[test]
    fn parse_lrc_returns_empty_for_garbage_input() {
        assert!(lyrics::parse_lrc("").is_empty());
        assert!(lyrics::parse_lrc("no timestamps here").is_empty());
        assert!(lyrics::parse_lrc("[ti:Title]\n[ar:Artist]").is_empty());
    }

    #[test]
    fn parse_lrc_filters_chinese_metadata_lines() {
        let lrc = "[00:00.00]作词: Thomas Bangalter\n[00:00.00]作曲: Thomas Bangalter\n[00:12.34]First line\n[00:15.67]Second line";
        let lines = lyrics::parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[1].text, "Second line");
    }

    #[test]
    fn extract_seed_lyric_track_reads_panel_renderer() {
        let response = json!({
            "contents": {
                "singleColumnMusicWatchNextResultsRenderer": {
                    "tabbedRenderer": {
                        "watchNextTabbedResultsRenderer": {
                            "tabs": [{
                                "tabRenderer": {
                                    "content": {
                                        "musicQueueRenderedContent": {
                                            "playlistPanelRenderer": {
                                                "playlistId": "RDAMVMseed",
                                                "contents": [
                                                    { "playlistPanelVideoRenderer": {
                                                        "videoId": "seed",
                                                        "title": { "runs": [{ "text": "Karma Police" }] },
                                                        "longBylineText": { "runs": [{ "text": "Radiohead • OK Computer" }] },
                                                        "lengthText": { "runs": [{ "text": "4:21" }] }
                                                    }}
                                                ]
                                            }
                                        }
                                    }
                                }
                            }]
                        }
                    }
                }
            }
        });

        let track = extract_seed_lyric_track(&response, "seed").expect("seed lyric track");
        assert_eq!(track.title, "Karma Police");
        assert_eq!(track.artist, "Radiohead");
        assert_eq!(track.duration_seconds, Some(261));
    }

    #[test]
    fn normalize_flat_uploader_treats_na_as_unknown() {
        assert_eq!(normalize_flat_uploader("NA"), "");
        assert_eq!(normalize_flat_uploader("n/a"), "");
        assert_eq!(normalize_flat_uploader("Radiohead - Topic"), "Radiohead");
    }

    #[test]
    fn parse_flat_playlist_tracks_keeps_na_uploader_tracks() {
        let raw = "nbCOAPR33ME|||Karma Police (Remastered)|||NA|||1\n";
        let tracks = parse_flat_playlist_tracks(raw);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Karma Police (Remastered)");
        assert_eq!(tracks[0].artist, "");
        assert_eq!(tracks[0].video_id.as_deref(), Some("nbCOAPR33ME"));
    }

    #[test]
    fn first_video_id_from_tracks_dump_reads_first_line() {
        let raw = "nbCOAPR33ME|||Karma Police|||NA|||1\npqrUQrAcfo4|||Do I Wanna Know?|||NA|||2\n";
        assert_eq!(
            first_video_id_from_tracks_dump(raw).as_deref(),
            Some("nbCOAPR33ME")
        );
    }

    fn artist_top_songs_browse_response(section_title: &str, continuation: Option<&str>) -> Value {
        let mut shelf = json!({
            "header": {
                "musicShelfHeaderRenderer": {
                    "title": { "runs": [{ "text": section_title }] }
                }
            },
            "contents": [
                {
                    "musicResponsiveListItemRenderer": {
                        "flexColumns": [
                            {
                                "musicResponsiveListItemFlexColumnRenderer": {
                                    "text": { "runs": [{ "text": "Song One" }] }
                                }
                            }
                        ],
                        "playlistItemData": { "videoId": "song1" }
                    }
                }
            ]
        });
        if let Some(token) = continuation {
            shelf["continuations"] = json!([{
                "nextContinuationData": { "continuation": token }
            }]);
        }
        json!({
            "header": {
                "musicImmersiveHeaderRenderer": {
                    "title": { "runs": [{ "text": "Radiohead" }] }
                }
            },
            "contents": {
                "singleColumnBrowseResultsRenderer": {
                    "tabs": [{
                        "tabRenderer": {
                            "content": {
                                "sectionListRenderer": {
                                    "contents": [{
                                        "musicShelfRenderer": shelf
                                    }]
                                }
                            }
                        }
                    }]
                }
            }
        })
    }

    #[test]
    fn top_tracks_section_title_matches_for_continuation() {
        assert!(is_top_songs_section_title("Top tracks"));
        assert!(is_top_songs_section_title("Top songs"));
        assert!(!is_top_songs_section_title("Albums"));
    }

    #[test]
    fn extract_top_songs_continuation_uses_top_tracks_shelf() {
        let response = artist_top_songs_browse_response("Top tracks", Some("cont-token"));
        assert_eq!(
            extract_top_songs_continuation(&response).as_deref(),
            Some("cont-token")
        );
    }

    #[test]
    fn extract_top_songs_continuation_falls_back_to_first_shelf() {
        let response = artist_top_songs_browse_response("Fans also like", Some("fallback-token"));
        assert_eq!(
            extract_top_songs_continuation(&response).as_deref(),
            Some("fallback-token")
        );
    }

    #[test]
    fn parse_artist_detail_reads_same_shelf_as_continuation() {
        let response = artist_top_songs_browse_response("Top tracks", Some("cont-token"));
        let detail = parse_artist_detail("artist123", &response).expect("artist detail");
        assert_eq!(detail.top_songs.len(), 1);
        assert_eq!(detail.top_songs[0].title, "Song One");
    }

    #[test]
    fn top_songs_playlist_browse_id_reads_header_navigation() {
        let shelf = json!({
            "header": {
                "musicShelfHeaderRenderer": {
                    "title": {
                        "runs": [{
                            "text": "Top songs",
                            "navigationEndpoint": {
                                "browseEndpoint": {
                                    "browseId": "VLPLExamplePlaylistId"
                                }
                            }
                        }]
                    }
                }
            },
            "contents": []
        });

        assert_eq!(
            top_songs_playlist_browse_id(&shelf).as_deref(),
            Some("VLPLExamplePlaylistId")
        );
    }

    #[test]
    fn top_songs_playlist_browse_id_reads_headerless_bottom_endpoint() {
        let shelf = json!({
            "title": { "runs": [{ "text": "Top songs" }] },
            "bottomEndpoint": {
                "browseEndpoint": {
                    "browseId": "VLOLAK5uy_exampleAudioPlaylist"
                }
            },
            "contents": []
        });

        assert_eq!(
            top_songs_playlist_browse_id(&shelf).as_deref(),
            Some("VLOLAK5uy_exampleAudioPlaylist")
        );
    }

    #[test]
    fn shelf_section_title_reads_headerless_top_level_title() {
        let shelf = json!({
            "title": { "runs": [{ "text": "Top songs" }] }
        });
        assert_eq!(shelf_section_title(&shelf).as_deref(), Some("Top songs"));
    }

    async fn live_ytmusic_browse(browse_id: &str) -> Value {
        let html = HTTP
            .get("https://music.youtube.com/")
            .send()
            .await
            .expect("music shell");
        let html = html.text().await.expect("music shell body");
        let api_key = API_KEY_RE
            .captures(&html)
            .and_then(|caps| caps.get(1))
            .expect("api key")
            .as_str();
        let client_version = CLIENT_VERSION_RE
            .captures(&html)
            .and_then(|caps| caps.get(1))
            .expect("client version")
            .as_str();
        let visitor_data = VISITOR_DATA_RE
            .captures(&html)
            .and_then(|caps| caps.get(1))
            .expect("visitor data")
            .as_str();

        let url = format!("https://music.youtube.com/youtubei/v1/browse?key={api_key}");
        let body = json!({
            "browseId": browse_id,
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": client_version,
                    "hl": "en",
                    "gl": "US",
                    "platform": "DESKTOP",
                    "clientFormFactor": "UNKNOWN_FORM_FACTOR",
                    "visitorData": visitor_data,
                },
                "capabilities": {},
                "request": { "useSsl": true },
                "user": { "lockedSafetyMode": false },
            }
        });

        HTTP.post(url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Origin", "https://music.youtube.com")
            .header("Referer", "https://music.youtube.com/")
            .header("x-goog-visitor-id", visitor_data)
            .json(&body)
            .send()
            .await
            .expect("browse request")
            .json::<Value>()
            .await
            .expect("browse json")
    }

    #[tokio::test]
    #[ignore = "live YouTube Music network integration"]
    async fn live_radiohead_top_songs_load_at_least_six() {
        let response = live_ytmusic_browse("UCUDVBtnOQi4c7E8jebpjc9Q").await;

        let sections = artist_overview_sections(&response).expect("sections");
        let shelf = top_songs_shelf(sections).expect("top songs shelf");
        assert_eq!(shelf_section_title(shelf).as_deref(), Some("Top songs"));
        let playlist_browse_id = top_songs_playlist_browse_id(shelf)
            .expect("playlist browse id on headerless artist shelf");

        let playlist_response = live_ytmusic_browse(&playlist_browse_id).await;
        let playlist_shelf =
            find_track_shelf_in_browse_response(&playlist_response).expect("playlist shelf");
        let tracks = parse_tracks_from_shelf_items(
            playlist_shelf
                .get("contents")
                .and_then(Value::as_array)
                .expect("playlist contents"),
            "Radiohead",
            None,
        );

        assert!(
            tracks.len() >= 6,
            "expected at least 6 top songs from linked playlist, got {}",
            tracks.len()
        );
    }

    #[test]
    fn shelf_continuation_token_reads_continuation_item_renderer() {
        let shelf = json!({
            "contents": [
                {
                    "musicResponsiveListItemRenderer": {
                        "flexColumns": [{
                            "musicResponsiveListItemFlexColumnRenderer": {
                                "text": { "runs": [{ "text": "Song One" }] }
                            }
                        }],
                        "playlistItemData": { "videoId": "song1" }
                    }
                },
                {
                    "continuationItemRenderer": {
                        "continuationEndpoint": {
                            "continuationCommand": {
                                "token": "inline-cont-token"
                            }
                        }
                    }
                }
            ]
        });

        assert_eq!(
            shelf_continuation_token(&shelf).as_deref(),
            Some("inline-cont-token")
        );
    }

    #[test]
    fn parse_shelf_continuation_items_reads_append_action() {
        let response = json!({
            "onResponseReceivedActions": [{
                "appendContinuationItemsAction": {
                    "continuationItems": [{
                        "musicResponsiveListItemRenderer": {
                            "flexColumns": [{
                                "musicResponsiveListItemFlexColumnRenderer": {
                                    "text": { "runs": [{ "text": "Song Six" }] }
                                }
                            }],
                            "playlistItemData": { "videoId": "song6" }
                        }
                    }]
                }
            }]
        });

        let items = parse_shelf_continuation_items(&response).expect("items");
        assert_eq!(items.len(), 1);
        let track = parse_track(&items[0], None, Some("Radiohead"), None).expect("track");
        assert_eq!(track.title, "Song Six");
    }

    #[test]
    fn top_songs_shelf_index_skips_non_shelf_sections() {
        let response = json!({
            "header": {
                "musicImmersiveHeaderRenderer": {
                    "title": { "runs": [{ "text": "Radiohead" }] }
                }
            },
            "contents": {
                "singleColumnBrowseResultsRenderer": {
                    "tabs": [{
                        "tabRenderer": {
                            "content": {
                                "sectionListRenderer": {
                                    "contents": [
                                        {
                                            "musicCarouselShelfRenderer": {
                                                "header": {
                                                    "musicCarouselShelfBasicHeaderRenderer": {
                                                        "title": { "runs": [{ "text": "Albums" }] }
                                                    }
                                                },
                                                "contents": []
                                            }
                                        },
                                        {
                                            "musicShelfRenderer": {
                                                "header": {
                                                    "musicShelfHeaderRenderer": {
                                                        "title": { "runs": [{ "text": "Top songs" }] }
                                                    }
                                                },
                                                "contents": [{
                                                    "musicResponsiveListItemRenderer": {
                                                        "flexColumns": [{
                                                            "musicResponsiveListItemFlexColumnRenderer": {
                                                                "text": { "runs": [{ "text": "Creep" }] }
                                                            }
                                                        }],
                                                        "playlistItemData": { "videoId": "creep" }
                                                    }
                                                }]
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }]
                }
            }
        });

        let sections = artist_overview_sections(&response).expect("sections");
        assert_eq!(top_songs_shelf_index(sections), Some(1));
        let detail = parse_artist_detail("artist123", &response).expect("artist detail");
        assert_eq!(detail.top_songs.len(), 1);
        assert_eq!(detail.top_songs[0].title, "Creep");
    }

    #[test]
    fn parse_spotify_og_track_count_reads_item_total() {
        let html = r#"<meta property="og:description" content="Playlist · Liam · 299 items · 3 saves">"#;
        assert_eq!(parse_spotify_og_track_count(html), Some(299));
    }

    #[test]
    fn spotify_import_track_count_sufficient_detects_embed_cap() {
        assert!(!spotify_import_track_count_sufficient(100, Some(305)));
        assert!(spotify_import_track_count_sufficient(305, Some(305)));
        assert!(!spotify_import_track_count_sufficient(100, None));
        assert!(spotify_import_track_count_sufficient(42, None));
    }

    #[test]
    fn parse_spotify_embed_track_entity_reads_name_and_artist() {
        let entity = json!({
            "name": "The Less I Know The Better",
            "artists": [{"name": "Tame Impala"}],
            "duration": 263000
        });
        let track = parse_spotify_embed_track_entity(&entity).expect("embed track");
        assert_eq!(track.title, "The Less I Know The Better");
        assert_eq!(track.artist, "Tame Impala");
        assert_eq!(track.duration_seconds, Some(263));
    }

    #[test]
    fn spotify_access_token_from_html_reads_embed_session_token() {
        let html = concat!(
            r#"<script id="__NEXT_DATA__">{"props":{"pageProps":{"state":{"settings":{"session":{"#,
            r#""accessToken":"abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF-ghij"}}}}}}}</script>"#
        );
        let token = spotify_access_token_from_html(html).expect("token");
        assert!(token.starts_with("abcdefghijklmnopqrstuvwxyz"));
    }

    #[tokio::test]
    #[ignore = "live network: Spotify pathfinder playlist pagination"]
    async fn spotify_pathfinder_returns_more_than_embed_cap_live() {
        let embed_html =
            fetch_spotify_embed_html("0WmzNjrJtN1rBjAUPXCnZm")
                .await
                .expect("embed html");
        let token = spotify_access_token_from_html(&embed_html).expect("embed token");
        let items = fetch_spotify_pathfinder_playlist_items(
            "0WmzNjrJtN1rBjAUPXCnZm",
            &token,
            Some(299),
        )
        .await
        .expect("pathfinder items");
        assert!(items.len() > SPOTIFY_EMBED_TRACK_PAGE_CAP);
    }

    #[tokio::test]
    #[ignore = "live network: Spotify embed track metadata scrape"]
    async fn spotify_embed_track_metadata_live() {
        let track = fetch_spotify_track_metadata_from_embed_page("6K4t31amVTZDgR3sKmwUJJ")
            .await
            .expect("track metadata");
        assert_eq!(track.title, "The Less I Know The Better");
        assert_eq!(track.artist, "Tame Impala");
    }

    #[tokio::test]
    #[ignore = "live network: Spotify extend beyond embed cap"]
    async fn spotify_extend_beyond_embed_cap_live() {
        let url = "https://open.spotify.com/playlist/0WmzNjrJtN1rBjAUPXCnZm";
        let embed_html = fetch_spotify_embed_html("0WmzNjrJtN1rBjAUPXCnZm")
            .await
            .expect("embed html");
        let import = scrape_playlist_via_embed_page(url, Some(&embed_html))
            .await
            .expect("embed import");
        assert_eq!(import.tracks.len(), SPOTIFY_EMBED_TRACK_PAGE_CAP);
        let token = spotify_access_token_from_html(&embed_html).expect("embed token");
        let extended = extend_spotify_tracks_beyond_embed_cap(
            &import.tracks,
            "0WmzNjrJtN1rBjAUPXCnZm",
            &token,
            Some(299),
            None,
        )
        .await
        .expect("extended tracks");
        assert!(extended.len() > SPOTIFY_EMBED_TRACK_PAGE_CAP);
    }

    #[tokio::test]
    #[ignore = "live network: Spotify playlist import pagination"]
    async fn spotify_playlist_import_fetches_more_than_embed_cap_live() {
        let url = "https://open.spotify.com/playlist/0WmzNjrJtN1rBjAUPXCnZm";
        let import = scrape_spotify_playlist(url)
            .await
            .expect("spotify playlist import");
        assert!(
            import.tracks.len() > SPOTIFY_EMBED_TRACK_PAGE_CAP,
            "expected more than {SPOTIFY_EMBED_TRACK_PAGE_CAP} tracks, got {}",
            import.tracks.len()
        );
    }

}


