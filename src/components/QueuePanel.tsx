import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripVertical, History, List, Pause, Play, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { usePlayerActions, usePlayerState } from "../player";
import type { MediaTrack } from "../types";
import { formatDuration } from "../utils/media";
import { rgbToCss } from "../utils/artwork-color";
import { ArtworkImage, DefaultArtwork, getArtworkRoundedClass } from "./Shared";
import { ArtistCreditText, DEFAULT_ALBUM_ACCENT, useTrackAccents } from "./PagesShared";
import type { View } from "./Sidebar";
import { getDirectArtistBrowseId, resolveArtistBrowseId } from "../utils/navigation";
import { VirtualList } from "./VirtualList";

type QueueTab = "queued" | "recent";
type DragOverlayFrame = { top: number; left: number; width: number };

const ROW_HEIGHT = 56;

function clamp01(v: number) { return Math.min(1, Math.max(0, v)); }

function muteForOverlay(c: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return c;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;

  const newS = clamp01(s * 0.45);
  const newL = clamp01(l * 0.62);

  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * newL - 1)) * newS;
  const seg = hue / 60;
  const x = chroma * (1 - Math.abs((seg % 2) - 1));
  const m = newL - chroma / 2;
  let rr = 0, gg = 0, bb = 0;
  if (seg < 1)      { rr = chroma; gg = x; }
  else if (seg < 2) { rr = x; gg = chroma; }
  else if (seg < 3) { gg = chroma; bb = x; }
  else if (seg < 4) { gg = x; bb = chroma; }
  else if (seg < 5) { rr = x; bb = chroma; }
  else              { rr = chroma; bb = x; }
  return { r: Math.round((rr + m) * 255), g: Math.round((gg + m) * 255), b: Math.round((bb + m) * 255) };
}

export function QueuePanel({ open, onNavigate }: { open: boolean; onNavigate: (view: View) => void }) {
  const player = usePlayerState();
  const playerActions = usePlayerActions();
  const [tab, setTab] = useState<QueueTab>("queued");
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowLayoutRef = useRef<{ queueIndex: number; top: number; height: number }[]>([]);
  const suppressNextQueueClickRef = useRef(false);

  // Live drag state, mirrored into React state only when something changes that
  // the DOM must reflect (overlay position, which row is lifted, where the gap is).
  const dragState = useRef<{
    fromIndex: number;
    overIndex: number;
    pointerId: number;
    grabOffsetX: number;
    grabOffsetY: number;
    originLeft: number;
    originTop: number;
    originWidth: number;
    lastClientX: number;
    lastClientY: number;
    pendingPointerMove: boolean;
    raf: number;
    autoscrollRaf: number;
    moved: boolean;
  } | null>(null);

  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // Mirrors dragState.current.lastClientY into React state during an active
  // drag so the overlay repaints each pointermove. The dragState ref updates
  // synchronously but doesn't drive a render — we still need a state tick
  // for the overlay's style.top to track the cursor.
  const [dragOverlayFrame, setDragOverlayFrame] = useState<DragOverlayFrame | null>(null);

  const futureTracks = useMemo(
    () => player.queue.slice(player.queueIndex + 1).map((track, offset) => ({
      track,
      queueIndex: player.queueIndex + 1 + offset,
      autoplay: player.autoplayTrackIds.has(track.id),
    })),
    [player.autoplayTrackIds, player.queue, player.queueIndex],
  );
  const allTracks = useMemo(() => {
    const list: { cover?: string | null }[] = [];
    if (player.currentTrack) list.push(player.currentTrack);
    for (const entry of futureTracks) list.push(entry.track);
    return list;
  }, [player.currentTrack, futureTracks]);

  const accentColors = useTrackAccents(open ? allTracks : []);

  const accentMap = useMemo(() => {
    const map = new Map<string, { r: number; g: number; b: number }>();
    for (let i = 0; i < allTracks.length; i++) {
      const cover = allTracks[i]?.cover;
      if (cover && accentColors[i]) {
        map.set(cover, accentColors[i]!);
      }
    }
    return map;
  }, [allTracks, accentColors]);

  useLayoutEffect(() => {
    if (!open || dragState.current?.moved) return;
    const listEl = listRef.current;
    if (!listEl) { rowLayoutRef.current = []; return; }
    const rows = listEl.querySelectorAll<HTMLElement>("[data-queue-index]");
    const listTop = listEl.getBoundingClientRect().top;
    const layout: { queueIndex: number; top: number; height: number }[] = [];
    for (const row of rows) {
      const qi = Number(row.dataset.queueIndex);
      const rect = row.getBoundingClientRect();
      layout.push({ queueIndex: qi, top: rect.top - listTop, height: rect.height });
    }
    rowLayoutRef.current = layout;
  }, [open, futureTracks.length, dragFromIndex]);

  const measureQueueRows = useCallback(() => {
    const listEl = listRef.current;
    if (!listEl) { rowLayoutRef.current = []; return; }
    const rows = listEl.querySelectorAll<HTMLElement>("[data-queue-index]");
    const listTop = listEl.getBoundingClientRect().top;
    const layout: { queueIndex: number; top: number; height: number }[] = [];
    for (const row of rows) {
      const qi = Number(row.dataset.queueIndex);
      if (!Number.isFinite(qi)) continue;
      const rect = row.getBoundingClientRect();
      layout.push({ queueIndex: qi, top: rect.top - listTop, height: rect.height });
    }
    rowLayoutRef.current = layout;
  }, []);

  const getTrackSectionLabel = useCallback((entry: { track: MediaTrack; autoplay: boolean }): string => {
    if (entry.autoplay) return "Autoplay";
    const origin = entry.track._labelOrigin;
    if (origin?.kind === "album") return `Next from ${origin.name || entry.track.album || "this album"}`;
    if (origin?.kind === "artist") return `Next from ${origin.name || "this artist"}`;
    if (origin?.kind === "playlist") return `Next from ${origin.name || "this playlist"}`;
    if (origin?.kind === "user-playlist") {
      return `Next from ${origin.name || "this playlist"}`;
    }
    return "Up next";
  }, []);

  const getTrackAtIndex = useCallback((index: number) => {
    if (index === player.queueIndex) return player.currentTrack;
    const futureIndex = index - player.queueIndex - 1;
    if (futureIndex >= 0 && futureIndex < futureTracks.length) return futureTracks[futureIndex].track;
    return null;
  }, [player.currentTrack, player.queueIndex, futureTracks]);

  const handlePointerDragStart = (event: ReactPointerEvent<HTMLDivElement>, queueIndex: number) => {
    if (event.button !== 0) return;

    const rowEl = event.currentTarget.closest("[data-queue-index]") as HTMLElement | null;
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (!rowEl || !listEl || !scrollEl) return;
    measureQueueRows();
    const rect = rowEl.getBoundingClientRect();
    dragState.current = {
      fromIndex: queueIndex,
      overIndex: queueIndex,
      pointerId: event.pointerId,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      originLeft: rect.left,
      originTop: rect.top,
      originWidth: rect.width,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      pendingPointerMove: false,
      raf: 0,
      autoscrollRaf: 0,
      moved: false,
    };
    setDragOverlayFrame({ top: rect.top, left: rect.left, width: rect.width });
  };

  // Core drag loop. Runs for the lifetime of a drag (from the first pointermove
  // that exceeds the threshold until pointerup). Kept in a stable effect so the
  // listeners (and their RAF handles) aren't torn down and recreated on every
  // state change.
  useEffect(() => {
    const DRAG_THRESHOLD = 4; // px before a press becomes a drag
    const AUTOSCROLL_EDGE = 56; // px band at top/bottom of viewport that triggers autoscroll
    const AUTOSCROLL_MAX_SPEED = 14; // px per frame

    const recomputeOverIndex = (clientY: number) => {
      const drag = dragState.current;
      const listEl = listRef.current;
      const scrollEl = scrollRef.current;
      const layout = rowLayoutRef.current;
      if (!drag || !listEl || !scrollEl || layout.length === 0) return;

      const listRect = listEl.getBoundingClientRect();
      // Pointer position in the list's scroll-content space. Both this and the
      // snapshot below live in content space, so the comparison is correct
      // regardless of how far the list has scrolled during the drag.
      const relY = clientY - listRect.top;

      // Find the first row whose vertical midpoint the pointer has not passed.
      // The gap is drawn before that row. If every midpoint is above the
      // pointer, the gap sits at the end of the queue.
      let overQueueIndex = layout[layout.length - 1].queueIndex + 1;
      for (const row of layout) {
        if (relY < row.top + row.height / 2) {
          overQueueIndex = row.queueIndex;
          break;
        }
      }

      // Clamp so the dragged item cannot slide before the currently playing
      // track or after the last queued item.
      const minIndex = player.queueIndex + 1;
      const maxIndex = player.queueIndex + futureTracks.length;
      overQueueIndex = Math.max(minIndex, Math.min(maxIndex + 1, overQueueIndex));

      if (overQueueIndex !== drag.overIndex) {
        drag.overIndex = overQueueIndex;
        setDragOverIndex(overQueueIndex);
      }
    };

    const runAutoscroll = () => {
      const drag = dragState.current;
      const scrollEl = scrollRef.current;
      if (!drag || !scrollEl) {
        dragState.current && (dragState.current.autoscrollRaf = 0);
        return;
      }
      const rect = scrollEl.getBoundingClientRect();
      const y = drag.lastClientY;
      let delta = 0;
      if (y < rect.top + AUTOSCROLL_EDGE) {
        const intensity = 1 - Math.min(1, (y - rect.top) / AUTOSCROLL_EDGE);
        delta = -AUTOSCROLL_MAX_SPEED * intensity;
      } else if (y > rect.bottom - AUTOSCROLL_EDGE) {
        const intensity = 1 - Math.min(1, (rect.bottom - y) / AUTOSCROLL_EDGE);
        delta = AUTOSCROLL_MAX_SPEED * intensity;
      }
      if (delta !== 0) {
        scrollEl.scrollTop += delta;
        // Recompute the over index since the content scrolled under the pointer.
        recomputeOverIndex(drag.lastClientY);
      }
      if (drag.moved) {
        drag.autoscrollRaf = requestAnimationFrame(runAutoscroll);
      } else {
        drag.autoscrollRaf = 0;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragState.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      drag.lastClientX = event.clientX;
      drag.lastClientY = event.clientY;
      // Repaint the overlay each pointermove (it derives style.top from
      // cursorY — grabOffsetY). Without this state tick the overlay would
      // freeze until the row under the cursor changes.
      // Clamp overlay top so it cannot visually escape the scroll container
      // or overlap the first section header above the queue rows.
      const scrollEl = scrollRef.current;
      let overlayTop = event.clientY - drag.grabOffsetY;
      if (scrollEl) {
        const scrollRect = scrollEl.getBoundingClientRect();
        const overlayHeight = ROW_HEIGHT;
        const layout = rowLayoutRef.current;
        const listEl = listRef.current;
        let minTop = scrollRect.top;
        if (listEl && layout.length > 0) {
          const listRect = listEl.getBoundingClientRect();
          minTop = listRect.top + layout[0].top;
        }
        overlayTop = Math.max(minTop, Math.min(scrollRect.bottom - overlayHeight, overlayTop));
      }
      setDragOverlayFrame({
        top: overlayTop,
        left: drag.originLeft,
        width: drag.originWidth,
      });

      // Promote to an active drag only once the pointer has moved past the
      // threshold. This keeps a plain click on the grip from flashing the overlay.
      if (!drag.moved) {
        const dx = event.clientX - drag.originLeft - drag.grabOffsetX;
        const dy = event.clientY - drag.originTop - drag.grabOffsetY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        setDragFromIndex(drag.fromIndex);
        setDragOverIndex(drag.overIndex);
        setDragOverlayFrame({
          top: overlayTop,
          left: drag.originLeft,
          width: drag.originWidth,
        });
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        if (!drag.autoscrollRaf) drag.autoscrollRaf = requestAnimationFrame(runAutoscroll);
      }

      event.preventDefault();

      if (drag.pendingPointerMove) return;
      drag.pendingPointerMove = true;
      drag.raf = requestAnimationFrame(() => {
        const d = dragState.current;
        if (!d) return;
        d.pendingPointerMove = false;
        d.raf = 0;
        recomputeOverIndex(d.lastClientY);
      });
    };

    const finishDrag = (event: PointerEvent) => {
      const drag = dragState.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.raf) cancelAnimationFrame(drag.raf);
      if (drag.autoscrollRaf) cancelAnimationFrame(drag.autoscrollRaf);

      const wasDrag = drag.moved;
      const from = drag.fromIndex;
      const over = drag.overIndex;

      dragState.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDragFromIndex(null);
      setDragOverIndex(null);
      setDragOverlayFrame(null);
      suppressNextQueueClickRef.current = wasDrag;
      if (wasDrag) {
        window.setTimeout(() => {
          suppressNextQueueClickRef.current = false;
        }, 0);
      }

      // Only commit a reorder if the pointer actually dragged. A click that
      // never crossed the threshold should not move anything.
      if (wasDrag && over !== from) {
        // `over` is the queue index of the row the gap currently sits before.
        // When moving down, removing the dragged item shifts that target row one
        // slot earlier, so the insert index needs the same one-slot adjustment.
        playerActions.moveQueueItem(from, from < over ? over - 1 : over);
      }
    };

    document.addEventListener("pointermove", handlePointerMove, { passive: false });
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", finishDrag);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", finishDrag);
      document.removeEventListener("pointercancel", finishDrag);
      const d = dragState.current;
      if (d) {
        if (d.raf) cancelAnimationFrame(d.raf);
        if (d.autoscrollRaf) cancelAnimationFrame(d.autoscrollRaf);
      }
    };
  }, [playerActions.moveQueueItem, player.queueIndex]);

  const getRowShift = (queueIndex: number): number => {
    if (dragFromIndex === null || dragOverIndex === null) return 0;
    if (queueIndex === dragFromIndex) return 0;
    if (queueIndex <= player.queueIndex) return 0;

    if (dragFromIndex < dragOverIndex) {
      if (queueIndex > dragFromIndex && queueIndex < dragOverIndex) return -ROW_HEIGHT;
    } else if (dragFromIndex > dragOverIndex) {
      if (queueIndex >= dragOverIndex && queueIndex < dragFromIndex) return ROW_HEIGHT;
    }
    return 0;
  };

  const draggedTrack = dragFromIndex !== null ? getTrackAtIndex(dragFromIndex) : null;
  const draggedAccent = useMemo(() => {
    if (!draggedTrack) return DEFAULT_ALBUM_ACCENT;
    const cover = draggedTrack.cover;
    return (cover ? accentMap.get(cover) : undefined) ?? DEFAULT_ALBUM_ACCENT;
  }, [draggedTrack, accentMap]);
  const draggedBannerColor = useMemo(() => {
    return rgbToCss(muteForOverlay(draggedAccent));
  }, [draggedAccent]);
  const runQueueClick = (action: () => void) => {
    if (suppressNextQueueClickRef.current) {
      suppressNextQueueClickRef.current = false;
      return;
    }
    action();
  };

  return (
    <>
    <section
      className={`queue-panel absolute bottom-[calc(100%+0.75rem)] right-0 z-20 flex h-[min(31rem,calc(100dvh-var(--ui-player-height)-2.75rem))] w-[min(28rem,calc(100vw-var(--ui-sidebar-closed)-2rem))] origin-bottom-right transform-gpu flex-col overflow-hidden rounded-xl border border-white/12 bg-neutral-950/90 shadow-[0_22px_80px_rgba(0,0,0,0.55)] backdrop-blur-md transition-[opacity,transform] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
        open
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-0 opacity-0"
      }`}
      aria-label="Playback queue"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="flex shrink-0 items-center border-b border-white/10 px-4 pt-3">
        <div className="flex h-10 items-end gap-5" role="tablist" aria-label="Queue views">
          <QueueTabButton
            active={tab === "queued"}
            icon={<List size={16} />}
            label="Queued"
            onClick={() => setTab("queued")}
          />
          <QueueTabButton
            active={tab === "recent"}
            icon={<History size={16} />}
            label="Recently Played"
            onClick={() => setTab("recent")}
          />
          <button
            type="button"
            onClick={() => (tab === "queued" ? playerActions.clearQueue() : playerActions.clearPlaybackHistory())}
            className="ml-auto flex h-10 items-center gap-2 whitespace-nowrap text-sm font-semibold text-white/48 transition-colors hover:text-white/78"
            title={tab === "queued" ? "Clear all upcoming tracks from the queue" : "Clear recently played history"}
          >
            <Trash2 size={16} />
            <span>Clear All</span>
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="nice-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-5 pt-3">
        {tab === "queued" ? (
          <>
            {player.currentTrack && (
              <QueueSection label="Now playing">
                <QueueTrackRow
                  track={player.currentTrack}
                  active
                  playing={player.isPlaying}
                  buffering={player.isBuffering}
                  onClick={playerActions.togglePlay}
                  onNavigate={onNavigate}
                />
              </QueueSection>
            )}

            {futureTracks.length > 0 ? (
              <div ref={listRef} className="mt-4 relative">
                {futureTracks.map((entry, index) => {
                  const prior = futureTracks[index - 1];
                  const sectionLabel = getTrackSectionLabel(entry);
                  const priorLabel = prior ? getTrackSectionLabel(prior) : null;
                  const startsSection = index === 0 || prior?.autoplay !== entry.autoplay || priorLabel !== sectionLabel;
                  const shift = getRowShift(entry.queueIndex);
                  const isGapAtFirstSection = index === 0 && startsSection && dragOverIndex === entry.queueIndex;

                  return (
                    <div key={`${entry.track.id}-${entry.queueIndex}`}>
                      {startsSection && (
                        <div
                          className="flex items-center gap-1.5 px-3 pb-1.5 pt-2 text-[12px] font-semibold text-white/42"
                          style={{
                            transform: `translateY(${isGapAtFirstSection ? 0 : shift}px)`,
                            transition: dragFromIndex !== null ? "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
                          }}
                        >
                          <span>{sectionLabel}</span>
                          {entry.autoplay && (
                            <button
                              type="button"
                              onClick={() => playerActions.reloadAutoplay()}
                              disabled={player.autoplaySeed?.videoId === player.currentTrack?.videoId || player.isReloadingAutoplay}
                              aria-label="Reload autoplay"
                              className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-150 ${
                                player.autoplaySeed?.videoId === player.currentTrack?.videoId || player.isReloadingAutoplay
                                  ? "pointer-events-none text-white/20"
                                  : "text-white/42 hover:text-white/80"
                              }`}
                            >
                              <RefreshCw size={12} className={player.isReloadingAutoplay ? "animate-spin" : ""} />
                            </button>
                          )}
                        </div>
                      )}
                      <div
                        style={{
                          transform: `translateY(${shift}px)`,
                          transition: dragFromIndex !== null ? "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
                        }}
                      >
                        <QueueTrackRow
                          track={entry.track}
                          queueIndex={entry.queueIndex}
                          isDragged={dragFromIndex === entry.queueIndex}
                          dragging={dragFromIndex !== null}
                          onClick={() => runQueueClick(() => playerActions.playQueueIndex(entry.queueIndex, entry.track.id))}
                          onPointerDragStart={(event) => handlePointerDragStart(event, entry.queueIndex)}
                          onNavigate={onNavigate}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              player.autoplay ? <AutoplayLoading /> : <EmptyQueue label="The queue ends here" />
            )}
          </>
        ) : player.recentlyPlayed.length > 0 ? (
          <QueueSection label="Recently played">
            <VirtualList
              items={player.recentlyPlayed}
              estimateSize={ROW_HEIGHT}
              scrollElement={scrollRef}
              overscan={8}
              getItemKey={(entry) =>
                entry.historyIndex >= 0
                  ? `${entry.track.id}-history-${entry.historyIndex}`
                  : `${entry.track.id}-queue-${entry.queueIndex}`
              }
              renderItem={(entry) => (
                <QueueTrackRow
                  track={entry.track}
                  onClick={() => {
                    if (entry.historyIndex >= 0) {
                      playerActions.restoreHistoryEntry(entry.historyIndex);
                      return;
                    }
                    if (typeof entry.queueIndex === "number") {
                      playerActions.playQueueIndex(entry.queueIndex, entry.track.id);
                    }
                  }}
                  onNavigate={onNavigate}
                />
              )}
            />
          </QueueSection>
        ) : (
          <EmptyQueue label="Songs you finish or skip will appear here" />
        )}
      </div>
    </section>
      {draggedTrack && dragFromIndex !== null && dragOverlayFrame !== null && typeof document !== "undefined"
        ? createPortal(
          <DragOverlay
            track={draggedTrack}
            frame={dragOverlayFrame}
            color={draggedBannerColor}
          />,
          document.body,
        )
        : null}
    </>
  );
}

function DragOverlay({
  track,
  frame,
  color,
}: {
  track: MediaTrack;
  frame: DragOverlayFrame;
  color: string;
}) {
  return (
    <div
      className="queue-drag-overlay pointer-events-none fixed z-[9999] flex h-14 items-center gap-2 rounded-lg px-2"
      style={{
        top: frame.top,
        left: frame.left,
        width: frame.width,
        backgroundColor: color,
      }}
    >
      <span className="flex h-9 w-5 shrink-0 items-center justify-center text-white/58">
        <GripVertical size={16} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className={`h-10 w-10 shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`}>
          {track.cover ? (
            <ArtworkImage src={track.cover} className="h-full w-full object-cover" />
          ) : (
            <DefaultArtwork />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{track.title}</span>
          <span className="mt-0.5 block truncate text-xs text-white/46">{track.artist}</span>
        </span>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/38">
          {track.durationSeconds ? formatDuration(track.durationSeconds) : ""}
        </span>
      </span>
    </div>
  );
}

function QueueTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex h-10 items-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors ${
        active ? "text-white" : "text-white/48 hover:text-white/78"
      }`}
    >
      {icon}
      <span>{label}</span>
      <span
        className={`absolute inset-x-0 bottom-0 h-0.5 bg-white transition-transform duration-150 ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

function QueueSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pb-1.5 text-[12px] font-semibold text-white/42">{label}</div>
      {children}
    </div>
  );
}

function QueueTrackRow({
  track,
  active,
  playing,
  buffering,
  queueIndex,
  isDragged,
  dragging,
  onClick,
  onPointerDragStart,
  onNavigate,
}: {
  track: MediaTrack;
  active?: boolean;
  playing?: boolean;
  buffering?: boolean;
  queueIndex?: number;
  isDragged?: boolean;
  dragging?: boolean;
  onClick: () => void;
  onPointerDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onNavigate?: (view: View) => void;
}) {
  const directArtistBrowseId = getDirectArtistBrowseId(track);
  const handleResolveNavigate = useCallback(() => {
    if (!onNavigate) return;
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);
  const handleResolveArtistName = useCallback((artistName: string) => {
    if (!onNavigate) return;
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate]);

  return (
    <div
      data-queue-index={queueIndex}
      draggable={false}
      onPointerDown={onPointerDragStart}
      className={`queue-track-row group relative flex h-14 items-center gap-2 rounded-lg px-2 transition-[background-color,opacity,transform,box-shadow] duration-150 ${
        onPointerDragStart ? "cursor-grab touch-none active:cursor-grabbing" : ""
      } ${
        isDragged ? "opacity-0" : ""
      } ${active ? "bg-white/8" : dragging ? "" : "hover:bg-white/[0.055]"}`}
    >
      {onPointerDragStart ? (
        <span
          className={`flex h-9 w-5 shrink-0 items-center justify-center text-white/36 transition-colors ${dragging ? "" : "group-hover:text-white/70"}`}
          aria-hidden="true"
        >
          <GripVertical size={16} />
        </span>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="flex h-7 w-7 shrink-0 items-center justify-center text-white transition-transform duration-[80ms] ease-out active:scale-[0.85] motion-reduce:transition-none motion-reduce:active:scale-100 animate-none"
          aria-label={buffering ? "Loading" : playing ? "Pause" : "Play"}
        >
          {buffering ? (
            <LoaderCircle size={15} className="animate-spin" />
          ) : playing ? (
            <Pause size={16} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={14} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      )}

      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
      >
        <span className={`h-10 w-10 shrink-0 overflow-hidden bg-neutral-800 ${getArtworkRoundedClass()}`} draggable={false}>
          {track.cover ? (
            <ArtworkImage src={track.cover} className="h-full w-full object-cover" />
          ) : (
            <DefaultArtwork />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-semibold ${active ? "text-white" : "text-white/88"}`}>
            {track.title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-white/46">
            {onNavigate ? (
              <ArtistCreditText
                artist={track.artist}
                artistBrowseId={track.artistBrowseId}
                artistCredits={track.artistCredits}
                context="default"
                onNavigate={onNavigate}
                onResolveNavigate={directArtistBrowseId ? null : handleResolveNavigate}
                onResolveArtistName={handleResolveArtistName}
              />
            ) : (
              track.artist
            )}
          </span>
        </span>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/38">
          {track.durationSeconds ? formatDuration(track.durationSeconds) : ""}
        </span>
      </button>
    </div>
  );
}

function EmptyQueue({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center px-5 text-center text-sm font-medium text-white/38">
      {label}
    </div>
  );
}

function AutoplayLoading() {
  return (
    <div className="flex min-h-32 items-center justify-center" role="status" aria-label="Loading autoplay songs">
      <LoaderCircle size={22} className="animate-spin text-white/55" />
    </div>
  );
}
