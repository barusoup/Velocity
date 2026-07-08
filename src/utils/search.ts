import type { ArtistCredit, SearchItem } from "../types";

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
  if (!/\d/.test(trimmed)) return false;

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
