import { sanitizeFilename } from "./media";

/**
 * Split a full file path returned by the native save dialog into { dir, stem }.
 * The dialog returns `C:\Music\foo.mp3` — we hand the Rust side `targetDir` + `fileName`
 * so it can do non-clobber checks and re-append the extension.
 */
export function splitDirAndName(path: string): { dir: string; stem: string } | null {
  const lastSep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (lastSep < 0) {
    return { dir: ".", stem: stripExtension(path) };
  }
  const dir = path.slice(0, lastSep);
  const name = path.slice(lastSep + 1);
  if (!dir || !name) return null;
  return { dir, stem: stripExtension(name) };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/**
 * Build a safe default filename for a track/album/playlist.
 * Mirrors the sanitization used by the Rust backend as defense-in-depth.
 */
export function safeTrackFileName(title: string | null | undefined): string {
  return sanitizeFilename(title?.trim() ? title!.trim() : "track");
}

export function safeAlbumFileName(title: string | null | undefined): string {
  return sanitizeFilename(title?.trim() ? title!.trim() : "Album");
}

export function safePlaylistFileName(title: string | null | undefined): string {
  return sanitizeFilename(title?.trim() ? title!.trim() : "Playlist");
}

/**
 * Shared error message extraction for save dialogs.
 */
export function saveDialogErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Could not open the save dialog.";
}
