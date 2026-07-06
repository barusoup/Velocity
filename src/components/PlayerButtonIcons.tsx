import type { ReactNode } from "react";
import {
  ListVideo,
  Repeat,
  Repeat1,
  Shuffle,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

type IconSlotProps = {
  active: boolean;
  children: ReactNode;
};

function IconSlot({ active, children }: IconSlotProps) {
  return (
    <span
      aria-hidden={!active}
      className={`absolute inset-0 grid place-items-center leading-none ${
        active ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
      }`}
    >
      {children}
    </span>
  );
}

export type RepeatMode = "off" | "all" | "one";

export function AnimatedShuffle({ active, size = 16 }: { active: boolean; size?: number }) {
  return (
    <span
      className="relative inline-grid place-items-center overflow-visible align-middle leading-none"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <IconSlot active={!active}>
        <Shuffle size={size} />
      </IconSlot>
      <IconSlot active={active}>
        <Shuffle size={size} />
      </IconSlot>
    </span>
  );
}

export function AnimatedRepeat({ mode, size = 16 }: { mode: RepeatMode; size?: number }) {
  return (
    <span
      className="relative inline-grid place-items-center overflow-visible align-middle leading-none"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <IconSlot active={mode === "off"}>
        <Repeat size={size} />
      </IconSlot>
      <IconSlot active={mode === "all"}>
        <Repeat size={size} />
      </IconSlot>
      <IconSlot active={mode === "one"}>
        <Repeat1 size={size} />
      </IconSlot>
    </span>
  );
}

type VolumeState = "muted" | "low" | "mid" | "high";

function getVolumeState(volume: number, muted: boolean): VolumeState {
  if (muted || volume <= 0) return "muted";
  if (volume < 0.4) return "low";
  if (volume < 0.75) return "mid";
  return "high";
}

export function AnimatedVolume({
  volume,
  muted,
  size = 18,
}: {
  volume: number;
  muted: boolean;
  size?: number;
}) {
  const state = getVolumeState(volume, muted);

  return (
    <span
      className="relative inline-grid place-items-center overflow-visible align-middle leading-none"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <IconSlot active={state === "muted"}>
        <VolumeX size={size} />
      </IconSlot>
      <IconSlot active={state === "low"}>
        <Volume1 size={size} />
      </IconSlot>
      <IconSlot active={state === "mid"}>
        <Volume2 size={size} />
      </IconSlot>
      <IconSlot active={state === "high"}>
        <Volume2 size={size} />
      </IconSlot>
    </span>
  );
}

export function QueueMenuIcon({ size = 18 }: { size?: number }) {
  return (
    <span
      className="relative inline-grid place-items-center align-middle leading-none"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <ListVideo size={size} />
    </span>
  );
}
