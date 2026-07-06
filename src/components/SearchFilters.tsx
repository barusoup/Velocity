import { Check } from "lucide-react";

export type SearchResultType = "artist" | "album" | "song";
export type SearchSort = "default" | "releaseDate";

export type SearchFilters = {
  types: SearchResultType[];
  sortBy: SearchSort;
};

const SEARCH_RESULT_TYPES: Array<{ value: SearchResultType; label: string }> = [
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "song", label: "Song" },
];

const SEARCH_SORTS: Array<{ value: SearchSort; label: string; hint: string }> = [
  { value: "default", label: "Normal", hint: "Original result order" },
  { value: "releaseDate", label: "Release date", hint: "Newest first when dates are available" },
];

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  types: SEARCH_RESULT_TYPES.map((type) => type.value),
  sortBy: "default",
};

export function getActiveFilterCount(filters: SearchFilters): number {
  let count = 0;
  if (filters.types.length !== DEFAULT_SEARCH_FILTERS.types.length) count += 1;
  if (filters.sortBy !== DEFAULT_SEARCH_FILTERS.sortBy) count += 1;
  return count;
}

export function SearchFilterPanel({
  filters,
  onChange,
  onClear,
}: {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  onClear: () => void;
}) {
  return (
    <div className="artist-menu-pop absolute right-[calc(-0.5*(14.75rem-var(--ui-control)))] top-[calc(var(--ui-control)+4px)] z-30 w-[14.75rem] overflow-hidden rounded-[4px] border border-white/10 bg-black shadow-[0_18px_48px_rgba(0,0,0,0.48)]">
      <div className="px-4 pb-3 pt-2 text-xs font-semibold text-white/58">Show</div>
      <div className="flex items-center gap-1.5 px-4 pb-3">
        {SEARCH_RESULT_TYPES.map((type) => {
          const selected = filters.types.includes(type.value);
          return (
            <button
              key={type.value}
              type="button"
              onClick={() => {
                const nextTypes = selected
                  ? filters.types.filter((value) => value !== type.value)
                  : [...filters.types, type.value];
                onChange({ ...filters, types: nextTypes });
              }}
              className={`h-8 rounded-full px-3 text-sm font-semibold transition-colors duration-200 animate-none ${
                selected
                  ? "bg-white text-black"
                  : "text-white hover:text-white/80"
              }`}
            >
              {type.label}
            </button>
          );
        })}
      </div>

      <div className="h-px bg-white/8" />

      <div className="px-4 pb-1 pt-2 text-xs font-semibold text-white/58">Sort by</div>
      {SEARCH_SORTS.map((sort) => (
        <button
          key={sort.value}
          type="button"
          onClick={() => onChange({ ...filters, sortBy: sort.value })}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-white/8 animate-none ${
            filters.sortBy === sort.value ? "text-white" : "text-white/72"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{sort.label}</span>
          {filters.sortBy === sort.value && <Check size={16} />}
        </button>
      ))}

      <div className="h-px bg-white/8" />

      <button
        type="button"
        onClick={onClear}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-semibold text-white/72 transition hover:bg-white/8 hover:text-white animate-none"
      >
        Clear all
      </button>
    </div>
  );
}
