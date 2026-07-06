import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { getArtistDetail, getEntityDetail, cacheArtwork } from "../api";
import type { QueueOrigin } from "../player";
import type { MediaTrack, SearchItem } from "../types";
import { buildArtistLineParts, buildArtistNameParts } from "../utils/artist-links";
import { getDirectArtistBrowseId } from "../utils/navigation";
import { getSearchItemArtist } from "../utils/search";
import { extractInterestingArtworkColor, peekArtworkAccent, type RgbColor } from "../utils/artwork-color";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { View } from "./Sidebar";

export const DEFAULT_ALBUM_ACCENT = { r: 80, g: 80, b: 80 };

export function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-800 bg-black p-12 text-center">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm text-neutral-400">{description}</p>
    </div>
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex min-h-[55vh] items-center justify-center">
      <LoaderCircle size={40} className="animate-spin text-neutral-400" aria-label={label} />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-neutral-900 bg-black p-16 text-center">
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-neutral-300">
        <CircleAlert size={18} />
      </div>
      <p className="text-base font-semibold text-white">Something went wrong</p>
      <p className="mt-2 text-sm text-neutral-400">{message}</p>
    </div>
  );
}

export function CardGrid({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <div
      className={`grid gap-2 ${
        small ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6"
      }`}
    >
      {children}
    </div>
  );
}

export function isPlayable(item: SearchItem): boolean {
  return item.kind === "song";
}

export function formatSearchItemMeta(item: SearchItem): string {
  switch (item.kind) {
    case "artist":
      return "Artist";
    case "album":
      return item.artist ? `Album • ${item.artist}` : "Album";
    case "playlist":
      return item.subtitle || "Playlist";
    case "song":
      return item.artist ? `Song • ${item.artist}` : "Song";
    default:
      return "";
  }
}

export function getSearchItemTitleView(item: SearchItem): View | null {
  if (item.kind === "song" && item.albumBrowseId) {
    return { name: "album", browseId: item.albumBrowseId, context: "search" };
  }
  if (item.kind === "artist" && item.browseId) {
    return { name: "artist", browseId: item.browseId, context: "search", cover: item.cover ?? null };
  }
  if (item.kind === "album" && item.browseId) {
    return { name: "album", browseId: item.browseId, context: "search" };
  }
  if (item.kind === "playlist" && item.browseId) {
    return { name: "playlist", browseId: item.browseId, context: "search" };
  }
  return null;
}

export function getSearchItemArtistView(item: SearchItem): View | null {
  if (!item.artistBrowseId) return null;
  return { name: "artist", browseId: item.artistBrowseId, context: "search" };
}

export function ArtistCreditText({
  artist,
  artistBrowseId,
  artistCredits,
  context,
  onNavigate,
  onResolveNavigate,
  onResolveArtistName,
}: {
  artist: string;
  artistBrowseId?: string | null;
  artistCredits?: SearchItem["artistCredits"] | MediaTrack["artistCredits"];
  context: "default" | "search";
  onNavigate: (view: View) => void;
  onResolveNavigate?: (() => void) | null;
  onResolveArtistName?: ((artistName: string) => void) | null;
}) {
  const parts = buildArtistLineParts(artist, artistCredits ?? []);
  const fallbackArtistBrowseId =
    (artistCredits?.length ?? 0) <= 1 ? getDirectArtistBrowseId({ artistBrowseId, artistCredits }) : null;
  const fallbackNameParts = onResolveArtistName ? buildArtistNameParts(artist) : null;

  if (parts) {
    return (
      <>
        {parts.map((part, index) =>
          part.type === "credit" ? (
            <button
              key={`${part.credit.browseId}-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNavigate({ name: "artist", browseId: part.credit.browseId, context });
              }}
              className="inline text-inherit transition hover:text-white/95 focus-visible:outline-none animate-none"
            >
              {part.value}
            </button>
          ) : (
            <span key={`text-${index}`}>{part.value}</span>
          ),
        )}
      </>
    );
  }

  if (fallbackNameParts) {
    return (
      <>
        {fallbackNameParts.map((part, index) =>
          part.type === "name" ? (
            <button
              key={`${part.value}-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onResolveArtistName?.(part.value.trim());
              }}
              className="inline text-inherit transition hover:text-white/95 focus-visible:outline-none animate-none"
            >
              {part.value}
            </button>
          ) : (
            <span key={`text-${index}`}>{part.value}</span>
          ),
        )}
      </>
    );
  }

  if (fallbackArtistBrowseId) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNavigate({ name: "artist", browseId: fallbackArtistBrowseId, context });
        }}
        className="inline text-inherit transition hover:text-white/95 focus-visible:outline-none animate-none"
      >
        {artist}
      </button>
    );
  }

  if (onResolveNavigate) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onResolveNavigate();
        }}
        className="inline text-inherit transition hover:text-white/95 focus-visible:outline-none animate-none"
      >
        {artist}
      </button>
    );
  }

  return <span>{artist}</span>;
}

export function SearchItemMeta({
  item,
  onNavigate,
}: {
  item: SearchItem;
  onNavigate: (view: View) => void;
}) {
  if (item.kind === "album" && item.artist) {
    return (
      <>
        <span>Album • </span>
        <ArtistCreditText
          artist={item.artist}
          artistBrowseId={item.artistBrowseId}
          artistCredits={item.artistCredits}
          context="search"
          onNavigate={onNavigate}
        />
      </>
    );
  }

  if (item.kind === "song" && item.artist) {
    return (
      <>
        <span>Song • </span>
        <ArtistCreditText
          artist={item.artist}
          artistBrowseId={item.artistBrowseId}
          artistCredits={item.artistCredits}
          context="search"
          onNavigate={onNavigate}
        />
      </>
    );
  }

  return <>{formatSearchItemMeta(item)}</>;
}

export function toTrack(item: SearchItem): MediaTrack | null {
  if (!item.videoId) return null;
  // Encode the release/album so identical songs that appear under multiple
  // YouTube Music releases (single vs. parent album) get distinct ids. This
  // mirrors the Rust-side `track_id` and `trackFromSearchItem` so every
  // MediaTrack constructor agrees on the same release-scoped identity.
  const id = item.albumBrowseId
    ? `yt:${item.videoId}:${item.albumBrowseId}`
    : `yt:${item.videoId}`;
  return {
    id,
    title: item.title,
    artist: getSearchItemArtist(item),
    album: item.album ?? null,
    albumBrowseId: item.albumBrowseId ?? null,
    artistBrowseId: item.artistBrowseId ?? null,
    artistCredits: item.artistCredits ?? null,
    durationSeconds: item.durationSeconds ?? null,
    playCount: item.playCount ?? null,
    cover: item.cover ?? null,
    videoId: item.videoId,
    source: "stream",
    filePath: null,
  };
}

export function isItemPlaying(
  item: SearchItem,
  currentTrack: MediaTrack | null,
  _isPlaying: boolean,
  queueOrigin?: QueueOrigin | null,
): boolean {
  if (!currentTrack) return false;
  if (item.kind === "song") {
    // Match by videoId (or id for uploads), but only if no specific
    // queue origin is active — a song played from an album, playlist,
    // or artist context should not show as playing in search results.
    if (queueOrigin) return false;
    if (currentTrack.videoId && item.videoId) {
      return currentTrack.videoId === item.videoId;
    }
    return currentTrack.id === item.id;
  }
  if (item.kind === "album" || item.kind === "playlist") {
    const expectedKind = item.kind === "album" ? "album" : "playlist";
    return (
      queueOrigin?.kind === expectedKind &&
      queueOrigin.browseId === item.browseId &&
      currentTrack.albumBrowseId === item.browseId
    );
  }
  if (item.kind === "artist") {
    return (
      queueOrigin?.kind === "artist" &&
      queueOrigin.browseId === item.browseId &&
      currentTrack.artistBrowseId === item.browseId
    );
  }
  return false;
}

export function getPlayHandler(
  item: SearchItem,
  onPlayTrack: (track: MediaTrack) => void,
  onPlayMany: (tracks: MediaTrack[], startIndex?: number, origin?: QueueOrigin) => void,
): (() => void) | undefined {
  if (isPlayable(item)) {
    const track = toTrack(item);
    if (track) return () => onPlayTrack(track);
  }
  if (item.kind === "album" && item.browseId) {
    return () => {
      getEntityDetail(item.browseId!).then((entity) => {
        const mappedTracks = entity.tracks.map((t) => ({ ...t, albumBrowseId: item.browseId }));
        onPlayMany(mappedTracks, 0, { kind: "album", browseId: item.browseId! });
      });
    };
  }
  if (item.kind === "playlist" && item.browseId) {
    return () => {
      getEntityDetail(item.browseId!).then((entity) => {
        const mappedTracks = entity.tracks.map((t) => ({ ...t, albumBrowseId: item.browseId }));
        onPlayMany(mappedTracks, 0, { kind: "playlist", browseId: item.browseId! });
      });
    };
  }
  if (item.kind === "artist" && item.browseId) {
    return () => {
      getArtistDetail(item.browseId!).then((artist) => {
        if (artist.topSongs.length > 0) {
          const mappedTracks = artist.topSongs.map((t) => ({ ...t, artistBrowseId: item.browseId }));
          onPlayMany(mappedTracks, 0, { kind: "artist", browseId: item.browseId! });
        }
      });
    };
  }
  return undefined;
}

export function useArtworkAccent(cover?: string | null, resetKey?: string) {
  // Seed from any already-cached accent so a revisit doesn't flash the
  // default gray before the async extraction re-resolves. The effect below
  // still re-derives the accent for fresh covers, but for cached ones the
  // first paint already has the right color.
  const [accent, setAccent] = useState<RgbColor>(() => {
    const peeked = peekArtworkAccent(cover ?? null);
    return peeked ?? DEFAULT_ALBUM_ACCENT;
  });

  useEffect(() => {
    let cancelled = false;

    // If we already have the accent for this cover cached, adopt it
    // synchronously and skip the reset-to-default flash. Otherwise reset to
    // default while the async extraction runs.
    const peeked = peekArtworkAccent(cover ?? null);
    if (peeked) {
      setAccent(peeked);
    } else {
      setAccent(DEFAULT_ALBUM_ACCENT);
    }

    if (!cover) {
      return () => {
        cancelled = true;
      };
    }

    let source = cover;

    if (!source.startsWith("asset://") && !source.startsWith("blob:") && !source.startsWith("data:")) {
      cacheArtwork(source)
        .then((filePath) => {
          if (!cancelled) {
            source = convertFileSrc(filePath);
            return extractInterestingArtworkColor(source);
          }
        })
        .then((color) => {
          if (!cancelled && color) {
            setAccent(color);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAccent(DEFAULT_ALBUM_ACCENT);
          }
        });
    } else {
      extractInterestingArtworkColor(source)
        .then((color) => {
          if (!cancelled) {
            setAccent(color);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAccent(DEFAULT_ALBUM_ACCENT);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [cover, resetKey]);

  return accent;
}

export function useArtistCover(artistBrowseId: string | null) {
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    if (!artistBrowseId) {
      setCover(null);
      return;
    }

    let cancelled = false;
    getArtistDetail(artistBrowseId)
      .then((data) => {
        if (!cancelled) {
          setCover(data.cover ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCover(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artistBrowseId]);

  return cover;
}

export function useTrackAccents(tracks: { cover?: string | null }[]) {
  const [colors, setColors] = useState<(RgbColor | null)[]>(() =>
    tracks.map((t) => peekArtworkAccent(t.cover ?? null)),
  );

  useEffect(() => {
    let cancelled = false;

    setColors(tracks.map((t) => peekArtworkAccent(t.cover ?? null)));

    tracks.map((t, i) => {
      const cover = t.cover;
      if (!cover || peekArtworkAccent(cover)) return null;

      const source = cover.startsWith("//") ? `https:${cover}` : cover;

    if (
      !source.startsWith("asset://") &&
      !source.startsWith("blob:") &&
      !source.startsWith("data:")
    ) {
        cacheArtwork(source)
          .then((filePath) => {
            if (!cancelled) {
              return extractInterestingArtworkColor(convertFileSrc(filePath));
            }
          })
          .then((color) => {
            if (!cancelled && color) {
              setColors((prev) => {
                const next = [...prev];
                next[i] = color;
                return next;
              });
            }
          })
          .catch(() => {});
      } else {
        extractInterestingArtworkColor(source)
          .then((color) => {
            if (!cancelled) {
              setColors((prev) => {
                const next = [...prev];
                next[i] = color;
                return next;
              });
            }
          })
          .catch(() => {});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [tracks]);

  return colors;
}
