// ---------------------------------------------------------------------------
// Track title utilities — the single source of truth for title normalization,
// music-video / variant detection, and edition-aware title comparison.
//
// These helpers were previously duplicated (with subtle drift) across
// `song-resolution.ts`, `media.ts`, and `upload-enrichment.ts`. Every module
// that needs to compare, clean, or classify track titles should import from
// here.
// ---------------------------------------------------------------------------

/** Strip diacritics and collapse punctuation to spaces, lowercased. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Jaccard-style token overlap in [0, 1]; 0 when either side is empty. */
export function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

// Marker words stripped from the START of a title before comparison
// ("Official Video — Song Name", "[Official Audio] Song", ...).
const VIDEO_TITLE_PREFIX_REGEX = new RegExp(
  "^[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video)[\\)\\]]?\\s*[-–—:]?\\s*",
  "i",
);

// Marker words stripped from the END of a title before comparison
// ("Song Name (Official Video)", "Song Name — Live", ...).
const VIDEO_TITLE_SUFFIX_REGEX = new RegExp(
  "[\\(\\[]?(official\\s+(music\\s+)?video|official\\s+audio|music\\s+video|official\\s+visualizer|visualizer|audio|video|lyrics?|lyric\\s+video|clip|m\\/v|hd|4k|hq|(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?)[\\)\\]]?\\s*$",
  "i",
);

/** Titles that explicitly name a music video ("(Official Music Video)", "(MV)", "Lyric Video", "Official 4K Video", ...). */
const EXPLICIT_MUSIC_VIDEO_TITLE_MARKERS =
  /\b(official\s+)?(music\s+video|lyric\s+video)\b|\bofficial\s+(?:hd|4k|8k|uhd|60\s?fps)?\s*video\b|\(mv\)|\[mv\]/i;

/** Recording-variant qualifiers — live/acoustic/remix/demo/covers, etc. */
const RECORDING_VARIANT_MARKERS =
  /\b(live(?:\s*\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\b/i;

const REMASTER_EDITION_REGEX =
  /\(([^)]*\b(?:\d{4}\s+)?remaster(?:ed)?[^)]*)\)|\b(\d{4}\s+remaster(?:ed)?)\b/i;

/**
 * Recording-variant qualifier pattern — a variant marker only counts when it
 * appears as a qualifier (inside parentheses or after a dash suffix, e.g.
 * "Song (Live)", "Song -- Live 2"). A marker word embedded in the base
 * title ("Radio Ga Ga", "Version 2.0", "Original Sin") must NOT classify
 * the track as a variant recording, or autoplay would drop legitimate songs.
 */
const VARIANT_QUALIFIER_PATTERN = new RegExp(
  "\\([^)]*\\b(live(?:\\s*\\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\\b[^)]*\\)" +
    "|\\s+[-–—]\\s*(live(?:\\s*\\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\\b",
  "i",
);

/**
 * Strip video/audio/lyric qualifiers from a title so "Song (Official Music
 * Video)" and "Song — Official Audio" both compare as "Song".
 */
export function cleanAutoplaySearchTitle(title: string): string {
  return title
    .replace(VIDEO_TITLE_PREFIX_REGEX, "")
    .replace(VIDEO_TITLE_SUFFIX_REGEX, "")
    .replace(/\s*[-–—]\s*topic\s*$/i, "")
    .trim();
}

/** Whether a title explicitly names a music video (or "(MV)"). */
export function titleLooksLikeMusicVideo(title: string): boolean {
  return EXPLICIT_MUSIC_VIDEO_TITLE_MARKERS.test(title);
}

/** Whether a title carries a recording-variant qualifier (live, remix, ...). */
export function isVariantRecordingTitle(title: string): boolean {
  return VARIANT_QUALIFIER_PATTERN.test(title);
}

const VARIANT_QUALIFIER_STRIP = new RegExp(
  "\\([^)]*\\b(live(?:\\s*\\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\\b[^)]*\\)" +
    "|\\s+[-–—]\\s*(live(?:\\s*\\d+)?|acoustic|unplugged|remix|demo|outtake|outtakes|instrumental|karaoke|cover|session|reprise|version|ver|normal|special|original|edit|extended|radio)\\b.*$",
  "gi",
);

/**
 * Remove recording-variant qualifiers so "Song (Live)" and "Song -- Live 2"
 * reduce to their base title "Song". Used by the studio-version matchers.
 */
export function stripVariantQualifiers(title: string): string {
  return title.replace(VARIANT_QUALIFIER_STRIP, " ").trim();
}

/**
 * Edition fingerprint so a 2007 remaster never matches the original studio
 * cut ("(2007 Remaster)" → "2007 remaster"). Null when the title has no
 * edition marker.
 */
export function remasterEditionKey(title: string): string | null {
  const match = title.match(REMASTER_EDITION_REGEX);
  if (!match) return null;
  return normalizeText(match[1] ?? match[2] ?? "");
}

/** Whether two titles describe the same remaster edition. */
export function editionsCompatible(sourceTitle: string, candidateTitle: string): boolean {
  return remasterEditionKey(sourceTitle) === remasterEditionKey(candidateTitle);
}

type RecordingVariantFlags = { hasVariant: boolean; normalized: string };

function recordingVariantFlags(title: string): RecordingVariantFlags {
  const cleaned = cleanAutoplaySearchTitle(title);
  return {
    hasVariant: RECORDING_VARIANT_MARKERS.test(cleaned),
    normalized: normalizeText(cleaned),
  };
}

/**
 * Whether two titles describe the same recording for audio-swap purposes:
 * same remaster edition AND same variant class ("Song -- Live 2" never
 * matches "Song -- Normal ver"). This is deliberately strict — it exists so
 * a live upload can never silently replace a studio cut (and vice versa).
 */
export function titlesMatchForAudioSwap(sourceTitle: string, candidateTitle: string): boolean {
  if (!editionsCompatible(sourceTitle, candidateTitle)) return false;
  const source = recordingVariantFlags(sourceTitle);
  const candidate = recordingVariantFlags(candidateTitle);
  if (source.hasVariant !== candidate.hasVariant) return false;
  return source.normalized === candidate.normalized;
}
