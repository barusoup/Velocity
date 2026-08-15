import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { View } from "../components/Sidebar";

export type HistoryEntry = { view: View; scrollTop: number };
export type HistoryState = { entries: HistoryEntry[]; index: number };

function viewsEqual(left: View, right: View): boolean {
  if (left.name !== right.name) return false;
  switch (left.name) {
    case "collection":
      if (right.name !== "collection") return false;
      return left.tab === right.tab;
    case "home":
      return right.name === "home";
    case "search":
      return right.name === "search" && left.query === right.query;
    case "lyrics":
    case "settings":
      return true;
    case "album":
    case "artist":
    case "playlist":
      if (
        right.name !== left.name ||
        left.browseId !== right.browseId ||
        left.context !== right.context
      )
        return false;
      if (left.name === "artist") {
        const leftSec = (left as Extract<View, { name: "artist" }>).section ?? "overview";
        const rightSec = (right as Extract<View, { name: "artist" }>).section ?? "overview";
        return leftSec === rightSec;
      }
      return true;
    case "user-playlist":
      return right.name === "user-playlist" && left.id === right.id;
    case "user-playlists":
      return right.name === "user-playlists";
    default:
      return false;
  }
}

function pushHistoryEntry(
  current: HistoryState,
  nextView: View,
  scrollTop: number,
): HistoryState {
  const active = current.entries[current.index]?.view;
  if (active && viewsEqual(active, nextView)) return current;
  const entries = current.entries.slice(0, current.index + 1);
  entries.push({ view: nextView, scrollTop });
  return { entries, index: entries.length - 1 };
}

export function useHistoryStack(initialView: View, scrollContainerRef: RefObject<HTMLDivElement | null>) {
  const [historyState, setHistoryState] = useState<HistoryState>(() => ({
    entries: [{ view: initialView, scrollTop: 0 }],
    index: 0,
  }));
  const [transientView, setTransientView] = useState<View | null>(null);
  const transientViewRef = useRef<View | null>(null);
  const transientScrollTopRef = useRef(0);

  const committedView = historyState.entries[historyState.index].view;
  const view = transientView ?? committedView;
  const canBack = Boolean(transientView) || historyState.index > 0;
  const canForward = !transientView && historyState.index < historyState.entries.length - 1;

  const transitionView = useCallback(
    (updater: () => void) => {
      const currentScrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      if (transientView) {
        transientScrollTopRef.current = currentScrollTop;
      } else {
        setHistoryState((current) => {
          const active = current.entries[current.index];
          if (active.scrollTop === currentScrollTop) return current;
          const entries = current.entries.slice();
          entries[current.index] = { ...active, scrollTop: currentScrollTop };
          return { ...current, entries };
        });
      }
      updater();
    },
    [transientView, scrollContainerRef],
  );

  const navigate = useCallback(
    (nextView: View) => {
      transitionView(() => {
        if (nextView.name === "search") {
          if (viewsEqual(view, nextView)) return;
          transientViewRef.current = nextView;
          setTransientView(nextView);
          return;
        }
        setTransientView(null);
        setHistoryState((current) => {
          let intermediate = current;
          const pendingTransient = transientViewRef.current;
          if (pendingTransient) {
            const active = intermediate.entries[intermediate.index]?.view;
            if (!active || !viewsEqual(active, pendingTransient)) {
              intermediate = pushHistoryEntry(
                intermediate,
                pendingTransient,
                transientScrollTopRef.current,
              );
            }
            transientViewRef.current = null;
          }
          return pushHistoryEntry(intermediate, nextView, 0);
        });
      });
    },
    [transitionView, view],
  );

  const goBack = useCallback(() => {
    if (!canBack) return;
    transitionView(() => {
      if (transientView) {
        transientViewRef.current = null;
        setTransientView(null);
        return;
      }
      setHistoryState((current) => ({ ...current, index: current.index - 1 }));
    });
  }, [canBack, transitionView, transientView]);

  const goForward = useCallback(() => {
    if (!canForward) return;
    transitionView(() => setHistoryState((current) => ({ ...current, index: current.index + 1 })));
  }, [canForward, transitionView]);

  return {
    historyState,
    setHistoryState,
    transientView,
    setTransientView,
    transientViewRef,
    transientScrollTopRef,
    view,
    committedView,
    canBack,
    canForward,
    transitionView,
    navigate,
    goBack,
    goForward,
    viewsEqual,
    pushHistoryEntry,
  };
}
