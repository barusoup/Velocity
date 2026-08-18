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
  isStreamResolveTimeout,
  isUnplayableStreamError,
  remasterEditionKey,
  resolveAutoplayEntryToSong,
  resolveStreamTrackAudio,
  resolveStreamTrackAudioFallback,
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
  it("preserves the selected release metadata when resolving alternate playback audio", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead How can you be sure?",
      results: [{
        id: "yt:other-release",
        kind: "song",
        title: "How can you be sure?",
        subtitle: "Radiohead",
        artist: "Radiohead",
        album: "Nowhere",
        videoId: "other-release",
        durationSeconds: 180,
      }],
    });

    const selected: MediaTrack = {
      id: "yt:selected:fake-plastic-trees",
      kind: "video",
      title: "How can you be sure?",
      artist: "Radiohead",
      album: "Fake Plastic Trees",
      albumBrowseId: "selected-album",
      cover: "selected-cover",
      videoId: "selected-video",
      durationSeconds: 180,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(selected);

    expect(resolved).toMatchObject({
      id: selected.id,
      title: selected.title,
      artist: selected.artist,
      album: selected.album,
      albumBrowseId: selected.albumBrowseId,
      cover: selected.cover,
      resolvedVideoId: "other-release",
    });
  });
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

describe("music-video candidate hygiene", () => {
  beforeEach(() => {
    mockedSearchMusic.mockReset();
    mockedGetEntityDetail.mockReset();
  });

  it("resolves the Paranoid Android single/EP track (the official MV) to a studio song, not a live cut", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      topResult: {
        id: "video:fHiGbolFFGw",
        kind: "video",
        title: "Paranoid Android",
        subtitle: "Radiohead",
        artist: "Radiohead",
        videoId: "fHiGbolFFGw",
        durationSeconds: 393,
      },
      results: [
        {
          id: "yt:DExBeFCx3mQ",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "Song • Radiohead",
          artist: "Radiohead",
          videoId: "DExBeFCx3mQ",
        },
        {
          id: "browse:MPREb_okc",
          kind: "album",
          title: "OK Computer",
          subtitle: "Album • Radiohead",
          artist: "Radiohead",
        },
        {
          id: "yt:Lt8AfIeJOxw",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "Song • Radiohead",
          artist: "Radiohead",
          videoId: "Lt8AfIeJOxw",
        },
        {
          id: "yt:JvvSfgWJCpE",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "Song • Zoom Karaoke",
          artist: "Zoom Karaoke",
          videoId: "JvvSfgWJCpE",
        },
      ],
    });
    mockedGetEntityDetail.mockResolvedValue({
      kind: "album",
      browseId: "MPREb_qcBQFrhPGhz",
      title: "Paranoid Android",
      subtitle: "",
      tracks: [
        {
          id: "yt:fHiGbolFFGw:MPREb_qcBQFrhPGhz",
          title: "Paranoid Android",
          artist: "Radiohead",
          videoId: "fHiGbolFFGw",
          source: "stream",
        },
      ],
    });

    // The single/EP's "Paranoid Android" row IS the official music video.
    const singleTrack: MediaTrack = {
      id: "yt:fHiGbolFFGw:MPREb_qcBQFrhPGhz",
      title: "Paranoid Android",
      artist: "Radiohead",
      album: "Paranoid Android",
      albumBrowseId: "MPREb_qcBQFrhPGhz",
      videoId: "fHiGbolFFGw",
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(singleTrack);

    expect(resolved?.resolvedVideoId).toBe("DExBeFCx3mQ");
    expect(resolved?.videoId).toBe("fHiGbolFFGw");
  });

  it("never resolves a studio song to a music-video candidate even when cleaned titles match", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:mv",
          kind: "song",
          title: "Song (Official Music Video)",
          subtitle: "",
          artist: "Artist",
          videoId: "mv",
          durationSeconds: 200,
        },
        {
          id: "yt:studio",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "studio",
          durationSeconds: 200,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio",
      kind: "song",
      title: "Song",
      artist: "Artist",
      videoId: "studio",
      durationSeconds: 200,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(track);

    expect(resolved?.resolvedVideoId).toBeUndefined();
    expect(resolved?.videoId).toBe("studio");
  });

  it("does not resolve a music-video row to a music-video candidate", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song Name",
      results: [
        {
          id: "yt:mv",
          kind: "song",
          title: "Song Name (Official Music Video)",
          subtitle: "",
          artist: "Artist",
          videoId: "mv",
          durationSeconds: 200,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:mv2",
      kind: "video",
      title: "Song Name (Official Music Video)",
      artist: "Artist",
      videoId: "mv2",
      durationSeconds: 200,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudio(track);

    expect(resolved?.resolvedVideoId).toBeUndefined();
    expect(resolved?.videoId).toBe("mv2");
  });

  it("drops a music-video autoplay row whose id is only catalogued under a music-video title", async () => {
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
      kind: "song",
      title: "Song",
      artist: "Artist",
      videoId: "mv456",
      source: "stream",
    };

    await expect(resolveAutoplayEntryToSong(entry)).resolves.toBeNull();
  });

  it("keeps a genuine studio-song autoplay row that is catalogued", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Song",
      results: [
        {
          id: "yt:studio",
          kind: "song",
          title: "Song",
          subtitle: "",
          artist: "Artist",
          videoId: "studio",
        },
      ],
    });

    const entry: MediaTrack = {
      id: "yt:studio",
      kind: "song",
      title: "Song",
      artist: "Artist",
      videoId: "studio",
      source: "stream",
    };

    const resolved = await resolveAutoplayEntryToSong(entry);

    expect(resolved).toMatchObject({ id: "yt:studio", videoId: "studio" });
  });
});

describe("resolveStreamTrackAudioFallback", () => {
  beforeEach(() => {
    mockedSearchMusic.mockReset();
    mockedGetEntityDetail.mockReset();
  });

  it("never falls back to the music video when the resolved studio id is unplayable (Paranoid Android case)", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:mv-abc",
          kind: "video",
          title: "Paranoid Android (Official Music Video)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "mv-abc",
          durationSeconds: 383,
        },
        {
          id: "yt:studio-xyz",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "",
          artist: "Radiohead",
          videoId: "studio-xyz",
          durationSeconds: 383,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio-xyz",
      kind: "song",
      title: "Paranoid Android",
      artist: "Radiohead",
      album: "OK Computer",
      videoId: "studio-xyz",
      resolvedVideoId: "studio-xyz",
      durationSeconds: 383,
      source: "stream",
    };

    // The only alternate besides the dead studio id is the official music
    // video — it must never be selected as audio, so the fallback gives up.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["studio-xyz"] }),
    ).resolves.toBeNull();
  });

  it("prefers another studio upload over the music video when both are playable", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:mv-abc",
          kind: "video",
          title: "Paranoid Android (Official Music Video)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "mv-abc",
          durationSeconds: 383,
        },
        {
          id: "yt:studio-alt",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "",
          artist: "Radiohead",
          videoId: "studio-alt",
          durationSeconds: 383,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio-dead",
      kind: "song",
      title: "Paranoid Android",
      artist: "Radiohead",
      videoId: "studio-dead",
      resolvedVideoId: "studio-dead",
      durationSeconds: 383,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudioFallback(track, {
      excludeVideoIds: ["studio-dead"],
    });

    expect(resolved?.resolvedVideoId).toBe("studio-alt");
  });

  it("returns null when no same-song alternate exists", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Artist Obscure",
      results: [
        {
          id: "yt:other",
          kind: "song",
          title: "Totally Different Song",
          subtitle: "",
          artist: "Someone Else",
          videoId: "other",
          durationSeconds: 120,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:obscure",
      kind: "song",
      title: "Obscure",
      artist: "Artist",
      videoId: "obscure",
      source: "stream",
    };

    await expect(resolveStreamTrackAudioFallback(track)).resolves.toBeNull();
  });

  it("never swaps a studio song to a recording-variant upload", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:live-abc",
          kind: "song",
          title: "Paranoid Android (Live)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "live-abc",
          durationSeconds: 400,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio-xyz",
      kind: "song",
      title: "Paranoid Android",
      artist: "Radiohead",
      videoId: "studio-xyz",
      resolvedVideoId: "studio-xyz",
      durationSeconds: 383,
      source: "stream",
    };

    // A studio row must not silently play a live/acoustic/remix variant.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["studio-xyz"] }),
    ).resolves.toBeNull();
  });

  it("refuses a variant alternate even when the SOURCE track is itself a variant", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:live-abc",
          kind: "song",
          title: "Paranoid Android (Live)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "live-abc",
          durationSeconds: 400,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:live-xyz",
      kind: "song",
      title: "Paranoid Android (Live)",
      artist: "Radiohead",
      videoId: "live-xyz",
      resolvedVideoId: "live-xyz",
      durationSeconds: 400,
      source: "stream",
    };

    // A live take is a different recording of the song, not the song's audio —
    // not even when the failing source is itself a variant.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["live-xyz"] }),
    ).resolves.toBeNull();
  });

  it("does not substitute a studio cut for an unplayable variant source", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:studio-abc",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "",
          artist: "Radiohead",
          videoId: "studio-abc",
          durationSeconds: 383,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:live-xyz",
      kind: "song",
      title: "Paranoid Android (Live)",
      artist: "Radiohead",
      videoId: "live-xyz",
      resolvedVideoId: "live-xyz",
      durationSeconds: 400,
      source: "stream",
    };

    // The studio cut is a different recording from the live row the user has —
    // prefer failing over silently changing what plays.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["live-xyz"] }),
    ).resolves.toBeNull();
  });

  it("does not fall an unplayable remaster row back to the original studio cut", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Pixies Where Is My Mind?",
      results: [
        {
          id: "yt:original-abc",
          kind: "song",
          title: "Where Is My Mind?",
          subtitle: "",
          artist: "Pixies",
          videoId: "original-abc",
          durationSeconds: 218,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:remaster-xyz",
      kind: "song",
      title: "Where Is My Mind? (2007 Remaster)",
      artist: "Pixies",
      videoId: "remaster-xyz",
      resolvedVideoId: "remaster-xyz",
      durationSeconds: 218,
      source: "stream",
    };

    // A different edition is not the same audio — prefer failing over
    // playing the wrong remaster.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["remaster-xyz"] }),
    ).resolves.toBeNull();
  });

  it("still falls back to an official-audio upload of the studio song", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:official-audio-abc",
          kind: "song",
          title: "Paranoid Android (Official Audio)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "official-audio-abc",
          durationSeconds: 383,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio-dead",
      kind: "song",
      title: "Paranoid Android",
      artist: "Radiohead",
      videoId: "studio-dead",
      resolvedVideoId: "studio-dead",
      durationSeconds: 383,
      source: "stream",
    };

    const resolved = await resolveStreamTrackAudioFallback(track, {
      excludeVideoIds: ["studio-dead"],
    });

    expect(resolved?.resolvedVideoId).toBe("official-audio-abc");
  });

  it("refuses to fall a remaster row back to the music video when no studio upload exists", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:mv-abc",
          kind: "video",
          title: "Paranoid Android (Official Music Video)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "mv-abc",
          durationSeconds: 383,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:remaster-xyz",
      kind: "song",
      title: "Paranoid Android (2017 Remaster)",
      artist: "Radiohead",
      videoId: "remaster-xyz",
      resolvedVideoId: "remaster-xyz",
      durationSeconds: 383,
      source: "stream",
    };

    // A music video is not an acceptable audio fallback — not even for a
    // remaster whose own upload is unplayable.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["remaster-xyz"] }),
    ).resolves.toBeNull();
  });

  it("does not recover to the originally-clicked music video when the resolved studio upload fails", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "Radiohead Paranoid Android",
      results: [
        {
          id: "yt:mv",
          kind: "video",
          title: "Paranoid Android (Official Music Video)",
          subtitle: "",
          artist: "Radiohead",
          videoId: "mv",
          durationSeconds: 393,
        },
        {
          id: "yt:studio",
          kind: "song",
          title: "Paranoid Android",
          subtitle: "",
          artist: "Radiohead",
          videoId: "studio",
          durationSeconds: 384,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:mv:paranoid-single",
      title: "Paranoid Android",
      artist: "Radiohead",
      album: "Paranoid Android",
      albumBrowseId: "MPREb_single",
      videoId: "mv",
      resolvedVideoId: "studio",
      source: "stream",
    };

    // The music-video row the user originally clicked is not a recovery
    // source once the resolved studio upload fails — the fallback gives up
    // rather than play a video.
    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["studio"] }),
    ).resolves.toBeNull();
  });

  it("rejects a tribute-band upload even when title and duration line up", async () => {
    mockedSearchMusic.mockResolvedValue({
      query: "The Beatles Hey Jude",
      results: [
        {
          id: "yt:tribute-abc",
          kind: "song",
          title: "Hey Jude",
          subtitle: "",
          artist: "The Beatles Tribute Band",
          videoId: "tribute-abc",
          durationSeconds: 431,
        },
      ],
    });

    const track: MediaTrack = {
      id: "yt:studio-xyz",
      kind: "song",
      title: "Hey Jude",
      artist: "The Beatles",
      videoId: "studio-xyz",
      resolvedVideoId: "studio-xyz",
      durationSeconds: 431,
      source: "stream",
    };

    await expect(
      resolveStreamTrackAudioFallback(track, { excludeVideoIds: ["studio-xyz"] }),
    ).resolves.toBeNull();
  });
});

describe("isStreamResolveTimeout", () => {
  it("classifies frontend resolve timeouts", () => {
    expect(isStreamResolveTimeout("Resolving this track's audio took too long.")).toBe(true);
    expect(isStreamResolveTimeout("request timed out")).toBe(true);
    expect(isStreamResolveTimeout("HTTP error 403")).toBe(false);
    expect(isStreamResolveTimeout("")).toBe(false);
  });
});

describe("isUnplayableStreamError", () => {
  it("catches the sign-in/bot refusals yt-dlp returns for restricted uploads", () => {
    expect(isUnplayableStreamError("Sign in to confirm you're not a bot. Use --cookies...")).toBe(true);
    expect(isUnplayableStreamError("Sign in to confirm your age")).toBe(true);
    expect(isUnplayableStreamError("ERROR: [youtube] DExBeFCx3mQ: Sign in to confirm you're not a bot.")).toBe(true);
    expect(isUnplayableStreamError("HTTP Error 403: Forbidden")).toBe(true);
    expect(isUnplayableStreamError("This video is not available")).toBe(true);
  });

  it("does not classify transient network failures as unplayable", () => {
    expect(isUnplayableStreamError("connection reset by peer")).toBe(false);
    expect(isUnplayableStreamError("Read timed out")).toBe(false);
  });
});
