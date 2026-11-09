// Map background helpers — the background color (with alpha) and the
// sidecar background image placement.

import type { ColorSpec } from '@cld/model';
import type { BackgroundImage } from '@cld/bbm';
import { colorSpecAlpha, colorSpecToHex } from './layerOptions';

/**
 * Where the background image is drawn, in scene px (8 per stud). A stored
 * rect (studs) wins; otherwise the image sits at its native size with its
 * top-left at the origin — 1 image px = 1 scene px (MapViewPaint.cpp:48-60).
 */
export function backgroundImageRectPx(
  bg: Pick<BackgroundImage, 'rect'>,
  natural: { width: number; height: number },
  pxPerStud = 8,
): { x: number; y: number; width: number; height: number } {
  if (bg.rect) {
    return { x: bg.rect.x * pxPerStud, y: bg.rect.y * pxPerStud, width: bg.rect.w * pxPerStud, height: bg.rect.h * pxPerStud };
  }
  return { x: 0, y: 0, width: natural.width, height: natural.height };
}

/**
 * The address to load a layout's background picture from: a path on this
 * site only (the server keeps it at `/api/layouts/<id>/background-image`
 * and takes nothing else), or null. An address on another host would tell
 * that host who opened the layout, so it is never loaded.
 */
export function sameOriginImageUrl(url: unknown, origin: string = window.location.origin): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  try {
    return new URL(url, origin).origin === origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * ARGB color spec as desktop writes it: `QColorDialog` with
 * ShowAlphaChannel (MainWindowMapMenu.cpp:54-55) → ColorSpec::fromArgb →
 * lowercase 8-digit `aarrggbb` (XmlPrimitives.cpp:174-180).
 */
export function argbSpec(hex: string, alpha: number): ColorSpec {
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0');
  const rgb = hex.replace(/^#/, '').toLowerCase().padStart(6, '0').slice(-6);
  return { kind: 'argb', argb: `${a}${rgb}` };
}

/** Picker state for a color spec: `#rrggbb` plus alpha 0-255 (known colors are opaque). */
export function hexAlpha(c: ColorSpec, fallback = '#6495ed'): { hex: string; alpha: number } {
  return { hex: colorSpecToHex(c, fallback), alpha: colorSpecAlpha(c) };
}
