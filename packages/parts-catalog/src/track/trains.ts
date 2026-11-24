// Rolling stock and trains (trains design 2.3, 2.4, 3.3): the records, and
// where a train's cars sit on the track. A car rides on its trucks: the
// front truck is on the track, the rear truck is on the track a chord (the
// truck spacing) behind it, and the body lies along the line between them;
// the next car's front coupler meets this car's rear coupler. The desktop's
// src/track/Trains.cpp is the twin; both check fixtures/contracts/train-geometry.json.

import { pointAt, type Pt } from './circuitPath.js';
import { switchKey, type TrackNetwork, type TrackPosition } from './network.js';

export type StockKind = 'engine' | 'car' | 'cab' | 'unit' | 'monorail';
export const STOCK_KINDS: readonly StockKind[] = ['engine', 'car', 'cab', 'unit', 'monorail'];

export interface Truck {
  /** Studs from the body centre along the body, + towards the front. */
  at: number;
  /** How far it may swivel under the body, degrees. */
  swivelMax: number;
}

export interface Coupler {
  type: 'magnet' | 'none' | 'fixed';
  swivelMax: number;
}

/** One engine or car (a record, not a part; trains design 2.3). */
export interface RollingStock {
  id: string;
  /** Road number shown on the map and in lists. */
  number: string;
  name: string;
  kind: StockKind;
  /** Free text: boxcar, hopper, tank, steam, diesel... */
  type: string;
  owner: string;
  ownerUserId?: string | null;
  tags: string[];
  trackKind: string;
  /** Coupler pivot to coupler pivot, studs. */
  length: number;
  /** Body width, studs. */
  width: number;
  /** Body only (defaults to length - 2). */
  bodyLength: number;
  trucks: Truck[];
  couplers: { front: Coupler; rear: Coupler };
  /** Articulated sets (later; kept as written). */
  articulated: unknown;
  powered: boolean;
  /** Scale km/h, engines only. */
  maxSpeed: number | null;
  look: {
    mode: 'simple' | 'part' | 'model';
    color: string;
    /** A library part used as the top view (part and model modes). */
    partKey?: string;
    picture?: string;
  };
  /** The imported model it was made from (look mode "model"): its part, its file, the file's kind and the day it came in (YYYY-MM-DD). */
  model?: { partKey?: string; file?: string; format?: string; importedAt?: string } | null;
  libraryId?: string | null;
  libraryVersion?: number | null;
  notes: string;
  [extra: string]: unknown;
}

/** A head car's front truck on the track, facing `to` (or `from`). */
export interface TrainPosition extends TrackPosition {
  facing: 'to' | 'from';
}

/** A train (consist): stock in order, front to back, moved as one. */
export interface Train {
  id: string;
  name: string;
  trackKind: string;
  units: { stock: string; reversed: boolean }[];
  /** Null: not on the map. */
  position: TrainPosition | null;
  color: string;
  /** Scale km/h, for animation (a later phase). */
  speed: number;
  [extra: string]: unknown;
}

/** Defaults for a simple car of `length` studs: trucks a quarter in from each end. */
export function simpleStock(id: string, fields: Partial<RollingStock> = {}): RollingStock {
  const length = fields.length ?? 32;
  const inset = length / 4;
  return {
    id,
    number: '',
    name: '',
    kind: 'car',
    type: '',
    owner: '',
    tags: [],
    trackKind: 'rail',
    width: 6,
    bodyLength: length - 2,
    trucks: [
      { at: length / 2 - inset, swivelMax: 30 },
      { at: -(length / 2 - inset), swivelMax: 30 },
    ],
    couplers: { front: { type: 'magnet', swivelMax: 37 }, rear: { type: 'magnet', swivelMax: 37 } },
    articulated: null,
    powered: false,
    maxSpeed: null,
    look: { mode: 'simple', color: '#B40000' },
    notes: '',
    ...fields,
    length,
  };
}

/** A record read from a sidecar or the doc, with defaults for what's missing. */
export function asStock(r: Record<string, unknown>): RollingStock {
  const base = simpleStock(String(r.id ?? ''), {});
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const length = num(r.length, base.length);
  const trucks = Array.isArray(r.trucks)
    ? (r.trucks as Partial<Truck>[]).map((t) => ({ at: num(t?.at, 0), swivelMax: num(t?.swivelMax, 30) }))
    : simpleStock('', { length }).trucks;
  return {
    ...base,
    ...r,
    id: String(r.id ?? ''),
    number: typeof r.number === 'string' ? r.number : '',
    name: typeof r.name === 'string' ? r.name : '',
    kind: (STOCK_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as StockKind) : 'car',
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    length,
    width: num(r.width, base.width),
    bodyLength: num(r.bodyLength, length - 2),
    trucks: trucks.length >= 2 ? trucks : simpleStock('', { length }).trucks,
    look: { ...base.look, ...((r.look as object) ?? {}) },
  } as RollingStock;
}

/** A part used as a car's top view: its length is the distance between its two coupler (magnet) connections. */
export function partStockLength(conns: readonly { type: string; x: number; y: number }[]): number | null {
  const magnets = conns.filter((c) => c.type === 'magnet');
  if (magnets.length !== 2) return null;
  return Math.hypot(magnets[0]!.x - magnets[1]!.x, magnets[0]!.y - magnets[1]!.y);
}

/** The track behind a train's head, as a line: points with their distance back from the head. */
export interface TrackLine {
  /** Each point, its distance back from the head, and the brick it's on. */
  pts: { p: Pt; d: number; brick: string }[];
  /** True when the track ran out before `length` (an end of track). */
  ended: boolean;
}

/**
 * Walk back from `head` along the track for `length` studs, through switches
 * as they are set (a train backing into a switch's heel takes the set way).
 */
export function trackBehind(net: TrackNetwork, head: TrainPosition, length: number, states: Readonly<Record<string, number>> = {}): TrackLine {
  const out: { p: Pt; d: number; brick: string }[] = [];
  let d = 0;
  // The way back through the head's brick: towards `from` when facing `to`.
  let brick = head.brick;
  let enter = head.facing === 'to' ? head.to : head.from;
  let leave = head.facing === 'to' ? head.from : head.to;
  let pts = net.path(brick, enter, leave);
  if (pts.length < 2) return { pts: [], ended: true };
  const len0 = pts[pts.length - 1]!.s;
  let start = head.facing === 'to' ? len0 - Math.max(0, Math.min(head.s, len0)) : Math.max(0, Math.min(head.s, len0));
  for (let guard = 0; guard < 100000; guard++) {
    if (out.length === 0) out.push({ p: pointAt(pts, start).p, d: 0, brick });
    for (const q of pts) {
      if (q.s <= start) continue;
      const prev = out[out.length - 1]!;
      d += Math.hypot(q.p.x - prev.p.x, q.p.y - prev.p.y);
      out.push({ p: q.p, d, brick });
      if (d >= length) return { pts: out, ended: false };
    }
    const next = net.partner({ brick, conn: leave });
    if (!next) return { pts: out, ended: true };
    brick = next.brick;
    enter = next.conn;
    const sw = net.switchAt(switchKey(brick, enter));
    const exits = net.exits(brick, enter);
    if (exits.length === 0) return { pts: out, ended: true };
    leave = sw ? net.settingOf(sw, states) : exits[0]!;
    pts = net.path(brick, enter, leave);
    start = 0;
  }
  return { pts: out, ended: true };
}

/** The point on the line at distance `d` from the head. */
export function lineAt(line: TrackLine, d: number): Pt | null {
  return at(line, d);
}

function at(line: TrackLine, d: number): Pt | null {
  const pts = line.pts;
  if (pts.length === 0 || d > pts[pts.length - 1]!.d + 1e-9) return null;
  if (d <= pts[0]!.d) return pts[0]!.p;
  // The first point at or past d (distances only grow along the line).
  let lo = 1;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.d >= d) hi = mid;
    else lo = mid + 1;
  }
  const a = pts[lo - 1]!;
  const b = pts[lo]!;
  const f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
  return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f };
}

/**
 * The first distance past `from` where the line is `chord` studs (straight
 * line) from `q`, by stepping along the line then halving; null when the
 * line ends first.
 */
function chordBehind(line: TrackLine, q: Pt, from: number, chord: number): number | null {
  const end = line.pts.length ? line.pts[line.pts.length - 1]!.d : 0;
  const dist = (d: number) => {
    const p = at(line, d)!;
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  let lo = from;
  for (let d = from + 0.5; ; d += 0.5) {
    const hi = Math.min(d, end);
    if (dist(hi) >= chord) {
      let a = lo;
      let b = hi;
      for (let k = 0; k < 50; k++) {
        const m = (a + b) / 2;
        if (dist(m) >= chord) b = m;
        else a = m;
      }
      return b;
    }
    if (hi >= end) return null;
    lo = hi;
  }
}

/** Where one unit of a train sits (studs, degrees: the body's heading, front end). */
export interface PlacedUnit {
  stock: string;
  frontTruck: Pt;
  rearTruck: Pt;
  centre: Pt;
  angle: number;
  frontCoupler: Pt;
  rearCoupler: Pt;
  /** The rear coupler's distance back from the head along the track. */
  back: number;
  /** The trucks' distances back from the head along the track (the fit checks read the track there). */
  frontD: number;
  rearD: number;
}

export interface PlacedTrain {
  units: PlacedUnit[];
  /** Some cars didn't fit on the track behind the head (an end of track). */
  offTrack: boolean;
  /** The track behind the head the cars were placed on. */
  line?: TrackLine;
}

/** A unit's trucks and couplers in the order it runs (turned round: mirrored). */
function runningGeometry(s: RollingStock, reversed: boolean) {
  const sorted = [...s.trucks].map((t) => t.at).sort((a, b) => b - a);
  const front = reversed ? -sorted[sorted.length - 1]! : sorted[0]!;
  const rear = reversed ? -sorted[0]! : sorted[sorted.length - 1]!;
  return { front, rear, half: s.length / 2 };
}

/**
 * Where each unit of a train sits on the track behind its head (trains
 * design 3.3): the head car's front truck is on the head position; its rear
 * truck the truck spacing (a chord) behind; the next car's front truck such
 * that its front coupler meets this car's rear coupler (along the chord).
 */
export function placeTrain(
  net: TrackNetwork,
  train: Pick<Train, 'units' | 'position'>,
  stock: ReadonlyMap<string, RollingStock>,
  states: Readonly<Record<string, number>> = {},
): PlacedTrain | null {
  if (!train.position) return null;
  const line = trackBehind(net, train.position, trainLength(train, stock) + 64, states);
  if (line.pts.length < 2) return null;
  return placeOnLine(line, train.units, stock);
}

/**
 * Where each unit sits on `line` (the track behind the head, its first
 * point the head car's front truck): as placeTrain, on a line the caller
 * made (a running train's: the way it came).
 */
export function placeOnLine(line: TrackLine, trainUnits: Train['units'], stock: ReadonlyMap<string, RollingStock>): PlacedTrain {
  const units = trainUnits.map((u) => ({ u, s: stock.get(u.stock) })).filter((x): x is { u: Train['units'][number]; s: RollingStock } => !!x.s);
  const out: PlacedUnit[] = [];
  let couplerAt: Pt | null = null;
  let along = 0;
  // A unit placed with its front truck `frontD` along the line: null when its rear truck runs off the end.
  const place = (s: RollingStock, g: ReturnType<typeof runningGeometry>, frontD: number) => {
    const spacing = g.front - g.rear;
    const frontTruck = at(line, frontD);
    if (!frontTruck) return null;
    const rearD = chordBehind(line, frontTruck, frontD, spacing);
    if (rearD === null) return null;
    const rearTruck = at(line, rearD)!;
    const ux = (frontTruck.x - rearTruck.x) / spacing;
    const uy = (frontTruck.y - rearTruck.y) / spacing;
    const centre = { x: frontTruck.x - ux * g.front, y: frontTruck.y - uy * g.front };
    return {
      stock: s.id,
      frontTruck,
      rearTruck,
      centre,
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      frontCoupler: { x: centre.x + ux * g.half, y: centre.y + uy * g.half },
      rearCoupler: { x: centre.x - ux * g.half, y: centre.y - uy * g.half },
      back: rearD + (g.half + g.rear),
      frontD,
      rearD,
    };
  };
  for (const { u, s } of units) {
    const g = runningGeometry(s, u.reversed);
    let unit: PlacedUnit | null;
    if (!couplerAt) {
      unit = place(s, g, 0);
    } else {
      // The front truck where this unit's front coupler meets the last one's
      // rear coupler: scanned a quarter stud at a time, then narrowed.
      const r: Pt = couplerAt;
      const gap = (d: number): number => {
        const p = place(s, g, d);
        return p ? Math.hypot(p.frontCoupler.x - r.x, p.frontCoupler.y - r.y) : Infinity;
      };
      const first = Math.max(0, along);
      let bestD = first;
      let best: number = gap(first);
      for (let d = first; d <= first + (g.half - g.front) + 8; d += 0.25) {
        const v = gap(d);
        if (v < best) {
          best = v;
          bestD = d;
        }
      }
      let lo = Math.max(0, bestD - 0.25);
      let hi = bestD + 0.25;
      for (let k = 0; k < 60; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (gap(m1) <= gap(m2)) hi = m2;
        else lo = m1;
      }
      unit = best === Infinity ? null : place(s, g, (lo + hi) / 2);
    }
    if (!unit) return { units: out, offTrack: true, line };
    out.push(unit);
    couplerAt = unit.rearCoupler;
    along = unit.back;
  }
  return { units: out, offTrack: false, line };
}

/** A train's coupler-to-coupler length, studs. */
export function trainLength(train: Pick<Train, 'units'>, stock: ReadonlyMap<string, RollingStock>): number {
  return train.units.reduce((n, u) => n + (stock.get(u.stock)?.length ?? 0), 0);
}

/**
 * A train turned round: its head moves to its tail (the last unit's rear
 * truck, which becomes the front truck), facing the other way, and its
 * units reverse.
 */
export function turnedAround(net: TrackNetwork, train: Train, stock: ReadonlyMap<string, RollingStock>, states: Readonly<Record<string, number>> = {}): Train {
  const units = [...train.units].reverse().map((u) => ({ ...u, reversed: !u.reversed }));
  const placed = placeTrain(net, train, stock, states);
  if (!placed || placed.offTrack || placed.units.length === 0 || !train.position) return { ...train, units };
  const tail = placed.units[placed.units.length - 1]!.rearTruck;
  const ahead = placed.units[placed.units.length - 1]!.frontTruck;
  // The tail's place on the track, and which way is "behind" for the new head: away from the rest of the train.
  let best: TrainPosition | null = null;
  let bestD = 1;
  for (const id of net.brickIds) {
    for (const [i, j] of net.trackOf(id)!.paths) {
      const pts = net.path(id, i, j);
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]!;
        const b = pts[k]!;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((tail.x - a.p.x) * dx + (tail.y - a.p.y) * dy) / l2)) : 0;
        const dd = Math.hypot(a.p.x + dx * t - tail.x, a.p.y + dy * t - tail.y);
        if (dd < bestD) {
          bestD = dd;
          // The new head's cars lie towards the old head: "behind" (facing 'from' looks back towards `to`) is that way.
          const towards = (ahead.x - tail.x) * dx + (ahead.y - tail.y) * dy > 0;
          best = { brick: id, from: i, to: j, s: a.s + (b.s - a.s) * t, facing: towards ? 'from' : 'to' };
        }
      }
    }
  }
  return { ...train, units, position: best ?? train.position };
}
