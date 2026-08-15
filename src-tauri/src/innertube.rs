use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_LANGUAGE, ORIGIN, REFERER};
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
pub const CLIENT_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 6);
/// Backoff (ms) between retries of a rate-limited (HTTP 429) API call.
/// Short on purpose: anonymous YouTube Music clients get 429'd constantly,
/// and a 600ms/1.8s pause absorbs the burst without making things worse.
const RATE_LIMIT_RETRY_DELAYS_MS: [u64; 2] = [600, 1_800];

pub static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
});

pub static HTTP_NO_REDIRECT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client no-redirect")
});

pub static API_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""INNERTUBE_API_KEY":"([^"]+)""#).expect("api key regex"));
pub static CLIENT_VERSION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#""INNERTUBE_CLIENT_VERSION":"([^"]+)""#).expect("client version regex")
});
pub static VISITOR_DATA_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""VISITOR_DATA":"([^"]+)""#).expect("visitor data regex"));

// Extract the `list` query parameter from a YT Music playlist URL. Used
// to seed the InnerTube `next` call (which needs both a videoId and a
// playlistId to return the full queue) and to build the browseId for the
// playlist header (browseId = "VL" + playlistId).
pub static YT_PLAYLIST_ID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"[?&]list=([A-Za-z0-9_-]+)"#).expect("yt playlist id regex")
});

pub(crate) struct InnerTubeConfig {
    pub(crate) api_key: String,
    pub(crate) client_version: String,
    pub(crate) visitor_data: String,
    pub(crate) fetched_at: Instant,
}

/// Look up (or fetch and cache) the InnerTube client config scraped from the
/// YouTube Music shell page. Shared by every `post_ytmusic*` helper so a
/// single fetch powers all requests for up to `CLIENT_CACHE_TTL`.
pub(crate) async fn get_client_config(
    config_cache: &Mutex<Option<InnerTubeConfig>>,
) -> Result<InnerTubeConfig, String> {
    {
        let cache = config_cache.lock().await;
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

    let mut cache = config_cache.lock().await;
    *cache = Some(InnerTubeConfig {
        api_key: config.api_key.clone(),
        client_version: config.client_version.clone(),
        visitor_data: config.visitor_data.clone(),
        fetched_at: config.fetched_at,
    });

    Ok(config)
}

pub(crate) async fn post_ytmusic(
    config_cache: &Mutex<Option<InnerTubeConfig>>,
    endpoint: &str,
    payload: Value,
) -> Result<Value, String> {
    let config = get_client_config(config_cache).await?;
    post_ytmusic_with_client(
        config_cache,
        endpoint,
        payload,
        "WEB_REMIX",
        &config.client_version,
        None,
    )
    .await
}

pub(crate) async fn post_ytmusic_continuation(
    config_cache: &Mutex<Option<InnerTubeConfig>>,
    token: &str,
) -> Result<Value, String> {
    let config = get_client_config(config_cache).await?;
    let encoded = urlencoding::encode(token);
    let query_suffix = format!("&ctoken={encoded}&continuation={encoded}");
    let with_query = post_ytmusic_with_client(
        config_cache,
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
        config_cache,
        "browse",
        json!({ "continuation": token }),
        "WEB_REMIX",
        &config.client_version,
        None,
    )
    .await
}

pub(crate) async fn post_ytmusic_with_client(
    config_cache: &Mutex<Option<InnerTubeConfig>>,
    endpoint: &str,
    payload: Value,
    client_name: &str,
    client_version: &str,
    query_suffix: Option<&str>,
) -> Result<Value, String> {
    let config = get_client_config(config_cache).await?;
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

    // Transient 429s (anonymous clients get rate-limited constantly, and the
    // app can burst a few requests at once around playlist/queue loads) used
    // to fail the whole call with a raw "HTTP 429" the UI had to surface.
    // A short bounded backoff absorbs the burst without hammering the API.
    let mut attempt = 0;
    loop {
        let response = HTTP
            .post(&url)
            .headers(headers.clone())
            .json(&Value::Object(body.clone()))
            .send()
            .await
            .map_err(|error| format!("YouTube Music request failed: {error}"))?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
            && attempt < RATE_LIMIT_RETRY_DELAYS_MS.len()
        {
            tokio::time::sleep(Duration::from_millis(RATE_LIMIT_RETRY_DELAYS_MS[attempt])).await;
            attempt += 1;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("YouTube Music returned HTTP {}", response.status()));
        }

        return response
            .json::<Value>()
            .await
            .map_err(|error| format!("Failed to decode YouTube Music response: {error}"));
    }
}

/// Build the `next` request payload that seeds the watch-playlist queue for a
/// given video. The default `playlistId` uses the auto-generated `RDAMVM<id>`
/// playlist (YouTube's "watch next" radio); a real playlist id overrides it.
pub(crate) fn watch_next_payload(video_id: &str, playlist_id: Option<&str>) -> Value {
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

/// Pull the `continuationItems` out of a `browse` continuation response,
/// whether they arrive as an `appendContinuationItemsAction` or a
/// `musicShelfContinuation`/`musicPlaylistShelfContinuation` block.
pub(crate) fn parse_shelf_continuation_items(response: &Value) -> Option<Vec<Value>> {
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

/// Look for a `MUSIC_PAGE_TYPE_TRACK_LYRICS` tab in a `next` response and
/// return its browse id. This is a *presence* signal only — the lyrics tab
/// existing tells the UI the song has lyrics (so the fast probe can report
/// "available" and skip the long timeout), without ever fetching or serving
/// YouTube Music's native timed lyrics (which are intentionally not used).
pub(crate) fn extract_lyrics_browse_id_from_next(response: &Value) -> Option<String> {
    let tabs = response
        .pointer(
            "/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs",
        )
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
            .pointer(
                "/tabRenderer/endpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType",
            )
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

const PREFERRED_THUMBNAIL_WIDTH: u64 = 640;
const ARTIST_AVATAR_SIZE: u64 = 640;
const ARTIST_BANNER_WIDTH: u64 = 2880;
const ARTIST_BANNER_HEIGHT: u64 = 1200;

pub(crate) fn best_thumbnail(value: &Value) -> Option<String> {
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

pub(crate) fn best_banner_thumbnail(value: &Value) -> Option<String> {
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

pub(crate) fn square_artist_thumbnail_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return square_artist_thumbnail_base(url);
    };
    format!("{}?{query}", square_artist_thumbnail_base(base))
}

pub(crate) fn banner_artist_thumbnail_url(url: &str) -> String {
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

pub(crate) fn as_str_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    get_path(value, path).and_then(Value::as_str)
}

pub(crate) fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

pub(crate) fn text_from_value(value: &Value) -> Option<String> {
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

pub(crate) fn is_excluded_type_label(label: &str) -> bool {
    matches!(
        label.trim().to_ascii_lowercase().as_str(),
        "episode" | "podcast" | "mix"
    )
}

pub static MUSIC_VIDEO_TITLE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:\(|\[)?(?:official\s+)?music\s+video(?:\)|\])?\s*$|(?:\(|\[)?official\s+video(?:\)|\])?\s*$|\(mv\)\s*$|\[mv\]\s*$"#,
    )
    .expect("music video title regex")
});

/// Whether a title explicitly names a music video ("Song (Official Music
/// Video)", "Song (MV)", ...). These rows are really `video`-type media even
/// when YouTube Music omits the "Video" label that would otherwise classify
/// them, so the search parser reclassifies them to keep them out of the
/// "song" pool that drives search results, autoplay substitution, and
/// studio-audio resolution.
pub(crate) fn is_explicit_music_video_title(title: &str) -> bool {
    MUSIC_VIDEO_TITLE_RE.is_match(title)
}

pub static VIEWS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bviews?\b").expect("views regex"));
pub static PLAYS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bplays?\b").expect("plays regex"));

/// Whether a row's raw metadata shows a VIEW count ("1.2M views") rather than
/// a PLAY count ("251M plays"). YouTube Music labels true songs with plays and
/// music videos with views, so a song-kind row carrying a view count is really
/// a music video — this is the only reliable signal for mislabeled videos.
pub(crate) fn text_indicates_video(text: &str) -> bool {
    VIEWS_RE.is_match(text) && !PLAYS_RE.is_match(text)
}

pub(crate) fn normalize_kind(label: Option<&str>, has_browse: bool, has_video: bool) -> String {
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

pub(crate) fn normalize_bullet_text(value: &str) -> String {
    value
        .replace("â€¢", "\u{2022}")
        .replace("Ã¢â‚¬Â¢", "\u{2022}")
        .replace("ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢", "\u{2022}")
}

pub(crate) fn split_bullets_fixed(value: &str) -> Vec<String> {
    value
        .replace("â€¢", "\u{2022}")
        .replace("Ã¢â‚¬Â¢", "\u{2022}")
        .split('\u{2022}')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn is_type_label(value: &str) -> bool {
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

pub(crate) fn looks_like_non_artist_meta(value: &str) -> bool {
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

pub(crate) fn fallback_artist_from_meta(meta_parts: &[String], has_type_label: bool) -> Option<String> {
    meta_parts
        .iter()
        .skip(usize::from(has_type_label))
        .find(|part| !looks_like_non_artist_meta(part))
        .cloned()
}

pub(crate) fn parse_duration(value: &str) -> Option<u32> {
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

pub(crate) fn parse_duration_from_text(value: &str) -> Option<u32> {
    parse_duration(value).or_else(|| {
        split_bullets_fixed(value)
            .into_iter()
            .rev()
            .find_map(|part| parse_duration(&part))
    })
}

pub(crate) fn fixed_column_texts(row: &Value) -> Vec<String> {
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

pub(crate) fn flex_column_texts(row: &Value) -> Vec<String> {
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

pub(crate) fn extract_duration_from_row(row: &Value) -> Option<u32> {
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

pub(crate) fn parse_play_count_candidate(value: &str) -> Option<String> {
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

pub(crate) fn extract_play_count_from_text(value: &str) -> Option<String> {
    split_bullets_fixed(value)
        .into_iter()
        .find_map(|part| parse_play_count_candidate(&part))
        .or_else(|| parse_play_count_candidate(value))
}

pub(crate) fn extract_play_count_from_row(row: &Value) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shelf_continuation_items_reads_append_action() {
        let response = json!({
            "onResponseReceivedActions": [
                {
                    "appendContinuationItemsAction": {
                        "continuationItems": [{ "item": 1 }, { "item": 2 }]
                    }
                }
            ]
        });

        let items = parse_shelf_continuation_items(&response).expect("items");
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn parse_shelf_continuation_items_reads_music_shelf_continuation() {
        let response = json!({
            "continuationContents": {
                "musicShelfContinuation": {
                    "contents": [{ "item": 1 }, { "item": 2 }, { "item": 3 }]
                }
            }
        });

        let items = parse_shelf_continuation_items(&response).expect("items");
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn parse_shelf_continuation_items_reads_music_playlist_shelf_continuation() {
        let response = json!({
            "continuationContents": {
                "musicPlaylistShelfContinuation": {
                    "items": [{ "item": 1 }]
                }
            }
        });

        let items = parse_shelf_continuation_items(&response).expect("items");
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn text_from_value_reads_runs_and_simple_text() {
        let runs = json!({ "runs": [{ "text": "A" }, { "text": "B" }] });
        assert_eq!(text_from_value(&runs).as_deref(), Some("AB"));
        let simple = json!({ "simpleText": "hello" });
        assert_eq!(text_from_value(&simple).as_deref(), Some("hello"));
        assert_eq!(text_from_value(&json!("plain")), Some("plain".to_string()));
    }

    #[test]
    fn parse_duration_reads_mm_ss_and_hh_mm_ss() {
        assert_eq!(parse_duration("5:00"), Some(300));
        assert_eq!(parse_duration("1:02:30"), Some(3750));
        assert_eq!(parse_duration("nope"), None);
    }

    #[test]
    fn extract_duration_from_row_prefers_fixed_column_then_length_text() {
        let row = json!({
            "fixedColumns": [{
                "musicResponsiveListItemFixedColumnRenderer": {
                    "text": { "runs": [{ "text": "5:00" }] }
                }
            }],
            "lengthText": { "simpleText": "3:45" }
        });
        assert_eq!(extract_duration_from_row(&row), Some(300));

        let only_length = json!({ "lengthText": { "simpleText": "3:45" } });
        assert_eq!(extract_duration_from_row(&only_length), Some(225));
    }

    #[test]
    fn extract_play_count_from_row_reads_play_count_text() {
        let row = json!({ "playCountText": { "simpleText": "176M plays" } });
        assert_eq!(extract_play_count_from_row(&row).as_deref(), Some("176M"));
    }

    #[test]
    fn normalize_kind_maps_labels_and_fallbacks() {
        assert_eq!(normalize_kind(Some("song"), true, true), "song");
        assert_eq!(normalize_kind(Some("single"), true, true), "album");
        assert_eq!(normalize_kind(Some("mix"), true, true), "unknown");
        assert_eq!(normalize_kind(None, true, false), "playlist");
        assert_eq!(normalize_kind(None, false, true), "song");
    }

    #[test]
    fn looks_like_non_artist_meta_recognizes_stats() {
        assert!(!looks_like_non_artist_meta("Coldplay"));
        assert!(looks_like_non_artist_meta("2.4M plays"));
        assert!(looks_like_non_artist_meta("2024"));
        assert!(looks_like_non_artist_meta("explicit"));
    }

    #[test]
    fn is_explicit_music_video_title_matches_suffix_markers_only() {
        assert!(is_explicit_music_video_title("Paranoid Android (Official Music Video)"));
        assert!(is_explicit_music_video_title("Creep (Official Video)"));
        assert!(is_explicit_music_video_title("Kill Bill (MV)"));
        assert!(is_explicit_music_video_title("Kill Bill [MV]"));
        assert!(is_explicit_music_video_title("Song (Music Video)"));

        assert!(!is_explicit_music_video_title("Paranoid Android"));
        assert!(!is_explicit_music_video_title("Song (Official Audio)"));
        assert!(!is_explicit_music_video_title("Video Games"));
        assert!(!is_explicit_music_video_title("Music Video Maker"));
    }

    #[test]
    fn text_indicates_video_distinguishes_views_from_plays() {
        assert!(text_indicates_video("Radiohead • 13M views"));
        assert!(text_indicates_video("Song • Artist • 1.2M views"));
        assert!(!text_indicates_video("Song • Radiohead • 251M plays"));
        assert!(!text_indicates_video("Radiohead • 96M plays • 6:17"));
        assert!(!text_indicates_video("Album • Radiohead • 1997"));
        assert!(!text_indicates_video(""));
    }
}
