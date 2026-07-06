import { describe, expect, it } from "vitest";
import { exportStreamVideoId } from "./media";

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