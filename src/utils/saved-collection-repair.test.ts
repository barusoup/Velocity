import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityDetail, MediaTrack } from "../types";
import type { SavedAlbum, SavedArtist } from "../collection";
import {
  clearRepairState,
  inspectAlbumRepairNeeds,
  inspectTrackRepairNeeds,
  isAlbumVerifiedHealthy,
  isArtistVerifiedHealthy,
  isPersistedLyricsMissingOrDirty,
  isTrackVerifiedHealthy,
  loadRepairState,
  markAlbumVerifiedHealthy,
  markArtistVerifiedHealthy,
  markTrackVerifiedHealthy,
  repairSavedAlbum,
  repairSavedArtist,
  repairSavedSong,
  resetSavedCollectionRepairForTests,
  startSavedCollectionRepair,
} from "./saved-collection-repair";
import * as api from "../api";
import * as songResolution from "./song-resolution";
import { useOfflineStatusStore } from "../store/offlineStatusStore";
import { setItem } from "../storage";

const storage = new Map<string, string>();

describe("saved-collection-repair", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
    resetSavedCollectionRepairForTests();
    clearRepairState();
    useOfflineStatusStore.getState().clearAll();
    vi.restoreAllMocks();
  });

  describe("state persistence", () => {
    it("loads and persists verified items", () => {
      expect(isTrackVerifiedHealthy("track-1")).toBe(false);
      markTrackVerifiedHealthy("track-1");
      expect(isTrackVerifiedHealthy("track-1")).toBe(true);

      expect(isAlbumVerifiedHealthy("album-1")).toBe(false);
      markAlbumVerifiedHealthy("album-1");
      expect(isAlbumVerifiedHealthy("album-1")).toBe(true);

      expect(isArtistVerifiedHealthy("artist-1")).toBe(false);
      markArtistVerifiedHealthy("artist-1");
      expect(isArtistVerifiedHealthy("artist-1")).toBe(true);

      const state = loadRepairState();
      expect(typeof state.verifiedTrackIds["track-1"]).toBe("number");
      expect(typeof state.verifiedAlbumIds["album-1"]).toBe("number");
      expect(typeof state.verifiedArtistIds?.["artist-1"]).toBe("number");
    });
  });

  describe("inspectTrackRepairNeeds", () => {
    it("identifies upload tracks as needing no repairs", () => {
      const track: MediaTrack = {
        id: "upload:1",
        title: "Song",
        artist: "Artist",
        source: "upload",
        filePath: "/path/to/song.mp3",
      };
      const needs = inspectTrackRepairNeeds(track);
      expect(needs.hasAnyNeed).toBe(false);
    });

    it("detects missing duration and album metadata", () => {
      const track: MediaTrack = {
        id: "yt:1",
        videoId: "vid-1",
        title: "Song",
        artist: "Artist",
        source: "stream",
        album: null,
        durationSeconds: null,
      };
      const needs = inspectTrackRepairNeeds(track);
      expect(needs.needsCoreMetadata).toBe(true);
      expect(needs.needsAlbumMetadata).toBe(true);
      expect(needs.hasAnyNeed).toBe(true);
    });

    it("detects music video tracks needing studio resolution", () => {
      const track: MediaTrack = {
        id: "yt:mv1",
        videoId: "mv-1",
        title: "Song (Official Music Video)",
        artist: "Artist",
        source: "stream",
        kind: "video",
        album: "Album",
        albumBrowseId: "browse-1",
        durationSeconds: 200,
      };
      const needs = inspectTrackRepairNeeds(track);
      expect(needs.needsVideoResolution).toBe(true);
    });

    it("detects missing or dirty lyrics", () => {
      const track: MediaTrack = {
        id: "yt:2",
        videoId: "vid-2",
        title: "Song",
        artist: "Artist",
        source: "stream",
        album: "Album",
        albumBrowseId: "browse-2",
        durationSeconds: 180,
      };
      // No lyrics in localStorage
      expect(inspectTrackRepairNeeds(track).needsLyrics).toBe(true);

      // Dirty/non-clean provider in localStorage
      setItem(
        "velocity-session-lyrics-vid-2",
        JSON.stringify({
          source: "Musixmatch",
          lines: [{ startTimeMs: 1000, text: "hello" }, { startTimeMs: 2000, text: "world" }],
        }),
      );
      expect(isPersistedLyricsMissingOrDirty("vid-2")).toBe(true);
      expect(inspectTrackRepairNeeds(track).needsLyrics).toBe(true);

      // Clean LRCLIB lyrics in localStorage
      setItem(
        "velocity-session-lyrics-vid-2",
        JSON.stringify({
          source: "lrclib",
          lines: [{ startTimeMs: 1000, text: "hello" }, { startTimeMs: 2000, text: "world" }],
        }),
      );
      expect(isPersistedLyricsMissingOrDirty("vid-2")).toBe(false);
      expect(inspectTrackRepairNeeds(track).needsLyrics).toBe(false);
    });
  });

  describe("inspectAlbumRepairNeeds", () => {
    it("detects missing album detail cache", () => {
      const album: SavedAlbum = {
        browseId: "MPREb_123",
        title: "Album",
        subtitle: "Artist • 2024",
      };
      const needs = inspectAlbumRepairNeeds(album);
      expect(needs.needsDetailCache).toBe(true);
      expect(needs.hasAnyNeed).toBe(true);
    });
  });

  describe("repairSavedSong", () => {
    it("resolves video track to studio audio and backfills metadata", async () => {
      const track: MediaTrack = {
        id: "yt:mv1",
        videoId: "mv-1",
        title: "Song (Official Music Video)",
        artist: "Artist",
        source: "stream",
        kind: "video",
        album: null,
        durationSeconds: null,
      };

      vi.spyOn(songResolution, "resolveStreamTrackAudio").mockResolvedValue({
        ...track,
        resolvedVideoId: "studio-vid-1",
        kind: "song",
        title: "Song",
        album: "Studio Album",
        albumBrowseId: "album-browse-1",
        durationSeconds: 210,
      });

      vi.spyOn(api, "getSyncedLyricsForTrack").mockResolvedValue({
        source: "lrclib",
        lines: [
          { id: 1, startTimeMs: 1000, text: "line 1" },
          { id: 2, startTimeMs: 3000, text: "line 2" },
        ],
      });

      const updateSongMetadata = vi.fn();
      const result = await repairSavedSong(track, { updateSongMetadata });

      expect(result.repaired).toBe(true);
      expect(result.actions).toContain("resolved_video_to_studio");
      expect(updateSongMetadata).toHaveBeenCalledWith(
        "yt:mv1",
        expect.objectContaining({
          resolvedVideoId: "studio-vid-1",
          kind: "song",
        }),
      );
      expect(isTrackVerifiedHealthy(track.id)).toBe(true);
    });

    it("trims untrimmed leading silence in existing offline file", async () => {
      const track: MediaTrack = {
        id: "yt:clean-1",
        videoId: "clean-vid",
        title: "Song",
        artist: "Artist",
        source: "stream",
        album: "Album",
        albumBrowseId: "browse-1",
        durationSeconds: 190,
      };

      // Set clean lyrics
      setItem(
        "velocity-session-lyrics-clean-vid",
        JSON.stringify({
          source: "lrclib",
          lines: [{ startTimeMs: 1000, text: "1" }, { startTimeMs: 2000, text: "2" }],
        }),
      );

      // Offline status downloaded
      useOfflineStatusStore.getState().setStatus("clean-vid", "downloaded");

      vi.spyOn(api, "healOfflineAudio").mockResolvedValue("trimmed");

      const result = await repairSavedSong(track, { offlineSyncEnabled: true });
      expect(result.actions).toContain("trimmed_audio_silence");
    });
  });

  describe("repairSavedAlbum", () => {
    it("fetches and caches missing album detail and tracks", async () => {
      const album: SavedAlbum = {
        browseId: "MPREb_abc",
        title: "My Album",
        subtitle: "Artist",
      };

      const mockDetail: EntityDetail = {
        browseId: "MPREb_abc",
        title: "My Album",
        subtitle: "Artist • 2024",
        kind: "album",
        cover: "https://cover.jpg",
        byline: "Artist",
        tracks: [
          {
            id: "yt:trk1",
            videoId: "trk-1",
            title: "Track 1",
            artist: "Artist",
            source: "stream",
          },
        ],
      };

      vi.spyOn(api, "getEntityDetail").mockResolvedValue(mockDetail);
      const cacheSpy = vi.spyOn(api, "cacheSavedAlbumDetail");

      const result = await repairSavedAlbum(album, { offlineSyncEnabled: true });
      expect(result.repaired).toBe(true);
      expect(result.actions).toContain("cached_album_detail");
      expect(cacheSpy).toHaveBeenCalledWith("MPREb_abc", mockDetail);
      expect(isAlbumVerifiedHealthy(album.browseId)).toBe(true);
      expect(useOfflineStatusStore.getState().albumTrackVideoIds["MPREb_abc"]).toEqual(["trk-1"]);
    });
  });

  describe("repairSavedArtist", () => {
    it("caches artist cover and banner and marks artist verified", async () => {
      const artist: SavedArtist = {
        browseId: "UC_artist_1",
        title: "Test Artist",
        cover: "https://cover.jpg",
        banner: "https://banner.jpg",
      };

      const cacheSpy = vi.spyOn(api, "cacheArtwork").mockResolvedValue("/local/path/cover.jpg");

      await repairSavedArtist(artist);
      expect(cacheSpy).toHaveBeenCalledWith("https://cover.jpg");
      expect(cacheSpy).toHaveBeenCalledWith("https://banner.jpg");
      expect(isArtistVerifiedHealthy(artist.browseId)).toBe(true);
    });
  });

  describe("startSavedCollectionRepair background queue", () => {
    it("skips verified tracks and completes quietly", async () => {
      const track: MediaTrack = {
        id: "yt:verified-1",
        videoId: "v-1",
        title: "Song",
        artist: "Artist",
        source: "stream",
        album: "Album",
        albumBrowseId: "browse-1",
        durationSeconds: 150,
      };
      markTrackVerifiedHealthy(track.id);

      const onComplete = vi.fn();
      startSavedCollectionRepair({
        savedSongs: [track],
        savedAlbums: [],
        savedArtists: [],
        offlineSyncEnabled: false,
        onComplete,
      });

      expect(onComplete).toHaveBeenCalled();
    });
  });
});
