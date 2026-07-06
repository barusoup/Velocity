import { resolveTrackAlbum, searchMusic } from "../api";
import type { ArtistCredit, MediaTrack, SearchItem } from "../types";

type ArtistLinkSource = {
  artist?: string | null;
  artistBrowseId?: string | null;
  artistCredits?: ArtistCredit[] | null;
  videoId?: string | null;
};

type AlbumLinkSource = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumBrowseId?: string | null;
  videoId?: string | null;
};

// Bounded LRU for in-flight + resolved artist/album browse-id lookups.
// Without the cap, a user navigating through thousands of distinct
// tracks/artists would let these Maps grow without bound. The Map
// iteration order matches insertion / access order, so the eldest
// entry is the first key — we delete that one when we exceed the cap.
const ARTIST_BROWSE_ID_CACHE_MAX = 200;
const ALBUM_BROWSE_ID_CACHE_MAX = 200;
const artistBrowseIdCache = new Map<string, Promise<string | null>>();
const albumBrowseIdCache = new Map<string, Promise<string | null>>();

function cacheGet<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  // LRU touch: re-insert to move to the most-recently-used position.
  map.delete(key);
  map.set(key, value);
  return value;
}

function cacheSet<T>(map: Map<string, T>, key: string, value: T, maxSize: number): void {
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function cacheDelete<T>(map: Map<string, T>, key: string): void {
  map.delete(key);
}

function trimToNull(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeLookupText(value?: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Strip parenthesized suffixes ("(Remastered 2011)", "(feat. ...)", "(Live)")
// before normalizing. Used by the loose matchers so "Album (Remastered 2011)"
// and "Album" compare equal. The exact matchers intentionally keep parens
// so a precise hit is always preferred over a loose one.
function stripParens(value: string): string {
  return value.replace(/\([^)]*\)/g, " ");
}

function normalizeLookupTextLoose(value?: string | null): string {
  return normalizeLookupText(stripParens(value ?? ""));
}

function getUniqueSearchItems(response: Awaited<ReturnType<typeof searchMusic>>): SearchItem[] {
  const items = [response.topResult, ...response.results].filter(Boolean) as SearchItem[];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function matchesArtistName(item: Pick<SearchItem, "title" | "artist">, artist: string): boolean {
  const normalizedArtist = normalizeLookupText(artist);
  if (!normalizedArtist) return false;
  return (
    normalizeLookupText(item.title) === normalizedArtist ||
    normalizeLookupText(item.artist) === normalizedArtist
  );
}

// Loose variant of matchesArtistName: strips parenthesized suffixes before
// comparing. Catches "Artist Official" vs "Artist" style mismatches that
// YouTube Music sometimes returns for the artist card title.
function matchesArtistNameLoose(item: Pick<SearchItem, "title" | "artist">, artist: string): boolean {
  const normalizedArtist = normalizeLookupTextLoose(artist);
  if (!normalizedArtist) return false;
  return (
    normalizeLookupTextLoose(item.title) === normalizedArtist ||
    normalizeLookupTextLoose(item.artist) === normalizedArtist
  );
}

function matchesTrack(item: SearchItem, track: Pick<MediaTrack, "title" | "artist" | "videoId">): boolean {
  if (track.videoId && item.videoId === track.videoId) {
    return true;
  }

  const normalizedTitle = normalizeLookupText(track.title);
  if (!normalizedTitle || normalizeLookupText(item.title) !== normalizedTitle) {
    return false;
  }

  const normalizedArtist = normalizeLookupText(track.artist);
  return !normalizedArtist || normalizeLookupText(item.artist) === normalizedArtist;
}

// Loose variant of matchesTrack: strips parenthesized suffixes from both
// sides before comparing titles. Catches the common "Title (Remastered 2011)"
// vs "Title" mismatch when the user's current track is a remastered/live
// version but YouTube Music's search index returns the original.
function matchesTrackLoose(item: SearchItem, track: Pick<MediaTrack, "title" | "artist" | "videoId">): boolean {
  if (track.videoId && item.videoId === track.videoId) {
    return true;
  }

  const normalizedTitle = normalizeLookupTextLoose(track.title);
  if (!normalizedTitle || normalizeLookupTextLoose(item.title) !== normalizedTitle) {
    return false;
  }

  const normalizedArtist = normalizeLookupTextLoose(track.artist);
  return !normalizedArtist || normalizeLookupTextLoose(item.artist) === normalizedArtist;
}

function matchesAlbum(
  item: SearchItem,
  album: string,
  artist?: string | null,
): boolean {
  const normalizedAlbum = normalizeLookupText(album);
  if (!normalizedAlbum || normalizeLookupText(item.title) !== normalizedAlbum) {
    return false;
  }

  const normalizedArtist = normalizeLookupText(artist);
  return !normalizedArtist || normalizeLookupText(item.artist) === normalizedArtist;
}

// Loose variant of matchesAlbum: strips parenthesized suffixes from both
// sides before comparing album titles. Catches "Album (Deluxe Edition)" vs
// "Album" and "Album (Remastered)" vs "Album" mismatches.
function matchesAlbumLoose(
  item: SearchItem,
  album: string,
  artist?: string | null,
): boolean {
  const normalizedAlbum = normalizeLookupTextLoose(album);
  if (!normalizedAlbum || normalizeLookupTextLoose(item.title) !== normalizedAlbum) {
    return false;
  }

  const normalizedArtist = normalizeLookupTextLoose(artist);
  return !normalizedArtist || normalizeLookupTextLoose(item.artist) === normalizedArtist;
}

export function getDirectArtistBrowseId(source: Pick<ArtistLinkSource, "artistBrowseId" | "artistCredits">): string | null {
  const direct = trimToNull(source.artistBrowseId);
  if (direct) return direct;

  for (const credit of source.artistCredits ?? []) {
    const browseId = trimToNull(credit.browseId);
    if (browseId) return browseId;
  }

  return null;
}

export function getDirectAlbumBrowseId(source: Pick<AlbumLinkSource, "albumBrowseId">): string | null {
  return trimToNull(source.albumBrowseId);
}

export async function resolveArtistBrowseId(source: ArtistLinkSource): Promise<string | null> {
  const direct = getDirectArtistBrowseId(source);
  if (direct) return direct;

  const artist = trimToNull(source.artist);
  const videoId = trimToNull(source.videoId);
  const cacheKey = [normalizeLookupText(artist), videoId ?? ""].join("|");

  if (!cacheKey.replace(/\|/g, "")) return null;

  const cached = cacheGet(artistBrowseIdCache, cacheKey);
  if (!cached) {
    cacheSet(
      artistBrowseIdCache,
      cacheKey,
      (async () => {
        if (artist) {
          const response = await searchMusic(artist);
          const items = getUniqueSearchItems(response);

          const matchedTrack = videoId
            ? items.find((item) => item.kind === "song" && item.videoId === videoId)
            : undefined;
          const matchedTrackArtist = matchedTrack ? getDirectArtistBrowseId(matchedTrack) : null;
          if (matchedTrackArtist) return matchedTrackArtist;

          const exactArtist = items.find((item) => item.kind === "artist" && matchesArtistName(item, artist));
          const exactArtistBrowseId = exactArtist ? trimToNull(exactArtist.browseId) : null;
          if (exactArtistBrowseId) return exactArtistBrowseId;

          // Loose match on the artist card title (strips parenthesized
          // suffixes). Catches "Artist Official" vs "Artist" mismatches.
          const looseArtist = items.find((item) => item.kind === "artist" && matchesArtistNameLoose(item, artist));
          const looseArtistBrowseId = looseArtist ? trimToNull(looseArtist.browseId) : null;
          if (looseArtistBrowseId) return looseArtistBrowseId;

          const fallbackArtist = items.find((item) => item.kind === "artist");
          const fallbackArtistBrowseId = trimToNull(fallbackArtist?.browseId);
          if (fallbackArtistBrowseId) return fallbackArtistBrowseId;

          // Last resort: search sometimes returns songs but no artist card
          // (common for featured/niche artists). If any song's artist field
          // exactly matches the target, reuse its artistBrowseId.
          const matchedSong = items.find(
            (item) =>
              item.kind === "song" &&
              normalizeLookupText(item.artist) === normalizeLookupText(artist) &&
              trimToNull(item.artistBrowseId),
          );
          const matchedSongArtistBrowseId = matchedSong ? trimToNull(matchedSong.artistBrowseId) : null;
          if (matchedSongArtistBrowseId) return matchedSongArtistBrowseId;
        }

        if (videoId) {
          try {
            const resolution = await resolveTrackAlbum(videoId);
            const watchArtistBrowseId = trimToNull(resolution.artistBrowseId);
            if (watchArtistBrowseId) return watchArtistBrowseId;
          } catch {
            // Backend unavailable or network error — fall through.
          }
        }

        return null;
      })().catch((error) => {
        cacheDelete(artistBrowseIdCache, cacheKey);
        throw error;
      }),
      ARTIST_BROWSE_ID_CACHE_MAX,
    );
  }

  return cached!;
}

export async function resolveAlbumBrowseId(source: AlbumLinkSource): Promise<string | null> {
  const direct = getDirectAlbumBrowseId(source);
  if (direct) return direct;

  const title = trimToNull(source.title);
  const artist = trimToNull(source.artist);
  const album = trimToNull(source.album);
  const videoId = trimToNull(source.videoId);
  const cacheKey = [
    videoId ?? "",
    normalizeLookupText(title),
    normalizeLookupText(artist),
    normalizeLookupText(album),
  ].join("|");

  if (!cacheKey.replace(/\|/g, "")) return null;

  const cached = cacheGet(albumBrowseIdCache, cacheKey);
  if (!cached) {
    cacheSet(
      albumBrowseIdCache,
      cacheKey,
      (async () => {
        if (title && artist) {
          const response = await searchMusic(`${title} ${artist}`);
          const items = getUniqueSearchItems(response);
          const matchedTrack = items.find((item) => item.kind === "song" && matchesTrack(item, {
            title,
            artist,
            videoId: videoId ?? null,
          }));
          const matchedTrackAlbumBrowseId = trimToNull(matchedTrack?.albumBrowseId);
          if (matchedTrackAlbumBrowseId) return matchedTrackAlbumBrowseId;

          // Loose match: strips "(Remastered 2011)" / "(Live)" suffixes so
          // a currently-playing remastered track still resolves to its
          // album when YouTube Music's search index only has the original.
          const looseMatchedTrack = items.find((item) => item.kind === "song" && matchesTrackLoose(item, {
            title,
            artist,
            videoId: videoId ?? null,
          }));
          const looseMatchedTrackAlbumBrowseId = trimToNull(looseMatchedTrack?.albumBrowseId);
          if (looseMatchedTrackAlbumBrowseId) return looseMatchedTrackAlbumBrowseId;
        }

        if (album) {
          const response = await searchMusic(artist ? `${album} ${artist}` : album);
          const items = getUniqueSearchItems(response);
          const exactAlbum = items.find((item) => item.kind === "album" && matchesAlbum(item, album, artist));
          const exactAlbumBrowseId = trimToNull(exactAlbum?.browseId);
          if (exactAlbumBrowseId) return exactAlbumBrowseId;

          // Loose match on the album title (strips parenthesized suffixes).
          const looseAlbum = items.find((item) => item.kind === "album" && matchesAlbumLoose(item, album, artist));
          const looseAlbumBrowseId = trimToNull(looseAlbum?.browseId);
          if (looseAlbumBrowseId) return looseAlbumBrowseId;

          const matchedAlbumSong = items.find(
            (item) =>
              item.kind === "song" &&
              normalizeLookupText(item.album) === normalizeLookupText(album) &&
              (!artist || normalizeLookupText(item.artist) === normalizeLookupText(artist)),
          );
          const matchedAlbumSongBrowseId = trimToNull(matchedAlbumSong?.albumBrowseId);
          if (matchedAlbumSongBrowseId) return matchedAlbumSongBrowseId;

          // Loose match on the song's album field.
          const looseMatchedAlbumSong = items.find(
            (item) =>
              item.kind === "song" &&
              normalizeLookupTextLoose(item.album) === normalizeLookupTextLoose(album) &&
              (!artist || normalizeLookupTextLoose(item.artist) === normalizeLookupTextLoose(artist)),
          );
          const looseMatchedAlbumSongBrowseId = trimToNull(looseMatchedAlbumSong?.albumBrowseId);
          if (looseMatchedAlbumSongBrowseId) return looseMatchedAlbumSongBrowseId;
        }

        if (videoId) {
          try {
            const resolution = await resolveTrackAlbum(videoId);
            const watchAlbumBrowseId = trimToNull(resolution.albumBrowseId);
            if (watchAlbumBrowseId) return watchAlbumBrowseId;
          } catch {
            // Backend unavailable or network error — fall through.
          }
        }

        return null;
      })().catch((error) => {
        cacheDelete(albumBrowseIdCache, cacheKey);
        throw error;
      }),
      ALBUM_BROWSE_ID_CACHE_MAX,
    );
  }

  return cached!;
}
