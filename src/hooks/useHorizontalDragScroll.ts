import { useCallback, useEffect, useRef, useState } from "react";

type DragSample = { x: number; t: number };

type DragState = {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  isDown: boolean;
  isDragging: boolean;
  suppressClick: boolean;
  samples: DragSample[];
  velocity: number;
  animationFrameId: number;
};

function createDragState(): DragState {
  return {
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    isDown: false,
    isDragging: false,
    suppressClick: false,
    samples: [],
    velocity: 0,
    animationFrameId: 0,
  };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const INTERACTIVE_POINTER_SELECTOR =
  "button, a[href], input, textarea, select, label";
const MARQUEE_SCRUB_SELECTOR = "[data-marquee-scrub]";

function isInteractivePointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE_POINTER_SELECTOR));
}

function isMarqueeScrubTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(MARQUEE_SCRUB_SELECTOR));
}

function cancelScrollAnimation(state: DragState) {
  if (state.animationFrameId) {
    window.cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = 0;
  }
}

function snapToNearestCard(strip: HTMLElement, state: DragState) {
  const firstChild = strip.children[0] as HTMLElement | undefined;
  if (!firstChild) return;

  const style = getComputedStyle(strip);
  const gap = Number.parseFloat(style.gap) || 0;
  const stride = firstChild.offsetWidth + gap;
  if (stride <= 0) return;

  const maxScroll = strip.scrollWidth - strip.clientWidth;
  const current = strip.scrollLeft;

  if (current <= 1 || current >= maxScroll - 1) return;

  const nearest = Math.round(current / stride) * stride;
  const target = Math.max(0, Math.min(nearest, maxScroll));

  if (Math.abs(target - current) < 1) return;

  if (state.animationFrameId) {
    window.cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = 0;
  }

  const startX = strip.scrollLeft;
  const distance = target - startX;
  const duration = 280;
  const startTime = performance.now();

  const step = (now: number) => {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    strip.scrollLeft = startX + distance * easeOutCubic(progress);
    if (progress < 1) {
      state.animationFrameId = window.requestAnimationFrame(step);
    } else {
      state.animationFrameId = 0;
    }
  };
  state.animationFrameId = window.requestAnimationFrame(step);
}

export function useHorizontalDragScroll() {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState>(createDragState());
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return () => {
      const frameId = dragStateRef.current.animationFrameId;
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Nested title/artist/play controls must receive a normal click. Capturing
    // the pointer on the rail retargets pointerup away from those buttons and
    // suppresses their click synthesis.
    if (isInteractivePointerTarget(event.target)) return;
    const state = dragStateRef.current;
    // Marquee title scrub owns horizontal drags on its surface. Stop any
    // in-flight rail momentum and do not start a competing rail drag.
    if (isMarqueeScrubTarget(event.target)) {
      cancelScrollAnimation(state);
      return;
    }
    const strip = stripRef.current;
    if (!strip) return;

    cancelScrollAnimation(state);

    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startScrollLeft = strip.scrollLeft;
    state.isDown = true;
    state.isDragging = false;
    state.suppressClick = false;
    state.samples = [{ x: event.clientX, t: performance.now() }];
    state.velocity = 0;
    // Do not capture on pointerdown — retargeting pointer events away from the
    // original target suppresses click synthesis on nested card surfaces. We
    // only capture once the drag threshold is crossed (see pointermove).
  }, []);

  useEffect(() => {
    const state = dragStateRef.current;

    const handlePointerMove = (event: PointerEvent) => {
      const strip = stripRef.current;
      if (!strip || !state.isDown || event.pointerId !== state.pointerId) return;

      const now = performance.now();
      state.samples.push({ x: event.clientX, t: now });

      const cutoff = now - 100;
      state.samples = state.samples.filter((sample) => sample.t >= cutoff);

      if (state.samples.length >= 2) {
        const first = state.samples[0];
        const last = state.samples[state.samples.length - 1];
        const dt = last.t - first.t;
        if (dt > 0) {
          const fingerVelocity = (last.x - first.x) / dt;
          state.velocity = -fingerVelocity * 16;
        }
      }

      const deltaX = event.clientX - state.startX;
      if (!state.isDragging && Math.abs(deltaX) < 6) return;

      if (!state.isDragging) {
        state.isDragging = true;
        setIsDragging(true);
        state.samples = [{ x: event.clientX, t: now }];
        try {
          strip.setPointerCapture(event.pointerId);
        } catch {
          // Older WebKit can throw on some elements; window listeners still cover it.
        }
      }

      event.preventDefault();
      strip.scrollLeft = state.startScrollLeft - deltaX;
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!state.isDown || event.pointerId !== state.pointerId) return;

      const wasDragging = state.isDragging;
      state.isDown = false;

      if (wasDragging) {
        state.suppressClick = true;
        window.setTimeout(() => {
          state.suppressClick = false;
        }, 0);
      }

      state.isDragging = false;
      setIsDragging(false);

      const strip = stripRef.current;
      if (strip && state.pointerId >= 0) {
        try {
          strip.releasePointerCapture(state.pointerId);
        } catch {
          // Capture may already be released.
        }
      }
      state.pointerId = -1;

      if (!strip || !wasDragging) return;

      const velocity = state.velocity;
      const hasMomentum = Math.abs(velocity) >= 0.5;

      if (hasMomentum) {
        const friction = 0.93;
        const animate = () => {
          state.velocity *= friction;
          strip.scrollLeft += state.velocity;
          if (Math.abs(state.velocity) < 0.15) {
            state.animationFrameId = 0;
            snapToNearestCard(strip, state);
            return;
          }
          state.animationFrameId = window.requestAnimationFrame(animate);
        };
        state.animationFrameId = window.requestAnimationFrame(animate);
      } else {
        snapToNearestCard(strip, state);
      }
    };

    const handleMarqueeScrubStart = () => {
      cancelScrollAnimation(state);
      state.isDown = false;
      state.isDragging = false;
      state.suppressClick = false;
      state.pointerId = -1;
      setIsDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("marquee-scrub-start", handleMarqueeScrubStart);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("marquee-scrub-start", handleMarqueeScrubStart);
    };
  }, []);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current.suppressClick = false;
  }, []);

  return {
    stripRef,
    isDragging,
    onPointerDown,
    onClickCapture,
  };
}