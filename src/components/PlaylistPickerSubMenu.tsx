import { useEffect, useState } from "react";
import { NestedSubMenuPanel } from "./NestedSubMenuPanel";
import { ContextMenuItem, ContextMenuSection } from "./ContextMenu";

export type PlaylistPickerItem = {
  browseId: string;
  title: string;
  subtitle?: string | null;
  cover?: string | null;
};

type PlaylistPickerSubMenuProps = {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  onPick: (playlist: PlaylistPickerItem) => void;
  resolver: (query: string) => Promise<PlaylistPickerItem[]>;
  label?: string;
};

export function PlaylistPickerSubMenu({
  anchorRef,
  onClose,
  onPick,
  resolver,
  label = "Search playlists",
}: PlaylistPickerSubMenuProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaylistPickerItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void resolver(query)
      .then((list) => {
        if (cancelled) return;
        setResults(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResults([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, resolver]);

  return (
    <NestedSubMenuPanel anchorRef={anchorRef} onClose={onClose}>
      <ContextMenuSection label={label}>
        <div className="px-3 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a playlist name…"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/40 outline-none transition-colors focus:border-white/20 focus:bg-white/10"
          />
        </div>
      </ContextMenuSection>
      <div className="max-h-64 overflow-y-auto">
        {loading && results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-white/40">Searching…</div>
        ) : results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-white/40">No playlists yet. Create one from the sidebar.</div>
        ) : (
          results.map((playlist) => (
            <ContextMenuItem
              key={playlist.browseId + playlist.title}
              label={playlist.title}
              onClick={() => onPick(playlist)}
            />
          ))
        )}
      </div>
    </NestedSubMenuPanel>
  );
}
