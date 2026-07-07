import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
  /**
   * Inline style applied to the container span. Useful when a dynamic
   * value (e.g. an artwork-derived accent color for the currently
   * playing track) needs to flow through to the marquee text via CSS
   * inheritance. Merged AFTER the internal style on a per-render-path
   * basis, so the caller's declarations win on collision: useful when
   * a caller wants to override `--marquee-duration` for a test render,
   * but be careful about overriding `touch-action` (pan-y) since
   * losing it would break pointer-capture on touch devices.
   */
  style?: CSSProperties;
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
// Drag threshold: pointer movement below this distance during a pressed
// state is treated as a tap, not a scrub. Same value as the Discography
// strip drag in `src/components/ArtistPage.tsx` so the marquee feels
// consistent with the only other grab-to-scrub surface in the app.
const DRAG_THRESHOLD_PX = 6;

// Pull the live X translation of an element directly from the resolved
// transform. The CSS animation interpolates the translate3d keyframes
// every frame; querying the matrix gives us the current rendered value
// even while a drag is in flight, so we can read the user's starting
// frame precisely instead of guessing where the animation was.
//
// DOMMatrix is a non-optional part of the WebKit / Chromium builds Tauri
// ships; the `typeof` guard is purely to keep the helper quiet under
// future embedders that might lack it (e.g. a Node.js render path in
// tests).
function readLiveTranslateX(el: HTMLElement): number {
  if (
    typeof window === "undefined" ||
    typeof DOMMatrix === "undefined" ||
    typeof window.getComputedStyle !== "function"
  ) {
    return 0;
  }
  const transform = window.getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  // `new DOMMatrix(string)` accepts both 2-D `matrix(...)` and 3-D
  // `matrix3d(...)` CSS transform strings; `.m41` is the X translation
  // in px in either form (4th-column, 1st-row entry of the affine
  // matrix).
  return new DOMMatrix(transform).m41;
}

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
  style: userStyle,
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
  // Cursor state. Lives on the container's className so a re-render
  // happens only at drag boundaries (start / end), never per pointermove.
  const [isDragging, setIsDragging] = useState(false);
  // Drag bookkeeping kept in a ref so the window-level pointermove
  // handler doesn't churn React state on every motion sample.
  //   * `basePosX`: visual X translation captured at threshold-cross
  //     (after pausing the animation) so the drag is relative to
  //     "where the text actually is" rather than "where the cycle
  //     clock is".
  //   * `textAnims` / `containerAnims`: WAAPI Animation handles
  //     cached at threshold-cross so we don't re-query
  //     getAnimations on every pointermove. Calling getAnimations
  //     during drag is a layout-adjacent operation we want to keep
  //     off the hot path. Caching here (instead of on pointerdown)
  //     also guarantees a refresh that recreates the underlying
  //     CSSAnimation instances between press and drag-start gives
  //     fresh handles, AND keeps a press that never becomes a drag
  //     from engaging the animations at all.
  const dragStateRef = useRef({
    isDown: false,
    isDragging: false,
    suppressClick: false,
    startX: 0,
    basePosX: 0,
    pointerId: -1,
    textAnims: [] as Animation[],
    containerAnims: [] as Animation[],
  });
  // JS-tracked hover pause replaces the previous Tailwind
  // `hover:[animation-play-state:paused]` rule. CSS `:hover` alone can
  // strand infinite animations in a paused frame after mouseout —
  // especially once WAAPI has also touched the same CSSAnimation
  // instances during drag-to-scrub — and the only recovery is another
  // hover/reflow. Pointer enter/leave with an explicit resume on leave
  // keeps the play state authoritative.
  const isHoverPausedRef = useRef(false);

  const pauseMarqueeAnimations = () => {
    const text = textRef.current;
    const container = containerRef.current;
    if (!text || !container) return;
    text.style.animationPlayState = "paused";
    container.style.animationPlayState = "paused";
    for (const el of [text, container]) {
      for (const anim of el.getAnimations()) {
        anim.pause();
      }
    }
  };

  const resumeMarqueeAnimations = () => {
    const text = textRef.current;
    const container = containerRef.current;
    if (!text || !container) return;
    text.style.animationPlayState = "";
    container.style.animationPlayState = "";
    for (const el of [text, container]) {
      for (const anim of el.getAnimations()) {
        if (anim.playState !== "running") {
          anim.play();
        }
      }
    }
  };

  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry?.isIntersecting ?? false),
      { rootMargin: "120px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!isVisible) {
      setOverflow(0);
      return;
    }

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
  }, [children, isVisible]);

  // Surface the dead-banded overflow to any parent coordinator so two
  // Marquees in the same parent can be synced without duplicating the
  // measurement. Only `overflow` itself — the parent decides whether
  // to lift it; this marquee still does its own math.
  useEffect(() => {
    onOverflowChange?.(overflow);
  }, [overflow, onOverflowChange]);

  const isOverflowing = overflow > 0;
  const isAnimating = isOverflowing;

  useEffect(() => {
    if (!isAnimating) {
      isHoverPausedRef.current = false;
    }
  }, [isAnimating]);

  const isDragEnabled = isOverflowing;
  // One cycle = two travel segments + two end-pauses. Travel time is the
  // variable leg; pauses stay constant so the read-pause rhythm doesn't
  // stretch when the scroll gets slower.
  const travelTime = isAnimating ? overflow / speed : 0;
  const localCycle = isAnimating ? 2 * (pauseSeconds + travelTime) : 0;
  // A non-zero `cycleOverride` (only meaningful while text overflows)
  // takes precedence so two marquees can share a single source of
  // pause beats even when their individual overflows differ.
  const cycle =
    cycleOverride !== undefined && cycleOverride > 0 && isAnimating
      ? cycleOverride
      : localCycle;
  const duration = isAnimating ? Math.max(minDuration, cycle) : 0;

  // Translate the absolute pause time into a percentage of one cycle.
  // By construction cycle = 2 * (pauseSeconds + travelTime), so the
  // pause occupies exactly pauseSeconds/cycle of the period and the
  // second pause is identical by symmetry (see buildMarqueeKeyframes).
  const pausePct = cycle > 0 ? (pauseSeconds / cycle) * 100 : 0;
  // Edge-fade ramps shrink with the pause window so they never overlap
  // their neighbour when pauses span a small fraction of the cycle.
  const ramp = isAnimating ? Math.min(FADE_RAMP_PCT, pausePct / 4) : 0;

  // Per-instance @keyframes so the actual per-side pause time stays
  // constant even after the cycle stretches to fit a slower speed.
  // Update the injected <style> in place; only remove it when animation
  // turns off or the instance unmounts. The previous cleanup removed the
  // entire <style> on every pausePct/ramp tweak, which briefly detached
  // the @keyframes and could leave sibling marquees frozen mid-cycle.
  useLayoutEffect(() => {
    if (!isAnimating) {
      const el = document.getElementById(marqueeStyleId(reactId));
      if (el?.parentNode) el.parentNode.removeChild(el);
      return;
    }
    const styleEl = ensureMarqueeStyle(reactId);
    const newCss = buildMarqueeKeyframes(reactId, pausePct, ramp);
    // Diff before writing: rewriting a <style>'s `textContent` even
    // with the same string invalidates active animations site-wide
    // and restarts them from 0%. Skip when the rules haven't changed.
    if (styleEl.textContent !== newCss) {
      styleEl.textContent = newCss;
      // Rewriting keyframes restarts the CSSAnimation instances. If the
      // pointer is still over the marquee, re-apply the hover pause so
      // the fresh animations don't begin scrolling under the cursor.
      if (isHoverPausedRef.current) {
        requestAnimationFrame(() => {
          if (isHoverPausedRef.current) {
            pauseMarqueeAnimations();
          }
        });
      }
    }
  }, [reactId, isAnimating, pausePct, ramp]);

  useEffect(() => {
    return () => {
      const el = document.getElementById(marqueeStyleId(reactId));
      if (el?.parentNode) el.parentNode.removeChild(el);
    };
  }, [reactId]);

  // DRAG-TO-SCRUB
  //
  // Failure modes from the previous implementation:
  //
  // (a) WebKit (WKWebView on macOS) caches the paused animation frame
  //     and ignores `animation-delay` side effects until the animation
  //     resumes. Setting `text.style.animationDelay` per pointermove
  //     visually did nothing; the user saw the marquee continue
  //     animating under their finger or stay frozen at the pointerdown
  //     position with no drag response.
  //
  // (b) The previous `(duration + rawDelay) % duration` modulo flipped
  //     the cycle position when `rawDelay` was negative: a desired
  //     frame at 33.5% of the cycle resolved to 66.5%, ending the
  //     scrub at the opposite cycle position from where the user
  //     dropped the text.
  //
  // Fix: drive the scrub through the Web Animations API, with the
  // visual position expressed directly as an inline transform:
  //
  //   1. handlePointerDown only captures intent (startX, basePosX of
  //      the running animation, pointerId). It deliberately does NOT
  //      pause, so a tap on the marquee that never crosses the drag
  //      threshold leaves the running animation untouched and is
  //      visually silent.
  //
  //   2. The first pointermove that crosses DRAG_THRESHOLD_PX (6 px)
  //      pauses the marquee animations and re-reads `basePosX` from
  //      the now-frozen frame, so a few-px drift between
  //      pointerdown and threshold-cross doesn't get baked into the
  //      relative move. `textEl.style.animationPlayState = "paused"`
  //      is also set inline as a guard against any class-side cascade
  //      reset re-enabling the animation while we scrub.
  //
//   3. Subsequent pointermoves write the inline `transform` with
//      the `important` flag, so it beats the paused animation
//      transform in the cascade (per CSS Cascading 5.2, an
//      !important author declaration outranks an animation-origin
//      declaration). The inline translate3d therefore paints
//      directly on every frame, with no race against the animation
//      engine and no reliance on `animation-delay` quirks. The
//      container's fade animations stay paused but their
//      `currentTime` is advanced in lockstep with the text so the
//      edge-fade mask gradient stays aligned with the dragged
//      frame.
  //
  //   4. On pointerup we clear the inline transform (animation
  //      transform paints the now-current frame), then `.play()` to
  //      resume — animation continues from exactly the dropped
  //      frame with no jump. We only do this when a drag actually
  //      happened; on taps the skip is what makes the interaction
  //      silent.
  const handleContainerPointerEnter = () => {
    if (!isAnimating) return;
    isHoverPausedRef.current = true;
    if (!dragStateRef.current.isDragging) {
      pauseMarqueeAnimations();
    }
  };

  const handleContainerPointerLeave = () => {
    if (!isAnimating) return;
    isHoverPausedRef.current = false;
    if (!dragStateRef.current.isDragging) {
      resumeMarqueeAnimations();
    }
  };

  const handleContainerPointerDown = (
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    if (event.button !== 0) return;
    if (!isDragEnabled) return;
    const text = textRef.current;
    const container = containerRef.current;
    if (!text || !container) return;

    const state = dragStateRef.current;
    state.isDown = true;
    state.isDragging = false;
    state.suppressClick = false;
    state.startX = event.clientX;
    state.basePosX = readLiveTranslateX(text);
    state.pointerId = event.pointerId;
    event.stopPropagation();
    // Halt any in-flight horizontal-rail momentum before scrubbing the title.
    window.dispatchEvent(new Event("marquee-scrub-start"));

    // Animations are NOT paused here. Pausing on every press causes
    // a visible pause → resume round-trip on taps that never cross
    // the drag threshold; deferring the pause until the first
    // qualifying `pointermove` makes taps silent. Animation refs
    // are likewise cached at threshold-crossing, so a refresh that
    // changes the underlying CSSAnimation instances between press
    // and drag-start never strands us with stale handles.

    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Older Safari throws on text/HTML elements; ignore — the
      // window-level listeners cover everything anyway.
    }
  };

  const handleContainerClickCapture = (
    event: ReactMouseEvent<HTMLSpanElement>,
  ) => {
    if (!dragStateRef.current.suppressClick) return;
    // The marquee is often nested inside a clickable parent (a release
    // card, an "open album" player-bar title, …). A scrub that drifted
    // more than the drag threshold without the user intending to open
    // the parent must NOT propagate as a click. Same capture-phase
    // technique used by the Discography strip.
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current.suppressClick = false;
  };

  useEffect(() => {
    if (!isDragEnabled) return;
    const state = dragStateRef.current;

    const syncAnimationFrame = (currentTimeMs: number) => {
      // Drive both elements' animations to the same `currentTime` so
      // when the drag ends and we `.play()`, the text translate and
      // the container fade ramp resume from a matched frame — no
      // visible desync between the mask gradient and the dragged text.
      for (const a of state.textAnims) {
        a.currentTime = currentTimeMs;
      }
      for (const a of state.containerAnims) {
        a.currentTime = currentTimeMs;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!state.isDown) return;

      const deltaX = event.clientX - state.startX;
      if (!state.isDragging) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
        const textEl = textRef.current;
        const containerEl = containerRef.current;
        if (!textEl || !containerEl) return;
        state.isDragging = true;
        state.suppressClick = true;
        setIsDragging(true);
        window.dispatchEvent(new Event("marquee-scrub-start"));
        // Cross into a real drag. Cache the live CSSAnimation handles
        // and pause them, then re-read `basePosX` from the paused
        // element so the few-px drift between `pointerdown` and the
        // threshold-cross doesn't get baked into the relative move.
        // `animationPlayState` is also set inline as a guard against
        // any class-side cascade reset re-enabling the animation while
        // we scrub.
        textEl.style.animationPlayState = "paused";
        containerEl.style.animationPlayState = "paused";
        state.textAnims = textEl.getAnimations();
        state.containerAnims = containerEl.getAnimations();
        state.textAnims.forEach((a) => a.pause());
        state.containerAnims.forEach((a) => a.pause());
        state.basePosX = readLiveTranslateX(textEl);
      }

      // Browsers fire pointermove even when the cursor is still pressed
      // on something that's now our captured element — preventDefault
      // keeps native drag-image / select-start off the marquee text.
      event.preventDefault();

      // Match the Discography-strip drag convention
      // (`ArtistPage.tsx` handleReleaseStripPointerDown): the text
      // follows the finger. Drag right (deltaX > 0) → text moves
      // RIGHT (less-negative tx, closer to 0) → the earlier portion
      // of the string becomes visible. Drag left pulls the text
      // leftward (more-negative tx), exposing later characters.
      // This is the standard "follow the finger" feel that matches
      // the only other grab-to-scrub surface in the app, so a drag
      // right on the marquee behaves the same as a drag right on
      // the Discography strip. (The marquee's automatic animation
      // scrolls leftward, but the user-driven scrub intentionally
      // decouples from the auto-direction so the interaction reads
      // as a direct-manipulation rather than a flipped
      // fast-forward — the latter proved unintuitive in the
      // previous build, where drag right moved the text opposite
      // to the finger even though the *end-state* revealed the
      // requested "later" characters.)
      //
      // Clamp into [−overflow, 0] so we don't exceed the keyframe
      // range even on a fast flick.
      let newPosX = state.basePosX + deltaX;
      if (newPosX > 0) newPosX = 0;
      else if (newPosX < -overflow) newPosX = -overflow;

      // Drive the visual position with an inline transform set via
      // the `important` priority. Per CSS cascade, normal author
      // declarations (including `el.style.x = ...`) sit at cascade
      // origin level 3, while animation-origin declarations sit at
      // level 4 and beat level 3 — so a plain
      // `text.style.transform = "..."` would be overridden by the
      // paused animation's translate3d and the visual would not
      // update during the drag. Tagging the inline transform with
      // the `important` flag lifts it to level 5 (important author),
      // which beats level 4 (animation) and is what actually drives
      // the painted position. On release we `removeProperty` so the
      // animation transform takes over at the synced `currentTime`
      // with no jump.
      const text = textRef.current;
      if (text) {
        text.style.setProperty(
          "transform",
          `translate3d(${newPosX}px, 0, 0)`,
          "important",
        );
      }

      // Also advance the underlying animations to the matching frame so
      // they're correctly positioned on release (no jump when we
      // clear the inline transform and `.play()` resumes).
      const fractionInTravel = -newPosX / overflow; // [0, 1]
      const tInCycleSeconds = pauseSeconds + fractionInTravel * travelTime;
      // tInCycleSeconds is bounded by cycle (= 2*(pauseSeconds+travelTime))
      // which is itself bounded by `duration` (= max(minDuration, cycle)),
      // so the value lands naturally inside one cycle. The divisor guard
      // keeps the static-marquee path (where `duration === 0`) safe from
      // producing NaN — the empty `state.textAnims` / `.containerAnims`
      // arrays reduce `syncAnimationFrame` to a no-op anyway, but the
      // explicit `duration > 0 ?` check makes "garbage in → NaN out" at
      // a drag boundary impossible.
      const currentTimeMs =
        duration > 0 ? (tInCycleSeconds * 1000) % (duration * 1000) : 0;
      syncAnimationFrame(currentTimeMs);
    };

    const handlePointerEnd = () => {
      if (!state.isDown) return;
      const wasDragging = state.isDragging;
      state.isDown = false;
      state.isDragging = false;

      // Only resume if a drag actually happened. A press that never
      // crossed the threshold left the animations untouched, so
      // there's nothing to undo here — and skipping the play() makes
      // taps perfectly silent.
      if (wasDragging) {
        const text = textRef.current;
        const container = containerRef.current;
        if (text && container) {
          // Drop our inline transform. The animation transform takes
          // over on the next paint; because we've kept the animations'
          // currentTime in lockstep, the swap is jump-free. We use
          // `removeProperty` rather than `text.style.transform = ""`
          // to make the !important-cleanup intent explicit at the
          // call site (per CSSOM, the empty-string setter also
          // removes the property, but `removeProperty` reads as
          // "strip everything that was set here, including the
          // priority tag").
          text.style.removeProperty("transform");
          state.textAnims = [];
          state.containerAnims = [];
          if (isHoverPausedRef.current) {
            pauseMarqueeAnimations();
          } else {
            resumeMarqueeAnimations();
          }
        }
      }

      setIsDragging(false);

      if (wasDragging) {
        // Defer clearing `suppressClick` so the click event that
        // pointer-up synthesizes fires while the flag is still true;
        // onClickCapture then preventDefaults/stopPropagation, which
        // keeps parent click handlers from firing on what was actually
        // a scrub gesture.
        window.setTimeout(() => {
          state.suppressClick = false;
        }, 0);
      }
    };

    // `passive: false` because we call `event.preventDefault()` to
    // suppress text selection / native drag-image while dragging.
    const options = { passive: false } as AddEventListenerOptions;
    window.addEventListener("pointermove", handlePointerMove, options);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      // Dependency churn (cycle/duration tweaks from a sibling ResizeObserver,
      // overflow dead-band edge, …) re-runs this effect. Without resetting an
      // in-flight scrub, the window listeners vanish while inline
      // `animation-play-state: paused` and the !important transform can
      // strand the marquee frozen until the next hover/reflow.
      if (state.isDown || state.isDragging) {
        const text = textRef.current;
        const container = containerRef.current;
        if (text && container) {
          text.style.removeProperty("transform");
          state.textAnims = [];
          state.containerAnims = [];
          if (isHoverPausedRef.current) {
            pauseMarqueeAnimations();
          } else {
            resumeMarqueeAnimations();
          }
        }
        state.isDown = false;
        state.isDragging = false;
        state.suppressClick = false;
        setIsDragging(false);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [
    isDragEnabled,
    overflow,
    pauseSeconds,
    cycle,
    duration,
    travelTime,
    speed,
  ]);

  // When drag transitions off (text reflows to fit), strip any inline
  // scrub overrides we left behind so the element doesn't carry stale
  // transform/animationPlayState into its rest state.
  // `removeProperty` (rather than `el.style.x = ""`) is used for the
  // transform clear so the `!important` priority tag from the in-drag
  // setProperty call is dropped in the same call — a drag interrupted
  // mid-scrub (e.g. text reflows to fit) would otherwise leave the
  // element carrying an important inline transform into its rest state.
  useEffect(() => {
    if (isDragEnabled) return;
    const text = textRef.current;
    const container = containerRef.current;
    if (!text || !container) return;
    text.style.animationPlayState = "";
    text.style.removeProperty("transform");
    container.style.animationPlayState = "";
  }, [isDragEnabled]);

  const translateClass = `marquee-translate-${reactId}`;
  const fadeClass = `marquee-fade-${reactId}`;
  // `touch-action: pan-y` keeps vertical page scrolling available on
  // touch devices while horizontal finger movement is left for the
  // JS pointer handlers to scrub the marquee. Without this, mobile
  // browsers would treat a horizontal pointer capture as a pan and
  // hijack our pointermove stream.
  const marqueeContainerStyle: CSSProperties = {
    touchAction: "pan-y",
    ["--marquee-duration" as string]: `${duration}s`,
  };

  const dragCursor = isDragging ? "cursor-grabbing" : "cursor-grab";
  // `overflow-hidden` lives on the container in BOTH branches. When
  // animating, the `marquee-mask` keyframes fade-gradient the clip for
  // a soft edge; when culled (the text already fits, the overflow
  // measurement transiently fell under threshold, or we're between
  // marquee re-installs), the same `overflow-hidden` provides a hard
  // clip so the inner `whitespace-nowrap` text can't bleed past the
  // container's right edge into sibling content (e.g. overflowing
  // track titles into the next card column, or section headings into
  // neighbour rows). Without the unconditional clip, culling the
  // animation dropped the only thing stopping the text from bleeding.
  const containerClassName = isAnimating
    ? `relative block w-full overflow-hidden marquee-mask ${fadeClass} ${dragCursor} ${className ?? ""}`
    : `relative block w-full overflow-hidden ${className ?? ""}`;

  const containerStyle = userStyle
    ? (isAnimating ? { ...marqueeContainerStyle, ...userStyle } : userStyle)
    : (isAnimating ? marqueeContainerStyle : undefined);

  return (
    <span
      ref={containerRef}
      className={containerClassName}
      style={containerStyle}
      {...(isDragEnabled ? { "data-marquee-scrub": "" } : {})}
      onPointerEnter={isAnimating ? handleContainerPointerEnter : undefined}
      onPointerLeave={isAnimating ? handleContainerPointerLeave : undefined}
      onPointerDown={isDragEnabled ? handleContainerPointerDown : undefined}
      onClickCapture={handleContainerClickCapture}
    >
      <span
        ref={textRef}
        className={
          isAnimating
            ? `marquee-translate ${translateClass} inline-block whitespace-nowrap motion-reduce:truncate motion-reduce:animate-none motion-reduce:block motion-reduce:w-full`
            : `block whitespace-nowrap`
        }
        style={
          isAnimating
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
