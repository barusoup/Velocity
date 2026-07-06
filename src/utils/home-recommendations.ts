import { getWatchPlaylist } from "../api";
import type { MediaTrack } from "../types";
import {
  getRecentRecommendationVideoIds,
  getTasteSeeds,
  getTopSongExclusionVideoIds,
  getYesterdayDailyRecommendationVideoIds,
  isKnownTasteSong,
  storeDailyRecommendations,
  tasteProfileVideoId,
} from "../taste-profile";
import {
  filterQueueableTracks,
  isAutoplayWatchPlaylistCandidate,
} from "./media";
import { resolveAutoplayEntries } from "./song-resolution";

export const DAILY_RECOMMENDATIONS_TARGET = 15;
export const NEW_SONG_MIN_RATIO = 0.75;
const RECOMMENDATION_SEED_LIMIT = 16;
const MIN_CANDIDATE_POOL = DAILY_RECOMMENDATIONS_TARGET * 4;

function shuffleInPlace<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

function dedupeTracks(tracks: MediaTrack[]): MediaTrack[] {
  const seenIds = new Set<string>();
  const seenVideoIds = new Set<string>();
  const unique: MediaTrack[] = [];
  for (const track of tracks) {
    const videoId = tasteProfileVideoId(track);
    if (seenIds.has(track.id)) continue;
    if (videoId && seenVideoIds.has(videoId)) continue;
    seenIds.add(track.id);
    if (videoId) seenVideoIds.add(videoId);
    unique.push(track);
  }
  return unique;
}

function isEligibleRecommendation(
  track: MediaTrack,
  excludedVideoIds: Set<string>,
): boolean {
  const videoId = tasteProfileVideoId(track);
  if (!videoId) return false;
  if (excludedVideoIds.has(videoId)) return false;
  return true;
}

function isNewCandidate(
  track: MediaTrack,
  known: Set<string>,
  excludedVideoIds: Set<string>,
): boolean {
  const videoId = tasteProfileVideoId(track);
  if (!videoId) return false;
  if (!isEligibleRecommendation(track, excludedVideoIds)) return false;
  if (isKnownTasteSong(videoId)) return false;
  if (known.has(videoId)) return false;
  return true;
}

function canAddToPicked(track: MediaTrack, picked: MediaTrack[], excludedVideoIds: Set<string>): boolean {
  const videoId = tasteProfileVideoId(track);
  if (!videoId || !isEligibleRecommendation(track, excludedVideoIds)) return false;
  return !picked.some((row) => tasteProfileVideoId(row) === videoId);
}

async function fetchSeedCandidates(seedVideoId: string): Promise<MediaTrack[]> {
  try {
    const response = await getWatchPlaylist(seedVideoId);
    const candidates = response.tracks.filter(isAutoplayWatchPlaylistCandidate);
    const queueable = filterQueueableTracks(candidates).filter((track) => {
      const videoId = tasteProfileVideoId(track);
      return Boolean(videoId) && videoId !== seedVideoId;
    });
    const resolved = await resolveAutoplayEntries(queueable);
    return resolved.filter((track): track is MediaTrack => track !== null);
  } catch {
    return [];
  }
}

function pickDailyRecommendations(
  unique: MediaTrack[],
  known: Set<string>,
  excludedVideoIds: Set<string>,
): MediaTrack[] {
  const eligible = unique.filter((track) => isEligibleRecommendation(track, excludedVideoIds));
  const fresh = eligible.filter((track) => isNewCandidate(track, known, excludedVideoIds));
  const familiar = eligible.filter((track) => !isNewCandidate(track, known, excludedVideoIds));

  const minNew = Math.ceil(DAILY_RECOMMENDATIONS_TARGET * NEW_SONG_MIN_RATIO);
  const picked: MediaTrack[] = [];

  shuffleInPlace(fresh);
  shuffleInPlace(familiar);

  for (const track of fresh) {
    if (picked.length >= DAILY_RECOMMENDATIONS_TARGET) break;
    if (canAddToPicked(track, picked, excludedVideoIds)) picked.push(track);
  }

  if (picked.length < minNew) {
    for (const track of familiar) {
      if (picked.length >= minNew) break;
      if (canAddToPicked(track, picked, excludedVideoIds)) picked.push(track);
    }
  }

  for (const track of fresh) {
    if (picked.length >= DAILY_RECOMMENDATIONS_TARGET) break;
    if (canAddToPicked(track, picked, excludedVideoIds)) picked.push(track);
  }

  for (const track of familiar) {
    if (picked.length >= DAILY_RECOMMENDATIONS_TARGET) break;
    if (canAddToPicked(track, picked, excludedVideoIds)) picked.push(track);
  }

  if (picked.length < DAILY_RECOMMENDATIONS_TARGET) {
    shuffleInPlace(eligible);
    for (const track of eligible) {
      if (picked.length >= DAILY_RECOMMENDATIONS_TARGET) break;
      if (canAddToPicked(track, picked, excludedVideoIds)) picked.push(track);
    }
  }

  return picked.slice(0, DAILY_RECOMMENDATIONS_TARGET);
}

function buildRecommendationExclusions(now = Date.now()): Set<string> {
  const excludedVideoIds = getTopSongExclusionVideoIds(now);
  for (const videoId of getYesterdayDailyRecommendationVideoIds(now)) {
    excludedVideoIds.add(videoId);
  }
  return excludedVideoIds;
}

export async function generateDailyRecommendations(now = Date.now()): Promise<MediaTrack[]> {
  const seeds = getTasteSeeds(RECOMMENDATION_SEED_LIMIT, now);
  if (seeds.length === 0) {
    storeDailyRecommendations([], now);
    return [];
  }

  const known = getRecentRecommendationVideoIds(7, now);
  const excludedVideoIds = buildRecommendationExclusions(now);
  const seedVideoIds = shuffleInPlace(seeds.map((entry) => entry.videoId));
  const gathered: MediaTrack[] = [];

  for (const seedVideoId of seedVideoIds) {
    const batch = await fetchSeedCandidates(seedVideoId);
    gathered.push(...batch);
    const unique = dedupeTracks(gathered);
    const eligibleCount = unique.filter((track) =>
      isEligibleRecommendation(track, excludedVideoIds),
    ).length;
    if (eligibleCount >= MIN_CANDIDATE_POOL) break;
  }

  if (gathered.length > 0) {
    const unique = dedupeTracks(gathered);
    const eligibleCount = unique.filter((track) =>
      isEligibleRecommendation(track, excludedVideoIds),
    ).length;
    if (eligibleCount < DAILY_RECOMMENDATIONS_TARGET) {
      for (const seedVideoId of seedVideoIds) {
        const batch = await fetchSeedCandidates(seedVideoId);
        gathered.push(...batch);
        const nextUnique = dedupeTracks(gathered);
        const nextEligible = nextUnique.filter((track) =>
          isEligibleRecommendation(track, excludedVideoIds),
        ).length;
        if (nextEligible >= DAILY_RECOMMENDATIONS_TARGET) break;
      }
    }
  }

  const unique = dedupeTracks(gathered);
  const final = pickDailyRecommendations(unique, known, excludedVideoIds);
  storeDailyRecommendations(final, now);
  return final;
}