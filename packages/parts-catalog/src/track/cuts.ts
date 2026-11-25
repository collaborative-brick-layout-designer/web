// Cars on the track (Live Ops design 2.3): every group of cars coupled
// together is a cut, a train record with `cut: true`. A car in one is in it
// alone: its own `opsCut` says which, so two people who move the same car
// at once leave it in one place, and one whose cut's list lost it in a
// merge is still there. Dragging a car pulls it, and the cars on the side
// it is dragged to, off the rest; an engine takes the whole train. A cut
// that meets another couples to it. `over` keeps the way a cut stands over
// switches, so one flipped under it doesn't move its cars.
//
// The desktop's src/track/Cuts.cpp is the twin; both check
// fixtures/contracts/cuts.json.

import { type CircuitPathPoint, type Pt } from './circuitPath.js';
import { switchKey, type TrackNetwork } from './network.js';
import { placeTrain, turnedAround, type PlacedTrain, type RollingStock, type Train, type TrainPosition } from './trains.js';

/** What the apps hold a layout to; the server takes twice the counts (two people may each add the last ones at once). */
export const CUT_LIMITS = {
  /** Cars in one train or cut. */
  units: 200,
  /** Cars, and trains (cuts included), a layout may have. */
  records: 2000,
} as const;

/** A car's load, as its record keeps it ('': it doesn't apply). */
export const LOADS = ['loaded', 'empty'] as const;
export type Load = (typeof LOADS)[number] | '';
export function loadOf(s: RollingStock): Load {
  return (LOADS as readonly unknown[]).includes(s.opsLoad) ? (s.opsLoad as Load) : '';
}

/** Couplers this close (studs) couple. */
export const COUPLE_REACH = 1;
/** How far (studs) ahead of and behind a train it can be dragged at once. */
const REACH = 1000;
/** How near (studs) the track a truck or coupler must be to stand on it. */
const ON_TRACK = 1.5;
/** A drag shorter than this (studs) does nothing. */
const MIN_MOVE = 0.5;
/** An emptied cut is kept this long (someone offline may still couple to it). */
export const EMPTIED_KEEP_MS = 24 * 60 * 60 * 1000;

export function isEngine(s: RollingStock | undefined): boolean {
  return !!s && (s.kind === 'engine' || s.powered);
}

type Stock = ReadonlyMap<string, RollingStock>;

/** Which record a car standing in a cut is in (unset: not in any, or only in plain trains). */
function homes(trains: readonly Train[], stock: Stock): Map<string, string> {
  const byId = new Map(trains.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  const listers = new Map<string, Train[]>();
  for (const t of trains) {
    if (!t.position) continue;
    for (const u of t.units) {
      const l = listers.get(u.stock);
      if (!l) listers.set(u.stock, [t]);
      else if (l[l.length - 1] !== t) l.push(t);
    }
  }
  for (const [id, s] of stock) {
    const own = typeof s.opsCut === 'string' ? byId.get(s.opsCut) : undefined;
    if (own?.position) {
      out.set(id, own.id);
      continue;
    }
    const l = listers.get(id);
    if (!l || !l.some((t) => t.cut)) continue;
    const first = [...l].sort((a, b) => Number(!!a.cut) - Number(!!b.cut) || (a.id < b.id ? -1 : 1))[0]!;
    out.set(id, first.id);
  }
  return out;
}

/** The trains as they stand: each car of a cut in one place only, and none left out. */
export function settleTrains(trains: readonly Train[], stock: Stock): Train[] {
  const home = homes(trains, stock);
  if (home.size === 0) return [...trains];
  const missing = new Map<string, Set<string>>();
  for (const [car, id] of home) {
    let m = missing.get(id);
    if (!m) missing.set(id, (m = new Set()));
    m.add(car);
  }
  return trains.map((t) => {
    if (!t.position) return t;
    const left = missing.get(t.id);
    const units: Train['units'] = [];
    let same = true;
    for (const u of t.units) {
      const h = home.get(u.stock);
      if (h === undefined) units.push(u);
      else if (h === t.id && left!.delete(u.stock)) units.push(u);
      else same = false;
    }
    if (left && left.size > 0) {
      for (const car of [...left].sort()) units.push({ stock: car, reversed: false });
      same = false;
    }
    return same ? t : { ...t, units };
  });
}

/** The cut or train on the track a car is in (settled trains), or undefined. */
export function standingIn(car: string, trains: readonly Train[]): Train | undefined {
  return trains.find((t) => t.position && t.units.some((u) => u.stock === car));
}

// ---- the track a train can slide along -------------------------------------

/** One brick of the way, in the direction from far ahead to far behind: its start's distance (0: the head's front truck, - ahead). */
interface Seg {
  brick: string;
  enter: number;
  leave: number;
  d0: number;
  len: number;
  pts: CircuitPathPoint[];
}

interface Way {
  segs: Seg[];
  min: number;
  max: number;
  /** The track ends there (else the reach did). */
  endAhead: boolean;
  endBehind: boolean;
}

/** The track through a train, ahead of it and behind it, through switches as they are set. */
function wayThrough(net: TrackNetwork, at: TrainPosition, behind: number, states: Readonly<Record<string, number>>): Way | null {
  const enter = at.facing === 'to' ? at.to : at.from;
  const leave = at.facing === 'to' ? at.from : at.to;
  const pts = net.path(at.brick, enter, leave);
  if (pts.length < 2) return null;
  const len = pts[pts.length - 1]!.s;
  const s = Math.max(0, Math.min(at.s, len));
  const start = at.facing === 'to' ? len - s : s;
  const first: Seg = { brick: at.brick, enter, leave, d0: -start, len, pts };
  const exit = (brick: string, conn: number): number | null => {
    const exits = net.exits(brick, conn);
    if (exits.length === 0) return null;
    const sw = net.switchAt(switchKey(brick, conn));
    return sw ? net.settingOf(sw, states) : exits[0]!;
  };
  const back: Seg[] = [];
  let endBehind = false;
  let max = first.d0 + len;
  for (let cur = first; max < behind + REACH; ) {
    const next = net.partner({ brick: cur.brick, conn: cur.leave });
    const out = next ? exit(next.brick, next.conn) : null;
    if (!next || out === null || back.length >= 4000) {
      endBehind = true;
      break;
    }
    const p = net.path(next.brick, next.conn, out);
    cur = { brick: next.brick, enter: next.conn, leave: out, d0: max, len: p[p.length - 1]!.s, pts: p };
    back.push(cur);
    max += cur.len;
  }
  const front: Seg[] = [];
  let endAhead = false;
  let min = first.d0;
  for (let cur = first; min > -REACH; ) {
    const next = net.partner({ brick: cur.brick, conn: cur.enter });
    const out = next ? exit(next.brick, next.conn) : null;
    if (!next || out === null || front.length >= 4000) {
      endAhead = true;
      break;
    }
    const p = net.path(next.brick, out, next.conn);
    const l = p[p.length - 1]!.s;
    cur = { brick: next.brick, enter: out, leave: next.conn, d0: min - l, len: l, pts: p };
    front.push(cur);
    min -= l;
  }
  return { segs: [...front.reverse(), first, ...back], min, max, endAhead, endBehind };
}

/** Everywhere the way passes within `reach` of a point: the nearest spot on each brick that does. */
function project(way: Way, at: Pt, reach: number): { d: number; off: number }[] {
  const out: { d: number; off: number }[] = [];
  for (const g of way.segs) {
    const p0 = g.pts[0]!.p;
    // (No point of a brick's way is further from its start than its length.)
    if (Math.hypot(p0.x - at.x, p0.y - at.y) > g.len + reach) continue;
    let best = reach;
    let d = NaN;
    for (let k = 1; k < g.pts.length; k++) {
      const a = g.pts[k - 1]!;
      const b = g.pts[k]!;
      const dx = b.p.x - a.p.x;
      const dy = b.p.y - a.p.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.p.x) * dx + (at.y - a.p.y) * dy) / l2)) : 0;
      const off = Math.hypot(a.p.x + dx * t - at.x, a.p.y + dy * t - at.y);
      if (off <= best) {
        best = off;
        d = g.d0 + a.s + (b.s - a.s) * t;
      }
    }
    if (!Number.isNaN(d)) out.push({ d, off: best });
  }
  return out;
}

/** The position `d` along the way, facing ahead (or back). */
function positionAt(way: Way, d: number, ahead: boolean): TrainPosition {
  const g = way.segs.find((x) => d <= x.d0 + x.len + 1e-9) ?? way.segs[way.segs.length - 1]!;
  const s = Math.max(0, Math.min(g.len, d - g.d0));
  const from = Math.min(g.enter, g.leave);
  const to = Math.max(g.enter, g.leave);
  const towards = ahead ? g.enter : g.leave;
  return { brick: g.brick, from, to, s: g.enter === from ? s : g.len - s, facing: towards === to ? 'to' : 'from' };
}

/** How the switches between `d0` and `d1` (the head's end first when `ahead`) are passed by a train standing there. */
function overAt(net: TrackNetwork, way: Way, d0: number, d1: number, ahead: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of way.segs) {
    if (g.d0 + g.len < d0 || g.d0 > d1) continue;
    const enter = ahead ? g.enter : g.leave;
    const key = switchKey(g.brick, enter);
    if (net.switchAt(key)) out[key] = ahead ? g.leave : g.enter;
  }
  return out;
}

// ---- dragging ----------------------------------------------------------------

/** What a drag does: the records to write, whole, and the cut each of these cars is in now. */
export interface CutChange {
  trains: Train[];
  /** Car id -> the record it is in now (null: none). */
  cars: Record<string, string | null>;
  /** Cuts left with no cars (written with none, `emptiedAt` now). */
  emptied: string[];
}

export interface CutMove {
  /** The cars that move (ids), and how far (studs, + the way the train faces). */
  moved: string[];
  by: number;
  /** The record they couple to, or null. */
  couples: string | null;
  /** They stop against this one and don't couple (both are trains; one has no coupler there; too many cars). */
  blockedBy: string | null;
  why: 'trains' | 'coupler' | 'full' | null;
  change: CutChange;
}

export interface CutDrag {
  /** What dropping at `at` (studs) would do; null: nothing. */
  to(at: Pt): CutMove | null;
}

interface Other {
  train: Train;
  placed: PlacedTrain;
  /** The stretch of the way it stands on. */
  lo: number;
  hi: number;
}

const coupler = (s: RollingStock | undefined, reversed: boolean, front: boolean): string => {
  const end = front !== reversed ? 'front' : 'rear';
  return s?.couplers?.[end]?.type ?? 'magnet';
};

const turned = (units: Train['units']): Train['units'] => [...units].reverse().map((u) => ({ ...u, reversed: !u.reversed }));

/**
 * Start dragging the car at `unit` (its index among the placed cars) of
 * `trainId` on the track. `trains` are settled (settleTrains); `newId` names
 * the cut a split makes. Null when it can't be dragged.
 */
export function startDrag(
  net: TrackNetwork,
  trains: readonly Train[],
  stock: Stock,
  states: Readonly<Record<string, number>>,
  trainId: string,
  unit: number,
  newId: string,
): CutDrag | null {
  const train = trains.find((t) => t.id === trainId);
  if (!train?.position) return null;
  // The switches as the trains standing over them leave them.
  let walk: Record<string, number> = { ...states };
  for (const t of trains) if (t.position && t.id !== trainId) walk = { ...walk, ...t.over };
  walk = { ...walk, ...train.over };
  const placed = placeTrain(net, train, stock, states);
  if (!placed || unit < 0 || unit >= placed.units.length) return null;
  const n = placed.units.length;
  const tailD = placed.units[n - 1]!.back;
  const way = wayThrough(net, train.position, tailD, walk);
  if (!way) return null;
  // The placed cars' indexes among the train's units (a car whose record is gone isn't placed).
  const at: number[] = [];
  train.units.forEach((u, i) => {
    if (stock.has(u.stock) && at.length < n) at.push(i);
  });
  const front = (i: number) => {
    const s = stock.get(placed.units[i]!.stock)!;
    const u = placed.units[i]!;
    return u.frontD - (s.length / 2 - frontTruckOf(s, train.units[at[i]!]!.reversed));
  };
  const rear = (i: number) => placed.units[i]!.back;

  // The other trains standing on the way: the stretches they take up.
  const longest = Math.max(8, ...[...stock.values()].map((s) => s.length)) + 2;
  const others: Other[] = [];
  for (const t of trains) {
    if (!t.position || t.id === trainId) continue;
    const p = placeTrain(net, t, stock, states);
    if (!p || p.units.length === 0) continue;
    const ds: number[] = [];
    for (const u of p.units) for (const q of [u.frontTruck, u.rearTruck]) for (const x of project(way, q, ON_TRACK)) ds.push(x.d);
    for (const q of [p.units[0]!.frontCoupler, p.units[p.units.length - 1]!.rearCoupler]) for (const x of project(way, q, ON_TRACK)) ds.push(x.d);
    if (ds.length === 0) continue;
    ds.sort((a, b) => a - b);
    let lo = ds[0]!;
    let hi = lo;
    for (const d of ds) {
      if (d - hi > longest) {
        others.push({ train: t, placed: p, lo, hi });
        lo = d;
      }
      hi = d;
    }
    others.push({ train: t, placed: p, lo, hi });
  }
  const mid = (placed.units[unit]!.frontD + placed.units[unit]!.rearD) / 2;
  const whole = isEngine(stock.get(placed.units[unit]!.stock)) || n === 1;

  return {
    to(to: Pt): CutMove | null {
      // Where along the way the pointer is: the nearest spot, and of two as near (a loop), the one nearest the car.
      let best: number | null = null;
      let bestCost = Infinity;
      for (const x of project(way, to, Infinity)) {
        const cost = x.off + 0.02 * Math.abs(x.d - mid);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          best = x.d;
        }
      }
      if (best === null) return null;
      const want = best - mid; // - ahead
      if (Math.abs(want) < MIN_MOVE) return null;
      const ahead = want < 0;
      // The cars that come: those on the side it is dragged to (all of them with an engine, or when the rest isn't on the track).
      let first = whole || ahead ? 0 : unit;
      let last = whole || !ahead ? n - 1 : unit;
      if (last === n - 1 && first === 0) {
        // the whole train
      } else if (ahead && at[last + 1] === undefined) last = n - 1;
      const all = first === 0 && last === n - 1;
      if (all) {
        first = 0;
        last = n - 1;
      }
      // How far they can go: to the end of the track, or to another train.
      let free: number;
      let hit: Other | null = null;
      if (ahead) {
        const edge = front(first);
        free = way.endAhead ? placed.units[first]!.frontD - way.min : Math.max(0, placed.units[first]!.frontD - way.min - longest);
        for (const o of others) {
          if (o.hi > edge + COUPLE_REACH || o.hi < -REACH) continue;
          const gap = Math.max(0, edge - o.hi);
          if (gap < free + COUPLE_REACH && (!hit || o.hi > hit.hi)) {
            hit = o;
            free = Math.min(free, gap);
          }
        }
      } else {
        const edge = rear(last);
        free = way.endBehind ? way.max - placed.units[last]!.rearD : Math.max(0, way.max - placed.units[last]!.rearD - longest);
        for (const o of others) {
          if (o.lo < edge - COUPLE_REACH) continue;
          const gap = Math.max(0, o.lo - edge);
          if (gap < free + COUPLE_REACH && (!hit || o.lo < hit.lo)) {
            hit = o;
            free = Math.min(free, gap);
          }
        }
      }
      const gapLeft = free - Math.abs(want);
      const meets = hit !== null && gapLeft <= COUPLE_REACH;
      const dist = meets ? free : Math.min(Math.abs(want), free);
      const m = ahead ? -dist : dist;
      if (dist < 1e-6 && !meets) return null;
      // A split that moves nothing isn't one.
      if (!all && dist < MIN_MOVE && !meets) return null;

      const u0 = at[first]!;
      const u1 = all || last === n - 1 ? train.units.length - 1 : at[last + 1]! - 1;
      const movedUnits = all ? train.units : train.units.slice(u0, u1 + 1);
      const restUnits = all ? [] : [...train.units.slice(0, u0), ...train.units.slice(u1 + 1)];
      const change: CutChange = { trains: [], cars: {}, emptied: [] };
      const movedPos = positionAt(way, placed.units[first]!.frontD + m, true);
      const movedOver = overAt(net, way, placed.units[first]!.frontD + m, rear(last) + m, true);
      const hasEngine = (us: Train['units']) => us.some((u) => isEngine(stock.get(u.stock)));
      // Whose record stays: the part with the engine, else the cars left standing.
      const movedKeeps = all || (hasEngine(movedUnits) && !hasEngine(restUnits));
      const blank = (): Train => ({ id: newId, name: '', trackKind: train.trackKind, units: [], position: null, color: train.color, speed: train.speed, cut: true });
      let mover: Train = { ...(movedKeeps ? train : blank()), units: movedUnits, position: movedPos, over: movedOver };
      const splitIds: Train[] = [];
      if (!all) {
        const restFirst = ahead ? last + 1 : 0;
        const restLast = ahead ? n - 1 : first - 1;
        splitIds.push({
          ...(movedKeeps ? blank() : train),
          units: restUnits,
          position: restFirst === 0 ? train.position : positionAt(way, placed.units[restFirst]!.frontD, true),
          over: overAt(net, way, placed.units[restFirst]!.frontD, rear(restLast), true),
        });
      }
      const couple = meets && hit ? coupled(net, way, stock, mover, hit, { head: placed.units[first]!.frontD + m, tail: rear(last) + m }, ahead) : null;
      let couples: string | null = null;
      let blockedBy: string | null = null;
      let why: CutMove['why'] = null;
      if (couple && typeof couple !== 'string') {
        couples = hit!.train.id;
        const gone = couple.id === mover.id ? hit!.train : mover;
        // A cut coupled away is left with no cars, not deleted: someone coupling to it now still finds it.
        if (trains.some((t) => t.id === gone.id)) change.emptied.push(gone.id);
        mover = couple;
      } else if (meets && hit) {
        blockedBy = hit.train.id;
        why = couple as CutMove['why'];
        if (dist < 1e-6) return { moved: [], by: 0, couples: null, blockedBy, why, change };
      }
      change.trains.push(mover, ...splitIds);
      if (!all || couples) for (const t of change.trains) for (const u of t.units) change.cars[u.stock] = t.id;
      return { moved: movedUnits.map((u) => u.stock), by: m === 0 ? 0 : -m, couples, blockedBy, why, change };
    },
  };
}

/** A unit's front truck from its middle, the way it runs. */
function frontTruckOf(s: RollingStock, reversed: boolean): number {
  const ats = s.trucks.map((t) => t.at);
  return reversed ? -Math.min(...ats) : Math.max(...ats);
}

/** `mover` (its head at `span.head`, its rear coupler at `span.tail`) and the train it meets, as one; or why not. */
function coupled(net: TrackNetwork, way: Way, stock: Stock, mover: Train, hit: Other, span: { head: number; tail: number }, ahead: boolean): Train | 'trains' | 'coupler' | 'full' | null {
  const other = hit.train;
  if (!mover.cut && !other.cut) return 'trains';
  if (mover.units.length + other.units.length > CUT_LIMITS.units) return 'full';
  const o0 = hit.placed.units[0]!;
  const oN = hit.placed.units[hit.placed.units.length - 1]!;
  const edge = ahead ? hit.hi : hit.lo;
  const near = (p: Pt) => Math.min(Infinity, ...project(way, p, ON_TRACK).map((x) => Math.abs(x.d - edge)));
  const headOff = near(o0.frontCoupler);
  const tailOff = near(oN.rearCoupler);
  if (Math.min(headOff, tailOff) > COUPLE_REACH) return null;
  // Which of its ends is met: ahead of us its tail means it faces our way.
  const meetsHead = headOff < tailOff;
  const faces = ahead ? !meetsHead : meetsHead;
  if (!meetsHead && hit.placed.offTrack) return null;
  const known = (us: Train['units']) => us.filter((u) => stock.has(u.stock));
  const mine = known(mover.units);
  const theirs = known(other.units);
  const myEnd = ahead ? mine[0]! : mine[mine.length - 1]!;
  const theirEnd = meetsHead ? theirs[0]! : theirs[theirs.length - 1]!;
  if (coupler(stock.get(myEnd.stock), myEnd.reversed, ahead) === 'none') return 'coupler';
  if (coupler(stock.get(theirEnd.stock), theirEnd.reversed, meetsHead) === 'none') return 'coupler';
  // The whole, front to back the way we face.
  const oriented = faces ? other.units : turned(other.units);
  const units = ahead ? [...oriented, ...mover.units] : [...mover.units, ...oriented];
  const lo = Math.min(span.head, hit.lo);
  const hi = Math.max(span.tail, hit.hi);
  // Where one of its trucks is on the way, in the stretch it takes up.
  const onWay = (p: Pt): number | null => {
    const x = project(way, p, ON_TRACK)
      .filter((q) => q.d >= hit.lo - COUPLE_REACH && q.d <= hit.hi + COUPLE_REACH)
      .sort((a, b) => a.off - b.off)[0];
    return x ? x.d : null;
  };
  const engine = (t: Train) => t.units.some((u) => isEngine(stock.get(u.stock)));
  // Whose record it is: a train's before a cut's, then the one with an engine, then the one that stood still.
  const keep = !mover.cut ? mover : !other.cut ? other : engine(mover) && !engine(other) ? mover : other;
  const flip = keep === other && !faces;
  let position: TrainPosition;
  if (!flip) {
    if (!ahead) position = mover.position!;
    else if (faces) position = other.position!;
    else {
      const d = onWay(oN.rearTruck);
      if (d === null) return null;
      position = positionAt(way, d, true);
    }
  } else if (ahead) {
    // Turned to face as the other does: its head is at our tail.
    const s = stock.get(mine[mine.length - 1]!.stock)!;
    const u = mine[mine.length - 1]!;
    const rearTruck = u.reversed ? -Math.max(...s.trucks.map((t) => t.at)) : Math.min(...s.trucks.map((t) => t.at));
    position = positionAt(way, span.tail - (s.length / 2 + rearTruck), false);
  } else position = other.position!;
  const over = { ...(keep === other ? mover.over : other.over), ...(keep === other ? other.over : mover.over), ...overAt(net, way, lo, hi, !flip) };
  return { ...keep, units: flip ? turned(units) : units, position, over };
}

/**
 * Take a car out of the cut or train it stands in: the cars ahead of it and
 * those behind stay where they are (two cuts, when it was between them;
 * `newId` names the other). `trains` are settled.
 */
export function takeOut(
  net: TrackNetwork,
  trains: readonly Train[],
  stock: Stock,
  states: Readonly<Record<string, number>>,
  car: string,
  newId: string,
): CutChange {
  const change: CutChange = { trains: [], cars: { [car]: null }, emptied: [] };
  const train = standingIn(car, trains);
  if (!train) return change;
  const i = train.units.findIndex((u) => u.stock === car);
  const ahead = train.units.slice(0, i);
  const behind = train.units.slice(i + 1);
  if (ahead.length === 0 && behind.length === 0) {
    if (train.cut) change.emptied.push(train.id);
    else change.trains.push({ ...train, units: [], position: null });
    return change;
  }
  const placed = placeTrain(net, train, stock, states);
  const way = placed ? wayThrough(net, train.position!, placed.units.at(-1)?.back ?? 0, { ...states, ...train.over }) : null;
  const next = placed?.units.findIndex((u) => u.stock === behind[0]?.stock) ?? -1;
  if (behind.length === 0 || !way || next < 0) {
    // Nothing placed behind it: the rest keeps its place.
    change.trains.push({ ...train, units: [...ahead, ...behind] });
    return change;
  }
  const units = placed!.units;
  const there = { position: positionAt(way, units[next]!.frontD, true), over: overAt(net, way, units[next]!.frontD, units[units.length - 1]!.back, true) };
  if (ahead.length === 0) {
    change.trains.push({ ...train, units: behind, ...there });
    return change;
  }
  const engine = (us: Train['units']) => us.some((u) => isEngine(stock.get(u.stock)));
  const backKeeps = engine(behind) && !engine(ahead);
  const blank: Train = { id: newId, name: '', trackKind: train.trackKind, units: [], position: null, color: train.color, speed: train.speed, cut: true };
  change.trains.push({ ...(backKeeps ? blank : train), units: ahead, position: train.position, over: train.over ?? {} }, { ...(backKeeps ? train : blank), units: behind, ...there });
  for (const t of change.trains) for (const u of t.units) change.cars[u.stock] = t.id;
  return change;
}

/** Cars put on the track at `position` as a new cut (each already taken out of where it stood). */
export function newCut(id: string, cars: readonly RollingStock[], position: TrainPosition): Train {
  return { id, name: '', trackKind: cars[0]?.trackKind ?? 'rail', units: cars.map((s) => ({ stock: s.id, reversed: false })), position, color: cars[0]?.look.color ?? '#B40000', speed: 40, cut: true, over: {} };
}

/** A train turned round (turnedAround), standing over switches as it does. */
export function turnStanding(net: TrackNetwork, train: Train, stock: Stock, states: Readonly<Record<string, number>>): Train {
  const out = turnedAround(net, train, stock, states);
  if (!train.over) return out;
  const placed = placeTrain(net, train, stock, states);
  const way = train.position && placed?.units.length ? wayThrough(net, train.position, placed.units.at(-1)!.back, { ...states, ...train.over }) : null;
  return way ? { ...out, over: overAt(net, way, 0, placed!.units.at(-1)!.back, false) } : out;
}

/** How a train standing as it does now passes the switches under it (`over`). */
export function standOver(net: TrackNetwork, train: Train, stock: Stock, states: Readonly<Record<string, number>>): Record<string, number> {
  const placed = placeTrain(net, train, stock, states);
  const way = train.position && placed?.units.length ? wayThrough(net, train.position, placed.units.at(-1)!.back, { ...states, ...train.over }) : null;
  return way ? overAt(net, way, 0, placed!.units.at(-1)!.back, true) : {};
}
