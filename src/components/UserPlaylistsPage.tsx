import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Upload,
} from "lucide-react";
import { importExternalPlaylist, type ExternalPlaylistImport } from "../api";
import { usePlaylists, DESCRIPTION_MAX_LENGTH, type UserPlaylist } from "../playlists";
import type { MediaTrack } from "../types";
import { getArtworkRoundedClass, ArtworkImage, DefaultArtwork } from "./Shared";
import { usePlayer } from "../player";
import type { View } from "./Sidebar";
import { IconSearch, IconX, IconYoutube, IconSpotify, IconAppleMusic } from "../wrapped-icons";
import { PlaylistContextMenu } from "./PlaylistContextMenu";
import {
  downloadAndEncodeCover,
  matchExternalTracksInParallel,
  serviceLabel,
} from "../utils/external-import";

// Lowercase + strip diacritics so accented characters in titles match
// their plain counterparts in the search query (e.g. "café" matches
// "cafe", "naïve" matches "naive"). NFD decomposes accented
// characters into a base letter plus a combining mark; stripping the
// combining mark class (U+0300–U+036F) leaves the bare letter. The
// function is intentionally permissive — no case folding beyond
// `toLowerCase` because titles are predominantly Latin-script on
// this page, and any user who searches in the same alphabet as their
// titles will already get the expected match.
function normalizeForSearch(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function UserPlaylistsPage({
  onNavigate,
  onCreatePlaylist,
  onDeletePlaylist,
}: {
  onNavigate: (view: View) => void;
  onCreatePlaylist: () => void;
  onDeletePlaylist: (id: string) => void;
}) {
  const { playlists, createPlaylist, updatePlaylist, addTrackToPlaylist, togglePlaylistPinned } = usePlaylists();
  const [searchQuery, setSearchQuery] = useState("");
  const [importFlow, setImportFlow] = useState<ImportFlowState | null>(null);

  const [contextMenuPlaylistId, setContextMenuPlaylistId] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuOpen = contextMenuPlaylistId !== null;

  // ── Context-menu dismissal (unchanged behavior) ──────────────────────
  useEffect(() => {
    if (!contextMenuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (contextMenuRef.current?.contains(target)) return;
      setContextMenuPlaylistId(null);
      setContextMenuPosition(undefined);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenuOpen]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenuPlaylistId(null);
        setContextMenuPosition(undefined);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenuOpen]);

  const handleContextMenu = useCallback((event: React.MouseEvent, playlistId: string) => {
    event.preventDefault();
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
    setContextMenuPlaylistId(playlistId);
  }, []);

  const handleContextMenuDelete = useCallback(() => {
    if (contextMenuPlaylistId) {
      onDeletePlaylist(contextMenuPlaylistId);
    }
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, [contextMenuPlaylistId, onDeletePlaylist]);

  const handleContextMenuTogglePin = useCallback(() => {
    if (contextMenuPlaylistId) {
      togglePlaylistPinned(contextMenuPlaylistId);
    }
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, [contextMenuPlaylistId, togglePlaylistPinned]);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, []);

  // ── External playlist import ─────────────────────────────────────────
  //
  // Drives the URL modal state machine and the matching worker. The
  // matching pass is started from inside the modal so we can attach
  // an `isCancelled` ref to it without leaking a long-running promise
  // when the user dismisses the dialog.
  const handleImportSelectService = useCallback((service: ImportFlowState["service"]) => {
    setImportFlow({ kind: "input", service });
  }, []);

  // Flip the cancelRef directly off the latest state via a functional setter
  // so we don't capture a stale snapshot of the async flow. The `input` kind
  // has no in-flight work; the `cancelRef` membership check scopes the
  // mutation to the kinds that actually own one.
  const handleImportClose = useCallback(() => {
    setImportFlow((current) => {
      if (current && "cancelRef" in current) {
        (current.cancelRef as { current: boolean }).current = true;
      }
      return null;
    });
  }, []);

  const handleImportSubmit = useCallback(
    async (url: string) => {
      const cancelRef = { current: false };
      setImportFlow((current) => ({
        kind: "fetching",
        service: current?.service ?? "youtube",
        url,
        cancelRef,
      }));
      try {
        const result = await importExternalPlaylist(url);
        if (cancelRef.current) return;
        const matchingCancelRef = { current: false };
        setImportFlow({
          kind: "matching",
          service: result.service,
          source: result,
          matched: 0,
          checked: 0,
          cancelRef: matchingCancelRef,
        });
        const matches = await matchExternalTracksInParallel(result.tracks, {
          isCancelled: () => matchingCancelRef.current,
          onProgress: (matched, checked) => {
            setImportFlow((current) => {
              if (!current || current.kind !== "matching") return current;
              return { ...current, matched, checked };
            });
          },
        });
        if (matchingCancelRef.current) return;
        const matched = matches.filter((track): track is NonNullable<typeof track> => track !== null);
        setImportFlow({
          kind: "ready",
          service: result.service,
          source: result,
          matches: matched,
          cancelRef: { current: false },
        });
      } catch (error) {
        if (cancelRef.current) return;
        // Tauri rejects the JS Promise with the Rust command's
        // `Err(String)` directly — a primitive JS string, NOT an
        // `Error` instance. The previous `error instanceof Error`
        // check therefore surfaced the generic "Failed to import
        // playlist." fallback for every Rust-side failure and
        // swallowed the actionable root cause ("yt-dlp timed out",
        // "Spotify request failed", etc.) so the user couldn't tell
        // what was wrong. Now we accept every common rejection
        // shape: a raw string, a real Error, or a plain
        // `{ message: string }` object that Tauri's internals
        // occasionally produce from the panic path.
        let message: string;
        if (typeof error === "string") {
          message = error;
        } else if (error instanceof Error) {
          message = error.message;
        } else if (
          error &&
          typeof error === "object" &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ) {
          message = (error as { message: string }).message;
        } else {
          message = "Failed to import playlist.";
        }
        setImportFlow((current) => ({
          kind: "error",
          service: current?.service ?? "youtube",
          message,
          cancelRef: { current: false },
        }));
      }
    },
    [],
  );

  // The dialog's "Save and open" commit takes the `ready` snapshot
  // explicitly as a parameter. We deliberately DO NOT capture it via a
  // ref + functional-setter trick because the previous implementation
  // assigned the snapshot inside `setImportFlow((current) => ...)` and
  // then read it back on the next line — React state setters run
  // asynchronously, so the ref was still `null` at the read point. The
  // function then early-returned and silently aborted the commit while
  // the modal still dismissed itself (because the queued setter
  // eventually fired and cleared `importFlow`), producing a "claims to
  // successfully import, but the playlist doesn't show up" bug. Passing
  // the snapshot in takes the setter race out of the equation entirely.
  const handleImportCommit = useCallback(
    async (snapshot: Extract<ImportFlowState, { kind: "ready" }>) => {
      // Close the dialog immediately. Clear synchronously so the modal
      // unmounts without waiting for a re-render.
      setImportFlow(null);

      const playlist = createPlaylist();
      // Seed the title/description first so the freshly-mounted
      // <UserPlaylistPage> renders with the imported metadata on its
      // very first paint instead of flashing the placeholder.
      updatePlaylist(playlist.id, {
        title: snapshot.source.title || playlist.title,
        description: (snapshot.source.description ?? "").slice(0, DESCRIPTION_MAX_LENGTH),
      });
      if (snapshot.source.coverUrl) {
        const dataUrl = await downloadAndEncodeCover(snapshot.source.coverUrl);
        if (dataUrl) {
          updatePlaylist(playlist.id, { cover: dataUrl });
        }
      }
      for (const track of snapshot.matches) {
        addTrackToPlaylist(playlist.id, track);
      }
      onNavigate({ name: "user-playlist", id: playlist.id });
    },
    [createPlaylist, updatePlaylist, addTrackToPlaylist, onNavigate],
  );

  const filteredPlaylists = useMemo(() => {
    const raw = searchQuery.trim();
    if (!raw) return playlists;

    // Normalize the query once and split into individual search terms.
    // Each term is matched independently (OR semantics) so typing
    // "lofi chill" still surfaces titles that contain only one of the
    // words; the strongest matches (full-phrase or all-words-in-title)
    // rank highest. Description is intentionally NOT searched — the
    // title is the canonical identifier on the page and the previous
    // description bonus was dwarfed by every title match, which made
    // description-only hits effectively invisible.
    const phrase = normalizeForSearch(raw);
    const terms = phrase.split(/\s+/).filter(Boolean);

    const scored = playlists.map((p) => {
      const title = normalizeForSearch(p.title);
      let score = 0;

      // Phrase-level matches dominate so the exact query outranks a
      // title that just happens to contain the same words in a
      // different order.
      if (title === phrase) score += 100;
      else if (title.startsWith(phrase)) score += 60;
      else if (title.includes(phrase)) score += 25;

      // Per-term OR matching: every query term that appears in the
      // title adds a small bonus, so a title containing all the
      // searched words scores higher than one that contains only one.
      const termHits = terms.reduce(
        (count, term) => count + (title.includes(term) ? 1 : 0),
        0,
      );
      score += termHits * 5;

      return { playlist: p, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        // Pinned playlists always rank above non-pinned, regardless of
        // their relevance score. This mirrors the sidebar's partition
        // so a user who pins a playlist and then searches for it still
        // sees it surface to the top of the results.
        const aPinned = a.playlist.pinned ?? false;
        const bPinned = b.playlist.pinned ?? false;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;

        if (b.score !== a.score) return b.score - a.score;
        // Stable tiebreaker so equal-scored results don't reshuffle on
        // re-render: newest first, then alphabetical by title.
        const dateDiff = b.playlist.createdAt - a.playlist.createdAt;
        if (dateDiff !== 0) return dateDiff;
        return a.playlist.title.localeCompare(b.playlist.title);
      })
      .map((s) => s.playlist);
  }, [playlists, searchQuery]);

  return (
    <div className="overflow-x-hidden bg-black pb-0">
      <div className="pt-[var(--ui-topbar-height)] px-[var(--ui-page-pad)] pb-[clamp(1.5rem,2vw,2.5rem)]">
        <div className="mx-auto max-w-[var(--ui-content-max)]">
          <div className="mb-6 flex flex-wrap items-center gap-4 pt-6">
            <h1 className="text-3xl font-bold text-white">Playlists</h1>
            <div className="ml-auto flex items-center gap-3">
              <PlaylistsSearchInput
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
              />
              <HeaderPill
                onCreatePlaylist={onCreatePlaylist}
                onPickService={handleImportSelectService}
              />
            </div>
          </div>

          {filteredPlaylists.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <p className="text-base font-semibold text-white">
                {searchQuery.trim() ? "No playlists match your search" : "No playlists yet"}
              </p>
              <p className="text-sm text-neutral-400">
                {searchQuery.trim()
                  ? "Try a different search term."
                  : "Create a playlist from the sidebar to get started."}
              </p>
            </div>
          ) : (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filteredPlaylists.map((playlist, index) => (
                <PlaylistCard
                  key={playlist.id}
                  playlist={playlist}
                  index={index}
                  onClick={() => onNavigate({ name: "user-playlist", id: playlist.id })}
                  onContextMenu={(event) => handleContextMenu(event, playlist.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {contextMenuOpen && contextMenuPosition && contextMenuPlaylistId && (
        <PlaylistContextMenu
          menuRef={contextMenuRef}
          position={contextMenuPosition}
          pinned={
            playlists.find((p) => p.id === contextMenuPlaylistId)?.pinned ?? false
          }
          onTogglePin={handleContextMenuTogglePin}
          onClose={handleContextMenuClose}
          onDelete={handleContextMenuDelete}
          playlist={
            playlists.find((p) => p.id === contextMenuPlaylistId) ?? null
          }
        />
      )}

      {importFlow && (
        <ImportDialog
          flow={importFlow}
          onClose={handleImportClose}
          onSubmit={handleImportSubmit}
          onCommit={handleImportCommit}
        />
      )}
    </div>
  );
}

// ── Playlist search input ───────────────────────────────────────────────
//
// Sibling to the HeaderPill — kept separate so the pill remains a tight
// two-control widget ("New Playlist" + "Import"). Same visual language
// as the TopBar search field: rounded-full, transparent against the
// page, white/10 border that brightens on hover/focus.
function PlaylistsSearchInput({
  searchQuery,
  onSearchChange,
}: {
  searchQuery: string;
  onSearchChange: (value: string) => void;
}) {
  return (
    <div className="relative ml-auto h-10 min-w-0 max-w-xs flex-1">
      <input
        type="text"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search playlists"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-10 w-full rounded-full border border-white/10 bg-white/5 pl-10 pr-9 text-sm text-white placeholder-neutral-500 outline-none backdrop-blur-md transition-colors hover:border-white/15 hover:bg-white/10 focus:border-white/15 focus:bg-white/10"
      />
      <div className="pointer-events-none absolute inset-y-0 left-3 z-10 flex items-center text-neutral-500">
        <IconSearch size={16} />
      </div>
      {searchQuery && (
        <div className="absolute inset-y-0 right-2 z-10 flex items-center">
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900/90 text-white/85 transition hover:bg-neutral-700 hover:text-white"
          >
            <IconX size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Header pill ─────────────────────────────────────────────────────────
//
// Single rounded container holding the playlist-creation actions:
//   1. A "New Playlist" button.
//   2. A vertical `bg-white/10` divider — same treatment as the back/
//      forward nav buttons in the TopBar's history pill.
//   3. An import button (Upload icon — same icon the Collection menu
//      uses for "Import to library") with an inline dropdown for
//      picking the source service.
//
// Widened from one to two controls; remains visually single-unit at
// rest but feels coherent with the TopBar's history pill style.
function HeaderPill({
  onCreatePlaylist,
  onPickService,
}: {
  onCreatePlaylist: () => void;
  onPickService: (service: ImportFlowState["service"]) => void;
}) {
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!importMenuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (importMenuRef.current?.contains(target)) return;
      if (importButtonRef.current?.contains(target)) return;
      setImportMenuOpen(false);
    };
    const escHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImportMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [importMenuOpen]);

  return (
    // Outer `<div>` is the positioning anchor for the dropdown menu
    // (sibling below). `inline-block` keeps us shrink-wrapped inside the
    // surrounding flex header row instead of taking full row width.
    //
    // Matches the TopBar's `PageHistoryControls` pill EXACTLY inside this
    // wrapper: rounded, bounded by `overflow-hidden` so the per-cell
    // hover highlight clamps into the pill's rounded curvature (instead
    // of bleeding into a square patch). No container-wide hover.
    <div className="relative inline-block">
      <div className="flex h-11 items-center overflow-hidden rounded-full border border-white/10 bg-white/5 backdrop-blur-md">
        <button
          type="button"
          onClick={onCreatePlaylist}
          className="flex h-11 items-center gap-2 px-4 text-sm font-semibold text-white transition enabled:hover:bg-white/10 enabled:hover:text-white"
        >
          <Plus size={15} strokeWidth={1.8} />
          New Playlist
        </button>

        {/* Divider — `h-6 w-px bg-white/10`, same separator treatment as the
            back/forward nav buttons in the TopBar's history pill. Sits flush
            against both buttons with no extra margin. */}
        <div className="h-6 w-px shrink-0 bg-white/10" />

        <button
          ref={importButtonRef}
          type="button"
          onClick={() => setImportMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={importMenuOpen}
          aria-label="Import playlist"
          // Idle text matches the page-history chevron's neutral wait color
          // (`text-neutral-500`). The menu now opens reliably (sits outside
          // the overflow-hidden pill, anchored to the outer wrapper), so
          // the dim idle reads as "always-available, currently resting"
          // rather than "disabled". Hover lifts to white on a `bg-white/10`
          // cell tinted by the pill's rounded corners.
          className="flex h-11 w-11 items-center justify-center text-neutral-500 transition enabled:hover:bg-white/10 enabled:hover:text-white"
        >
          <Upload size={16} strokeWidth={2.2} />
        </button>
      </div>

      {/* Dropdown lives OUTSIDE the overflow-hidden pill so it isn't
          clipped; anchored to the outer wrapper's right edge + 8px
          below the pill bottom. `right-0` resolves against the wrapper
          (NOT the body) because this wrapper is the nearest positioned
          ancestor. */}
      {importMenuOpen && (
        <div
          ref={importMenuRef}
          role="menu"
          className="artist-menu-pop absolute right-0 top-[calc(100%+8px)] z-30 flex min-w-[14rem] flex-col overflow-hidden rounded-[4px] border border-white/10 bg-neutral-950 shadow-[0_18px_48px_rgba(0,0,0,0.48)]"
        >
          <ImportServiceOption
            service="youtube"
            label="YouTube Music"
            onClick={() => {
              setImportMenuOpen(false);
              onPickService("youtube");
            }}
          />
          <ImportServiceOption
            service="spotify"
            label="Spotify"
            onClick={() => {
              setImportMenuOpen(false);
              onPickService("spotify");
            }}
          />
          <ImportServiceOption
            service="apple"
            label="Apple Music"
            onClick={() => {
              setImportMenuOpen(false);
              onPickService("apple");
            }}
          />
        </div>
      )}
    </div>
  );
}

function ImportServiceOption({
  service,
  label,
  onClick,
}: {
  service: ImportFlowState["service"];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition hover:bg-white/8 hover:text-white"
    >
      <ServiceIcon service={service} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Upload size={16} className="text-white/40" />
    </button>
  );
}

function ServiceIcon({ service }: { service: ImportFlowState["service"] }) {
  const icons: Record<ImportFlowState["service"], React.ReactNode> = {
    youtube: <IconYoutube size={18} className="text-red-500" />,
    spotify: <IconSpotify size={18} className="text-[#1bd760]" />,
    apple: <IconAppleMusic size={18} className="text-red-500" />,
  };
  return <span className="flex shrink-0 items-center justify-center" aria-hidden>{icons[service]}</span>;
}

// ── Import dialog (state-machine) ───────────────────────────────────────
//
// `idle` (showing URL input) → `fetching` (yt-dlp running) →
// `matching` (searching) → `ready` (showing summary) →
// `error` (error message with retry option).
// `cancelRef` flips true if the user closes the modal mid-flight so
// async workers can bail out without orphaning state.
type ImportFlowState =
  | { kind: "input"; service: "youtube" | "spotify" | "apple" }
  | {
      kind: "fetching";
      service: "youtube" | "spotify" | "apple";
      url: string;
      cancelRef: { current: boolean };
    }
  | {
      kind: "matching";
      service: "youtube" | "spotify" | "apple";
      source: ExternalPlaylistImport;
      matched: number;
      checked: number;
      cancelRef: { current: boolean };
    }
  | {
      kind: "ready";
      service: "youtube" | "spotify" | "apple";
      source: ExternalPlaylistImport;
      matches: MediaTrack[];
      cancelRef: { current: boolean };
    }
  | {
      kind: "error";
      service: "youtube" | "spotify" | "apple";
      message: string;
      cancelRef: { current: boolean };
    };

function ImportDialog({
  flow,
  onClose,
  onSubmit,
  onCommit,
}: {
  flow: ImportFlowState;
  onClose: () => void;
  onSubmit: (url: string) => Promise<void>;
  // `onCommit` takes the `ready` snapshot explicitly so the parent
  // owner's commit logic doesn't have to rebuild it from a ref over an
  // async boundary — see handleImportCommit's note.
  onCommit: (snapshot: Extract<ImportFlowState, { kind: "ready" }>) => Promise<void>;
}) {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-playlist-title"
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mx-4 flex w-full max-w-md flex-col gap-5 rounded-xl border border-white/10 bg-black p-6 shadow-[0_24px_60px_rgba(0,0,0,0.62)]">
        <DialogHeader flow={flow} />
        {flow.kind === "input" && (
          <DialogInput flow={flow} onSubmit={onSubmit} onClose={onClose} />
        )}
        {flow.kind === "fetching" && (
          <DialogFetching flow={flow} onClose={onClose} />
        )}
        {flow.kind === "matching" && (
          <DialogMatching flow={flow} onClose={onClose} />
        )}
        {flow.kind === "ready" && (
          <DialogReady flow={flow} onCommit={onCommit} onClose={onClose} />
        )}
        {flow.kind === "error" && <DialogError flow={flow} onClose={onClose} onSubmit={onSubmit} />}
      </div>
    </div>,
    document.body,
  );
}

function DialogHeader({ flow }: { flow: ImportFlowState }) {
  // Stripped to just the title: the "Import from ___" eyebrow text and the
  // X close button are gone — the modal stays dismissable via the existing
  // `onPointerDown` backdrop handler (click-off-to-close).
  return (
    <h2 id="import-playlist-title" className="text-lg font-semibold text-white">
      {dialogTitleFor(flow)}
    </h2>
  );
}

function dialogTitleFor(flow: ImportFlowState): string {
  switch (flow.kind) {
    case "input":
      return `Paste a ${serviceLabel(flow.service)} playlist link`;
    case "fetching":
      return `Reading your ${serviceLabel(flow.service)} playlist…`;
    case "matching":
      return `Matching songs (${flow.checked}/${flow.source.tracks.length})…`;
    case "ready":
      return `Ready to import from ${serviceLabel(flow.service)}`;
    case "error":
      return "We couldn't import that playlist";
  }
}

function DialogInput({ flow, onSubmit, onClose }: { flow: Extract<ImportFlowState, { kind: "input" }>; onSubmit: (url: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const placeholder = placeholderForService(flow.service);

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || pending) return;
      setPending(true);
      try {
        await onSubmit(trimmed);
      } finally {
        setPending(false);
      }
    },
    [onSubmit, pending, value],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-neutral-400">
        Paste a public playlist link from {serviceLabel(flow.service)}. We'll match each
        song against YouTube Music and skip anything we can't find a clean copy of.
      </p>
      <input
        type="url"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        className="h-11 w-full rounded-lg border border-white/12 bg-white/5 px-3 text-sm text-white placeholder-neutral-500 outline-none transition-colors hover:border-white/20 focus:border-white/30 focus:bg-white/10"
      />
      <div className="flex justify-end gap-3">
        <CancelCloseButton pending={pending} onClose={onClose} />
        <button
          type="submit"
          disabled={!value.trim() || pending}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} strokeWidth={2.2} />}
          Start import
        </button>
      </div>
    </form>
  );
}

function placeholderForService(service: ImportFlowState["service"]): string {
  if (service === "youtube") {
    return "https://music.youtube.com/playlist?list=…";
  }
  if (service === "spotify") {
    return "https://open.spotify.com/playlist/…";
  }
  return "https://music.apple.com/…/playlist/…";
}

function DialogFetching({ flow, onClose }: { flow: Extract<ImportFlowState, { kind: "fetching" }>; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <ProgressBanner message={`Calling ${serviceLabel(flow.service)}…`} />
      <p className="break-all text-xs text-neutral-500">{flow.url}</p>
      <div className="flex justify-end">
        <CancelCloseButton pending={false} onClose={onClose} />
      </div>
    </div>
  );
}

function DialogMatching({ flow, onClose }: { flow: Extract<ImportFlowState, { kind: "matching" }>; onClose: () => void }) {
  const total = flow.source.tracks.length;
  const pct = total > 0 ? Math.min(100, Math.round((flow.checked / total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-neutral-400">
        Looking up <span className="font-semibold text-white">{flow.source.title}</span> on{" "}
        {serviceLabel(flow.service)}. Matched <span className="font-semibold text-white">{flow.matched}</span>{" "}
        of {total} so far.
      </p>
      <ProgressBar percent={pct} />
      <div className="flex justify-end">
        <CancelCloseButton pending={false} onClose={onClose} />
      </div>
    </div>
  );
}

function ProgressBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/88">
      <LoaderCircle size={16} className="animate-spin text-white/72" />
      <span>{message}</span>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-white transition-[width] duration-150 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function DialogReady({ flow, onCommit, onClose }: { flow: Extract<ImportFlowState, { kind: "ready" }>; onCommit: (snapshot: Extract<ImportFlowState, { kind: "ready" }>) => Promise<void>; onClose: () => void }) {
  const [committing, setCommitting] = useState(false);
  const matched = flow.matches.length;

  // Guard the spinner-reset `setCommitting(false)` against the (very
  // likely) case where the dialog has already unmounted by the time
  // `onCommit` resolves. The parent's `handleImportCommit` calls
  // `setImportFlow(null)` synchronously to dismiss the modal, then
  // runs the playlist-create + cover-download + navigate sequence
  // before our `await onCommit(flow)` returns. Without this ref,
  // React would log the classic "state update on an unmounted
  // component" warning.
  // `mountedRef.current` MUST be re-set to `true` inside the effect body
  // (not just at `useRef` init time). In React 18 Strict Mode the component
  // mounts → unmounts → remounts during dev to surface side-effect bugs;
  // the unmount would otherwise leave `mountedRef.current = false`
  // permanently (since `useRef` preserves its mutable slot across the
  // remount), causing `handleCommit`'s isMounted guard to silently early-
  // return and swallow the click. Same pattern is correct outside Strict
  // Mode because the effect still fires its setup body on every mount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleCommit = useCallback(async () => {
    if (committing || !mountedRef.current) return;
    setCommitting(true);
    try {
      // Hand the whole `ready` branch over to the parent's commit
      // handler. Avoids the setState-then-read-ref race that previously
      // caused the commit to silently abort.
      await onCommit(flow);
    } finally {
      if (mountedRef.current) setCommitting(false);
    }
  }, [committing, onCommit, flow]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white">
        <Check size={16} className="text-[#1bd760]" />
        <span>
          Ready to import <span className="font-semibold">{matched}</span> {matched === 1 ? "song" : "songs"}.
        </span>
      </div>
      <p className="break-words text-sm leading-relaxed text-neutral-400">
        Creating playlist <span className="font-semibold text-white">{flow.source.title}</span>.
      </p>
      <div className="flex justify-end gap-3">
        <CancelCloseButton onClose={onClose} pending={committing} />
        <button
          type="button"
          onClick={handleCommit}
          disabled={matched === 0 || committing}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {committing ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />}
          Save and open
        </button>
      </div>
    </div>
  );
}

function DialogError({ flow, onClose, onSubmit }: { flow: Extract<ImportFlowState, { kind: "error" }>; onClose: () => void; onSubmit: (url: string) => Promise<void> }) {
  const [retryUrl, setRetryUrl] = useState("");
  const [pending, setPending] = useState(false);

  const handleRetry = useCallback(async () => {
    if (!retryUrl.trim() || pending) return;
    setPending(true);
    try {
      await onSubmit(retryUrl.trim());
    } finally {
      setPending(false);
    }
  }, [onSubmit, pending, retryUrl]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-red-300">{flow.message}</p>
      <input
        type="url"
        value={retryUrl}
        onChange={(event) => setRetryUrl(event.target.value)}
        placeholder="Paste a different playlist link"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        className="h-11 w-full rounded-lg border border-white/12 bg-white/5 px-3 text-sm text-white placeholder-neutral-500 outline-none transition-colors hover:border-white/20 focus:border-white/30 focus:bg-white/10"
      />
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleRetry}
          disabled={!retryUrl.trim() || pending}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} strokeWidth={2.2} />}
          Retry
        </button>
      </div>
    </div>
  );
}

function CancelCloseButton({ onClose, pending }: { onClose: () => void; pending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClose}
      disabled={pending}
      className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      Cancel
    </button>
  );
}

function PlaylistCard({
  playlist,
  index,
  onClick,
  onContextMenu,
}: {
  playlist: UserPlaylist;
  index: number;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const player = usePlayer();
  const tracks = playlist.tracks;
  const hasTracks = tracks.length > 0;
  const playlistOrigin: import("../player").QueueOrigin = {
    kind: "user-playlist",
    id: playlist.id,
    name: playlist.title,
  };
  const currentTrackInPlaylist = useMemo(() => {
    if (!player.currentTrack || !tracks.length) return false;
    return tracks.some((t) =>
      t.videoId && player.currentTrack!.videoId
        ? t.videoId === player.currentTrack!.videoId
        : t.id === player.currentTrack!.id,
    );
  }, [player.currentTrack, tracks]);
  const isPlaylistActive = Boolean(
    player.queueOrigin?.kind === "user-playlist" &&
      player.queueOrigin.id === playlist.id &&
      currentTrackInPlaylist,
  );
  const isPlaying = isPlaylistActive && player.isPlaying;
  const isBuffering = isPlaylistActive && player.isBuffering;
  const trackCount = tracks.length;
  const subtitle = trackCount === 0 ? "Empty" : `${trackCount} song${trackCount === 1 ? "" : "s"}`;

  const handlePlayClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!hasTracks) return;
    if (isPlaylistActive) {
      player.togglePlay();
      return;
    }
    void player.playMany(tracks, 0, playlistOrigin);
  }, [hasTracks, isPlaylistActive, player, tracks, playlistOrigin]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className="playlist-card group block w-full min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none animate-none"
      style={{ "--domino-index": index } as React.CSSProperties}
    >
      <div className={`relative aspect-square overflow-hidden bg-neutral-900 shadow-[0_4px_12px_rgba(0,0,0,0.28)] ${getArtworkRoundedClass()}`}>
        {playlist.cover ? (
          <ArtworkImage src={playlist.cover} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-white/30">
            <DefaultArtwork className="h-full w-full" />
          </div>
        )}
        <button
          type="button"
          onClick={handlePlayClick}
          className="absolute bottom-2 right-2 flex h-14 w-14 translate-y-2 items-center justify-center rounded-full bg-white text-black shadow-lg opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100 animate-none"
          aria-label={isBuffering ? "Loading" : isPlaying ? "Pause" : "Play"}
        >
          {isBuffering ? (
            <LoaderCircle size={24} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={24} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={24} fill="currentColor" strokeWidth={0} className="translate-x-[1.5px]" />
          )}
        </button>
      </div>
      <div className="px-1 pt-2">
        <div className="truncate text-[0.6875rem] font-semibold text-white">
          {playlist.title}
        </div>
        <div className="truncate text-sm font-medium text-neutral-400">
          {subtitle}
        </div>
      </div>
    </div>
  );
}
