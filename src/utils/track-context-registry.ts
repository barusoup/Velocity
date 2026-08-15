import type { MediaTrack } from "../types";

const registry = new Map<string, MediaTrack | Set<MediaTrack>>();

/** Register a track for right-click context menu lookup by id. */
export function registerContextTrack(track: MediaTrack): () => void {
  const existing = registry.get(track.id);
  if (!existing) {
    registry.set(track.id, track);
  } else if (existing instanceof Set) {
    existing.add(track);
  } else if (existing !== track) {
    registry.set(track.id, new Set([existing, track]));
  }

  return () => {
    const current = registry.get(track.id);
    if (!current) return;
    if (current === track) {
      registry.delete(track.id);
    } else if (current instanceof Set) {
      current.delete(track);
      if (current.size === 1) {
        for (const only of current) {
          registry.set(track.id, only);
        }
      } else if (current.size === 0) {
        registry.delete(track.id);
      }
    }
  };
}

/** Resolve a context-menu track from its row's `data-track-id`. */
export function lookupContextTrack(id: string): MediaTrack | null {
  const existing = registry.get(id);
  if (!existing) return null;
  if (existing instanceof Set) {
    for (const track of existing) return track;
    return null;
  }
  return existing;
}