import { useEffect, useRef } from "react";

import { listImportedTracks } from "../api";
import { getSettings } from "../settings";
import { getCachedDailyRecommendations, needsDailyRecommendationRefresh } from "../taste-profile";
import { generateDailyRecommendations } from "../utils/home-recommendations";
import { cancelIdle, useIdle } from "./useIdle";

/**
 * Splash-screen lifecycle hook.
 *
 * Keeps the splash screen visible over the webview until the application has
 * finished its initial startup sequence:
 *   1. Initial paint frame has completed (double requestAnimationFrame).
 *   2. Minimum display duration has passed (500ms) for visual smoothness.
 *   3. Critical startup data has loaded:
 *      - If the user lands on the Home page with Today's Picks enabled and
 *        recommendations need refreshing, wait for recommendation generation.
 *      - Imported library tracks list has hydrated.
 *   4. Hard fallback timeout (4000ms) so the app recovers unconditionally even
 *      if network/API calls hang or fail.
 *
 * On dismiss, invokes `window.__velocityHideSplash()` so CSS smoothly transitions
 * the splash out with a fade-out + scale animation before removing the DOM element.
 * The startup chime is queued on an idle callback.
 */
export function useStartupSplash(): void {
  const settledRef = useRef(false);

  useEffect(() => {
    if (settledRef.current) return;
    let raf1: number | null = null;
    let raf2: number | null = null;
    let idleHandle: number | null = null;
    let fallbackTimer: number | null = null;
    let minDisplayTimer: number | null = null;

    let framesDone = false;
    let idleDone = false;
    let minDisplayDone = false;
    let tasksDone = false;

    const finalize = () => {
      if (settledRef.current) return;
      if (!framesDone || !idleDone || !minDisplayDone || !tasksDone) return;
      settledRef.current = true;

      // Allow one extra frame for latest React state commits to flush to DOM
      window.requestAnimationFrame(() => {
        if (typeof window.__velocityHideSplash === "function") {
          window.__velocityHideSplash();
        } else {
          const loader = document.getElementById("initial-loader");
          loader?.classList.add("fade-out");
          window.setTimeout(() => loader?.remove(), 450);
        }

        // Defer chime to idle so audio context creation does not compete with UI transitions
        useIdle(() => playStartupChime(), { timeout: 2000 });
      });
    };

    // 1. Initial paint frames
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

    // 2. Minimum display time (500ms) to ensure smooth transition without jarring flash
    minDisplayTimer = window.setTimeout(() => {
      minDisplayDone = true;
      finalize();
    }, 500);

    // 3. Await critical startup tasks
    const startupTasks: Promise<unknown>[] = [];

    const settings = getSettings();
    if (
      settings.showHomeMenu &&
      settings.showHomeTodaysPicks &&
      needsDailyRecommendationRefresh() &&
      !getCachedDailyRecommendations()
    ) {
      startupTasks.push(generateDailyRecommendations().catch(() => []));
    }

    startupTasks.push(listImportedTracks().catch(() => []));

    if (startupTasks.length === 0) {
      tasksDone = true;
      finalize();
    } else {
      Promise.allSettled(startupTasks).then(() => {
        tasksDone = true;
        finalize();
      });
    }

    // 4. Hard fallback timeout (4000ms) so splash never hangs indefinitely
    fallbackTimer = window.setTimeout(() => {
      framesDone = true;
      idleDone = true;
      minDisplayDone = true;
      tasksDone = true;
      finalize();
    }, 4000);

    return () => {
      if (raf1 !== null) window.cancelAnimationFrame(raf1);
      if (raf2 !== null) window.cancelAnimationFrame(raf2);
      cancelIdle(idleHandle);
      if (minDisplayTimer !== null) window.clearTimeout(minDisplayTimer);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  }, []);
}

function playStartupChime(): void {
  try {
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
  } catch {
    // AudioContext failure (e.g. autoplay restriction or uninitialized audio)
  }
}
