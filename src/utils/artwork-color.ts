export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

type HslColor = {
  h: number;
  s: number;
  l: number;
};

const DEFAULT_ACCENT: RgbColor = { r: 80, g: 80, b: 80 };

// Tracks both the in-flight promise (for deduplication) and the resolved
// value (for synchronous peek). Callers that revisit an artwork they've
// already colored can read the cached accent synchronously via
// `peekArtworkAccent` and avoid the default-color flash that the async
// re-extraction would otherwise produce.
type AccentEntry = {
  promise: Promise<RgbColor>;
  resolved: boolean;
  value: RgbColor | undefined;
};

const accentCache = new Map<string, AccentEntry>();
const ACCENT_CACHE_MAX = 400;

export async function extractInterestingArtworkColor(src?: string | null): Promise<RgbColor> {
  if (!src) return DEFAULT_ACCENT;

  const normalized = src.startsWith("//") ? `https:${src}` : src;
  const existing = accentCache.get(normalized);
  if (existing) {
    // LRU touch.
    accentCache.delete(normalized);
    accentCache.set(normalized, existing);
    return existing.promise;
  }

  const promise = extractInterestingArtworkColorInternal(normalized).catch(() => DEFAULT_ACCENT);
  const entry: AccentEntry = { promise, resolved: false, value: undefined };
  promise.then((value) => {
    if (accentCache.get(normalized) === entry) {
      entry.resolved = true;
      entry.value = value;
    }
  });
  accentCache.set(normalized, entry);
  if (accentCache.size > ACCENT_CACHE_MAX) {
    const oldestKey = accentCache.keys().next().value;
    if (oldestKey !== undefined) accentCache.delete(oldestKey);
  }
  return promise;
}

// Returns the already-extracted accent for `src` synchronously, or null if
// nothing is cached yet. Use this to seed a component's initial state so it
// doesn't flash `DEFAULT_ACCENT` before the async extraction resolves.
export function peekArtworkAccent(src?: string | null): RgbColor | null {
  if (!src) return null;
  const normalized = src.startsWith("//") ? `https:${src}` : src;
  const entry = accentCache.get(normalized);
  if (!entry || !entry.resolved || entry.value === undefined) return null;
  return entry.value;
}

export function mixRgb(left: RgbColor, right: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(left.r + (right.r - left.r) * amount),
    g: Math.round(left.g + (right.g - left.g) * amount),
    b: Math.round(left.b + (right.b - left.b) * amount),
  };
}

export function rgbToCss(color: RgbColor, alpha = 1): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

async function extractInterestingArtworkColorInternal(src: string): Promise<RgbColor> {
  const image = await loadImage(src);
  const sample = sampleImage(image);
  const best = pickInterestingBucket(sample);
  return normalizeAccent(best ?? fallbackAverage(sample) ?? DEFAULT_ACCENT);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return loadFromBlob(src).catch(() => decodeImage(src));
}

async function loadFromBlob(src: string): Promise<HTMLImageElement> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Artwork fetch failed: ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error("Artwork fetch was empty.");
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await decodeImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Artwork failed to load."));
    image.src = src;
  });
}

function sampleImage(image: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  const longestEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1);
  const scale = Math.min(1, 72 / longestEdge);
  canvas.width = Math.max(24, Math.round((image.naturalWidth || image.width || 72) * scale));
  canvas.height = Math.max(24, Math.round((image.naturalHeight || image.height || 72) * scale));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is unavailable.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function pickInterestingBucket(sample: ImageData): RgbColor | null {
  const buckets = new Map<
    string,
    {
      weight: number;
      red: number;
      green: number;
      blue: number;
      saturation: number;
      lightness: number;
    }
  >();

  const { data, width, height } = sample;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3] / 255;
      if (alpha < 0.96) continue;

      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const hsl = rgbToHsl(red, green, blue);

      if (hsl.l < 0.04 || hsl.l > 0.94) continue;
      if (hsl.s < 0.06 && hsl.l > 0.15 && hsl.l < 0.85) continue;

      const centerX = width <= 1 ? 0.5 : x / (width - 1);
      const centerY = height <= 1 ? 0.5 : y / (height - 1);
      const distance = Math.hypot(centerX - 0.5, centerY - 0.5);
      const centerBias = 1.18 - Math.min(distance * 0.85, 0.55);
      const chromaBias = 0.42 + hsl.s * 1.25;
      const balanceBias = 1.08 - Math.min(Math.abs(hsl.l - 0.48) * 1.2, 0.58);
      const weight = centerBias * chromaBias * balanceBias;

      const bucketHue = Math.round(hsl.h / 16);
      const bucketSat = Math.round(hsl.s * 7);
      const bucketLight = Math.round(hsl.l * 6);
      const key = `${bucketHue}:${bucketSat}:${bucketLight}`;
      const current = buckets.get(key) ?? {
        weight: 0,
        red: 0,
        green: 0,
        blue: 0,
        saturation: 0,
        lightness: 0,
      };

      current.weight += weight;
      current.red += red * weight;
      current.green += green * weight;
      current.blue += blue * weight;
      current.saturation += hsl.s * weight;
      current.lightness += hsl.l * weight;
      buckets.set(key, current);
    }
  }

  let bestScore = -1;
  let bestColor: RgbColor | null = null;

  for (const bucket of buckets.values()) {
    const avgSaturation = bucket.saturation / bucket.weight;
    const avgLightness = bucket.lightness / bucket.weight;
    const vibrance = avgSaturation * (1 - Math.abs(avgLightness - 0.52) * 0.9);
    const prominence = Math.pow(bucket.weight, 0.7);
    const score = prominence * (0.55 + avgSaturation * 1.4 + vibrance * 1.3);

    if (score > bestScore) {
      bestScore = score;
      bestColor = {
        r: Math.round(bucket.red / bucket.weight),
        g: Math.round(bucket.green / bucket.weight),
        b: Math.round(bucket.blue / bucket.weight),
      };
    }
  }

  return bestColor;
}

function fallbackAverage(sample: ImageData): RgbColor | null {
  const { data } = sample;
  let totalWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.96) continue;

    const hsl = rgbToHsl(data[index], data[index + 1], data[index + 2]);
    const weight = 0.2 + hsl.s * 1.15 + (1 - Math.abs(hsl.l - 0.5));
    totalWeight += weight;
    red += data[index] * weight;
    green += data[index + 1] * weight;
    blue += data[index + 2] * weight;
  }

  if (totalWeight === 0) return null;

  return {
    r: Math.round(red / totalWeight),
    g: Math.round(green / totalWeight),
    b: Math.round(blue / totalWeight),
  };
}

function normalizeAccent(color: RgbColor): RgbColor {
  const hsl = rgbToHsl(color.r, color.g, color.b);
  const saturation = hsl.s < 0.08 ? hsl.s : clamp(hsl.s * 1.15, 0.18, 0.84);
  const minLight = hsl.l < 0.18 ? 0.18 : 0.22;
  const maxLight = hsl.l > 0.78 ? 0.78 : 0.68;
  return hslToRgb({
    h: hsl.h,
    s: saturation,
    l: clamp(hsl.l, minLight, maxLight),
  });
}

function rgbToHsl(red: number, green: number, blue: number): HslColor {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;
  switch (max) {
    case r:
      hue = (g - b) / delta + (g < b ? 6 : 0);
      break;
    case g:
      hue = (b - r) / delta + 2;
      break;
    default:
      hue = (r - g) / delta + 4;
      break;
  }

  return {
    h: hue * 60,
    s: saturation,
    l: lightness,
  };
}

function hslToRgb(color: HslColor): RgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const saturation = clamp(color.s, 0, 1);
  const lightness = clamp(color.l, 0, 1);

  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { r: value, g: value, b: value };
  }

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const match = lightness - chroma / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (segment >= 0 && segment < 1) {
    r = chroma;
    g = x;
  } else if (segment < 2) {
    r = x;
    g = chroma;
  } else if (segment < 3) {
    g = chroma;
    b = x;
  } else if (segment < 4) {
    g = x;
    b = chroma;
  } else if (segment < 5) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return {
    r: Math.round((r + match) * 255),
    g: Math.round((g + match) * 255),
    b: Math.round((b + match) * 255),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
