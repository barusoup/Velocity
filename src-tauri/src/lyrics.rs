//! Synced-lyrics resolution: provider fan-out, metadata matching, and
//! playback alignment for stream tracks.
//!
//! Provider priority (by composite score, not hard-coded order):
//!   1. YouTube Music timed lyrics — same clock as the playing stream
//!   2. Musixmatch richsync / subtitle LRC
//!   3. LRCLIB, then regional fallbacks (Kugou, QQ, NetEase)

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use base64::Engine;
use md5::{Digest, Md5};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::{
    process::Command,
    sync::Mutex,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const LYRIC_PROVIDER_TIMEOUT: Duration = Duration::from_secs(6);
const MUSIXMATCH_APP_ID: &str = "web-desktop-app-v1.0";
pub const ANDROID_MUSIC_CLIENT_VERSION: &str = "7.21.50";

const YTM_SOURCE: &str = "Lyrics from YouTube Music";
const MUSIXMATCH_SOURCE: &str = "Lyrics from Musixmatch";
const LRCLIB_SOURCE: &str = "Lyrics from LRCLIB";
const KUGOU_SOURCE: &str = "Lyrics from Kugou";
const QQ_MUSIC_SOURCE: &str = "Lyrics from QQ Music";
const NETEASE_SOURCE: &str = "Lyrics from NetEase Cloud Music";

static LRC_TIMESTAMP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?]").expect("lrc timestamp regex")
});

// ---------------------------------------------------------------------------
// Public types (serialized to the frontend — field names must stay stable)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedLyricWord {
    pub text: String,
    pub start_time_ms: u32,
    pub end_time_ms: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedLyricLine {
    pub id: u32,
    pub text: String,
    pub start_time_ms: u32,
    pub end_time_ms: Option<u32>,
    pub words: Option<Vec<TimedLyricWord>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedLyricsResponse {
    pub lines: Vec<TimedLyricLine>,
    pub source: Option<String>,
    pub has_per_word_sync: Option<bool>,
}

#[derive(Clone)]
pub struct LyricTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_seconds: Option<u32>,
}

/// Optional playback context used to align third-party lyrics with the
/// cached stream file (leading silence) and to reach YTM's native lyrics.
pub struct LyricsResolveContext {
    pub next_response: Option<Value>,
    pub leading_silence_skip_ms: u32,
}

// ---------------------------------------------------------------------------
// Dependencies injected from `main.rs` (InnerTube + app paths)
// ---------------------------------------------------------------------------

pub struct LyricsDeps<'a> {
    pub http: &'a Client,
    pub http_no_redirect: &'a Client,
    pub user_agent: &'a str,
    pub musixmatch_token: &'a Mutex<Option<MusixmatchTokenCache>>,
}

pub struct MusixmatchTokenCache {
    pub token: String,
    pub cookies: String,
    pub expires_at: Instant,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn resolve_synced_lyrics(
    deps: &LyricsDeps<'_>,
    meta: &LyricTrack,
    ctx: &LyricsResolveContext,
    ytm_lyrics: Option<SyncedLyricsResponse>,
) -> Option<SyncedLyricsResponse> {
    let mut candidates: Vec<(i32, SyncedLyricsResponse)> = Vec::new();

    if let Some(lyrics) = ytm_lyrics {
        // YTM timed lyrics are already aligned to the playing stream — never
        // apply the leading-silence shift meant for third-party studio LRC.
        if lyrics.lines.len() >= 2 {
            return Some(lyrics);
        }
    }

    let (musixmatch, lrclib, kugou, qq, netease) = tokio::join!(
        fetch_musixmatch_lyrics(deps, meta),
        fetch_lrclib_lyrics(deps.http, meta),
        fetch_kugou_lyrics(deps.http, deps.user_agent, meta),
        fetch_qq_music_lyrics(deps.http, deps.user_agent, meta),
        fetch_netease_lyrics(deps.http, meta),
    );

    for (lyrics, validated) in [
        (musixmatch, true),
        (lrclib, true),
        (kugou, true),
        (qq, true),
        (netease, true),
    ] {
        let Some(lyrics) = lyrics else { continue };
        let meta_bonus = if validated { 25 } else { 0 };
        let score = score_candidate(&lyrics, meta, meta_bonus, validated, false);
        if score >= 45 {
            candidates.push((score, lyrics));
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, lyrics)| finalize_third_party_lyrics(lyrics, ctx))
}

fn finalize_third_party_lyrics(
    lyrics: SyncedLyricsResponse,
    ctx: &LyricsResolveContext,
) -> SyncedLyricsResponse {
    if ctx.leading_silence_skip_ms == 0 || is_ytm_native_source(&lyrics) {
        lyrics
    } else {
        apply_playback_offset(lyrics, ctx.leading_silence_skip_ms)
    }
}

fn is_ytm_native_source(lyrics: &SyncedLyricsResponse) -> bool {
    lyrics
        .source
        .as_deref()
        .is_some_and(|s| s.contains("YouTube Music"))
}

pub async fn build_resolve_context(
    app: &AppHandle,
    stream_cache: &Mutex<std::collections::HashMap<String, crate::CachedStream>>,
    stream_cache_ttl: Duration,
    video_id: Option<&str>,
) -> LyricsResolveContext {
    let stream_file_path = match video_id {
        Some(id) => resolve_stream_file_path(app, stream_cache, stream_cache_ttl, id).await,
        None => None,
    };
    let leading_silence_skip_ms = match stream_file_path.as_deref() {
        Some(path) => analyze_leading_silence_skip_ms(path).await.unwrap_or(0),
        None => 0,
    };
    LyricsResolveContext {
        next_response: None,
        leading_silence_skip_ms,
    }
}

pub async fn resolve_stream_file_path(
    app: &AppHandle,
    stream_cache: &Mutex<std::collections::HashMap<String, crate::CachedStream>>,
    stream_cache_ttl: Duration,
    video_id: &str,
) -> Option<String> {
    {
        let cache = stream_cache.lock().await;
        if let Some(entry) = cache.get(video_id) {
            if entry.fetched_at.elapsed() < stream_cache_ttl && Path::new(&entry.source).exists() {
                return Some(entry.source.clone());
            }
        }
    }
    let cache_dir = crate::stream_cache_dir(app).ok()?;
    find_disk_stream_cache(&cache_dir, video_id, stream_cache_ttl).await
}

async fn find_disk_stream_cache(
    cache_dir: &Path,
    video_id: &str,
    stream_cache_ttl: Duration,
) -> Option<String> {
    let mut entries = tokio::fs::read_dir(cache_dir).await.ok()?;
    let prefix = format!("{video_id}.");
    let cutoff = SystemTime::now() - stream_cache_ttl;
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

// ---------------------------------------------------------------------------
// YouTube Music timed lyrics
// ---------------------------------------------------------------------------

pub fn extract_lyrics_browse_id_from_next(response: &Value) -> Option<String> {
    let tabs = response
        .pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs")
        .and_then(Value::as_array)?;
    for tab in tabs {
        if tab
            .pointer("/tabRenderer/unselectable")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let page_type = tab
            .pointer("/tabRenderer/endpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
            .and_then(Value::as_str)?;
        if page_type == "MUSIC_PAGE_TYPE_TRACK_LYRICS" {
            return tab
                .pointer("/tabRenderer/endpoint/browseEndpoint/browseId")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    None
}

pub fn parse_ytm_timed_lyrics_response(response: &Value) -> Option<SyncedLyricsResponse> {
    let data = response.pointer(
        "/contents/elementRenderer/newElement/type/componentType/model/timedLyricsModel/lyricsData",
    )?;
    let entries = data.get("timedLyricsData").and_then(Value::as_array)?;
    if entries.is_empty() {
        return None;
    }

    let mut lines = Vec::with_capacity(entries.len());
    for entry in entries {
        let text = entry.get("lyricLine").and_then(Value::as_str)?.trim();
        if text.is_empty() {
            continue;
        }
        let cue = entry.get("cueRange")?;
        let start_ms = parse_ytm_ms(cue.get("startTimeMilliseconds"))?;
        let end_ms = parse_ytm_ms(cue.get("endTimeMilliseconds")).unwrap_or(start_ms + 3000);
        let id = cue
            .pointer("/metadata/id")
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(start_ms as u64) as u32;

        lines.push(TimedLyricLine {
            id,
            text: text.to_string(),
            start_time_ms: start_ms,
            end_time_ms: Some(end_ms),
            words: None,
        });
    }

    if lines.len() < 2 {
        return None;
    }

    Some(SyncedLyricsResponse {
        lines,
        source: data
            .get("sourceMessage")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| Some(YTM_SOURCE.to_string())),
        has_per_word_sync: Some(false),
    })
}

fn parse_ytm_ms(value: Option<&Value>) -> Option<u32> {
    let raw = value?;
    let ms = if let Some(n) = raw.as_u64() {
        n
    } else if let Some(s) = raw.as_str() {
        s.parse().ok()?
    } else if let Some(n) = raw.as_i64() {
        n.max(0) as u64
    } else {
        return None;
    };
    Some(ms.min(u32::MAX as u64) as u32)
}

// ---------------------------------------------------------------------------
// Scoring & metadata matching
// ---------------------------------------------------------------------------

fn score_candidate(
    lyrics: &SyncedLyricsResponse,
    meta: &LyricTrack,
    provider_bonus: i32,
    metadata_validated: bool,
    is_ytm_native: bool,
) -> i32 {
    let mut score = score_sync_quality(&lyrics.lines, meta.duration_seconds) as i32;
    score += provider_bonus;
    if lyrics.has_per_word_sync == Some(true) {
        score += 12;
    }
    if is_ytm_native {
        score += 40;
    }
    if metadata_validated {
        score += 8;
    }
    score.min(200)
}

fn score_sync_quality(lines: &[TimedLyricLine], track_duration_secs: Option<u32>) -> u32 {
    let n = lines.len();
    if n < 2 {
        return 0;
    }

    let mut score: u32 = 30;

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
    if first_ms <= 3000 {
        score += 8;
    } else if first_ms <= 8000 {
        score += 4;
    } else if first_ms > 45_000 {
        score = score.saturating_sub(25);
    } else if first_ms > 20_000 {
        score = score.saturating_sub(12);
    }

    let unique_starts = lines
        .iter()
        .map(|l| l.start_time_ms)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if unique_starts <= 1 {
        return 0;
    }
    if unique_starts < n / 3 {
        score = score.saturating_sub(30);
    }

    let last_ms = lines[n - 1].start_time_ms;
    if let Some(dur_s) = track_duration_secs {
        let dur_ms = dur_s.saturating_mul(1000);
        if dur_ms > 0 {
            let ratio = last_ms as f64 / dur_ms as f64;
            if ratio >= 0.75 && ratio <= 1.25 {
                score += 18;
            } else if ratio >= 0.50 && ratio <= 1.50 {
                score += 6;
            } else {
                score = score.saturating_sub(22);
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
        score = score.saturating_sub(30);
    }
    score = score.saturating_sub(gap_penalty.min(20));

    score.min(100)
}

fn score_metadata_match(
    candidate_title: &str,
    candidate_artist: &str,
    candidate_duration_secs: Option<i64>,
    track: &LyricTrack,
) -> i32 {
    let mut score: i32 = 0;

    if lyric_titles_match(candidate_title, &track.title) {
        score += 55;
    } else if titles_compatible(candidate_title, &track.title) {
        score += 22;
    } else {
        return -100;
    }

    if lyric_artists_match(candidate_artist, &track.artist) {
        score += 35;
    } else if artists_compatible(candidate_artist, &track.artist) {
        score += 12;
    } else if !candidate_artist.trim().is_empty() && !track.artist.trim().is_empty() {
        score -= 40;
    }

    if let Some(td) = track.duration_seconds.map(|s| s as i64) {
        let cd = candidate_duration_secs.unwrap_or(0);
        if cd > 0 {
            let delta = (cd - td).abs();
            if delta <= 3 {
                score += 20;
            } else if delta <= 8 {
                score += 12;
            } else if delta <= 20 {
                score += 5;
            } else if delta > 45 {
                score -= 25;
            }
        }
    }

    score
}

fn normalize_lyric_title(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prev_space = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch.to_ascii_lowercase());
            prev_space = false;
        } else if ch.is_ascii_whitespace() || ch == '_' || ch == '-' {
            if !prev_space && !result.is_empty() {
                result.push(' ');
                prev_space = true;
            }
        } else if matches!(ch, '(' | ')' | '[' | ']') {
            if !prev_space && !result.is_empty() {
                result.push(' ');
                prev_space = true;
            }
        }
    }
    result.trim().to_string()
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

fn primary_artist_name(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    for sep in [" feat.", " ft.", " featuring ", " with ", " & ", " and ", ","] {
        if let Some(idx) = lower.find(sep) {
            return normalize_query_text(&text[..idx]);
        }
    }
    normalize_query_text(text)
}

fn lyric_titles_match(a: &str, b: &str) -> bool {
    let na = normalize_lyric_title(a);
    let nb = normalize_lyric_title(b);
    !na.is_empty() && na == nb
}

fn titles_compatible(a: &str, b: &str) -> bool {
    let na = normalize_query_text(a);
    let nb = normalize_query_text(b);
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    na == nb || na.contains(&nb) || nb.contains(&na)
}

fn lyric_artists_match(a: &str, b: &str) -> bool {
    primary_artist_name(a) == primary_artist_name(b)
}

fn artists_compatible(a: &str, b: &str) -> bool {
    let na = primary_artist_name(a);
    let nb = primary_artist_name(b);
    if na.is_empty() || nb.is_empty() {
        return true;
    }
    na == nb || na.contains(&nb) || nb.contains(&na)
}

fn apply_playback_offset(mut lyrics: SyncedLyricsResponse, offset_ms: u32) -> SyncedLyricsResponse {
    if offset_ms == 0 {
        return lyrics;
    }
    for line in &mut lyrics.lines {
        line.start_time_ms = line.start_time_ms.saturating_add(offset_ms);
        line.id = line.start_time_ms;
        if let Some(end) = line.end_time_ms {
            line.end_time_ms = Some(end.saturating_add(offset_ms));
        }
        if let Some(words) = line.words.as_mut() {
            for word in words {
                word.start_time_ms = word.start_time_ms.saturating_add(offset_ms);
                word.end_time_ms = word.end_time_ms.saturating_add(offset_ms);
            }
        }
    }
    lyrics
}

// ---------------------------------------------------------------------------
// LRC parsing
// ---------------------------------------------------------------------------

pub fn parse_lrc(lrc: &str) -> Vec<TimedLyricLine> {
    let mut offset_ms: i64 = 0;
    let mut entries: Vec<(u32, String)> = Vec::new();

    for raw in lrc.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("[offset:") {
            if let Some(inner) = rest.strip_suffix(']') {
                if let Ok(value) = inner.trim().parse::<i64>() {
                    offset_ms = value;
                }
            }
            continue;
        }

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
    static METADATA_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new("^[一-龥][一-龥\\s]*:").unwrap());
    METADATA_RE.is_match(text)
}

fn build_lyrics_from_lrc(lrc: &str, source: &str) -> Option<SyncedLyricsResponse> {
    let lines = parse_lrc(lrc);
    if lines.len() < 2 || score_sync_quality(&lines, None) < 20 {
        return None;
    }
    Some(SyncedLyricsResponse {
        lines,
        source: Some(source.to_string()),
        has_per_word_sync: Some(false),
    })
}

// ---------------------------------------------------------------------------
// Leading silence (align third-party lyrics with stream playback position)
// ---------------------------------------------------------------------------

async fn analyze_leading_silence_skip_ms(file_path: &str) -> Option<u32> {
    const ANALYSIS_MAX_SECONDS: f64 = 45.0;
    const SILENCE_NOISE_DB: f64 = -30.0;
    const SILENCE_MIN_DURATION: f64 = 0.25;
    const MIN_SKIP_SECONDS: f64 = 0.5;
    const MAX_SKIP_SECONDS: f64 = 30.0;
    const LEADING_SILENCE_START_TOLERANCE: f64 = 0.05;

    fn parse_silence_value(line: &str, key: &str) -> Option<f64> {
        let marker = format!("{key}:");
        let start = line.find(&marker)? + marker.len();
        let raw = line[start..].trim();
        let token = raw.split_whitespace().next()?;
        token.parse::<f64>().ok().filter(|value| value.is_finite())
    }

    let ffmpeg = check_ffmpeg().await?;
    let null_device = if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    };
    let filter = format!("silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DURATION}");

    let mut command = Command::new(&ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-vn",
        "-t",
        &format!("{ANALYSIS_MAX_SECONDS:.3}"),
        "-i",
        file_path,
        "-af",
        &filter,
        "-f",
        "null",
        null_device,
        "-y",
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().await.ok()?;
    if !output.status.success() {
        return None;
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

    leading_skip.and_then(|seconds| {
        if seconds < MIN_SKIP_SECONDS {
            None
        } else {
            let clamped = seconds.min(MAX_SKIP_SECONDS);
            Some((clamped * 1000.0).round() as u32)
        }
    })
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

// ---------------------------------------------------------------------------
// Musixmatch
// ---------------------------------------------------------------------------

async fn fetch_musixmatch_lyrics(deps: &LyricsDeps<'_>, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let (token, cookies) = fetch_musixmatch_token(deps).await?;
    let client = deps.http;

    let mut search_params: Vec<(&str, &str)> = vec![
        ("app_id", MUSIXMATCH_APP_ID),
        ("usertoken", &token),
        ("q_track", &track.title),
        ("q_artist", &track.artist),
        ("page_size", "8"),
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

    let mut scored: Vec<(i32, i64)> = track_list
        .iter()
        .filter_map(|entry| {
            let track_name = entry.pointer("/track/track_name").and_then(Value::as_str).unwrap_or("");
            let artist_name = entry.pointer("/track/artist_name").and_then(Value::as_str).unwrap_or("");
            let track_id = entry.pointer("/track/track_id").and_then(Value::as_i64)?;
            let entry_duration = entry.pointer("/track/track_length").and_then(Value::as_i64);
            let mut score = score_metadata_match(track_name, artist_name, entry_duration, track);
            if entry.pointer("/track/has_richsync").and_then(Value::as_i64) == Some(1) {
                score += 15;
            }
            if score >= 40 {
                Some((score, track_id))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, track_id) in scored {
        if let Some(lyrics) = fetch_musixmatch_richsync(client, &token, &cookies, track_id).await {
            let name = track_list
                .iter()
                .find(|e| e.pointer("/track/track_id").and_then(Value::as_i64) == Some(track_id))
                .and_then(|e| e.pointer("/track/track_name").and_then(Value::as_str))
                .unwrap_or("");
            if lyric_titles_match(name, &track.title) {
                return Some(lyrics);
            }
        }
        if let Some(lyrics) = fetch_musixmatch_subtitle(client, &token, &cookies, track_id).await {
            let name = track_list
                .iter()
                .find(|e| e.pointer("/track/track_id").and_then(Value::as_i64) == Some(track_id))
                .and_then(|e| e.pointer("/track/track_name").and_then(Value::as_str))
                .unwrap_or("");
            if lyric_titles_match(name, &track.title) {
                return Some(lyrics);
            }
        }
    }
    None
}

async fn fetch_musixmatch_richsync(
    client: &Client,
    token: &str,
    cookies: &str,
    track_id: i64,
) -> Option<SyncedLyricsResponse> {
    let richsync_resp = client
        .get("https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get")
        .query(&[
            ("app_id", MUSIXMATCH_APP_ID),
            ("usertoken", token),
            ("track_id", &track_id.to_string()),
        ])
        .header("cookie", cookies)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    let richsync_json: Value = richsync_resp.json().await.ok()?;
    if richsync_json.pointer("/message/header/status_code").and_then(Value::as_i64)? != 200 {
        return None;
    }
    let richsync_body_str = richsync_json
        .pointer("/message/body/richsync/richsync_body")
        .and_then(Value::as_str)?;
    let richsync_body: Value = serde_json::from_str(richsync_body_str).ok()?;
    let lines_array = richsync_body.as_array()?;

    let mut lines = Vec::new();
    for line_entry in lines_array {
        let ts = line_entry.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
        let te = line_entry.get("te").and_then(Value::as_f64).unwrap_or(0.0);
        let text = line_entry.get("x").and_then(Value::as_str).unwrap_or("").to_string();
        let words_data = line_entry.get("l").and_then(Value::as_array);
        let line_start_ms = (ts * 1000.0) as u32;
        let line_end_ms = (te * 1000.0) as u32;

        let words = words_data.and_then(|word_entries| {
            let mut words = Vec::new();
            for (word_idx, word_entry) in word_entries.iter().enumerate() {
                let c = word_entry.get("c").and_then(Value::as_str).unwrap_or("");
                let o = word_entry.get("o").and_then(Value::as_f64).unwrap_or(0.0);
                let offset_ms = (o * 1000.0) as u32;
                let next_offset_ms = word_entries
                    .get(word_idx + 1)
                    .and_then(|w| w.get("o"))
                    .and_then(Value::as_f64)
                    .map(|o| (o * 1000.0) as u32)
                    .unwrap_or(line_end_ms.saturating_sub(line_start_ms));
                if !c.is_empty() {
                    words.push(TimedLyricWord {
                        text: c.to_string(),
                        start_time_ms: line_start_ms + offset_ms,
                        end_time_ms: line_start_ms + next_offset_ms,
                    });
                }
            }
            if words.is_empty() { None } else { Some(words) }
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

    if lines.len() < 2 {
        return None;
    }
    Some(SyncedLyricsResponse {
        lines,
        source: Some(MUSIXMATCH_SOURCE.to_string()),
        has_per_word_sync: Some(true),
    })
}

async fn fetch_musixmatch_subtitle(
    client: &Client,
    token: &str,
    cookies: &str,
    track_id: i64,
) -> Option<SyncedLyricsResponse> {
    let resp = client
        .get("https://apic-desktop.musixmatch.com/ws/1.1/track.subtitle.get")
        .query(&[
            ("app_id", MUSIXMATCH_APP_ID),
            ("usertoken", token),
            ("track_id", &track_id.to_string()),
            ("subtitle_format", "lrc"),
        ])
        .header("cookie", cookies)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    let json: Value = resp.json().await.ok()?;
    if json.pointer("/message/header/status_code").and_then(Value::as_i64)? != 200 {
        return None;
    }
    let lrc = json
        .pointer("/message/body/subtitle/subtitle_body")
        .and_then(Value::as_str)?;
    build_lyrics_from_lrc(lrc, MUSIXMATCH_SOURCE)
}

async fn fetch_musixmatch_token(deps: &LyricsDeps<'_>) -> Option<(String, String)> {
    {
        let cache = deps.musixmatch_token.lock().await;
        if let Some(ref cached) = *cache {
            if Instant::now() < cached.expires_at {
                return Some((cached.token.clone(), cached.cookies.clone()));
            }
        }
    }

    let mut cookies: Vec<String> = Vec::new();
    for _attempt in 0..3 {
        let mut req = deps
            .http_no_redirect
            .get("https://apic-desktop.musixmatch.com/ws/1.1/token.get")
            .query(&[("user_language", "en"), ("app_id", MUSIXMATCH_APP_ID)])
            .timeout(LYRIC_PROVIDER_TIMEOUT);
        if !cookies.is_empty() {
            req = req.header("cookie", cookies.join("; "));
        }
        let resp = req.send().await.ok()?;

        if resp.status().as_u16() == 301 {
            for set_cookie in resp.headers().get_all("set-cookie").iter() {
                if let Ok(val) = set_cookie.to_str() {
                    if let Some(name_value) = val.split(';').next() {
                        let nv = name_value.trim().to_string();
                        if !nv.ends_with("=unknown") {
                            cookies.push(nv);
                        }
                    }
                }
            }
            continue;
        }

        let json: Value = resp.json().await.ok()?;
        let status = json.pointer("/message/header/status_code").and_then(Value::as_i64)?;
        if status == 401 || status != 200 {
            return None;
        }
        let token = json
            .pointer("/message/body/user_token")
            .and_then(Value::as_str)?
            .to_string();
        let cookie_header = cookies.join("; ");
        let mut cache = deps.musixmatch_token.lock().await;
        *cache = Some(MusixmatchTokenCache {
            token: token.clone(),
            cookies: cookie_header.clone(),
            expires_at: Instant::now() + Duration::from_secs(540),
        });
        return Some((token, cookie_header));
    }
    None
}

// ---------------------------------------------------------------------------
// LRCLIB
// ---------------------------------------------------------------------------

async fn fetch_lrclib_lyrics(http: &Client, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
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

    if let Some(lyrics) = fetch_lrclib_get(http, &params, track).await {
        return Some(lyrics);
    }
    fetch_lrclib_search(http, track).await
}

async fn fetch_lrclib_get(
    http: &Client,
    params: &[(&str, String)],
    track: &LyricTrack,
) -> Option<SyncedLyricsResponse> {
    let response = http
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
    parse_lrclib_entry(&json, track)
}

async fn fetch_lrclib_search(http: &Client, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let params: Vec<(&str, String)> = vec![
        ("artist_name", track.artist.clone()),
        ("track_name", track.title.clone()),
    ];
    let response = http
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
    let mut candidates: Vec<(i32, SyncedLyricsResponse)> = results
        .iter()
        .filter_map(|entry| parse_lrclib_entry(entry, track).map(|lyrics| {
            let entry_title = entry.get("trackName").and_then(Value::as_str).unwrap_or("");
            let entry_artist = entry.get("artistName").and_then(Value::as_str).unwrap_or("");
            let entry_duration = entry.get("duration").and_then(Value::as_f64).map(|d| d.round() as i64);
            let mut score = score_sync_quality(&lyrics.lines, track.duration_seconds) as i32;
            score += score_metadata_match(entry_title, entry_artist, entry_duration, track);
            (score, lyrics)
        }))
        .filter(|(score, _)| *score >= 55)
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, lyrics)| lyrics)
}

fn parse_lrclib_entry(value: &Value, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let synced = value.get("syncedLyrics").and_then(Value::as_str)?;
    if synced.trim().is_empty() {
        return None;
    }
    let entry_title = value.get("trackName").and_then(Value::as_str).unwrap_or("");
    let entry_artist = value.get("artistName").and_then(Value::as_str).unwrap_or("");
    let entry_duration = value.get("duration").and_then(Value::as_f64).map(|d| d.round() as i64);
    let meta_score = score_metadata_match(entry_title, entry_artist, entry_duration, track);
    if meta_score < 35 {
        return None;
    }
    let mut lyrics = build_lyrics_from_lrc(synced, LRCLIB_SOURCE)?;
    if score_sync_quality(&lyrics.lines, track.duration_seconds) < 25 {
        return None;
    }
    lyrics.source = Some(LRCLIB_SOURCE.to_string());
    Some(lyrics)
}

// ---------------------------------------------------------------------------
// NetEase / Kugou / QQ Music
// ---------------------------------------------------------------------------

async fn fetch_netease_lyrics(http: &Client, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let response = http
        .post("https://music.163.com/api/search/get")
        .header("Referer", "https://music.163.com")
        .form(&[("s", query.as_str()), ("type", "1"), ("offset", "0"), ("limit", "12")])
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
    fetch_netease_lyrics_by_id(http, song_id).await
}

fn pick_netease_song(songs: &[Value], track: &LyricTrack) -> Option<u64> {
    let mut candidates: Vec<(i32, u64)> = Vec::new();
    for song in songs {
        let id = song.get("id").and_then(Value::as_u64)?;
        let name = song.get("name").and_then(Value::as_str).unwrap_or("");
        let artists = song
            .get("artists")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|a| a.get("name").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let duration_ms = song.get("duration").and_then(Value::as_u64).unwrap_or(0);
        let duration_secs = if duration_ms > 0 {
            Some((duration_ms / 1000) as i64)
        } else {
            None
        };
        let score = score_metadata_match(name, &artists, duration_secs, track);
        if score >= 45 {
            candidates.push((score, id));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.first().map(|(_, id)| *id)
}

async fn fetch_netease_lyrics_by_id(http: &Client, song_id: u64) -> Option<SyncedLyricsResponse> {
    let url = format!("https://music.163.com/api/song/lyric?id={song_id}&lv=1&tv=-1");
    let response = http
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
    build_lyrics_from_lrc(lrc, NETEASE_SOURCE)
}

async fn fetch_kugou_lyrics(http: &Client, user_agent: &str, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let search_url = format!(
        "https://mobilecdn.kugou.com/api/v3/search/song?keyword={}&page=1&pagesize=8",
        urlencoding::encode(&query),
    );
    let response = http
        .get(&search_url)
        .header("User-Agent", user_agent)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let data = json.get("data")?.get("info")?.as_array()?;

    let mut best: Option<(i32, &Value)> = None;
    for entry in data {
        let song_name = entry.get("songname").and_then(Value::as_str).unwrap_or("");
        let singer = entry.get("singername").and_then(Value::as_str).unwrap_or("");
        let duration = entry.get("duration").and_then(Value::as_i64);
        let score = score_metadata_match(song_name, singer, duration, track);
        if score >= 45 {
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, entry));
            }
        }
    }
    let candidate = best?.1;
    let hash = candidate.get("hash").and_then(Value::as_str)?;
    let hash_bytes = hex::decode(hash).ok()?;
    let accesskey = {
        let mut hasher = Md5::new();
        hasher.update(&hash_bytes);
        hex::encode(hasher.finalize())
    };
    let lyrics_url = format!(
        "https://lyrics.kugou.com/download?ver=1&client=pc&id={hash}&accesskey={accesskey}&fmt=lrc&charset=utf8",
    );
    let resp = http
        .get(&lyrics_url)
        .header("User-Agent", user_agent)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: Value = resp.json().await.ok()?;
    if json.get("status").and_then(Value::as_i64).unwrap_or(0) != 200 {
        return None;
    }
    let lrc = json.get("content").and_then(Value::as_str)?;
    let lrc_decoded = base64_decode(lrc)?;
    build_lyrics_from_lrc(&lrc_decoded, KUGOU_SOURCE)
}

async fn fetch_qq_music_lyrics(http: &Client, user_agent: &str, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let query = format!("{} {}", track.artist, track.title);
    let search_url = format!(
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key={}&format=json",
        urlencoding::encode(&query),
    );
    let response = http
        .get(&search_url)
        .header("Referer", "https://y.qq.com/")
        .header("User-Agent", user_agent)
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

    let mut best: Option<(i32, &Value)> = None;
    for entry in songs {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        let singer = entry.get("singer").and_then(Value::as_str).unwrap_or("");
        let score = score_metadata_match(name, singer, None, track);
        if score >= 45 {
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, entry));
            }
        }
    }
    let song = best?.1;
    let mid = song.get("mid").and_then(Value::as_str)?;
    let lyrics_url = format!(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={mid}&format=json&nobase64=1",
    );
    let resp = http
        .get(&lyrics_url)
        .header("Referer", "https://y.qq.com/")
        .header("User-Agent", user_agent)
        .timeout(LYRIC_PROVIDER_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let json_str = text
        .strip_prefix("MusicJsonCallback(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(&text);
    let json: Value = serde_json::from_str(json_str).ok()?;
    let lrc = json.get("lyric").and_then(Value::as_str)?;
    build_lyrics_from_lrc(lrc, QQ_MUSIC_SOURCE)
}

fn base64_decode(input: &str) -> Option<String> {
    use std::io::Read;
    let decoded = base64::engine::general_purpose::STANDARD.decode(input).ok()?;
    let mut decoder = flate2::read::GzDecoder::new(&decoded[..]);
    let mut output = String::new();
    decoder.read_to_string(&mut output).ok()?;
    Some(output)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lrc_handles_basic_synced_lines() {
        let lrc = "[00:12.34]First line\n[00:15.67]Second line\n[00:20.00]Third line";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[0].start_time_ms, 12_340);
        assert_eq!(lines[0].end_time_ms, Some(15_670));
    }

    #[test]
    fn parse_lrc_rejects_unsynced_plain_text() {
        let lrc = "Plain lyrics line\nAnother plain line";
        assert!(parse_lrc(lrc).is_empty());
    }

    #[test]
    fn lyric_artists_match_ignores_featuring() {
        assert!(lyric_artists_match("Radiohead", "Radiohead feat. Guest"));
        assert!(!lyric_artists_match("Radiohead", "Coldplay"));
    }

    #[test]
    fn extract_lyrics_browse_id_reads_next_tabs() {
        let response = serde_json::json!({
            "contents": {
                "singleColumnMusicWatchNextResultsRenderer": {
                    "tabbedRenderer": {
                        "watchNextTabbedResultsRenderer": {
                            "tabs": [
                                {
                                    "tabRenderer": {
                                        "endpoint": {
                                            "browseEndpoint": {
                                                "browseId": "MPLYt_abc123",
                                                "browseEndpointContextSupportedConfigs": {
                                                    "browseEndpointContextMusicConfig": {
                                                        "pageType": "MUSIC_PAGE_TYPE_TRACK_LYRICS"
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
            }
        });
        assert_eq!(
            extract_lyrics_browse_id_from_next(&response).as_deref(),
            Some("MPLYt_abc123")
        );
    }

    #[test]
    fn score_sync_quality_rejects_single_timestamp() {
        let lines = vec![
            TimedLyricLine {
                id: 0,
                text: "a".into(),
                start_time_ms: 0,
                end_time_ms: Some(1000),
                words: None,
            },
            TimedLyricLine {
                id: 0,
                text: "b".into(),
                start_time_ms: 0,
                end_time_ms: None,
                words: None,
            },
        ];
        assert_eq!(score_sync_quality(&lines, Some(180)), 0);
    }
}