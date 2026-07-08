import { describe, expect, it } from "vitest";
import type { SearchItem } from "../types";
import { artistLineFromCredits, getSearchItemArtist } from "./search";

function searchItem(
  overrides: Partial<SearchItem> & Pick<SearchItem, "title">,
): SearchItem {
  return {
    id: "test",
    kind: "song",
    subtitle: "",
    ...overrides,
  };
}

describe("getSearchItemArtist", () => {
  it("reads artist credits when the flat artist field is missing", () => {
    expect(
      getSearchItemArtist(
        searchItem({
          title: "Let Down",
          subtitle: "Song • 2.4M plays",
          artistCredits: [{ name: "Radiohead", browseId: "artist123" }],
        }),
      ),
    ).toBe("Radiohead");
  });

  it("uses the title for artist search rows", () => {
    expect(
      getSearchItemArtist(
        searchItem({
          kind: "artist",
          title: "Radiohead",
          subtitle: "Artist • 12M monthly listeners",
        }),
      ),
    ).toBe("Radiohead");
  });

  it("keeps a direct artist field even when the name matches a type label", () => {
    expect(
      getSearchItemArtist(
        searchItem({
          title: "Song",
          artist: "Artist",
          subtitle: "",
        }),
      ),
    ).toBe("Artist");
  });

  it("falls back to subtitle segments when artist is absent", () => {
    expect(
      getSearchItemArtist(
        searchItem({
          title: "Creep",
          subtitle: "Song • Radiohead",
        }),
      ),
    ).toBe("Radiohead");
  });
});

describe("artistLineFromCredits", () => {
  it("joins multiple credited artists", () => {
    expect(
      artistLineFromCredits([
        { name: "OutKast", browseId: "a" },
        { name: "Andre 3000", browseId: "b" },
      ]),
    ).toBe("OutKast, Andre 3000");
  });
});