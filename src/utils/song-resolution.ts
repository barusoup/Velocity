import { getEntityDetail, searchMusic } from "../api";
import type { MediaTrack, SearchItem } from "../types";
import { isExcludedNonMusicStreamKind } from "./media";
import { getSearchItemArtist, isPlaceholderArtist } from "./search";

const SEARCH_MATCH_TIMEOUT_MS = 4_000;
const AUTOPLAY_MIN_ARTIST_OVERLAP = 0.25;
const AUTOPLAY_MIN_TITLE_OVERLAP = 0.25;
const AUTOPLAY_RESOLVE_CONCURRENCY = 4;

const VIDEO_TITLE_SUFFIX_REGEX = new RegExp(
  "[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video|official\\s+visualizer|visualizer|audio|video|lyrics?|lyric\\s+video|clip|m\\/v|hd|4k|hq|(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?)[\\)\\]]?\\s*$",
  "i",
);
const VIDEO_TITLE_PREFIX_REGEX = new RegExp(
  "^[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video)[\\)\\]]?\\s*[-–—:]?\\s*",
  "i",
);
const EXPLICIT_MUSIC_VIDEO_TITLE_MARKERS =
  /\b(official\s+)?music\s+video\b|\bofficial\s+video\b|\(mv\)|\[mv\]/i;

const RECORDING_VARIANT_MARKERS =
  /\b(live(?:\s*\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\b/i;

const REMASTER_EDITION_REGEX =
  /\(([^)]*\b(?:\d{4}\s+)?remaster(?:ed)?[^)]*)\)|\b(\d{4}\s+remaster(?:ed)?)\b/i;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function cleanAutoplaySearchTitle(title: string): string {
  return title
    .replace(VIDEO_TITLE_PREFIX_REGEX, "")
    .replace(VIDEO_TITLE_SUFFIX_REGEX, "")
    .replace(/\s*[-–—]\s*topic\s*$/i, "")
    .trim();
}

function normalizeAutoplayMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Edition fingerprint so a 2007 remaster never matches the original studio cut. */
export function remasterEditionKey(title: string): string | null {
  const match = title.match(REMASTER_EDITION_REGEX);
  if (!match) return null;
  return normalizeAutoplayMatchText(match[1] ?? match[2] ?? "");
}

export function editionsCompatible(sourceTitle: string, candidateTitle: string): boolean {
  return remasterEditionKey(sourceTitle) === remasterEditionKey(candidateTitle);
}

function recordingVariantFlags(title: string): { hasVariant: boolean; normalized: string } {
  const cleaned = cleanAutoplaySearchTitle(title);
  return {
    hasVariant: RECORDING_VARIANT_MARKERS.test(cleaned),
    normalized: normalizeAutoplayMatchText(cleaned),
  };
}

export function titlesMatchForAudioSwap(sourceTitle: string, candidateTitle: string): boolean {
  if (!editionsCompatible(sourceTitle, candidateTitle)) return false;
  const source = recordingVariantFlags(sourceTitle);
  const candidate = recordingVariantFlags(candidateTitle);
  if (source.hasVariant !== candidate.hasVariant) return false;
  return source.normalized === candidate.normalized;
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(normalizeAutoplayMatchText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeAutoplayMatchText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function artistsMatchForAudioSwap(left: string, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeAutoplayMatchText(left);
  const normalizedRight = normalizeAutoplayMatchText(right ?? "");
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return tokenOverlap(left, right ?? "") >= 0.8;
}

function isDurationMatchForAutoplaySwap(
  sourceSeconds: number | null | undefined,
  candidateSeconds: number | null | undefined,
  options?: { allowMissingCandidate?: boolean },
): boolean {
  const hasSource =
    sourceSeconds != null && Number.isFinite(sourceSeconds) && sourceSeconds > 0;
  const hasCandidate =
    candidateSeconds != null && Number.isFinite(candidateSeconds) && candidateSeconds > 0;
  if (!hasSource) return true;
  if (!hasCandidate) return options?.allowMissingCandidate ?? false;
  const diff = Math.abs(sourceSeconds - candidateSeconds);
  const tolerance = Math.max(15, sourceSeconds * 0.15);
  return diff <= tolerance;
}

function titleExplicitlyMusicVideo(title: string): boolean {
  return EXPLICIT_MUSIC_VIDEO_TITLE_MARKERS.test(title);
}

function collectSearchCandidates(response: {
  topResult?: SearchItem | null;
  results?: SearchItem[];
}): SearchItem[] {
  const candidates: SearchItem[] = [];
  if (response.topResult) candidates.push(response.topResult);
  for (const item of response.results ?? []) {
    if (!candidates.some((existing) => existing.id === item.id)) {
      candidates.push(item);
    }
  }
  return candidates;
}

async function searchMusicCandidates(query: string): Promise<SearchItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await withTimeout(
    searchMusic(trimmed),
    SEARCH_MATCH_TIMEOUT_MS,
    "Song lookup took too long.",
  );
  return collectSearchCandidates(response);
}

async function searchCandidatesForTrack(track: MediaTrack): Promise<SearchItem[]> {
  const cleanedTitle = cleanAutoplaySearchTitle(track.title);
  const query = `${track.artist} ${cleanedTitle || track.title}`.trim();
  return searchMusicCandidates(query);
}

/** Raw-title query used by the canonical song lookup (pre-refactor behavior). */
async function searchCandidatesForCanonicalTrack(track: MediaTrack): Promise<SearchItem[]> {
  const query = `${track.artist} ${track.title}`.trim();
  return searchMusicCandidates(query);
}

function songKindCandidates(candidates: readonly SearchItem[]): SearchItem[] {
  return candidates.filter((item) => item.kind === "song" && item.videoId);
}

/** Whether search already lists this upload as the intended artist/title row. */
function isCataloguedSongMatch(
  track: Pick<MediaTrack, "artist" | "title" | "videoId">,
  item: SearchItem,
): boolean {
  if (!track.videoId || item.videoId !== track.videoId) return false;
  if (!artistsMatchForAudioSwap(track.artist, item.artist ?? "")) return false;
  return titlesMatchForAudioSwap(track.title, item.title);
}

/**
 * Keep the user-selected upload when search agrees on artist/title and the
 * known duration still lines up — even if other same-titled variants exist.
 */
function shouldTrustCataloguedUpload(
  track: Pick<MediaTrack, "artist" | "title" | "videoId" | "durationSeconds">,
  candidates: readonly SearchItem[],
): boolean {
  const listing = songKindCandidates(candidates).find((item) => item.videoId === track.videoId);
  if (!listing || !isCataloguedSongMatch(track, listing)) return false;

  const hasSourceDuration =
    track.durationSeconds != null &&
    Number.isFinite(track.durationSeconds) &&
    track.durationSeconds > 0;
  const hasListingDuration =
    listing.durationSeconds != null &&
    Number.isFinite(listing.durationSeconds) &&
    listing.durationSeconds > 0;
  // Same-titled variants (studio vs live vs mislabeled MV) need a duration
  // anchor before we skip resolution.
  if (!hasSourceDuration || !hasListingDuration) return false;

  return isDurationMatchForAutoplaySwap(track.durationSeconds, listing.durationSeconds, {
    allowMissingCandidate: false,
  });
}

/**
 * Autoplay matcher for `kind === "video"` rows — overlap-ranked best hit with
 * cleaned title search, matching the pre-refactor `findClosestSongForVideoTrack`.
 */
function findClosestSongFromCandidates(
  video: Pick<MediaTrack, "artist" | "title" | "videoId" | "durationSeconds">,
  candidates: readonly SearchItem[],
): SearchItem | null {
  const songs = songKindCandidates(candidates);
  if (songs.length === 0) return null;

  const candidateArtist = video.artist;
  const cleanedTitle = cleanAutoplaySearchTitle(video.title);
  const candidateTitle = cleanedTitle || video.title;
  const ranked = songs
    .map((song, index) => {
      const songArtist = song.artist ?? "";
      const exactArtist =
        normalizeAutoplayMatchText(candidateArtist) ===
        normalizeAutoplayMatchText(songArtist);
      const exactTitle =
        normalizeAutoplayMatchText(candidateTitle) ===
        normalizeAutoplayMatchText(song.title);
      const artistScore = tokenOverlap(candidateArtist, songArtist);
      const titleScore = tokenOverlap(candidateTitle, song.title);
      const exactPair = exactArtist && exactTitle ? 1 : 0;
      const score = exactPair + artistScore * 0.6 + titleScore * 0.4;
      return { song, score, index, exactArtist, exactTitle, artistScore, titleScore };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (shouldTrustCataloguedUpload(video, candidates)) return null;

  for (const entry of ranked) {
    const meetsArtist =
      entry.exactArtist || entry.artistScore >= AUTOPLAY_MIN_ARTIST_OVERLAP;
    const meetsTitle =
      entry.exactTitle || entry.titleScore >= AUTOPLAY_MIN_TITLE_OVERLAP;
    if (!meetsArtist || !meetsTitle) continue;
    if (!titlesMatchForAudioSwap(video.title, entry.song.title)) continue;
    if (
      !isDurationMatchForAutoplaySwap(video.durationSeconds, entry.song.durationSeconds, {
        allowMissingCandidate: true,
      })
    ) {
      continue;
    }
    const matchedVideoId = entry.song.videoId!;
    if (matchedVideoId === video.videoId) continue;
    return entry.song;
  }
  return null;
}

/**
 * Autoplay matcher for mislabeled `kind === "song"` rows — exact (artist, title)
 * scan skipping the source videoId, matching pre-refactor canonical lookup.
 */
function findCanonicalSongFromCandidates(
  track: Pick<MediaTrack, "artist" | "title" | "videoId" | "durationSeconds">,
  candidates: readonly SearchItem[],
): SearchItem | null {
  const songs = songKindCandidates(candidates);
  if (songs.length === 0) return null;

  if (shouldTrustCataloguedUpload(track, candidates)) {
    return null;
  }

  const candidateArtist = track.artist;
  const candidateTitle = track.title;
  const ranked = songs
    .map((song, index) => {
      const songArtist = song.artist ?? "";
      const exactArtist =
        normalizeAutoplayMatchText(candidateArtist) ===
        normalizeAutoplayMatchText(songArtist);
      const exactTitle =
        normalizeAutoplayMatchText(candidateTitle) ===
        normalizeAutoplayMatchText(song.title);
      const artistScore = tokenOverlap(candidateArtist, songArtist);
      const titleScore = tokenOverlap(candidateTitle, song.title);
      const exactPair = exactArtist && exactTitle ? 1 : 0;
      const score = exactPair + artistScore * 0.6 + titleScore * 0.4;
      return { song, score, index, exactArtist, exactTitle };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const entry of ranked) {
    if (!entry.exactArtist || !entry.exactTitle) continue;
    if (
      !isDurationMatchForAutoplaySwap(track.durationSeconds, entry.song.durationSeconds, {
        allowMissingCandidate: true,
      })
    ) {
      continue;
    }
    const matchedVideoId = entry.song.videoId!;
    if (matchedVideoId === track.videoId) continue;
    return entry.song;
  }
  return null;
}

function albumBrowseIdForTrack(
  track: Pick<MediaTrack, "title" | "artist" | "album" | "albumBrowseId">,
  candidates: readonly SearchItem[],
): string | null {
  const explicit = track.albumBrowseId?.trim();
  if (explicit) return explicit;

  const trackEdition = remasterEditionKey(track.title) ?? remasterEditionKey(track.album ?? "");
  const normalizedAlbum = track.album ? normalizeAutoplayMatchText(track.album) : "";

  for (const item of candidates) {
    if (item.kind !== "album" || !item.browseId?.trim()) continue;
    if (!artistsMatchForAudioSwap(track.artist, item.artist ?? item.title)) continue;
    if (normalizedAlbum && normalizeAutoplayMatchText(item.title) === normalizedAlbum) {
      return item.browseId.trim();
    }
    const albumEdition = remasterEditionKey(item.title);
    if (trackEdition && albumEdition && trackEdition === albumEdition) {
      return item.browseId.trim();
    }
  }
  return null;
}

export type AlbumListingMatch = {
  videoId: string;
  row: MediaTrack;
};

/**
 * YouTube Music album shelves sometimes point at a different (playable)
 * videoId than search returns for the same remaster row — search may surface
 * an age-gated upload while the album listing uses an official audio/lyric
 * upload that yt-dlp can fetch anonymously.
 */
export async function findAlbumListingMatch(
  track: Pick<MediaTrack, "title" | "artist" | "album" | "albumBrowseId" | "videoId">,
  candidates: readonly SearchItem[],
): Promise<AlbumListingMatch | null> {
  const browseId = albumBrowseIdForTrack(track, candidates);
  if (!browseId || !track.videoId) return null;

  try {
    const entity = await getEntityDetail(browseId);
    for (const row of entity.tracks) {
      if (!row.videoId || row.videoId === track.videoId) continue;
      if (!artistsMatchForAudioSwap(track.artist, row.artist)) continue;
      if (!titlesMatchForAudioSwap(track.title, row.title)) continue;
      return { videoId: row.videoId, row };
    }
  } catch (error) {
    console.warn("Album listing lookup failed:", error);
  }
  return null;
}

export async function findAlbumListingVideoId(
  track: Pick<MediaTrack, "title" | "artist" | "album" | "albumBrowseId" | "videoId">,
  candidates: readonly SearchItem[],
): Promise<string | null> {
  const match = await findAlbumListingMatch(track, candidates);
  return match?.videoId ?? null;
}

/** Whether a yt-dlp / stream-resolve failure should try an alternate videoId. */
export function isUnplayableStreamError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("sign in to confirm your age") ||
    (lower.includes("confirm your age")) ||
    lower.includes("private video") ||
    lower.includes("video unavailable") ||
    lower.includes("this video is not available")
  );
}

function isCataloguedSongUpload(
  track: Pick<MediaTrack, "videoId">,
  ...candidateLists: readonly (readonly SearchItem[])[]
): boolean {
  if (!track.videoId) return false;
  for (const candidates of candidateLists) {
    for (const item of songKindCandidates(candidates)) {
      if (item.videoId === track.videoId) return true;
    }
  }
  return false;
}

function hasAutoplayVariantTitle(title: string): boolean {
  return recordingVariantFlags(title).hasVariant;
}

function hasDistinctStudioSongCandidate(
  track: Pick<MediaTrack, "artist" | "title" | "videoId" | "durationSeconds">,
  candidates: readonly SearchItem[],
): boolean {
  if (shouldTrustCataloguedUpload(track, candidates)) return false;
  for (const item of songKindCandidates(candidates)) {
    if (!item.videoId || item.videoId === track.videoId) continue;
    const songArtist = item.artist ?? "";
    if (!artistsMatchForAudioSwap(track.artist, songArtist)) continue;
    if (titlesMatchForAudioSwap(track.title, item.title)) return true;
  }
  return false;
}

/**
 * Whether a stream track must be swapped to a studio "song" upload before
 * playback. Music videos arrive as `kind === "video"`, as mislabeled songs,
 * or with a title that explicitly names a music video.
 */
export function trackNeedsStudioSongResolution(
  track: Pick<MediaTrack, "kind" | "videoId" | "title" | "artist">,
  candidates: readonly SearchItem[],
): boolean {
  if (track.kind === "video") return true;
  if (titleExplicitlyMusicVideo(track.title)) return true;
  if (!track.videoId) return false;
  // Search excludes `kind === "video"` (Rust `should_include_search_item`), so
  // detect mislabeled uploads when search surfaces a different song row.
  return hasDistinctStudioSongCandidate(track, candidates);
}

/**
 * Find the best studio-song (`kind === "song"`) match for a track by
 * artist/title equivalence. Skips the track's own videoId so a music
 * video never resolves to itself.
 */
export function findStudioSongForTrack(
  track: Pick<MediaTrack, "artist" | "title" | "videoId" | "durationSeconds">,
  candidates: readonly SearchItem[],
  options?: { allowMissingCandidateDuration?: boolean },
): SearchItem | null {
  const songs = candidates.filter((item) => item.kind === "song" && item.videoId);
  if (songs.length === 0) return null;

  if (shouldTrustCataloguedUpload(track, candidates)) {
    return null;
  }

  const candidateArtist = track.artist;
  const candidateTitle = cleanAutoplaySearchTitle(track.title);
  const ranked = songs
    .map((song, index) => {
      const songArtist = song.artist ?? "";
      const cleanedSongTitle = cleanAutoplaySearchTitle(song.title);
      const artistMatch = artistsMatchForAudioSwap(candidateArtist, songArtist);
      const exactTitle =
        normalizeAutoplayMatchText(candidateTitle) ===
        normalizeAutoplayMatchText(cleanedSongTitle);
      const artistScore = tokenOverlap(candidateArtist, songArtist);
      const titleScore = tokenOverlap(candidateTitle, cleanedSongTitle);
      const exactPair = artistMatch && exactTitle ? 1 : 0;
      const score = exactPair + artistScore * 0.6 + titleScore * 0.4;
      return { song, score, index, artistMatch, exactTitle };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const entry of ranked) {
    if (!entry.artistMatch) continue;
    if (!titlesMatchForAudioSwap(track.title, entry.song.title)) continue;
    const matchedVideoId = entry.song.videoId!;
    if (matchedVideoId === track.videoId) continue;
    if (
      !isDurationMatchForAutoplaySwap(track.durationSeconds, entry.song.durationSeconds, {
        allowMissingCandidate: options?.allowMissingCandidateDuration,
      })
    ) {
      continue;
    }
    return entry.song;
  }
  return null;
}

function artistFromMetadataSource(matched: MetadataSource): string {
  const artist = matched.artist?.trim();
  if (artist) return artist;
  if ("source" in matched) return "";
  return getSearchItemArtist(matched);
}

export function songMetadataFromMatch(
  matched: MediaTrack | SearchItem,
): Partial<MediaTrack> {
  const artist = artistFromMetadataSource(matched);
  return {
    title: matched.title,
    artist: artist && !isPlaceholderArtist(artist) ? artist : artist || undefined,
    album: matched.album ?? undefined,
    albumBrowseId: matched.albumBrowseId ?? undefined,
    artistBrowseId: matched.artistBrowseId ?? undefined,
    artistCredits: matched.artistCredits ?? undefined,
    durationSeconds: matched.durationSeconds ?? undefined,
    playCount: matched.playCount ?? undefined,
    cover: matched.cover ?? undefined,
    kind: "song",
  };
}

type MetadataSource = MediaTrack | SearchItem;

function buildResolvedAutoplayTrack(entry: MediaTrack, matched: MetadataSource): MediaTrack {
  const matchedVideoId = matched.videoId!;
  // Build from the matched song's metadata only. Do not fall back to the
  // source entry's title/cover when the match omits a field — autoplay rows
  // are often music videos and inheriting their artwork re-introduces the
  // wrong thumbnail while the audio is already corrected.
  return {
    ...entry,
    id: `yt:${matchedVideoId}`,
    videoId: matchedVideoId,
    title: matched.title,
    artist: artistFromMetadataSource(matched),
    album: matched.album ?? null,
    albumBrowseId: matched.albumBrowseId ?? null,
    artistBrowseId: matched.artistBrowseId ?? null,
    artistCredits: matched.artistCredits ?? null,
    durationSeconds: matched.durationSeconds ?? null,
    playCount: matched.playCount ?? null,
    cover: matched.cover ?? null,
    kind: "song",
    resolvedVideoId: null,
  };
}

function trackWithResolvedVideoId(
  track: MediaTrack,
  resolvedVideoId: string,
  matched?: MetadataSource | null,
): MediaTrack {
  if (matched?.videoId) {
    return {
      ...track,
      resolvedVideoId,
      ...songMetadataFromMatch(matched),
    };
  }
  return {
    ...track,
    resolvedVideoId,
  };
}

async function resolvePlaybackVideoId(
  track: MediaTrack,
  candidates: readonly SearchItem[],
): Promise<{ resolvedVideoId?: string; matched: MetadataSource | null }> {
  const needsResolution = trackNeedsStudioSongResolution(track, candidates);
  const strictMatched =
    findStudioSongForTrack(track, candidates, { allowMissingCandidateDuration: true }) ??
    findCanonicalSongFromCandidates(track, candidates);
  const relaxedMatched = needsResolution ? findClosestSongFromCandidates(track, candidates) : null;
  const matched = strictMatched ?? relaxedMatched;
  const albumListingMatch = await findAlbumListingMatch(track, candidates);

  if (needsResolution) {
    if (matched?.videoId) {
      return { resolvedVideoId: matched.videoId, matched };
    }
    if (albumListingMatch) {
      return { resolvedVideoId: albumListingMatch.videoId, matched: albumListingMatch.row };
    }
    return { matched: null };
  }

  // User-selected catalog rows already carry the intended upload — only
  // swap for album-shelf alternates (age-gated search hits, etc.).
  if (albumListingMatch) {
    return { resolvedVideoId: albumListingMatch.videoId, matched: albumListingMatch.row };
  }
  return { matched: null };
}

async function resolveAutoplayEntryWithCandidates(
  entry: MediaTrack,
  cleanedQueryCandidates: SearchItem[],
  canonicalQueryCandidates: SearchItem[] | null,
): Promise<MediaTrack | null> {
  if (entry.kind === "video") {
    const matched =
      findClosestSongFromCandidates(entry, cleanedQueryCandidates) ??
      (canonicalQueryCandidates
        ? findClosestSongFromCandidates(entry, canonicalQueryCandidates)
        : null);
    if (matched) return buildResolvedAutoplayTrack(entry, matched);
    const albumListingMatch = await findAlbumListingMatch(entry, cleanedQueryCandidates);
    if (albumListingMatch) return buildResolvedAutoplayTrack(entry, albumListingMatch.row);
    return null;
  }

  const canonicalCandidates = canonicalQueryCandidates ?? cleanedQueryCandidates;
  const canonical =
    findCanonicalSongFromCandidates(entry, canonicalCandidates) ??
    findCanonicalSongFromCandidates(entry, cleanedQueryCandidates);
  if (canonical?.videoId && canonical.videoId !== entry.videoId) {
    return buildResolvedAutoplayTrack(entry, canonical);
  }

  const studioMatch =
    findStudioSongForTrack(entry, cleanedQueryCandidates, {
      allowMissingCandidateDuration: true,
    }) ??
    findStudioSongForTrack(entry, canonicalCandidates, {
      allowMissingCandidateDuration: true,
    });
  if (studioMatch?.videoId && studioMatch.videoId !== entry.videoId) {
    return buildResolvedAutoplayTrack(entry, studioMatch);
  }

  const relaxedMatch =
    findClosestSongFromCandidates(entry, cleanedQueryCandidates) ??
    findClosestSongFromCandidates(entry, canonicalCandidates);
  if (relaxedMatch) return buildResolvedAutoplayTrack(entry, relaxedMatch);

  const albumListingMatch = await findAlbumListingMatch(entry, cleanedQueryCandidates);
  if (albumListingMatch && albumListingMatch.videoId !== entry.videoId) {
    return buildResolvedAutoplayTrack(entry, albumListingMatch.row);
  }

  if (
    titleExplicitlyMusicVideo(entry.title) ||
    hasAutoplayVariantTitle(entry.title) ||
    trackNeedsStudioSongResolution(entry, cleanedQueryCandidates) ||
    !isCataloguedSongUpload(entry, cleanedQueryCandidates, canonicalCandidates)
  ) {
    return null;
  }

  return entry;
}

/**
 * Resolve an autoplay watch-playlist row to its studio song counterpart.
 * Returns `null` when the row is a music video (or other non-song media)
 * that has no matching `kind === "song"` result — those entries are never
 * added to the autoplay tail.
 */
export async function resolveAutoplayEntryToSong(entry: MediaTrack): Promise<MediaTrack | null> {
  if (isExcludedNonMusicStreamKind(entry.kind) && entry.kind !== "video") {
    return null;
  }
  if (!entry.videoId) return null;

  try {
    const cleanedQueryCandidates = await searchCandidatesForTrack(entry);
    const canonicalQueryCandidates =
      entry.kind === "video"
        ? null
        : await searchCandidatesForCanonicalTrack(entry);
    return resolveAutoplayEntryWithCandidates(
      entry,
      cleanedQueryCandidates,
      canonicalQueryCandidates,
    );
  } catch (error) {
    console.warn("Autoplay song-match lookup failed:", error);
    return null;
  }
}

/** Resolve autoplay rows with bounded concurrency so parallel searches don't time out. */
export async function resolveAutoplayEntries(
  entries: readonly MediaTrack[],
): Promise<Array<MediaTrack | null>> {
  const results: Array<MediaTrack | null> = new Array(entries.length).fill(null);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await resolveAutoplayEntryToSong(entries[index]!);
    }
  }

  const workerCount = Math.min(AUTOPLAY_RESOLVE_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Resolve a queue track's playback audio to a studio song upload when its
 * videoId points at a music video. When no studio match exists, returns
 * the original track so playback can still use the saved videoId (offline
 * files, yt-dlp, and stream fallbacks may still work).
 */
export async function resolveStreamTrackAudio(track: MediaTrack): Promise<MediaTrack | null> {
  if (track.source !== "stream" || !track.videoId) return track;
  if (track.kind === "episode" || track.kind === "podcast" || track.kind === "mix") {
    return track;
  }

  try {
    const candidates = await searchCandidatesForTrack(track);
    const needsResolution = trackNeedsStudioSongResolution(track, candidates);
    let { resolvedVideoId, matched } = await resolvePlaybackVideoId(track, candidates);

    if (!resolvedVideoId && needsResolution && track.kind !== "video") {
      const canonicalCandidates = await searchCandidatesForCanonicalTrack(track);
      const canonical = findCanonicalSongFromCandidates(track, canonicalCandidates);
      if (canonical?.videoId && canonical.videoId !== track.videoId) {
        resolvedVideoId = canonical.videoId;
        matched = canonical;
      }
    }

    if (resolvedVideoId && resolvedVideoId !== track.videoId) {
      return trackWithResolvedVideoId(track, resolvedVideoId, matched);
    }
    return track;
  } catch (error) {
    console.warn("Stream song-match lookup failed:", error);
    return track;
  }
}

/**
 * Last-resort playback resolver used when yt-dlp cannot fetch the current
 * videoId (age-gated uploads, etc.). Re-queries YT Music and prefers the
 * album-shelf videoId for the same remaster row.
 */
export async function resolveStreamTrackAudioFallback(track: MediaTrack): Promise<MediaTrack | null> {
  if (track.source !== "stream" || !track.videoId) return null;
  if (track.resolvedVideoId && track.resolvedVideoId !== track.videoId) return null;

  try {
    const candidates = await searchCandidatesForTrack(track);
    const albumListingMatch = await findAlbumListingMatch(track, candidates);
    if (!albumListingMatch || albumListingMatch.videoId === track.videoId) return null;
    return trackWithResolvedVideoId(track, albumListingMatch.videoId, albumListingMatch.row);
  } catch (error) {
    console.warn("Stream playback fallback lookup failed:", error);
    return null;
  }
}