import { describe, expect, it } from "vitest";
import type { MediaTrack } from "../types";
import {
  dedupeTracksBySong,
  exportStreamVideoId,
  isLikelyMusicVideoTrack,
  isSameSongTrack,
  isSameStreamPlayback,
  preferStudioSongTrack,
} from "./media";

function streamTrack(
  overrides: Partial<MediaTrack> & Pick<MediaTrack, "id">,
): MediaTrack {
  return {
    kind: "song",
    title: "Song",
    artist: "Artist",
    source: "stream",
    filePath: null,
    ...overrides,
  };
}

describe("exportStreamVideoId", () => {
  it("prefers resolvedVideoId over the catalog videoId", () => {
    expect(
      exportStreamVideoId({
        id: "yt:mv123",
        source: "stream",
        videoId: "mv123",
        resolvedVideoId: "audio456",
      }),
    ).toBe("audio456");
  });

  it("falls back to videoId and parses yt-prefixed track ids", () => {
    expect(
      exportStreamVideoId({
        id: "yt:abc123:MPREb_album",
        source: "stream",
        videoId: null,
      }),
    ).toBe("abc123");
    expect(
      exportStreamVideoId({
        id: "yt:abc123",
        source: "stream",
        videoId: "abc123",
      }),
    ).toBe("abc123");
  });

  it("dedupes tracks that share a resolved playback id", () => {
    const tracks = dedupeTracksBySong([
      streamTrack({ id: "yt:mv123", videoId: "mv123", title: "One Song" }),
      streamTrack({
        id: "yt:audio456",
        videoId: "mv123",
        resolvedVideoId: "audio456",
        title: "One Song",
      }),
      streamTrack({ id: "yt:other", videoId: "other", title: "Other Song" }),
    ]);

    expect(tracks).toHaveLength(2);
    expect(tracks.map((track) => track.id)).toEqual(["yt:audio456", "yt:other"]);
  });

  it("matches by artist + title when video ids don't overlap", () => {
    const deduped = dedupeTracksBySong([
      streamTrack({
        id: "yt:mv123",
        videoId: "mv123",
        title: "Same Song",
        artist: "Artist",
      }),
      streamTrack({
        id: "yt:audio456",
        videoId: "audio456",
        title: "Same Song",
        artist: "Artist",
      }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("yt:audio456");
  });

  it("prefers studio audio over explicit music-video rows", () => {
    const studio = streamTrack({
      id: "yt:audio456",
      videoId: "audio456",
      title: "Same Song",
      artist: "Artist",
    });
    const musicVideo = streamTrack({
      id: "yt:mv123",
      videoId: "mv123",
      kind: "video",
      title: "Same Song (Official Music Video)",
      artist: "Artist",
    });
    expect(isLikelyMusicVideoTrack(musicVideo)).toBe(true);
    expect(preferStudioSongTrack(musicVideo, studio)).toBe(studio);
  });

  it("does not throw when candidate omits artist/title (SearchItem path)", () => {
    const current = streamTrack({
      id: "yt:current",
      videoId: "current",
      title: "Song",
      artist: "Artist",
    });
    // Mirrors how usePlayerSelectors/PageShared rebuild a partial candidate
    // from a SearchItem — no artist/title on the candidate.
    const candidate = {
      id: "yt:search-result",
      videoId: "different-video",
      source: "stream" as const,
    };
    expect(() => dedupeTracksBySong([streamTrack(current), candidate as MediaTrack])).not.toThrow();
    expect(isSameSongTrack(current, candidate)).toBe(false);
  });

  it("does not treat distinct video rows as the same stream playback target", () => {
    const studio = streamTrack({
      id: "yt:audio456",
      videoId: "audio456",
      title: "Same Song",
      artist: "Artist",
    });
    const musicVideo = streamTrack({
      id: "yt:mv123",
      videoId: "mv123",
      title: "Same Song",
      artist: "Artist",
    });

    expect(isSameStreamPlayback(studio, musicVideo)).toBe(false);
    expect(isSameSongTrack(studio, musicVideo)).toBe(true);
  });

  it(
    "matches a SearchItem-derived candidate against the active track when "
      + "artist+title match but videoId differs (different release of the same song)",
    () => {
      const current = streamTrack({
        id: "yt:current-release",
        videoId: "release-audio",
        title: "Same Song",
        artist: "Artist",
      });
      // Mirrors the SearchItem-derived candidate shape used by
      // `isItemPlaying` / `useSearchItemPlaybackState`.
      const candidate: Parameters<typeof isSameSongTrack>[1] = {
        id: "yt:search-result",
        videoId: "music-video",
        title: "Same Song",
        artist: "Artist",
        source: "stream",
      };
      expect(isSameSongTrack(current, candidate)).toBe(true);
    },
  );

  it("returns null for uploads", () => {
    expect(
      exportStreamVideoId({
        id: "upload:local",
        source: "upload",
        videoId: null,
      }),
    ).toBeNull();
  });
});