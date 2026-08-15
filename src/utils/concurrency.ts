// ---------------------------------------------------------------------------
// Shared async concurrency helpers.
//
// These were previously duplicated across `song-resolution.ts` (worker pool),
// `autoplayResolver.ts` (worker pool), and `player.tsx` (`withTimeout`). Both
// worker pools were byte-for-byte the same bounded-concurrency pattern.
// ---------------------------------------------------------------------------

/** Bounded-concurrency map: at most `concurrency` workers run at once. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * Bounded async semaphore. At most `maxConcurrent` tasks run at once;
 * further `run` calls wait for a slot. Tasks that reject release their
 * slot like completed tasks (the rejection propagates to the caller).
 */
export function createSemaphore(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiters.shift()?.();
      }
    },
  };
}

/** Reject `promise` if it has not settled within `timeoutMs`. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
