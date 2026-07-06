/** Progress deltas larger than this are treated as seeks, not listened time. */
export const MAX_LISTEN_PROGRESS_STEP_SECONDS = 2.5;

export type ListenSession = {
  trackId: string;
  lastProgress: number;
  accumulatedSeconds: number;
  qualified: boolean;
};

export function createListenSession(trackId: string, progress: number): ListenSession {
  return {
    trackId,
    lastProgress: progress,
    accumulatedSeconds: 0,
    qualified: false,
  };
}

export type ListenSampleInput = {
  trackId: string;
  progress: number;
  duration: number;
  isPlaying: boolean;
  qualifyRatio: number;
};

export type ListenSampleResult = {
  session: ListenSession;
  /** True only on the sample that crosses the qualify threshold. */
  newlyQualified: boolean;
};

/**
 * Advance listen accounting for one progress sample. Only counts time while
 * playing and only when the playhead advances in small, continuous steps.
 * Large jumps (seeks) update the anchor without adding to accumulated time.
 */
export function sampleListenProgress(
  session: ListenSession | null,
  input: ListenSampleInput,
): ListenSampleResult {
  const { trackId, progress, duration, isPlaying, qualifyRatio } = input;

  if (!Number.isFinite(duration) || duration <= 0) {
    const fallback = session ?? createListenSession(trackId, progress);
    return { session: fallback, newlyQualified: false };
  }

  let next =
    session && session.trackId === trackId
      ? session
      : createListenSession(trackId, progress);

  if (next.qualified) {
    return { session: next, newlyQualified: false };
  }

  if (isPlaying) {
    const delta = progress - next.lastProgress;
    if (delta > 0 && delta <= MAX_LISTEN_PROGRESS_STEP_SECONDS) {
      next = {
        ...next,
        accumulatedSeconds: next.accumulatedSeconds + delta,
      };
    }
  }

  next = { ...next, lastProgress: progress };

  const threshold = duration * qualifyRatio;
  if (next.accumulatedSeconds >= threshold && !next.qualified) {
    next = { ...next, qualified: true };
    return { session: next, newlyQualified: true };
  }

  return { session: next, newlyQualified: false };
}