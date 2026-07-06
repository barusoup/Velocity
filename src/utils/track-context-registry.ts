import type { MediaTrack } from "../types";

const registry = new Map<string, MediaTrack>();

/** Register a track for right-click context menu lookup by id. */
export function registerContextTrack(track: MediaTrack): () => void {
  registry.set(track.id, track);
  return () => {
    if (registry.get(track.id) === track) {
      registry.delete(track.id);
    }
  };
}

/** Resolve a context-menu track from its row's `data-track-id`. */
export function lookupContextTrack(id: string): MediaTrack | null {
  return registry.get(id) ?? null;
}