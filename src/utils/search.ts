import type { ArtistCredit, SearchItem } from "../types";
import { cleanAutoplaySearchTitle, normalizeText, titleLooksLikeMusicVideo } from "./track-titles";

export const PLACEHOLDER_ARTIST = "Unknown artist";

export function isPlaceholderArtist(artist: string | null | undefined): boolean {
  const trimmed = artist?.trim() ?? "";
  return !trimmed || trimmed.toLowerCase() === PLACEHOLDER_ARTIST.toLowerCase();
}

const SEARCH_TYPE_LABELS = new Set([
  "song",
  "artist",
  "album",
  "single",
  "ep",
  "playlist",
  "podcast",
  "episode",
  "mix",
  "video",
]);

function splitSearchMeta(value: string): string[] {
  const normalized = value
    .replace(/\u00e2\u20ac\u00a2/g, "\u2022")
    .replace(/\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u00a2/g, "\u2022");

  return normalized
    .split(/\s*\u2022\s*/u)
    .map((part: string) => part.trim())
    .filter(Boolean);
}

function looksLikePollutedArtistField(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  if (lower === "explicit") return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(trimmed)) return true;
  if (/^\d{4}$/.test(trimmed)) return true;
  if (/\bmonthly listeners?\b/i.test(trimmed)) return true;
  if (/\bmonthly listeners?\b/i.test(trimmed)) return true;
  return /\b(plays?|views?|streams?|listeners?|subscribers?)\b/i.test(trimmed);
}

function looksLikeNonArtistMeta(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  if (SEARCH_TYPE_LABELS.has(lower) || lower === "explicit") return true;

  return looksLikePollutedArtistField(value);
}

export function artistLineFromCredits(
  artistCredits: readonly ArtistCredit[] | null | undefined,
): string | null {
  const names = (artistCredits ?? [])
    .map((credit) => credit.name.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join(", ") : null;
}

export function getSearchItemArtist(
  item: Pick<SearchItem, "artist" | "subtitle" | "title" | "kind" | "artistCredits">,
): string {
  const directArtist = item.artist?.trim();
  if (directArtist && !looksLikePollutedArtistField(directArtist)) {
    return directArtist;
  }

  const parts = splitSearchMeta(item.subtitle ?? "");
  const hasTypeLabel = SEARCH_TYPE_LABELS.has((parts[0] ?? "").toLowerCase());
  const fallbackArtist = parts
    .slice(hasTypeLabel ? 1 : 0)
    .find((part) => !looksLikeNonArtistMeta(part));

  if (fallbackArtist) return fallbackArtist;

  const fromCredits = artistLineFromCredits(item.artistCredits);
  if (fromCredits) return fromCredits;

  if (item.kind === "artist") {
    const title = item.title?.trim();
    if (title) return title;
  }

  return PLACEHOLDER_ARTIST;
}

/**
 * Compensate for mislabeled search rows. When the same song appears both as
 * a clean studio-titled row and as a music-video-titled row ("Song (Official
 * Music Video)"), keep only the clean studio row so search results don't
 * show duplicate entries for one song.
 *
 * Deliberately conservative: a video-titled row that is the ONLY
 * representation of its song is always kept — dropping it would remove the
 * song from search entirely, and the playback layer resolves its videoId to
 * the studio audio anyway.
 */
export function dedupeMusicVideoTitledSongs(
  items: readonly SearchItem[],
): SearchItem[] {
  const byBaseTitle = new Map<string, SearchItem[]>();
  for (const item of items) {
    if (item.kind !== "song") continue;
    const base = normalizeText(cleanAutoplaySearchTitle(item.title));
    if (!base) continue;
    const group = byBaseTitle.get(base);
    if (group) group.push(item);
    else byBaseTitle.set(base, [item]);
  }

  const droppedIds = new Set<string>();
  for (const group of byBaseTitle.values()) {
    const cleanRows = group.filter((item) => !titleLooksLikeMusicVideo(item.title));
    if (cleanRows.length === 0 || cleanRows.length === group.length) continue;
    for (const item of group) {
      if (titleLooksLikeMusicVideo(item.title)) droppedIds.add(item.id);
    }
  }

  if (droppedIds.size === 0) return [...items];
  return items.filter((item) => !droppedIds.has(item.id));
}

/**
 * Drop music-video-titled song rows from search results whenever a clean
 * studio song row meaningfully matches the query ("Paranoid Android" should
 * appear once, as the studio cut — not twice with a "(Official Music Video)"
 * twin). A video-titled row is kept only when it is the song's only
 * representation in the results, so dropping it could not empty the search;
 * the playback layer resolves that videoId to studio audio anyway.
 */
export function filterSearchMusicVideoRows(
  items: readonly SearchItem[],
  query: string,
): SearchItem[] {
  const videoTitled = items.filter(
    (item) => item.kind === "song" && titleLooksLikeMusicVideo(item.title),
  );
  if (videoTitled.length === 0) return [...items];

  const cleanRows = items.filter(
    (item) => !(item.kind === "song" && titleLooksLikeMusicVideo(item.title)),
  );
  const queryTokens = new Set(normalizeText(query).split(/\s+/).filter(Boolean));
  if (queryTokens.size === 0) return [...items];

  const overlapThreshold = Math.min(2, queryTokens.size);
  const hasCleanSongMatch = cleanRows.some((item) => {
    if (item.kind !== "song") return false;
    const itemTokens = new Set(normalizeText(item.title).split(/\s+/).filter(Boolean));
    let overlap = 0;
    for (const token of itemTokens) {
      if (queryTokens.has(token)) overlap += 1;
    }
    return overlap >= overlapThreshold;
  });

  return hasCleanSongMatch ? cleanRows : [...items];
}
