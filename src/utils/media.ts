import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaTrack } from "../types";

export function formatDuration(seconds?: number | null): string {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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

export function withResolvedAudioSrc(track: MediaTrack): MediaTrack {
  if (track.source !== "upload") return track;
  let result = track;
  if (!result.audioSrc && result.filePath) {
    result = { ...result, audioSrc: convertFileSrc(result.filePath) };
  }
  if (result.cover && !result.cover.startsWith("http") && !result.cover.startsWith("data:")) {
    result = { ...result, cover: convertFileSrc(result.cover) };
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
