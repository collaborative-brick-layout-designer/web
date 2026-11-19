// Zoom and pan for the import preview, as the desktop's PreviewView
// (src/ui/ImportPreviewDialog.cpp): it fits the whole model until you zoom,
// zooms towards the pointer, drags to pan, and stops at 5% and 3200% of the
// picture's own pixels.
//
// The view is held in the turned picture's studs ("world"), so the picture
// stays still while it's nudged and the stud grid slides under it: what you
// look at doesn't jump when the part's frame grows by a stud.

import type { PreviewFrame } from './previewMath';

export interface View {
  /** Screen pixels per stud. */
  k: number;
  /** Where the picture's top-left corner is on screen, in pixels. */
  tx: number;
  ty: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The desktop's limits, in the picture's own pixels (1 = 100%). */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;

/** The part's frame (its stud grid) in the picture's studs. */
export function frameBox(frame: PreviewFrame): Box {
  return { x: 0 - frame.imageAt.x, y: 0 - frame.imageAt.y, width: frame.widthStuds, height: frame.heightStuds };
}

/** The picture and the frame together: what Fit shows. */
export function contentBox(frame: PreviewFrame): Box {
  const f = frameBox(frame);
  const x = Math.min(0, f.x);
  const y = Math.min(0, f.y);
  const r = Math.max(frame.imageStuds.width, f.x + f.width);
  const b = Math.max(frame.imageStuds.height, f.y + f.height);
  return { x, y, width: r - x, height: b - y };
}

/** Fit the box, centered, with a little room around it. */
export function fit(box: Box, viewW: number, viewH: number, margin = 16): View {
  const w = Math.max(1, viewW - 2 * margin);
  const h = Math.max(1, viewH - 2 * margin);
  const k = Math.min(w / Math.max(box.width, 0.01), h / Math.max(box.height, 0.01));
  return { k, tx: viewW / 2 - (box.x + box.width / 2) * k, ty: viewH / 2 - (box.y + box.height / 2) * k };
}

/** Clamp a scale (pixels per stud) to the desktop's limits. */
export function clampK(k: number, pxPerStud: number): number {
  const s = Math.max(1, pxPerStud);
  return Math.min(MAX_ZOOM * s, Math.max(MIN_ZOOM * s, k));
}

/** Zoom by a factor, keeping the point under (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number, pxPerStud: number): View {
  const k = clampK(v.k * factor, pxPerStud);
  const r = k / v.k;
  return { k, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r };
}

/** Zoom to a scale, around the middle of the view. */
export function zoomTo(v: View, k: number, viewW: number, viewH: number, pxPerStud: number): View {
  return zoomAt(v, k / v.k, viewW / 2, viewH / 2, pxPerStud);
}

/** The zoom as people read it: 100% is one picture pixel per screen pixel. */
export function zoomPercent(v: View, pxPerStud: number): number {
  return Math.round((v.k / Math.max(1, pxPerStud)) * 100);
}

/** One wheel step's zoom factor: a mouse notch ≈ the desktop's 1.15. */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const perUnit = pinch ? 0.01 : deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.0015;
  return Math.exp(-deltaY * perUnit);
}

/** Map a point in the picture's studs to the screen. */
export function toScreen(v: View, x: number, y: number): { x: number; y: number } {
  return { x: v.tx + x * v.k, y: v.ty + y * v.k };
}
