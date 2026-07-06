import { useEffect, useRef } from "react";

import { cancelIdle, useIdle } from "./useIdle";

/**
 * Splash-screen lifecycle hook.
 *
 * Dismisses the splash at the earliest of:
 *   - both a double-rAF (two paint frames) AND an idle callback having fired,
 *   - a 3-second hard fallback so a stalled tab always recovers.
 *
 * On dismiss, prefers the host page's optional
 * `window.__velocityHideSplash()` callback so CSS owns the fade-out and
 * the splash-side transition animation stays intact. Falls back to
 * toggling the `fade-out` class on the default `#initial-loader` element
 * when no custom hook is installed.
 *
 * Once dismissed, the hook stays inert for the rest of the session —
 * no retry, no second dismissal. The startup chime is queued on the
 * same idle round-trip so we don't pay for a second `requestIdleCallback`.
 */
export function useStartupSplash(): void {
  const settledRef = useRef(false);

  useEffect(() => {
    if (settledRef.current) return;
    let raf1: number | null = null;
    let raf2: number | null = null;
    let idleHandle: number | null = null;
    let fallback: number | null = null;

    let framesDone = false;
    let idleDone = false;

    const finalize = () => {
      if (settledRef.current) return;
      if (!framesDone || !idleDone) return;
      settledRef.current = true;
      if (typeof window.__velocityHideSplash === "function") {
        window.__velocityHideSplash();
      } else {
        const loader = document.getElementById("initial-loader");
        loader?.classList.add("fade-out");
        window.setTimeout(() => loader?.remove(), 500);
      }
      // Defer the chime to a separate idle round-trip so the AudioContext
      // construction and media element setup don't compete with the first
      // real paint of the app shell.
      useIdle(() => playStartupChime(), { timeout: 2000 });
    };

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        framesDone = true;
        finalize();
      });
    });

    idleHandle = useIdle(() => {
      idleDone = true;
      finalize();
    });

    fallback = window.setTimeout(() => {
      framesDone = true;
      idleDone = true;
      finalize();
    }, 3000);

    return () => {
      if (raf1 !== null) window.cancelAnimationFrame(raf1);
      if (raf2 !== null) window.cancelAnimationFrame(raf2);
      cancelIdle(idleHandle);
      if (fallback !== null) window.clearTimeout(fallback);
    };
  }, []);
}

function playStartupChime(): void {
  const audio = new Audio("/startupdone.mp3");
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = 1.75;
  source.connect(gain);
  gain.connect(ctx.destination);
  void audio.play().catch(() => undefined);
  audio.addEventListener(
    "ended",
    () => {
      void ctx.close().catch(() => undefined);
    },
    { once: true },
  );
}
