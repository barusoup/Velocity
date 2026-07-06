import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Disc,
  Folder,
  List,
  ListMusic,
  LoaderCircle,
  Menu,
  Mic2,
  Music2,
  Pause,
  Play,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { usePlayer, usePlayerActions } from "../player";
import { useContextTrackTarget } from "../hooks/useContextTrackTarget";
import { useCollectionMetadataBackfill } from "../hooks/useCollectionMetadataBackfill";
import { useTrackPlaybackState } from "../hooks/usePlayerSelectors";
import { VirtualList } from "./VirtualList";
import { useCollectionActions, useCollectionData } from "../collection";
import { useIsTrackSaved, useToggleTrackSave } from "../hooks/useCollectionSelectors";
import { getArtistDetail, getEntityDetail, importTracks, updateImportedTrackMetadata, extractFileMetadata } from "../api";
import { formatDuration, formatPlayCount, trimExtension } from "../utils/media";
import { preloadArtworkUrls } from "../utils/artwork-preload";
import {
  displayAlbumName,
  enrichUploadMetadataFromYtm,
  isPlaceholderAlbumName,
} from "../utils/upload-enrichment";
import { cn } from "../utils/cn";
import {
  getDirectAlbumBrowseId,
  getDirectArtistBrowseId,
  resolveAlbumBrowseId,
  resolveArtistBrowseId,
} from "../utils/navigation";
import {
  ArtworkImage,
  cardHoverPlayRevealClass,
  cardHoverPlayTransitionClass,
  DefaultArtwork,
  getArtworkRoundedClass,
} from "./Shared";
import { SaveButton } from "./SaveButton";
import { ArtistCreditText } from "./PagesShared";
import { CoverImageCropper } from "./CoverImageCropper";
import { ReleaseCard, type ReleaseItem } from "./ArtistPage";
import { Marquee } from "./Marquee";
import { COLLECTION_TRACK_GRID } from "./TrackList";
import type { MediaTrack } from "../types";
import type { View } from "./Sidebar";
import { useSetting, setSetting, type ViewMode } from "../settings";

// -----------------------------------------------------------------------
// CollectionPage — full implementation.
//
// Top of the page: a pill-style tab switcher (Albums / Songs / Artists /
// Local) on the left, an Upload button on its right. The tab style mirrors
// the artist Discography's filter/sort pill tags and the search filter
// popout: rounded full + white fill on the active tab, hover lift on the
// rest.
//
// Tabs:
//   * Albums — card grid of saved albums. Tap a card to navigate to its
//     detail page via the onNavigate prop.
//   * Songs — list of saved songs. Tap a row to play. Each row carries a
//     SaveButton + the data-song-context-target marker so the global
//     SongContextMenu can take over on right-click.
//   * Artists — card grid of saved artists. Tap a card to open the artist
//     page; hover play starts top tracks.
//   * Local — list of locally uploaded tracks with a per-row remove
//     button. Saved Albums, Songs, and Artists state is persisted via the
//     CollectionContext (localStorage); Local tracks are persisted via the
//     backend's library.json.
//
// Upload flow:
//   * Click Upload → native OS file picker via a hidden <input>.
//   * While the OS dialog is open, a fixed full-screen black overlay tints
//     the app. The overlay goes away on either selection (modal opens) or
//     cancellation (focus returns to the WebView with no change event).
//   * Selected files flow into a metadata edit modal with one row per
//     file. Title pre-fills from filename (extension stripped); artist +
//     album fill in if the user typed them; cover auto-detects a sibling
//     image file when picking a directory.
//   * "Import" pipes the rows through the Rust `import_tracks` command.
//     "Cancel" drops the batch.
// -------------------------------------------------------------------------

type CollectionTab = "albums" | "songs" | "artists" | "local";

type CollectionPageProps = {
  uploadedTracks: MediaTrack[];
  onImportFiles: (files: FileList | File[]) => Promise<void>;
  onImportsChanged: () => Promise<void>;
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
  initialTab?: CollectionTab;
};

type PendingImportRow = {
  tempId: string;
  file: File;
  title: string;
  artist: string;
  album: string;
  coverFile: File | null;
  findLyrics: boolean;
};

const COVER_NAME_CANDIDATES = new Set([
  "cover",
  "folder",
  "album",
  "albumart",
  "front",
  "albumartsmall",
]);

const COVER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);

const AUDIO_ACCEPT = [
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
  ".alac",
].join(",");

// Preserve the last-selected tab across CollectionPage remounts so
// switching tabs doesn't require a history entry (and thus doesn't
// create separate checkpoints in page history navigation).
let _lastCollectionTab: CollectionTab | null = null;

function KeepAliveTabPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div className={active ? undefined : "hidden"} aria-hidden={!active}>
      {children}
    </div>
  );
}

export function CollectionPage(props: CollectionPageProps) {
  const { savedSongs, savedAlbums, savedArtists } = useCollectionData();
  const { updateSongMetadata, updateSongsMetadataBatch } = useCollectionActions();
  const [tab, setTab] = useState<CollectionTab>(
    props.initialTab ?? _lastCollectionTab ?? "albums",
  );

  // Sync the active tab when the view's `initialTab` changes via back/forward
  // navigation. Without this, returning to the collection page (which remounts
  // because App.tsx unmounts it on navigation away) would always land on the
  // tab that was active at first mount, ignoring the tab baked into the
  // history entry.
  useEffect(() => {
    if (props.initialTab && props.initialTab !== tab) {
      setTab(props.initialTab);
    }
  }, [props.initialTab, tab]);

  // Carousel indicator state
  const tabRefs = useRef<Record<CollectionTab, HTMLButtonElement | null>>({
    albums: null,
    songs: null,
    artists: null,
    local: null,
  });
  const tabContainerRef = useRef<HTMLDivElement | null>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number;
    width: number;
  } | null>(null);

  // Measure tab positions and animate indicator
  useLayoutEffect(() => {
    const container = tabContainerRef.current;
    const activeBtn = tabRefs.current[tab];
    if (!container || !activeBtn) return;
    const containerRect = container.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    setIndicatorStyle({
      left: btnRect.left - containerRect.left,
      width: btnRect.width,
    });
  }, [tab]);

  // Picker / upload state
  const [pickerActive, setPickerActive] = useState(false);
  const [pendingRows, setPendingRows] = useState<PendingImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Track whether the most recent picker session was cancelled so we can
  // hide the overlay without opening the metadata modal.
  const cancelledRef = useRef(false);

  // Newest-first ordering for local uploads. `list_imported_tracks` returns
  // library-order (Rust ordering), so we re-sort by id (monotonic-ish) for
  // nicer UX.
  const sortedLocal = useMemo(
    () =>
      props.uploadedTracks
        .slice()
        .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)),
    [props.uploadedTracks],
  );

  useCollectionMetadataBackfill(savedSongs, {
    updateSongMetadata,
    updateSongsMetadataBatch,
  });

  const preloadTabArtwork = useCallback(
    (target: CollectionTab) => {
      switch (target) {
        case "albums":
          preloadArtworkUrls(savedAlbums.map((album) => album.cover));
          break;
        case "songs":
          preloadArtworkUrls(savedSongs.map((song) => song.cover));
          break;
        case "artists":
          preloadArtworkUrls([
            ...savedArtists.map((artist) => artist.cover),
            ...savedArtists.map((artist) => artist.banner),
          ]);
          break;
        case "local":
          preloadArtworkUrls(sortedLocal.map((track) => track.cover));
          break;
      }
    },
    [savedAlbums, savedArtists, savedSongs, sortedLocal],
  );

  useEffect(() => {
    const controller = new AbortController();
    preloadArtworkUrls(
      [
        ...savedAlbums.map((album) => album.cover),
        ...savedArtists.map((artist) => artist.cover),
        ...savedArtists.map((artist) => artist.banner),
        ...savedSongs.map((song) => song.cover),
        ...sortedLocal.map((track) => track.cover),
      ],
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [savedAlbums, savedArtists, savedSongs, sortedLocal]);

  // Tab switches update state locally only — no history entry, so page
  // history navigation doesn't treat each collection tab as a separate
  // checkpoint. The last-active tab is remembered across page remounts
  // via a module-level variable.
  const handleTabClick = useCallback(
    (next: CollectionTab) => {
      if (next === tab) return;
      preloadTabArtwork(next);
      setTab(next);
      _lastCollectionTab = next;
    },
    [tab, preloadTabArtwork],
  );

  // Show the picker. The overlay renders synchronously with this state so the
  // black tint is already on screen BEFORE the OS dialog steals focus. A
  // microtask is queued to actually click the hidden <input> so React flushes
  // the overlay paint first.
  const beginPick = useCallback(() => {
    if (pickerActive) return;
    cancelledRef.current = true;
    setPickerActive(true);
    requestAnimationFrame(() => {
      fileInputRef.current?.click();
    });
  }, [pickerActive]);

  // Hide the overlay. `wasCancelled` is used internally for the focus-return
  // signal; we don't need to act on it because `pendingRows` will be empty
  // in the cancel path (no <input>.change) so the row modal won't open.
  const finishPick = useCallback(() => {
    setPickerActive(false);
  }, []);

  useEffect(() => {
    if (!pickerActive) return;
    // Window focus returning without a `change` event means the user
    // cancelled. We had `cancelledRef.current = true` on open; if the
    // <input> change fires, that handler sets it back to false. So:
    //   * change fires      → cancelledRef = false → keep overlay hidden
    //                          (modal will be opened by onChange)
    //   * focus only        → cancelledRef stays true → hide overlay only
    const handleWindowFocus = () => {
      // Defer the check so the onChange handler can run first if it fired.
      queueMicrotask(() => {
        if (pendingRows.length === 0) finishPick();
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        queueMicrotask(() => {
          if (pendingRows.length === 0) finishPick();
        });
      }
    };
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pickerActive, finishPick, pendingRows.length]);

  const handleFilesPicked = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      // Reset the input so picking the same file twice still fires `change`.
      event.target.value = "";
      cancelledRef.current = false;
      finishPick();
      if (files.length === 0) return;
      setImportError(null);
      const rows = await Promise.all(
        files
          .filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|flac|ogg|opus|wav|wma|alac)$/i.test(f.name))
          .map((file) => buildPendingRow(file, files)),
      );
      if (rows.length === 0) return;
      // Once at least one audio file landed in the OS picker, switch to
      // the Local tab so the user lands in the right place after the
      // metadata modal closes. This fires on file selection (here), not
      // on import confirmation — the user's mental model is "selecting a
      // song takes me to Local", which is what switching here delivers.
      // Cancelling the OS dialog with no <input>.change landed in this
      // handler at all so this branch is never taken.
      setTab("local");
      setPendingRows(rows);
    },
    [finishPick],
  );

  const handleCancelImport = useCallback(() => {
    setPendingRows([]);
    setImportError(null);
  }, []);

  const handleConfirmImport = useCallback(async () => {
    if (pendingRows.length === 0 || importing) return;
    const incomplete = pendingRows.filter((row) => !row.title.trim());
    if (incomplete.length > 0) {
      setImportError(
        `${incomplete.length === 1 ? "One track is" : `${incomplete.length} tracks are`} missing a title.`,
      );
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const fileBuffers = await Promise.all(
        pendingRows.map(async (row) => {
          const bytes = Array.from(new Uint8Array(await row.file.arrayBuffer()));
          const coverBytes = row.coverFile
            ? Array.from(new Uint8Array(await row.coverFile.arrayBuffer()))
            : undefined;
          return { bytes, coverBytes };
        }),
      );
      const nonEmptyIndices: number[] = [];
      const filteredPayloads = fileBuffers
        .map((buf, i) => ({
          name: pendingRows[i].file.name,
          bytes: buf.bytes,
          coverBytes: buf.coverBytes,
        }))
        .filter((_, i) => {
          if (fileBuffers[i].bytes.length > 0) {
            nonEmptyIndices.push(i);
            return true;
          }
          return false;
        });
      const stored = await importTracks(filteredPayloads);

      for (let i = 0; i < stored.length; i++) {
        const row = pendingRows[nonEmptyIndices[i]];
        const storedTrack = stored[i];
        if (!storedTrack) continue;

        let artist = row.artist.trim() || storedTrack.artist;
        let album = row.album.trim() || displayAlbumName(storedTrack.album);

        try {
          const enrichment = await enrichUploadMetadataFromYtm({
            title: row.title || storedTrack.title,
            artist,
            album,
          });
          if (enrichment?.artist && !row.artist.trim()) artist = enrichment.artist;
          if (enrichment?.album && (!album || isPlaceholderAlbumName(album))) {
            album = enrichment.album;
          }
        } catch {
          // best-effort
        }

        try {
          await updateImportedTrackMetadata(storedTrack.id, {
            title: row.title,
            artist: artist || undefined,
            album: album || undefined,
            findLyrics: row.findLyrics || undefined,
          });
        } catch {
          // best-effort
        }
      }
      await props.onImportsChanged();
      setPendingRows([]);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }, [pendingRows, importing, props]);

  return (
    <div className="collection-page relative pt-8">
      {/* Tab + upload header row */}
      <div className="flex items-center justify-between gap-4 px-3 pb-4">
        <div
          ref={tabContainerRef}
          className="relative flex items-center gap-1.5"
        >
          {/* Sliding indicator pill */}
          {indicatorStyle && (
            <div
              className="absolute top-0 bottom-0 rounded-full bg-white transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{
                left: indicatorStyle.left,
                width: indicatorStyle.width,
              }}
            />
          )}
          {/* Disc (single concentric ring), ListMusic (note on a horizontal
          bar — vertically symmetric around the wrapper midline), and the
          closed Folder (smaller upward tab, less upward pull). All three
          share ~equal visual mass so the row reads evenly aligned rather
          than one icon dipping below the others. ListMusic replaces Music
          here because Music's notes hang below the wrapper center. */}
          <CollectionTabButton
            ref={(el) => { tabRefs.current.albums = el; }}
            label="Albums"
            active={tab === "albums"}
            onClick={() => handleTabClick("albums")}
            onHover={() => preloadTabArtwork("albums")}
            icon={<Disc size={16} strokeWidth={1.8} />}
          />
          <CollectionTabButton
            ref={(el) => { tabRefs.current.songs = el; }}
            label="Songs"
            active={tab === "songs"}
            onClick={() => handleTabClick("songs")}
            onHover={() => preloadTabArtwork("songs")}
            icon={<ListMusic size={16} strokeWidth={1.8} />}
          />
          <CollectionTabButton
            ref={(el) => { tabRefs.current.artists = el; }}
            label="Artists"
            active={tab === "artists"}
            onClick={() => handleTabClick("artists")}
            onHover={() => preloadTabArtwork("artists")}
            icon={<Mic2 size={16} strokeWidth={1.8} />}
          />
          <CollectionTabButton
            ref={(el) => { tabRefs.current.local = el; }}
            label="Local"
            active={tab === "local"}
            onClick={() => handleTabClick("local")}
            onHover={() => preloadTabArtwork("local")}
            icon={<Folder size={16} strokeWidth={1.8} />}
          />
        </div>
        <button
          type="button"
          onClick={beginPick}
          className="inline-flex h-8 items-center justify-center gap-2 rounded-full bg-white px-3.5 text-sm font-semibold leading-none text-black shadow-[0_6px_18px_rgba(0,0,0,0.32)] transition hover:scale-[1.02] hover:bg-white/96 animate-none"
          aria-label="Upload audio files"
        >
          <Upload size={16} strokeWidth={2.2} />
          Upload
        </button>
      </div>

      <KeepAliveTabPanel active={tab === "albums"}>
        <SavedAlbumsGrid
          albums={savedAlbums}
          onNavigate={props.onNavigate}
        />
      </KeepAliveTabPanel>
      <KeepAliveTabPanel active={tab === "songs"}>
        <SavedSongsList
          songs={savedSongs}
          onNavigate={props.onNavigate}
          listEnabled={tab === "songs"}
        />
      </KeepAliveTabPanel>
      <KeepAliveTabPanel active={tab === "artists"}>
        <SavedArtistsGrid
          artists={savedArtists}
          onNavigate={props.onNavigate}
        />
      </KeepAliveTabPanel>
      <KeepAliveTabPanel active={tab === "local"}>
        <LocalUploadsList
          tracks={sortedLocal}
          onPlayTrack={props.onPlayTrack}
          onNavigate={props.onNavigate}
          listEnabled={tab === "local"}
        />
      </KeepAliveTabPanel>

      {/* Hidden native file picker filtered to audio files. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={AUDIO_ACCEPT}
        onChange={handleFilesPicked}
        style={{ display: "none" }}
        aria-hidden
        tabIndex={-1}
      />

      {/* Full-screen black overlay while the OS file dialog is open. */}
      {pickerActive &&
        createPortal(
          <div
            role="presentation"
            className="pointer-events-none fixed inset-0 z-[100] bg-black/95"
            aria-hidden="true"
          />,
          document.body,
        )}

      {/* Metadata edit modal — opens once files are picked.
         Portaled to document.body (matching the picker overlay above) so the
         `fixed inset-0` overlay escapes the `.page-content` ancestor:
           * `transform: translate3d(0,0,0)` from `.page-content`'s page-enter
             animation (with `both` fill-mode) would otherwise establish
             itself as the containing block for our `position: fixed` modal,
             shrinking it to the page-content box instead of the viewport and
             knocking the Y-axis centering off.
           * `.page-content` also carries `contain: paint` and
             `isolation: isolate`, which would clip the modal's painting and
             sequester its z-index inside a local stack — both manifesting
             as "rendered but cut off almost entirely" relative to the bottom
             of the page-content box.
         Body itself only has `overflow: hidden` and is full-viewport, so
         rendering there gives true viewport-relative `inset-0` coverage. */}
      {pendingRows.length > 0 &&
        createPortal(
          <ImportMetadataModal
            rows={pendingRows}
            setRows={setPendingRows}
            importing={importing}
            error={importError}
            onCancel={handleCancelImport}
            onConfirm={handleConfirmImport}
            onRemoveRow={(tempId) =>
              setPendingRows((rows) => rows.filter((row) => row.tempId !== tempId))
            }
          />,
          document.body,
        )}
    </div>
  );
}

const CollectionTabButton = forwardRef<HTMLButtonElement, {
  label: string;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
  icon: React.ReactNode;
}>(function CollectionTabButton({ label, active, onClick, onHover, icon }, ref) {
  // Each tab hugs its own content (icon + label + small padding) instead
  // of stretching with `flex-1` to fill the row. With flex-1 the active
  // tab's white pill background extends across the full row width, which
  // reads as an oversized outline against the naturally-sized inactive
  // siblings. Letting each pill size to its content keeps the active and
  // inactive tabs visually identical in width and spacing, like matched
  // siblings.
  //
  // The active state no longer applies bg-white directly — a sliding
  // indicator div handles the white pill background via CSS transition
  // for a carousel effect. Active text remains black to contrast with
  // the indicator.
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      aria-pressed={active}
      className={cn(
        "relative z-10 inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold leading-none transition-colors animate-none",
        active ? "text-black" : "text-white hover:text-white/80",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
});

function SavedAlbumsGrid({
  albums,
  onNavigate,
}: {
  albums: Array<{
    browseId: string;
    title: string;
    subtitle: string;
    cover?: string | null;
    byline?: string | null;
    year?: string | null;
    artistBrowseId?: string | null;
  }>;
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();

  const handlePlayAlbum = useCallback(
    (browseId: string) => {
      void getEntityDetail(browseId).then((entity) => {
        const tracks = entity.tracks.map((t) => ({ ...t, albumBrowseId: browseId }));
        void player.playMany(tracks, 0, { kind: "album", browseId });
      });
    },
    [player],
  );

  const handleResolveArtistName = useCallback(
    (artistName: string) => {
      void resolveArtistBrowseId({ artist: artistName }).then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      });
    },
    [onNavigate],
  );

  if (albums.length === 0) {
    return (
      <CollectionEmpty
        title="Nothing saved yet"
        description="Open an album and tap the plus icon next to the play button to save it here."
      />
    );
  }
  return (
    <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
      {albums.map((album) => {
        const releaseItem: ReleaseItem = {
          id: album.browseId,
          kind: "album",
          browseId: album.browseId,
          title: album.title,
          subtitle: album.subtitle,
          cover: album.cover,
          artist: album.byline,
          year: album.year,
          releaseType: "album",
          yearLabel: album.year ?? null,
          shelfTitle: album.title,
        };

        return (
          <div key={album.browseId}>
            <ReleaseCard
              item={releaseItem}
              onOpen={() =>
                onNavigate({ name: "album", browseId: album.browseId, context: "default" })
              }
              onPlay={() => handlePlayAlbum(album.browseId)}
              playBgColor="#ffffff"
              metaExtra={
                album.byline ? (
                  <>
                    <span className="mx-1">•</span>
                    <ArtistCreditText
                      artist={album.byline}
                      artistBrowseId={album.artistBrowseId}
                      context="default"
                      onNavigate={onNavigate}
                      onResolveNavigate={
                        album.artistBrowseId
                          ? null
                          : () => {
                              void resolveArtistBrowseId({ artist: album.byline ?? undefined }).then((browseId) => {
                                if (!browseId) return;
                                onNavigate({ name: "artist", browseId, context: "default" });
                              });
                            }
                      }
                      onResolveArtistName={handleResolveArtistName}
                    />
                  </>
                ) : null
              }
            />
          </div>
        );
      })}
    </div>
  );
}

function SavedArtistsGrid({
  artists,
  onNavigate,
}: {
  artists: Array<{
    browseId: string;
    title: string;
    cover?: string | null;
    banner?: string | null;
    monthlyListeners?: string | null;
  }>;
  onNavigate: (view: View) => void;
}) {
  const player = usePlayer();

  const handlePlayArtist = useCallback(
    (browseId: string) => {
      void getArtistDetail(browseId).then((artist) => {
        if (artist.topSongs.length === 0) return;
        const tracks = artist.topSongs.map((track) => ({
          ...track,
          artistBrowseId: browseId,
        }));
        void player.playMany(tracks, 0, { kind: "artist", browseId });
      });
    },
    [player],
  );

  if (artists.length === 0) {
    return (
      <CollectionEmpty
        title="No saved artists yet"
        description="Open an artist and tap the plus icon next to the shuffle button to save them here."
      />
    );
  }

  return (
    <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
      {artists.map((artist) => (
        <SavedArtistCard
          key={artist.browseId}
          artist={artist}
          onOpen={() =>
            onNavigate({
              name: "artist",
              browseId: artist.browseId,
              context: "default",
              cover: artist.cover,
            })
          }
          onPlay={() => handlePlayArtist(artist.browseId)}
        />
      ))}
    </div>
  );
}

function SavedArtistCard({
  artist,
  onOpen,
  onPlay,
}: {
  artist: {
    browseId: string;
    title: string;
    cover?: string | null;
    monthlyListeners?: string | null;
  };
  onOpen: () => void;
  onPlay: () => void;
}) {
  const player = usePlayer();
  const isArtistActive =
    player.queueOrigin?.kind === "artist" &&
    player.queueOrigin.browseId === artist.browseId &&
    player.currentTrack?.artistBrowseId === artist.browseId;
  const playing = isArtistActive && player.isPlaying;
  const buffering = isArtistActive && player.isBuffering;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group block w-full min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none animate-none"
    >
      <div className="relative aspect-square">
        <div
          className={`h-full w-full overflow-hidden bg-neutral-900 shadow-[0_8px_22px_rgba(0,0,0,0.32)] ${getArtworkRoundedClass("circle")}`}
        >
          {artist.cover ? (
            <ArtworkImage src={artist.cover} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/30">
              <Music2 size={22} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (isArtistActive) {
              player.togglePlay();
            } else {
              onPlay();
            }
          }}
          className={`absolute bottom-0.5 right-0.5 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-lg ${cardHoverPlayTransitionClass} ${cardHoverPlayRevealClass()}`}
          aria-label={buffering ? "Loading" : playing ? "Pause artist" : "Play artist"}
        >
          {buffering ? (
            <LoaderCircle size={24} className="animate-spin" />
          ) : playing ? (
            <Pause size={24} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={24} fill="currentColor" strokeWidth={0} className="translate-x-[1.5px]" />
          )}
        </button>
      </div>
      <div className="mt-2 min-w-0">
        <Marquee className="text-[15px] font-semibold text-white/92">{artist.title}</Marquee>
        {artist.monthlyListeners && (
          <div className="mt-0.5 truncate text-[12px] text-white/50">{artist.monthlyListeners}</div>
        )}
      </div>
    </div>
  );
}

function SavedSongsList({
  songs,
  onNavigate,
  listEnabled = true,
}: {
  songs: MediaTrack[];
  onNavigate: (view: View) => void;
  listEnabled?: boolean;
}) {
  const player = usePlayer();
  const viewMode = useSetting("viewModeCollectionSongs");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuScopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || viewMenuScopeRef.current?.contains(target)) return;
      setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [viewMenuOpen]);

  const selectViewMode = (mode: ViewMode) => {
    setSetting("viewModeCollectionSongs", mode);
    setViewMenuOpen(false);
  };

  const totalSeconds = useMemo(
    () => songs.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0),
    [songs],
  );
  const unknownCount = useMemo(
    () => songs.filter((t) => t.durationSeconds == null).length,
    [songs],
  );

  if (songs.length === 0) {
    return (
      <CollectionEmpty
        title="No saved songs yet"
        description="Save songs by clicking the plus button next to a track, or by selecting 'Save to collection' from a song's context menu."
      />
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end px-3 pb-1">
        <div ref={viewMenuScopeRef} className="relative">
          <button
            type="button"
            onClick={() => setViewMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            className="inline-flex min-h-10 items-center gap-2 px-3 py-2 text-left text-sm font-bold text-white/62 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 animate-none"
          >
            {viewMode === "list" ? "List" : "Compact"}
            {viewMode === "list" ? <List size={17} /> : <Menu size={17} />}
            <ChevronDown
              size={16}
              className={viewMenuOpen ? "rotate-180 transition" : "transition"}
            />
          </button>
          {viewMenuOpen && (
            <MenuPanel className="right-0 top-10 w-48">
              <MenuOption
                label="List"
                active={viewMode === "list"}
                icon={<List size={17} />}
                onClick={() => selectViewMode("list")}
              />
              <MenuOption
                label="Compact"
                active={viewMode === "compact"}
                icon={<Menu size={17} />}
                onClick={() => selectViewMode("compact")}
              />
            </MenuPanel>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-1 text-xs text-neutral-500">
        <span>{songs.length} {songs.length === 1 ? "song" : "songs"}</span>
        <span aria-hidden="true">•</span>
        <span>
          {unknownCount > 0
            ? `${formatDuration(totalSeconds)} + ${unknownCount} unknown`
            : `Total ${formatDuration(totalSeconds)}`}
        </span>
      </div>
      <div
        className={cn(
          "grid items-center gap-3 px-3 pb-1 text-xs text-neutral-500",
          COLLECTION_TRACK_GRID,
        )}
      >
        <div />
        <div />
        <div className="-ml-1 hidden sm:block">Album</div>
        <div className="hidden items-center justify-end sm:flex">Plays</div>
        <div className="flex items-center justify-end">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 8.3v4.2" /></svg>
        </div>
      </div>
      <VirtualList
        items={songs}
        enabled={listEnabled}
        estimateSize={viewMode === "compact" ? 44 : 56}
        getItemKey={(track) => track.id}
        renderItem={(track, index) => (
          <CollectionSongRow
            track={track}
            index={index}
            compact={viewMode === "compact"}
            onPlay={() => {
              const playable = songs.map((song) =>
                song.kind === "video" ? { ...song, kind: "song" as const } : song,
              );
              void player.playMany(playable, index);
            }}
            onNavigate={onNavigate}
          />
        )}
      />
    </div>
  );
}

function LocalUploadsList({
  tracks,
  onPlayTrack,
  onNavigate,
  listEnabled = true,
}: {
  tracks: MediaTrack[];
  onPlayTrack: (track: MediaTrack) => void;
  onNavigate: (view: View) => void;
  listEnabled?: boolean;
}) {
  const viewMode = useSetting("viewModeCollectionLocal");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuScopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || viewMenuScopeRef.current?.contains(target)) return;
      setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [viewMenuOpen]);

  const selectViewMode = (mode: ViewMode) => {
    setSetting("viewModeCollectionLocal", mode);
    setViewMenuOpen(false);
  };

  const totalSeconds = useMemo(
    () => tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0),
    [tracks],
  );
  const unknownCount = useMemo(
    () => tracks.filter((t) => t.durationSeconds == null).length,
    [tracks],
  );

  if (tracks.length === 0) {
    return (
      <CollectionEmpty
        title="No local tracks yet"
        description="Use the Upload button at the top right to add songs from your computer."
      />
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end px-3 pb-1">
        <div ref={viewMenuScopeRef} className="relative">
          <button
            type="button"
            onClick={() => setViewMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            className="inline-flex min-h-10 items-center gap-2 px-3 py-2 text-left text-sm font-bold text-white/62 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 animate-none"
          >
            {viewMode === "list" ? "List" : "Compact"}
            {viewMode === "list" ? <List size={17} /> : <Menu size={17} />}
            <ChevronDown
              size={16}
              className={viewMenuOpen ? "rotate-180 transition" : "transition"}
            />
          </button>
          {viewMenuOpen && (
            <MenuPanel className="right-0 top-10 w-48">
              <MenuOption
                label="List"
                active={viewMode === "list"}
                icon={<List size={17} />}
                onClick={() => selectViewMode("list")}
              />
              <MenuOption
                label="Compact"
                active={viewMode === "compact"}
                icon={<Menu size={17} />}
                onClick={() => selectViewMode("compact")}
              />
            </MenuPanel>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-1 text-xs text-neutral-500">
        <span>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</span>
        <span aria-hidden="true">•</span>
        <span>
          {unknownCount > 0
            ? `${formatDuration(totalSeconds)} + ${unknownCount} unknown`
            : `Total ${formatDuration(totalSeconds)}`}
        </span>
      </div>
      <div
        className={cn(
          "grid items-center gap-3 px-3 pb-1 text-xs text-neutral-500",
          COLLECTION_TRACK_GRID,
        )}
      >
        <div />
        <div />
        <div className="-ml-1 hidden sm:block">Album</div>
        <div />
        <div className="flex items-center justify-end">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 8.3v4.2" /></svg>
        </div>
      </div>
      <VirtualList
        items={tracks}
        enabled={listEnabled}
        estimateSize={viewMode === "compact" ? 44 : 56}
        getItemKey={(track) => track.id}
        renderItem={(track, index) => (
          <LocalTrackRow
            track={track}
            index={index}
            compact={viewMode === "compact"}
            onPlay={() => onPlayTrack(track)}
            onNavigate={onNavigate}
          />
        )}
      />
    </div>
  );
}

function CollectionRowShell({
  track,
  onPlay,
  onNavigate,
  withContextTarget,
  isSaved,
  onToggleSave,
  compact,
  index = 0,
}: {
  track: MediaTrack;
  onPlay: () => void;
  onNavigate: (view: View) => void;
  withContextTarget?: boolean;
  isSaved?: boolean;
  onToggleSave?: () => void;
  compact?: boolean;
  index?: number;
}) {
  const { togglePlay } = usePlayerActions();
  const { active, playingActive, bufferingActive } = useTrackPlaybackState(track);
  const contextTarget = useContextTrackTarget(track, Boolean(withContextTarget));

  const directAlbumBrowseId = getDirectAlbumBrowseId(track);
  const albumLabel = displayAlbumName(track.album);
  const canNavigateToAlbum = Boolean(directAlbumBrowseId || track.videoId || albumLabel);

  const handleNavigateToAlbum = useCallback(() => {
    if (directAlbumBrowseId) {
      onNavigate({ name: "album", browseId: directAlbumBrowseId, context: "default" });
      return;
    }
    // The track the user clicked is the authoritative target — we do NOT
    // compare it against the currently-playing track. The user can click
    // any row in the list to jump to that row's album, regardless of what
    // is queued. Cancelling on a player mismatch used to silently swallow
    // the navigation for any row that wasn't the active track, which
    // made the title look unclickable on local uploads.
    void resolveAlbumBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "album", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [directAlbumBrowseId, onNavigate, track]);

  const directArtistBrowseId = getDirectArtistBrowseId(track);
  // Fallback for local upload rows where we have nothing to resolve an
  // album from (no album name, no embedded album browse id, no
  // videoId). The title button still needs somewhere to land, so it
  // jumps to the Local tab of the Collection page where the row lives.
  // This is the same destination the player bar's local-track title
  // button falls back to.
  const handleNavigateToLocal = useCallback(() => {
    onNavigate({ name: "collection", tab: "local" });
  }, [onNavigate]);
  const handleResolveNavigate = useCallback(() => {
    void resolveArtistBrowseId(track)
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate, track]);
  const handleResolveArtistName = useCallback((artistName: string) => {
    void resolveArtistBrowseId({ artist: artistName })
      .then((browseId) => {
        if (!browseId) return;
        onNavigate({ name: "artist", browseId, context: "default" });
      })
      .catch(() => undefined);
  }, [onNavigate]);

  return (
    <div
      {...contextTarget}
      role="row"
      className={cn(
        "collection-row group grid cursor-pointer items-center gap-3 rounded-lg px-3 text-sm hover:bg-neutral-900",
        COLLECTION_TRACK_GRID,
        compact ? "py-1.5" : "py-2",
        active && "bg-neutral-900/70",
      )}
      onClick={active ? togglePlay : onPlay}
    >
      {compact ? (
        <div className="relative flex items-center justify-center">
          <span
            className={`text-sm tabular-nums transition-opacity ${
              active ? "text-white/78 opacity-0" : "text-white/42 group-hover:opacity-0"
            }`}
          >
            {index + 1}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              (active ? togglePlay : onPlay)();
            }}
            className={`absolute flex h-7 w-7 items-center justify-center text-white animate-none ${
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            aria-label={playingActive ? "Pause" : "Play"}
          >
            {bufferingActive ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : playingActive ? (
              <Pause size={16} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={14} fill="currentColor" strokeWidth={0} />
            )}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            (active ? togglePlay : onPlay)();
          }}
          className="flex h-7 w-7 items-center justify-center justify-self-center rounded-full text-neutral-500 transition-colors hover:text-white"
          aria-label={playingActive ? "Pause" : "Play"}
        >
          {bufferingActive ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : playingActive ? (
            <Pause size={14} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={14} fill="currentColor" strokeWidth={0} />
          )}
        </button>
      )}
      {compact ? (
        <div className="flex min-w-0 items-center gap-2 self-center">
          <div className="min-w-0 flex-1 overflow-hidden">
            {canNavigateToAlbum ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleNavigateToAlbum();
                }}
                className="block w-full text-left text-[15px] font-semibold text-white transition hover:text-white/85 focus-visible:outline-none"
              >
                <Marquee className="text-[15px] font-semibold text-inherit">{track.title}</Marquee>
              </button>
            ) : track.source === "upload" ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleNavigateToLocal();
                }}
                className="block w-full text-left text-[15px] font-semibold text-white transition hover:text-white/85 focus-visible:outline-none"
              >
                <Marquee className="text-[15px] font-semibold text-inherit">{track.title}</Marquee>
              </button>
            ) : (
              <Marquee className="text-[15px] font-semibold text-white">{track.title}</Marquee>
            )}
          </div>
          <span className="shrink-0 text-neutral-600" aria-hidden="true">•</span>
          <div className="min-w-0 max-w-[42%] shrink truncate text-sm text-neutral-400">
            <ArtistCreditText
              artist={track.artist || "\u2014"}
              artistBrowseId={track.artistBrowseId}
              artistCredits={track.artistCredits}
              context="default"
              onNavigate={onNavigate}
              onResolveNavigate={directArtistBrowseId ? null : (track.artist ? handleResolveNavigate : null)}
              onResolveArtistName={handleResolveArtistName}
            />
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "h-[var(--ui-art-row)] w-[var(--ui-art-row)] flex-shrink-0 overflow-hidden bg-neutral-800",
              getArtworkRoundedClass(),
            )}
          >
            {track.cover ? (
              <ArtworkImage src={track.cover} className="h-full w-full object-cover" />
            ) : (
              <DefaultArtwork />
            )}
          </div>
          <div className="min-w-0 overflow-hidden">
            {canNavigateToAlbum ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleNavigateToAlbum();
                }}
                className="block w-full text-left text-[15px] font-semibold text-white transition hover:text-white/85 focus-visible:outline-none"
              >
                <Marquee className="text-[15px] font-semibold text-inherit">{track.title}</Marquee>
              </button>
            ) : track.source === "upload" ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleNavigateToLocal();
                }}
                className="block w-full text-left text-[15px] font-semibold text-white transition hover:text-white/85 focus-visible:outline-none"
              >
                <Marquee className="text-[15px] font-semibold text-inherit">{track.title}</Marquee>
              </button>
            ) : (
              <Marquee className="text-[15px] font-semibold text-white">{track.title}</Marquee>
            )}
            <div className="truncate text-xs text-neutral-400">
              <ArtistCreditText
                artist={track.artist || "\u2014"}
                artistBrowseId={track.artistBrowseId}
                artistCredits={track.artistCredits}
                context="default"
                onNavigate={onNavigate}
                onResolveNavigate={directArtistBrowseId ? null : (track.artist ? handleResolveNavigate : null)}
                onResolveArtistName={handleResolveArtistName}
              />
            </div>
          </div>
          {withContextTarget && onToggleSave && track.source !== "upload" && (
            <div
              className="shrink-0 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <SaveButton
                isSaved={isSaved ?? true}
                size="sm"
                onToggle={onToggleSave}
                ariaLabel={isSaved ? "Remove from collection" : "Save to collection"}
              />
            </div>
          )}
        </div>
      )}
      <div className="relative -ml-1 hidden min-w-0 self-center sm:block">
        {canNavigateToAlbum && albumLabel ? (
          <Marquee className="text-sm text-neutral-400">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleNavigateToAlbum();
              }}
              className="text-left transition hover:text-white/85 focus-visible:outline-none animate-none"
            >
              {albumLabel}
            </button>
          </Marquee>
        ) : (
          <Marquee className="text-sm text-neutral-400">
            <span>{albumLabel || "\u2014"}</span>
          </Marquee>
        )}
      </div>
      <div className="hidden items-center justify-end text-xs tabular-nums text-neutral-400 sm:flex">
        {formatPlayCount(track.playCount)}
      </div>
      <div className="flex items-center justify-end text-xs tabular-nums text-neutral-400">
        {formatRowDuration(track.durationSeconds)}
      </div>
    </div>
  );
}

function CollectionSongRow({
  track,
  onPlay,
  onNavigate,
  compact,
  index,
}: {
  track: MediaTrack;
  onPlay: () => void;
  onNavigate: (view: View) => void;
  compact?: boolean;
  index: number;
}) {
  const isSaved = useIsTrackSaved(track);
  const toggleSave = useToggleTrackSave(track);
  return (
    <CollectionRowShell
      track={track}
      onPlay={onPlay}
      onNavigate={onNavigate}
      withContextTarget
      compact={compact}
      index={index}
      isSaved={isSaved}
      onToggleSave={toggleSave}
    />
  );
}

function LocalTrackRow({
  track,
  onPlay,
  onNavigate,
  compact,
  index,
}: {
  track: MediaTrack;
  onPlay: () => void;
  onNavigate: (view: View) => void;
  compact?: boolean;
  index?: number;
}) {
  const isSaved = useIsTrackSaved(track);
  return (
    <CollectionRowShell
      track={track}
      onPlay={onPlay}
      onNavigate={onNavigate}
      withContextTarget
      compact={compact}
      index={index}
      isSaved={isSaved}
    />
  );
}

function CollectionEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="py-12 text-center">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm text-neutral-400">{description}</p>
    </div>
  );
}

async function buildPendingRow(
  file: File,
  allFiles: Array<File>,
): Promise<PendingImportRow> {
  let title = "";
  let artist = "";
  let album = "";
  let coverFile: File | null = null;

  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const meta = await extractFileMetadata(bytes, file.name);
    title = meta.title?.trim() ?? "";
    artist = meta.artist?.trim() ?? "";
    album = meta.album?.trim() ?? "";
    if (meta.coverBytes && meta.coverBytes.length > 0) {
      const blob = new Blob([new Uint8Array(meta.coverBytes)], { type: "image/jpeg" });
      coverFile = new File([blob], "cover.jpg", { type: "image/jpeg" });
    }
  } catch {
    // Extraction failed — fall through to filename heuristics.
  }

  if (!title) title = deriveTitleFromFilename(file.name);
  if (!artist) artist = deriveArtistFromFilename(file.name);

  if (title && artist && (!album || isPlaceholderAlbumName(album))) {
    try {
      const enrichment = await enrichUploadMetadataFromYtm({ title, artist, album });
      if (enrichment?.artist && !artist) artist = enrichment.artist;
      if (enrichment?.album) album = enrichment.album;
    } catch {
      // best-effort
    }
  }

  // Sibling cover detection: only when the picker was opened in directory
  // mode does `webkitRelativePath` populate, which lets us find sibling
  // images in the same folder. This takes priority over embedded art
  // because the user explicitly placed it alongside the audio files.
  const siblingCover = findSiblingCover(allFiles, file);
  if (siblingCover) coverFile = siblingCover;

  return {
    tempId: cryptoRandomId(),
    file,
    title,
    artist,
    album,
    coverFile,
    findLyrics: false,
  };
}

function deriveTitleFromFilename(name: string): string {
  const stem = trimExtension(name).replace(/[._]+/g, " ").trim();
  return stem.replace(/^(\d{1,3})\s*[-.]?\s+/, "").trim() || stem;
}

function deriveArtistFromFilename(name: string): string {
  const stem = trimExtension(name);
  const dashMatch = stem.match(/^(.+?)\s+-\s+(.+)$/);
  if (!dashMatch) return "";
  const [, left, right] = dashMatch;
  if (!left || !right) return "";
  return left.replace(/[._]+/g, " ").trim();
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function findSiblingCover(sourceFiles: Array<File>, pivot: File): File | null {
  const pivotPath = (
    pivot as File & { webkitRelativePath?: string }
  ).webkitRelativePath;
  if (!pivotPath) return null;
  const pivotDir = pivotPath.replace(/\/[^/]+$/, "");
  for (const candidate of sourceFiles) {
    const path = (
      candidate as File & { webkitRelativePath?: string }
    ).webkitRelativePath;
    if (!path || typeof path !== "string") continue;
    const candidateDir = path.replace(/\/[^/]+$/, "");
    if (candidateDir !== pivotDir) continue;
    const segments = path.split("/");
    const lastSegment = segments[segments.length - 1] ?? "";
    const stem = trimExtension(lastSegment).toLowerCase();
    const ext = lastSegment.split(".").pop()?.toLowerCase() ?? "";
    if (!COVER_EXTENSIONS.has(ext)) continue;
    if (!COVER_NAME_CANDIDATES.has(stem)) continue;
    return candidate;
  }
  return null;
}

function formatRowDuration(seconds?: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function ImportMetadataModal({
  rows,
  setRows,
  importing,
  error,
  onCancel,
  onConfirm,
  onRemoveRow,
}: {
  rows: PendingImportRow[];
  setRows: React.Dispatch<React.SetStateAction<PendingImportRow[]>>;
  importing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onRemoveRow: (tempId: string) => void;
}) {
  // Cover cropper state. Each row's cover cell opens the same
  // `CoverImageCropper` the playlist page uses, so per-track thumbnails
  // get the same square-crop / zoom flow as playlist covers. We track
  // both the picked file and the row it belongs to, since rows can be
  // edited in any order before the user confirms the import.
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  const [pendingCoverRowId, setPendingCoverRowId] = useState<string | null>(null);

  const handleCoverPicked = useCallback((file: File, tempId: string) => {
    setPendingCoverFile(file);
    setPendingCoverRowId(tempId);
  }, []);

  const handleCoverDrop = useCallback(
    (event: DragEvent<HTMLLabelElement>, tempId: string) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!file || !file.type.startsWith("image/")) return;
      handleCoverPicked(file, tempId);
    },
    [handleCoverPicked],
  );

  // The cropper hands back a JPEG data URL, but `import_tracks` expects
  // raw bytes for the cover. Decode the data URL into a Blob/File with
  // the same `cover.jpg` filename used by the embedded-art path in
  // `buildPendingRow`, so downstream code sees a uniform file payload.
  const handleCoverConfirm = useCallback(
    async (dataUrl: string) => {
      if (!pendingCoverRowId) return;
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const cropped = new File([blob], "cover.jpg", { type: "image/jpeg" });
      const rowId = pendingCoverRowId;
      setRows((current) =>
        current.map((row) =>
          row.tempId === rowId ? { ...row, coverFile: cropped } : row,
        ),
      );
      setPendingCoverFile(null);
      setPendingCoverRowId(null);
    },
    [pendingCoverRowId, setRows],
  );

  const handleCoverCancel = useCallback(() => {
    setPendingCoverFile(null);
    setPendingCoverRowId(null);
  }, []);

  return (
    // Backdrop is `bg-black/85` so the dimmed app behind it almost
    // disappears into the same #000 as the panel itself. The panel
    // sits on top of that as one continuous dark surface; the deep
    // shadow + a 1px white/5 edge are what separate the two, not a
    // contrasting fill color. The `import-backdrop` / `import-dialog`
    // classes drive a soft, fast entry (see index.css) — same family
    // as `lyrics-dialog`.
    //
    // Backdrop click closes the modal — `event.stopPropagation()` on
    // the panel prevents clicks inside it from bubbling out and
    // accidentally dismissing. Guarded by `!importing` so a mid-import
    // backdrop tap can't strand the user without a result.
    <div
      className="import-backdrop fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4 sm:p-6"
      onClick={() => {
        if (!importing) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm track metadata"
        onClick={(event) => event.stopPropagation()}
        className="import-dialog flex max-h-[min(84vh,52rem)] w-full max-w-[min(56rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-white/5 bg-black shadow-[0_48px_160px_rgba(0,0,0,0.7)]"
      >
        <div className="px-6 py-5">
          <div className="truncate text-base font-semibold text-white">
            Review your {rows.length === 1 ? "track" : "tracks"}
          </div>
        </div>
        {/* nice-scroll keeps the scrollbar thin and dark like every
           other scroll surface in the app. The raw white webkit
           default is what showed up here before. */}
        <div className="nice-scroll flex-1 overflow-y-auto px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <ImportRow
                key={row.tempId}
                row={row}
                onChange={(update) =>
                  setRows((current) =>
                    current.map((entry) =>
                      entry.tempId === row.tempId ? { ...entry, ...update } : entry,
                    ),
                  )
                }
                onRemove={() => onRemoveRow(row.tempId)}
                onDropCover={(event) => handleCoverDrop(event, row.tempId)}
                onCoverPicked={(file) => handleCoverPicked(file, row.tempId)}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-4">
          {error ? (
            <div className="mr-auto text-sm font-semibold text-red-400">{error}</div>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="flex h-9 items-center rounded-full px-4 text-sm font-semibold text-white/72 transition-colors duration-150 ease-out hover:bg-white/8 hover:text-white disabled:opacity-50 animate-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={importing || rows.length === 0}
            // `font-semibold` (not `font-bold`) per the app's preference
            // for semibold over heavier weights. `transition` (not
            // `transition-transform`) so the bg also eases on hover, and
            // `hover:scale-[1.02]` matches the Upload button — the only
            // place in the app that uses a scale on hover.
            className="flex h-9 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black shadow-[0_6px_18px_rgba(0,0,0,0.32)] transition duration-150 ease-out hover:scale-[1.02] hover:bg-white/96 disabled:opacity-50 animate-none"
          >
            {importing ? (
              <>
                <LoaderCircle size={14} className="animate-spin" />
                Importing…
              </>
            ) : (
              <>
                <Plus size={14} strokeWidth={2.4} />
                Import {rows.length} {rows.length === 1 ? "track" : "tracks"}
              </>
            )}
          </button>
        </div>
      </div>
      {pendingCoverFile && (
        <CoverImageCropper
          file={pendingCoverFile}
          onConfirm={(dataUrl) => {
            void handleCoverConfirm(dataUrl);
          }}
          onCancel={handleCoverCancel}
        />
      )}
    </div>
  );
}

function ImportRow({
  row,
  onChange,
  onRemove,
  onDropCover,
  onCoverPicked,
}: {
  row: PendingImportRow;
  onChange: (update: Partial<PendingImportRow>) => void;
  onRemove: () => void;
  onDropCover: (event: DragEvent<HTMLLabelElement>) => void;
  onCoverPicked: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const titleId = `import-row-title-${row.tempId}`;
  const artistId = `import-row-artist-${row.tempId}`;

  const handleCoverPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    // Hand the picked file up to the modal so it can route through
    // `CoverImageCropper` — same crop/zoom flow the playlist page uses.
    onCoverPicked(file);
  };

  // Invisible inline-edit input. No border, no bg, no focus highlight,
  // no padding offset — the input is just text. The user clicks
  // anywhere on the text to start typing. `autoComplete`/`autoCorrect`/
  // `spellCheck` are off so the browser doesn't underline titles or
  // suggest "fixes" for band/album names — same treatment the search
  // bar uses.
  const inlineEditClass =
    "block w-full bg-transparent text-inherit outline-none placeholder:text-white/28";

  return (
    // Row layout mirrors `DiscographyTrackRow` (artist page): a cover
    // cell on the left, then a stacked title + artist line, then a
    // per-row remove on the right. No row dividers; the
    // `hover:bg-white/[0.03]` highlight does the separation, the same
    // value the discography uses for the active track treatment.
    // `transition-colors` (not `transition-all`) for the same reason
    // the lyrics page note in index.css:330 warns about — keeps the
    // input off a fresh compositor layer so the text doesn't get
    // antialiasing seams.
    <div className="import-row group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-white/[0.03]">
      {/* Cover cell. The cell is a `<label>` wrapping the hidden
         <input>, so clicking anywhere on the cell opens the file
         picker — no separate "Cover" button needed. Solid
         `bg-neutral-800` matches every other artwork cell in the
         app. The only visual cue that the cell accepts a drop is
         the slight bg lighten to `bg-neutral-700` while a file is
         hovering over it. `focus-within:ring-1` puts a thin
         white/20 ring around the cell when the hidden input is
         focused via Tab, so keyboard users can see where they are.
         The empty state uses `DefaultArtwork` — the same app-icon
         placeholder the Local tab renders for tracks without a
         cover. */}
      <label
        className={cn(
          "relative block h-12 w-12 shrink-0 cursor-pointer select-none overflow-hidden bg-neutral-800 focus-within:ring-1 focus-within:ring-white/20",
          getArtworkRoundedClass(),
          dragOver ? "bg-neutral-700" : "",
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          setDragOver(false);
          onDropCover(event);
        }}
        aria-label="Album art"
      >
        {row.coverFile ? (
          <img
            src={URL.createObjectURL(row.coverFile)}
            alt=""
            className="block h-full w-full object-cover"
            onLoad={(event) => URL.revokeObjectURL(event.currentTarget.src)}
          />
        ) : (
          <DefaultArtwork />
        )}
        <input
          type="file"
          accept="image/*"
          onChange={handleCoverPick}
          className="hidden"
          tabIndex={-1}
        />
      </label>

      {/* Title + artist stack. Title is the primary line at
         `text-[15px] font-semibold text-white/92` — the same size
         and tone the discography uses for its track titles, but
         `font-semibold` (600) instead of `font-bold` (700) per the
         app's preference for semibold over heavier weights. The
         smaller line below holds the artist only (no album field);
         it's editable inline. */}
      <div className="min-w-0 flex-1">
        <input
          id={titleId}
          value={row.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="Track title"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            inlineEditClass,
            "truncate text-[15px] font-semibold text-white/92",
          )}
        />
        <div className="mt-0.5 truncate text-sm font-semibold text-white/48">
          <input
            id={artistId}
            value={row.artist}
            onChange={(event) => onChange({ artist: event.target.value })}
            placeholder="Add artist"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(inlineEditClass, "w-full truncate")}
          />
        </div>
        </div>

        {/* Find lyrics toggle. On import, if this is checked, the app
           searches for synced lyrics by title + artist and attaches
           them to the track so the lyrics page works for local files. */}
        <label
          className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-white/48 transition-colors hover:text-white/72"
          title="Search for and attach synced lyrics after import"
        >
          <input
            type="checkbox"
            checked={row.findLyrics}
            onChange={(event) => onChange({ findLyrics: event.target.checked })}
            className="h-3.5 w-3.5 accent-white"
          />
          Find lyrics
        </label>

        {/* Per-row remove. The X is a bare glyph with just a text-color
           change on hover — no circular bg fill, no scale, no border,
           no outline. Matches the "minimal hover depending on button
           type" rule: a destructive icon action that should be quietly
           present until touched. */}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-white/40 transition-colors duration-150 ease-out hover:text-white animate-none"
        aria-label="Remove row"
      >
        <X size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function MenuPanel({ children, className }: { children: ReactNode; className: string }) {
  return (
    <div
      className={`artist-menu-pop absolute z-40 overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)] ${className}`}
    >
      {children}
    </div>
  );
}

function MenuOption({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-white/8 animate-none ${
        active ? "text-white" : "text-white/72"
      }`}
    >
      {icon && <span className={active ? "text-white" : "text-white/72"}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={16} />}
    </button>
  );
}
