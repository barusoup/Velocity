import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

/**
 * Player transport store.
 *
 * Carves the lowest-risk slice of `player.tsx`'s state out into an
 * external Zustand store so the audio graph's gain-node reads and the
 * UI's volume slider reads can both subscribe without each triggering
 * the other. Today:
 *
 *   * `player.tsx` keeps `volume` AND `muted` AND `normGain` as
 *     `useState` + mirror `useRef` + 3 mirror `useEffect`s so the
 *     `setLiveVolume` (slider onChange) and `applyOutputLevels`
 *     (effect-driven gain) closures can read the latest value without
 *     closure staleness.
 *
 *   * The first slice we migrate is the transport layer: read/write
 *     through `usePlayerTransportStore` selectors. The store is fully
 *     external — it survives the React tree being torn down between
 *     tests and it gives us a single source of truth that the audio
 *     graph can subscribe to via `subscribeWithSelector` without
 *     forcing a parent re-render.
 *
 * The Provider's transport `useState`s can be migrated to `useStore`
 * calls one-by-one (volume today, muted tomorrow, normGain next) with
 * no big-bang rewrite. Each migration deletes one useState + one
 * useRef + one useEffect and never breaks the public API the rest of
 * the app depends on.
 */
export interface PlayerTransportState {
  /** Effective volume scalar (0..1), pre-master. */
  volume: number;
  /** Mute toggle (uses 0 gain even when `volume > 0`). */
  muted: boolean;
  /**
   * Per-track loudness-normalization gain (linear). 1 when
   * normalization is disabled or the cached gain hasn't been derived
   * yet. Used as the post-norm scalar in the gain factor chain.
   */
  normGain: number;
}

export interface PlayerTransportActions {
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  setNormGain: (value: number) => void;
  toggleMuted: () => void;
  /**
   * Reset to defaults — used for the volume restore flow on app start
   * (treat `muted === true` or `volume === 0` as the "use the default"
   * case so the user doesn't get a silent boot).
   */
  resetTransport: (defaultVolume: number) => void;
}

export type PlayerTransportStore = PlayerTransportState & PlayerTransportActions;

export const DEFAULT_VOLUME = 0.8;

export const usePlayerTransportStore = create<PlayerTransportStore>()(
  subscribeWithSelector((set) => ({
    volume: DEFAULT_VOLUME,
    muted: false,
    normGain: 1,
    setVolume: (value) =>
      set((state) => ({
        volume: clampVolumeScalar(
          typeof value === "function"
            ? (value as (prev: number) => number)(state.volume)
            : value,
        ),
      })),
    setMuted: (value) =>
      set((state) => ({
        muted:
          typeof value === "function"
            ? Boolean((value as (prev: boolean) => boolean)(state.muted))
            : Boolean(value),
      })),
    setNormGain: (value) =>
      set((state) => ({
        normGain:
          typeof value === "function"
            ? normalizeNormGain((value as (prev: number) => number)(state.normGain))
            : normalizeNormGain(value),
      })),
    toggleMuted: () => set((state) => ({ muted: !state.muted })),
    resetTransport: (defaultVolume) =>
      set({
        volume: clampVolumeScalar(defaultVolume),
        muted: false,
        normGain: 1,
      }),
  })),
);

function clampVolumeScalar(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_VOLUME;
}

function normalizeNormGain(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * One-time subscribers can use `subscribe` directly without going
 * through the React layer — e.g. the audio graph's gain-node effect
 * subscribes to `volume`/`muted`/`normGain` once on mount and pushes
 * the latest values into its `apply`, avoiding the parent's mirror
 * `useEffect` and the closure-staleness window during rapid slide drags.
 */
export function subscribeTransport(
  listener: (state: PlayerTransportState) => void,
): () => void {
  return usePlayerTransportStore.subscribe(
    (state) => ({
      volume: state.volume,
      muted: state.muted,
      normGain: state.normGain,
    }),
    listener,
    {
      // Equality by field so the listener only fires when one of the
      // three transport values actually changes. Without `equalityFn`,
      // Zustand's default shallow equality would still fire on no-op
      // `set({})` calls.
      equalityFn: (a, b) =>
        a.volume === b.volume && a.muted === b.muted && a.normGain === b.normGain,
    },
  );
}
