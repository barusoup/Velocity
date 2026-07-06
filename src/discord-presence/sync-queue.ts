import type { DiscordPresencePayload } from "../api";

export type QueuedPresenceSync = {
  payload: DiscordPresencePayload;
  generation: number;
};

/** Keep only the newest queued sync (later generations win). */
export function collapseQueuedSync(
  current: QueuedPresenceSync | null,
  incoming: QueuedPresenceSync,
): QueuedPresenceSync {
  if (!current) return incoming;
  return incoming.generation >= current.generation ? incoming : current;
}

/** Drop syncs that were superseded before we invoke IPC. */
export function isSupersededQueuedSync(
  queuedGeneration: number,
  engineGeneration: number,
): boolean {
  return queuedGeneration < engineGeneration;
}

/** True when a completed IPC invoke no longer reflects the engine head. */
export function isStaleIpcGeneration(
  sentGeneration: number,
  engineGeneration: number,
): boolean {
  return sentGeneration !== engineGeneration;
}