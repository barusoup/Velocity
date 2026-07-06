import { resolveTrackAlbum, searchMusic } from "../api";
import type { MediaTrack, SearchItem } from "../types";

const PLACEHOLDER_ALBUMS = new Set(["collection", "unknown album", "unknown"]);

export function isPlaceholderAlbumName(album: string | null | undefined): boolean {
  const trimmed = album?.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_ALBUMS.has(trimmed.toLowerCase());
}

export function displayAlbumName(album: string | null | undefined): string {
  if (isPlaceholderAlbumName(album)) return "";
  return album?.trim() ?? "";
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(normalizeMatchText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeMatchText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function pickCandidateArtist(item: SearchItem): string {
  const direct = item.artist?.trim();
  if (direct) return direct;
  const parts = item.subtitle.split(/\s*\u2022\s*/).map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (["song", "video", "single", "ep", "album", "playlist"].includes(lower)) continue;
    return part;
  }
  return "";
}

function rankSongMatch(
  targetTitle: string,
  targetArtist: string,
  candidate: SearchItem,
  index: number,
): number {
  const candidateTitle = candidate.title;
  const candidateArtist = pickCandidateArtist(candidate);
  const exactArtist =
    normalizeMatchText(targetArtist) === normalizeMatchText(candidateArtist);
  const exactTitle =
    normalizeMatchText(targetTitle) === normalizeMatchText(candidateTitle);
  const artistScore = tokenOverlap(targetArtist, candidateArtist);
  const titleScore = tokenOverlap(targetTitle, candidateTitle);
  const exactPair = exactArtist && exactTitle ? 1 : 0;
  return exactPair + artistScore * 0.6 + titleScore * 0.4 - index * 0.001;
}

export type UploadYtmEnrichment = {
  artist?: string;
  album?: string;
  albumBrowseId?: string | null;
  videoId?: string;
  /** HTTPS album-art URL from the YTM search match. */
  cover?: string | null;
};

export type UploadDiscordCover = {
  coverUrl: string | null;
  videoId: string | null;
};

export function isDiscordSafeCoverUrl(cover: string | null | undefined): boolean {
  if (!cover) return false;
  const normalized = cover.startsWith("//") ? `https:${cover}` : cover;
  return (
    normalized.startsWith("https://")
    && !normalized.includes("asset.localhost")
    && !normalized.startsWith("https://127.0.0.1")
    && !normalized.startsWith("https://localhost")
  );
}

/**
 * Best-effort YouTube Music lookup for a locally uploaded track. Used to
 * fill in album metadata and to seed autoplay with a streamable videoId.
 */
export async function enrichUploadMetadataFromYtm(fields: {
  title: string;
  artist: string;
  album?: string | null;
}): Promise<UploadYtmEnrichment | null> {
  const title = fields.title.trim();
  const artist = fields.artist.trim();
  const query = [artist, title].filter(Boolean).join(" ").trim();
  if (!title || !query) return null;

  let response;
  try {
    response = await searchMusic(query);
  } catch {
    return null;
  }

  const candidates = [response.topResult, ...response.results].filter(
    (item): item is SearchItem => Boolean(item && item.kind === "song" && item.videoId),
  );
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      score: rankSongMatch(title, artist, candidate, index),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.45) return null;

  const match = best.candidate;
  const enrichment: UploadYtmEnrichment = {
    videoId: match.videoId ?? undefined,
    cover: match.cover ?? null,
  };

  const matchedArtist = pickCandidateArtist(match);
  if (!artist && matchedArtist) enrichment.artist = matchedArtist;

  let album = match.album?.trim() || null;
  let albumBrowseId = match.albumBrowseId ?? null;

  if ((!album || isPlaceholderAlbumName(album) || !albumBrowseId) && match.videoId) {
    try {
      const resolution = await resolveTrackAlbum(match.videoId);
      if (resolution.album && !isPlaceholderAlbumName(resolution.album)) {
        album = resolution.album;
      }
      if (resolution.albumBrowseId) albumBrowseId = resolution.albumBrowseId;
    } catch {
      // best-effort
    }
  }

  if (album && !isPlaceholderAlbumName(album)) enrichment.album = album;
  if (albumBrowseId) enrichment.albumBrowseId = albumBrowseId;

  return enrichment;
}

/** Upload carries user-provided artwork that Rust publishes for Discord. */
export function hasLocalUploadCover(
  track: Pick<MediaTrack, "source" | "cover">,
): boolean {
  if (track.source !== "upload" || !track.cover) return false;
  return !isDiscordSafeCoverUrl(track.cover);
}

/**
 * Upload has no dedicated artwork — fall back to the closest YTM match for
 * Discord thumbnails only.
 */
export function needsYtmCoverFallback(
  track: Pick<MediaTrack, "source" | "cover">,
): boolean {
  return track.source === "upload" && !track.cover;
}

/**
 * Resolve a Discord-safe HTTPS cover for an upload without dedicated artwork.
 */
export async function resolveUploadDiscordCover(
  track: Pick<MediaTrack, "title" | "artist" | "album">,
): Promise<UploadDiscordCover> {
  const enrichment = await enrichUploadMetadataFromYtm({
    title: track.title,
    artist: track.artist,
    album: track.album,
  });
  if (!enrichment) {
    return { coverUrl: null, videoId: null };
  }

  const coverUrl = isDiscordSafeCoverUrl(enrichment.cover) ? enrichment.cover! : null;
  const videoId = enrichment.videoId ?? null;
  return { coverUrl, videoId };
}