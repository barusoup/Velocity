

export const ALBUM_TRACK_GRID =
  "grid-cols-[2.25rem_minmax(0,1fr)_3.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_4.5rem]";

export const ALBUM_TRACK_GRID_WITH_PLAYS =
  "grid-cols-[2.25rem_minmax(0,1fr)_minmax(5rem,8rem)_3.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(6rem,10rem)_4.5rem]";

export const RELEASE_TRACK_GRID =
  "grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,9rem)_3.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(7.5rem,12rem)_4.5rem]";

export const POPULAR_TRACK_GRID =
  "grid-cols-[2.75rem_minmax(0,1fr)_minmax(5.5rem,9rem)_3.75rem] sm:grid-cols-[2.75rem_minmax(0,1fr)_minmax(7.5rem,12rem)_4.5rem]";

export const COMPACT_TRACK_GRID =
  "grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,9rem)_3.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(7.5rem,12rem)_4.5rem]";

export const PLAYLIST_TRACK_GRID =
  "grid-cols-[2.25rem_minmax(0,1fr)_minmax(5rem,18rem)_minmax(6rem,8rem)_3.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(6rem,22rem)_minmax(7rem,9.5rem)_4.5rem]";

export function TrackListHeader({
  showPlays = false,
  showArtist = false,
  showAlbum = false,
  showDateAdded = false,
  dividerHidden = false,
  gridClassName,
}: {
  showPlays?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showDateAdded?: boolean;
  dividerHidden?: boolean;
  gridClassName?: string;
}) {
  return (
    <div
      className={`grid ${
        gridClassName ??
        (showArtist
          ? COMPACT_TRACK_GRID
          : showPlays
            ? ALBUM_TRACK_GRID_WITH_PLAYS
            : showAlbum || showDateAdded
              ? PLAYLIST_TRACK_GRID
              : ALBUM_TRACK_GRID)
      } gap-3 border-b px-4 py-2.5 text-sm text-white/58 transition-colors duration-150 ${
        dividerHidden ? "border-transparent" : "border-white/10"
      }`}
    >
      <span className="text-center">#</span>
      <span>Title</span>
      {showAlbum && <span className="text-left">Album</span>}
      {showArtist && <span className="text-center">Artist</span>}
      {showPlays && <span className="text-center">Plays</span>}
      {showDateAdded && <span className="text-left">Date Added</span>}
      <span className="flex items-center justify-end pr-[0.4rem]">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 8.3v4.2" /></svg>
      </span>
    </div>
  );
}
