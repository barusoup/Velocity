/**
 * Stateless `requestIdleCallback` wrapper with `setTimeout` polyfill.
 *
 * Each caller owns its own returned handle, so multiple concurrent
 * callers (splash teardown + imported-tracks hydration) can each
 * register a callback without clobbering one another. The browser
 * natively supports concurrent RIIC handles, and the polyfill branches
 * on the same `setTimeout` API.
 */

const POLYFILL_DEADLINE_MS = 350;

export function useIdle(
  callback: IdleRequestCallback,
  options?: IdleRequestOptions,
): number {
  if (typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline),
    POLYFILL_DEADLINE_MS,
  ) as unknown as number;
}

export function cancelIdle(handle: number | null): void {
  if (handle === null) return;
  if (typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}
