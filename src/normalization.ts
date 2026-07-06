import type { LoudnessData } from "./types";
import { getItem, setItem } from "./storage";

const LOUDNESS_CACHE_KEY = "velocity-loudness-cache";
const TARGET_LUFS_KEY = "velocity-target-lufs";

const DEFAULT_TARGET_LUFS = -14;
const TRUE_PEAK_CEILING_DB = -1;
// Allow boosting quiet tracks so all songs land near the same perceived
// volume. +12 dB matches commercial streaming services (Spotify, YouTube
// Music). Pushing higher risks elevating the noise floor on low-level
// recordings (acoustic, classical, podcasts) audibly.
const MAX_GAIN_DB = 12;
const MIN_GAIN_DB = -24;
const LOUDNESS_ANALYSIS_VERSION = 2;
const NORMALIZATION_DEADBAND_DB = 1;
const SOFT_ATTENUATION_RATIO = 0.75;

function clampDb(value: number): number {
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// In-memory cache avoids re-parsing localStorage on every read. The cache is
// invalidated when `saveCache` writes a new value, so callers that only read
// never pay the parse cost more than once per session.
let _loudnessCache: Record<string, LoudnessData> | null = null;

function loadCache(): Record<string, LoudnessData> {
  if (_loudnessCache !== null) return _loudnessCache;
  let cache: Record<string, LoudnessData>;
  try {
    const raw = getItem(LOUDNESS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  _loudnessCache = cache;
  return cache;
}

function saveCache(cache: Record<string, LoudnessData>): void {
  _loudnessCache = cache;
  setItem(LOUDNESS_CACHE_KEY, JSON.stringify(cache));
}

export function getCachedLoudness(trackId: string): LoudnessData | null {
  const cached = loadCache()[trackId] ?? null;
  return isUsableLoudness(cached) && cached.analysisVersion === LOUDNESS_ANALYSIS_VERSION ? cached : null;
}

export function setCachedLoudness(trackId: string, data: LoudnessData): void {
  const cache = loadCache();
  cache[trackId] = { ...data, analysisVersion: LOUDNESS_ANALYSIS_VERSION };
  saveCache(cache);
}

// Default to the target itself so unanalyzed tracks play at unity gain
// until loudness analysis runs. Picking a louder reference (e.g. -9.5 LUFS
// for typical over-mastered YouTube content) produced an initial cut that
// made quiet tracks audibly quieter before analysis could correct them;
// staying neutral means preview/full analysis apply the right gain as soon
// as it's available rather than fighting a pre-applied bias.
export const ASSUMED_AVERAGE_LUFS = DEFAULT_TARGET_LUFS;

export function getInitialGain(targetLufs: number): number {
  if (!isFiniteNumber(targetLufs)) return 1;
  const gainDb = computeGainDb(
    { integratedLufs: ASSUMED_AVERAGE_LUFS, truePeak: null },
    targetLufs,
  );
  return Math.pow(10, gainDb / 20);
}

export function hasAttemptedAnalysis(trackId: string): boolean {
  const cache = loadCache();
  return trackId in cache;
}

export function isUsableLoudness(loudness: LoudnessData | null | undefined): loudness is LoudnessData {
  return isFiniteNumber(loudness?.integratedLufs);
}

// Returns the gain (in dB) needed to bring the track's integrated
// loudness toward the target. Symmetric: cuts loud masters and boosts
// quiet masters so all songs land at roughly the same perceived volume.
// The deadband keeps perceived-equivalent tracks un-touched; the soft
// ratio keeps dynamics from being crushed against the target — boosting
// a -19 LUFS master is gentle, not a hard slam to the exact target.
function computeIntegratedGainDb(integratedLufs: number, targetLufs: number): number {
  const diffDb = integratedLufs - targetLufs;
  if (!Number.isFinite(diffDb) || Math.abs(diffDb) <= NORMALIZATION_DEADBAND_DB) return 0;
  const adjustmentDb = (Math.abs(diffDb) - NORMALIZATION_DEADBAND_DB) * SOFT_ATTENUATION_RATIO;
  // Sign flip: overshoot (positive diff) gets cut (negative gain);
  // undershoot (negative diff) gets boosted (positive gain).
  return clampDb(diffDb > 0 ? -adjustmentDb : adjustmentDb);
}

// Returns the maximum allowable gain (in dB) such that after applying the
// gain the track's true peak doesn't exceed the ceiling. Dual of the
// legacy "peak guard cuts" logic: instead of forcing overshoots down to
// the ceiling, we cap amplifications so a boosted signal still peaks
// safely. When truePeak is unknown we permit any gain up to MAX_GAIN_DB;
// when truePeak already exceeds the ceiling the constraint becomes a
// (negative) mandatory cut.
function computePeakGuardMaxGainDb(truePeak: number | null | undefined): number {
  if (!isFiniteNumber(truePeak)) return MAX_GAIN_DB;
  return Math.min(MAX_GAIN_DB, TRUE_PEAK_CEILING_DB - truePeak);
}

function computeGainDb(loudness: Pick<LoudnessData, "integratedLufs" | "truePeak">, targetLufs: number): number {
  if (!isFiniteNumber(loudness.integratedLufs) || !isFiniteNumber(targetLufs)) return 0;

  const integratedGainDb = computeIntegratedGainDb(loudness.integratedLufs, targetLufs);
  const peakGuardMaxGainDb = computePeakGuardMaxGainDb(loudness.truePeak);

  // Take whichever is smaller. For cuts (integrated negative, or
  // peakGuard a cut because truePeak > ceiling), `min` picks the stronger
  // reduction — matching the legacy "use whichever cut is stronger"
  // semantics. For boosts, `peakGuardMaxGainDb` acts as a ceiling so a
  // loud-master quiet-mix doesn't get pushed past -1 dBFS into the
  // limiter's heavy-compression region.
  return clampDb(Math.min(integratedGainDb, peakGuardMaxGainDb));
}

export function computeLinearGain(loudness: LoudnessData, targetLufs: number): number {
  if (!isUsableLoudness(loudness) || !isFiniteNumber(targetLufs)) return 1;

  const gainDb = computeGainDb(loudness, targetLufs);
  return Math.pow(10, gainDb / 20);
}

export function loadTargetLufs(): number {
  try {
    const raw = getItem(TARGET_LUFS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_TARGET_LUFS;
  } catch {
    return DEFAULT_TARGET_LUFS;
  }
}

export function saveTargetLufs(lufs: number): void {
  setItem(TARGET_LUFS_KEY, JSON.stringify(lufs));
}

export {
  DEFAULT_TARGET_LUFS,
  LOUDNESS_ANALYSIS_VERSION,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  TRUE_PEAK_CEILING_DB,
};
