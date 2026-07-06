import { useEffect, useRef, useState } from "react";

/**
 * Reusable portal-mount for context menu sub-panels.
 *
 * All three "Add to playlist" sub-menus (song, album, playlist) used to
 * maintain their own near-identical portal-positioning code. This component
 * keeps the boilerplate in one place: anchor-relative positioning with
 * viewport clamping, scroll/resize re-measurement, and a click-away close
 * trigger. The children render whatever the sub-menu actually shows.
 */
export function NestedSubMenuPanel({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelWidth = panel?.offsetWidth ?? 220;
      const panelHeight = panel?.offsetHeight ?? 220;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let top = rect.top;
      let left = rect.right + 6;
      if (left + panelWidth > viewportW - 12) {
        left = Math.max(8, rect.left - panelWidth - 6);
      }
      if (top + panelHeight > viewportH - 8) {
        top = Math.max(8, viewportH - panelHeight - 8);
      }
      if (top < 8) top = 8;
      setCoords({ top, left });
    };
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const closeIfOutside = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [anchorRef, onClose]);

  if (typeof document === "undefined") return null;

  return (
    <div
      ref={panelRef}
      role="menu"
      data-context-menu="true"
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        zIndex: 65,
      }}
      className="artist-menu-pop overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] min-w-[14rem] max-w-[18rem]"
    >
      {children}
    </div>
  );
}
