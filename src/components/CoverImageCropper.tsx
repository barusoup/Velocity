import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ZoomIn, ZoomOut, X } from "lucide-react";

const CROP_SIZE = 300;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const COVER_MAX_SIDE = 480;
const COVER_JPEG_QUALITY = 0.7;

function clampPan(
  px: number,
  py: number,
  displayW: number,
  displayH: number,
) {
  const maxX = 0;
  const minX = Math.min(maxX, CROP_SIZE - displayW);
  const maxY = 0;
  const minY = Math.min(maxY, CROP_SIZE - displayH);
  return {
    x: Math.max(minX, Math.min(maxX, px)),
    y: Math.max(minY, Math.min(maxY, py)),
  };
}

export function CoverImageCropper({
  file,
  onConfirm,
  onCancel,
}: {
  file: File;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, startPanX: 0, startPanY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);

  const baseScale = useMemo(
    () => (img ? CROP_SIZE / Math.min(img.naturalWidth, img.naturalHeight) : 1),
    [img],
  );

  const displayScale = baseScale * zoom;
  const displayW = img ? img.naturalWidth * displayScale : 0;
  const displayH = img ? img.naturalHeight * displayScale : 0;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      const scale = CROP_SIZE / Math.min(image.naturalWidth, image.naturalHeight);
      const dw = image.naturalWidth * scale;
      const dh = image.naturalHeight * scale;
      setPan({
        x: (CROP_SIZE - dw) / 2,
        y: (CROP_SIZE - dh) / 2,
      });
    };
    image.onerror = () => setError("Failed to load image.");
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Keep zoom centered on the middle of the crop area. This runs as a
  // layout effect (not a regular effect) so the pan is recomputed and
  // committed in the same paint frame as the zoom change. With a
  // regular effect the image would render for one frame at the new
  // size but the old pan, then jump to the re-centered pan on the
  // next frame — visibly "jittery" while zooming, and most pronounced
  // when the user scrubs the slider, because the browser fires a
  // stream of `change` events (one per wheel tick) and each one kicks
  // off its own two-paint cycle.
  useLayoutEffect(() => {
    const prevZoom = zoomRef.current;
    zoomRef.current = zoom;
    if (!img || prevZoom === zoom) return;

    const ratio = zoom / prevZoom;
    setPan((prevPan) => {
      const npx = CROP_SIZE / 2 * (1 - ratio) + prevPan.x * ratio;
      const npy = CROP_SIZE / 2 * (1 - ratio) + prevPan.y * ratio;
      return clampPan(npx, npy, img.naturalWidth * baseScale * zoom, img.naturalHeight * baseScale * zoom);
    });
  }, [zoom, img, baseScale]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setDragging(true);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pan],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !img) return;
      const npx = dragRef.current.startPanX + (e.clientX - dragRef.current.startX);
      const npy = dragRef.current.startPanY + (e.clientY - dragRef.current.startY);
      setPan(clampPan(npx, npy, displayW, displayH));
    },
    [dragging, img, displayW, displayH],
  );

  const handlePointerUp = useCallback(() => setDragging(false), []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom - e.deltaY * 0.002));
      setZoom(next);
    },
    [zoom],
  );

  const handleConfirm = useCallback(() => {
    if (!img) return;

    const srcX = Math.max(0, -pan.x / displayScale);
    const srcY = Math.max(0, -pan.y / displayScale);
    const srcW = Math.min(CROP_SIZE / displayScale, img.naturalWidth - srcX);
    const srcH = Math.min(CROP_SIZE / displayScale, img.naturalHeight - srcY);

    const canvas = document.createElement("canvas");
    canvas.width = COVER_MAX_SIDE;
    canvas.height = COVER_MAX_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, COVER_MAX_SIDE, COVER_MAX_SIDE);
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, COVER_MAX_SIDE, COVER_MAX_SIDE);

    onConfirm(canvas.toDataURL("image/jpeg", COVER_JPEG_QUALITY));
  }, [img, pan, displayScale, onConfirm]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && img) handleConfirm();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel, handleConfirm, img]);

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="mx-4 flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border border-white/10 bg-neutral-950 p-6 shadow-2xl"
      >
        <div className="flex w-full items-center justify-between">
          <h2 className="text-base font-bold text-white">Adjust cover</h2>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 transition hover:text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div
          ref={containerRef}
          className="relative h-[300px] w-[300px] overflow-hidden rounded-lg bg-neutral-900"
          style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {!img && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-red-300">
              {error}
            </div>
          )}
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              className="pointer-events-none"
              style={{
                position: "absolute",
                left: `${pan.x}px`,
                top: `${pan.y}px`,
                width: `${displayW}px`,
                height: `${displayH}px`,
                maxWidth: "none",
              }}
            />
          )}
        </div>

        <div className="flex w-full items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
              disabled={zoom <= MIN_ZOOM}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition hover:text-white disabled:opacity-25"
              aria-label="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="h-1 w-full appearance-none rounded-full bg-white/15 accent-white"
            />
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}
              disabled={zoom >= MAX_ZOOM}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition hover:text-white disabled:opacity-25"
              aria-label="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
        </div>

        <div className="flex w-full justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-300 transition hover:bg-neutral-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!img}
            onClick={handleConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-40"
          >
            <Check size={16} />
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
