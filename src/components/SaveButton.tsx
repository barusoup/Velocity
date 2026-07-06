import { memo, useEffect, useRef, useState } from "react";
import { Check, CirclePlus, LoaderCircle } from "lucide-react";
import { cn } from "../utils/cn";

// ---------------------------------------------------------------------------
// SaveButton — toggle between the lucide `CirclePlus` (not saved) and
// `Check` (saved). The saved state uses a green inner disc at the same
// visible size as the plus icon. Pairing the circle
// outline of CirclePlus with a bare Check (instead of CircleCheck, which
// would draw its own inner outline and read as a donut) keeps the saved
// state's interior clean — no nested rings.
//
// Sizes:
//   * "lg" — matches the existing CirclePlus button next to shuffle/play on
//            the Album header (~h-10 w-10). Hover turns the icon white.
//   * "md" — album rows on the full discography page (~h-8 w-8).
//   * "sm" — compact pill for track rows / queue rows / player bar (~h-7 w-7).
//
// The toggle uses a quick Spotify-like pop: the green disc blooms in, the
// check settles into place, and a tiny sparkle burst fades out.
// ---------------------------------------------------------------------------

type SaveButtonSize = "lg" | "md" | "sm";

export type SaveButtonProps = {
  isSaved: boolean;
  isLoading?: boolean;
  ariaLabel?: string;
  size?: SaveButtonSize;
  className?: string;
  onToggle: (nextSaved: boolean) => void;
};

export const SaveButton = memo(function SaveButton({
  isSaved,
  isLoading = false,
  ariaLabel,
  size = "lg",
  className,
  onToggle,
}: SaveButtonProps) {
  // The entrance pop should play ONLY on a user-clicked unsaved → saved
  // transition. It must NOT play on:
  //   - the very first render (e.g. an item already in the collection)
  //   - any parent re-render that keeps the saved branch alive
  //   - an external sync that flips isSaved false → true without a click
  // We gate the animation on a transient `isFlashing` flag, set inside
  // `handleClick` and cleared once the longest sub-animation (the 460ms
  // burst) has had time to finish. Because the saved subtree is
  // conditionally rendered, every unsaved → saved transition mounts a
  // fresh `<span>` with the `.is-flashing` class applied to its base
  // classes — the CSS `animation` property triggers naturally on that
  // fresh DOM node, so a rapid toggle → resave replays the pop without
  // any key-bump gymnastics.
  const [isFlashing, setIsFlashing] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  const handleClick = () => {
    if (isLoading) return;
    if (!isSaved) {
      // Cancel any in-flight flash so a rapid toggle → resave starts a
      // fresh window instead of inheriting a stale timer.
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
      }
      setIsFlashing(true);
      flashTimerRef.current = setTimeout(() => {
        setIsFlashing(false);
        flashTimerRef.current = null;
      }, 460);
    }
    onToggle(!isSaved);
  };

  // The button keeps a stable hit area, while the visible icon/disc stays
  // pixel-matched between states. The plus icon draws its own circle; the
  // saved state gets a green inner disc at that same box size.
  const dimensions =
    size === "lg" ? "h-10 w-10" : size === "md" ? "h-8 w-8" : "h-7 w-7";
  const iconDiscDimensions =
    size === "lg" ? "h-7 w-7" : size === "md" ? "h-[22px] w-[22px]" : "h-4 w-4";
  const savedIconDimensions =
    size === "lg" ? "h-[18px] w-[18px]" : size === "md" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";

  // One glyph per state. The saved check is intentionally smaller than the
  // disc around it, matching Spotify's compact black tick inside the green
  // circle instead of letting the diagonal stroke fill the whole button.
  const Icon = isSaved ? Check : CirclePlus;
  const strokeWidth = 2.4;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={isSaved}
      aria-label={ariaLabel ?? (isSaved ? "Remove from collection" : "Save to collection")}
      data-saved={isSaved ? "true" : "false"}
      className={cn(
        "collection-save-button group relative flex shrink-0 items-center justify-center rounded-full animate-none",
        dimensions,
        !isSaved && "text-white/60 transition-colors hover:text-white",
        isSaved && "text-black",
        isLoading && "cursor-default opacity-80",
        className,
      )}
    >
      {isSaved ? (
        <span
          aria-hidden
          data-size={size}
          className={cn(
            "collection-save-disc flex items-center justify-center rounded-full bg-[#1bd760] transition-colors group-hover:bg-[#20e57a]",
            iconDiscDimensions,
          )}
        >
          <span className={cn("collection-save-burst", isFlashing && "is-flashing")} />
          <Icon
            className={cn("collection-save-check", savedIconDimensions, isFlashing && "is-flashing")}
            strokeWidth={strokeWidth}
          />
        </span>
      ) : (
        <Icon className={iconDiscDimensions} strokeWidth={strokeWidth} aria-hidden />
      )}
      {isLoading && (
        <span className="absolute inset-0 flex items-center justify-center text-white">
          <LoaderCircle
            className="animate-spin"
            size={size === "lg" ? 24 : size === "md" ? 18 : 14}
          />
        </span>
      )}
    </button>
  );
});

// Convenience: render an "unsaved / saved" pill (no animation) for spot UI
// (e.g. inside a context menu label) where we don't have a click handler but
// still want the green-check glyph to look identical. The stroke weight
// mirrors the main SaveButton (2.4) so the spot-UI badge reads as the same
// icon family rather than a thinner glyph that visually drifts.
export function SavedIconBadge({ isSaved }: { isSaved: boolean }) {
  return isSaved ? (
    <Check className="text-[#1bd760]" size={16} strokeWidth={2.4} />
  ) : (
    <CirclePlus size={16} strokeWidth={2.4} className="text-white/72" />
  );
}
