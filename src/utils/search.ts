import type { SearchItem } from "../types";

const SEARCH_TYPE_LABELS = new Set([
  "song",
  "artist",
  "album",
  "single",
  "ep",
  "playlist",
  "podcast",
  "episode",
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

function looksLikeNonArtistMeta(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  if (SEARCH_TYPE_LABELS.has(lower) || lower === "explicit") return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(trimmed)) return true;
  if (/^\d{4}$/.test(trimmed)) return true;
  if (/\bmonthly listeners?\b/i.test(trimmed)) return true;
  if (!/\d/.test(trimmed)) return false;

  return /\b(plays?|views?|streams?|listeners?|subscribers?)\b/i.test(trimmed);
}

export function getSearchItemArtist(item: Pick<SearchItem, "artist" | "subtitle">): string {
  const directArtist = item.artist?.trim();
  if (directArtist && !looksLikeNonArtistMeta(directArtist)) {
    return directArtist;
  }

  const parts = splitSearchMeta(item.subtitle);
  const hasTypeLabel = SEARCH_TYPE_LABELS.has((parts[0] ?? "").toLowerCase());
  const fallbackArtist = parts
    .slice(hasTypeLabel ? 1 : 0)
    .find((part) => !looksLikeNonArtistMeta(part));

  return fallbackArtist ?? "Unknown artist";
}
