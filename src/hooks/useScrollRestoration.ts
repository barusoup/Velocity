import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * Scroll-position restoration hook.
 *
 * After a view change (history index tick, transient view swap), the
 * scroll container should re-measure its scroll position once on each
 * useLayoutEffect and then auto-disconnect once the content has settled.
 * The hook owns:
 *   - the ResizeObserver that re-applies the saved scrollTop whenever
 *     scrollHeight changes,
 *   - wheel/touchstart/pointerdown listeners that stop restoration the
 *     moment the user grabs the scrollport,
 *   - a 2.5-second hard timeout that guarantees the observer disconnects
 *     even if the content never settles.
 */
export function useScrollRestoration({
  containerRef,
  savedScrollTop,
  enabled,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  savedScrollTop: number;
  /** When `false` the effect skips its work entirely. */
  enabled: boolean;
}): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!(container instanceof HTMLDivElement)) return;

    let cancelled = false;
    let timeoutId: number | null = null;

    const resizeObserver = new ResizeObserver(() => restoreScrollPosition());

    const stopRestoring = () => {
      if (cancelled) return;
      cancelled = true;
      resizeObserver.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };

    const restoreScrollPosition = () => {
      if (cancelled) return;
      container.scrollTop = savedScrollTop;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const closeEnough = Math.abs(container.scrollTop - savedScrollTop) <= 1;
      // Two restoration conditions: (a) top of page (always restored;
      // no need to wait for content to fill) and (b) content has scrolled
      // enough that we'd close the loop on the observer. The observer
      // only stops once the saved position is actually achievable.
      if (savedScrollTop === 0) {
        if (closeEnough) stopRestoring();
        return;
      }
      if (maxScrollTop >= savedScrollTop - 1 && closeEnough) {
        stopRestoring();
      }
    };

    resizeObserver.observe(container);

    container.addEventListener("wheel", stopRestoring, { passive: true, capture: true });
    container.addEventListener("touchstart", stopRestoring, { passive: true, capture: true });
    container.addEventListener("pointerdown", stopRestoring, { passive: true, capture: true });

    restoreScrollPosition();
    if (!cancelled) {
      timeoutId = window.setTimeout(stopRestoring, 2500);
    }

    return () => {
      container.removeEventListener("wheel", stopRestoring, true);
      container.removeEventListener("touchstart", stopRestoring, true);
      container.removeEventListener("pointerdown", stopRestoring, true);
      stopRestoring();
    };
  }, [containerRef, savedScrollTop, enabled]);
}
