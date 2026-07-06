import { useEffect } from "react";
import type { MediaTrack } from "../types";
import { registerContextTrack } from "../utils/track-context-registry";

export type ContextTrackTargetProps = {
  "data-song-context-target": "true";
  "data-track-id": string;
  "data-track-source": MediaTrack["source"];
};

/** Registers the track for context-menu lookup and returns row data attributes. */
export function useContextTrackTarget(
  track: MediaTrack,
  enabled = true,
): Partial<ContextTrackTargetProps> {
  useEffect(() => {
    if (!enabled) return;
    return registerContextTrack(track);
  }, [track, enabled]);

  if (!enabled) return {};

  return {
    "data-song-context-target": "true",
    "data-track-id": track.id,
    "data-track-source": track.source ?? "stream",
  };
}