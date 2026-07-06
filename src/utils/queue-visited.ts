/** Lowest queue index before `currentIndex` whose track was actually started. */
export function findPreviousVisitedQueueIndex(
  queue: readonly { id: string }[],
  currentIndex: number,
  visitedTrackIds: ReadonlySet<string>,
): number {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const track = queue[index];
    if (track && visitedTrackIds.has(track.id)) return index;
  }
  return -1;
}

export function addVisitedQueueTrack(
  visitedTrackIds: ReadonlySet<string>,
  trackId: string,
): ReadonlySet<string> {
  if (visitedTrackIds.has(trackId)) return visitedTrackIds;
  const next = new Set(visitedTrackIds);
  next.add(trackId);
  return next;
}

export function removeVisitedQueueTrack(
  visitedTrackIds: ReadonlySet<string>,
  trackId: string,
): ReadonlySet<string> {
  if (!visitedTrackIds.has(trackId)) return visitedTrackIds;
  const next = new Set(visitedTrackIds);
  next.delete(trackId);
  return next;
}

export function resetVisitedQueueTracks(trackId: string): ReadonlySet<string> {
  return new Set([trackId]);
}

export function restoreVisitedQueueTracks(ids: readonly string[]): ReadonlySet<string> {
  return new Set(ids);
}

export function resolveHistoryVisitedTrackIds(
  entry: { track: { id: string }; queueVisitedTrackIds?: readonly string[] },
): readonly string[] {
  if (entry.queueVisitedTrackIds && entry.queueVisitedTrackIds.length > 0) {
    return entry.queueVisitedTrackIds;
  }
  return [entry.track.id];
}