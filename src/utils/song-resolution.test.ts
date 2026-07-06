import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTrack, SearchItem } from "../types";

vi.mock("../api", () => ({
  searchMusic: vi.fn(),
  getEntityDetail: vi.fn(),
}));

import { getEntityDetail, searchMusic } from "../api";
import {
  cleanAutoplaySearchTitle,
  editionsCompatible,
  findStudioSongForTrack,
  remasterEditionKey,
  resolveAutoplayEntryToSong,
  resolveStreamTrackAudio,
  titlesMatchForAudioSwap,
  trackNeedsStudioSongResolution,
} from "./song-resolution";

const mockedSearchMusic = vi.mocked(searchMusic);
const mockedGetEntityDetail = vi.mocked(getEntityDetail);

describe("song-resolution remaster handling", () => {
  it("strips (2007 Remaster) suffix from search titles", () => {
    expect(cleanAutoplaySearchTitle("Where Is My Mind? (2007 Remaster)")).toBe(
      "Where Is My Mind?",
    );
  });

  it("keeps remaster editions distinct from originals", () => {
    expect(remasterEditionKey("Where Is My Mind? (2007 Remaster)")).toBe("2007 remaster");
    expect(remasterEditionKey("Where Is My Mind?")).toBeNull();
    expect(
      editionsCompatible("Where Is My Mind? (2007 Remaster)", "Where Is My Mind?"),
    ).toBe(false);
    expect(
      editionsCompatible(
        "Where Is My Mind? (2007 Remaster)",
        "Where Is My Mind? (2007 Remaster)",
      ),
    ).toBe(true);
  });

  it("matches remaster titles after suffix stripping", () => {
    expect(
      titlesMatchForAudioSwap(
        "Where Is My Mind? (2007 Remaster)",
        "Where Is My Mind? (2007 Remaster)",
      ),
    ).toBe(true);
    expect(titlesMatchForAudioSwap("Where Is My Mind? (2007 Remaster)", "Where Is My Mind?")).toBe(
      false,
    );
  });

  it("keeps distinct recording variants separate", () => {
    expect(titlesMatchForAudioSwap("Song -- Normal ver", "Song -- Live 2")).toBe(false);
    expect(titlesMatchForAudioSwap("Song -- Normal ver", "Song -- Special ver")).toBe(false);
    expect(titlesMatchForAudioSwap("Song -- Normal ver", "Song -- Normal ver")).toBe(true);
  });

  it("does not swap a remaster search hit to the non-remaster studio upload", () => {
    const candidates: SearchItem[] = [
      {
        id: "yt:6VG6gIvcjU8",
        kind: "song",
        title: "Where Is My Mind? (2007 Remaster)",
        subtitle: "",
        artist: "Pixies",
        videoId: "6VG6gIvcjU8",
      },
      {
        id: "yt:49FB9hhoO6c",
        kind: "song",
        title: "Where Is My Mind?",
        subtitle: "",
        artist: "Pixies",
        videoId: "49FB9hhoO6c",
      },
    ];

    const matched = findStudioSongForTrack(
      {
        artist: "Pixies",
        title: "Where Is My Mind? (2007 Remaster)",
        videoId: "6VG6gIvcjU8",
        durationSeconds: null,
      },
      candidates,
    );

    expect(matched?.videoId).toBeUndefined();
  });

  it("does not swap a catalogued normal version to a live upload", () => {
    const candidates: SearchItem[] = [
      {
        id: "yt:normal123",
        kind: "song",
        title: "Song -- Normal ver",
        subtitle: "",
        artist: "Artist",
        videoId: "normal123",
      },
      {
        id: "yt:live456",
        kind: "song",
        title: "Song -- Live 2",
        subtitle: "",
        artist: "Artist",
        videoId: "live456",
      },
    ];

    const matched = findStudioSongForTrack(
      {
        artist: "Artist",
        title: "Song -- Normal ver",
        videoId: "normal123",
        durationSeconds: 200,
      },
      candidates,
    );

    expect(matched).toBeNull();
  });

  it("does not treat loosely overlapping variant titles as distinct studio rows", () => {
    const entry = {
      id: "yt:normal123",
      kind: "song" as const,
      title: "Song -- Normal ver",
      artist: "Artist",
      videoId: "normal123",
    };
    const candidates: SearchItem[] = [
      {
        id: "yt:normal123",
        kind: "song",
        title: "Song -- Normal ver",
        subtitle: "",
        artist: "Artist",
        videoId: "normal123",
      },
      {
        id: "yt:live456",
        kind: "song",
        title: "Song -- Live 2",
        subtitle: "",
        artist: "Artist",
        videoId: "live456",
      },
    ];

    expect(trackNeedsStudioSongResolution(entry, candidates)).toBe(false);
  });
});

describe("resolveStreamTrackAudio", () => {
  beforeEach(() => {
    mockedSearchMusic.mockReset();
    mockedGetEntityDetail.mockReset();
  });

  it("keeps the user-selected normal version when search also surfaces live uploads", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song -- Normal ver",
      results: [
        {
          id: "yt:live456",
          kind: "song",
          title: "Song -- Live 2",
          subtitle: "",
          artist: "Artist",
          videoId: "live456",
        },
        {
          id: "yt:normal123",
          kind: "song",
          title: "Song -- Normal ver",
          subtitle: "",
          artist: "Artist",
          videoId: "normal123",
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:normal123",
      kind: "song",
      title: "Song -- Normal ver",
      artist: "Artist",
      videoId: "normal123",
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(track);

    expect(resolved).toMatchObject({
      videoId: "normal123",
      title: "Song -- Normal ver",
    });
    expect(resolved?.resolvedVideoId).toBeUndefined();
  });

  it("does not swap identically titled uploads when the catalog already lists the selected row", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:live456",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "live456",
          durationSeconds: 360,
        },
        {
          id: "yt:normal123",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "normal123",
          durationSeconds: 200,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:normal123",
      kind: "song",
      title: "Song",
      artist: "Artist",
      videoId: "normal123",
      durationSeconds: 200,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(track);

    expect(resolved).toMatchObject({
      videoId: "normal123",
      title: "Song",
    });
    expect(resolved?.resolvedVideoId).toBeUndefined();
  });
});

describe("resolveAutoplayEntryToSong", () => {
  beforeEach(() => {
    mockedSearchMusic.mockReset();
    mockedGetEntityDetail.mockReset();
  });

  it("resolves mislabeled song-kind rows via canonical exact-title lookup", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song Name",
      results: [
        {
          id: "yt:mv456",
          kind: "song",
          title: "Song Name",
          subtitle: "",
          artist: "Artist",
          videoId: "mv456",
        },
        {
          id: "yt:studio123",
          kind: "song",
          title: "Song Name",
          subtitle: "",
          artist: "Artist",
          videoId: "studio123",
          cover: "https://example.com/studio.jpg",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song Name",
      artist: "Artist",
      videoId: "mv456",
      cover: "https://example.com/mv.jpg",
      source: "stream",
    };

    const resolved = await resolveAutoplayEntryToSong(entry);

    expect(resolved).toMatchObject({
      id: "yt:studio123",
      videoId: "studio123",
      cover: "https://example.com/studio.jpg",
      kind: "song",
    });
  });

  it("replaces music-video metadata with the studio song match", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:studio123",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "studio123",
          cover: "https://example.com/studio.jpg",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song",
      artist: "Artist",
      videoId: "mv456",
      cover: "https://example.com/mv.jpg",
      source: "stream",
    };

    const resolved = await resolveAutoplayEntryToSong(entry);

    expect(resolved).toMatchObject({
      id: "yt:studio123",
      videoId: "studio123",
      title: "Song",
      artist: "Artist",
      cover: "https://example.com/studio.jpg",
      kind: "song",
    });
    expect(resolved?.cover).not.toBe(entry.cover);
  });

  it("drops explicit music-video autoplay rows with no studio match", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:mv456",
          kind: "song",
          title: "Song (Official Music Video)",
          subtitle: "",
          artist: "Artist",
          videoId: "mv456",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "video",
      title: "Song (Official Music Video)",
      artist: "Artist",
      videoId: "mv456",
      source: "stream",
    };

    expect(trackNeedsStudioSongResolution(entry, [])).toBe(true);
    await expect(resolveAutoplayEntryToSong(entry)).resolves.toBeNull();
  });

  it("resolves mislabeled song-kind music videos via overlap-ranked matching", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song Name",
      results: [
        {
          id: "yt:mv456",
          kind: "song",
          title: "Song Name (Official Music Video)",
          subtitle: "",
          artist: "Artist",
          videoId: "mv456",
        },
        {
          id: "yt:studio123",
          kind: "song",
          title: "Song Name",
          subtitle: "",
          artist: "Artist",
          videoId: "studio123",
          cover: "https://example.com/studio.jpg",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song Name (Official Music Video)",
      artist: "Artist",
      videoId: "mv456",
      cover: "https://example.com/mv.jpg",
      source: "stream",
    };

    const resolved = await resolveAutoplayEntryToSong(entry);

    expect(resolved).toMatchObject({
      id: "yt:studio123",
      videoId: "studio123",
      cover: "https://example.com/studio.jpg",
      kind: "song",
    });
  });

  it("flags mislabeled uploads when search surfaces a distinct studio row", () => {
    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song Name",
      artist: "Artist",
      videoId: "mv456",
      source: "stream",
    };
    const candidates: SearchItem[] = [
      {
        id: "yt:mv456",
        kind: "song",
        title: "Song Name",
        subtitle: "",
        artist: "Artist",
        videoId: "mv456",
      },
      {
        id: "yt:studio123",
        kind: "song",
        title: "Song Name",
        subtitle: "",
        artist: "Artist",
        videoId: "studio123",
      },
    ];

    expect(trackNeedsStudioSongResolution(entry, candidates)).toBe(true);
  });

  it("drops fanmade variant titles such as covers from autoplay", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song Name Cover",
      results: [
        {
          id: "yt:cover456",
          kind: "song",
          title: "Song Name (Cover)",
          subtitle: "",
          artist: "Artist",
          videoId: "cover456",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:cover456",
      kind: "song",
      title: "Song Name (Cover)",
      artist: "Artist",
      videoId: "cover456",
      source: "stream",
    };

    await expect(resolveAutoplayEntryToSong(entry)).resolves.toBeNull();
  });

  it("drops autoplay rows that are not catalogued as YT Music songs", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Obscure Fan Upload",
      results: [
        {
          id: "yt:studio123",
          kind: "song",
          title: "Totally Different Song",
          subtitle: "",
          artist: "Someone Else",
          videoId: "studio123",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:fan999",
      kind: "song",
      title: "Obscure Fan Upload",
      artist: "Artist",
      videoId: "fan999",
      source: "stream",
    };

    await expect(resolveAutoplayEntryToSong(entry)).resolves.toBeNull();
  });

  it("drops autoplay rows when song-match lookup fails", async () => {
    mockedSearchMusic.mockRejectedValue(new Error("Song lookup took too long."));

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song Name",
      artist: "Artist",
      videoId: "mv456",
      source: "stream",
    };

    await expect(resolveAutoplayEntryToSong(entry)).resolves.toBeNull();
  });

  it("uses album-listing metadata when search only surfaces the music video", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:albumBrowse",
          kind: "album",
          title: "Album",
          subtitle: "",
          artist: "Artist",
          browseId: "MPREb_album",
        },
        {
          id: "yt:mv456",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "mv456",
        },
      ],
    });
    mockedGetEntityDetail.mockResolvedValue({
      kind: "album",
      browseId: "MPREb_album",
      title: "Album",
      subtitle: "",
      tracks: [
        {
          id: "yt:studio789:MPREb_album",
          kind: "song",
          title: "Song",
          artist: "Artist",
          videoId: "studio789",
          cover: "https://example.com/album-row.jpg",
          albumBrowseId: "MPREb_album",
          source: "stream",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:mv456",
      kind: "song",
      title: "Song",
      artist: "Artist",
      album: "Album",
      videoId: "mv456",
      cover: "https://example.com/mv.jpg",
      source: "stream",
    };

    const resolved = await resolveAutoplayEntryToSong(entry);

    expect(resolved).toMatchObject({
      id: "yt:studio789",
      videoId: "studio789",
      title: "Song",
      cover: "https://example.com/album-row.jpg",
      kind: "song",
    });
    expect(resolved?.cover).not.toBe(entry.cover);
  });
});