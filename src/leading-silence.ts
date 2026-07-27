import { getItem, setItem } from "./storage";
import type { LeadingSilenceData } from "./types";

const LEADING_SILENCE_CACHE_KEY = "velocity-leading-silence-cache";

// Bump whenever the Rust detection parameters change to invalidate stale
// cached results. v2 → v3: lowered SILENCE_NOISE_DB from -35 to -50,
// added SILENCE_END_PREROLL of 0.15 s.
export const LEADING_SILENCE_ANALYSIS_VERSION = 3;
export const MIN_LEADING_SILENCE_SKIP = 1;
export const MAX_LEADING_SILENCE_SKIP = 30;
export const LEADING_SILENCE_DETECT_TIMEOUT_MS = 2500;
/** Cap persisted leading-silence entries so long sessions don't grow without bound. */
export const LEADING_SILENCE_CACHE_MAX_ENTRIES = 500;

let _leadingSilenceCache: Record<string, LeadingSilenceData> | null = null;

function loadCache(): Record<string, LeadingSilenceData> {
  if (_leadingSilenceCache !== null) return _leadingSilenceCache;
  let cache: Record<string, LeadingSilenceData>;
  try {
    const raw = getItem(LEADING_SILENCE_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  _leadingSilenceCache = cache;
  return cache;
}

function trimLeadingSilenceCache(
  cache: Record<string, LeadingSilenceData>,
): Record<string, LeadingSilenceData> {
  const entries = Object.entries(cache);
  if (entries.length <= LEADING_SILENCE_CACHE_MAX_ENTRIES) return cache;
  // Keep the most recently inserted entries (tail of the object).
  return Object.fromEntries(entries.slice(-LEADING_SILENCE_CACHE_MAX_ENTRIES));
}

function saveCache(cache: Record<string, LeadingSilenceData>): void {
  const trimmed = trimLeadingSilenceCache(cache);
  _leadingSilenceCache = trimmed;
  setItem(LEADING_SILENCE_CACHE_KEY, JSON.stringify(trimmed));
}

export function getCachedLeadingSilence(trackId: string): LeadingSilenceData | null {
  const cached = loadCache()[trackId] ?? null;
  if (!cached || cached.analysisVersion !== LEADING_SILENCE_ANALYSIS_VERSION) return null;
  return cached;
}

export function setCachedLeadingSilence(trackId: string, data: LeadingSilenceData): void {
  const cache = loadCache();
  cache[trackId] = { ...data, analysisVersion: LEADING_SILENCE_ANALYSIS_VERSION };
  saveCache(cache);
}

export function hasAttemptedLeadingSilenceAnalysis(trackId: string): boolean {
  const cached = loadCache()[trackId];
  return cached?.analysisVersion === LEADING_SILENCE_ANALYSIS_VERSION;
}

export function resolveLeadingSilenceSkipSeconds(trackId: string): number {
  const cached = getCachedLeadingSilence(trackId);
  const skip = cached?.skipSeconds;
  if (typeof skip !== "number" || !Number.isFinite(skip)) return 0;
  if (skip < MIN_LEADING_SILENCE_SKIP) return 0;
  return Math.min(skip, MAX_LEADING_SILENCE_SKIP);
}