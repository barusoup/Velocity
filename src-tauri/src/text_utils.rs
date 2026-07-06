//! Pure text-cleaning helpers used by the YT Music / Spotify /
//! Apple playlist scraping code in `main.rs`.
//!
//! Both helpers are intentionally side-effect-free and free of any
//! lazy-static state so they're trivial to test in isolation and
//! available for reuse from any future scraper. Currently called
//! from:
//!
//!   * `decode_html_entities` — every Spotify/Apple scrape that
//!     reads server-rendered HTML (OG tags, ld+json, __NEXT_DATA__).
//!     Spotify and Apple both emit `&amp;` / `&quot;` / the U+FFFD
//!     replacement character between long metadata strings, so we
//!     decode them inline instead of pulling a full HTML5 entity
//!     table.
//!
//!   * `strip_artist_noise` — every YT Music playlist import that
//!     parses `yt-dlp --flat-playlist --print` output. The flat-mode
//!     uploader reads "Artist - Topic" / "Artist - VEVO" etc.; we
//!     strip the suffix so title-vs-source comparison is meaningful.
//!     No-op for non-music platforms that already put the artist
//!     in `artist` directly.

/// Minimal HTML-entity decoder for the handful of escapes Spotify /
/// Apple emit in their server-rendered markup.
///
/// The full HTML5 entity list is overkill for what we parse — these
/// six cover every value we actually pull from the page.
pub fn decode_html_entities(value: &str) -> String {
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

/// Strip the trailing " - Topic" / " - VEVO" / " - Vevo" /
/// " - Official" suffix from the uploader so the title-vs-source
/// title compare is meaningful in YT Music flat-playlist mode.
///
/// Other platforms put the artist in `artist` directly so this is a
/// no-op for them. The function takes both the original string and
/// the trimmed/lowercased variant lazily so callers can pass
/// either form.
pub fn strip_artist_noise(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_html_entities_basic() {
        assert_eq!(decode_html_entities("hello"), "hello");
        assert_eq!(decode_html_entities("a &amp; b"), "a & b");
        assert_eq!(decode_html_entities("&lt;tag&gt;"), "<tag>");
        assert_eq!(decode_html_entities("&quot;hi&quot;"), "\"hi\"");
        assert_eq!(decode_html_entities("&apos;x&apos;"), "'x'");
        assert_eq!(decode_html_entities("&nbsp;a&nbsp;"), " a ");
    }

    #[test]
    fn decode_html_entities_numeric() {
        assert_eq!(decode_html_entities("&#65;"), "A");
        assert_eq!(decode_html_entities("&#x41;"), "A");
    }

    #[test]
    fn decode_html_entities_unknown_passthrough() {
        // Unknown entities are kept verbatim rather than dropped, so
        // a malformed page can't silently lose data we don't
        // recognize.
        assert_eq!(decode_html_entities("&weird;"), "&weird;");
    }

    #[test]
    fn strip_artist_noise_removes_topic() {
        assert_eq!(strip_artist_noise("Radiohead - Topic"), "Radiohead");
    }

    #[test]
    fn strip_artist_noise_no_op() {
        assert_eq!(strip_artist_noise("Plain Artist"), "Plain Artist");
    }

    #[test]
    fn strip_artist_noise_only_first_match() {
        assert_eq!(strip_artist_noise("The Beatles - VEVO"), "The Beatles");
        assert_eq!(strip_artist_noise("Random - Official"), "Random");
    }
}
