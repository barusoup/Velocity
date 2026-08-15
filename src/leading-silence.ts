import { getItem, setItem } from "./storage";
import type { LeadingSilenceData } from "./types";

const LEADING_SILENCE_CACHE_KEY = "velocity-leading-silence-cache";

// Bump whenever the Rust detection parameters change to invalidate stale
// cached results. v5 → v6: robust stream trimming with -42 dB threshold
// and 0.35s minimum skip.
// v6 → v7: switch to sample-accurate atrim re-encode and cap at 8s to avoid
// trimming intended quiet intros; lyrics no longer offset by silence.
export const LEADING_SILENCE_ANALYSIS_VERSION = 7;
export const MIN_LEADING_SILENCE_SKIP = 0.35;
export const MAX_LEADING_SILENCE_SKIP = 8;
export const LEADING_SILENCE_DETECT_TIMEOUT_MS = 8000;
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

export function resetLeadingSilenceCacheForTests(): void {
  _leadingSilenceCache = null;
}