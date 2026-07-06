import { getItem, setItem } from "./storage";
import type { LeadingSilenceData } from "./types";

const LEADING_SILENCE_CACHE_KEY = "velocity-leading-silence-cache";

export const LEADING_SILENCE_ANALYSIS_VERSION = 2;
export const MIN_LEADING_SILENCE_SKIP = 1;
export const MAX_LEADING_SILENCE_SKIP = 30;
export const LEADING_SILENCE_DETECT_TIMEOUT_MS = 2500;

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

function saveCache(cache: Record<string, LeadingSilenceData>): void {
  _leadingSilenceCache = cache;
  setItem(LEADING_SILENCE_CACHE_KEY, JSON.stringify(cache));
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