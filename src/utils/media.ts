import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaTrack } from "../types";

/** YT Music type labels that are never playable as songs in Velocity. */
const EXCLUDED_NON_MUSIC_STREAM_KINDS = new Set([
  "episode",
  "podcast",
  "mix",
  "video",
  "unknown",
]);

export function isExcludedNonMusicStreamKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return EXCLUDED_NON_MUSIC_STREAM_KINDS.has(kind.trim().toLowerCase());
}

/**
 * Whether a track may appear in the queue or album/playlist track lists.
 * Uploads are always queueable. Stream tracks with no kind are treated as
 * songs (typical album/playlist rows). Music videos and other non-song media
 * are excluded — they must not masquerade as songs in the player UI.
 */
export function isQueueableTrack(track: MediaTrack): boolean {
  if (track.source === "upload") return true;
  return !isExcludedNonMusicStreamKind(track.kind);
}

export function filterQueueableTracks(tracks: readonly MediaTrack[]): MediaTrack[] {
  return tracks.filter(isQueueableTrack);
}

/** Watch-playlist rows that autoplay may attempt to resolve into songs. */
export function isAutoplayWatchPlaylistCandidate(
  track: Pick<MediaTrack, "kind">,
): boolean {
  if (track.kind === "video") return true;
  return !isExcludedNonMusicStreamKind(track.kind);
}

/**
 * Remap a play-many start index after non-queueable tracks are removed.
 * When the clicked row was filtered out, play the next queueable track
 * at or after that position; otherwise fall back to the first queueable row.
 */
export function remapQueueStartIndex(
  original: readonly MediaTrack[],
  queueable: readonly MediaTrack[],
  startIndex: number,
): number {
  if (queueable.length === 0) return 0;
  const clamped = Math.max(0, Math.min(startIndex, original.length - 1));
  const targetId = original[clamped]?.id;
  const direct = queueable.findIndex((track) => track.id === targetId);
  if (direct >= 0) return direct;
  for (let index = clamped; index < original.length; index += 1) {
    const mapped = queueable.findIndex((track) => track.id === original[index]?.id);
    if (mapped >= 0) return mapped;
  }
  return 0;
}

// Strip queue-placement metadata (`_labelOrigin`) from a track before
// passing it across trust boundaries — into the playlist store, into
// localStorage, or back to the Rust pipeline. The field is purely an
// in-memory annotation used to label per-origin queue sections, never
// part of a track's declared identity, so it should never leak into the
// on-disk JSON. The returned type stays as `T` because `_labelOrigin`
// isn't declared on `MediaTrack` — this is a runtime strip the type
// system can't see.
export function stripQueueMetadata<T extends Partial<MediaTrack>>(track: T): T {
  const { _labelOrigin: _lo, ...rest } = track as Partial<MediaTrack> & Record<string, unknown>;
  void _lo;
  return rest as T;
}

export function formatDuration(seconds?: number | null): string {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Best-effort duration from a live media element plus optional track metadata. */
export function readLiveMediaDuration(
  audio: HTMLAudioElement | null | undefined,
  trackDurationSeconds?: number | null,
): number {
  if (audio) {
    const direct = audio.duration;
    if (Number.isFinite(direct) && direct > 0) return direct;
    if (audio.seekable.length > 0) {
      const end = audio.seekable.end(audio.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
  }
  if (
    typeof trackDurationSeconds === "number" &&
    Number.isFinite(trackDurationSeconds) &&
    trackDurationSeconds > 0
  ) {
    return trackDurationSeconds;
  }
  return 0;
}

export function formatOptionalDuration(seconds?: number | null): string {
  return Number.isFinite(seconds) && seconds != null && seconds >= 0 ? formatDuration(seconds) : "";
}

export function formatPlayCount(playCount?: string | null): string {
  return playCount?.trim() ?? "";
}

export function trimExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
}

// Cross-platform FS-safe filename sanitizer. Used by every "Save to my
// device" menu (song / album / playlist) to pre-fill the native picker
// with a name the OS will accept, and matched by the Rust side as
// defense-in-depth. We only sanitize the field the dialog is pre-filling
// — the backend re-validates per-character before writing anything to disk
// so a stale frontend sanitizer (e.g. one that forgot a colon on macOS)
// can never corrupt a real export.
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[\s.]+$/g, "")
    .trim();
  return cleaned || "track";
}

export function withResolvedAudioSrc(track: MediaTrack): MediaTrack {
  if (track.source !== "upload") return track;
  let result = track;
  if (!result.audioSrc && result.filePath) {
    result = { ...result, audioSrc: convertFileSrc(result.filePath) };
  }
  if (result.cover && !result.cover.startsWith("http") && !result.cover.startsWith("data:")) {
    result = {
      ...result,
      coverFilePath: result.cover,
      cover: convertFileSrc(result.cover),
    };
  }
  return result;
}

export async function readFileImports(
  files: FileList | File[],
): Promise<Array<{ name: string; bytes: number[] }>> {
  const audioFiles = Array.from(files).filter((file) => file.type.startsWith("audio/"));
  return Promise.all(
    audioFiles.map(async (file) => ({
      name: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    })),
  );
}

/** Parse the YouTube video id embedded in a stream track id (`yt:vid` or `yt:vid:album`). */
export function streamVideoIdFromTrackId(trackId: string): string | null {
  if (!trackId.startsWith("yt:")) return null;
  const payload = trackId.slice(3);
  if (!payload) return null;
  const sep = payload.indexOf(":");
  return sep === -1 ? payload : payload.slice(0, sep);
}

/**
 * Canonical YouTube video id for yt-dlp "Save to my device" exports.
 * Matches stream playback (`resolvedVideoId ?? videoId`) and never
 * passes a raw `yt:…` track id to the backend.
 */
export function exportStreamVideoId(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): string | null {
  if (track.source === "upload") return null;
  return track.resolvedVideoId ?? track.videoId ?? streamVideoIdFromTrackId(track.id);
}

/** Video ids that identify the same underlying stream audio for a track. */
export function streamIdentityVideoIds(
  track: Pick<MediaTrack, "id" | "videoId" | "resolvedVideoId" | "source">,
): string[] {
  const ids = new Set<string>();
  if (track.videoId) ids.add(track.videoId);
  if (track.resolvedVideoId) ids.add(track.resolvedVideoId);
  if (ids.size === 0) {
    const fromId = streamVideoIdFromTrackId(track.id);
    if (fromId) ids.add(fromId);
  }
  return [...ids];
}

/**
 * Minimal shape needed to recognize a track as the underlying song.
 * `artist`/`title` are optional because callers rebuilding a candidate
 * from a `SearchItem` or other partial source may not have them — when
 * missing, only the video-id / id match path applies.
 */
export type SongIdentityInput = Pick<
  MediaTrack,
  "id" | "videoId" | "resolvedVideoId" | "source"
> & {
  artist?: string | null;
  title?: string | null;
};

function songIdentityLabel(track: SongIdentityInput): string | null {
  if (track.source === "upload") return null;
  const artist = track.artist?.trim() ?? "";
  const title = track.title?.trim() ?? "";
  if (!artist || !title) return null;
  return `${artist.toLowerCase()}\0${title.toLowerCase()}`;
}

/**
 * Whether two tracks are the same stream playback target (shared video id).
 * Used for row active-state and play/pause toggles — must not treat distinct
 * queue rows (e.g. music-video vs studio uploads of one song) as the same row.
 */
export function isSameStreamPlayback(
  current: SongIdentityInput | null,
  candidate: SongIdentityInput,
): boolean {
  if (!current) return false;
  if (current.source === "upload" || candidate.source === "upload") {
    return current.id === candidate.id;
  }
  const currentIds = streamIdentityVideoIds(current);
  const candidateIds = streamIdentityVideoIds(candidate);
  if (currentIds.length === 0 || candidateIds.length === 0) {
    return current.id === candidate.id;
  }
  return currentIds.some((id) => candidateIds.includes(id));
}

/**
 * Whether two tracks are the same underlying song, regardless of
 * release-scoped id or where playback was started (search, album, playlist).
 * Falls back to artist+title when video ids do not overlap (dedupe, search).
 */
export function isSameSongTrack(
  current: SongIdentityInput | null,
  candidate: SongIdentityInput,
): boolean {
  if (isSameStreamPlayback(current, candidate)) return true;

  const currentLabel = songIdentityLabel(current);
  const candidateLabel = songIdentityLabel(candidate);
  return Boolean(currentLabel && candidateLabel && currentLabel === candidateLabel);
}

const MUSIC_VIDEO_TITLE_MARKERS =
  /\b(official\s+)?music\s+video\b|\bofficial\s+video\b|\(mv\)|\[mv\]/i;

/** Whether a stream row likely points at a music video rather than studio audio. */
export function isLikelyMusicVideoTrack(
  track: Pick<MediaTrack, "kind" | "title" | "videoId" | "resolvedVideoId">,
): boolean {
  if (track.kind === "video") return true;
  if (MUSIC_VIDEO_TITLE_MARKERS.test(track.title)) return true;
  const resolvedVideoId = track.resolvedVideoId?.trim();
  const videoId = track.videoId?.trim();
  if (resolvedVideoId && videoId && resolvedVideoId !== videoId) return false;
  return false;
}

/** Higher rank means a better playback/display target for the same underlying song. */
export function trackPlaybackPreferenceRank(
  track: Pick<MediaTrack, "kind" | "title" | "videoId" | "resolvedVideoId" | "source">,
): number {
  if (track.source === "upload") return 0;
  let rank = 0;
  const resolvedVideoId = track.resolvedVideoId?.trim();
  const videoId = track.videoId?.trim();
  if (resolvedVideoId && videoId && resolvedVideoId !== videoId) rank += 100;
  if (track.kind !== "video") rank += 50;
  if (!MUSIC_VIDEO_TITLE_MARKERS.test(track.title)) rank += 25;
  if (isQueueableTrack(track as MediaTrack)) rank += 10;
  return rank;
}

/** Pick the studio-audio row when two tracks represent the same song. */
export function preferStudioSongTrack(current: MediaTrack, candidate: MediaTrack): MediaTrack {
  const currentRank = trackPlaybackPreferenceRank(current);
  const candidateRank = trackPlaybackPreferenceRank(candidate);
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  // Later rows are usually from resolution passes and tend to be studio audio.
  return candidate;
}

/** Keep one row per underlying song, preferring studio audio over music videos. */
export function dedupeTracksBySong(tracks: MediaTrack[]): MediaTrack[] {
  const unique: MediaTrack[] = [];
  for (const track of tracks) {
    const existingIndex = unique.findIndex((row) => isSameSongTrack(row, track));
    if (existingIndex < 0) {
      unique.push(track);
      continue;
    }
    unique[existingIndex] = preferStudioSongTrack(unique[existingIndex]!, track);
  }
  return unique;
}

export function readDuration(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = src;
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
    };
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration) : null;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}
