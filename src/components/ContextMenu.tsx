import { Check } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../utils/cn";

// ---------------------------------------------------------------------------
// Generic popout menu panel — visually matches the artist discography's
// filter/sort panels and the search-filter popout (rounded-[4px], thin
// white/10 border, neutral-950 background, deep shadow).
//
// Hoisted here so SongContextMenu, AlbumContextMenu, and any future popout
// share the same close-on-pointerdown / Escape behaviour and (more
// importantly) the same GAP-FREE button styling the user explicitly asked
// for: each item is a self-contained <button> row that paints the entire
// row's full width on hover, with no dividers between items.
//
// Important behavior rules:
//   1. `anchorRef` lets the consumer mark a trigger element as "in scope"
//      (e.g. the plus button next to a track). Pointerdown on it does NOT
//      close the menu — but pointerdown anywhere else does. This avoids the
//      "click the trigger itself closes its own menu" bug.
//   2. Menus are anchored relative to their parent anchor (the button that
//      opened them) via the `align` prop. The DOM is portal-mounted to
//      document.body so the menu can extend past the scroll container.
//   3. The menu animates in with `artist-menu-pop` (already defined in
//      index.css and reused across the discography). That keyframe is what
//      pushes the menu ~6px below its origin at t=0 and resets to t=0;
//      multiple matchMedia / prefers-reduced-motion rules in index.css
//      already dampen or disable it under reduced motion.
// ---------------------------------------------------------------------------

type MenuAlign = "right-bottom" | "right-top" | "left-bottom" | "left-top" | "right-center";

export type ContextMenuItemProps = {
  label: string;
  active?: boolean;
  icon?: ReactNode;
  /**
   * `"destructive"` paints the row in red and pulses it slightly on hover
   * so a user pausing over it before clicking cannot miss the warning.
   * Default style mirrors the rest of the popout (white/72 on hover-white).
   */
  variant?: "default" | "destructive";
  onClick: () => void;
};

export function ContextMenuItem({
  label,
  active,
  icon,
  variant = "default",
  onClick,
}: ContextMenuItemProps) {
  const isDestructive = variant === "destructive";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Each row paints the full background on hover WITHOUT any gap
        // between rows. No top border, no bottom border, just a single
        // solid hover fill across the row's full block bounds.
        "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold transition-colors animate-none",
        isDestructive
          ? "text-red-400 hover:bg-red-500/15"
          : "text-white/72 hover:bg-white/8 hover:text-white",
        active && !isDestructive ? "text-white" : null,
      )}
    >
      {icon && (
        <span
          className={cn(
            "shrink-0",
            isDestructive
              ? "text-red-400"
              : active
              ? "text-white"
              : "text-white/72",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && !isDestructive && (
        <span className="shrink-0 text-white">
          <Check size={16} />
        </span>
      )}
    </button>
  );
}

export type ContextMenuSectionProps = {
  label?: string;
  children: ReactNode;
};

export function ContextMenuSection({ label, children }: ContextMenuSectionProps) {
  return (
    <div>
      {label && (
        <div className="px-4 pb-1 pt-3 text-xs font-semibold text-white/58 first:pt-2">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// `ContextMenu` — opens a popout menu next to an anchor element. Renders via
// createPortal so the menu can escape scrolling parents. The anchor itself
// should be passed as a ref-stable element so the menu stays in sync if the
// button moves.
// ---------------------------------------------------------------------------

export type ContextMenuProps = {
  open: boolean;
  /** ref to the trigger element. Could be a button. The menu is positioned relative to it. */
  anchorRef: { current: HTMLElement | null };
  align?: MenuAlign;
  /** Override positioning, e.g. for right-click menus anchored to the cursor. */
  position?: { x: number; y: number };
  onClose: () => void;
  panelClassName?: string;
  children: ReactNode;
};

export function ContextMenu({
  open,
  anchorRef,
  align = "right-bottom",
  position,
  onClose,
  panelClassName,
  children,
}: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // Position the menu exactly when it opens; recompute if the anchor moves
  // (e.g. window resize, scroll, layout). Measure on next animation frame
  // after mount so the panel has its real width before we read it.
  // A ResizeObserver ensures the panel re-anchors if its content changes
  // size (e.g. switching to a shorter confirmation section).
  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    let frameId: number;
    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      const panel = panelRef.current;
      const panelWidth = panel?.offsetWidth ?? 220;
      const panelHeight = panel?.offsetHeight ?? 220;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let top: number;
      let left: number;
      if (position) {
        top = position.y;
        left = position.x;
        if (top + panelHeight > viewportH - 8) {
          top = Math.max(8, position.y - panelHeight);
        }
        if (top < 8) top = 8;
        if (left + panelWidth > viewportW - 8) {
          left = Math.max(8, position.x - panelWidth);
        }
        if (left < 8) left = 8;
        setCoords({ top, left });
        return;
      }
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const padding = 8;
      top = rect.bottom + padding;
      left = rect.right - panelWidth;
      switch (align) {
        case "right-top":
          top = rect.top - panelHeight - padding;
          break;
        case "left-bottom":
          left = rect.left;
          break;
        case "left-top":
          top = rect.top - panelHeight - padding;
          left = rect.left;
          break;
        case "right-center":
          top = rect.top + rect.height / 2 - panelHeight / 2;
          break;
        default:
          // right-bottom (default): align right edge with anchor's right.
          break;
      }
      // Flip above anchor if it would overflow the bottom edge.
      if (top + panelHeight > viewportH - 8) {
        top = Math.max(8, rect.top - panelHeight - padding);
      }
      if (top < 8) top = 8;
      // Flip left of anchor if it would overflow the right edge.
      if (left + panelWidth > viewportW - 8) {
        left = Math.max(8, rect.left - panelWidth - padding);
      }
      if (left < 8) left = 8;
      setCoords({ top, left });
    };

    const scheduleMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    frameId = requestAnimationFrame(measure);

    // Watch the panel for content-size changes so the menu stays anchored
    // to the cursor even when its children swap (e.g. delete confirmation).
    if (panelRef.current) {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(panelRef.current);
    }

    const handleResize = () => requestAnimationFrame(measure);
    const handleScroll = () => requestAnimationFrame(measure);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      cancelAnimationFrame(frameId);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, align, position, anchorRef]);

  // Click-away / Escape close. Pointer-down on the trigger element is
  // allowed because we expose the anchor ref; on it we don't auto-close.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      // Don't close if clicking inside a submenu or nested context menu
      // (portaled to body, so not within panelRef).
      if (target instanceof Element && target.closest('[data-context-menu]')) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
      <div
        ref={panelRef}
        role="menu"
        data-context-menu="true"
        aria-orientation="vertical"
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        zIndex: 60,
      }}
      className={cn(
        "artist-menu-pop overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] min-w-[14rem] max-w-[20rem]",
        panelClassName,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Nested sub-menu — renders a right-side popup when the parent's row is
// hovered, anchored to the parent's rect (with vertical centering).
// ---------------------------------------------------------------------------

export type NestedMenuProps = {
  open: boolean;
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  children: ReactNode;
};

export function NestedMenu({ open, anchorRef, onClose, children }: NestedMenuProps) {
  if (!open) return null;
  return (
    <ContextMenu
      open={open}
      anchorRef={anchorRef}
      align="right-center"
      onClose={onClose}
      panelClassName="min-w-[14rem]"
    >
      {children}
    </ContextMenu>
  );
}
