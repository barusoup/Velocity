import { useEffect } from "react";
import type { SavedAlbum } from "../collection";
import type { MediaTrack } from "../types";

/**
 * Two near-identical `document.addEventListener("contextmenu", …)` handlers
 * used to live in `App.tsx`: one for songs, one for albums. Both walked up
 * the DOM looking for a `data-*-context-target` attribute, parsed a JSON
 * payload from a sibling `data-*-payload` attribute, and pushed the result
 * into React state.
 *
 * This hook folds both into a single capture-phase document listener so the
 * event-handling cost is paid once per right-click instead of twice. Song
 * targets take precedence over album targets when one is nested inside
 * the other (matching the original App.tsx policy).
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
      // Middle-click is irrelevant for menu semantics. Keyboard-driven
      // contextmenu events arrive with `button === 0`; we still want to
      // surface our menus to keyboard users so they aren't locked out of
      // Go-to-Album / Save-to-collection on Shift+F10 or the Menu key.
      if (event.button === 1) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const songTrigger = target.closest("[data-song-context-target]");
      if (songTrigger) {
        event.preventDefault();
        const raw = songTrigger.getAttribute("data-track");
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as MediaTrack;
          // Preserve source if `data-track-source` was set (upload tracks
          // vs stream tracks). Default to "stream" for backward compat with
          // rows that only encode the payload.
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
          // Ignore unparseable rows — the menu only opens on valid payload.
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
