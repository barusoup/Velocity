import { useEffect } from "react";
import type { SavedAlbum } from "../collection";
import type { MediaTrack } from "../types";
import { lookupContextTrack } from "../utils/track-context-registry";

/**
 * Global right-click handlers for song and album context menus. Song targets
 * resolve tracks via `data-track-id` (registry lookup) with a JSON
 * `data-track` fallback for rows not yet migrated.
 */
export function useGlobalContextMenus({
  onSongContextMenu,
  onAlbumContextMenu,
}: {
  onSongContextMenu: (track: MediaTrack, position: { x: number; y: number }) => void;
  onAlbumContextMenu: (album: SavedAlbum, position: { x: number; y: number }) => void;
}): void {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.button === 1) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const songTrigger = target.closest("[data-song-context-target]");
      if (songTrigger) {
        event.preventDefault();

        const trackId = songTrigger.getAttribute("data-track-id");
        if (trackId) {
          const track = lookupContextTrack(trackId);
          if (track) {
            onSongContextMenu(track, { x: event.clientX, y: event.clientY });
          }
          return;
        }

        const raw = songTrigger.getAttribute("data-track");
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as MediaTrack;
          const sourceRaw = songTrigger.getAttribute("data-track-source");
          const source: MediaTrack["source"] =
            sourceRaw === "upload" || sourceRaw === "stream"
              ? sourceRaw
              : parsed.source ?? "stream";
          onSongContextMenu(
            { ...parsed, source },
            { x: event.clientX, y: event.clientY },
          );
        } catch {
          // Ignore unparseable rows.
        }
        return;
      }
      const albumTrigger = target.closest("[data-album-context-target]");
      if (!albumTrigger) return;
      event.preventDefault();
      const raw = albumTrigger.getAttribute("data-album");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as SavedAlbum;
        onAlbumContextMenu(parsed, { x: event.clientX, y: event.clientY });
      } catch {
        // Ignore unparseable rows
      }
    };
    document.addEventListener("contextmenu", handler, { capture: true });
    return () => document.removeEventListener("contextmenu", handler, { capture: true });
  }, [onSongContextMenu, onAlbumContextMenu]);
}