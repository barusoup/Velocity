//! Publish locally stored upload covers to a public HTTPS host so Discord's
//! Rich Presence CDN can fetch the user's dedicated artwork (Discord cannot
//! read Tauri asset URLs or on-disk paths directly).

use base64::Engine as _;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

const UGUU_UPLOAD_URL: &str = "https://uguu.se/upload";
const LITTERBOX_UPLOAD_URL: &str = "https://litterbox.catbox.moe/resources/internals/api.php";
const DISCORD_IMAGE_URL_MAX_LEN: usize = 254;
const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default, Serialize, Deserialize)]
struct CoverPublishCache {
    entries: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct UguuUploadResponse {
    files: Vec<UguuUploadedFile>,
}

#[derive(Debug, Deserialize)]
struct UguuUploadedFile {
    url: String,
}

static MEMORY_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// When `cover_ref` points at local upload artwork, upload (or reuse cache)
/// and return a public `https://` URL. Returns `None` for remote URLs or
/// when publishing fails.
pub fn publish_local_cover_for_discord(app: &AppHandle, cover_ref: &str) -> Option<String> {
    let (bytes, file_name, mime) = read_cover_bytes(cover_ref)?;
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return None;
    }

    let hash = md5_hex(&bytes);
    if let Ok(memory) = MEMORY_CACHE.lock() {
        if let Some(url) = memory.get(&hash) {
            return Some(url.clone());
        }
    }

    let mut cache = load_cache(app);
    if let Some(url) = cache.entries.get(&hash) {
        remember_in_memory(&hash, url);
        return Some(url.clone());
    }

    let url = publish_cover_bytes(&bytes, &file_name, mime)?;
    cache.entries.insert(hash.clone(), url.clone());
    let _ = save_cache(app, &cache);
    remember_in_memory(&hash, &url);
    Some(url)
}

fn remember_in_memory(hash: &str, url: &str) {
    if let Ok(mut memory) = MEMORY_CACHE.lock() {
        memory.insert(hash.to_string(), url.to_string());
    }
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data folder: {error}"))?;
    Ok(root.join("discord-published-covers.json"))
}

fn load_cache(app: &AppHandle) -> CoverPublishCache {
    let path = match cache_path(app) {
        Ok(path) => path,
        Err(_) => return CoverPublishCache::default(),
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return CoverPublishCache::default();
    };
    let mut cache: CoverPublishCache = serde_json::from_str(&raw).unwrap_or_default();
    // Catbox uploads were disabled upstream; litterbox links expire. Drop those
    // entries so the next play re-publishes through the current host(s).
    cache.entries.retain(|_, url| !url.contains("catbox.moe"));
    cache
}

fn save_cache(app: &AppHandle, cache: &CoverPublishCache) -> Result<(), String> {
    let path = cache_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create cache folder: {error}"))?;
    }
    let encoded = serde_json::to_string_pretty(cache)
        .map_err(|error| format!("Failed to encode cover cache: {error}"))?;
    fs::write(path, encoded).map_err(|error| format!("Failed to write cover cache: {error}"))
}

fn md5_hex(bytes: &[u8]) -> String {
    let digest = Md5::digest(bytes);
    format!("{digest:x}")
}

fn read_cover_bytes(cover_ref: &str) -> Option<(Vec<u8>, String, &'static str)> {
    if let Some(bytes) = parse_data_cover(cover_ref) {
        return Some((bytes, "cover.jpg".to_string(), "image/jpeg"));
    }

    let path = parse_local_cover_path(cover_ref)?;
    let bytes = fs::read(&path).ok()?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cover.jpg")
        .to_string();
    let mime = image_mime(&path)?;
    Some((bytes, file_name, mime))
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn parse_data_cover(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (meta, encoded) = rest.split_once(',')?;
    if !meta.contains(";base64") {
        return None;
    }
    let mime = meta.split(';').next()?;
    if !mime.starts_with("image/") {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
        .filter(|bytes| !bytes.is_empty())
}

fn parse_local_cover_path(raw: &str) -> Option<PathBuf> {
    if let Some(path) = parse_asset_cover_path(raw) {
        return Some(path);
    }

    if raw.contains("://") && !raw.contains("asset.localhost") {
        return None;
    }

    let path = PathBuf::from(raw);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn parse_asset_cover_path(url: &str) -> Option<PathBuf> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let encoded_path = without_query
        .strip_prefix("asset://localhost/")
        .or_else(|| without_query.strip_prefix("asset://"))
        .or_else(|| {
            without_query
                .split_once("asset.localhost/")
                .map(|(_, remainder)| remainder)
        })?;

    let decoded = percent_decode_path(encoded_path)?;
    let path = PathBuf::from(decoded);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn percent_decode_path(encoded: &str) -> Option<String> {
    if let Ok(decoded) = urlencoding::decode(encoded) {
        let candidate = decoded.into_owned();
        if Path::new(&candidate).is_file() {
            return Some(candidate);
        }
    }

    let mut bytes = Vec::with_capacity(encoded.len());
    let mut chars = encoded.chars();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let hi = chars.next()?;
            let lo = chars.next()?;
            bytes.push(u8::from_str_radix(&format!("{hi}{lo}"), 16).ok()?);
        } else if ch.is_ascii() {
            bytes.push(ch as u8);
        } else {
            return None;
        }
    }

    let candidate = String::from_utf8_lossy(&bytes).into_owned();
    if Path::new(&candidate).is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn publish_cover_bytes(bytes: &[u8], file_name: &str, mime: &str) -> Option<String> {
    upload_to_uguu(bytes, file_name, mime).or_else(|| upload_to_litterbox(bytes, file_name, mime))
}

fn upload_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()
}

fn is_discord_safe_image_url(url: &str) -> bool {
    url.starts_with("https://") && url.len() <= DISCORD_IMAGE_URL_MAX_LEN
}

fn upload_to_uguu(bytes: &[u8], file_name: &str, mime: &str) -> Option<String> {
    let client = upload_client()?;
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str(mime)
        .ok()?;
    let form = reqwest::blocking::multipart::Form::new().part("files[]", part);

    let response = client.post(UGUU_UPLOAD_URL).multipart(form).send().ok()?;
    if !response.status().is_success() {
        return None;
    }

    let payload: UguuUploadResponse = response.json().ok()?;
    let url = payload.files.first()?.url.trim().to_string();
    if is_discord_safe_image_url(&url) {
        Some(url)
    } else {
        None
    }
}

fn upload_to_litterbox(bytes: &[u8], file_name: &str, mime: &str) -> Option<String> {
    let client = upload_client()?;
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str(mime)
        .ok()?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("reqtype", "fileupload")
        .text("time", "24h")
        .part("fileToUpload", part);

    let response = client
        .post(LITTERBOX_UPLOAD_URL)
        .multipart(form)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let url = response.text().ok()?.trim().to_string();
    if is_discord_safe_image_url(&url) {
        Some(url)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_asset_localhost_cover_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cover = dir.path().join("cover.jpg");
        fs::write(&cover, b"fake-jpeg").expect("write cover");
        let cover_string = cover.to_string_lossy().into_owned();
        let encoded = urlencoding::encode(&cover_string);
        let url = format!("http://asset.localhost/{encoded}");
        assert_eq!(parse_asset_cover_path(&url), Some(cover));
    }

    #[test]
    fn parses_raw_windows_cover_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cover = dir.path().join("cover.jpg");
        fs::write(&cover, b"fake-jpeg").expect("write cover");
        assert_eq!(
            parse_local_cover_path(&cover.to_string_lossy()),
            Some(cover),
        );
    }

    #[test]
    fn rejects_remote_urls_as_local_paths() {
        assert_eq!(
            parse_local_cover_path("https://i.ytimg.com/vi/abc/hqdefault.jpg"),
            None,
        );
    }
}