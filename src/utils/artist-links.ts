import type { ArtistCredit } from "../types";

export type ArtistLinePart =
  | { type: "text"; value: string }
  | { type: "credit"; value: string; credit: ArtistCredit };

export type ArtistNamePart =
  | { type: "text"; value: string }
  | { type: "name"; value: string };

export function buildArtistLineParts(artist: string, artistCredits: ArtistCredit[]): ArtistLinePart[] | null {
  const credits = artistCredits.filter((credit) => credit.name.trim() && credit.browseId.trim());
  if (credits.length === 0) return null;

  const lowerArtist = artist.toLocaleLowerCase();
  const parts: ArtistLinePart[] = [];
  let cursor = 0;

  for (const credit of credits) {
    const lowerName = credit.name.toLocaleLowerCase();
    const index = lowerArtist.indexOf(lowerName, cursor);
    if (index === -1) {
      continue;
    }

    if (index > cursor) {
      parts.push({ type: "text", value: artist.slice(cursor, index) });
    }

    parts.push({
      type: "credit",
      value: artist.slice(index, index + credit.name.length),
      credit,
    });

    cursor = index + credit.name.length;
  }

  if (cursor < artist.length) {
    parts.push({ type: "text", value: artist.slice(cursor) });
  }

  if (!parts.some((part) => part.type === "credit")) return null;

  // When credits are separated only by plain whitespace (no visible
  // collaboration separator like "&", "feat.", etc.), the credits likely
  // don't represent genuinely separate artists — e.g. "Atoms for Peace"
  // split into ["Atoms", "for Peace"].  Fall back to a single-button
  // rendering instead of producing a partial split.
  const hasWhitespaceOnlyGap = parts.some(
    (part, i) =>
      part.type === "text" &&
      !part.value.replace(/\s/g, "") &&
      i > 0 &&
      i < parts.length - 1 &&
      parts[i - 1].type === "credit" &&
      parts[i + 1]?.type === "credit",
  );
  if (hasWhitespaceOnlyGap) return null;

  return parts;
}

function hasCollaborationSeparator(value: string): boolean {
  return /\s(?:&|and|x|with|feat\.?|featuring)\s/i.test(value);
}

function shouldSplitComma(left: string, right: string, fullValue: string): boolean {
  if (!hasCollaborationSeparator(fullValue)) return false;
  if (!left.trim() || !right.trim()) return false;
  return !/^(the|la|le|el)\b/i.test(right.trim());
}

export function buildArtistNameParts(artist: string): ArtistNamePart[] | null {
  const trimmed = artist.trim();
  if (!trimmed || !hasCollaborationSeparator(trimmed)) return null;

  const parts: ArtistNamePart[] = [];
  const separatorPattern = /(\s+(?:&|and|x|with|feat\.?|featuring)\s+|\s*,\s*)/gi;
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
