import type { ArtistCredit } from "../types";

export type ArtistLinePart =
  | { type: "text"; value: string }
  | { type: "credit"; value: string; credit: ArtistCredit };

export type ArtistNamePart =
  | { type: "text"; value: string }
  | { type: "name"; value: string };

const COLLABORATION_SEPARATOR_PATTERN =
  /(\s+(?:&|and|x|\+|with|ft\.?|feat\.?|featuring|vs\.?)\s+|\s*,\s*)/gi;

function normalizeArtistToken(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function hasCollaborationSeparator(value: string): boolean {
  return /\s(?:&|and|x|\+|with|ft\.?|feat\.?|featuring|vs\.?)\s/i.test(value) || /\s*,\s*/.test(value);
}

function shouldSplitComma(left: string, right: string, fullValue: string): boolean {
  if (!left.trim() || !right.trim()) return false;
  if (/^(the|la|le|el)\b/i.test(right.trim())) return false;

  if (/\s(?:&|and|x|\+|with|ft\.?|feat\.?|featuring|vs\.?)\s/i.test(fullValue)) {
    return true;
  }

  const leftTrim = left.trim();
  const rightTrim = right.trim();
  return /[a-zA-Z]/.test(leftTrim) && /[a-zA-Z]/.test(rightTrim);
}

function hasWhitespaceOnlyGap(parts: ArtistLinePart[]): boolean {
  return parts.some(
    (part, index) =>
      part.type === "text" &&
      !part.value.replace(/\s/g, "") &&
      index > 0 &&
      index < parts.length - 1 &&
      parts[index - 1]?.type === "credit" &&
      parts[index + 1]?.type === "credit",
  );
}

function countMatchedCredits(parts: ArtistLinePart[] | null): number {
  return parts?.filter((part) => part.type === "credit").length ?? 0;
}

function validCredits(artistCredits: ArtistCredit[]): ArtistCredit[] {
  return artistCredits.filter((credit) => credit.name.trim() && credit.browseId.trim());
}

function findCreditPosition(artist: string, creditName: string): { index: number; length: number } | null {
  const normalizedArtist = normalizeArtistToken(artist);
  const normalizedName = normalizeArtistToken(creditName);
  if (!normalizedName) return null;

  const index = normalizedArtist.indexOf(normalizedName);
  if (index === -1) return null;

  let cursor = 0;
  let normalizedCursor = 0;
  while (normalizedCursor < index && cursor < artist.length) {
    if (/\s/.test(artist[cursor]) && /\s/.test(normalizedArtist[normalizedCursor] ?? "")) {
      while (cursor < artist.length && /\s/.test(artist[cursor])) cursor += 1;
      normalizedCursor += 1;
      continue;
    }
    cursor += 1;
    normalizedCursor += 1;
  }

  let length = 0;
  let matched = "";
  while (matched.length < normalizedName.length && cursor + length < artist.length) {
    length += 1;
    matched = normalizeArtistToken(artist.slice(cursor, cursor + length));
  }

  if (matched !== normalizedName) return null;
  return { index: cursor, length };
}

function artistNamesMatch(left: string, right: string): boolean {
  const a = normalizeArtistToken(left);
  const b = normalizeArtistToken(right);
  return a === b || a.includes(b) || b.includes(a);
}

function findCreditForName(
  name: string,
  credits: ArtistCredit[],
  usedBrowseIds: Set<string>,
): ArtistCredit | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  for (const credit of credits) {
    if (usedBrowseIds.has(credit.browseId)) continue;
    if (artistNamesMatch(credit.name, trimmed)) {
      usedBrowseIds.add(credit.browseId);
      return credit;
    }
  }

  return null;
}

export function buildArtistLineParts(artist: string, artistCredits: ArtistCredit[]): ArtistLinePart[] | null {
  const credits = validCredits(artistCredits);
  if (credits.length === 0) return null;

  const positioned = credits
    .map((credit) => {
      const position = findCreditPosition(artist, credit.name);
      return position ? { credit, ...position } : null;
    })
    .filter((entry): entry is { credit: ArtistCredit; index: number; length: number } => entry != null)
    .sort((left, right) => left.index - right.index);

  if (positioned.length === 0) return null;

  const parts: ArtistLinePart[] = [];
  let cursor = 0;

  for (const { credit, index, length } of positioned) {
    if (index < cursor) continue;

    if (index > cursor) {
      parts.push({ type: "text", value: artist.slice(cursor, index) });
    }

    parts.push({
      type: "credit",
      value: artist.slice(index, index + length),
      credit,
    });

    cursor = index + length;
  }

  if (cursor < artist.length) {
    parts.push({ type: "text", value: artist.slice(cursor) });
  }

  if (!parts.some((part) => part.type === "credit")) return null;
  if (hasWhitespaceOnlyGap(parts)) return null;

  return parts;
}

export function buildArtistNameParts(artist: string): ArtistNamePart[] | null {
  const trimmed = artist.trim();
  if (!trimmed || !hasCollaborationSeparator(trimmed)) return null;

  const parts: ArtistNamePart[] = [];
  const separatorPattern = new RegExp(COLLABORATION_SEPARATOR_PATTERN.source, COLLABORATION_SEPARATOR_PATTERN.flags);
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = separatorPattern.exec(artist)) !== null) {
    const separator = match[0];
    const left = artist.slice(cursor, match.index);
    const right = artist.slice(match.index + separator.length);
    const isComma = separator.includes(",");

    if (isComma && !shouldSplitComma(left, right, artist)) {
      continue;
    }

    if (left.trim()) {
      parts.push({ type: "name", value: left });
    } else if (left) {
      parts.push({ type: "text", value: left });
    }
    parts.push({ type: "text", value: separator });
    cursor = match.index + separator.length;
  }

  const tail = artist.slice(cursor);
  if (tail.trim()) {
    parts.push({ type: "name", value: tail });
  } else if (tail) {
    parts.push({ type: "text", value: tail });
  }

  const nameCount = parts.filter((part) => part.type === "name").length;
  return nameCount > 1 ? parts : null;
}

function buildArtistCreditPairedParts(artist: string, artistCredits: ArtistCredit[]): ArtistLinePart[] | null {
  const credits = validCredits(artistCredits);
  if (credits.length < 2) return null;

  const nameParts = buildArtistNameParts(artist);
  if (!nameParts) return null;

  const usedBrowseIds = new Set<string>();
  const result: ArtistLinePart[] = [];
  let matchedCredits = 0;

  for (const part of nameParts) {
    if (part.type === "name") {
      const credit = findCreditForName(part.value, credits, usedBrowseIds);
      if (credit) {
        result.push({ type: "credit", value: part.value, credit });
        matchedCredits += 1;
        continue;
      }
      result.push({ type: "text", value: part.value });
      continue;
    }

    result.push(part);
  }

  return matchedCredits >= 2 ? result : null;
}

export function buildArtistDisplayParts(artist: string, artistCredits: ArtistCredit[]): ArtistLinePart[] | null {
  const credits = validCredits(artistCredits);
  if (credits.length === 0) return null;

  const lineParts = buildArtistLineParts(artist, credits);
  const pairedParts = buildArtistCreditPairedParts(artist, credits);

  if (lineParts && pairedParts) {
    const lineMatches = countMatchedCredits(lineParts);
    const pairedMatches = countMatchedCredits(pairedParts);
    if (pairedMatches > lineMatches) return pairedParts;
    return lineParts;
  }

  return lineParts ?? pairedParts;
}