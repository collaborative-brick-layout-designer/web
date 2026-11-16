// Where a library version of a module sits in a layout
// (docs/shared-modules.md). The server, the web and the desktop
// (edit/SharedModulePlacement.cpp) all do this the same way; the shared
// vectors are fixtures/contracts/shared-module-placement.json.
//
// A placement maps the version's own coordinates onto the layout: turn by
// `degrees` about the version's origin, then move to (`x`, `y`). Each part
// turns about its pivot (its sprite centre), so its box is worked out
// again from its footprint at the new angle.

import type { RectangleF } from '@cld/model';
import { areaForPivot, pivotOf, rotated, type PartLookup, type Pt } from './geometry.js';
import type { BatchBrick, ModuleBatch } from './batches.js';

/** How a version sits in a layout, as the sidecar keeps it (`shared.placement`). */
export interface Placement {
  degrees: number;
  x: number;
  y: number;
  /** The version's sheets (by name) to the layout's sheets (by id). */
  sheets?: Record<string, string>;
}

/** A placement worked out from the parts, and how many parts agree with it (0: a guess from the module's middle). */
export interface AlignedPlacement extends Placement {
  matched: number;
}

export const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** Reads `shared.placement` from a sidecar value; null when it isn't one. */
export function readPlacement(v: unknown): Placement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!num(o.degrees) || !num(o.x) || !num(o.y)) return null;
  const out: Placement = { degrees: o.degrees, x: o.x, y: o.y };
  if (o.sheets && typeof o.sheets === 'object' && !Array.isArray(o.sheets)) {
    const sheets: Record<string, string> = {};
    for (const [k, id] of Object.entries(o.sheets as Record<string, unknown>)) if (typeof id === 'string' && id) sheets[k] = id;
    out.sheets = sheets;
  }
  return out;
}

/** Where the placement puts a point of the version. */
export function placePoint(p: Placement, at: Pt): Pt {
  const r = rotated(at, p.degrees);
  return { x: p.x + r.x, y: p.y + r.y };
}

/** One part of the version where the placement puts it. */
export function placeBrick<T extends BatchBrick>(b: T, placement: Placement, partOf: PartLookup): T {
  const part = partOf(b.partNumber);
  const was = b.orientation ?? 0;
  const to = placePoint(placement, pivotOf({ displayArea: b.displayArea, orientation: was }, part));
  const orientation = was + placement.degrees;
  return { ...b, orientation: norm360(orientation), displayArea: areaForPivot(part, orientation, to, b.displayArea) };
}

/** The version's parts where `placement` puts them. */
export function placeVersion(batches: readonly ModuleBatch[], placement: Placement, partOf: PartLookup): ModuleBatch[] {
  return batches.map((batch) => ({ ...batch, bricks: batch.bricks.map((b) => placeBrick(b, placement, partOf)) }));
}

/** The placement after the placed module is moved by (`dx`, `dy`). */
export function movedPlacement(p: Placement, dx: number, dy: number): Placement {
  return { ...p, x: p.x + dx, y: p.y + dy };
}

/** The placement after the placed module is turned by `degrees` about `about`. */
export function turnedPlacement(p: Placement, degrees: number, about: Pt): Placement {
  const r = rotated({ x: p.x - about.x, y: p.y - about.y }, degrees);
  return { ...p, degrees: norm360(p.degrees + degrees), x: about.x + r.x, y: about.y + r.y };
}

/**
 * The placement of a module dropped onto the map: moved by (`dx`, `dy`),
 * then, when a connection snap turned it, turned by `turn.degrees` about
 * (`pivotX`, `pivotY`) onto (`toX`, `toY`).
 */
export function droppedPlacement(drop: { dx: number; dy: number; turn?: { degrees: number; pivotX: number; pivotY: number; toX: number; toY: number } | undefined }): Placement {
  if (!drop.turn) return { degrees: 0, x: drop.dx, y: drop.dy };
  const r = rotated({ x: drop.dx - drop.turn.pivotX, y: drop.dy - drop.turn.pivotY }, drop.turn.degrees);
  return { degrees: norm360(drop.turn.degrees), x: drop.turn.toX + r.x, y: drop.turn.toY + r.y };
}

// ---- Finding the placement from the parts -----------------------------------

type Placed = { partNumber: string; displayArea: RectangleF; orientation?: number };
type Item = { key: string; p: Pt; o: number };

const bucket = (v: number, step: number) => Math.round(v / step) * step;
/** At most this many part pairs are compared per part number (big modules stay quick). */
const MAX_PAIRS = 40000;

function items(bricks: readonly Placed[], partOf: PartLookup): Item[] {
  return bricks.map((b) => ({
    key: b.partNumber.toLowerCase(),
    p: pivotOf({ displayArea: b.displayArea, orientation: b.orientation ?? 0 }, partOf(b.partNumber)),
    o: norm360(b.orientation ?? 0),
  }));
}

/** Each part number's pairs (library part, placed part), thinned evenly past MAX_PAIRS. */
function* pairs(lib: readonly Item[], placed: readonly Item[]): Generator<[Item, Item]> {
  const byKey = new Map<string, Item[]>();
  for (const it of placed) {
    const list = byKey.get(it.key);
    if (list) list.push(it);
    else byKey.set(it.key, [it]);
  }
  const libByKey = new Map<string, Item[]>();
  for (const it of lib) {
    const list = libByKey.get(it.key);
    if (list) list.push(it);
    else libByKey.set(it.key, [it]);
  }
  for (const [key, a] of libByKey) {
    const b = byKey.get(key);
    if (!b) continue;
    const stride = Math.max(1, Math.ceil((a.length * b.length) / MAX_PAIRS));
    let n = 0;
    for (const x of a) for (const y of b) if (n++ % stride === 0) yield [x, y];
  }
}

/** The most common value (the smallest on a tie, so the answer never depends on order). */
function mode<T>(counts: Map<string, { n: number; v: T }>, smaller: (a: T, b: T) => boolean): { v: T; n: number } | null {
  let best: { v: T; n: number } | null = null;
  for (const { n, v } of counts.values()) if (!best || n > best.n || (n === best.n && smaller(v, best.v))) best = { v, n };
  return best;
}

/**
 * Where a library version's parts go so that its parts the layout already
 * has land on them: the turn most part pairs agree on, then the shift.
 * Robust to some parts having changed on either side. Falls back to the
 * placed module's middle, unturned, when no parts are alike.
 */
export function alignToPlaced(batches: readonly ModuleBatch[], placed: readonly Placed[], partOf: PartLookup): AlignedPlacement {
  const lib = items(batches.flatMap((b) => b.bricks), partOf);
  const here = items(placed, partOf);
  const turns = new Map<string, { n: number; v: number }>();
  for (const [a, b] of pairs(lib, here)) {
    const d = bucket(norm360(b.o - a.o), 0.1) % 360;
    const k = d.toFixed(1);
    const e = turns.get(k);
    if (e) e.n++;
    else turns.set(k, { n: 1, v: d });
  }
  const turn = mode(turns, (x, y) => x < y);
  if (turn) {
    const r = (turn.v * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    // The shift most pairs agree on, in 0.05-stud steps; then exactly: the
    // mean of the pairs in that step.
    const shifts = new Map<string, { n: number; v: Pt; sum: Pt }>();
    for (const [a, b] of pairs(lib, here)) {
      const d = norm360(b.o - a.o);
      if (Math.min(Math.abs(d - turn.v), 360 - Math.abs(d - turn.v)) > 0.1) continue;
      const exact = { x: b.p.x - (a.p.x * c - a.p.y * s), y: b.p.y - (a.p.x * s + a.p.y * c) };
      const v = { x: bucket(exact.x, 0.05), y: bucket(exact.y, 0.05) };
      const k = `${v.x.toFixed(2)},${v.y.toFixed(2)}`;
      const e = shifts.get(k);
      if (e) {
        e.n++;
        e.sum.x += exact.x;
        e.sum.y += exact.y;
      } else shifts.set(k, { n: 1, v, sum: { ...exact } });
    }
    const shift = mode(shifts, (x, y) => x.x < y.x || (x.x === y.x && x.y < y.y));
    if (shift) {
      const e = shifts.get(`${shift.v.x.toFixed(2)},${shift.v.y.toFixed(2)}`)!;
      return { degrees: turn.v, x: e.sum.x / e.n, y: e.sum.y / e.n, matched: shift.n };
    }
  }
  // Nothing alike: the library version's middle on the module's middle.
  const mid = (xs: readonly Item[]) =>
    xs.length === 0 ? { x: 0, y: 0 } : { x: xs.reduce((n, i) => n + i.p.x, 0) / xs.length, y: xs.reduce((n, i) => n + i.p.y, 0) / xs.length };
  const a = mid(lib);
  const b = mid(here);
  return { degrees: 0, x: b.x - a.x, y: b.y - a.y, matched: 0 };
}

/** How many of the placed parts are one of the version's parts where `placement` puts it (same part, place and turn, within a hair). */
export function partsInPlace(batches: readonly ModuleBatch[], placed: readonly Placed[], placement: Placement, partOf: PartLookup): number {
  const lib = items(placeVersion(batches, placement, partOf).flatMap((b) => b.bricks), partOf);
  const here = items(placed, partOf);
  const used = new Set<number>();
  let n = 0;
  for (const h of here) {
    const i = lib.findIndex(
      (l, k) =>
        !used.has(k) &&
        l.key === h.key &&
        Math.hypot(l.p.x - h.p.x, l.p.y - h.p.y) < 0.1 &&
        Math.min(Math.abs(l.o - h.o), 360 - Math.abs(l.o - h.o)) < 0.5,
    );
    if (i < 0) continue;
    used.add(i);
    n++;
  }
  return n;
}

/**
 * The placement to use for a placed module: the one the sidecar kept when
 * it still fits the parts (at least half of them are where it puts the
 * version's), else the one worked out from the parts. An app that doesn't
 * keep the placement may have moved the module since it was written.
 */
export function resolvePlacement(
  batches: readonly ModuleBatch[],
  placed: readonly Placed[],
  kept: Placement | null,
  partOf: PartLookup,
): Placement {
  if (kept) {
    const total = Math.min(placed.length, batches.reduce((n, b) => n + b.bricks.length, 0));
    if (total === 0 || partsInPlace(batches, placed, kept, partOf) * 2 >= total) return kept;
  }
  const { matched: _matched, ...found } = alignToPlaced(batches, placed, partOf);
  return kept?.sheets ? { ...found, sheets: kept.sheets } : found;
}

/**
 * Whether the placed module's parts are exactly the library version's
 * (same parts, same places and turns, within a hair): false when it was
 * changed in this layout. `placement` is where the version sits when
 * known; else it's worked out from the parts.
 */
export function matchesVersion(batches: readonly ModuleBatch[], placed: readonly Placed[], partOf: PartLookup, placement?: Placement | null): boolean {
  const total = batches.reduce((n, b) => n + b.bricks.length, 0);
  if (total !== placed.length) return false;
  if (placement && partsInPlace(batches, placed, placement, partOf) === total) return true;
  return partsInPlace(batches, placed, alignToPlaced(batches, placed, partOf), partOf) === total;
}
