import { cacheArtwork, peekCachedArtwork } from "../api";

const DEFAULT_CONCURRENCY = 6;

function normalizeArtworkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (
    normalized.startsWith("asset://") ||
    normalized.startsWith("blob:") ||
    normalized.startsWith("data:")
  ) {
    return null;
  }
  return normalized;
}

/** Deduplicated remote artwork URLs that are not already in the session cache. */
export function uncachedArtworkUrls(urls: Array<string | null | undefined>): string[] {
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const normalized = normalizeArtworkUrl(raw);
    if (!normalized || seen.has(normalized) || peekCachedArtwork(normalized)) continue;
    seen.add(normalized);
    pending.push(normalized);
  }
  return pending;
}

/**
 * Warm the artwork disk cache for a list of URLs without blocking the UI.
 * Already-cached URLs are skipped. Failures are ignored — this is best-effort.
 */
export function preloadArtworkUrls(
  urls: Array<string | null | undefined>,
  options?: { concurrency?: number; signal?: AbortSignal },
): void {
  const pending = uncachedArtworkUrls(urls);
  if (pending.length === 0 || options?.signal?.aborted) return;

  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;

  const worker = async () => {
    while (!options?.signal?.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      try {
        await cacheArtwork(pending[index]!);
      } catch {
        // Best-effort preload.
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, () => worker());
  void Promise.all(workers);
}