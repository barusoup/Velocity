import type { DiscordPresencePayload } from "../api";
import type { MediaTrack } from "../types";
import {
  hasLocalUploadCover,
  needsYtmCoverFallback,
  type UploadDiscordCover,
} from "../utils/upload-enrichment";
import { streamIdentityVideoIds } from "../utils/media";

export const SEEK_SYNC_INTERVAL_MS = 4_000;
export const SEEK_JUMP_SECONDS = 3;
export const STARTUP_RETRY_DELAYS_MS = [400, 1_200, 3_000, 6_000] as const;
/** Re-push windows after critical transitions when IPC may still be waking up. */
export const CONFIRM_BURST_DELAYS_MS = [350, 900, 2_000, 4_500] as const;
export const STATE_MAX_CHARS = 128;

function resolveVideoId(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): string | null {
  const ids = streamIdentityVideoIds(track);
  return ids[0] ?? null;
}

function truncateState(value: string): string {
  if (value.length <= STATE_MAX_CHARS) return value;
  return `${value.slice(0, STATE_MAX_CHARS - 1)}…`;
}

/** Only the live player duration drives Discord timestamps — not cached track metadata. */
function trackDurationSeconds(duration: number): number {
  return duration > 0 ? duration : 0;
}

export function trackArtKey(track: MediaTrack): string {
  return [
    track.cover ?? "",
    track.coverFilePath ?? "",
    track.videoId ?? "",
    track.resolvedVideoId ?? "",
  ].join("|");
}

function buildListeningState(track: MediaTrack): string {
  const artist = track.artist?.trim();
  const album = track.album?.trim();
  if (artist && album) return truncateState(`${artist} · ${album}`);
  if (artist) return truncateState(artist);
  if (album) return truncateState(album);
  return "";
}

export function buildTimestamps(
  progress: number,
  duration: number,
  _track: MediaTrack,
  nowMs: number,
): { startedAt: number; endsAt: number } | null {
  const trackDuration = trackDurationSeconds(duration);
  if (trackDuration <= 0) return null;

  const progressMs = Math.max(0, Math.floor(progress * 1000));
  const durationMs = Math.max(1, Math.floor(trackDuration * 1000));
  const startedAt = nowMs - progressMs;
  const endsAt = startedAt + durationMs;

  return { startedAt, endsAt };
}

export function isPlaybackFrozen(isPlaying: boolean, isBuffering: boolean): boolean {
  return !isPlaying || isBuffering;
}

function discordArtForTrack(
  track: MediaTrack,
  uploadCoverCache: ReadonlyMap<string, UploadDiscordCover>,
): { coverUrl: string | null; videoId: string | null } {
  if (hasLocalUploadCover(track)) {
    return {
      coverUrl: track.coverFilePath ?? track.cover ?? null,
      videoId: resolveVideoId(track),
    };
  }

  if (needsYtmCoverFallback(track)) {
    const cached = uploadCoverCache.get(track.id);
    if (cached) {
      return {
        coverUrl: cached.coverUrl,
        videoId: cached.videoId ?? resolveVideoId(track),
      };
    }
    return { coverUrl: null, videoId: resolveVideoId(track) };
  }

  return {
    coverUrl: track.cover ?? null,
    videoId: resolveVideoId(track),
  };
}

export function buildPresencePayload(
  enabled: boolean,
  track: MediaTrack | null,
  progress: number,
  duration: number,
  frozen: boolean,
  uploadCoverCache: ReadonlyMap<string, UploadDiscordCover>,
  nowMs: number,
): DiscordPresencePayload {
  if (!enabled) {
    return { enabled: false };
  }
  if (!track) {
    return { enabled: true };
  }

  const timestamps = frozen
    ? null
    : buildTimestamps(progress, duration, track, nowMs);
  const art = discordArtForTrack(track, uploadCoverCache);

  return {
    enabled: true,
    paused: frozen,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    state: buildListeningState(track),
    coverUrl: art.coverUrl,
    videoId: art.videoId,
    startedAt: timestamps?.startedAt ?? null,
    endsAt: timestamps?.endsAt ?? null,
  };
}

export function payloadKey(payload: DiscordPresencePayload): string {
  return JSON.stringify(payload);
}