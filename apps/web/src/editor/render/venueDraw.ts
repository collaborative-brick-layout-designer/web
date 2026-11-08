// How the venue model's newer parts are drawn (references/VENUE-MODEL.md,
// "Drawing"), as plain geometry in studs so the web and desktop draw the
// same thing: desktop rendering/VenueDraw.cpp mirrors this file.

import type { VenueDimension, VenueObstacle, VenuePower } from '@cld/bbm';

type Pt = { x: number; y: number };
export type Seg = [number, number, number, number];

export interface ObstacleStyle {
  fill: string | null;
  stroke: string;
  strokeWidth: number;
}

/** Fill and outline by obstacle kind (px widths, zoom-independent). */
export function obstacleStyle(kind: VenueObstacle['kind']): ObstacleStyle {
  switch (kind) {
    case 'column':
      return { fill: 'rgba(60,60,60,0.75)', stroke: 'rgb(40,40,40)', strokeWidth: 1 };
    case 'stairs':
      return { fill: 'rgba(214,180,196,0.55)', stroke: 'rgb(120,80,100)', strokeWidth: 1 };
    case 'elevator':
      return { fill: 'rgba(150,150,170,0.45)', stroke: 'rgb(70,70,90)', strokeWidth: 1 };
    case 'counter':
      return { fill: 'rgba(170,125,70,0.45)', stroke: 'rgb(110,80,40)', strokeWidth: 1 };
    case 'railing':
      return { fill: null, stroke: 'rgb(40,40,40)', strokeWidth: 3 };
    default:
      return { fill: 'rgba(120,120,120,0.4)', stroke: 'rgb(90,90,90)', strokeWidth: 1 };
  }
}

/** Stair treads and the way-up arrow: spacing between treads, in studs. */
export const TREAD_SPACING_STUDS = 10;

/**
 * Treads across the stairs (perpendicular to the way up, every
 * TREAD_SPACING_STUDS) and an arrow pointing up the stairs: its shaft and
 * two head strokes. Nothing without `upDegrees` or a polygon.
 */
export function stairMarks(ob: Pick<VenueObstacle, 'poly' | 'upDegrees'>): { treads: Seg[]; arrow: Seg[] } {
  if (ob.upDegrees === undefined || ob.poly.length < 3) return { treads: [], arrow: [] };
  const a = (ob.upDegrees * Math.PI) / 180;
  const u = { x: Math.cos(a), y: Math.sin(a) }; // up the stairs
  const w = { x: -u.y, y: u.x }; // across them
  const dot = (p: Pt, d: Pt) => p.x * d.x + p.y * d.y;
  const us = ob.poly.map((p) => dot(p, u));
  const ws = ob.poly.map((p) => dot(p, w));
  const u0 = Math.min(...us), u1 = Math.max(...us), w0 = Math.min(...ws), w1 = Math.max(...ws);
  const at = (uu: number, ww: number): Pt => ({ x: u.x * uu + w.x * ww, y: u.y * uu + w.y * ww });
  const seg = (p: Pt, q: Pt): Seg => [p.x, p.y, q.x, q.y];
  const treads: Seg[] = [];
  for (let uu = u0 + TREAD_SPACING_STUDS; uu < u1 - 0.001; uu += TREAD_SPACING_STUDS) treads.push(seg(at(uu, w0), at(uu, w1)));
  const len = u1 - u0;
  const mid = (w0 + w1) / 2;
  const tail = at(u0 + len * 0.15, mid), tip = at(u1 - len * 0.15, mid);
  const head = Math.min(len * 0.2, (w1 - w0) * 0.3);
  const arrow: Seg[] = [
    seg(tail, tip),
    seg(tip, at(u1 - len * 0.15 - head, mid - head * 0.6)),
    seg(tip, at(u1 - len * 0.15 - head, mid + head * 0.6)),
  ];
  return { treads, arrow };
}

/** Elevator: the two diagonals of its bounding box. */
export function elevatorCross(poly: Pt[]): Seg[] {
  if (poly.length < 3) return [];
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [
    [x0, y0, x1, y1],
    [x1, y0, x0, y1],
  ];
}

/** Power point marker radius, in studs. */
export const POWER_RADIUS_STUDS = 6;
export const POWER_COLOR = 'rgb(220,100,20)';

/** "Stage · 20 A · 120 V", or '' when there's nothing to say. */
export function powerText(p: Pick<VenuePower, 'label' | 'amps' | 'volts'>): string {
  return [p.label ?? '', p.amps ? `${p.amps} A` : '', p.volts ? `${p.volts} V` : ''].filter(Boolean).join(' · ');
}

export const DIMENSION_COLOR = 'rgb(40,90,140)';
export const ESTIMATE_COLOR = 'rgb(120,120,120)';
/** Half-length of the end ticks and the label's offset from the line, in studs. */
export const DIMENSION_TICK_STUDS = 5;
export const DIMENSION_LABEL_OFFSET_STUDS = 8;

/**
 * A measurement's line, its end ticks, and where its label goes (the
 * midpoint, offset to the line's left, turned to read left to right).
 */
export function dimensionGeometry(d: Pick<VenueDimension, 'from' | 'to'>): {
  line: Seg;
  ticks: Seg[];
  label: Pt;
  angleDeg: number;
} | null {
  const dx = d.to.x - d.from.x, dy = d.to.y - d.from.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return null;
  const nx = -dy / len, ny = dx / len;
  const t = DIMENSION_TICK_STUDS;
  const tick = (p: Pt): Seg => [p.x - nx * t, p.y - ny * t, p.x + nx * t, p.y + ny * t];
  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angleDeg > 90) angleDeg -= 180;
  else if (angleDeg <= -90) angleDeg += 180;
  const o = DIMENSION_LABEL_OFFSET_STUDS;
  return {
    line: [d.from.x, d.from.y, d.to.x, d.to.y],
    ticks: [tick(d.from), tick(d.to)],
    label: { x: (d.from.x + d.to.x) / 2 - nx * o, y: (d.from.y + d.to.y) / 2 - ny * o },
    angleDeg,
  };
}

/** Text shown for an estimated value. */
export const estimatedText = (s: string): string => `${s} (est.)`;

/**
 * A venue color as drawn on a dark canvas (the Venue Designer in the dark
 * theme): a dark color gets the same hue with its lightness mirrored, so
 * walls, outlines and text read light on dark; light colors stay. Alpha is
 * kept. Desktop rendering/VenueDraw.cpp onDarkCanvas() is the same.
 */
export function onDarkCanvas(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim());
  if (!m) return color;
  const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l >= 0.5) return color;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  // Back to rgb with lightness 1 - l.
  const L = 1 - l;
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const k = L - c / 2;
  const hi = Math.floor(((h % 6) + 6) % 6);
  const [r1, g1, b1] = ([[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]] as const)[hi]!;
  const to = (v: number) => Math.round((v + k) * 255);
  return m[4] !== undefined ? `rgba(${to(r1)},${to(g1)},${to(b1)},${m[4]})` : `rgb(${to(r1)},${to(g1)},${to(b1)})`;
}
