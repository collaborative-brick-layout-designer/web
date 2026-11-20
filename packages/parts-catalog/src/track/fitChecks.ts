// Fit checks (trains design 3.3, 3.5): computed from the track and the
// trains on it, never stored. Track runs and their usable lengths (between
// fouling points, bumpers and switches: the siding lengths), and, for each
// train on the map, whether it fits its run, whether its trucks and
// couplers can take the curves, whether its cars clear the other tracks
// and trains, and whether it is on its kind of track; for each route,
// whether it turns the train around (and on powered track, needs a
// polarity switch). Each result is a kind, a severity, what it is about,
// the numbers, and a place to show. The words are each app's own. The
// desktop's src/track/FitChecks.cpp is the twin; both check
// fixtures/contracts/train-geometry.json.

import { pointAt as pathPointAt, type Pt } from './circuitPath.js';
import { switchKey, type SwitchPoint, type TrackNetwork, type TrackPosition } from './network.js';
import { routeStatus, type Route, type RouteStep } from './routes.js';
import { TRACK_KINDS, type TrackKindDefaults } from './tables.js';
import { lineAt, placeTrain, trainLength, type PlacedTrain, type RollingStock, type TrackLine, type Train } from './trains.js';

// ---- overhang on a curve (3.3) ---------------------------------------------

export interface Overhang {
  /** How far the body's middle swings inside the track, studs. */
  middle: number;
  /** How far the body's ends swing outside it, studs. */
  end: number;
  /** How far the outer corners pass the track's outer edge (half a car width out), studs. */
  corner: number;
  /** How far each truck turns under the body, degrees. */
  swivel: number;
}

/** A car of `bodyLength` x `width` on trucks `truckSpacing` apart, on a curve of `radius` (studs). */
export function overhang(radius: number, truckSpacing: number, bodyLength: number, width: number): Overhang {
  const a = truckSpacing / 2;
  const b = bodyLength / 2;
  const d = Math.sqrt(Math.max(0, radius * radius - a * a));
  return {
    middle: radius - d,
    end: Math.hypot(d, b) - radius,
    corner: Math.hypot(d + width / 2, b) - (radius + width / 2),
    swivel: (Math.asin(Math.min(1, a / radius)) * 180) / Math.PI,
  };
}

/** The kind's defaults (rail's when it has none). */
export function kindDefaults(kind: string | null | undefined): TrackKindDefaults {
  return TRACK_KINDS.kinds[kind ?? 'rail'] ?? TRACK_KINDS.kinds.rail!;
}

// ---- lines along the track ---------------------------------------------------

/** The track ahead from the start of the way `from` -> `to` through `brick`, `length` studs, through switches as set. */
export function lineAhead(net: TrackNetwork, brick: string, from: number, to: number, length: number, states: Readonly<Record<string, number>> = {}): TrackLine {
  const out: TrackLine['pts'] = [];
  let d = 0;
  let b = brick;
  let enter = from;
  let leave = to;
  for (let guard = 0; guard < 100000; guard++) {
    const pts = net.path(b, enter, leave);
    if (pts.length < 2) return { pts: out, ended: true };
    for (const q of pts) {
      const prev = out[out.length - 1];
      if (prev) {
        const step = Math.hypot(q.p.x - prev.p.x, q.p.y - prev.p.y);
        if (step < 1e-9) continue;
        d += step;
      }
      out.push({ p: q.p, d, brick: b });
      if (d >= length) return { pts: out, ended: false };
    }
    const next = net.partner({ brick: b, conn: leave });
    if (!next) return { pts: out, ended: true };
    b = next.brick;
    enter = next.conn;
    const exits = net.exits(b, enter);
    if (exits.length === 0) return { pts: out, ended: true };
    const sw = net.switchAt(switchKey(b, enter));
    leave = sw ? net.settingOf(sw, states) : exits[0]!;
  }
  return { pts: out, ended: true };
}

/**
 * How far past the end of a switch's leg its fouling point is: the first
 * place, measured from the heel along both legs, where they are `clearance`
 * apart (0 when that is inside the switch). Studs; `max` when never.
 */
export function foulingBeyond(net: TrackNetwork, sw: SwitchPoint, leg: number, clearance: number, max = 200): number {
  const legLength = net.pathLength(sw.brick, sw.heel, leg);
  let worst = 0;
  for (const other of sw.exits) {
    if (other === leg) continue;
    const a = lineAhead(net, sw.brick, sw.heel, leg, max);
    const b = lineAhead(net, sw.brick, sw.heel, other, max);
    const end = Math.min(a.pts[a.pts.length - 1]?.d ?? 0, b.pts[b.pts.length - 1]?.d ?? 0);
    let foul = max;
    for (let k = 0; k * 0.25 <= end + 1e-9; k++) {
      const s = k * 0.25;
      const p = lineAt(a, s);
      const q = lineAt(b, s);
      if (p && q && Math.hypot(p.x - q.x, p.y - q.y) >= clearance) {
        foul = s;
        break;
      }
    }
    worst = Math.max(worst, foul - legLength);
  }
  return Math.max(0, worst);
}

// ---- track runs: the siding lengths ----------------------------------------------

export interface RunEnd {
  /** end: a bumper or open end; heel: a switch's heel; leg: one of a switch's legs; loop: none (a ring). */
  kind: 'end' | 'heel' | 'leg' | 'loop';
  /** The switch there (heel and leg). */
  switch?: string;
  /** How much of the run its fouling point takes, studs (legs only). */
  foul: number;
}

export interface TrackRun {
  /** The ways through each part, end to end. */
  steps: RouteStep[];
  /** Studs, end to end. */
  length: number;
  /** What a train can stand in: the length less the fouling points at switch legs. */
  usable: number;
  ends: [RunEnd, RunEnd];
  /** Its middle, for its label (studs). */
  middle: Pt;
}

const pathKey = (brick: string, a: number, b: number) => `${brick}\u0000${Math.min(a, b)}\u0000${Math.max(a, b)}`;

/**
 * The network's runs of track between switches, bumpers and open ends (and
 * rings with no switch at all), each with its usable length (design 3.5).
 */
export function trackRuns(net: TrackNetwork): TrackRun[] {
  const switchBricks = new Set(net.switches.map((s) => s.brick));
  const visited = new Set<string>();
  const runs: TrackRun[] = [];
  const endAt = (brick: string, conn: number): RunEnd => {
    const leg = net.switches.find((s) => s.brick === brick && s.heel !== conn && s.exits.includes(conn));
    if (leg) return { kind: 'leg', switch: leg.key, foul: foulingBeyond(net, leg, conn, kindDefaults(net.kindOf(brick)).clearance) };
    const heel = net.switches.find((s) => s.brick === brick && s.heel === conn) ?? net.switches.find((s) => s.brick === brick);
    return heel ? { kind: 'heel', switch: heel.key, foul: 0 } : { kind: 'heel', foul: 0 };
  };
  // A run from (brick, enter) on a simple part to its far end.
  const walk = (brick: string, enter: number, start: RunEnd) => {
    const steps: RouteStep[] = [];
    let b = brick;
    let e = enter;
    let end: RunEnd = { kind: 'end', foul: 0 };
    for (let guard = 0; guard < 100000; guard++) {
      const exits = net.exits(b, e);
      if (exits.length === 0) break;
      const to = exits[0]!;
      if (visited.has(pathKey(b, e, to))) {
        end = { kind: 'loop', foul: 0 };
        break;
      }
      visited.add(pathKey(b, e, to));
      steps.push({ brick: b, from: e, to });
      const p = net.partner({ brick: b, conn: to });
      if (!p) break;
      if (switchBricks.has(p.brick)) {
        end = endAt(p.brick, p.conn);
        break;
      }
      b = p.brick;
      e = p.conn;
    }
    if (steps.length === 0) return;
    const ends: [RunEnd, RunEnd] = end.kind === 'loop' ? [{ kind: 'loop', foul: 0 }, end] : [start, end];
    runs.push(finish(net, steps, ends));
  };
  const ports = (brick: string) => [...new Set(net.trackOf(brick)!.paths.flat())].sort((a, b) => a - b);
  // From each switch, out of each of its connections.
  for (const brick of net.brickIds) {
    if (!switchBricks.has(brick)) continue;
    for (const c of ports(brick)) {
      const q = net.partner({ brick, conn: c });
      if (!q || switchBricks.has(q.brick)) continue;
      const exits = net.exits(q.brick, q.conn);
      if (exits.length === 0 || visited.has(pathKey(q.brick, q.conn, exits[0]!))) continue;
      walk(q.brick, q.conn, endAt(brick, c));
    }
  }
  // From each open end.
  for (const brick of net.brickIds) {
    if (switchBricks.has(brick)) continue;
    for (const c of ports(brick)) {
      if (net.partner({ brick, conn: c })) continue;
      const exits = net.exits(brick, c);
      if (exits.length === 0 || visited.has(pathKey(brick, c, exits[0]!))) continue;
      walk(brick, c, { kind: 'end', foul: 0 });
    }
  }
  // Rings with no switch.
  for (const brick of net.brickIds) {
    if (switchBricks.has(brick)) continue;
    for (const [i, j] of net.trackOf(brick)!.paths) if (!visited.has(pathKey(brick, i, j))) walk(brick, i, { kind: 'loop', foul: 0 });
  }
  return runs;
}

function finish(net: TrackNetwork, steps: RouteStep[], ends: [RunEnd, RunEnd]): TrackRun {
  let length = 0;
  for (const s of steps) length += net.pathLength(s.brick, s.from, s.to);
  const usable = ends[0].kind === 'loop' ? length : Math.max(0, length - ends[0].foul - ends[1].foul);
  // Its middle: half way along.
  let left = length / 2;
  let middle: Pt = net.port(steps[0]!.brick, steps[0]!.from)?.p ?? { x: 0, y: 0 };
  for (const s of steps) {
    const pts = net.path(s.brick, s.from, s.to);
    const len = pts.length ? pts[pts.length - 1]!.s : 0;
    if (left <= len) {
      middle = pathPointAt(pts, left).p;
      break;
    }
    left -= len;
  }
  return { steps, length, usable, ends, middle };
}

/** The run a place on the track is in (none on a switch). */
export function runAt(runs: readonly TrackRun[], pos: Pick<TrackPosition, 'brick' | 'from' | 'to'>): TrackRun | undefined {
  const key = pathKey(pos.brick, pos.from, pos.to);
  return runs.find((r) => r.steps.some((s) => pathKey(s.brick, s.from, s.to) === key));
}

// ---- the checks ---------------------------------------------------------------

export type FitCheckKind =
  /** A train longer than the track it stands in (between its fouling points). */
  | 'siding'
  /** A curve too tight for a car's trucks. */
  | 'truck'
  /** Two cars at too sharp an angle for their couplers, or too far apart to couple. */
  | 'coupler'
  /** A coupler that can't couple (none) between two cars. */
  | 'uncoupled'
  /** A car's body over another track's clearance. */
  | 'clearance'
  /** Two trains' cars on top of each other. */
  | 'overlap'
  /** A car on another kind of track (a rail car on monorail). */
  | 'trackKind'
  /** A train running off the end of the track. */
  | 'offEnd'
  /** A train whose track was moved or removed. */
  | 'lost'
  /** A route that turns the train around (a reversing loop or wye). */
  | 'reverse'
  /** ... on powered track: it needs a polarity switch. */
  | 'power';

export interface FitCheck {
  /** Stable while the problem lasts (a key for lists). */
  key: string;
  kind: FitCheckKind;
  severity: 'error' | 'warning';
  train?: string;
  route?: string;
  /** The car (a stock id) it's about, and its place in the train (0: the front). */
  stock?: string;
  unit?: number;
  /** The other train (overlap), or the brick (clearance, reverse, power). */
  other?: string;
  /** Where to show it (studs). */
  at: Pt;
  /** The numbers the words need: lengths in studs, angles in degrees. */
  values: Record<string, number>;
}

interface Rect {
  c: Pt;
  ux: number;
  uy: number;
  half: number;
  halfW: number;
}

function rectOf(u: PlacedTrain['units'][number], s: RollingStock): Rect {
  const rad = (u.angle * Math.PI) / 180;
  return { c: u.centre, ux: Math.cos(rad), uy: Math.sin(rad), half: (s.bodyLength > 0 ? s.bodyLength : s.length - 2) / 2, halfW: s.width / 2 };
}

function corners(r: Rect): Pt[] {
  const out: Pt[] = [];
  for (const [i, j] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const)
    out.push({ x: r.c.x + r.ux * r.half * i - r.uy * r.halfW * j, y: r.c.y + r.uy * r.half * i + r.ux * r.halfW * j });
  return out;
}

/** A point in the rectangle's own frame (along, across). */
function local(r: Rect, p: Pt): Pt {
  const dx = p.x - r.c.x;
  const dy = p.y - r.c.y;
  return { x: dx * r.ux + dy * r.uy, y: -dx * r.uy + dy * r.ux };
}

/** Distance from a segment to the rectangle (0 when they touch). */
function segRectDistance(r: Rect, a: Pt, b: Pt): number {
  const p = local(r, a);
  const q = local(r, b);
  const inside = (t: Pt) => Math.abs(t.x) <= r.half && Math.abs(t.y) <= r.halfW;
  if (inside(p) || inside(q)) return 0;
  // Crossing an edge?
  const box = [{ x: -r.half, y: -r.halfW }, { x: r.half, y: -r.halfW }, { x: r.half, y: r.halfW }, { x: -r.half, y: r.halfW }];
  const cross = (o: Pt, u: Pt, v: Pt) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
  for (let k = 0; k < 4; k++) {
    const e1 = box[k]!;
    const e2 = box[(k + 1) % 4]!;
    if (cross(p, q, e1) * cross(p, q, e2) < 0 && cross(e1, e2, p) * cross(e1, e2, q) < 0) return 0;
  }
  const pointBox = (t: Pt) => Math.hypot(Math.max(0, Math.abs(t.x) - r.half), Math.max(0, Math.abs(t.y) - r.halfW));
  const pointSeg = (t: Pt) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((t.x - p.x) * dx + (t.y - p.y) * dy) / l2)) : 0;
    return Math.hypot(p.x + dx * f - t.x, p.y + dy * f - t.y);
  };
  return Math.min(pointBox(p), pointBox(q), ...box.map(pointSeg));
}

/** Whether two rectangles overlap (separating axes). */
function rectsOverlap(a: Rect, b: Rect): boolean {
  const ca = corners(a);
  const cb = corners(b);
  for (const [ux, uy] of [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]] as const) {
    const pa = ca.map((p) => p.x * ux + p.y * uy);
    const pb = cb.map((p) => p.x * ux + p.y * uy);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false;
  }
  return true;
}

/** The track's heading at `d` on the line (towards the head), degrees. */
function headingAt(line: TrackLine, d: number): number | null {
  const ahead = lineAt(line, Math.max(0, d - 0.5));
  const behind = lineAt(line, d + 0.5) ?? lineAt(line, d);
  if (!ahead || !behind || (ahead.x === behind.x && ahead.y === behind.y)) return null;
  return (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
}

/** |a - b| for angles in degrees, folded to [0, 90] (a truck or coupler turns either way). */
function turn(a: number, b: number): number {
  let d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  if (d > 90) d = 180 - d;
  return d;
}

/** The running order's coupler at one end of a unit (turned round: its other end). */
function couplerAt(s: RollingStock, reversed: boolean, end: 'front' | 'rear') {
  const which = reversed ? (end === 'front' ? 'rear' : 'front') : end;
  return s.couplers?.[which] ?? { type: 'magnet', swivelMax: 37 };
}

export interface FitInput {
  trains: readonly Train[];
  stock: ReadonlyMap<string, RollingStock>;
  routes?: readonly Route[];
  states?: Readonly<Record<string, number>>;
  /** Placements already worked out (the map's), by train id. */
  placed?: ReadonlyMap<string, PlacedTrain | null>;
  /** The runs already worked out. */
  runs?: readonly TrackRun[];
}

/** Every fit check for the trains on the map and the routes (design 3.5), in a stable order. */
export function fitChecks(net: TrackNetwork, input: FitInput): FitCheck[] {
  const states = input.states ?? {};
  const runs = input.runs ?? trackRuns(net);
  const out: FitCheck[] = [];
  const rects: { train: string; unit: number; rect: Rect }[] = [];
  for (const t of input.trains) {
    if (!t.position) continue;
    const placed = input.placed?.has(t.id) ? input.placed.get(t.id)! : placeTrain(net, t, input.stock, states);
    const head = net.pointAt(t.position);
    if (!placed || !head) {
      out.push({ key: `lost:${t.id}`, kind: 'lost', severity: 'warning', train: t.id, at: head?.p ?? { x: 0, y: 0 }, values: {} });
      continue;
    }
    if (placed.offTrack) {
      const last = placed.units[placed.units.length - 1];
      out.push({ key: `offEnd:${t.id}`, kind: 'offEnd', severity: 'warning', train: t.id, at: last?.rearCoupler ?? head.p, values: {} });
    }
    // The track it stands in.
    const run = runAt(runs, t.position);
    const length = trainLength(t, input.stock);
    if (run && run.ends[0].kind !== 'loop' && length > run.usable + 1e-6)
      out.push({ key: `siding:${t.id}`, kind: 'siding', severity: 'warning', train: t.id, at: run.middle, values: { length, usable: run.usable } });
    const kind = net.kindOf(t.position.brick);
    const units = t.units.filter((u) => input.stock.has(u.stock));
    placed.units.forEach((u, i) => {
      const unit = units[i]!;
      const s = input.stock.get(u.stock)!;
      // Its kind of track.
      if (kind && s.trackKind && s.trackKind !== kind)
        out.push({ key: `trackKind:${t.id}:${i}`, kind: 'trackKind', severity: 'error', train: t.id, stock: s.id, unit: i, at: u.centre, values: {} });
      // Its trucks on the curve.
      if (placed.line) {
        let worst = 0;
        let at = u.frontTruck;
        let limit = Infinity;
        for (const [d, p] of [[u.frontD, u.frontTruck], [u.rearD, u.rearTruck]] as const) {
          const h = headingAt(placed.line, d);
          if (h === null) continue;
          const a = turn(h, u.angle);
          if (a > worst) {
            worst = a;
            at = p;
          }
        }
        for (const tr of s.trucks) limit = Math.min(limit, tr.swivelMax);
        if (worst > limit + 1e-6)
          out.push({ key: `truck:${t.id}:${i}`, kind: 'truck', severity: 'warning', train: t.id, stock: s.id, unit: i, at, values: { angle: worst, max: limit } });
      }
      // Its coupling to the car ahead.
      if (i > 0) {
        const prev = placed.units[i - 1]!;
        const prevUnit = units[i - 1]!;
        const ps = input.stock.get(prev.stock)!;
        const behind = couplerAt(ps, prevUnit.reversed, 'rear');
        const ahead = couplerAt(s, unit.reversed, 'front');
        const at = { x: (prev.rearCoupler.x + u.frontCoupler.x) / 2, y: (prev.rearCoupler.y + u.frontCoupler.y) / 2 };
        if (behind.type === 'none' || ahead.type === 'none') {
          out.push({ key: `uncoupled:${t.id}:${i}`, kind: 'uncoupled', severity: 'warning', train: t.id, stock: s.id, unit: i, at, values: {} });
        } else {
          // Each coupler takes half the angle between the bodies.
          const angle = turn(prev.angle, u.angle) / 2;
          const max = Math.min(behind.swivelMax, ahead.swivelMax);
          const gap = Math.hypot(prev.rearCoupler.x - u.frontCoupler.x, prev.rearCoupler.y - u.frontCoupler.y);
          if (angle > max + 1e-6 || gap > 1)
            out.push({ key: `coupler:${t.id}:${i}`, kind: 'coupler', severity: 'warning', train: t.id, stock: s.id, unit: i, at, values: { angle, max, gap } });
        }
      }
      rects.push({ train: t.id, unit: i, rect: rectOf(u, s) });
    });
    // Clearance: its cars against the other tracks (not the ones it stands on).
    if (placed.line) {
      // The parts under the train: from just ahead of its front coupler to just past its rear one.
      const lastBack = placed.units.length ? placed.units[placed.units.length - 1]!.back : 0;
      const pts = placed.line.pts;
      const occupied = new Set<string>([t.position.brick]);
      for (let k = 1; k < pts.length; k++) if (pts[k - 1]!.d <= lastBack + 2) occupied.add(pts[k]!.brick);
      const first = placed.units[0];
      if (first) {
        const fs = input.stock.get(first.stock)!;
        const reach = Math.max(0, fs.length / 2 - Math.max(...fs.trucks.map((x) => Math.abs(x.at)))) + 2;
        const head = t.position;
        const ahead = head.facing === 'to'
          ? lineAhead(net, head.brick, head.from, head.to, net.pathLength(head.brick, head.from, head.to) + reach, states)
          : lineAhead(net, head.brick, head.to, head.from, net.pathLength(head.brick, head.from, head.to) + reach, states);
        for (const p of ahead.pts) occupied.add(p.brick);
      }
      const band = kindDefaults(kind).carWidth / 2 + 0.5;
      placed.units.forEach((u, i) => {
        const s = input.stock.get(u.stock)!;
        const r = rectOf(u, s);
        const reach = Math.hypot(r.half, r.halfW) + band;
        for (const brick of net.brickIds) {
          if (occupied.has(brick)) continue;
          let hit: Pt | null = null;
          for (const [a, b] of net.trackOf(brick)!.paths) {
            const pts = net.path(brick, a, b);
            for (let k = 1; k < pts.length && !hit; k++) {
              const p = pts[k - 1]!.p;
              const q = pts[k]!.p;
              // (far away: skip)
              if (segPointDistance(p, q, r.c) > reach) continue;
              if (segRectDistance(r, p, q) < band - 1e-6) hit = closestOnSeg(p, q, r.c);
            }
            if (hit) break;
          }
          if (hit) {
            out.push({ key: `clearance:${t.id}:${i}:${brick}`, kind: 'clearance', severity: 'warning', train: t.id, stock: s.id, unit: i, other: brick, at: hit, values: {} });
            break;
          }
        }
      });
    }
  }
  // Trains on top of each other.
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.train === b.train || !rectsOverlap(a.rect, b.rect)) continue;
      if (out.some((c) => c.kind === 'overlap' && c.train === a.train && c.other === b.train)) continue;
      out.push({ key: `overlap:${a.train}:${b.train}`, kind: 'overlap', severity: 'error', train: a.train, other: b.train, unit: a.unit, at: a.rect.c, values: {} });
    }
  // Routes that turn the train around.
  for (const r of input.routes ?? []) {
    const st = routeStatus(net, r, states);
    if (st.status !== 'ok') continue;
    for (const brick of st.turnsAround) {
      const step = r.steps.find((s) => s.brick === brick);
      const at = (step && net.pointAt({ brick, from: step.from, to: step.to, s: net.pathLength(brick, step.from, step.to) / 2 })?.p) ?? { x: 0, y: 0 };
      out.push({ key: `reverse:${r.id}:${brick}`, kind: 'reverse', severity: 'warning', route: r.id, other: brick, at, values: {} });
      if (net.isPowered(brick)) out.push({ key: `power:${r.id}:${brick}`, kind: 'power', severity: 'warning', route: r.id, other: brick, at, values: {} });
    }
  }
  return out;
}

function closestOnSeg(p: Pt, q: Pt, t: Pt): Pt {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const l2 = dx * dx + dy * dy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((t.x - p.x) * dx + (t.y - p.y) * dy) / l2)) : 0;
  return { x: p.x + dx * f, y: p.y + dy * f };
}

function segPointDistance(p: Pt, q: Pt, t: Pt): number {
  const c = closestOnSeg(p, q, t);
  return Math.hypot(c.x - t.x, c.y - t.y);
}
