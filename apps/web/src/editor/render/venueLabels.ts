// Where a venue's wall labels go ("Stage wall — 24.50 ft"), as plain
// geometry so the web and the desktop place them the same
// (rendering/VenueLabels.cpp there; packages/bbm/tests/fixtures/
// render-parity/venue-labels.json holds the cases both check):
//   - just outside the room, a little off the wall, in a pill;
//   - turned along the wall but always upright: left to right, and bottom
//     to top on a vertical wall, never upside down;
//   - a label that would overlap another shows just the length (the full
//     text shows while its wall is selected or the pointer is on it);
//   - never under a selection handle: pushed further out until clear.
// Every size is a multiple of the font size, so labels stay the same size
// on screen when the font is (the Venue Designer sets it from the zoom).

import type { VenueEdge } from '@cld/bbm';
import { estimatedText } from './venueDraw';
import { formatLength, type LengthUnit } from '../../venues/designer/units';

type Pt = { x: number; y: number };

/** Scene px per stud. */
const K = 8;

/** The pill: padding across and along, the gap to the wall, all in font sizes. */
export const VENUE_LABEL = {
  padX: 0.5,
  padY: 0.25,
  gap: 0.6,
  /** Pushed this much further (plus a handle) when a handle covers it. */
  handleGap: 0.3,
  /** Corner radius: a full pill. */
  radius: 0.75,
} as const;

/** The pill's colors by theme (light: white with a slate edge; dark: slate with a light edge). */
export const VENUE_LABEL_THEME = {
  light: { fill: 'rgba(255,255,255,0.92)', border: 'rgba(15,23,42,0.2)', text: 'rgb(20,20,20)' },
  dark: { fill: 'rgba(30,41,59,0.92)', border: 'rgba(255,255,255,0.25)', text: 'rgb(241,245,249)' },
} as const;

export interface VenueLabelOptions {
  /** Font size in scene px. */
  fontPx: number;
  /** A line's width at a font size, scene px. */
  measure: (text: string, fontPx: number) => number;
  /** The selected wall: its label always shows in full. */
  selectedEdge?: number | null;
  /** Selection handles (studs) and their half size (scene px): labels keep clear of them. */
  handles?: readonly Pt[];
  handleHalfPx?: number;
  /** The unit the lengths are shown in (the Venue Designer's Units pick); feet by default. */
  unit?: LengthUnit;
}

export interface VenueLabel {
  edge: number;
  /** What's shown. */
  text: string;
  /** The whole text ("Stage wall — 24.50 ft"). */
  full: string;
  shortened: boolean;
  /** The pill's centre (scene px), its turn (degrees) and size along / across it. */
  x: number;
  y: number;
  angle: number;
  width: number;
  height: number;
}

/** "24.50 ft" (or inches under a foot), "7.47 m" or "280 studs", in the chosen unit. */
export function venueDistanceText(lenStuds: number, unit: LengthUnit = 'ftin'): string {
  if (unit !== 'ftin') return formatLength(lenStuds, unit);
  const lenFt = lenStuds * 0.026248;
  return lenFt < 1 ? `${(lenFt * 12).toFixed(1)}"` : `${lenFt.toFixed(2)} ft`;
}

/** A wall's direction turned to read upright: in [-90, 90), so a vertical wall reads bottom to top. */
export function uprightAngle(dx: number, dy: number): number {
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (a >= 90) a -= 180;
  else if (a < -90) a += 180;
  return a;
}

/** Whether two turned rectangles overlap (separating axis test). */
export function pillsOverlap(a: Omit<VenueLabel, 'edge' | 'text' | 'full' | 'shortened'>, b: Omit<VenueLabel, 'edge' | 'text' | 'full' | 'shortened'>): boolean {
  const axes = (r: typeof a) => {
    const t = (r.angle * Math.PI) / 180;
    return [
      { x: Math.cos(t), y: Math.sin(t) },
      { x: -Math.sin(t), y: Math.cos(t) },
    ];
  };
  const corners = (r: typeof a): Pt[] => {
    const [u, v] = axes(r);
    const hw = r.width / 2, hh = r.height / 2;
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([i, j]) => ({ x: r.x + u!.x * hw * i! + v!.x * hh * j!, y: r.y + u!.y * hw * i! + v!.y * hh * j! }));
  };
  const ca = corners(a), cb = corners(b);
  for (const ax of [...axes(a), ...axes(b)]) {
    const pa = ca.map((p) => p.x * ax.x + p.y * ax.y);
    const pb = cb.map((p) => p.x * ax.x + p.y * ax.y);
    if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
  }
  return true;
}

/** Lays out every wall's label (walls under half a stud get none). */
export function venueEdgeLabels(edges: readonly VenueEdge[], opts: VenueLabelOptions): VenueLabel[] {
  const f = opts.fontPx;
  // The room's middle: labels go on the far side of each wall from it.
  const all = edges.flatMap((e) => e.poly ?? []);
  if (all.length === 0) return [];
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const c = { x: ((Math.min(...xs) + Math.max(...xs)) / 2) * K, y: ((Math.min(...ys) + Math.max(...ys)) / 2) * K };
  const height = f * (1 + 2 * VENUE_LABEL.padY);
  const widthOf = (t: string) => opts.measure(t, f) + 2 * VENUE_LABEL.padX * f;

  interface Draft extends VenueLabel {
    short: string;
    nx: number;
    ny: number;
  }
  const drafts: Draft[] = [];
  edges.forEach((edge, i) => {
    const poly = edge.poly ?? [];
    if (poly.length < 2) return;
    const a = poly[0]!, b = poly[poly.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0.5) return;
    const distance = venueDistanceText(len, opts.unit);
    const base = edge.label ? `${edge.label} — ${distance}` : distance;
    const full = edge.estimated ? estimatedText(base) : base;
    const short = edge.estimated ? estimatedText(distance) : distance;
    const m = { x: ((a.x + b.x) / 2) * K, y: ((a.y + b.y) / 2) * K };
    let nx = -dy / len, ny = dx / len;
    if (nx * (m.x - c.x) + ny * (m.y - c.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = VENUE_LABEL.gap * f + height / 2;
    drafts.push({
      edge: i,
      text: full,
      full,
      short,
      shortened: false,
      x: m.x + nx * off,
      y: m.y + ny * off,
      angle: uprightAngle(dx, dy),
      width: widthOf(full),
      height,
      nx,
      ny,
    });
  });

  // Overlapping labels show just their length (the selected wall's stays whole).
  const clash = drafts.map((d, i) => drafts.some((o, j) => j !== i && pillsOverlap(d, o)));
  drafts.forEach((d, i) => {
    if (!clash[i] || d.edge === opts.selectedEdge || d.short === d.full) return;
    d.text = d.short;
    d.shortened = true;
    d.width = widthOf(d.short);
  });

  // Out from under the selection handles.
  const hs = opts.handleHalfPx ?? 0;
  const handles = (opts.handles ?? []).map((h) => ({ x: h.x * K, y: h.y * K, angle: 0, width: hs * 2, height: hs * 2 }));
  if (hs > 0 && handles.length > 0) {
    for (const d of drafts) {
      for (let n = 0; n < 8 && handles.some((h) => pillsOverlap(d, h)); n++) {
        const step = hs * 2 + VENUE_LABEL.handleGap * f;
        d.x += d.nx * step;
        d.y += d.ny * step;
      }
    }
  }
  return drafts.map((d) => ({
    edge: d.edge,
    text: d.text,
    full: d.full,
    shortened: d.shortened,
    x: d.x,
    y: d.y,
    angle: d.angle,
    width: d.width,
    height: d.height,
  }));
}
