import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTrack, SearchItem } from "../types";

vi.mock("../api", () => ({
  searchMusic: vi.fn(),
}));

import { searchMusic } from "../api";
import { clearMusicVideoFinderCache, findMusicVideoForTrack } from "./music-video";

const mockedSearchMusic = vi.mocked(searchMusic);

function searchItem(
  overrides: Partial<SearchItem> & { id: string; kind: SearchItem["kind"]; title: string },
): SearchItem {
  return {
    subtitle: "",
    cover: null,
    browseId: null,
    videoId: "vid-default",
    durationSeconds: 180,
    playCount: null,
    artist: null,
    album: null,
    year: null,
    albumBrowseId: null,
    artistBrowseId: null,
    artistCredits: null,
    ...overrides,
  };
}

function track(overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: "yt:abc",
    title: "Hello",
    artist: "Adele",
    source: "stream",
    videoId: "abc",
    ...overrides,
  };
}

beforeEach(() => {
  mockedSearchMusic.mockReset();
  // The finder caches results per track for the session (so the watch page
  // skips the duplicate search). Tests reuse the same default track, so the
  // cache must be cleared between cases or later assertions would read the
  // previous test's result.
  clearMusicVideoFinderCache();
});

describe("findMusicVideoForTrack", () => {
  it("returns null when the track has no title or artist", async () => {
    await expect(findMusicVideoForTrack(track({ title: "" }))).resolves.toBeNull();
    await expect(findMusicVideoForTrack(track({ artist: "" }))).resolves.toBeNull();
    expect(mockedSearchMusic).not.toHaveBeenCalled();
  });

  it("uses the track's own videoId when the active track is already a music video", async () => {
    const result = await findMusicVideoForTrack(
      track({ kind: "video", videoId: "mv-1", title: "Hello (Official Music Video)" }),
    );
    expect(result).toEqual({
      videoId: "mv-1",
      title: "Hello (Official Music Video)",
      artist: "Adele",
    });
    expect(mockedSearchMusic).not.toHaveBeenCalled();
  });

  it("picks the top result when it is a matching music video", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: searchItem({
        id: "mv-top",
        kind: "video",
        title: "Hello (Official Music Video)",
        artist: "Adele",
        videoId: "mv-top",
        durationSeconds: 375,
      }),
      results: [],
    });
    const result = await findMusicVideoForTrack(track({ durationSeconds: 373 }));
    expect(result?.videoId).toBe("mv-top");
    expect(result?.title).toBe("Hello (Official Music Video)");
  });

  it("prefers a lower-ranked music video over a matching studio song at the top", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: searchItem({
        id: "song-top",
        kind: "song",
        title: "Hello",
        artist: "Adele",
        videoId: "song-top",
        durationSeconds: 373,
      }),
      results: [
        searchItem({
          id: "mv-2",
          kind: "video",
          title: "Hello (Official Music Video)",
          artist: "Adele",
          videoId: "mv-2",
          durationSeconds: 375,
        }),
      ],
    });
    const result = await findMusicVideoForTrack(track({ durationSeconds: 373 }));
    expect(result?.videoId).toBe("mv-2");
  });

  it("falls back to a lower music video when the top result is unrelated", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: searchItem({
        id: "remix",
        kind: "video",
        title: "Hello (Acoustic)",
        artist: "Someone Else",
        videoId: "remix",
      }),
      results: [
        searchItem({
          id: "mv-3",
          kind: "video",
          title: "Hello (Official Music Video)",
          artist: "Adele",
          videoId: "mv-3",
        }),
      ],
    });
    const result = await findMusicVideoForTrack(track());
    expect(result?.videoId).toBe("mv-3");
  });

  it("matches video titles with qualifiers stripped (Song vs Song (Official Video))", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: searchItem({
        id: "mv-4",
        kind: "video",
        title: "Hello (Official Video)",
        artist: "Adele",
        videoId: "mv-4",
      }),
      results: [],
    });
    const result = await findMusicVideoForTrack(track());
    expect(result?.videoId).toBe("mv-4");
  });

  it("returns null when no music-video row matches the song", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: searchItem({
        id: "song-only",
        kind: "song",
        title: "Hello",
        artist: "Adele",
        videoId: "song-only",
      }),
      results: [
        searchItem({
          id: "other-video",
          kind: "video",
          title: "Rolling in the Deep",
          artist: "Adele",
          videoId: "other-video",
        }),
      ],
    });
    const result = await findMusicVideoForTrack(track());
    expect(result).toBeNull();
  });

  it("returns null when the matching video row belongs to a different artist", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Hello Adele",
      topResult: null,
      results: [
        searchItem({
          id: "cover",
          kind: "video",
          title: "Hello",
          artist: "Someone Else",
          videoId: "cover",
        }),
      ],
    });
    const result = await findMusicVideoForTrack(track());
    expect(result).toBeNull();
  });
});
