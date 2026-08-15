import { memo, type ReactNode } from "react";
import { VirtualList } from "./VirtualList";
import {
  ALBUM_TRACK_GRID,
  ALBUM_TRACK_GRID_WITH_PLAYS,
  COLLECTION_TRACK_GRID,
  COMPACT_TRACK_GRID,
  PLAYLIST_TRACK_GRID,
  TrackListHeader,
} from "./TrackList";
import type { MediaTrack } from "../types";

type TrackListVariant = "album" | "albumWithPlays" | "compact" | "playlist" | "collection" | "queue" | "search";

function gridForVariant(variant: TrackListVariant, custom?: string): string {
  if (custom) return custom;
  switch (variant) {
    case "album":
      return ALBUM_TRACK_GRID;
    case "albumWithPlays":
      return ALBUM_TRACK_GRID_WITH_PLAYS;
    case "compact":
      return COMPACT_TRACK_GRID;
    case "playlist":
      return PLAYLIST_TRACK_GRID;
    case "collection":
      return COLLECTION_TRACK_GRID;
    case "queue":
      return COMPACT_TRACK_GRID;
    case "search":
      return ALBUM_TRACK_GRID;
    default:
      return ALBUM_TRACK_GRID;
  }
}

type UnifiedTrackListProps = {
  tracks: MediaTrack[];
  variant?: TrackListVariant;
  gridClassName?: string;
  estimateSize?: number;
  renderTrack: (track: MediaTrack, index: number) => ReactNode;
  getItemKey?: (track: MediaTrack, index: number) => string | number;
  headerProps?: {
    showPlays?: boolean;
    showArtist?: boolean;
    showAlbum?: boolean;
    showDateAdded?: boolean;
    dividerHidden?: boolean;
  };
  showHeader?: boolean;
  overscan?: number;
  className?: string;
  enabled?: boolean;
  emptyState?: ReactNode;
};

export const UnifiedTrackList = memo(function UnifiedTrackList({
  tracks,
  variant = "album",
  gridClassName,
  estimateSize = 68,
  renderTrack,
  getItemKey,
  headerProps,
  showHeader = true,
  overscan = 10,
  className,
  enabled = true,
  emptyState,
}: UnifiedTrackListProps) {
  if (tracks.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const grid = gridForVariant(variant, gridClassName);

  return (
    <div className={className}>
      {showHeader && (
        <TrackListHeader
          gridClassName={grid}
          showPlays={headerProps?.showPlays}
          showArtist={headerProps?.showArtist}
          showAlbum={headerProps?.showAlbum}
          showDateAdded={headerProps?.showDateAdded}
          dividerHidden={headerProps?.dividerHidden}
        />
      )}
      <VirtualList
        items={tracks}
        estimateSize={estimateSize}
        renderItem={renderTrack}
        getItemKey={getItemKey ?? ((track) => track.id)}
        overscan={overscan}
        enabled={enabled}
      />
    </div>
  );
});

export { ALBUM_TRACK_GRID, PLAYLIST_TRACK_GRID, COLLECTION_TRACK_GRID };
export type { TrackListVariant };
