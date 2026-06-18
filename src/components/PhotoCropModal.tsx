'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ZoomIn, ZoomOut } from 'lucide-react';

interface PhotoCropModalProps {
  /** Object URL or data URL of the source image. */
  src: string;
  /** Cancel without saving. */
  onCancel: () => void;
  /** Returns a 256×256 JPEG data URL of the cropped region. */
  onSave: (dataUrl: string) => void;
}

/**
 * Profile-photo cropper. Square→circle crop frame; the source image floats
 * underneath. Drag to reposition, scroll/pinch or slider to zoom, save
 * writes a 256×256 JPEG back to the contact row.
 */
export default function PhotoCropModal({ src, onCancel, onSave }: PhotoCropModalProps) {
  // Visible crop window size. Output is downsampled to OUTPUT_SIZE so the
  // saved data URL stays a sane size in the Supabase row.
  const CROP_SIZE = 280;
  const OUTPUT_SIZE = 256;

  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // Initial pointer + offset snapshot at drag-start, so the move handler can
  // compute total delta from origin instead of accumulating per-frame deltas.
  const dragOriginRef = useRef<{ x: number; y: number; offX: number; offY: number } | null>(null);

  // Initial fit: scale the image so it COVERS the crop window (the shorter
  // dimension matches CROP_SIZE). Reset offset to centered.
  useEffect(() => {
    if (!natural.w || !natural.h) return;
    const cover = CROP_SIZE / Math.min(natural.w, natural.h);
    setScale(cover);
    setOffset({ x: 0, y: 0 });
  }, [natural]);

  // Lock body scroll while the modal is open — the wheel handler is for
  // zoom, not page scroll.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const renderedW = natural.w * scale;
  const renderedH = natural.h * scale;
  const left = CROP_SIZE / 2 + offset.x - renderedW / 2;
  const top = CROP_SIZE / 2 + offset.y - renderedH / 2;

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      offX: offset.x,
      offY: offset.y,
    };
    setIsDragging(true);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragOriginRef.current) return;
    setOffset({
      x: dragOriginRef.current.offX + (e.clientX - dragOriginRef.current.x),
      y: dragOriginRef.current.offY + (e.clientY - dragOriginRef.current.y),
    });
  };
  const endDrag = () => {
    dragOriginRef.current = null;
    setIsDragging(false);
  };
  const handleWheel = (e: React.WheelEvent) => {
    // Wheel zoom is centered on the crop window, not the cursor. Good enough
    // for profile photos and avoids the pan-jump that anchor-to-cursor causes.
    const delta = -e.deltaY * 0.0025;
    setScale((s) => clampScale(s + s * delta));
  };

  const minScale = natural.w && natural.h ? CROP_SIZE / Math.min(natural.w, natural.h) : 0.5;
  const maxScale = minScale * 5;
  const clampScale = (s: number) => Math.max(minScale, Math.min(maxScale, s));

  const handleSave = () => {
    if (!imgRef.current || !natural.w) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The image is positioned at (left, top) in crop-frame coords with size
    // (renderedW, renderedH). The crop window is (0, 0) to (CROP_SIZE, CROP_SIZE).
    // Source rect in NATURAL image pixels is the inverse of that mapping.
    const srcX = -left / scale;
    const srcY = -top / scale;
    const srcSize = CROP_SIZE / scale;
    ctx.drawImage(imgRef.current, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    onSave(canvas.toDataURL('image/jpeg', 0.88));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl p-6 w-full max-w-[360px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold tracking-tight">Position your photo</h3>
        <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">Drag to reposition · scroll or use the slider to zoom</p>

        {/* Crop frame — circular cutout. The image floats underneath. */}
        <div
          className="relative mx-auto mt-5 rounded-full overflow-hidden bg-black select-none"
          style={{
            width: CROP_SIZE,
            height: CROP_SIZE,
            cursor: isDragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={handleWheel}
        >
          {natural.w > 0 && (
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              className="absolute pointer-events-none"
              style={{ left, top, width: renderedW, height: renderedH }}
            />
          )}
          {/* Hidden loader: reads naturalWidth/Height once so the visible
              image can be positioned correctly. */}
          <img
            src={src}
            alt=""
            className="hidden"
            onLoad={(e) => {
              const i = e.currentTarget;
              setNatural({ w: i.naturalWidth, h: i.naturalHeight });
            }}
          />
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-3 mt-5">
          <ZoomOut size={13} className="text-[var(--text-secondary)] flex-shrink-0" />
          <input
            type="range"
            min={minScale}
            max={maxScale}
            step={(maxScale - minScale) / 100}
            value={scale}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            className="flex-1 accent-[var(--accent)]"
          />
          <ZoomIn size={13} className="text-[var(--text-secondary)] flex-shrink-0" />
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg border border-[var(--border)] text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!natural.w}
            className="flex-1 py-2.5 rounded-lg bg-[var(--accent)] text-white text-[12.5px] font-medium hover:bg-[var(--accent-light)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Save photo
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
