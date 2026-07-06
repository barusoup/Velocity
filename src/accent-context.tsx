import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cacheArtwork } from "./api";
import { usePlayerCover } from "./hooks/usePlayerSelectors";
import {
  extractInterestingArtworkColor,
  peekArtworkAccent,
  type RgbColor,
} from "./utils/artwork-color";

const DEFAULT_ACCENT: RgbColor = { r: 80, g: 80, b: 80 };

type AccentContextValue = {
  accent: RgbColor;
};

const AccentContext = createContext<AccentContextValue>({ accent: DEFAULT_ACCENT });

export function AccentProvider({ children }: { children: ReactNode }) {
  const cover = usePlayerCover();
  const [accent, setAccent] = useState<RgbColor>(() => peekArtworkAccent(cover) ?? DEFAULT_ACCENT);

  useEffect(() => {
    let cancelled = false;

    const peeked = peekArtworkAccent(cover);
    if (peeked) {
      setAccent(peeked);
    } else {
      setAccent(DEFAULT_ACCENT);
    }

    if (!cover) return;

    const source = cover.startsWith("//") ? `https:${cover}` : cover;

    if (!source.startsWith("asset://") && !source.startsWith("blob:")) {
      // Wrap in async IIFE so the cancellation check is checked between
      // every async step. The previous Promise-chain version would let
      // `setAccent` fire if `cacheArtwork` resolved after `cancelled`
      // was set but before the next `.then` ran.
      void (async () => {
        try {
          const filePath = await cacheArtwork(source);
          if (cancelled) return;
          const color = await extractInterestingArtworkColor(convertFileSrc(filePath));
          if (cancelled) return;
          if (color) setAccent(color);
        } catch {
          if (!cancelled) setAccent(DEFAULT_ACCENT);
        }
      })();
    } else {
      extractInterestingArtworkColor(source)
        .then((color) => {
          if (!cancelled) setAccent(color);
        })
        .catch(() => {
          if (!cancelled) setAccent(DEFAULT_ACCENT);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [cover]);

  return (
    <AccentContext.Provider value={{ accent }}>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): RgbColor {
  return useContext(AccentContext).accent;
}

export function getAccentForCover(cover?: string | null): RgbColor {
  return peekArtworkAccent(cover) ?? DEFAULT_ACCENT;
}
