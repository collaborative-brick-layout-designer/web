// What an update of a shared module left to look at (docs/shared-modules.md,
// "Collisions after an update"): an update never waits for room, so the
// module then says "It overlaps 2 parts" or "2 track ends no longer meet".
// Worked out from the layout as it is; nothing is stored. The same rules
// as the desktop's edit/SharedMarks.cpp:
//   - overlaps: parts outside the module, on a sheet the module has parts
//     on, that one of its parts lies over by more than a square stud (the
//     parts' outlines, so parts that only touch along an edge don't count);
//   - loose ends: the module's free track ends with someone else's free
//     end of the same kind close by (8 studs), not joined.

import type { BbmMap, Brick } from '@cld/model';
import type { PartWire } from '../api';
import { spriteUrlFor } from '../api';
import { connectionWorld, pivotOf, rotated, type PartGeom, type Pt } from './brickGeometry';
import { getSpriteSync } from './render/spriteCache';

export interface SharedMarks {
  /** Parts outside the module that one of its parts lies over. */
  overlaps: number;
  /** Its free track ends with another free end close by, not joined. */
  looseEnds: number;
}

/** What the marks need of a part: its geometry, and where its picture is. */
export type MarkPart = PartGeom & Partial<Pick<PartWire, 'pickShape' | 'spritePath' | 'source' | 'customPartId' | 'noSprite'>>;

/** Lying over each other by more than this (square studs) counts. */
const OVERLAP_AREA = 1;
/** A free end this close (studs) to a free end of the module was meant to meet it... */
const NEAR_END = 8;
/** ...and closer than this they do meet. */
const JOINED = 0.05;

type Box = { x: number; y: number; width: number; height: number };

const boxesMeet = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The convex hull of `pts` (monotone chain), counter-clockwise. */
export function convexHull(pts: readonly Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The area of a simple polygon. */
export function polygonArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const u = poly[i]!;
    const v = poly[(i + 1) % poly.length]!;
    a += u.x * v.y - v.x * u.y;
  }
  return Math.abs(a) / 2;
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman). */
export function clipConvex(subject: readonly Pt[], clip: readonly Pt[]): Pt[] {
  if (subject.length < 3 || clip.length < 3) return [];
  // The clip polygon's winding decides which side is inside.
  let signed = 0;
  for (let i = 0; i < clip.length; i++) {
    const u = clip[i]!;
    const v = clip[(i + 1) % clip.length]!;
    signed += u.x * v.y - v.x * u.y;
  }
  const dir = signed >= 0 ? 1 : -1;
  let out: Pt[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Pt) => dir * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!;
      const q = input[(j + 1) % input.length]!;
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return out;
}

// ---- A part's outline ------------------------------------------------------------

const ALPHA = 32;
const STRIDE = 2;
/** Each picture's hull, in studs around the sprite centre (null: it couldn't be read). */
const hullCache = new Map<string, Pt[] | null>();

/** The convex hull of a picture's opaque pixels, in studs around its centre (the desktop's hullPolygonStuds). */
function pictureHull(part: MarkPart): Pt[] | null {
  const url = part.noSprite ? '' : spriteUrlFor(part as PartWire);
  if (!url) return null;
  if (hullCache.has(url)) return hullCache.get(url)!;
  const img = getSpriteSync(url);
  if (!img || !img.naturalWidth || !img.naturalHeight || typeof document === 'undefined') return null;
  let hull: Pt[] | null = null;
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const pts: Pt[] = [];
      for (let y = 0; y < h; y += STRIDE) for (let x = 0; x < w; x += STRIDE) if (data[(y * w + x) * 4 + 3]! >= ALPHA) pts.push({ x, y });
      // Studs: the part's own size, whatever size its picture came in.
      const studsWide = part.spriteSize && part.pxPerStud > 0 ? part.spriteSize.w / part.pxPerStud : w / (part.pxPerStud || 8);
      const scale = studsWide / w;
      if (pts.length >= 3) hull = convexHull(pts).map((p) => ({ x: (p.x - w / 2) * scale, y: (p.y - h / 2) * scale }));
    }
  } catch {
    hull = null;
  }
  hullCache.set(url, hull);
  return hull;
}

/** The part's outline on the map: its shape turned and put at its sprite centre; its box when its shape isn't known. */
export function partOutline(b: Pick<Brick, 'displayArea' | 'orientation' | 'partNumber'>, part: MarkPart | undefined): Pt[] {
  const a = b.displayArea;
  const box = [
    { x: a.x, y: a.y },
    { x: a.x + a.width, y: a.y },
    { x: a.x + a.width, y: a.y + a.height },
    { x: a.x, y: a.y + a.height },
  ];
  if (!part) return box;
  let local: Pt[] | null = part.pickShape?.length ? convexHull(part.pickShape.flat()) : pictureHull(part);
  if (!local && part.hullPts?.length && part.spriteSize) {
    // The part's XML <hull>, in its picture's pixels.
    const pps = part.pxPerStud > 0 ? part.pxPerStud : 8;
    local = convexHull(part.hullPts.map((p) => ({ x: (p.x + 0.5 - part.spriteSize!.w / 2) / pps, y: (p.y + 0.5 - part.spriteSize!.h / 2) / pps })));
  }
  if (!local || local.length < 3) return box;
  const c = pivotOf(b, part);
  return local.map((p) => {
    const r = rotated(p, b.orientation ?? 0);
    return { x: c.x + r.x, y: c.y + r.y };
  });
}

// ---- The marks -------------------------------------------------------------------

interface End {
  at: Pt;
  type: string;
  linked: boolean;
}

function endsOf(b: Brick, part: MarkPart | undefined): End[] {
  const cps = part?.connections ?? [];
  return cps.map((cp, i) => ({ at: connectionWorld(b, part, i), type: cp.type, linked: !!b.connexions?.[i]?.linkedTo }));
}

/**
 * The marks of the module whose parts are `members`. `outline` is a
 * part's outline on the map (partOutline; a test can give its own).
 */
export function sharedMarks(
  map: Pick<BbmMap, 'layers'>,
  members: ReadonlySet<string>,
  partOf: (partNumber: string) => MarkPart | undefined,
  outline: (b: Brick, part: MarkPart | undefined) => Pt[] = partOutline,
): SharedMarks {
  const marks: SharedMarks = { overlaps: 0, looseEnds: 0 };
  if (members.size === 0) return marks;
  const mine: End[] = [];
  const theirs: End[] = [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    const bricks = layer.bricks as Brick[];
    const inside = bricks.filter((b) => members.has(b.id));
    if (inside.length === 0) continue;
    const box = inside.reduce<Box>((u, b) => united(u, b.displayArea), { ...inside[0]!.displayArea });
    const reach = { x: box.x - NEAR_END, y: box.y - NEAR_END, width: box.width + 2 * NEAR_END, height: box.height + 2 * NEAR_END };
    const shapes = inside.map((b) => outline(b, partOf(b.partNumber)));
    for (const b of inside) mine.push(...endsOf(b, partOf(b.partNumber)));
    for (const o of bricks) {
      if (members.has(o.id) || !boxesMeet(reach, o.displayArea)) continue;
      const part = partOf(o.partNumber);
      theirs.push(...endsOf(o, part));
      if (!boxesMeet(box, o.displayArea)) continue;
      const shape = outline(o, part);
      for (let i = 0; i < inside.length; i++) {
        if (!boxesMeet(inside[i]!.displayArea, o.displayArea)) continue;
        if (polygonArea(clipConvex(shapes[i]!, shape)) > OVERLAP_AREA) {
          marks.overlaps++;
          break;
        }
      }
    }
  }
  const apart = (a: End, b: End) => (a.type === b.type ? Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) : Infinity);
  for (const e of mine) {
    // A joined end (linked, or with a partner right on it) is fine.
    if (e.linked || theirs.some((o) => apart(e, o) <= JOINED)) continue;
    if (theirs.some((o) => !o.linked && apart(e, o) > JOINED && apart(e, o) <= NEAR_END)) marks.looseEnds++;
  }
  return marks;
}

function united(u: Box, a: Box): Box {
  const x = Math.min(u.x, a.x);
  const y = Math.min(u.y, a.y);
  return { x, y, width: Math.max(u.x + u.width, a.x + a.width) - x, height: Math.max(u.y + u.height, a.y + a.height) - y };
}

/** "It overlaps 2 parts. 1 track end no longer meets."; empty when nothing does. */
export function marksText(marks: SharedMarks): string {
  const out: string[] = [];
  if (marks.overlaps > 0) out.push(`It overlaps ${marks.overlaps} part${marks.overlaps === 1 ? '' : 's'}.`);
  if (marks.looseEnds > 0) out.push(marks.looseEnds === 1 ? '1 track end no longer meets.' : `${marks.looseEnds} track ends no longer meet.`);
  return out.join(' ');
}

/** "Overlaps 2 parts", for the Modules panel's line; empty when nothing does. */
export function marksNote(marks: SharedMarks | null | undefined): string {
  return marks && marks.overlaps > 0 ? `Overlaps ${marks.overlaps} part${marks.overlaps === 1 ? '' : 's'}` : '';
}
