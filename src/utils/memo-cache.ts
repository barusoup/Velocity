/**
 * MemoCache — LRU-bounded promise cache with TTL, deduplication, and alias support.
 *
 * This is the single implementation used by all frontend caches (search, entity,
 * stream, lyrics, etc.). Compared to the original inline class in api.ts it:
 *  - Uses Map insertion-order for O(1) LRU instead of O(n) scan for oldest
 *  - Supports key aliases (canonicalization) so `yt:videoId` and
 *    `yt:videoId:browseId` that resolve to same audio share one entry
 *  - Tracks hit/miss/eviction counts for debugging
 *  - Has a clear()` and `size` getter for tests and memory-stress harness
 */

type CacheEntry<T> = {
  promise: Promise<T>;
  resolved: boolean;
  value: T | undefined;
  error: unknown | undefined;
  insertedAt: number;
  resolvedAt: number | undefined;
};

export type MemoCacheOptions = {
  maxSize: number;
  ttlMs?: number;
  name?: string;
};

export class MemoCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  // Alias map: aliasKey -> canonicalKey. Allows `videoId` and `resolvedVideoId`
  // to point at same entry without duplicating the promise/value.
  private alias = new Map<string, string>();
  // Reverse alias index: canonicalKey -> Set<aliasKey> for cleanup on eviction
  private aliasReverse = new Map<string, Set<string>>();

  constructor(private readonly options: MemoCacheOptions) {}

  get maxSize(): number {
    return this.options.maxSize;
  }
  get ttlMs(): number | undefined {
    return this.options.ttlMs;
  }
  get size(): number {
    return this.entries.size;
  }
  get aliasCount(): number {
    return this.alias.size;
  }

  stats(): { size: number; aliasCount: number; hits: number; misses: number } {
    return { size: this.entries.size, aliasCount: this.alias.size, hits: this.hits, misses: this.misses };
  }

  private resolveKey(key: string): string {
    return this.alias.get(key) ?? key;
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    if (this.options.ttlMs === undefined) return false;
    if (!entry.resolved) return false;
    const age = Date.now() - (entry.resolvedAt ?? entry.insertedAt);
    return age > this.options.ttlMs;
  }

  /** Move key to most-recent position (Map insertion order = recency) */
  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  has(key: string): boolean {
    const canonical = this.resolveKey(key);
    return this.entries.has(canonical);
  }

  peek(key: string): T | null {
    const canonical = this.resolveKey(key);
    const entry = this.entries.get(canonical);
    if (!entry || !entry.resolved || entry.error !== undefined) {
      this.misses += 1;
      return null;
    }
    if (this.isExpired(entry)) {
      this.delete(canonical);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.touch(canonical, entry);
    return entry.value ?? null;
  }

  isPending(key: string): boolean {
    const canonical = this.resolveKey(key);
    const entry = this.entries.get(canonical);
    return entry !== undefined && !entry.resolved;
  }

  getOrCreate(
    key: string,
    factory: () => Promise<T>,
    shouldCache?: (value: T) => boolean,
  ): Promise<T> {
    const canonical = this.resolveKey(key);
    const existing = this.entries.get(canonical);
    if (existing) {
      if (this.isExpired(existing)) {
        this.delete(canonical);
      } else {
        this.hits += 1;
        this.touch(canonical, existing);
        return existing.promise;
      }
    }
    this.misses += 1;

    const promise = factory();
    const entry: CacheEntry<T> = {
      promise,
      resolved: false,
      value: undefined,
      error: undefined,
      insertedAt: Date.now(),
      resolvedAt: undefined,
    };

    promise
      .then((value) => {
        if (this.entries.get(canonical) !== entry) return;
        entry.resolved = true;
        entry.resolvedAt = Date.now();
        entry.value = value;
        if (shouldCache && !shouldCache(value)) {
          this.delete(canonical);
        }
      })
      .catch((error) => {
        if (this.entries.get(canonical) !== entry) return;
        entry.resolved = true;
        entry.resolvedAt = Date.now();
        entry.error = error;
        this.delete(canonical);
      });

    this.entries.set(canonical, entry);
    this.evictIfNeeded();
    return promise;
  }

  /**
   * Like getOrCreate but supports aliasing: `aliasKeys` will be mapped to
   * `canonicalKey` so future gets/peeks for any alias resolve to the same entry.
   * Used for streamIdentityVideoIds — all videoIds for same song share one cache.
   */
  getOrCreateWithAliases(
    canonicalKey: string,
    aliasKeys: string[],
    factory: () => Promise<T>,
    shouldCache?: (value: T) => boolean,
  ): Promise<T> {
    for (const alias of aliasKeys) {
      if (alias !== canonicalKey && !this.alias.has(alias)) {
        this.alias.set(alias, canonicalKey);
        let set = this.aliasReverse.get(canonicalKey);
        if (!set) {
          set = new Set();
          this.aliasReverse.set(canonicalKey, set);
        }
        set.add(alias);
      }
    }
    return this.getOrCreate(canonicalKey, factory, shouldCache);
  }

  peekWithAliases(keys: string[]): T | null {
    for (const key of keys) {
      const v = this.peek(key);
      if (v !== null) return v;
    }
    return null;
  }

  isPendingAny(keys: string[]): boolean {
    for (const key of keys) {
      if (this.isPending(key)) return true;
    }
    return false;
  }

  delete(key: string): void {
    const canonical = this.resolveKey(key);
    // If key was an alias, just drop the alias mapping
    if (canonical !== key) {
      this.alias.delete(key);
      const set = this.aliasReverse.get(canonical);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.aliasReverse.delete(canonical);
      }
      return;
    }
    this.entries.delete(canonical);
    const aliases = this.aliasReverse.get(canonical);
    if (aliases) {
      for (const a of aliases) this.alias.delete(a);
      this.aliasReverse.delete(canonical);
    }
  }

  deleteMany(keys: string[]): void {
    for (const k of keys) this.delete(k);
  }

  prime(key: string, value: T): void {
    const canonical = this.resolveKey(key);
    if (this.entries.has(canonical)) return;
    const entry: CacheEntry<T> = {
      promise: Promise.resolve(value),
      resolved: true,
      value,
      error: undefined,
      insertedAt: Date.now(),
      resolvedAt: Date.now(),
    };
    this.entries.set(canonical, entry);
    this.evictIfNeeded();
  }

  primeWithAliases(canonicalKey: string, aliasKeys: string[], value: T): void {
    this.prime(canonicalKey, value);
    for (const alias of aliasKeys) {
      if (alias !== canonicalKey && !this.alias.has(alias)) {
        this.alias.set(alias, canonicalKey);
        let set = this.aliasReverse.get(canonicalKey);
        if (!set) {
          set = new Set();
          this.aliasReverse.set(canonicalKey, set);
        }
        set.add(alias);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.alias.clear();
    this.aliasReverse.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.options.maxSize) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }
}

// Factory helper so call sites read like `createCache({ maxSize: 100, ttlMs: 20*60*1000 })`
export function createCache<T>(options: MemoCacheOptions): MemoCache<T> {
  return new MemoCache<T>(options);
}

// Deep rewrite: single TtlCache + alias map replaces 7 ad-hoc caches; O1 LRU via Map insertion order
