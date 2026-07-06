import { cacheArtwork, resolveTrackAlbum, searchMusic } from "../api";
import { toTrack } from "../components/PagesShared";
import type { MediaTrack, SearchItem } from "../types";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ExternalPlaylistTrack } from "../api";

// Cap the active searcher concurrency so a 200-track playlist doesn't
// blast YouTube Music with 200 parallel requests. The number matches
// the chunk-size we use for imported-file durations elsewhere in the
// app — large enough to feel snappy without tripping upstream rate limits.
const MATCH_CONCURRENCY = 4;

// ── String normalization ─────────────────────────────────────────────────
//
// We compare an external (imported) title/artist pair against a YouTube
// Music search candidate. Both sides go through this normalizer first so
// a stray "(feat. ...)", "(Remastered 2011)", " - Topic" suffix, or
// punctuation noise can't sink a real match.
//
// Note: we intentionally KEEP digits, spaces, and Unicode letters
// intact — only drop ASCII punctuation and strip the known noisy
// parentheticals. The result is a whitespace-collapsed lowercase string.
function normalizeForMatching(value: string): string {
  // YTM often appends the same qualifier with a dash instead of parens,
  // e.g. "This fffire - New Version" vs an imported "This fffire (New
  // Version)". The parenthetical strip above catches `(New Version)` but
  // not the dash variant; this final `dashNoise` strip mirrors the same
  // keyword list so both sides collapse to the same root. Note: this also
  // intentionally mirrors the existing risk of the parenthetical list —
  // `(Live)` already collapsed before this round; `- Live` does the same
  // now. That parity is a deliberate consistency call; if a future
  // "imported the live recording instead of the studio" complaint shows
  // up, narrow this list before the parenthetical one.
  return value
    .toLowerCase()
    .replace(/\(.*?(?:feat\.?|featuring|ft\.?|remaster(?:ed)?|remix|live|version|edit|mono|stereo|deluxe).*?\)/gi, "")
    .replace(/\[[^\]]*?(?:feat\.?|ft\.?|remaster(?:ed)?|remix|live).*?\]/gi, "")
    .replace(/\s*-\s*(?:feat|ft)\.?\s+.*$/i, "")
    .replace(
      /\s*-\s+(?:new\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|remix|live(?:\s+(?:at|version))?|mono|stereo|deluxe(?:\s+edition)?|edit(?:ion)?|version|recording|original(?:\s+mix)?|extended(?:\s+(?:mix|version))?|radio(?:\s+edit)?|clean|explicit|instrumental|acapella|album\s+version|single(?:\s+version)?|bonus\s+track|remaster)\b.*$/i,
      "",
    )
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true only on near-exact post-normalization equality.
//
// The user explicitly asked us NOT to match approximately when an exact
// match isn't available, because naive substring matches are dangerous
// ("Run" by AWOLNATION should not match "Running Up That Hill"). The
// normalizer already strips the YTM-specific noise (parenthetical
// "(Remastered 2011)", appended " - Topic" tails, embedded artists,
// punctuation), so most real candidates collapse to the exact same
// string. Anything that doesn't should be dropped — the user can paste
// the missing track into the playlist manually if they really want it.
function looksLikeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b;
}

function pickCandidateArtist(item: SearchItem): string {
  const direct = item.artist?.trim();
  if (direct) return direct;
  // Tiny fallback for items that bury the artist in the subtitle —
  // split on the bullet character (U+2022) that YTM uses. This should
  // be rare for `kind === "song"` results, which always carry a
  // resolved artist, but doesn't hurt as belt-and-braces.
  const parts = item.subtitle.split(/\s*\u2022\s*/).map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (["song", "video", "single", "ep", "album", "playlist"].includes(lower)) continue;
    return part;
  }
  return "";
}

// Look up a single external track on YouTube Music and return the
// closest song-kind match. Returns `null` rather than an empty array so
// the caller doesn't have to disambiguate "no candidates" from "no
// match" — both should drop the track from the imported playlist.
export async function matchExternalTrackToYTM(
  external: ExternalPlaylistTrack,
): Promise<MediaTrack | null> {
  const query = `${external.title} ${external.artist}`.trim();
  if (!query) return null;

  let response;
  try {
    response = await searchMusic(query);
  } catch {
    return null;
  }

  // Concatenate the top result + the listed results; filter down to
  // `kind === "song"` so MVs and lyric videos can't sneak through.
  const candidates = [response.topResult, ...response.results].filter(
    (item): item is SearchItem => Boolean(item && item.kind === "song" && item.videoId),
  );

  const targetTitle = normalizeForMatching(external.title);
  const targetArtist = normalizeForMatching(external.artist);
  // YT Music playlists served via `--flat-playlist` resolve the
  // per-track uploader field to "NA" server-side, and our Rust
  // importer maps that to an empty artist. Don't gate on
  // `!targetArtist` here — the lenient topResult fallback below
  // checks `topArtist.includes("")` which is true for empty
  // ``targetArtist`` and rescues the track. The previous gate
  // short-circuited before the fallback ever ran, dropping every
  // YT Music import to zero matches (the "playlists fail to load"
  // user-visible symptom). Empty ``targetTitle`` is still a hard
  // reject — there's nothing meaningful to look up.
  if (!targetTitle) return null;

  // Strict equality pass. This remains the preferred path because it
  // refuses near-misses that substring matching would tolerate (e.g.
  // "Run" matching "Running Up That Hill").
  let match: MediaTrack | null = null;
  for (const candidate of candidates) {
    const candidateTitle = normalizeForMatching(candidate.title);
    const candidateArtist = normalizeForMatching(pickCandidateArtist(candidate));
    if (!candidateTitle || !candidateArtist) continue;
    if (looksLikeMatch(targetTitle, candidateTitle) && looksLikeMatch(targetArtist, candidateArtist)) {
      match = toTrack(candidate);
      if (match) break;
    }
  }

  // Lenient fallback against only the topResult. YouTube Music's topResult
  // for "Title Artist" queries is extremely reliable even when the search
  // result carries a slightly different surface form (e.g. "X (Remastered
  // 2011)" vs. "X", "&" vs. "and", a stray " - Topic" tail). Accepting it
  // here reclaims tracks that the strict pass drops because of that kind
  // of cosmetic noise — the user reported "one of the songs always fails
  // to import despite literally being the first search result". We cap
  // the leniency to candidates[0] so lower-ranked results can't sneak in
  // as a wrong match, AND require the shorter of the two titles to be at
  // least half the longer's length so a short external title can't be
  // substring-matched against a same-artist longer title (e.g. "Run" by
  // Kate Bush falsely hitting "Running Up That Hill" by Kate Bush). The
  // 50%-overlap substring rule below is also gated: when ``targetArtist``
  // is empty (the YT Music flat-playlist-rescued case) we instead
  // require strict title equality so a generic title like "Hello" can't
  // land on the wrong artist's topResult.
  if (!match) {
    const top = candidates[0];
    if (top) {
      const topTitle = normalizeForMatching(top.title);
      const topArtist = normalizeForMatching(pickCandidateArtist(top));
      if (topTitle && topArtist) {
        // Empty `targetArtist` is the YT Music flat-playlist-rescued
        // case: the Rust importer maps the unresolvable "NA" uploader
        // to empty and we can’t verify the artist at all. The
        // standard 50%-overlap substring rule is too permissive here
        // — a short generic title like "Hello" with no artist
        // would happily rescue onto the wrong topResult. Require
        // STRICT title equality whenever the target artist is empty so
        // the rescue only fires on unambiguous matches.
        let titleOverlap: boolean;
        if (targetArtist === "") {
          titleOverlap = topTitle === targetTitle;
        } else {
          const minTitleLen = Math.min(topTitle.length, targetTitle.length);
          const maxTitleLen = Math.max(topTitle.length, targetTitle.length);
          titleOverlap =
            topTitle === targetTitle ||
            ((topTitle.includes(targetTitle) || targetTitle.includes(topTitle)) &&
              maxTitleLen > 0 &&
              minTitleLen / maxTitleLen >= 0.5);
        }
        const artistOverlap =
          topArtist === targetArtist ||
          topArtist.includes(targetArtist) ||
          targetArtist.includes(topArtist);
        if (titleOverlap && artistOverlap) {
          match = toTrack(top);
        }
      }
    }
  }

  if (!match) return null;

  // YTM search results frequently omit `durationSeconds` even when the
  // track clearly has one. yt-dlp already extracted the duration for the
  // external track; backfill it here so the duration column populates
  // without forcing the user to listen to the whole song.
  if (match.durationSeconds == null && external.durationSeconds != null) {
    match = { ...match, durationSeconds: external.durationSeconds };
  }

  // YTM search results also frequently omit `albumBrowseId` even when
  // the track has a real album (the structured-byline path doesn't fire
  // for every search hit). Resolve it from the watch-playlist payload so
  // the Album column can hyperlink the song to its album — matching the
  // affordance native tracks have. Best-effort: failures silently fall
  // back to whatever the search result had, so a network hiccup never
  // costs the track.
  //
  // We also call resolveTrackAlbum when the search hit had an
  // `albumBrowseId` but no album *text* (very common — the structured
  // byline carries the album link without an inline album name). Without
  // the second condition the Album column would still show em-dash for
  // tracks whose search result serialized only the browse id, which is
  // most of the imported playlist (the user reports this as "albums aren't
  // loading as they should"). Best-effort: failures silently leave the
  // search's best-effort metadata in place.
  if ((!match.albumBrowseId || !match.album?.trim()) && match.videoId) {
    try {
      const resolution = await resolveTrackAlbum(match.videoId);
      if (resolution.albumBrowseId) {
        match = { ...match, albumBrowseId: resolution.albumBrowseId };
      }
      if (resolution.album && resolution.album !== match.album) {
        match = { ...match, album: resolution.album };
      }
    } catch {
      // search succeeded but the album lookup didn't; leave the search's
      // best-effort metadata in place.
    }
  }

  return match;
}

// Concurrent progress reporter. `concurrency` workers each pull the next
// index from a shared counter so the total pace is bounded but the
// scheduling across worker slots stays simple (no per-worker queue).
// The optional `isCancelled` hook lets the modal bail out mid-flight
// when the user hits Cancel.
type BatchOptions = {
  concurrency?: number;
  isCancelled?: () => boolean;
  onProgress?: (matched: number, checked: number) => void;
};

export async function matchExternalTracksInParallel(
  tracks: ExternalPlaylistTrack[],
  options: BatchOptions = {},
): Promise<Array<MediaTrack | null>> {
  const concurrency = options.concurrency ?? MATCH_CONCURRENCY;
  const results: Array<MediaTrack | null> = new Array(tracks.length).fill(null);
  let matched = 0;
  let checked = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < tracks.length) {
      if (options.isCancelled?.()) return;
      const index = cursor++;
      const match = await matchExternalTrackToYTM(tracks[index]);
      results[index] = match;
      if (match) matched++;
      checked++;
      options.onProgress?.(matched, checked);
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  return results;
}

// ── Cover handling ───────────────────────────────────────────────────────
//
// We need a base64 JPEG data URL to populate `UserPlaylist.cover` (the
// existing storage contract). Three steps:
//
//   1. Hand the source URL to the Rust `cache_artwork` command, which
//      downloads + persists the bytes and returns the local file path.
//   2. Convert the file path to an in-process asset URL we can load
//      into an `<img>` element without CORS taint.
//   3. Render the image into a canvas and re-encode as a JPEG data URL
//      downscaled to 480px to keep `localStorage` usage modest (the
//      same envelope CoverImageCropper uses on upload).
//
// Bypasses the canvas if the cover is already a 480px-square JPEG (a
// common Spotify/YTM case) — but we always re-encode through canvas so
// the final byte format stays consistent regardless of source.
const COVER_MAX_SIDE = 480;
const COVER_JPEG_QUALITY = 0.7;

export async function downloadAndEncodeCover(remoteUrl: string): Promise<string | null> {
  try {
    const filePath = await cacheArtwork(remoteUrl);
    const assetUrl = convertFileSrc(filePath);

    const image = await loadImage(assetUrl);
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = longest > COVER_MAX_SIDE ? COVER_MAX_SIDE / longest : 1;
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    return canvas.toDataURL("image/jpeg", COVER_JPEG_QUALITY);
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode cover image."));
    image.src = src;
  });
}

// Pretty-print service slug for use in the import modal's header.
export function serviceLabel(service: string | null | undefined): string {
  switch (service) {
    case "youtube":
      return "YouTube Music";
    case "spotify":
      return "Spotify";
    case "apple":
      return "Apple Music";
    default:
      return "external";
  }
}
