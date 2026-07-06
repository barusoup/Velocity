import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clsx } from "clsx";
import { cn } from "../utils/cn";
import { ArrowDown, ArrowUp, ArrowUpDown, Book, Home, Pin, Plus, SlidersHorizontal } from "lucide-react";
import { fetchSearchSuggestions } from "../api";
import type { SearchSuggestion } from "../types";

function getInlineSuggestionSuffix(draft: string, suggestion: string): string | null {
  if (!draft || !suggestion || draft === suggestion) return null;
  if (!suggestion.toLowerCase().startsWith(draft.toLowerCase())) return null;
  return suggestion.slice(draft.length);
}
import {
  IconChevronLeft,
  IconChevronRight,
  IconMaximize,
  IconMinus,
  IconPanelLeftClose,
  IconPanelLeftOpen,
  IconSearch,
  IconSettings,
  IconX,
} from "../wrapped-icons";
import { useSetting } from "../settings";
import { DEFAULT_SEARCH_FILTERS, SearchFilterPanel, type SearchFilters, getActiveFilterCount } from "./SearchFilters";
import type { UserPlaylist } from "../playlists";
import type { SortMode, SortDirection } from "../playlists";
import { DefaultArtwork } from "./Shared";
import { PlaylistContextMenu } from "./PlaylistContextMenu";

const SIDEBAR_TRANSITION = "duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]";

export type View =
  | { name: "home" }
  | { name: "collection"; tab?: "albums" | "songs" | "local" }
  | { name: "search"; query: string }
  | { name: "album"; browseId: string; context: "default" | "search" }
  | {
      name: "artist";
      browseId: string;
      context: "default" | "search";
      cover?: string | null;
      section?: "overview" | "discography";
    }
  | { name: "playlist"; browseId: string; context: "default" | "search" }
  | { name: "user-playlist"; id: string }
  | { name: "user-playlists" }
  | { name: "lyrics" }
  | { name: "settings" };

export function isSearchWorkspace(view: View): boolean {
  return view.name === "search" || ("context" in view && view.context === "search");
}

export function Sidebar({
  view,
  onNavigate,
  expanded,
  onToggle,
  playlists,
  playlistsSortMode,
  playlistsSortDirection,
  onSetPlaylistsSortMode,
  onSetPlaylistsSortDirection,
  onCreatePlaylist,
  onDeletePlaylist,
  onTogglePinPlaylist,
}: {
  view: View;
  onNavigate: (view: View) => void;
  expanded: boolean;
  onToggle: () => void;
  playlists: UserPlaylist[];
  playlistsSortMode: SortMode;
  playlistsSortDirection: SortDirection;
  onSetPlaylistsSortMode: (mode: SortMode) => void;
  onSetPlaylistsSortDirection: (direction: SortDirection) => void;
  onCreatePlaylist: () => void;
  onDeletePlaylist: (id: string) => void;
  onTogglePinPlaylist: (id: string) => void;
}) {
  const showHomeMenu = useSetting("showHomeMenu");

  // `expanded` drives the sidebar width animation. Content visibility is
  // controlled via opacity transitions so the labels fade in/out in sync
  // with the sidebar opening/closing rather than teleporting at the end.

  return (
    <aside
      className={`sidebar-shell relative z-40 flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r      ${view.name === "lyrics" ? "border-white/5 bg-black/35" : "border-neutral-900 bg-black"} transition-[width,border-color] ${SIDEBAR_TRANSITION} ${
        expanded ? "w-[var(--ui-sidebar-open)]" : "w-[var(--ui-sidebar-closed)]"
      }`}
      style={{ willChange: "width", contain: "size layout" }}
      aria-label="Primary"
    >
      <div className="relative flex h-[var(--ui-topbar-height)] w-[var(--ui-sidebar-open)] items-center">
        <div className="flex h-full w-[var(--ui-sidebar-rail)] shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={onToggle}
            disabled={expanded}
            className={`sidebar-brand-button relative flex h-11 w-10 flex-shrink-0 items-center justify-center text-neutral-500 outline-none transition-[color,transform] ${SIDEBAR_TRANSITION} ${
              expanded
                ? "cursor-default"
                : "hover:text-white focus-visible:text-white"
            }`}
            aria-label={expanded ? "Velocity" : "Show sidebar"}
            aria-hidden={expanded ? true : undefined}
            tabIndex={expanded ? -1 : 0}
          >
            <span
              className={`sidebar-brand-logo absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center overflow-hidden rounded-md opacity-100 transition-[opacity,transform,filter] ${SIDEBAR_TRANSITION}`}
            >
              <img
                src="/icon.png"
                alt="Velocity"
                className="h-full w-full scale-110 object-cover"
                draggable={false}
              />
            </span>
            <span
              className={`sidebar-brand-glyph absolute flex h-11 w-11 items-center justify-center opacity-0 transition-[opacity,transform,filter] ${SIDEBAR_TRANSITION}`}
              aria-hidden="true"
            >
              <IconPanelLeftOpen size={18} />
            </span>
          </button>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className={`absolute right-3 flex h-11 w-11 min-w-11 flex-none items-center justify-center text-neutral-500 outline-none transition-[color,opacity,transform] ${SIDEBAR_TRANSITION} hover:text-white focus-visible:text-white ${
            expanded ? "translate-x-0 scale-100 opacity-100" : "pointer-events-none translate-x-2 scale-95 opacity-0"
          }`}
          aria-label="Collapse sidebar"
          aria-hidden={!expanded}
          tabIndex={expanded ? 0 : -1}
        >
          <IconPanelLeftClose size={18} />
        </button>
      </div>

      <nav className="relative w-[var(--ui-sidebar-open)]">
        <AnimatedSidebarNavItem visible={showHomeMenu}>
          <SidebarLink
            label="Home"
            active={view.name === "home"}
            onClick={() => onNavigate({ name: "home" })}
            icon={<Home size={18} strokeWidth={1.8} />}
            compact={!expanded}
          />
        </AnimatedSidebarNavItem>
        <SidebarLink
          label="Collection"
          active={view.name === "collection"}
          onClick={() => onNavigate({ name: "collection" })}
          icon={<Book size={18} />}
          compact={!expanded}
        />
      </nav>

      {/* `overflow-x-hidden` keeps the column from sprouting a sideways
          scrollbar if a descendent (e.g. an untruncated playlist title or
          artwork image with a natural aspect ratio) hands back a wider
          intrinsic size than the sidebar can fit. Without this, any
          horizontal overflow lands as a webkit scrollbar above Settings. */}
      {/* PlaylistsHeader sits OUTSIDE the scroll container so the
          "Playlists" label and the create/sort controls stay anchored
          to the top of the sidebar while the playlists themselves
          scroll. Tightly abuts Collection (which has its own mb-1) so
          the header reads as visually yoked to the main navigation. */}
      <PlaylistsHeader
        sortMode={playlistsSortMode}
        sortDirection={playlistsSortDirection}
        onSetSortMode={onSetPlaylistsSortMode}
        onSetSortDirection={onSetPlaylistsSortDirection}
        onCreate={onCreatePlaylist}
        expanded={expanded}
        onNavigate={onNavigate}
      />

      <div className="sidebar-playlists-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1">
        <PlaylistsSection
          playlists={playlists}
          activeView={view}
          expanded={expanded}
          onNavigate={onNavigate}
          sortMode={playlistsSortMode}
          onDeletePlaylist={onDeletePlaylist}
          onTogglePinPlaylist={onTogglePinPlaylist}
        />
      </div>

      <div
        // No top border: the user requested the divider above Settings be
        // invisible. We keep the wrapper so Settings sits at the bottom
        // of the sidebar (last child in the flex column) with shrink-0
        // to prevent compression, while the scroll container above it
        // fills all remaining space via flex-1.
        className="w-[var(--ui-sidebar-open)] pb-1.5 shrink-0"
      >
        <SidebarLink
          label="Settings"
          active={view.name === "settings"}
          onClick={() => onNavigate({ name: "settings" })}
          icon={<IconSettings size={18} />}
          compact={!expanded}
        />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Playlists section — sidebar list of user-created playlists.
//
// The header carries the "Playlists" label, a "+" button that creates a
// new playlist and immediately navigates into it, and a sort toggle that
// swaps between "createdAt" (newest first — the default) and "name" (A→Z).
// The two icons are sized to match the lucide icons used by the Search and
// Collection buttons above so the row reads as part of the same family,
// not a foreign control.
//
// Compact (sidebar collapsed): the icons stay, the label/icons vanish
// entirely. The plus + sort buttons are hidden in compact mode — compact
// users get a rail button that opens the Playlists page directly. (We
// don't surface a "create" affordance in compact mode to avoid surprise
// navigations triggered from the tiny collapsed rail.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Playlists header — the "Playlists" label plus the create/sort controls.
//
// Rendered ABOVE the playlists scroll container in Sidebar so the header
// stays anchored to the top of the sidebar while the playlists themselves
// scroll. Visibility still tracks `expanded` (the sidebar's open/closed
// state) so the header can fade in/out in lockstep with the rest of the
// expanded sidebar content. The margin below (`mb-1.5`) supplies the
// breathing room between the header row and the first playlist tile once
// each lane has its own scroll container — the previous `pt-4` on the
// playlists section lived at the top of the scroll area and has been
// removed so Collection (above) and the header (here) read as a single
// visual group.
// ---------------------------------------------------------------------------

function PlaylistsHeader({
  sortMode,
  sortDirection,
  onSetSortMode,
  onSetSortDirection,
  onCreate,
  expanded,
  onNavigate,
}: {
  sortMode: SortMode;
  sortDirection: SortDirection;
  onSetSortMode: (mode: SortMode) => void;
  onSetSortDirection: (direction: SortDirection) => void;
  onCreate: () => void;
  expanded: boolean;
  onNavigate: (view: View) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuCoords, setMenuCoords] = useState<{ top: number; left: number } | null>(null);

  // Position the menu when it opens
  useEffect(() => {
    if (!menuOpen) {
      setMenuCoords(null);
      return;
    }
    const measure = () => {
      const anchor = buttonRef.current;
      const panel = menuRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const padding = 8;

      let top = rect.bottom + padding;
      let left = rect.right - panelWidth;

      // Flip above if it would overflow the bottom edge
      if (top + panelHeight > viewportH - padding) {
        top = Math.max(padding, rect.top - panelHeight - padding);
      }
      if (top < padding) top = padding;

      // Flip left if it would overflow the right edge
      if (left + panelWidth > viewportW - padding) {
        left = Math.max(padding, viewportW - panelWidth - padding);
      }
      if (left < padding) left = padding;

      setMenuCoords({ top, left });
    };
    // Measure on next frame so the panel has its real dimensions
    requestAnimationFrame(measure);
  }, [menuOpen]);

  // Click-away close
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [menuOpen]);

  // Escape to close
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [menuOpen]);

  const handleSortSelect = (mode: SortMode) => {
    if (sortMode === mode) {
      onSetSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      onSetSortMode(mode);
    }
  };

  const getSortLabel = (mode: SortMode) => {
    switch (mode) {
      case "createdAt":
        return "Recently added";
      case "name":
        return "Alphabetical";
    }
  };

  return (
    <div className="relative w-[var(--ui-sidebar-open)] mb-1.5">
      {/*
        Expanded mode: "Playlists" label + "+" create button + sort toggle.
        Collapsed mode: invisible; replaced by the absolutely-positioned
        compact "+" button below.
      */}
      <div
        className={`flex items-center gap-1 ml-[calc((var(--ui-sidebar-rail)-2.5rem)/2)] mr-4 h-8 transition-opacity ${SIDEBAR_TRANSITION} ${
          expanded ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <button
          type="button"
          onClick={() => onNavigate({ name: "user-playlists" })}
          className="flex-1 truncate px-2 py-1 text-left text-xs font-semibold tracking-wider text-neutral-500 transition-colors hover:text-white rounded-md"
        >
          Playlists
        </button>
        <button
          type="button"
          onClick={onCreate}
          aria-label="Create new playlist"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-neutral-500 transition-colors hover:text-white"
        >
          <Plus size={15} strokeWidth={1.8} />
        </button>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Sort playlists"
          aria-expanded={menuOpen}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-neutral-500 transition-colors hover:text-white"
        >
          <ArrowUpDown size={14} strokeWidth={1.8} />
        </button>
      </div>
      {/*
        Collapsed mode: "+" button in the rail, exactly where the
        "Playlists" label would be.  Replaces the entire header so the
        create affordance is always one click away even in the narrow
        sidebar.
      */}
      <div
        className={`absolute top-0 left-0 right-0 flex items-center h-8 transition-opacity ${SIDEBAR_TRANSITION} ${
          expanded ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        aria-hidden={expanded}
      >
        <div className="ml-[calc((var(--ui-sidebar-rail)-2rem)/2)]">
          <button
            type="button"
            onClick={onCreate}
            aria-label="Create new playlist"
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:text-white"
          >
            <Plus size={17} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {menuOpen && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[60] w-44 overflow-hidden rounded-[4px] border border-white/10 bg-black shadow-[0_18px_48px_rgba(0,0,0,0.48)] animate-[artist-menu-pop_170ms_cubic-bezier(0.16,1,0.3,1)]"
          style={{
            top: menuCoords?.top ?? -9999,
            left: menuCoords?.left ?? -9999,
          }}
        >
          {(["createdAt", "name"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitem"
              onClick={() => handleSortSelect(mode)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] font-semibold transition hover:bg-white/5 ${
                sortMode === mode ? "text-white" : "text-white/72"
              }`}
            >
              <span>{getSortLabel(mode)}</span>
              {sortMode === mode && (
                sortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />
              )}
            </button>
          ))}

        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlists body — the two visual treatments of the user's playlists,
// intended to live INSIDE the sidebar's scroll container.
//
// The header row used to live at the top of this component (above the
// playlist list inside the expanded view). It has been promoted to
// PlaylistsHeader above so it can sit outside the scroll area and stay
// anchored while the playlist list scrolls beneath it.
// ---------------------------------------------------------------------------

function PlaylistsSection({
  playlists,
  activeView,
  expanded,
  onNavigate,
  sortMode,
  onDeletePlaylist,
  onTogglePinPlaylist,
}: {
  playlists: UserPlaylist[];
  activeView: View;
  expanded: boolean;
  onNavigate: (view: View) => void;
  sortMode: SortMode;
  onDeletePlaylist: (id: string) => void;
  onTogglePinPlaylist: (id: string) => void;
}) {
  const activePlaylistId = activeView.name === "user-playlist" ? activeView.id : null;

  const [contextMenuPlaylistId, setContextMenuPlaylistId] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuOpen = contextMenuPlaylistId !== null;

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
    // The Sidebar's `<aside>` ancestor carries `contain: layout`, which
    // turns it into a containing block for `position: fixed` descendants.
    // If we mount `<ConfirmDialog>` here its `inset-0` backdrop would
    // size to the sidebar (~240px) instead of the viewport, covering the
    // playlist icons with a dark+blurred panel. Instead, this handler
    // raises a "request" up to `App.tsx`, which rides the global modal
    // mounting site (next to the song/album menus) — both escape the
    // sidebar's containing block AND match the project's existing
    // pattern for top-level confirmation modals.
    if (contextMenuPlaylistId) {
      onDeletePlaylist(contextMenuPlaylistId);
    }
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, [contextMenuPlaylistId, onDeletePlaylist]);

  const handleContextMenuTogglePin = useCallback(() => {
    if (contextMenuPlaylistId) {
      onTogglePinPlaylist(contextMenuPlaylistId);
    }
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, [contextMenuPlaylistId, onTogglePinPlaylist]);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuPlaylistId(null);
    setContextMenuPosition(undefined);
  }, []);

  return (
    <div className="relative w-[var(--ui-sidebar-open)] pb-2">
      {/*
        The single list below handles BOTH the expanded and the compact
        sidebar treatments natively: `PlaylistsSidebarItem` shrinks its
        width to `w-10` and fades its internal text labels out when
        `compact` is true, then opens back up via the same `SIDEBAR_TRANSITION`
        easing the rest of the sidebar uses. An earlier revision rendered
        a second absolute-positioned rail of `CompactPlaylistsRailItem`
        tiles at the same coordinates and toggled both lists' opacity in
        parallel — the overlapping opacity transitions fought each other
        on the strict GPU layer the `<aside>`'s `contain: size layout`
        promotes this subtree onto, leaving WebKit/Chromium dropping the
        image textures for the icons in the steady state. Keeping a
        single source of truth (this `<ul>`) eliminates the dual
        paint-thrash path entirely.
      */}
      <ul key={sortMode} className="flex flex-col" role="list">
        {playlists.map((playlist, index) => (
          <PlaylistsSidebarItem
            key={playlist.id}
            playlist={playlist}
            active={activePlaylistId === playlist.id}
            compact={!expanded}
            index={index}
            onClick={() => onNavigate({ name: "user-playlist", id: playlist.id })}
            onContextMenu={(event) => handleContextMenu(event, playlist.id)}
          />
        ))}
      </ul>

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
          // The "Save to my device" row needs the full playlist
          // (tracks + cover) to drive the export. We look it up by
          // the right-clicked id so the menu always sees the playlist
          // the user actually clicked, not whatever was last selected
          // by navigation.
          playlist={
            playlists.find((p) => p.id === contextMenuPlaylistId) ?? null
          }
        />
      )}
    </div>
  );
}

function PlaylistsSidebarItem({
  playlist,
  active,
  onClick,
  onContextMenu,
  compact,
  index,
}: {
  playlist: UserPlaylist;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  compact: boolean;
  index: number;
}) {
  const trackCount = playlist.tracks.length;
  const subtitle = trackCount === 0 ? "Empty" : `${trackCount}`;
  const isPinned = playlist.pinned ?? false;
  // Translate the two sidebar treatments into the two pinned affordances
  // the user asked for: a solid green pin on the right of the row when
  // expanded, and a 1px emerald outline hugging the icon's rounded
  // corners when collapsed (so the pin reads at-a-glance even with the
  // label hidden). The `outline` property follows `border-radius` in
  // every modern browser, which keeps the green line flush with the
  // icon's 4px corners instead of clipping into a square at the corners.
  const compactPinOutline = compact && isPinned;
  
  return (
    <li
      className="sidebar-item-enter"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <button
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-current={active ? "page" : undefined}
        className={`group relative z-10 ml-[calc((var(--ui-sidebar-rail)-2.5rem)/2)] flex items-center gap-2 text-left transition-[width,color,padding] ${SIDEBAR_TRANSITION} ${
          compact
            ? "w-10 h-10 mb-3"
            : "pl-1 w-[calc(var(--ui-sidebar-open)-var(--ui-sidebar-rail)+2.5rem)] h-10 mb-3"
        } ${
          active
            ? "font-bold text-white"
            : "font-semibold text-neutral-200 hover:text-white"
        }`}
      >
        <span className={`absolute inset-x-0 rounded-md transition-colors duration-150 ${
          compact ? "inset-y-0" : "-inset-y-1"
        } ${
          active ? "bg-neutral-900" : "bg-neutral-900/0 group-hover:bg-neutral-900/50"
        }`} />
        <span
          className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-neutral-900 ${
            compactPinOutline ? "outline outline-2 outline-green-500" : ""
          }`}
        >
          {playlist.cover ? (
            <img
              src={playlist.cover}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <DefaultArtwork className="h-full w-full" />
          )}
          {/* Darken the cover slightly on hover so the row stands out
              (and so compact mode mirrors the expanded treatment). */}
          <span className="absolute inset-0 bg-black/0 transition-colors duration-150 group-hover:bg-black/20" />
        </span>
        <span className="relative z-10 min-w-0 flex-1 overflow-hidden">
          <span
            className={`block transition-opacity ${SIDEBAR_TRANSITION} ${
              compact ? "opacity-0" : "opacity-100"
            }`}
          >
            <span className="block truncate whitespace-nowrap font-semibold leading-tight text-sm">
              {playlist.title}
            </span>
            <span className="block truncate whitespace-nowrap text-[11px] font-semibold text-neutral-500">
              {subtitle} song{trackCount === 1 ? "" : "s"}
            </span>
          </span>
        </span>
        {!compact && isPinned && (
          <span
            className="relative z-10 mr-1.5 shrink-0 text-emerald-500"
            aria-hidden
          >
            <Pin size={14} fill="currentColor" strokeWidth={1.4} />
          </span>
        )}
      </button>
    </li>
  );
}

function AnimatedSidebarNavItem({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const [contentMounted, setContentMounted] = useState(visible);
  const [slotOpen, setSlotOpen] = useState(visible);
  const [motion, setMotion] = useState<"enter" | "exit" | null>(null);
  const prevVisibleRef = useRef(visible);
  const initialRenderRef = useRef(true);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      prevVisibleRef.current = visible;
      setContentMounted(visible);
      setSlotOpen(visible);
      return;
    }

    if (visible === prevVisibleRef.current) return;
    prevVisibleRef.current = visible;

    if (visible) {
      setContentMounted(true);
      if (reducedMotion) {
        setSlotOpen(true);
        setMotion(null);
        return;
      }
      setSlotOpen(false);
      setMotion(null);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setSlotOpen(true);
          setMotion("enter");
        });
      });
      return;
    }

    if (reducedMotion) {
      setSlotOpen(false);
      setContentMounted(false);
      setMotion(null);
      return;
    }

    setMotion("exit");
    setSlotOpen(false);
  }, [visible]);

  const handleSlotTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.propertyName !== "max-height") return;
      if (slotOpen || motion !== "exit") return;
      setContentMounted(false);
      setMotion(null);
    },
    [slotOpen, motion],
  );

  const handleAnimationEnd = useCallback(() => {
    if (motion === "enter") {
      setMotion(null);
    }
  }, [motion]);

  return (
    <div
      className={cn("sidebar-nav-slot", slotOpen && "is-open")}
      onTransitionEnd={handleSlotTransitionEnd}
    >
      {contentMounted ? (
        <div
          className={cn(
            motion === "enter" && "sidebar-nav-item-enter",
            motion === "exit" && "sidebar-nav-item-exit",
          )}
          onAnimationEnd={handleAnimationEnd}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function SidebarLink({
  label,
  active,
  onClick,
  icon,
  className = "",
  compact = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={compact ? label : undefined}
      className={`group relative z-10 mb-1 ml-[calc((var(--ui-sidebar-rail)-2.5rem)/2)] flex h-10 items-center overflow-hidden rounded-xl text-sm transition-[width,color,background-color] ${SIDEBAR_TRANSITION} ${
        compact ? "w-10" : "w-[calc(var(--ui-sidebar-open)-var(--ui-sidebar-rail)+2.5rem)]"
      } ${className} ${
        active ? "bg-neutral-900 font-bold text-white" : "font-semibold text-neutral-200 hover:bg-neutral-900/50 hover:text-white"
      }`}
    >
      <span className="flex h-10 w-10 flex-none items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 overflow-hidden">
        <span
          className={`block truncate whitespace-nowrap transition-opacity ${SIDEBAR_TRANSITION} ${
            compact ? "opacity-0" : "opacity-100"
          }`}
        >
          {label}
        </span>
      </span>
    </button>
  );
}

export function TopBar({
  onSearch,
  canBack,
  canForward,
  onBack,
  onForward,
  suppressHistoryControls = false,
  suppressSearchBar = false,
  query,
  isSearchLoading,
  sidebarExpanded,
  showSearchFilters,
  searchFilters,
  searchFiltersOpen,
  onToggleSearchFilters,
  onCloseSearchFilters,
  onChangeSearchFilters,
}: {
  onSearch: (query: string, forceRefresh?: boolean) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  suppressHistoryControls?: boolean;
  suppressSearchBar?: boolean;
  query: string;
  isSearchLoading?: boolean;
  sidebarExpanded: boolean;
  showSearchFilters: boolean;
  searchFilters: SearchFilters;
  searchFiltersOpen: boolean;
  onToggleSearchFilters: () => void;
  onCloseSearchFilters: () => void;
  onChangeSearchFilters: (filters: SearchFilters) => void;
}) {
  const [draft, setDraft] = useState(query);
  const timeoutRef = useRef<number | null>(null);
  const suggestionsTimeoutRef = useRef<number | null>(null);
  const suggestionsRequestRef = useRef(0);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [hoveringTopArea, setHoveringTopArea] = useState(false);
  const sensorLeaveTimeoutRef = useRef<number | null>(null);
  const topbarSensorRef = useRef<HTMLDivElement | null>(null);
  const windowControlsRef = useRef<HTMLDivElement | null>(null);
  const hasQueryText = draft.trim().length > 0;
  const historyCanBack = suppressHistoryControls ? false : canBack;
  const historyCanForward = suppressHistoryControls ? false : canForward;
  const runSearch = useEffectEvent((nextQuery: string) => {
    onSearch(nextQuery);
  });
  const activeFilterCount = getActiveFilterCount(searchFilters);
  // The search group (input + filter + history nav) hides when no query text,
  // no input focus, no filter panel open, and the user isn't hovering the
  // top trigger zone. When the device has no real pointer (touch / pen-less)
  // we keep it always revealed so the bar is reachable without hover.
  const [hasHoverCapability, setHasHoverCapability] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setHasHoverCapability(mql.matches);
    sync();
    const listener = (event: MediaQueryListEvent) => {
      setHasHoverCapability(event.matches);
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    }
    mql.addListener(listener);
    return () => mql.removeListener(listener);
  }, []);
  // useSetting (not getSetting) so flipping the toggle in the settings
  // page re-renders TopBar and updates the search-bar visibility state
  // immediately. With getSetting the snapshot was only re-read on
  // parent-driven re-renders, so toggling had no live effect.
  const alwaysShowSearch = useSetting("alwaysShowSearch");
  const searchSuggestionsEnabled = useSetting("searchSuggestions");
  const topSuggestionText = suggestions[0]?.text ?? null;
  const inlineSuggestionSuffix = useMemo(() => {
    if (!searchSuggestionsEnabled || !searchFocused || !topSuggestionText) return null;
    return getInlineSuggestionSuffix(draft, topSuggestionText);
  }, [draft, searchFocused, searchSuggestionsEnabled, topSuggestionText]);
  const topbarInteractive = suppressSearchBar
    ? false
    : alwaysShowSearch
      ? true
      : hasHoverCapability
        ? Boolean(hasQueryText || searchFocused || searchFiltersOpen || hoveringTopArea)
        : true;

  const handleSensorEnter = () => {
    if (sensorLeaveTimeoutRef.current !== null) {
      window.clearTimeout(sensorLeaveTimeoutRef.current);
      sensorLeaveTimeoutRef.current = null;
    }
    setHoveringTopArea(true);
  };

  const handleSensorLeave = () => {
    if (sensorLeaveTimeoutRef.current !== null) {
      window.clearTimeout(sensorLeaveTimeoutRef.current);
    }
    // Short grace before hiding so a mouse that briefly drifts off the
    // topbar mid-scan doesn't dismiss the bar. Longer than the fade-in so
    // the bar can settle on screen before fade-out starts; kept tight
    // enough that a deliberate move away still feels responsive.
    sensorLeaveTimeoutRef.current = window.setTimeout(() => {
      setHoveringTopArea(false);
      sensorLeaveTimeoutRef.current = null;
    }, 320);
  };

  // The window controls (minimize / maximize / close) are descendants of
  // the sensor (so React keeps the sensor's rectangular bounding box
  // intact), but their hover state must NOT reveal the search bar —
  // otherwise the bar pops up directly under the cursor as the user
  // reaches for the close button, which is jarring and can occlude the
  // controls. These handlers override `hoveringTopArea` specifically for
  // the controls:
  //
  //   * Entering the controls clears any pending leave-grace and forces
  //     hoveringTopArea to false immediately.
  //   * Leaving the controls clears any pending leave-grace but does NOT
  //     restore hoveringTopArea — the search bar should stay hidden when
  //     moving off the controls. The parent's leave handler (with its
  //     320 ms grace) takes over for the final hide.
  //
  // See the hover-detection comment block on the sensor div in the JSX
  // below for the broader picture.
  const handleWindowControlsEnter = () => {
    if (sensorLeaveTimeoutRef.current !== null) {
      window.clearTimeout(sensorLeaveTimeoutRef.current);
      sensorLeaveTimeoutRef.current = null;
    }
    setHoveringTopArea(false);
  };

  const handleWindowControlsLeave = () => {
    if (sensorLeaveTimeoutRef.current !== null) {
      window.clearTimeout(sensorLeaveTimeoutRef.current);
      sensorLeaveTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    const ref = sensorLeaveTimeoutRef;
    return () => {
      if (ref.current !== null) {
        window.clearTimeout(ref.current);
        ref.current = null;
      }
    };
  }, []);

  // When the cursor exits the browser window while hovering the top
  // sensor zone, no mouseleave fires on the sensor div, so the search
  // bar gets stuck visible. Detect the exit and force it closed.
  useEffect(() => {
    if (!hasHoverCapability) return;

    const handleWindowExit = (e: MouseEvent) => {
      if (e.relatedTarget !== null) return;
      if (sensorLeaveTimeoutRef.current !== null) {
        window.clearTimeout(sensorLeaveTimeoutRef.current);
        sensorLeaveTimeoutRef.current = null;
      }
      setHoveringTopArea(false);
    };

    document.addEventListener("mouseout", handleWindowExit);
    return () => document.removeEventListener("mouseout", handleWindowExit);
  }, [hasHoverCapability]);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      if (draft.trim()) runSearch(draft.trim());
    }, 250);
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [draft]);

  useEffect(() => {
    if (!searchSuggestionsEnabled || !searchFocused) {
      setSuggestions([]);
      return;
    }

    const clean = draft.trim();
    if (!clean) {
      setSuggestions([]);
      return;
    }

    setSuggestions([]);

    if (suggestionsTimeoutRef.current !== null) {
      window.clearTimeout(suggestionsTimeoutRef.current);
    }

    const requestId = suggestionsRequestRef.current + 1;
    suggestionsRequestRef.current = requestId;

    suggestionsTimeoutRef.current = window.setTimeout(() => {
      void fetchSearchSuggestions(clean)
        .then((next) => {
          if (suggestionsRequestRef.current !== requestId) return;
          setSuggestions(next);
        })
        .catch(() => {
          if (suggestionsRequestRef.current !== requestId) return;
          setSuggestions([]);
        });
    }, 200);

    return () => {
      if (suggestionsTimeoutRef.current !== null) {
        window.clearTimeout(suggestionsTimeoutRef.current);
        suggestionsTimeoutRef.current = null;
      }
    };
  }, [draft, searchFocused, searchSuggestionsEnabled]);

  useEffect(() => {
    if (!searchFiltersOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!filterPanelRef.current?.contains(event.target as Node)) {
        onCloseSearchFilters();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseSearchFilters();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCloseSearchFilters, searchFiltersOpen]);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!value.trim()) {
      setSuggestions([]);
      // Clearing the field should jump straight back to the empty search page.
      onSearch("");
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && inlineSuggestionSuffix && topSuggestionText) {
      event.preventDefault();
      setDraft(topSuggestionText);
      setSuggestions([]);
      suggestionsRequestRef.current += 1;
      requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (!input) return;
        const end = topSuggestionText.length;
        input.setSelectionRange(end, end);
      });
      return;
    }

    if (event.key === "Escape" && inlineSuggestionSuffix) {
      event.preventDefault();
      setSuggestions([]);
      suggestionsRequestRef.current += 1;
      return;
    }

    if (event.key === "Enter") {
      event.currentTarget.blur();
      const clean = draft.trim();
      if (!clean) return;
      event.preventDefault();
      const sameQuery = clean === query.trim();
      if (sameQuery && isSearchLoading) return;
      onSearch(clean, !sameQuery);
    }
  };

  const handleDrag = () => {
    getCurrentWindow().startDragging();
  };

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex">
      <div
        ref={topbarSensorRef}
        className="relative flex min-h-[var(--ui-topbar-height)] flex-1 items-center justify-center px-[clamp(0.75rem,1.8vw,1.5rem)] py-3"
        onMouseEnter={handleSensorEnter}
        onMouseLeave={handleSensorLeave}
      >
        {/* Hover detection is hoisted to this inner container so React treats
            movement between the drag region and the search group as one
            continuous hover. With the listeners on a dedicated sensor
            element, `mouseleave` would fire spuriously the moment the cursor
            moved from the sensor onto a sibling that was stacked on top of
            it — most importantly the now-visible search group — so the bar
            would hide itself a moment after it appeared. Listening on this
            parent keeps `hovering = true` for the entire time the cursor
            stays anywhere inside this subtree, and only flips `false` when
            the cursor leaves it (which is exactly when we want the bar to
            fade out).

            The window controls (minimize / maximize / close) live INSIDE
            this sensor subtree so they don't break its rectangular
            bounding box — but arriving on them is NOT supposed to reveal
            the search bar (it would pop up directly underneath the cursor
            as the user reaches for the close button, occluding it). The
            override `onMouseEnter` / `onMouseLeave` on
            `.topbar-window-controls` below force `hoveringTopArea` to
            `false` while the cursor is on the controls so the bar stays
            hidden. The 320 ms grace timeout still applies for every
            leave path. */}
        <div
          aria-hidden="true"
          className="topbar-drag-region pointer-events-auto absolute inset-x-0 top-0 h-[var(--ui-topbar-height)]"
          onMouseDown={handleDrag}
        />
        {/* Width-only probe: reports the search group's natural width and the
            flex row's centered "rest" position without ever being shifted by
            the discography layout. The layout solver reads this instead of the
            shifted search element to avoid a position feedback loop. */}
        <div className="topbar-search-natural-probe-frame">
          <div className="topbar-search-natural-probe" />
        </div>
        {/* `.topbar-search-group` is a pure layout container — it owns NO
            animation properties. Only its class flips between
            `topbar-is-visible` and `topbar-is-hidden`. The actual
            show/hide animation lives on its backdrop-blurred children
            (the input / filter button / history pill) so their own
            `backdrop-blur-md` renders correctly throughout the transition
            instead of being trapped by an ancestor's transform, opacity,
            filter, or non-zero translate (see the Search-bar hide/show
            comment block in index.css for the full rationale). We use
            `topbar-is-visible` / `topbar-is-hidden` (rather than the
            plain `.is-visible`/`.is-hidden` already used in `ArtistPage`)
            so there's no class-name collision. */}
        <div
          className={clsx(
            "topbar-search-group pointer-events-auto relative min-w-0",
            topbarInteractive ? "topbar-is-visible" : "topbar-is-hidden",
          )}
          style={{
            "--topbar-sidebar-shift": sidebarExpanded ? "0.5rem" : "0px",
          } as CSSProperties}
        >
          <div
            className={clsx(
              "topbar-history-controls absolute right-full top-1/2 mr-2 hidden h-11 shrink-0 items-center rounded-full border border-white/10 bg-white/5 backdrop-blur-md overflow-hidden transition-all duration-100 ease-out sm:flex",
              suppressHistoryControls && "invisible pointer-events-none !max-w-0 !border-transparent !opacity-0 !transition-none",
              !historyCanBack && !historyCanForward && "max-w-0 opacity-0 border-transparent",
              (historyCanBack || historyCanForward) && !(historyCanBack && historyCanForward) && "max-w-[48px]",
              historyCanBack && historyCanForward && "max-w-[83px]",
            )}
            aria-hidden={suppressHistoryControls || (!historyCanBack && !historyCanForward)}
          >
            <div
              className={clsx(
                "overflow-hidden transition-[max-width,opacity] duration-100 ease-out",
                historyCanBack ? (historyCanBack && !historyCanForward ? "max-w-11 opacity-100" : "max-w-10 opacity-100") : "max-w-0 opacity-0",
              )}
            >
              <button
                type="button"
                onClick={onBack}
                disabled={!historyCanBack}
                aria-label="Back"
                className={clsx(
                  "flex h-11 items-center justify-center transition enabled:hover:bg-white/10 enabled:hover:text-white",
                  hasQueryText ? "text-white" : "text-neutral-500",
                  "disabled:text-neutral-500",
                  historyCanBack && !historyCanForward ? "w-11 rounded-full" : "w-10",
                )}
                tabIndex={suppressHistoryControls ? -1 : undefined}
              >
                <IconChevronLeft size={18} />
              </button>
            </div>
            <div
              className={clsx(
                "h-6 bg-white/10 transition-[width,opacity] duration-100 ease-out",
                historyCanBack && historyCanForward ? "w-px opacity-100" : "w-0 opacity-0",
              )}
            />
            <div
              className={clsx(
                "overflow-hidden transition-[max-width,opacity] duration-100 ease-out",
                historyCanForward ? (!historyCanBack && historyCanForward ? "max-w-11 opacity-100" : "max-w-10 opacity-100") : "max-w-0 opacity-0",
              )}
            >
              <button
                type="button"
                onClick={onForward}
                disabled={!historyCanForward}
                aria-label="Forward"
                className={clsx(
                  "flex h-11 items-center justify-center transition enabled:hover:bg-white/10 enabled:hover:text-white",
                  hasQueryText ? "text-white" : "text-neutral-500",
                  "disabled:text-neutral-500",
                  !historyCanBack && historyCanForward ? "w-11 rounded-full" : "w-10",
                )}
                tabIndex={suppressHistoryControls ? -1 : undefined}
              >
                <IconChevronRight size={18} />
              </button>
            </div>
          </div>            <div className="flex h-full min-w-0 items-center">
             <div className="topbar-search-input-wrapper relative h-full min-w-0 flex-1">
               <input
                ref={searchInputRef}
                type="text"
                value={draft}
                onChange={(event) => handleDraftChange(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={handleKeyDown}
                placeholder="Search artists, songs, albums"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                aria-autocomplete="inline"
                className="topbar-search-element peer relative z-[2] h-full min-h-[var(--ui-control)] max-h-[var(--ui-control)] w-full rounded-full border border-white/10 bg-white/5 pl-11 pr-10 text-[0.95rem] text-white placeholder-neutral-500 outline-none backdrop-blur-md transition-colors hover:border-white/15 hover:bg-white/10 focus:border-white/15 focus:bg-white/10"
              />
              {inlineSuggestionSuffix && (
                <div
                  aria-hidden="true"
                  className="topbar-search-element pointer-events-none absolute inset-0 z-[3] flex items-center overflow-hidden rounded-full pl-11 pr-10 text-[0.95rem]"
                >
                  <span className="min-w-0 truncate whitespace-pre">
                    <span className="invisible">{draft}</span>
                    <span className="text-white/35">{inlineSuggestionSuffix}</span>
                  </span>
                </div>
              )}
              <div className="topbar-search-icon pointer-events-none absolute inset-y-0 left-4 z-10 flex items-center text-white peer-placeholder-shown:text-neutral-500">
                <IconSearch size={18} />
              </div>
              {draft && (
                <div className="topbar-search-element absolute inset-y-0 right-3 z-10 flex items-center">
                  <button
                    type="button"
                    onClick={() => handleDraftChange("")}
                    aria-label="Clear search"
                    className="relative flex h-6 w-6 items-center justify-center rounded-full border border-transparent bg-neutral-900/90 text-white/85 shadow-[0_4px_14px_rgba(0,0,0,0.35)] transition hover:bg-neutral-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
                  >
                    <IconX size={14} />
                  </button>
                </div>              )}
            </div>

            <div
              ref={filterPanelRef}
              className={clsx(
                "relative shrink-0 overflow-visible transition-all duration-100 ease-out",
                showSearchFilters ? "ml-2 max-w-11 opacity-100" : "pointer-events-none ml-0 max-w-0 opacity-0"
              )}
              aria-hidden={!showSearchFilters}
            >
              <button
                type="button"
                onClick={onToggleSearchFilters}
                tabIndex={showSearchFilters ? 0 : -1}
                className={clsx(
                  "topbar-search-element relative flex h-[var(--ui-control)] w-[var(--ui-control)] items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-300 backdrop-blur-md transition-all duration-100 ease-out hover:border-white/15 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                  showSearchFilters ? "scale-100" : "scale-95",
                  (searchFiltersOpen || activeFilterCount > 0) && "border-white/15 bg-white/10 text-white",
                )}
                aria-label="Search filters"
                aria-expanded={searchFiltersOpen}
              >
                <SlidersHorizontal size={17} />
                {activeFilterCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold text-black ring-2 ring-black">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {searchFiltersOpen && (
                <SearchFilterPanel
                  filters={searchFilters}
                  onChange={onChangeSearchFilters}
                  onClear={() => onChangeSearchFilters(DEFAULT_SEARCH_FILTERS)}
                />
              )}
            </div>
          </div>
        </div>
        <div
          ref={windowControlsRef}
          onMouseEnter={handleWindowControlsEnter}
          onMouseLeave={handleWindowControlsLeave}
          className="topbar-window-controls pointer-events-auto absolute right-0 z-50 flex items-center pr-3"
        >
          <button
            type="button"
            onClick={() => getCurrentWindow().minimize()}
            aria-label="Minimize"
            className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
          >
            <IconMinus size={16} />
          </button>
          <button
            type="button"
            onClick={() => getCurrentWindow().toggleMaximize()}
            aria-label="Maximize"
            className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
          >
            <IconMaximize size={14} />
          </button>
          <button
            type="button"
            onClick={() => getCurrentWindow().close()}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-500 hover:text-white"
          >
            <IconX size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export const PageHistoryControls = forwardRef<HTMLDivElement, {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  buttonTextClassName?: string;
  className?: string;
  style?: CSSProperties;
  animated?: boolean;
}>(function PageHistoryControls(
  {
    canBack,
    canForward,
    onBack,
    onForward,
    buttonTextClassName = "text-neutral-500",
    className = "",
    style,
    animated = true,
  },
  ref,
) {
  const hasBack = canBack;
  const hasForward = canForward;
  const hasAny = hasBack || hasForward;
  const hasBoth = hasBack && hasForward;
  const hasSingle = hasAny && !hasBoth;

  return (
    <div
      ref={ref}
      className={clsx(
        "flex h-11 items-center overflow-hidden rounded-full border border-white/10 bg-white/5 backdrop-blur-md",
        animated && "transition-all duration-100 ease-out",
        !hasAny && "max-w-0 border-transparent opacity-0",
        hasBoth && "w-[84px] max-w-[84px]",
        hasSingle && "w-11 max-w-11",
        className,
      )}
      style={style}
      aria-hidden={!hasAny}
    >
      <div className="flex h-full w-full items-center overflow-hidden">
        <div
          className={clsx(
            "overflow-hidden",
            animated && "transition-all duration-100 ease-out",
            hasBack
              ? hasSingle
                ? "w-full max-w-full opacity-100"
                : "w-[calc((100%-1px)/2)] max-w-[calc((100%-1px)/2)] opacity-100"
              : "max-w-0 opacity-0",
          )}
        >
          <button
            type="button"
            onClick={onBack}
            disabled={!hasBack}
            aria-label="Back"
            className={clsx(
              "flex h-11 items-center justify-center transition enabled:hover:bg-white/10 enabled:hover:text-white",
              buttonTextClassName,
              "disabled:text-neutral-500",
              hasSingle ? "w-full rounded-full" : "w-full",
            )}
          >
            <IconChevronLeft size={18} />
          </button>
        </div>
        <div
          className={clsx(
            "h-6 bg-white/10",
            animated && "transition-all duration-100 ease-out",
            hasBack && hasForward ? "w-px opacity-100" : "w-0 opacity-0",
          )}
        />
        <div
          className={clsx(
            "overflow-hidden",
            animated && "transition-all duration-100 ease-out",
            hasForward
              ? hasSingle
                ? "w-full max-w-full opacity-100"
                : "w-[calc((100%-1px)/2)] max-w-[calc((100%-1px)/2)] opacity-100"
              : "max-w-0 opacity-0",
          )}
        >
          <button
            type="button"
            onClick={onForward}
            disabled={!hasForward}
            aria-label="Forward"
            className={clsx(
              "flex h-11 items-center justify-center transition enabled:hover:bg-white/10 enabled:hover:text-white",
              buttonTextClassName,
              "disabled:text-neutral-500",
              hasSingle ? "w-full rounded-full" : "w-full",
            )}
          >
            <IconChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});
