import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type MarqueeProps = {
  children: ReactNode;
  className?: string;
  /**
   * Scrolling speed in pixels per second. Higher = faster.
   * Only affects the moving segments of the cycle; the end-pauses
   * have their own absolute time, controlled by `pauseSeconds`.
   */
  speed?: number;
  /**
   * Constant pause duration at each end of the cycle, in seconds.
   * Decoupled from the cycle length so slowing `speed` does not
   * lengthen the read-pause rhythm.
   */
  pauseSeconds?: number;
  /**
   * Minimum total cycle duration in seconds. Prevents very short
   * overflows from snapping back and forth too quickly and forces a
   * minimum beat between traversals.
   */
  minDuration?: number;
  /**
   * External cycle override, in seconds. When provided (and greater
   * than zero while text actually overflows), it replaces the locally
   * computed cycle for both keyframe percentages and animation
   * duration, so multiple Marquees in the same parent share a single
   * source of pause beats even when their individual overflows differ.
   * The locally measured overflow still drives the slide distance
   * (`--marquee-distance`), so the two marquees can travel at their
   * own visible speeds while holding in lockstep at each end.
   */
  cycle?: number;
  /**
   * Fired whenever the dead-banded measured overflow changes. Lets a
   * parent coordinator pick up the locally measured overflow without
   * duplicating the measurement. The callback only fires after React
   * commits the new overflow state, so it is safe to drive parent
   * state from it.
   */
  onOverflowChange?: (overflow: number) => void;
};

// Minimum overflow before we bother animating. At 15px font with a ~6px
// character width this captures ~1 char of overflow, which is enough to
// warrant scrolling. The previous value (24px ≈ 4 chars) meant the marquee
// silently failed for names that barely overflow — especially common in
// the responsive Collection grid where card width varies with viewport.
const OVERFLOW_THRESHOLD_PX = 6;
// Dead band applied around overflow changes. Neighbouring layout shifts
// (e.g. the player bar updating progress) can dither the measured
// overflow by 1–2 px; without this floor those tiny deltas churn React
// state on every re-render, which in turn rewrites the injected
// <style> and restarts the animation from its 0% stop. Anything inside
// the band is treated as "same value" so the keyframes stay stable.
const OVERFLOW_CHANGE_DEAD_BAND_PX = 1.5;
// Edge-fade ramp width, in % of one animation cycle, centered on each
// pause/travel boundary. Kept small so the fade reads as a quick lift
// rather than a slow easing between holds.
const FADE_RAMP_PCT = 1;

export function Marquee({
  children,
  className,
  // ~20% slower than the previous default of 50 while keeping the
  // per-side pause feel at ~0.85s — close to the existing rhythm.
  speed = 40,
  pauseSeconds = 0.85,
  minDuration = 4,
  cycle: cycleOverride,
  onOverflowChange,
}: MarqueeProps) {
  // React 19's `useId` returns IDs that contain colons (e.g. `:r0:`),
  // but CSS `<ident>` tokens don't permit colons, so an unsanitized id
  // would produce an invalid `@keyframes`/`animation-name` pair and
  // silently break the animation. Strip everything outside the
  // `_a-zA-Z0-9-` ident set before using the id for any CSS-bound
  // identifier (class names, keyframe names, animation-name).
  const reactId = useId().replace(/[^_a-zA-Z0-9-]/g, "_");
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const text = textRef.current;
      if (!container || !text) return;
      const diff = text.scrollWidth - container.clientWidth;
      const calculated = diff > OVERFLOW_THRESHOLD_PX ? diff : 0;
      // Dead-band the measured value so sub-pixel layout jitter from
      // sibling updates doesn't churn state and restart the keyframes.
      setOverflow((prev) =>
        Math.abs(prev - calculated) > OVERFLOW_CHANGE_DEAD_BAND_PX ? calculated : prev,
      );
    };

    measure();

    const container = containerRef.current;
    const parent = container?.parentElement;

    const observer = new ResizeObserver(measure);
    if (container) observer.observe(container);
    if (textRef.current) observer.observe(textRef.current);
    if (parent) observer.observe(parent);

    // Re-measure once web fonts have loaded (text width can change).
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => undefined);
    }

    // Some browsers apply font faces asynchronously after
    // `document.fonts.ready` resolves. Listening for the `loadingdone`
    // event catches those late swaps without polling.
    let onFontLoadingDone: (() => void) | undefined;
    if (typeof document !== "undefined" && document.fonts?.addEventListener) {
      onFontLoadingDone = () => measure();
      document.fonts.addEventListener("loadingdone", onFontLoadingDone);
    }

    // Delayed re-check: CSS custom property changes (e.g. --discography-title-width)
    // may trigger a ResizeObserver on the parent, but the container's layout might
    // settle one frame later. A double-rAF ensures we catch the final geometry.
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(measure);
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (
        typeof document !== "undefined" &&
        document.fonts?.removeEventListener &&
        onFontLoadingDone
      ) {
        document.fonts.removeEventListener("loadingdone", onFontLoadingDone);
      }
    };
  }, [children]);

  // Surface the dead-banded overflow to any parent coordinator so two
  // Marquees in the same parent can be synced without duplicating the
  // measurement. Only `overflow` itself — the parent decides whether
  // to lift it; this marquee still does its own math.
  useEffect(() => {
    onOverflowChange?.(overflow);
  }, [overflow, onOverflowChange]);

  const isOverflowing = overflow > 0;
  // One cycle = two travel segments + two end-pauses. Travel time is the
  // variable leg; pauses stay constant so the read-pause rhythm doesn't
  // stretch when the scroll gets slower.
  const travelTime = isOverflowing ? overflow / speed : 0;
  const localCycle = isOverflowing ? 2 * (pauseSeconds + travelTime) : 0;
  // A non-zero `cycleOverride` (only meaningful while text overflows)
  // takes precedence so two marquees can share a single source of
  // pause beats even when their individual overflows differ.
  const cycle =
    cycleOverride !== undefined && cycleOverride > 0 && isOverflowing
      ? cycleOverride
      : localCycle;
  const duration = isOverflowing ? Math.max(minDuration, cycle) : 0;

  // Translate the absolute pause time into a percentage of one cycle.
  // By construction cycle = 2 * (pauseSeconds + travelTime), so the
  // pause occupies exactly pauseSeconds/cycle of the period and the
  // second pause is identical by symmetry (see buildMarqueeKeyframes).
  const pausePct = cycle > 0 ? (pauseSeconds / cycle) * 100 : 0;
  // Edge-fade ramps shrink with the pause window so they never overlap
  // their neighbour when pauses span a small fraction of the cycle.
  const ramp = isOverflowing ? Math.min(FADE_RAMP_PCT, pausePct / 4) : 0;

  // Per-instance @keyframes so the actual per-side pause time stays
  // constant even after the cycle stretches to fit a slower speed.
  // The injected <style> is removed on unmount.
  useLayoutEffect(() => {
    if (!isOverflowing) return;
    const styleEl = ensureMarqueeStyle(reactId);
    const newCss = buildMarqueeKeyframes(reactId, pausePct, ramp);
    // Diff before writing: rewriting a <style>'s `textContent` even
    // with the same string invalidates active animations site-wide
    // and restarts them from 0%. Skip when the rules haven't changed.
    if (styleEl.textContent !== newCss) {
      styleEl.textContent = newCss;
    }
    return () => {
      const el = document.getElementById(marqueeStyleId(reactId));
      if (el?.parentNode) el.parentNode.removeChild(el);
    };
  }, [reactId, isOverflowing, pausePct, ramp]);

  const translateClass = `marquee-translate-${reactId}`;
  const fadeClass = `marquee-fade-${reactId}`;

  return (
    <span
      ref={containerRef}
      className={`relative block w-full ${isOverflowing ? `overflow-hidden marquee-mask hover:[animation-play-state:paused] ${fadeClass}` : ""} ${className ?? ""}`}
      style={
        isOverflowing
          ? ({ ["--marquee-duration" as string]: `${duration}s` } as CSSProperties)
          : undefined
      }
    >
      <span
        ref={textRef}
        className={
          isOverflowing
            ? `marquee-translate ${translateClass} inline-block whitespace-nowrap hover:[animation-play-state:paused] motion-reduce:truncate motion-reduce:animate-none motion-reduce:block motion-reduce:w-full`
            : "block whitespace-nowrap"
        }
        style={
          isOverflowing
            ? ({
                ["--marquee-distance" as string]: `-${overflow}px`,
              } as CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </span>
  );
}

function marqueeStyleId(id: string): string {
  return `marquee-style-${id}`;
}

function ensureMarqueeStyle(id: string): HTMLStyleElement {
  const fullId = marqueeStyleId(id);
  let el = document.getElementById(fullId) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = fullId;
    document.head.appendChild(el);
  }
  return el;
}

function buildMarqueeKeyframes(
  id: string,
  pausePct: number,
  ramp: number,
): string {
  const translateName = `marquee-translate-${id}`;
  const fadeLeftName = `marquee-fade-left-${id}`;
  const fadeRightName = `marquee-fade-right-${id}`;
  const num = (n: number) => Math.max(0, Math.min(100, n)).toFixed(3);

  const endOfSecondHold = Math.min(100, pausePct + 50);
  const translate = `
  0%, ${num(pausePct)}% { transform: translate3d(0, 0, 0); }
  50%, ${num(endOfSecondHold)}% { transform: translate3d(var(--marquee-distance, 0px), 0, 0); }
  100% { transform: translate3d(0, 0, 0); }`;

  const r = Math.max(0, ramp);
  const firstHoldEnd = Math.max(0, pausePct - r);
  const firstHoldBegin = Math.min(100, pausePct + r);
  const firstHoldEndTravel = Math.max(0, 50 - r);
  const secondHoldBegin = Math.min(100, 50);
  const secondHoldEnd = Math.max(0, endOfSecondHold - r);
  const returnTravelBegin = Math.min(100, endOfSecondHold + r);
  const returnTravelEnd = Math.max(0, 100 - r);

  // Left edge: text extends beyond left during travel and end pause.
  // No fade at start (text starts at left edge), fade everywhere else.
  const fadeLeft = `
  0%, ${num(firstHoldEnd)}% { --fade-left: 0; }
  ${num(firstHoldBegin)}%, ${num(returnTravelEnd)}% { --fade-left: 1; }
  100% { --fade-left: 0; }`;

  // Right edge: text extends beyond right during start pause and travel.
  // No fade at end pause (text ends at right edge), fade everywhere else.
  const fadeRight = `
  0%, ${num(firstHoldEndTravel)}% { --fade-right: 1; }
  ${num(secondHoldBegin)}%, ${num(secondHoldEnd)}% { --fade-right: 0; }
  ${num(returnTravelBegin)}% { --fade-right: 1; }
  100% { --fade-right: 1; }`;

  return `@keyframes ${translateName} {${translate} }
@keyframes ${fadeLeftName} {${fadeLeft} }
@keyframes ${fadeRightName} {${fadeRight} }
.${translateName} { animation-name: ${translateName}; }
.marquee-fade-${id} { animation-name: ${fadeLeftName}, ${fadeRightName}; }`;
}
