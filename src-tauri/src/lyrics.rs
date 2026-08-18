//! Synced-lyrics resolution: LRCLIB matching and playback alignment for stream tracks.
//!
//! LRCLIB is the single lyric provider queried for synced lyrics.
//! Regional fallbacks (Kugou, QQ, NetEase) and legacy providers (Musixmatch)
//! are intentionally excluded.

use std::time::Duration;

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

const LRCLIB_SOURCE: &str = "Lyrics from LRCLIB";

/// Fast probe — how long Tier-0 is allowed before we report "unknown".
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
const PROBE_LRCLIB_TIMEOUT: Duration = Duration::from_millis(900);

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

#[derive(Clone)]
pub struct LyricTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_seconds: Option<u32>,
}

/// Optional playback context for synced-lyrics resolution. Kept as
/// plumbing (empty) since no playback offset is applied anymore.
pub struct LyricsResolveContext {}

// ---------------------------------------------------------------------------
// Dependencies injected from `main.rs` (InnerTube + app paths)
// ---------------------------------------------------------------------------

pub struct LyricsDeps<'a> {
    pub http: &'a Client,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn resolve_synced_lyrics(
    deps: &LyricsDeps<'_>,
    meta: &LyricTrack,
    ctx: &LyricsResolveContext,
) -> Option<SyncedLyricsResponse> {
    // Only query LRCLIB for synced lyrics.
    let lyrics = fetch_lrclib_lyrics(deps.http, meta).await?;
    let score = score_candidate(&lyrics, meta, 25, true);
    if score >= 45 {
        Some(finalize_third_party_lyrics(lyrics, ctx))
    } else {
        None
    }
}

fn finalize_third_party_lyrics(
    lyrics: SyncedLyricsResponse,
    _ctx: &LyricsResolveContext,
) -> SyncedLyricsResponse {
    // Silence is physically trimmed from the audio file (atrim re-encode)
    // so the file starts at 0:00 where the music begins. Third-party LRC
    // (LRCLIB) is authored for the studio master (no leading silence), so
    // it must NOT be shifted. Leave lyrics as-is.
    lyrics
}

pub async fn build_resolve_context(
    _app: &AppHandle,
    _stream_cache: &Mutex<crate::cache::TtlCache<String, crate::CachedStream>>,
    _stream_cache_ttl: Duration,
    _video_id: Option<&str>,
) -> LyricsResolveContext {
    // No playback offset is applied to third-party lyrics anymore: silence is
    // physically trimmed from the audio file (atrim re-encode) and vocal-onset
    // correction was removed, so the context carries nothing today.
    LyricsResolveContext {}
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
    })
}

// ---------------------------------------------------------------------------
// Leading silence (align third-party lyrics with stream playback position)
// ---------------------------------------------------------------------------

pub(crate) fn parse_leading_silence_stderr(stderr: &str) -> Option<u32> {
    const MIN_SKIP_SECONDS: f64 = 0.35;
    const MAX_SKIP_SECONDS: f64 = 8.0;
    const LEADING_SILENCE_START_TOLERANCE: f64 = 0.5;
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
                    let with_preroll = (end - SILENCE_END_PREROLL).max(0.0);
                    if with_preroll >= MIN_SKIP_SECONDS {
                        leading_skip = Some(end);
                        break;
                    }
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
) -> LyricsAvailability {
    let lrclib_res =
        tokio::time::timeout(PROBE_TIMEOUT, fetch_lrclib_get_fast(deps.http, meta)).await;
    if let Ok(Some(lyrics)) = lrclib_res {
        if lyrics.lines.len() >= 2 {
            return LyricsAvailability {
                available: true,
                confidence: 0.95,
                source: Some(LRCLIB_SOURCE.to_string()),
                first_lyric_ms: lyrics.lines.first().map(|l| l.start_time_ms),
                ytm_has_tab: false,
            };
        }
    }

    LyricsAvailability {
        available: false,
        confidence: 0.35,
        source: None,
        first_lyric_ms: None,
        ytm_has_tab: false,
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

    #[test]
    fn parse_leading_silence_stderr_recovers_from_leading_sub_minimum_gap() {
        // Micro-pause at 0s, followed by genuine 3s leading silence starting within tolerance
        let stderr = "[Parsed_silencedetect_0 @ 0x123] silence_start: 0\n[Parsed_silencedetect_0 @ 0x123] silence_end: 0.3 | silence_duration: 0.3\n[Parsed_silencedetect_0 @ 0x123] silence_start: 0.35\n[Parsed_silencedetect_0 @ 0x123] silence_end: 3.12 | silence_duration: 2.77\n";
        let skip = parse_leading_silence_stderr(stderr);
        // 3.12s - 0.08s preroll = 3.04s = 3040ms
        assert_eq!(skip, Some(3040));
    }
}