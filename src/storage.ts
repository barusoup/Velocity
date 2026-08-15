import { invoke } from "@tauri-apps/api/core";

const VELOCITY_PREFIX = "velocity-";
let _initialized = false;
let _initFailed = false;
/**
 * Pending backend writes, coalesced by key. Player progress and session state
 * can change several times before the IPC bridge drains; persisting every
 * intermediate value only adds disk/IPC work and can grow the queue.
 *
 * Map insertion order remains stable for existing keys, while the latest
 * operation wins for each key. Writes are still applied sequentially.
 */
const _writeQueue = new Map<string, { type: "set" | "delete"; key: string; value?: string }>();
let _writeQueueFlushing = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 120;

function isVelocityKey(key: string): boolean {
  return key.startsWith(VELOCITY_PREFIX);
}

async function flushWriteQueue(): Promise<void> {
  if (_writeQueueFlushing) return;
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _writeQueueFlushing = true;
  try {
    while (_writeQueue.size > 0) {
      const batch = Array.from(_writeQueue.values());
      _writeQueue.clear();
      try {
        await invoke("write_user_data_batch", {
          entries: batch.map((op) => [op.key, op.type === "set" ? op.value ?? null : null]),
        });
      } catch (error) {
        console.warn("[storage] Backend batch write failed:", error);
      }
      // If new writes arrived while the IPC was in flight, loop will batch them.
      // Yield one microtask so the main thread can paint between large batches.
      if (_writeQueue.size > 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  } finally {
    _writeQueueFlushing = false;
  }
}

function scheduleFlush(): void {
  if (_flushTimer || _writeQueueFlushing) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flushWriteQueue();
  }, FLUSH_DEBOUNCE_MS);
}

function enqueueBackendWrite(type: "set" | "delete", key: string, value?: string): void {
  if (_initFailed) return;
  _writeQueue.set(key, { type, key, value });
  scheduleFlush();
}

export async function init(): Promise<void> {
  if (_initialized) return;

  try {
    const data = await invoke<Record<string, string>>("load_all_user_data");
    for (const [key, value] of Object.entries(data)) {
      localStorage.setItem(key, value);
    }
    _initialized = true;
    _initFailed = false;
  } catch {
    // File doesn't exist yet — first run. Mark initialized=false so
    // a later retry (e.g. from a "Retry" button or on next app launch)
    // can attempt again instead of being permanently stuck.
    _initFailed = true;
    _initialized = false;
  }
}

export function resetInit(): void {
  _initialized = false;
  _initFailed = false;
}

export function getItem(key: string): string | null {
  return localStorage.getItem(key);
}

export function setItem(key: string, value: string): void {
  localStorage.setItem(key, value);
  if (isVelocityKey(key)) {
    enqueueBackendWrite("set", key, value);
  }
}

export function removeItem(key: string): void {
  localStorage.removeItem(key);
  if (isVelocityKey(key)) {
    enqueueBackendWrite("delete", key);
  }
}

export async function flush(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushWriteQueue();
}

export async function clearAll(): Promise<void> {
  // Ensure queued mirrors cannot repopulate the backend after it is cleared.
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushWriteQueue();
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isVelocityKey(k)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  await invoke("clear_all_user_data_backend");
}
