//! Synced-lyrics resolution: provider fan-out, metadata matching, and
//! playback alignment for stream tracks.
//!
//! Only clean providers are queried — Musixmatch (richsync/subtitle) and
//! LRCLIB. Regional fallbacks (Kugou, QQ, NetEase) are intentionally NOT
//! queried: they frequently return poorly formatted or machine-translated
//! LRC that visibly flickers when a better result arrives later. Prefer
//! waiting a few seconds longer (or reporting "no lyrics") over flashing
//! a bad provider's result and then swapping.
//!
//! YouTube Music native timed lyrics are intentionally NOT displayed — in
//! practice they are not aligned to the resolved stream. We prefer reporting
//! "no lyrics" over serving unsynced lyrics. The YTM lyrics *tab* is still
//! consulted as a cheap presence probe (does this song have lyrics at all?)
//! so the UI can short-circuit the slow provider fan-out when a song has no
//! lyrics to find.

use std::{
    path::Path,
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

const YTM_SOURCE: &str = "Lyrics from YouTube Music";
const MUSIXMATCH_SOURCE: &str = "Lyrics from Musixmatch";
const LRCLIB_SOURCE: &str = "Lyrics from LRCLIB";
const KUGOU_SOURCE: &str = "Lyrics from Kugou";
const QQ_MUSIC_SOURCE: &str = "Lyrics from QQ Music";
const NETEASE_SOURCE: &str = "Lyrics from NetEase Cloud Music";

/// Fast probe — how long Tier-0 is allowed before we report "unknown".
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const PROBE_LRCLIB_TIMEOUT: Duration = Duration::from_millis(900);

/// Vocal-onset DSP constants — tuned for 16 kHz mono PCM.
const VOCAL_SAMPLE_RATE: u32 = 16_000;
const VOCAL_WINDOW_MS: u32 = 20;
const VOCAL_HOP_MS: u32 = 10;
const VOCAL_MIN_SUSTAIN_MS: u32 = 320;
const VOCAL_MIN_PHRASE_MS: u32 = 500;
const VOCAL_ANALYSIS_SECONDS: f64 = 45.0;
const VOCAL_ONSET_DB_ABOVE_FLOOR: f64 = 14.0;
const VOCAL_ABSOLUTE_FLOOR_DB: f64 = -48.0;

/// Bound for ffmpeg analysis (leading-silence + vocal-onset). Healthy runs
/// finish in seconds; this reaps a wedged ffmpeg so it can't pin a tokio
/// worker and its child process forever.
#[allow(dead_code)]
const FFMPEG_ANALYSIS_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// Total playback offset (ms) already applied to `lines`. Set by the
    /// vocal-onset correction for third-party LRC; `None` means no offset
    /// was applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_offset_ms: Option<i32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsAvailability {
    /// Tier-0 thinks lyrics exist (YTM tab or LRCLIB get hit).
    pub available: bool,
    /// 0.0-1.0 — high means probe is confident; low means "unknown, keep searching".
    pub confidence: f32,
    /// Which fast provider triggered availability, if any.
    pub source: Option<String>,
    /// First lyric timestamp if availability came from a real LRC probe.
    pub first_lyric_ms: Option<u32>,
    /// Whether the YTM native lyrics tab existed (even if body wasn't fetched).
    pub ytm_has_tab: bool,
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricOffsetRecord {
    pub offset_ms: i32,
    pub confidence: f32,
    pub method: String,
    pub lyrics_hash: String,
    pub computed_at_ms: u64,
    pub first_lyric_ms: u32,
    pub vocal_onset_ms: u32,
    pub leading_silence_ms: u32,
}

#[derive(Clone)]
pub struct LyricTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_seconds: Option<u32>,
}

/// Optional playback context used to align third-party lyrics with the
/// cached stream file (leading silence).
pub struct LyricsResolveContext {
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
) -> Option<SyncedLyricsResponse> {
    let mut candidates: Vec<(i32, SyncedLyricsResponse)> = Vec::new();

    // Only clean providers: Musixmatch + LRCLIB. Regional providers (Kugou,
    // QQ, NetEase) are excluded per product decision — they cause the
    // "bad lyrics then better lyrics" flicker. Waiting longer (or showing
    // "no lyrics") is preferred over flashing poorly formatted LRC.
    let (musixmatch, lrclib) = tokio::join!(
        fetch_musixmatch_lyrics(deps, meta),
        fetch_lrclib_lyrics(deps.http, meta),
    );

    for (lyrics, validated) in [(musixmatch, true), (lrclib, true)] {
        let Some(lyrics) = lyrics else { continue };
        let meta_bonus = if validated { 25 } else { 0 };
        let score = score_candidate(&lyrics, meta, meta_bonus, validated);
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
    _ctx: &LyricsResolveContext,
) -> SyncedLyricsResponse {
    // Silence is now physically trimmed from the audio file (atrim re-encode)
    // so the file starts at 0:00 where the music begins. Third-party LRC
    // (LRCLIB/Musixmatch etc) is authored for the studio master (no leading
    // silence), so it must NOT be shifted. Previously we did
    // `lyrics + leading_silence_skip_ms` which delayed every line by the
    // silence amount and defeated the trim — e.g. a YT Music upload with 3s
    // of silence got trimmed to 0 but lyrics were pushed to +3s, staying
    // out of sync. With physical trimming, leave lyrics as-is.
    lyrics
}

pub async fn build_resolve_context(
    _app: &AppHandle,
    _stream_cache: &Mutex<crate::cache::TtlCache<String, crate::CachedStream>>,
    _stream_cache_ttl: Duration,
    _video_id: Option<&str>,
) -> LyricsResolveContext {
    // No leading-silence offset is applied anymore — physical trimming makes
    // `analyze_leading_silence_skip_ms` unnecessary on the lyrics path. We
    // keep the struct field for cache-key stability (vocal offset still
    // stores leading_silence_ms) but always report 0 so `finalize` becomes
    // a no-op. This also saves an ffmpeg spawn per `get_synced_lyrics` call.
    LyricsResolveContext {
        leading_silence_skip_ms: 0,
    }
}

pub async fn resolve_stream_file_path(
    app: &AppHandle,
    stream_cache: &Mutex<crate::cache::TtlCache<String, crate::CachedStream>>,
    stream_cache_ttl: Duration,
    video_id: &str,
) -> Option<String> {
    {
        let mut cache = stream_cache.lock().await;
        if let Some(entry) = cache.get(&video_id.to_string()) {
            if Path::new(&entry.source).exists() {
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
// Scoring & metadata matching
// ---------------------------------------------------------------------------

fn score_candidate(
    lyrics: &SyncedLyricsResponse,
    meta: &LyricTrack,
    provider_bonus: i32,
    metadata_validated: bool,
) -> i32 {
    let mut score = score_sync_quality(&lyrics.lines, meta.duration_seconds) as i32;
    score += provider_bonus;
    if lyrics.has_per_word_sync == Some(true) {
        score += 12;
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

#[allow(dead_code)]
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
        applied_offset_ms: None,
    })
}

// ---------------------------------------------------------------------------
// Leading silence (align third-party lyrics with stream playback position)
// ---------------------------------------------------------------------------

pub(crate) fn parse_leading_silence_stderr(stderr: &str) -> Option<u32> {
    const MIN_SKIP_SECONDS: f64 = 0.35;
    const MAX_SKIP_SECONDS: f64 = 8.0;
    const LEADING_SILENCE_START_TOLERANCE: f64 = 0.25;
    const SILENCE_END_PREROLL: f64 = 0.08;

    fn parse_silence_value(line: &str, key: &str) -> Option<f64> {
        let marker = format!("{key}:");
        let start = line.find(&marker)? + marker.len();
        let raw = line[start..].trim();
        let token = raw.split_whitespace().next()?;
        token.parse::<f64>().ok().filter(|value| value.is_finite())
    }

    let mut current_silence_start: Option<f64> = None;
    let mut leading_skip: Option<f64> = None;

    for line in stderr.lines() {
        if line.contains("silence_start:") {
            current_silence_start = parse_silence_value(line, "silence_start");
            continue;
        }
        if line.contains("silence_end:") {
            let silence_end = parse_silence_value(line, "silence_end");
            let silence_dur = parse_silence_value(line, "silence_duration");
            if let Some(end) = silence_end {
                let start = current_silence_start
                    .or_else(|| silence_dur.map(|dur| (end - dur).max(0.0)))
                    .unwrap_or(0.0);
                if start <= LEADING_SILENCE_START_TOLERANCE {
                    leading_skip = Some(end);
                    break;
                }
            }
            current_silence_start = None;
        }
    }

    leading_skip.and_then(|seconds| {
        let with_preroll = (seconds - SILENCE_END_PREROLL).max(0.0);
        if with_preroll < MIN_SKIP_SECONDS {
            None
        } else {
            let clamped = with_preroll.min(MAX_SKIP_SECONDS);
            Some((clamped * 1000.0).round() as u32)
        }
    })
}

#[allow(dead_code)]
async fn analyze_leading_silence_skip_ms(app: &AppHandle, file_path: &str) -> Option<u32> {
    const ANALYSIS_MAX_SECONDS: f64 = 45.0;
    const SILENCE_NOISE_DB: f64 = -42.0;
    const SILENCE_MIN_DURATION: f64 = 0.3;

    let ffmpeg = crate::resolve_ffmpeg(app).await?;
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
    command.kill_on_drop(true);

    let output = match tokio::time::timeout(FFMPEG_ANALYSIS_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_leading_silence_stderr(&stderr)
}

// ---------------------------------------------------------------------------
// Availability probe (fast "does this song have lyrics?" signal)
// ---------------------------------------------------------------------------

/// Tier-0 probe — YTM tab + LRCLIB get, bounded to PROBE_TIMEOUT.
/// Returns high-confidence availability; low confidence means "unknown, keep
/// searching". This powers the UI's fast existence signal WITHOUT ever
/// serving YouTube Music's native timed lyrics.
pub async fn probe_lyrics_availability(
    deps: &LyricsDeps<'_>,
    meta: &LyricTrack,
    ytm_has_tab: Option<bool>,
) -> LyricsAvailability {
    let ytm_tab = ytm_has_tab.unwrap_or(false);

    // The YTM tab existing is a strong signal even before fetching its body.
    // No InnerTube helper lives here — the probe trusts the caller's
    // `ytm_has_tab` signal and races LRCLIB get as the text-lyrics fallback.
    if ytm_tab {
        return LyricsAvailability {
            available: true,
            confidence: 0.92,
            source: Some(YTM_SOURCE.to_string()),
            first_lyric_ms: None,
            ytm_has_tab: true,
        };
    }

    let lrclib_res =
        tokio::time::timeout(PROBE_TIMEOUT, fetch_lrclib_get_fast(deps.http, meta)).await;
    if let Ok(Some(lyrics)) = lrclib_res {
        if lyrics.lines.len() >= 2 {
            return LyricsAvailability {
                available: true,
                confidence: 0.88,
                source: Some(LRCLIB_SOURCE.to_string()),
                first_lyric_ms: lyrics.lines.first().map(|l| l.start_time_ms),
                ytm_has_tab: false,
            };
        }
    }
    // Neither fast provider hit — low confidence "unknown", caller should keep full search alive.
    LyricsAvailability {
        available: false,
        confidence: 0.35,
        source: None,
        first_lyric_ms: None,
        ytm_has_tab: ytm_tab,
    }
}

async fn fetch_lrclib_get_fast(http: &Client, track: &LyricTrack) -> Option<SyncedLyricsResponse> {
    let mut params: Vec<(&str, String)> = vec![
        ("artist_name", track.artist.clone()),
        ("track_name", track.title.clone()),
    ];
    if let Some(album) = track.album.as_ref().filter(|a| !a.trim().is_empty()) {
        params.push(("album_name", album.clone()));
    }
    if let Some(d) = track.duration_seconds {
        params.push(("duration", d.to_string()));
    }
    // Short timeout for the probe path.
    let resp = tokio::time::timeout(PROBE_LRCLIB_TIMEOUT, async {
        http.get("https://lrclib.net/api/get").query(&params).send().await.ok()
    })
    .await
    .ok()??;
    if !resp.status().is_success() {
        return None;
    }
    let json: Value = resp.json().await.ok()?;
    parse_lrclib_entry(&json, track)
}

// ---------------------------------------------------------------------------
// Vocal-onset offset — light DSP alternative to a singing-voice model
// ---------------------------------------------------------------------------

/// Hash of the first few lyric lines — stable key for the offset cache.
/// Only the textual content matters; timestamps don't affect identity.
pub fn lyrics_content_hash(lyrics: &SyncedLyricsResponse) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for line in lyrics.lines.iter().take(5) {
        line.text.trim().to_lowercase().hash(&mut hasher);
    }
    (lyrics.lines.len() as u64).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn offset_cache_key(video_id: &str) -> String {
    format!("lyrics-offset-v2-{video_id}")
}

/// Decide whether a detected vocal onset warrants shifting third-party LRC.
/// Conservative: only shifts when intro is clearly instrumental and detection
/// is confident. Returns signed offset to ADD to lyrics timestamps.
pub fn compute_vocal_offset(
    first_lyric_ms: u32,
    vocal_onset_ms: u32,
    leading_silence_ms: u32,
) -> Option<(i32, f32, String)> {
    // Vocal onset is measured from file start (0). Leading silence already
    // accounts for digital blank; vocal onset should be >= leading silence.
    let effective_vocal = vocal_onset_ms.saturating_sub(leading_silence_ms);
    let effective_lyric = first_lyric_ms;
    let delta = effective_vocal as i32 - effective_lyric as i32;
    let abs_delta = delta.abs() as u32;

    // Ignore tiny misalignments the user won't perceive; also cap absurd shifts.
    // Allow larger delta for intro case (early lyric, late vocal) — intros can be 10-12s.
    if abs_delta < 700 || abs_delta > 15000 {
        return None;
    }

    let confidence: f32;
    let method;

    if first_lyric_ms <= 3000 && vocal_onset_ms >= 8000 && delta > 0 {
        // Early lyric but late vocal — classic intro case
        confidence = 0.88;
        method = "vocal_onset_intro".to_string();
    } else if delta > 0 && abs_delta >= 1200 {
        confidence = 0.72;
        method = "vocal_onset_late".to_string();
    } else if delta < 0 && abs_delta >= 1000 {
        // Lyrics lag vocals — less common, lower confidence
        confidence = 0.60;
        method = "vocal_onset_early".to_string();
    } else {
        method = "vocal_onset".to_string();
        confidence = 0.55;
    }

    if confidence < 0.55 {
        return None;
    }

    // Clamp to safe range so a bad detection never jumps lyrics off-screen.
    let clamped = delta.clamp(-4000, 8000);
    Some((clamped, confidence, method))
}

/// Light DSP vocal onset: decode first 45s to 16kHz mono f32le and look for
/// the first sustained energy plateau. No ML — ~80% accurate on pop/rock,
/// conservative gating in `compute_vocal_offset` avoids wrong shifts.
pub async fn detect_vocal_onset_ms(app: &AppHandle, file_path: &str) -> Option<u32> {
    let ffmpeg = crate::resolve_ffmpeg(app).await?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-t",
        &format!("{:.1}", VOCAL_ANALYSIS_SECONDS),
        "-i",
        file_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        &VOCAL_SAMPLE_RATE.to_string(),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    cmd.kill_on_drop(true);

    let child = cmd.spawn().ok()?;
    let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let pcm_bytes = output.stdout;
    if pcm_bytes.len() < (VOCAL_SAMPLE_RATE as usize * 2 * 4) {
        return None; // too short
    }
    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    detect_vocal_onset_from_samples(&samples, VOCAL_SAMPLE_RATE)
}

fn detect_vocal_onset_from_samples(samples: &[f32], sample_rate: u32) -> Option<u32> {
    let window = (sample_rate * VOCAL_WINDOW_MS / 1000) as usize;
    let hop = (sample_rate * VOCAL_HOP_MS / 1000) as usize;
    if window == 0 || hop == 0 || samples.len() < window {
        return None;
    }
    let mut rms_db: Vec<f32> = Vec::new();
    let mut idx = 0usize;
    while idx + window <= samples.len() {
        let sum_sq: f64 = samples[idx..idx + window]
            .iter()
            .map(|s| (*s as f64) * (*s as f64))
            .sum();
        let rms = (sum_sq / window as f64).sqrt();
        let db = if rms < 1e-9 {
            -90.0
        } else {
            20.0 * rms.log10()
        };
        rms_db.push(db as f32);
        idx += hop;
    }
    if rms_db.len() < 50 {
        return None;
    }
    // Noise floor = 10th percentile
    let mut sorted = rms_db.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p10_idx = sorted.len() / 10;
    let noise_floor = sorted[p10_idx] as f64;
    let thresh_db = (noise_floor + VOCAL_ONSET_DB_ABOVE_FLOOR).max(VOCAL_ABSOLUTE_FLOOR_DB);
    let sustain_windows = (VOCAL_MIN_SUSTAIN_MS / VOCAL_HOP_MS) as usize;
    let phrase_windows = (VOCAL_MIN_PHRASE_MS / VOCAL_HOP_MS) as usize;

    for start in 0..rms_db.len().saturating_sub(sustain_windows + phrase_windows) {
        let mut ok = true;
        for w in 0..sustain_windows {
            if (rms_db[start + w] as f64) < thresh_db {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }
        // Check phrase sustain: average of next phrase_windows stays above thresh-2dB
        let avg: f64 = rms_db[start..start + phrase_windows]
            .iter()
            .map(|v| *v as f64)
            .sum::<f64>()
            / phrase_windows as f64;
        if avg < thresh_db - 2.0 {
            continue;
        }
        // Also ensure variance is not huge (reject transient drum burst that decays)
        let var: f64 = rms_db[start..start + phrase_windows]
            .iter()
            .map(|v| {
                let d = *v as f64 - avg;
                d * d
            })
            .sum::<f64>()
            / phrase_windows as f64;
        if var > 80.0 {
            continue;
        }
        let onset_ms = (start as u32) * VOCAL_HOP_MS;
        // Ignore onsets in first 400ms — often click/pop
        if onset_ms < 400 {
            continue;
        }
        return Some(onset_ms);
    }
    None
}

pub fn apply_vocal_offset(mut lyrics: SyncedLyricsResponse, offset_ms: i32) -> SyncedLyricsResponse {
    if offset_ms == 0 {
        return lyrics;
    }
    for line in &mut lyrics.lines {
        let new_start = (line.start_time_ms as i32 + offset_ms).max(0) as u32;
        line.start_time_ms = new_start;
        line.id = new_start;
        if let Some(end) = line.end_time_ms {
            let new_end = (end as i32 + offset_ms).max(0) as u32;
            line.end_time_ms = Some(new_end);
        }
        if let Some(words) = line.words.as_mut() {
            for word in words {
                word.start_time_ms = (word.start_time_ms as i32 + offset_ms).max(0) as u32;
                word.end_time_ms = (word.end_time_ms as i32 + offset_ms).max(0) as u32;
            }
        }
    }
    lyrics.applied_offset_ms = Some(offset_ms);
    lyrics
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
        applied_offset_ms: None,
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

    #[test]
    fn compute_vocal_offset_intro_case() {
        // Early lyric (1s) but vocal at 12s — classic intro, should offset +11s clamped to 8s
        let result = compute_vocal_offset(1200, 12000, 0);
        assert!(result.is_some());
        let (offset, conf, _) = result.unwrap();
        assert!(offset > 700 && offset <= 8000);
        assert!(conf >= 0.8);
    }

    #[test]
    fn compute_vocal_offset_ignores_small_delta() {
        assert!(compute_vocal_offset(5000, 5400, 0).is_none()); // 400ms < 700 threshold
        assert!(compute_vocal_offset(5000, 5600, 300).is_none()); // 300ms after leading silence
    }

    #[test]
    fn compute_vocal_offset_leading_silence_subtracted() {
        // File has 2s leading silence, vocal at 4s, lyric at 1s → effective vocal 2s, delta 1s
        let result = compute_vocal_offset(1000, 4000, 2000);
        assert!(result.is_some());
        let (offset, _, _) = result.unwrap();
        assert_eq!(offset, 1000);
    }

    #[test]
    fn lyrics_content_hash_stable() {
        let a = SyncedLyricsResponse { lines: vec![TimedLyricLine { id: 0, text: "hello".into(), start_time_ms: 0, end_time_ms: None, words: None }, TimedLyricLine { id: 1000, text: "world".into(), start_time_ms: 1000, end_time_ms: None, words: None }], source: None, has_per_word_sync: None, applied_offset_ms: None };
        let b = SyncedLyricsResponse { lines: vec![TimedLyricLine { id: 5, text: "  Hello ".into(), start_time_ms: 5, end_time_ms: None, words: None }, TimedLyricLine { id: 1005, text: "WORLD".into(), start_time_ms: 1005, end_time_ms: None, words: None }], source: Some("other".into()), has_per_word_sync: Some(true), applied_offset_ms: Some(100) };
        assert_eq!(lyrics_content_hash(&a), lyrics_content_hash(&b));
    }

    #[test]
    fn detect_vocal_onset_from_silence_then_tone() {
        // 5s of near-silence then sustained tone at -20dB should trigger ~5s onset
        let sr = VOCAL_SAMPLE_RATE;
        let silence_len = (sr * 5) as usize;
        let tone_len = (sr * 2) as usize;
        let mut samples = vec![0.0f32; silence_len];
        samples.extend(vec![0.1f32; tone_len]); // -20dB approx
        samples.extend(vec![0.0f32; 1000]);
        let onset = detect_vocal_onset_from_samples(&samples, sr);
        assert!(onset.is_some());
        let ms = onset.unwrap();
        assert!(ms >= 4800 && ms <= 5500, "onset {ms} not in expected 5s window");
    }

    #[test]
    fn detect_vocal_onset_rejects_transient_click() {
        // Single 20ms click should not count as vocal (needs 320ms sustain)
        let sr = VOCAL_SAMPLE_RATE;
        let mut samples = vec![0.0f32; (sr * 3) as usize];
        let click_start = sr as usize; // 1s in
        for i in 0..(sr * 20 / 1000) as usize {
            samples[click_start + i] = 0.5;
        }
        let onset = detect_vocal_onset_from_samples(&samples, sr);
        assert!(onset.is_none() || onset.unwrap() > 4000);
    }

    #[test]
    fn parse_leading_silence_stderr_standard_format() {
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_start: 0\n[Parsed_silencedetect_0 @ 0x123] silence_end: 2.0 | silence_duration: 2.0\n";
        let skip = parse_leading_silence_stderr(stderr);
        // 2.0s - 0.08s preroll = 1.92s = 1920ms
        assert_eq!(skip, Some(1920));
    }

    #[test]
    fn parse_leading_silence_stderr_duration_fallback() {
        // Missing silence_start line, only silence_end with silence_duration
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_end: 1.5 | silence_duration: 1.5\n";
        let skip = parse_leading_silence_stderr(stderr);
        // 1.5s - 0.08s preroll = 1.42s = 1420ms
        assert_eq!(skip, Some(1420));
    }

    #[test]
    fn parse_leading_silence_stderr_with_encoder_priming() {
        // Silence starts at 0.12s (within 0.25s tolerance)
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_start: 0.12\n[Parsed_silencedetect_0 @ 0x123] silence_end: 2.0 | silence_duration: 1.88\n";
        let skip = parse_leading_silence_stderr(stderr);
        // 2.0s - 0.08s preroll = 1.92s = 1920ms
        assert_eq!(skip, Some(1920));
    }

    #[test]
    fn parse_leading_silence_stderr_ignores_mid_track_silence() {
        // Silence starts at 15.0s (not leading)
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_start: 15.0\n[Parsed_silencedetect_0 @ 0x123] silence_end: 18.0 | silence_duration: 3.0\n";
        let skip = parse_leading_silence_stderr(stderr);
        assert_eq!(skip, None);
    }

    #[test]
    fn parse_leading_silence_stderr_rejects_sub_minimum_silence() {
        // 0.3s silence - 0.08s preroll = 0.22s (< 0.35s min skip)
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_start: 0\n[Parsed_silencedetect_0 @ 0x123] silence_end: 0.3 | silence_duration: 0.3\n";
        let skip = parse_leading_silence_stderr(stderr);
        assert_eq!(skip, None);
    }
}