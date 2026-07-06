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
use data_store::DataFileLock;

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
use md5::{Md5, Digest};
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
const CLIENT_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 6);
const STREAM_CACHE_TTL: Duration = Duration::from_secs(60 * 45);
const WATCH_PLAYLIST_CACHE_TTL: Duration = Duration::from_secs(60 * 30);
const PREFERRED_THUMBNAIL_WIDTH: u64 = 640;
const ARTIST_AVATAR_SIZE: u64 = 640;
const ARTIST_BANNER_WIDTH: u64 = 2880;
const ARTIST_BANNER_HEIGHT: u64 = 1200;
const MAX_CACHED_ARTWORK_BYTES: usize = 8 * 1024 * 1024;
const ARTIST_TOP_SONG_LIMIT: usize = 10;
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

static LRC_TIMESTAMP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?]").expect("lrc timestamp regex")
});

const LYRIC_PROVIDER_TIMEOUT: Duration = Duration::from_secs(6);

struct MusixmatchTokenCache {
    token: String,
    cookies: String,
    expires_at: Instant,
}

#[derive(Default)]
struct AppState {
    client_config: Mutex<Option<InnerTubeConfig>>,
    stream_cache: Mutex<HashMap<String, CachedStream>>,
    watch_playlist_cache: Mutex<HashMap<String, CachedWatchPlaylist>>,
    track_duration_cache: Mutex<HashMap<String, Option<u32>>>,
    import_library: Mutex<()>,
    musixmatch_token: Mutex<Option<MusixmatchTokenCache>>,
    data_lock: DataFileLock,
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
struct CachedStream {
    source: String,
    fetched_at: Instant,
}

struct CachedWatchPlaylist {
    tracks: Vec<MediaTrack>,
    playlist_id: Option<String>,
    fetched_at: Instant,
}

const MUSIXMATCH_APP_ID: &str = "web-desktop-app-v1.0";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimedLyricWord {
    text: String,
    start_time_ms: u32,
    end_time_ms: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimedLyricLine {
    id: u32,
    text: String,
    start_time_ms: u32,
    end_time_ms: Option<u32>,
    words: Option<Vec<TimedLyricWord>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncedLyricsResponse {
    lines: Vec<TimedLyricLine>,
    source: Option<String>,
    has_per_word_sync: Option<bool>,
}

#[derive(Clone)]
struct LyricTrack {
    title: String,
    artist: String,
    album: Option<String>,
    duration_seconds: Option<u32>,
}

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

fn str_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn duration_from_value(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(value as u32)
}

async fn run_yt_dlp_playlist_dump(yt_dlp: &Path, url: &str) -> Result<String, String> {
    // We deliberately do NOT pass `--flat-playlist` even though it'd be the
    // fastest path: in flat mode yt-dlp emits only the per-track video id +
    // title (no `artist`, `album`, `duration`), which is unusable for our
    // title+artist matcher downstream. Without `--flat-playlist`, yt-dlp
    // runs the full extractor on every track and prints one JSON object
    // per line (via `--dump-json`), each carrying `title`/`track`,
    // `artist`/`artists`, `album`, and `duration` — exactly what the
    // matcher wants. `--yes-playlist` keeps the run alive past the first
    // private/unavailable track so a single dead video can't poison the
    // whole import. `--no-warnings` keeps stderr quiet for expected
    // "unable to extract description" warnings on YT Music playlists.
    //
    // Note: `--no-playlist-error` is NOT a real yt-dlp flag and silently
    // crashes the shell-out before extraction even starts — this was the
    // first bug behind "imports don't work".
    run_command(
        yt_dlp,
        ["--yes-playlist", "--dump-json", "--no-warnings", url],
    )
    .await
}

#[tauri::command]
async fn import_external_playlist(
    app: AppHandle,
    request: ExternalPlaylistImportRequest,
) -> Result<ExternalPlaylistImport, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a playlist link to import.".to_string());
    }
    let service = detect_playlist_service(&url)?;

    match service {
        // YouTube Music is the only service that still works through
        // yt-dlp's `--dump-json` playlist walk. Spotify's extractor was
        // removed upstream (DRM), and Apple Music's extractor doesn't
        // recognize the `pl.u-...` Universal Link share tokens the user
        // pastes. Both services have public web players that render
        // server-side, so we read those pages directly.
        "youtube" => import_youtube_playlist(&app, &url).await,
        "spotify" => scrape_spotify_playlist(&url).await,
        "apple" => scrape_apple_music_playlist(&url).await,
        _ => Err(format!("Unsupported playlist service: {service}")),
    }
}

// Fast partner to `run_yt_dlp_playlist_dump`: returns the playlist-root
// JSON document carrying the REAL playlist cover (`thumbnails[]`) and
// the playlist-level title/description, without paying the per-track-
// extraction cost. We pass `--flat-playlist` so yt-dlp short-circuits
// per-track work and resolves only the playlist shell — empirically a
// sub-second call even on YT Music where the per-track dump takes tens
// of seconds for large playlists.
async fn run_yt_dlp_playlist_header_dump(
    yt_dlp: &Path,
    url: &str,
) -> Result<String, String> {
    run_command(
        yt_dlp,
        [
            "--yes-playlist",
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings",
            url,
        ],
    )
    .await
}

async fn import_youtube_playlist(
    app: &AppHandle,
    url: &str,
) -> Result<ExternalPlaylistImport, String> {
    let yt_dlp = ensure_yt_dlp(app).await?;
    // Two concurrent yt-dlp invocations:
    //   1. `--dump-json` streams per-track metadata line-by-line so the
    //      import dialog can show progress as tracks extract.
    //   2. `--flat-playlist --dump-single-json` runs in parallel and
    //      returns the playlist root document carrying the REAL playlist
    //      cover (`thumbnails[]`) plus title/description. Empirically
    //      resolves in ~1s — well before the streaming call has finished
    //      its first tracks — so cover loading adds no perceptible delay.
    let (tracks_result, header_result) = tokio::join!(
        run_yt_dlp_playlist_dump(&yt_dlp, url),
        run_yt_dlp_playlist_header_dump(&yt_dlp, url),
    );
    let output = tracks_result?;
    if output.trim().is_empty() {
        return Err(
            "YouTube Music didn't return any playlist data for that link. Make sure it's a public playlist."
                .to_string(),
        );
    }

    // Parse the header dump best-effort. yt-dlp's `--dump-single-json`
    // emits one document whose root carries `thumbnails[]`, `title`, and
    // `description` for the playlist. If parsing fails (network blip,
    // malformed JSON, etc.) we fall through so the per-track gates below
    // still run as defense-in-depth.
    let header_value = header_result
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(raw.trim()).ok())
        .unwrap_or(Value::Null);
    let header_cover_url = pick_best_thumbnail_url(&header_value);
    let header_title = header_value
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string);
    let header_description = header_value
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut cover_url: Option<String> = None;
    let mut first_track_cover: Option<String> = None;
    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::new();

    // Seed from the header dump first so the REAL playlist cover (which
    // lives ONLY on the root document) wins over the per-track gates.
    title = title.or(header_title);
    description = description.or(header_description);
    cover_url = cover_url.or(header_cover_url);

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };

        // Playlist-level metadata — every entry exposes it on Spotify/Apple
        // because each track line carries the playlist header. Take the
        // first non-empty value we see.
        if title.is_none() {
            if let Some(candidate) = str_field(&parsed, &["playlist_title", "title"]) {
                title = Some(candidate);
            }
        }
        if description.is_none() {
            // Only consume `playlist_description` from the playlist-level entry.
            // The previous fallback to `description` was happily reading track-level
            // metadata dumps ("Provided to YouTube by Universal Music Group ...")
            // whenever the playlist header omitted its own description, which then
            // landed in the import dialog and in newly-saved playlists as a giant
            // wall of text. The front-end also drops the description display from
            // the import dialog as a defense-in-depth measure.
            if let Some(candidate) = str_field(&parsed, &["playlist_description"]) {
                description = Some(candidate);
            }
        }
        if cover_url.is_none() {
            // Strict gate: only set the playlist-level cover from a line yt-dlp
            // explicitly marks as the playlist header. When no such line shows
            // up — YT Music with --dump-json streams only per-track
            // `_type: "video"` lines — capture the first track's thumbnails as
            // `first_track_cover` so the new playlist shows a real image instead
            // of the DefaultArtwork placeholder.
            if parsed.get("_type").and_then(Value::as_str) == Some("playlist") {
                cover_url = pick_best_thumbnail_url(&parsed);
            } else if first_track_cover.is_none() {
                first_track_cover = pick_best_thumbnail_url(&parsed);
            }
        }

        // Track title. YouTube Music returns `title` on flat-playlist
        // entries; Spotify/Apple prefer `track`. Some scrapers only
        // populate `title` (the playlist title bleeds in). Skip entries
        // without a real track title.
        let track_title = str_field(&parsed, &["track", "title"]);
        // Artist extraction handles three yt-dlp shapes depending on the
        // service:
        //   * `artist`   — single string (Spotify, Apple Music).
        //   * `uploader` — single string (YT Music fallback).
        //   * `artists`  — JSON array of strings (YT Music full mode
        //                  returns ["Michael Kiwanuka"]; SoundCloud
        //                  and others can return multi-artist arrays).
        // `str_field` only reads strings, so the array shape silently
        // drops the track. We explicitly coerce the array to a
        // comma-joined string before falling through.
        let track_artist = {
            if let Some(arr) = parsed.get("artists").and_then(Value::as_array) {
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if joined.is_empty() {
                    None
                } else {
                    Some(joined.join(", "))
                }
            } else {
                str_field(&parsed, &["artist", "uploader", "channel"])
            }
        }
        // Strip trailing " - Topic" / " - VEVO" suffix yt-dlp appends for
        // YT Music channels. Apple Music and Spotify emit clean artist
        // names so this is a no-op for them.
        .map(|value| strip_artist_noise(&value));
        let track_album = str_field(&parsed, &["album"]);
        let track_duration = parsed
            .get("duration")
            .and_then(Value::as_f64)
            .and_then(duration_from_value);

        let Some(title) = track_title else { continue };
        let Some(artist) = track_artist else { continue };
        if !title.is_empty() && !artist.is_empty() {
            tracks.push(ExternalPlaylistTrack {
                title,
                artist,
                album: track_album,
                duration_seconds: track_duration,
            });
        }
    }

    if tracks.is_empty() {
        return Err(
            "We couldn't read any songs from that YouTube Music playlist. Some playlists require sign-in or are region-locked."
                .to_string(),
        );
    }

    Ok(ExternalPlaylistImport {
        service: "youtube".to_string(),
        title: title.unwrap_or_else(|| "Imported playlist".to_string()),
        description,
        // Prefer the playlist-level cover when yt-dlp emitted a header line;
        // otherwise fall through to the first track's thumbnail (the YT
        // Music case where no `_type: "playlist"` line appears in --dump-json).
        cover_url: cover_url.or(first_track_cover),
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
//   * <meta property="og:description"> — "Playlist · <owner> · <N> items · <M> saves"
//
// KNOWN GAPS (no fix possible without Spotify auth — see scrape fn body):
//   * `description` is dropped — the og:description above is a hard-coded
//     template, not the user's actual playlist description.
//   * per-row `duration_seconds` is always None — the server-rendered row
//     markup carries no duration; Spotify hydrates it client-side.
//   * <meta property="og:image">       — 300x300 cover art
//   * one <div data-testid="track-row"> per track, each containing:
//       <a href="/track/<id>">…<span class="e-10451-line-clamp">TITLE</span></a>
//       <span data-testid="internal-artist-link">…<a>ARTIST</a></span>
//
// We deliberately do NOT try to call Spotify's JSON API; it requires an
// auth token tied to a logged-in user. The public page above is enough
// to match tracks against YouTube Music.
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

async fn scrape_spotify_playlist(url: &str) -> Result<ExternalPlaylistImport, String> {
    // A barebones User-Agent triggers Spotify's server-side rendering
    // branch which embeds the playlist's full track list in the HTML. The
    // full Chrome UA (used for everything else) makes them ship the JS
    // shell instead, and we'd lose access to the data.
    let response = HTTP_NO_REDIRECT
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            HeaderValue::from_static("Mozilla/5.0"),
        )
        .header(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"))
        .send()
        .await
        .map_err(|error| format!("Spotify request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Spotify returned HTTP {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|error| format!("Spotify response read failed: {error}"))?;

    let title = SPOTIFY_OG_TITLE_RE
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported playlist".to_string());

    // Spotify's `<meta property="og:description">` is a templated string
    // ("Playlist · <owner> · <N> items · <M> saves") — NOT the user's actual
    // description. The real user-entered description lives only behind
    // `api-partner.spotify.com`, which requires a logged-in bearer token.
    // Returning the template here made the imported-spotiplaylist's
    // description a wall of metadata noise (the "Playlist tag • creator •
    // item count" the user complained about), so we deliberately return
    // `None` until a non-auth source surfaces. Per-row duration has the
    // same constraint (the server-rendered row markup carries no duration;
    // Spotify hydrates client-side) — see the top-of-section comment.
    let description: Option<String> = None;

    let cover_url = SPOTIFY_OG_IMAGE_RE
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.is_empty());

    let mut tracks: Vec<ExternalPlaylistTrack> = Vec::new();
    // We slice between consecutive `data-testid="track-row"` markers
    // instead of trying to capture the gap in a single regex. The
    // `regex` crate doesn't support look-around, so a non-lookahead
    // terminator would consume the next row's marker and skip the row
    // that owned it. Slicing is also cheaper on a page that can weigh
    // in at ~600KB of inline track markup.
    let marker_offsets: Vec<usize> = SPOTIFY_TRACK_ROW_MARKER_RE
        .find_iter(&html)
        .map(|m| m.start())
        .collect();
    for window in marker_offsets.windows(2) {
        let row = &html[window[0]..window[1]];
        let track_title = SPOTIFY_TRACK_TITLE_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| decode_html_entities(m.as_str()));
        let artist = SPOTIFY_ARTIST_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| decode_html_entities(m.as_str()));
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
        // The final row extends to the closing `</body>` tag (or end
        // of document); there's no next marker to bound it.
        let tail_end = html[*last_offset..]
            .find("</body>")
            .map(|offset| *last_offset + offset)
            .unwrap_or(html.len());
        let row = &html[*last_offset..tail_end];
        let track_title = SPOTIFY_TRACK_TITLE_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| decode_html_entities(m.as_str()));
        let artist = SPOTIFY_ARTIST_RE
            .captures(row)
            .and_then(|c| c.get(1))
            .map(|m| decode_html_entities(m.as_str()));
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

    if tracks.is_empty() {
        return Err(
            "We couldn't read any songs from that Spotify playlist. Some playlists require sign-in or are region-locked."
                .to_string(),
        );
    }

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

// Minimal HTML-entity decoder for the handful of escapes Spotify/Apple
// emit in their server-rendered markup (`&amp;`, `&quot;`, the U+FFFD
// replacement char the players insert between long metadata strings).
// The full HTML5 entity list is overkill for what we parse — these
// three cover every value we actually pull from the page.
fn decode_html_entities(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '&' {
            result.push(ch);
            continue;
        }
        let mut entity = String::new();
        while let Some(&next) = chars.peek() {
            if next == ';' {
                chars.next();
                break;
            }
            if entity.len() >= 8 {
                break;
            }
            entity.push(next);
            chars.next();
        }
        let decoded: Option<String> = match entity.as_str() {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" => Some("'".to_string()),
            "nbsp" => Some(" ".to_string()),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                let hex = &entity[2..];
                u32::from_str_radix(hex, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map(|c| c.to_string())
            }
            _ if entity.starts_with('#') => entity[1..]
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string()),
            _ => None,
        };
        if let Some(replacement) = decoded {
            result.push_str(&replacement);
        } else {
            result.push('&');
            result.push_str(&entity);
        }
    }
    result
}

// yt-dlp's `uploader` for YT Music channels often reads
// "The Beatles - Topic". Strip the trailing " - Topic" / " - VEVO" /
// similar noise so the title-vs-source title compare is meaningful.
// Other platforms put the artist in `artist` directly so this is a
// no-op for them.
fn strip_artist_noise(value: &str) -> String {
    let noise_suffixes = [" - Topic", " - VEVO", " - Vevo", " - Official"];
    let mut result = value.to_string();
    for suffix in noise_suffixes {
        if let Some(stripped) = result.strip_suffix(suffix) {
            result = stripped.to_string();
            break;
        }
    }
    result
}

#[tauri::command]
async fn ensure_streaming_backend(app: AppHandle) -> Result<BackendStatus, String> {
    let path = ensure_yt_dlp(&app).await?;
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
async fn cache_artwork(app: AppHandle, url: String) -> Result<String, String> {
    cache_remote_artwork(&app, &url).await
}

#[tauri::command]
async fn get_entity_detail(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<EntityDetail, String> {
    let response = post_ytmusic(&state, "browse", json!({ "browseId": browse_id })).await?;
    parse_entity_detail(&browse_id, &response)
}

fn parse_playlist_panel_video(value: &Value) -> Option<MediaTrack> {
    let video = value.get("playlistPanelVideoRenderer")?;
    let video_id = video.get("videoId").and_then(Value::as_str)?.to_string();
    let title = video.get("title").and_then(text_from_value)?;
    let byline_value = video
        .get("longBylineText")
        .or_else(|| video.get("shortBylineText"))?;
    let parsed_runs = extract_run_meta_from_runs(byline_value);
    // Drop podcast episodes out at the parse level so they never reach the
    // autoplay queue in the frontend. Videos are kept; the React layer
    // substitutes them with a same-name song match.
    let lower_label = parsed_runs
        .type_label
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase());
    if lower_label.as_deref() == Some("episode") || lower_label.as_deref() == Some("podcast") {
        return None;
    }
    let kind = lower_label.filter(|value| !value.is_empty());
    let artist = parsed_runs.artist_text.unwrap_or_else(|| {
        let byline = text_from_value(byline_value).unwrap_or_default();
        infer_artist_from_text(&byline, true).unwrap_or_else(|| "Unknown artist".to_string())
    });
    let album = parsed_runs.album_text.filter(|value| parse_duration(value).is_none()).or_else(|| {
        let byline = text_from_value(byline_value).unwrap_or_default();
        let parts = split_bullets_fixed(&byline);
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
        kind: kind.or_else(|| Some("song".to_string())),
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

fn extract_watch_playlist(value: &Value, seed_video_id: &str) -> (Vec<MediaTrack>, Option<String>) {
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

    let tracks = items
        .iter()
        .filter_map(parse_playlist_panel_video)
        .filter(|track| track.video_id.as_deref() != Some(seed_video_id))
        .collect();

    (tracks, playlist_id)
}

#[tauri::command]
async fn get_artist_detail(
    state: State<'_, AppState>,
    browse_id: String,
) -> Result<ArtistDetail, String> {
    let response = post_ytmusic(&state, "browse", json!({ "browseId": browse_id })).await?;
    let mut detail = parse_artist_detail(&browse_id, &response)?;

    if let Some(token) = extract_top_songs_continuation(&response) {
        let cont_response =
            post_ytmusic(&state, "browse", json!({ "continuation": token })).await?;
        let cont_items = cont_response
            .get("continuationContents")
            .and_then(|c| {
                c.get("musicShelfContinuation")
                    .or(c.get("musicPlaylistShelfContinuation"))
            })
            .and_then(|s| s.get("contents"))
            .and_then(Value::as_array);

        if let Some(items) = cont_items {
            let extra_tracks: Vec<MediaTrack> = items
                .iter()
                .filter_map(|item| {
                    parse_track(
                        item,
                        None,
                        Some(detail.title.as_str()),
                        detail.cover.as_deref(),
                    )
                })
                .collect();
            detail.top_songs.extend(extra_tracks);
        }
    }

    enrich_artist_top_songs(&state, &mut detail).await;

    Ok(detail)
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

async fn enrich_artist_top_songs(state: &State<'_, AppState>, detail: &mut ArtistDetail) {
    let search_tracks = search_artist_song_tracks(state, &detail.title)
        .await
        .unwrap_or_default();

    merge_artist_song_metadata(&mut detail.top_songs, &search_tracks);
    append_unique_artist_songs(&mut detail.top_songs, search_tracks);
    detail.top_songs.truncate(ARTIST_TOP_SONG_LIMIT);

    for track in detail.top_songs.iter_mut() {
        if track.duration_seconds.is_some() {
            continue;
        }
        let Some(video_id) = track.video_id.clone() else {
            continue;
        };
        if let Ok(duration) = fetch_track_duration(state, &video_id).await {
            if let Some(duration) = duration {
                track.duration_seconds = Some(duration);
            }
        }
    }
}

async fn search_artist_song_tracks(
    state: &State<'_, AppState>,
    artist: &str,
) -> Result<Vec<MediaTrack>, String> {
    let artist_key = normalize_lookup_text(artist);
    let mut tracks = Vec::new();

    for query in [format!("{artist} songs"), artist.to_string()] {
        let response = post_ytmusic(state, "search", json!({ "query": query })).await?;
        let parsed = parse_search_response(artist, &response);

        let mut items = Vec::new();
        if let Some(top_result) = parsed.top_result {
            items.push(top_result);
        }
        items.extend(parsed.results);

        for track in items
            .into_iter()
            .filter(|item| item.kind == "song")
            .filter(|item| {
                item.artist
                    .as_deref()
                    .map(|value| artist_text_matches(value, &artist_key))
                    .unwrap_or(false)
            })
            .filter_map(search_item_to_media_track)
        {
            if tracks
                .iter()
                .any(|existing| tracks_match_for_metadata(existing, &track))
            {
                continue;
            }
            tracks.push(track);
            if tracks.len() >= ARTIST_TOP_SONG_LIMIT {
                return Ok(tracks);
            }
        }
    }

    Ok(tracks)
}

fn search_item_to_media_track(item: SearchItem) -> Option<MediaTrack> {
    let video_id = item.video_id?;
    let artist = item
        .artist
        .clone()
        .or_else(|| infer_artist_from_text(&item.subtitle, true))
        .unwrap_or_else(|| "Unknown artist".to_string());

    Some(MediaTrack {
        id: track_id(&video_id, item.album_browse_id.as_deref()),
        kind: Some(item.kind),
        title: item.title,
        artist,
        album: item.album,
        album_browse_id: item.album_browse_id,
        artist_browse_id: item.artist_browse_id,
        artist_credits: item.artist_credits,
        duration_seconds: item.duration_seconds,
        play_count: item.play_count,
        cover: item.cover,
        video_id: Some(video_id),
        source: "stream",
        audio_src: None,
        file_path: None,
        find_lyrics: false,
    })
}

fn merge_artist_song_metadata(tracks: &mut [MediaTrack], candidates: &[MediaTrack]) {
    for track in tracks {
        let Some(candidate) = candidates
            .iter()
            .find(|candidate| tracks_match_for_metadata(track, candidate))
        else {
            continue;
        };

        merge_track_metadata(track, candidate);
    }
}

fn append_unique_artist_songs(tracks: &mut Vec<MediaTrack>, candidates: Vec<MediaTrack>) {
    for candidate in candidates {
        if tracks.len() >= ARTIST_TOP_SONG_LIMIT {
            break;
        }
        if tracks
            .iter()
            .any(|track| tracks_match_for_metadata(track, &candidate))
        {
            continue;
        }
        tracks.push(candidate);
    }
}

fn merge_track_metadata(track: &mut MediaTrack, candidate: &MediaTrack) {
    if track.duration_seconds.is_none() {
        track.duration_seconds = candidate.duration_seconds;
    }
    if track.play_count.is_none() {
        track.play_count = candidate.play_count.clone();
    }
    if track.album.is_none() {
        track.album = candidate.album.clone();
    }
    if track.album_browse_id.is_none() {
        track.album_browse_id = candidate.album_browse_id.clone();
    }
    if track.artist_browse_id.is_none() {
        track.artist_browse_id = candidate.artist_browse_id.clone();
    }
    if track.artist_credits.is_none() {
        track.artist_credits = candidate.artist_credits.clone();
    }
    if track.cover.is_none() {
        track.cover = candidate.cover.clone();
    }
}

fn tracks_match_for_metadata(left: &MediaTrack, right: &MediaTrack) -> bool {
    if left.video_id.is_some() && left.video_id == right.video_id {
        return true;
    }

    let left_title = normalize_lookup_text(&left.title);
    let right_title = normalize_lookup_text(&right.title);
    if left_title.is_empty() || left_title != right_title {
        return false;
    }

    let left_artist = normalize_lookup_text(&left.artist);
    let right_artist = normalize_lookup_text(&right.artist);
    left_artist.is_empty()
        || right_artist.is_empty()
        || left_artist == right_artist
        || left_artist.contains(&right_artist)
        || right_artist.contains(&left_artist)
}

fn artist_text_matches(candidate: &str, artist_key: &str) -> bool {
    if artist_key.is_empty() {
        return false;
    }
    let candidate_key = normalize_lookup_text(candidate);
    candidate_key == artist_key
        || candidate_key.contains(artist_key)
        || artist_key.contains(&candidate_key)
}

async fn fetch_track_duration(
    state: &State<'_, AppState>,
    video_id: &str,
) -> Result<Option<u32>, String> {
    {
        let cache = state.track_duration_cache.lock().await;
        if let Some(duration) = cache.get(video_id) {
            return Ok(*duration);
        }
    }

    let response = post_ytmusic(state, "next", watch_next_payload(video_id, None)).await?;
    let (tracks, _) = extract_watch_playlist(&response, video_id);
    let duration = tracks
        .iter()
        .find(|t| t.video_id.as_deref() == Some(video_id))
        .or(tracks.first())
        .and_then(|t| t.duration_seconds);

    let mut cache = state.track_duration_cache.lock().await;
    cache.insert(video_id.to_string(), duration);
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
    let (tracks, next_playlist_id) = extract_watch_playlist(&response, &video_id);

    let trimmed_tracks: Vec<MediaTrack> = tracks.into_iter().take(25).collect();

    let resolved_playlist_id = next_playlist_id.or(playlist_id);

    if !trimmed_tracks.is_empty() {
        let mut cache = state.watch_playlist_cache.lock().await;
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
    state: State<'_, AppState>,
    video_id: String,
) -> Result<Option<SyncedLyricsResponse>, String> {
    // Seed-track metadata powers the providers. Prefer the watch playlist
    // cache (no network) when the current song is already queued.
    let cached_meta = find_cached_lyric_track(&state, &video_id).await;

    // YouTube Music's "next" response feeds the seed-track metadata for
    // the lyrics providers. If this fails, we can still try providers that
    // work with just the video title (extracted from the cache or a best
    // guess), but most need real title + artist.
    let ytm_meta = post_ytmusic(&state, "next", watch_next_payload(&video_id, None))
        .await
        .ok()
        .and_then(|response| {
            cached_meta
                .clone()
                .or_else(|| extract_seed_lyric_track(&response, &video_id))
        });

    // Fall back to cached metadata alone if the YTM request failed.
    let seed_meta = ytm_meta.or(cached_meta);

    // Providers need a real title + artist to query.
    let meta = seed_meta.as_ref().filter(|meta| {
        !meta.title.trim().is_empty() && !meta.artist.trim().is_empty()
    });

    let Some(meta) = meta else {
        return Ok(None);
    };

    // 1) Musixmatch richsync (word-level sync) — best quality when correct.
    if let Some(lyrics) = fetch_musixmatch_lyrics(&state, meta).await {
        if validate_lyrics(&lyrics.lines, meta.duration_seconds) {
            return Ok(Some(lyrics));
        }
    }

    // 2) Collect all other provider results and pick the best-scored one.
    Ok(query_remaining_lyrics_providers(meta).await)
}

#[tauri::command]
async fn get_synced_lyrics_by_meta(
    state: State<'_, AppState>,
    title: String,
    artist: String,
    album: Option<String>,
    duration_seconds: Option<u32>,
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

    // 1) Musixmatch richsync (word-level sync) — best quality when correct.
    if let Some(lyrics) = fetch_musixmatch_lyrics(&state, &meta).await {
        if validate_lyrics(&lyrics.lines, meta.duration_seconds) {
            return Ok(Some(lyrics));
        }
    }

    Ok(query_remaining_lyrics_providers(&meta).await)
}

async fn query_remaining_lyrics_providers(meta: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let mut candidates: Vec<(u32, SyncedLyricsResponse)> = Vec::new();

    if let Some(lyrics) = fetch_lrclib_lyrics(meta).await {
        let score = score_lyrics(&lyrics.lines, meta.duration_seconds);
        if score >= 25 {
            candidates.push((score, lyrics));
        }
    }

    if let Some(lyrics) = fetch_kugou_lyrics(meta).await {
        let score = score_lyrics(&lyrics.lines, meta.duration_seconds);
        if score >= 25 {
            candidates.push((score, lyrics));
        }
    }

    if let Some(lyrics) = fetch_qq_music_lyrics(meta).await {
        let score = score_lyrics(&lyrics.lines, meta.duration_seconds);
        if score >= 25 {
            candidates.push((score, lyrics));
        }
    }

    if let Some(lyrics) = fetch_netease_lyrics(meta).await {
        let score = score_lyrics(&lyrics.lines, meta.duration_seconds);
        if score >= 25 {
            candidates.push((score, lyrics));
        }
    }

    candidates.sort_by_key(|(s, _)| -(i32::try_from(*s).unwrap_or(0)));
    candidates.into_iter().next().map(|(_, lyrics)| lyrics)
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

fn stream_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
    state: State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    let _guard = state.data_lock.0.lock().await;
    data_store::load_all(&app).await
}

#[tauri::command]
async fn write_user_data(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    data: String,
) -> Result<(), String> {
    let _guard = state.data_lock.0.lock().await;
    data_store::write(&app, &key, &data).await
}

#[tauri::command]
async fn delete_user_data(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let _guard = state.data_lock.0.lock().await;
    data_store::delete(&app, &key).await
}

#[tauri::command]
async fn clear_all_user_data_backend(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _guard = state.data_lock.0.lock().await;
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

/// Pull a single track through yt-dlp into an MP3 at `target_path`. Used
/// by both the song and album exports.
///
/// The output template yt-dlp uses is intentionally a placeholder name;
/// after yt-dlp returns we don't care about the literal name it used —
/// we re-tag the file with lofty and rename to `target_path` at the end.
async fn download_track_mp3(
    yt_dlp: &Path,
    video_id: &str,
    target_path: &Path,
) -> Result<PathBuf, String> {
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
    let output = run_command(
        yt_dlp,
        [
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
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
    )
    .await?;
    let produced = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .filter(|line| Path::new(line).exists())
        .ok_or_else(|| {
            "yt-dlp did not produce an MP3 file. Make sure ffmpeg is installed and on PATH."
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
    let is_music_yt = parsed
        .host_str()
        .map(|host| host == "music.youtube.com")
        .unwrap_or(false);
    let mut request = HTTP.get(parsed);
    if is_music_yt {
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
    let target = target_dir.join(format!("{stem}.mp3"));
    if target.exists() {
        return Err(format!(
            "A file named \"{}\" already exists in the chosen folder.",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("track")
        ));
    }

    // Register a cancellation sender for this request. The frontend
    // can interrupt the in-flight work at the next checkpoint by
    // firing `cancel_save_export(request_id)`. We always pop the
    // entry back out on completion (success OR error OR cancel) so
    // the map only ever holds senders for live requests.
    let request_id = request.request_id.clone();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    if !request_id.is_empty() {
        state
            .active_save_exports
            .lock()
            .await
            .insert(request_id.clone(), cancel_tx);
    }

    // We use `tokio::select!` between the actual work and the cancel
    // signal. To do that cleanly we wrap each sub-step in a future
    // we own the lifetime of, and on cancellation we attempt to
    // clean up the produced temp file before returning.
    enum CancelResult {
        Cancelled,
        Failed(String),
    }
    let work = async {
        let yt_dlp = ensure_yt_dlp(app).await?;
        let produced = download_track_mp3(&yt_dlp, &request.video_id, &target).await?;

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

    let result: Result<String, CancelResult> = if request_id.is_empty() {
        // No request id means cancellation isn't supported (e.g.
        // pre-frontend-id callers, future internal callers). Just
        // run the work without a select.
        work.await.map_err(CancelResult::Failed)
    } else {
        tokio::select! {
            result = work => result.map_err(CancelResult::Failed),
            _ = cancel_rx => Err(CancelResult::Cancelled),
        }
    };

    // Always unregister the sender, regardless of outcome.
    if !request_id.is_empty() {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(path) => Ok(path),
        Err(CancelResult::Cancelled) => {
            // The user pulled the ripcord. We may have left a
            // partially-downloaded temp file in the target dir if
            // yt-dlp finished before the cancel signal landed. Sweep
            // it (and the target, if we'd already moved) so the user
            // doesn't find a stray `.velocity-export-*.mp3` in their
            // Music folder.
            sweep_cancel_artifacts(&target).await;
            Err("Save cancelled.".to_string())
        }
        Err(CancelResult::Failed(error)) => Err(error),
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
    if !request_id.is_empty() {
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

    enum CancelResult {
        Cancelled,
        Failed(String),
    }
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
            let yt_dlp = ensure_yt_dlp(app).await?;
            let produced = download_track_mp3(&yt_dlp, &track.video_id, &target).await?;
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

    let result: Result<SaveAlbumResult, CancelResult> = if request_id.is_empty() {
        work.await.map_err(CancelResult::Failed)
    } else {
        // `oneshot::Receiver::try_recv` is a non-blocking peek; we
        // also need to handle the case where the sender was dropped
        // without firing (e.g. the album finished on its own and
        // removed the entry). Wrap the receiver in an async loop
        // that polls between tracks via a `tokio::select!` at the
        // top of each iteration would require restructuring the
        // for-loop, so instead we just race the whole work against
        // the cancel signal once. The user has to wait for the
        // current track to finish before cancellation takes effect,
        // which matches the per-track granularity of `yt-dlp`.
        tokio::select! {
            result = work => result.map_err(CancelResult::Failed),
            _ = &mut cancel_rx => Err(CancelResult::Cancelled),
        }
    };

    if !request_id.is_empty() {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(value) => Ok(value),
        Err(CancelResult::Cancelled) => {
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
            Err("Save cancelled.".to_string())
        }
        Err(CancelResult::Failed(error)) => Err(error),
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
    if !request_id.is_empty() {
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

    enum CancelResult {
        Cancelled,
        Failed(String),
    }
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
            let yt_dlp = ensure_yt_dlp(app).await?;
            let produced = match download_track_mp3(&yt_dlp, &track.video_id, &target).await {
                Ok(produced) => produced,
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

    let result: Result<SavePlaylistResult, CancelResult> = if request_id.is_empty() {
        work.await.map_err(CancelResult::Failed)
    } else {
        tokio::select! {
            result = work => result.map_err(CancelResult::Failed),
            _ = &mut cancel_rx => Err(CancelResult::Cancelled),
        }
    };

    if !request_id.is_empty() {
        state.active_save_exports.lock().await.remove(&request_id);
    }

    match result {
        Ok(value) => Ok(value),
        Err(CancelResult::Cancelled) => {
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
            Err("Save cancelled.".to_string())
        }
        Err(CancelResult::Failed(error)) => Err(error),
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

    // Only mint a YouTube Music Referer when the source host is YouTube
    // Music itself. Spotify (i.scdn.co) and Apple Music (mzstatic.com)
    // CDNs reject requests with a wrong-referrer header, which previously
    // caused non-YTM playlist cover downloads to silently fail.
    let music_youtube_referer =
        parsed.host_str().map(|host| host == "music.youtube.com").unwrap_or(false);
    let mut request = HTTP.get(parsed);
    if music_youtube_referer {
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
        let album = extracted
            .album
            .filter(|v| !v.trim().is_empty())
            .or(Some("Collection".to_string()));

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

fn yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("bin").join("yt-dlp.exe"))
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
        album: record.album.clone(),
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
    )
    .await
}

async fn post_ytmusic_with_client(
    state: &State<'_, AppState>,
    endpoint: &str,
    payload: Value,
    client_name: &str,
    client_version: &str,
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
        "https://music.youtube.com/youtubei/v1/{endpoint}?key={}",
        config.api_key
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

fn extract_top_songs_continuation(value: &Value) -> Option<String> {
    let sections = value
        .get("contents")
        .and_then(|v| v.get("singleColumnBrowseResultsRenderer"))
        .and_then(|v| v.get("tabs"))
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|v| v.get("tabRenderer"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.get("sectionListRenderer"))
        .and_then(|v| v.get("contents"))
        .and_then(Value::as_array)?;

    for section in sections {
        if let Some(shelf) = section
            .get("musicShelfRenderer")
            .or_else(|| section.get("musicPlaylistShelfRenderer"))
        {
            let section_title = shelf
                .get("header")
                .and_then(|h| {
                    h.get("musicShelfHeaderRenderer")
                        .or(h.get("musicPlaylistShelfHeaderRenderer"))
                })
                .and_then(|h| h.get("title"))
                .and_then(text_from_value);

            if let Some(section_title) = section_title {
                let lower = section_title.to_lowercase();
                if (lower.contains("top") && lower.contains("song"))
                    || lower == "songs"
                    || lower.contains("popular")
                {
                    return shelf
                        .get("continuations")
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("nextContinuationData"))
                        .and_then(|c| c.get("continuation"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| find_continuation_token(shelf));
                }
            }
        }
    }

    None
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

    let sections = value
        .get("contents")
        .and_then(|value| value.get("singleColumnBrowseResultsRenderer"))
        .and_then(|value| value.get("tabs"))
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|value| value.get("tabRenderer"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.get("sectionListRenderer"))
        .and_then(|value| value.get("contents"))
        .and_then(Value::as_array)
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

    let mut best_index: Option<usize> = None;
    let mut fallback_index: Option<usize> = None;

    for (index, section) in sections.iter().enumerate() {
        let shelf = if let Some(s) = section.get("musicShelfRenderer") {
            s
        } else if let Some(s) = section.get("musicPlaylistShelfRenderer") {
            s
        } else {
            continue;
        };

        if fallback_index.is_none() {
            fallback_index = Some(index);
        }

        let section_title = shelf
            .get("header")
            .and_then(|h| {
                h.get("musicShelfHeaderRenderer")
                    .or(h.get("musicPlaylistShelfHeaderRenderer"))
            })
            .and_then(|h| h.get("title"))
            .and_then(text_from_value);

        if let Some(t) = section_title {
            let lower = t.to_lowercase();
            if (lower.contains("top") && lower.contains("song"))
                || lower == "songs"
                || lower.contains("popular")
            {
                best_index = Some(index);
                break;
            }
        }
    }

    let top_songs = best_index
        .or(fallback_index)
        .and_then(|idx| {
            sections[idx]
                .get("musicShelfRenderer")
                .or(sections[idx].get("musicPlaylistShelfRenderer"))
        })
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
            .filter(|value| value != "episode" && value != "podcast"),
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

fn normalize_lookup_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| ch.to_lowercase())
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

fn normalize_kind(label: Option<&str>, has_browse: bool, has_video: bool) -> String {
    match label.map(|value| value.to_lowercase()) {
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
                thumb.get("width").and_then(Value::as_u64),
            ))
        })
        .collect::<Vec<_>>();

    normalized
        .iter()
        .find(|(_, width)| {
            width
                .map(|value| value >= PREFERRED_THUMBNAIL_WIDTH)
                .unwrap_or(false)
        })
        .map(|(url, _)| url.clone())
        .or_else(|| normalized.last().map(|(url, _)| url.clone()))
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

fn normalize_query_text(text: &str) -> String {
    let mut s = String::with_capacity(text.len());
    let mut depth: u32 = 0;
    for ch in text.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ if depth == 0 => {
                s.push(ch.to_ascii_lowercase());
            }
            _ => {}
        }
    }
    let trimmed = s.trim();
    let mut result = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_whitespace() || ch == '_' || ch == '-' {
            if !prev_space {
                result.push(' ');
                prev_space = true;
            }
        } else if ch.is_alphanumeric() {
            result.push(ch);
            prev_space = false;
        }
    }
    result.trim().to_string()
}

fn titles_match(a: &str, b: &str) -> bool {
    let na = normalize_query_text(a);
    let nb = normalize_query_text(b);
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    na == nb || na.contains(&nb) || nb.contains(&na)
}

fn score_lyrics(lines: &[TimedLyricLine], track_duration_secs: Option<u32>) -> u32 {
    let n = lines.len();
    if n < 2 {
        return 0;
    }

    let mut score: u32 = 40;

    if n >= 8 {
        score += 5;
    }
    if n >= 16 {
        score += 5;
    }
    if n >= 30 {
        score += 5;
    }

    let first_ms = lines[0].start_time_ms;
    if first_ms <= 2000 {
        score += 10;
    } else if first_ms <= 5000 {
        score += 5;
    } else if first_ms > 30_000 {
        score = score.saturating_sub(20);
    } else {
        score = score.saturating_sub(8);
    }

    let last_ms = lines[n - 1].start_time_ms;
    if let Some(dur_s) = track_duration_secs {
        let dur_ms = dur_s * 1000;
        if dur_ms > 0 {
            let ratio = last_ms as f64 / dur_ms as f64;
            if ratio >= 0.80 && ratio <= 1.20 {
                score += 15;
            } else if ratio >= 0.55 && ratio <= 1.40 {
                score += 5;
            } else {
                score = score.saturating_sub(20);
            }
        }
    }

    let mut monotonic = true;
    let mut gap_penalty: u32 = 0;
    for w in lines.windows(2) {
        let a = w[0].start_time_ms;
        let b = w[1].start_time_ms;
        if b < a {
            monotonic = false;
        } else {
            let gap = b - a;
            if gap > 30_000 {
                gap_penalty += 3;
            } else if gap > 15_000 {
                gap_penalty += 1;
            }
        }
    }
    if monotonic {
        score += 10;
    } else {
        score = score.saturating_sub(25);
    }
    score = score.saturating_sub(gap_penalty.min(20));

    if lines.iter().any(|l| l.words.is_some()) {
        score += 15;
    }

    score.min(100)
}

fn validate_lyrics(lines: &[TimedLyricLine], track_duration_secs: Option<u32>) -> bool {
    score_lyrics(lines, track_duration_secs) >= 25
}

fn parse_lrc(lrc: &str) -> Vec<TimedLyricLine> {
    let mut offset_ms: i64 = 0;
    let mut entries: Vec<(u32, String)> = Vec::new();

    for raw in lrc.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        // Global offset tag: `[offset:±N]` (milliseconds).
        if let Some(rest) = line.strip_prefix("[offset:") {
            if let Some(inner) = rest.strip_suffix(']') {
                if let Ok(value) = inner.trim().parse::<i64>() {
                    offset_ms = value;
                }
            }
            continue;
        }

        // Consume every leading [mm:ss.xx] timestamp so multi-timestamp lines
        // (`[00:12.34][00:45.00]text`) emit one entry per cue.
        let mut rest = line;
        let mut timestamps: Vec<u32> = Vec::new();
        while let Some(captures) = LRC_TIMESTAMP_RE.captures(rest) {
            let minutes: u32 = captures[1].parse().unwrap_or(0);
            let seconds: u32 = captures[2].parse().unwrap_or(0);
            let frac_ms: u32 = captures
                .get(3)
                .map(|match_| {
                    let digits = match_.as_str();
                    let padded = format!("{:0<3}", digits);
                    padded[..3].parse().unwrap_or(0)
                })
                .unwrap_or(0);
            timestamps.push(minutes * 60_000 + seconds * 1000 + frac_ms);
            rest = &rest[captures[0].len()..];
        }

        if timestamps.is_empty() {
            continue;
        }
        let text = rest.trim().to_string();
        if text.is_empty() || is_lrc_metadata_line(&text) {
            continue;
        }
        for timestamp in timestamps {
            entries.push((timestamp, text.clone()));
        }
    }

    if entries.is_empty() {
        return Vec::new();
    }
    entries.sort_by_key(|(ms, _)| *ms);

    let mut lines = Vec::with_capacity(entries.len());
    for (index, (start, text)) in entries.iter().enumerate() {
        let start_ms = apply_lrc_offset(*start, offset_ms);
        let end_ms = entries
            .get(index + 1)
            .map(|(next_start, _)| apply_lrc_offset(*next_start, offset_ms))
            .filter(|end| *end > start_ms);
        lines.push(TimedLyricLine {
            id: start_ms,
            text: text.clone(),
            start_time_ms: start_ms,
            end_time_ms: end_ms,
            words: None,
        });
    }
    lines
}

fn apply_lrc_offset(ms: u32, offset_ms: i64) -> u32 {
    (ms as i64 + offset_ms).max(0) as u32
}

fn is_lrc_metadata_line(text: &str) -> bool {
    static METADATA_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new("^[一-龥][一-龥\\s]*:").unwrap());
    METADATA_RE.is_match(text)
}

fn build_lyrics_from_lrc(lrc: &str, source: &str) -> Option<SyncedLyricsResponse> {
    let lines = parse_lrc(lrc);
    if lines.is_empty() {
        return None;
    }
    Some(SyncedLyricsResponse {
        lines,
        source: Some(source.to_string()),
        has_per_word_sync: Some(false),
    })
}

const MUSIXMATCH_SOURCE: &str = "Lyrics from Musixmatch";

async fn fetch_musixmatch_token(state: &State<'_, AppState>) -> Option<(String, String)> {
    // Check cached token first.
    {
        let cache = state.musixmatch_token.lock().await;
        if let Some(ref cached) = *cache {
            if Instant::now() < cached.expires_at {
                return Some((cached.token.clone(), cached.cookies.clone()));
            }
        }
    }

    // The Musixmatch desktop API returns a 301 with Set-Cookie headers on
    // the first call. We must follow the redirect manually (like a browser),
    // passing accumulated cookies on each retry, until we get a non-301
    // JSON response containing the user_token.
    let mut cookies: Vec<String> = Vec::new();

    for _attempt in 0..3 {
        let mut req = HTTP_NO_REDIRECT
            .get("https://apic-desktop.musixmatch.com/ws/1.1/token.get")
            .query(&[
                ("user_language", "en"),
                ("app_id", MUSIXMATCH_APP_ID),
            ])
            .timeout(LYRIC_PROVIDER_TIMEOUT);
        if !cookies.is_empty() {
            let cookie_str = cookies.join("; ");
            req = req.header("cookie", &cookie_str);
        }
        let resp = req.send().await.ok()?;

        if resp.status().as_u16() == 301 {
            for set_cookie in resp.headers().get_all("set-cookie").iter() {
                if let Ok(val) = set_cookie.to_str() {
                    if let Some(name_value) = val.split(';').next() {
                        let nv = name_value.trim().to_string();
                        if nv.ends_with("=unknown") {
                            continue;
                        }
                        cookies.push(nv);
                    }
                }
            }
            continue;
        }

        // Non-301: parse the JSON response.
        let json: Value = resp.json().await.ok()?;
        let status = json
            .pointer("/message/header/status_code")
            .and_then(Value::as_i64)?;

        if status == 401 {
            return None;
        }
        if status != 200 {
            return None;
        }

        let token = json
            .pointer("/message/body/user_token")
            .and_then(Value::as_str)?
            .to_string();
        let cookie_header = cookies.join("; ");

        // Cache for 9 minutes (token expires in 10).
        {
            let mut cache = state.musixmatch_token.lock().await;
            *cache = Some(MusixmatchTokenCache {
                token: token.clone(),
                cookies: cookie_header.clone(),
                expires_at: Instant::now() + Duration::from_secs(540),
            });
        }

        return Some((token, cookie_header));
    }

    None
}

async fn fetch_musixmatch_lyrics(
    state: &State<'_, AppState>,
    track: &LyricTrack,
) -> Option<SyncedLyricsResponse> {
    let (token, cookies) = fetch_musixmatch_token(state).await?;

    let client = &HTTP;

    // Search for the track.
    let mut search_params: Vec<(&str, &str)> = vec![
        ("app_id", MUSIXMATCH_APP_ID),
        ("usertoken", &token),
        ("q_track", &track.title),
        ("q_artist", &track.artist),
        ("page_size", "5"),
        ("page", "1"),
    ];
    let duration_str;
    if let Some(dur) = track.duration_seconds {
        duration_str = dur.to_string();
        search_params.push(("q_duration", &duration_str));
    }

    let search_resp = client
        .get("https://apic-desktop.musixmatch.com/ws/1.1/track.search")
        .query(&search_params)
        .header("cookie", &cookies)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;

    let search_json: Value = search_resp.json().await.ok()?;
    let track_list = search_json
        .pointer("/message/body/track_list")
        .and_then(Value::as_array)?;

    let track_duration = track.duration_seconds.map(|s| s as i64);

    let mut scored: Vec<(i64, &Value)> = track_list
        .iter()
        .filter_map(|entry| {
            let track_name = entry
                .pointer("/track/track_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let artist_name = entry
                .pointer("/track/artist_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let has_richsync = entry
                .pointer("/track/has_richsync")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let entry_duration = entry
                .pointer("/track/track_length")
                .and_then(Value::as_i64)
                .unwrap_or(0);

            let mut score: i64 = 0;

            let nt = normalize_query_text(track_name);
            let nt_target = normalize_query_text(&track.title);
            if nt == nt_target {
                score += 50;
            } else if !nt.is_empty()
                && !nt_target.is_empty()
                && (nt.contains(&nt_target) || nt_target.contains(&nt))
            {
                score += 20;
            }

            let na = normalize_query_text(artist_name);
            let na_target = normalize_query_text(&track.artist);
            if na == na_target {
                score += 30;
            } else if !na.is_empty()
                && !na_target.is_empty()
                && (na.contains(&na_target) || na_target.contains(&na))
            {
                score += 10;
            }

            if let Some(td) = track_duration {
                let delta = (entry_duration - td).abs();
                if delta <= 5 {
                    score += 20;
                } else if delta <= 15 {
                    score += 10;
                } else if delta <= 30 {
                    score += 5;
                }
            }

            if has_richsync == 1 {
                score += 40;
            }

            if score >= 30 {
                Some((score, entry))
            } else {
                None
            }
        })
        .collect();

    scored.sort_by_key(|(s, _)| -*s);

    let matched = scored
        .first()
        .filter(|(_, entry)| {
            entry
                .pointer("/track/has_richsync")
                .and_then(Value::as_i64)
                == Some(1)
        })
        .map(|(_, entry)| *entry)?;

    let track_id = matched
        .pointer("/track/track_id")
        .and_then(Value::as_i64)?;

    // Fetch richsync (word-level lyrics).
    let richsync_resp = client
        .get("https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get")
        .query(&[
            ("app_id", MUSIXMATCH_APP_ID),
            ("usertoken", &token),
            ("track_id", &track_id.to_string()),
        ])
        .header("cookie", &cookies)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;

    let richsync_json: Value = richsync_resp.json().await.ok()?;
    let status = richsync_json
        .pointer("/message/header/status_code")
        .and_then(Value::as_i64)?;
    if status != 200 {
        return None;
    }

    let richsync_body_str = richsync_json
        .pointer("/message/body/richsync/richsync_body")
        .and_then(Value::as_str)?;

    // The richsync_body is a JSON string that needs to be parsed.
    let richsync_body: Value = serde_json::from_str(richsync_body_str).ok()?;
    let lines_array = richsync_body.as_array()?;

    let mut lines = Vec::new();
    for (_line_idx, line_entry) in lines_array.iter().enumerate() {
        let ts = line_entry.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
        let te = line_entry.get("te").and_then(Value::as_f64).unwrap_or(0.0);
        let text = line_entry
            .get("x")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let words_data = line_entry.get("l").and_then(Value::as_array);

        let line_start_ms = (ts * 1000.0) as u32;
        let line_end_ms = (te * 1000.0) as u32;

        // If there's word-level data, build TimedLyricWords.
        let words = words_data.and_then(|word_entries| {
            let mut words = Vec::new();
            for (word_idx, word_entry) in word_entries.iter().enumerate() {
                let c = word_entry
                    .get("c")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let o = word_entry.get("o").and_then(Value::as_f64).unwrap_or(0.0);
                let offset_ms = (o * 1000.0) as u32;

                // Word end time is the next word's offset, or the line end time.
                let next_offset_ms = word_entries
                    .get(word_idx + 1)
                    .and_then(|w| w.get("o"))
                    .and_then(Value::as_f64)
                    .map(|o| (o * 1000.0) as u32)
                    .unwrap_or(line_end_ms - line_start_ms);

                if !c.is_empty() {
                    words.push(TimedLyricWord {
                        text: c.to_string(),
                        start_time_ms: line_start_ms + offset_ms,
                        end_time_ms: line_start_ms + next_offset_ms,
                    });
                }
            }
            if words.is_empty() {
                None
            } else {
                Some(words)
            }
        });

        if text.trim().is_empty() {
            continue;
        }

        lines.push(TimedLyricLine {
            id: line_start_ms,
            text,
            start_time_ms: line_start_ms,
            end_time_ms: Some(line_end_ms),
            words,
        });
    }

    if lines.is_empty() {
        return None;
    }

    Some(SyncedLyricsResponse {
        lines,
        source: Some(MUSIXMATCH_SOURCE.to_string()),
        has_per_word_sync: Some(true),
    })
}

const LRCLIB_SOURCE: &str = "Lyrics from LRCLIB";
const KUGOU_SOURCE: &str = "Lyrics from Kugou";
const QQ_MUSIC_SOURCE: &str = "Lyrics from QQ Music";
const NETEASE_SOURCE: &str = "Lyrics from NetEase Cloud Music";

async fn fetch_lrclib_lyrics(track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let mut params: Vec<(&str, String)> = vec![
        ("artist_name", track.artist.clone()),
        ("track_name", track.title.clone()),
    ];
    if let Some(album) = track.album.as_ref().filter(|album| !album.trim().is_empty()) {
        params.push(("album_name", album.clone()));
    }
    if let Some(duration) = track.duration_seconds {
        params.push(("duration", duration.to_string()));
    }

    // /api/get returns a single exact-ish match; /api/search is the fuzzy
    // fallback when the precise query misses.
    if let Some(lyrics) = fetch_lrclib_get(&params).await {
        return Some(lyrics);
    }
    fetch_lrclib_search(track).await
}

async fn fetch_lrclib_get(params: &[(&str, String)]) -> Option<SyncedLyricsResponse> {
    let response = HTTP
        .get("https://lrclib.net/api/get")
        .query(params)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    parse_lrclib_entry(&json)
}

async fn fetch_lrclib_search(track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let params: Vec<(&str, String)> = vec![
        ("artist_name", track.artist.clone()),
        ("track_name", track.title.clone()),
    ];
    let response = HTTP
        .get("https://lrclib.net/api/search")
        .query(&params)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let results: Vec<Value> = response.json().await.ok()?;
    pick_best_lrclib_match(&results, track)
}

fn pick_best_lrclib_match(results: &[Value], track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let mut candidates: Vec<(u32, SyncedLyricsResponse)> = results
        .iter()
        .filter_map(|entry| {
            let synced = entry.get("syncedLyrics").and_then(Value::as_str)?;
            if synced.trim().is_empty() {
                return None;
            }
            let lines = parse_lrc(synced);
            if lines.is_empty() {
                return None;
            }
            let mut score = score_lyrics(&lines, track.duration_seconds);

            let entry_duration = entry.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
            if let Some(td) = track.duration_seconds {
                let delta = ((entry_duration as i64) - (td as i64)).abs();
                if delta <= 3 {
                    score += 10;
                } else if delta <= 10 {
                    score += 5;
                } else if delta > 60 {
                    score = score.saturating_sub(15);
                }
            }

            let entry_title = entry.get("trackName").and_then(Value::as_str).unwrap_or("");
            if !entry_title.is_empty() && !titles_match(entry_title, &track.title) {
                score = score.saturating_sub(15);
            }

            if score >= 25 {
                Some((
                    score,
                    SyncedLyricsResponse {
                        lines,
                        source: Some(LRCLIB_SOURCE.to_string()),
                        has_per_word_sync: Some(false),
                    },
                ))
            } else {
                None
            }
        })
        .collect();

    candidates.sort_by_key(|(s, _)| -(i32::try_from(*s).unwrap_or(0)));
    candidates.into_iter().next().map(|(_, lyrics)| lyrics)
}

fn parse_lrclib_entry(value: &Value) -> Option<SyncedLyricsResponse> {
    let synced = value.get("syncedLyrics").and_then(Value::as_str)?;
    if synced.trim().is_empty() {
        return None;
    }
    build_lyrics_from_lrc(synced, LRCLIB_SOURCE)
}

async fn fetch_netease_lyrics(track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let response = HTTP
        .post("https://music.163.com/api/search/get")
        .header("Referer", "https://music.163.com")
        .form(&[
            ("s", query.as_str()),
            ("type", "1"),
            ("offset", "0"),
            ("limit", "10"),
        ])
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let songs = json
        .get("result")
        .and_then(|result| result.get("songs"))
        .and_then(Value::as_array)?;
    let song_id = pick_netease_song(songs, track)?;
    fetch_netease_lyrics_by_id(song_id).await
}

fn pick_netease_song(songs: &[Value], track: &LyricTrack) -> Option<u64> {
    let mut candidates: Vec<(i64, u64)> = Vec::new();
    for song in songs {
        let id = match song.get("id").and_then(Value::as_u64) {
            Some(value) => value,
            None => continue,
        };
        let name = song.get("name").and_then(Value::as_str).unwrap_or("");
        if !lyric_name_matches(name, &track.title) {
            continue;
        }
        let duration_ms = song.get("duration").and_then(Value::as_u64).unwrap_or(0);
        let delta = track
            .duration_seconds
            .map(|seconds| ((duration_ms as i64) - (seconds as i64 * 1000)).abs())
            .unwrap_or(0);
        candidates.push((delta, id));
    }
    candidates.sort_by_key(|(delta, _)| *delta);
    candidates.first().map(|(_, id)| *id)
}

async fn fetch_netease_lyrics_by_id(song_id: u64) -> Option<SyncedLyricsResponse> {
    let url = format!("https://music.163.com/api/song/lyric?id={song_id}&lv=1&tv=-1");
    let response = HTTP
        .get(&url)
        .header("Referer", "https://music.163.com")
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let lrc = json
        .get("lrc")
        .and_then(|value| value.get("lyric"))
        .and_then(Value::as_str)?;
    if lrc.trim().is_empty() {
        return None;
    }
    build_lyrics_from_lrc(lrc, NETEASE_SOURCE)
}

async fn fetch_kugou_lyrics(track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let search_url = format!(
        "https://mobilecdn.kugou.com/api/v3/search/song?keyword={}&page=1&pagesize=5",
        urlencoding::encode(&query),
    );
    let response = HTTP
        .get(&search_url)
        .header("User-Agent", USER_AGENT)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let data = json.get("data")?.get("info")?.as_array()?;
    let candidate = data.iter().find(|entry| {
        let song_name = entry.get("songname").and_then(Value::as_str).unwrap_or("");
        lyric_name_matches(song_name, &track.title)
    })?;
    let hash = candidate.get("hash").and_then(Value::as_str)?;

    // Kugou lyrics API requires MD5 of the hash as the accesskey.
    let hash_bytes = hex::decode(hash).ok()?;
    let accesskey = {
        let mut hasher = Md5::new();
        hasher.update(&hash_bytes);
        hex::encode(hasher.finalize())
    };

    let lyrics_url = format!(
        "https://lyrics.kugou.com/download?ver=1&client=pc&id={}&accesskey={}&fmt=lrc&charset=utf8",
        hash, accesskey,
    );
    let resp = HTTP
        .get(&lyrics_url)
        .header("User-Agent", USER_AGENT)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: Value = resp.json().await.ok()?;
    let status = json.get("status").and_then(Value::as_i64).unwrap_or(0);
    if status != 200 {
        return None;
    }
    let lrc = json.get("content").and_then(Value::as_str)?;
    let lrc_decoded = base64_decode(lrc)?;
    build_lyrics_from_lrc(&lrc_decoded, KUGOU_SOURCE)
}

fn base64_decode(input: &str) -> Option<String> {
    use std::io::Read;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(input)
        .ok()?;
    let mut decoder = flate2::read::GzDecoder::new(&decoded[..]);
    let mut output = String::new();
    decoder.read_to_string(&mut output).ok()?;
    Some(output)
}

async fn fetch_qq_music_lyrics(track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let search_url = format!(
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key={}&format=json",
        urlencoding::encode(&query),
    );
    let response = HTTP
        .get(&search_url)
        .header("Referer", "https://y.qq.com/")
        .header("User-Agent", USER_AGENT)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let songs = json
        .get("data")
        .and_then(|d| d.get("song"))
        .and_then(|s| s.get("list"))
        .and_then(Value::as_array)?;
    let song = songs.iter().find(|entry| {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        lyric_name_matches(name, &track.title)
    })?;
    let mid = song.get("mid").and_then(Value::as_str)?;

    let lyrics_url = format!(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={}&format=json&nobase64=1",
        mid,
    );
    let resp = HTTP
        .get(&lyrics_url)
        .header("Referer", "https://y.qq.com/")
        .header("User-Agent", USER_AGENT)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    // QQ Music wraps JSON in a callback — strip it if present.
    let json_str = text
        .strip_prefix("MusicJsonCallback(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(&text);
    let json: Value = serde_json::from_str(json_str).ok()?;
    let lrc = json.get("lyric").and_then(Value::as_str)?;
    if lrc.trim().is_empty() {
        return None;
    }
    build_lyrics_from_lrc(lrc, QQ_MUSIC_SOURCE)
}

fn lyric_name_matches(candidate: &str, target: &str) -> bool {
    titles_match(candidate, target)
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None::<Vec<&str>>))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_status,
            ensure_streaming_backend,
            search_music,
            cache_artwork,
            get_entity_detail,
            get_artist_detail,
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
            import_external_playlist
        ])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
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
        .run(tauri::generate_context!())
        .expect("failed to run app");
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

        let (tracks, playlist_id) = extract_watch_playlist(&response, "seed");
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
        let lines = parse_lrc(lrc);
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
        let lines = parse_lrc(lrc);
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
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_time_ms, 10_250);
        assert_eq!(lines[1].start_time_ms, 14_250);
        assert_eq!(lines[0].end_time_ms, Some(14_250));
    }

    #[test]
    fn parse_lrc_ignores_plain_text_without_timestamps() {
        let lrc = "Plain lyrics line\n[00:05.00]Synced line";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Synced line");
        assert_eq!(lines[0].start_time_ms, 5_000);
    }

    #[test]
    fn parse_lrc_returns_empty_for_garbage_input() {
        assert!(parse_lrc("").is_empty());
        assert!(parse_lrc("no timestamps here").is_empty());
        assert!(parse_lrc("[ti:Title]\n[ar:Artist]").is_empty());
    }

    #[test]
    fn parse_lrc_filters_chinese_metadata_lines() {
        let lrc = "[00:00.00]作词: Thomas Bangalter\n[00:00.00]作曲: Thomas Bangalter\n[00:12.34]First line\n[00:15.67]Second line";
        let lines = parse_lrc(lrc);
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
}


