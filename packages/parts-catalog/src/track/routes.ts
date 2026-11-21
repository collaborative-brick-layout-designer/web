// Named routes (trains design 2.5, 3.4, 4): finding a way along the track
// from one place to another, the switch settings it needs, and checking a
// saved route against the track as it is now. The desktop's
// src/track/Routes.cpp is the twin; both check
// fixtures/contracts/route-search.json.
//
// A search state is a directed step: a way through one brick, entered at
// `from` and left at `to`, so the way a train faces is part of it. From a
// step, the next ones are the ways through the brick linked at `to`,
// entered there. Inside a switch a train can't go frog to frog (the part's
// paths leave that out). A train never turns round on the spot; it may run
// the whole loop round, past its own start, and through a switch more than
// once. Cost is length; the shortest way wins, ties going to the lower
// brick id and connection.

import { pointAt, type CircuitPathPoint, type Pt } from './circuitPath.js';
import { switchKey, type TrackNetwork, type TrackPosition } from './network.js';

/** One way through one brick, in the direction the route takes it. */
export interface RouteStep {
  brick: string;
  from: number;
  to: number;
}

/** A stop on the way. `reverse`: the train turns round there (not searched yet: kept for later). */
export interface RouteVia {
  at: TrackPosition;
  reverse?: boolean;
}

/** A named route as the layout keeps it (sidecar `routes`, live doc `meta.routes`). */
export interface Route {
  id: string;
  name: string;
  /** The train it is for, or null (trains come in a later phase). */
  train: string | null;
  from: TrackPosition;
  to: TrackPosition;
  via: RouteVia[];
  /** The exact way chosen, in order: two routes of equal length don't swap. */
  steps: RouteStep[];
  color: string;
  [extra: string]: unknown;
}

export interface RouteFound {
  steps: RouteStep[];
  /** Studs, from the start position to the end position. */
  length: number;
  /** Switch key → the exit the route needs. */
  switches: Record<string, number>;
  /** Bricks the route runs through both ways: it turns the train round (a reversing loop or wye). */
  turnsAround: string[];
  /** Which way it leaves the start: towards the start position's `to`, or its `from`. */
  facing: Facing;
  /** Switches it leaves by both legs (it runs through them twice): one has to be flipped on the way. */
  bothWays: string[];
}

/** Which way along a position's path: towards its `to`, or its `from` (a train's `facing`). */
export type Facing = 'to' | 'from';

export type RouteProblem = 'noTrack' | 'turnAround' | 'samePlace';

export interface FindOptions {
  via?: readonly TrackPosition[];
  /** Follow the switches as they are set (where does a train go now?), not any way. */
  followSwitches?: boolean;
  states?: Readonly<Record<string, number>>;
  /** The way the train leaves the start (a train's own facing, or the person's pick); either way when left out. */
  facing?: Facing;
}

const stepKey = (s: RouteStep) => `${s.brick}\u0000${s.from}\u0000${s.to}`;

/** Where a position is along a step, studs from the step's start. */
export function offsetOnStep(net: TrackNetwork, pos: TrackPosition, step: RouteStep): number {
  const len = net.pathLength(step.brick, step.from, step.to);
  const s = Math.max(0, Math.min(pos.s, len));
  return pos.from === step.from ? s : len - s;
}

/** Whether a position lies on a step's way through its brick. */
function onStep(pos: TrackPosition, step: RouteStep): boolean {
  return pos.brick === step.brick && ((pos.from === step.from && pos.to === step.to) || (pos.from === step.to && pos.to === step.from));
}

/** The nearest place on the track to `at` (studs), within `reach`; null when no track is that close. */
export function nearestPosition(net: TrackNetwork, at: Pt, reach: number): TrackPosition | null {
  let best: TrackPosition | null = null;
  let bestD = reach;
  for (const id of net.brickIds) {
    for (const [i, j] of net.trackOf(id)!.paths) {
      const pts = net.path(id, i, j);
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]!;
        const b = pts[k]!;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.p.x) * dx + (at.y - a.p.y) * dy) / l2)) : 0;
        const d = Math.hypot(a.p.x + dx * t - at.x, a.p.y + dy * t - at.y);
        if (d < bestD - 1e-9) {
          bestD = d;
          best = { brick: id, from: i, to: j, s: a.s + (b.s - a.s) * t };
        }
      }
    }
  }
  return best;
}

/** One way a search can be at a place: on `step`, `s` studs along it, `cost` studs from the start, by `steps`. */
interface Arrival {
  step: RouteStep;
  s: number;
  cost: number;
  steps: RouteStep[];
}

/** How close (studs) another way through a brick must pass to count as the same place: a switch's legs share their heel end. */
const SAME_SPOT = 0.5;

/** Where `at` falls on a path: the distance to it and how far along (studs). */
function projectOnPath(pts: readonly CircuitPathPoint[], at: Pt): { d: number; s: number } {
  let best = { d: Infinity, s: 0 };
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const dx = b.p.x - a.p.x;
    const dy = b.p.y - a.p.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((at.x - a.p.x) * dx + (at.y - a.p.y) * dy) / l2)) : 0;
    const d = Math.hypot(a.p.x + dx * t - at.x, a.p.y + dy * t - at.y);
    if (d < best.d - 1e-9) best = { d, s: a.s + (b.s - a.s) * t };
  }
  return best;
}

/**
 * A place and the same place on the brick's other ways through it: a click
 * on a switch's heel end is on every leg there, so the search may take
 * whichever leg it needs. Each is written so that heading towards its `to`
 * is the same way along the track as heading towards `pos.to`.
 */
export function sameSpot(net: TrackNetwork, pos: TrackPosition): TrackPosition[] {
  const out = [pos];
  const t = net.trackOf(pos.brick);
  const at = net.pointAt(pos)?.p;
  if (!t || !at) return out;
  for (const [i, j] of t.paths) {
    if ((i === pos.from && j === pos.to) || (i === pos.to && j === pos.from)) continue;
    const shared = i === pos.from || i === pos.to ? i : j === pos.from || j === pos.to ? j : -1;
    if (shared < 0) continue;
    const other = shared === i ? j : i;
    const alt = shared === pos.to ? { brick: pos.brick, from: other, to: shared } : { brick: pos.brick, from: shared, to: other };
    const hit = projectOnPath(net.path(alt.brick, alt.from, alt.to), at);
    if (hit.d <= SAME_SPOT) out.push({ ...alt, s: hit.s });
  }
  return out;
}

/**
 * One leg of a search: from each of `sources` (a train already on its step,
 * heading towards the step's `to`) to any of `targets`. Every way it can
 * arrive comes back, cheapest first found, one per step: the next leg
 * starts from each, so a stop reached the long way round, facing the other
 * way, can still lead on. A source is its own search node (only part of
 * its step is ahead of it), so the way may come round and run the whole of
 * that step again: a train may pass its own start, or a stop, and go on.
 * `last`: only the cheapest arrival matters, so stop once it is sure.
 */
function searchLeg(net: TrackNetwork, sources: readonly Arrival[], targets: readonly TrackPosition[], opts: FindOptions, last: boolean): Arrival[] {
  type Node = { src: number } | { step: RouteStep };
  const states = opts.states ?? {};
  const arrivals = new Map<string, { step: RouteStep; s: number; cost: number; prev: Node | null; src: number }>();
  let best = Infinity;
  const arrive = (key: string, step: RouteStep, s: number, cost: number, prev: Node | null, src: number) => {
    const had = arrivals.get(key);
    if (had && cost >= had.cost - 1e-9) return;
    arrivals.set(key, { step, s, cost, prev, src });
    if (cost < best) best = cost;
  };
  const targetOn = (step: RouteStep) => targets.find((t) => onStep(t, step));
  const dist = new Map<string, number>();
  const prev = new Map<string, Node>();
  const open: { node: Node; key: string; d: number }[] = [];
  sources.forEach((src, i) => {
    const t = targetOn(src.step);
    // The target is on the source's step, ahead: there at once.
    if (t) {
      const off = offsetOnStep(net, t, src.step);
      if (off >= src.s - 1e-9) arrive(stepKey(src.step), src.step, off, src.cost + off - src.s, null, i);
    }
    open.push({ node: { src: i }, key: `${stepKey(src.step)}\u0001${i}`, d: src.cost + net.pathLength(src.step.brick, src.step.from, src.step.to) - src.s });
  });
  const done = new Set<string>();
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[bi]!;
      if (a.d < b.d - 1e-9 || (Math.abs(a.d - b.d) <= 1e-9 && a.key < b.key)) bi = i;
    }
    const { node, key, d } = open.splice(bi, 1)[0]!;
    if (done.has(key)) continue;
    done.add(key);
    if (last && d >= best) break;
    const step = 'src' in node ? sources[node.src]!.step : node.step;
    const next = net.partner({ brick: step.brick, conn: step.to });
    if (!next) continue;
    let exits = net.exits(next.brick, next.conn);
    if (opts.followSwitches) {
      const sw = net.switchAt(switchKey(next.brick, next.conn));
      if (sw) exits = [net.settingOf(sw, states)];
    }
    for (const x of exits) {
      const ns: RouteStep = { brick: next.brick, from: next.conn, to: x };
      const nk = stepKey(ns);
      const t = targetOn(ns);
      if (t) {
        const off = offsetOnStep(net, t, ns);
        arrive(nk, ns, off, d + off, node, -1);
        continue;
      }
      const nd = d + net.pathLength(ns.brick, ns.from, ns.to);
      if (nd < (dist.get(nk) ?? Infinity) - 1e-9) {
        dist.set(nk, nd);
        prev.set(nk, node);
        open.push({ node: { step: ns }, key: nk, d: nd });
      }
    }
  }
  const out: Arrival[] = [];
  for (const a of arrivals.values()) {
    if (a.prev === null) {
      // There at once, on the source's own step.
      out.push({ step: a.step, s: a.s, cost: a.cost, steps: sources[a.src]!.steps });
      continue;
    }
    const tail: RouteStep[] = [a.step];
    let n: Node = a.prev;
    while (!('src' in n)) {
      tail.unshift(n.step);
      n = prev.get(stepKey(n.step))!;
    }
    out.push({ step: a.step, s: a.s, cost: a.cost, steps: [...sources[n.src]!.steps, ...tail] });
  }
  return out;
}

/** Whether two places are on track that joins up at all (either way round). */
function joined(net: TrackNetwork, a: string, b: string): boolean {
  const seen = new Set([a]);
  const queue = [a];
  while (queue.length) {
    const brick = queue.shift()!;
    if (brick === b) return true;
    const t = net.trackOf(brick);
    if (!t) continue;
    for (let c = 0; c < t.kinds.length; c++) {
      const p = net.partner({ brick, conn: c });
      if (p && !seen.has(p.brick)) {
        seen.add(p.brick);
        queue.push(p.brick);
      }
    }
  }
  return false;
}

/**
 * The switch settings a way needs: each step that leaves a switch's heel.
 * A way through the same switch twice, two ways, keeps the first (that's
 * how it's set when the train starts); routeBothWays names those.
 */
export function routeSwitches(net: TrackNetwork, steps: readonly RouteStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) {
    const sw = net.switchAt(switchKey(s.brick, s.from));
    if (sw && sw.exits.includes(s.to) && !(sw.key in out)) out[sw.key] = s.to;
  }
  return out;
}

/** Switches a way leaves by both legs: someone has to flip them while the train runs. */
export function routeBothWays(net: TrackNetwork, steps: readonly RouteStep[]): string[] {
  const first: Record<string, number> = {};
  const out = new Set<string>();
  for (const s of steps) {
    const sw = net.switchAt(switchKey(s.brick, s.from));
    if (!sw || !sw.exits.includes(s.to)) continue;
    if (!(sw.key in first)) first[sw.key] = s.to;
    else if (first[sw.key] !== s.to) out.add(sw.key);
  }
  return [...out].sort();
}

/** Bricks a way runs through both ways round. */
function turnsAroundIn(steps: readonly RouteStep[]): string[] {
  const seen = new Set(steps.map(stepKey));
  const out = new Set<string>();
  for (const s of steps) if (seen.has(stepKey({ brick: s.brick, from: s.to, to: s.from }))) out.add(s.brick);
  return [...out].sort();
}

/** Which way a route leaves its start: towards the start position's `to`, or its `from`. */
export function routeFacing(route: Pick<Route, 'steps' | 'from'>): Facing {
  const first = route.steps[0];
  // The start's own path, or another leg of a switch sharing an end with it (sameSpot).
  return first && first.brick === route.from.brick && (first.from === route.from.to || first.to === route.from.from) ? 'from' : 'to';
}

/**
 * The shortest way from `from` through each `via` to `to`, or what stops
 * it: no track joins them, or only a way that needs the train to turn
 * round on the spot. The train leaves `from` heading `opts.facing` (towards
 * the position's `to` or its `from`), or either way when that's not given;
 * it never turns round on the spot, so the way may run the whole loop
 * round, past its own start and through a switch twice. After a stop it
 * carries on the way it arrived (however it got there). Of two ways, one
 * that needs a switch set both ways loses to one that doesn't.
 */
export function findRoute(net: TrackNetwork, from: TrackPosition, to: TrackPosition, opts: FindOptions = {}): RouteFound | RouteProblem {
  const points = [from, ...(opts.via ?? []), to];
  for (const p of points) if (net.pathLength(p.brick, p.from, p.to) <= 0) return 'noTrack';
  if (points.length === 2 && from.brick === to.brick && from.from === to.from && from.to === to.to && Math.abs(from.s - to.s) < 0.5) return 'samePlace';
  const spots = points.map((p) => sameSpot(net, p));
  let best = null as RouteFound | null;
  for (const facing of opts.facing ? [opts.facing] : (['to', 'from'] as const)) {
    let at: Arrival[] = spots[0]!.map((p) => {
      const step = facing === 'to' ? { brick: p.brick, from: p.from, to: p.to } : { brick: p.brick, from: p.to, to: p.from };
      return { step, s: offsetOnStep(net, p, step), cost: 0, steps: [step] };
    });
    for (let i = 1; i < points.length && at.length > 0; i++) at = searchLeg(net, at, spots[i]!, opts, i === points.length - 1);
    let end: Arrival | null = null;
    for (const a of at) if (!end || a.cost < end.cost - 1e-9) end = a;
    if (!end) continue;
    const found: RouteFound = {
      steps: end.steps,
      length: end.cost,
      switches: routeSwitches(net, end.steps),
      turnsAround: turnsAroundIn(end.steps),
      facing,
      bothWays: routeBothWays(net, end.steps),
    };
    // Better: needs no switch set both ways when the other does, else shorter (a tie keeps the first, the way as clicked).
    const better = !best || ((found.bothWays.length > 0) !== (best.bothWays.length > 0) ? best.bothWays.length > 0 : found.length < best.length - 1e-9);
    if (better) best = found;
  }
  if (!best) return points.every((p) => joined(net, from.brick, p.brick)) ? 'turnAround' : 'noTrack';
  return best;
}

export type RouteStatus =
  | { status: 'ok'; length: number; switches: Record<string, number>; setAgainst: string[]; turnsAround: string[]; bothWays: string[] }
  | { status: 'broken'; at: number; brick: string };

/**
 * A saved route against the track as it is now: broken at the first step
 * whose part or way is gone, or that no longer joins the next (it keeps
 * its data; Find a new way searches again). Otherwise its length, the
 * switches it needs and those set the other way now.
 */
export function routeStatus(net: TrackNetwork, route: Pick<Route, 'steps' | 'from' | 'to'>, states: Readonly<Record<string, number>> = {}): RouteStatus {
  const steps = route.steps;
  if (steps.length === 0) return { status: 'broken', at: 0, brick: route.from.brick };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!net.exits(s.brick, s.from).includes(s.to)) return { status: 'broken', at: i, brick: s.brick };
    const next = steps[i + 1];
    if (next) {
      const p = net.partner({ brick: s.brick, conn: s.to });
      if (!p || p.brick !== next.brick || p.conn !== next.from) return { status: 'broken', at: i + 1, brick: next.brick };
    }
  }
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  if (!onStep(route.from, first)) return { status: 'broken', at: 0, brick: first.brick };
  if (!onStep(route.to, last)) return { status: 'broken', at: steps.length - 1, brick: last.brick };
  let length = 0;
  for (const s of steps) length += net.pathLength(s.brick, s.from, s.to);
  length -= offsetOnStep(net, route.from, first);
  length -= net.pathLength(last.brick, last.from, last.to) - offsetOnStep(net, route.to, last);
  const switches = routeSwitches(net, steps);
  const setAgainst = Object.entries(switches)
    .filter(([key, exit]) => {
      const sw = net.switchAt(key);
      return sw && net.settingOf(sw, states) !== exit;
    })
    .map(([key]) => key);
  return { status: 'ok', length: Math.max(0, length), switches, setAgainst, turnsAround: turnsAroundIn(steps), bothWays: routeBothWays(net, steps) };
}

/**
 * The route's line on the map (studs): from its start along each step to its
 * end; for a broken route, as far as it still goes. Each run of joined
 * steps is one line.
 */
export function routeLines(net: TrackNetwork, route: Pick<Route, 'steps' | 'from' | 'to'>): Pt[][] {
  const lines: Pt[][] = [];
  let line: Pt[] = [];
  const steps = route.steps;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const pts: CircuitPathPoint[] = net.path(s.brick, s.from, s.to);
    if (pts.length < 2) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    const len = pts[pts.length - 1]!.s;
    const a = i === 0 && onStep(route.from, s) ? offsetOnStep(net, route.from, s) : 0;
    const b = i === steps.length - 1 && onStep(route.to, s) ? offsetOnStep(net, route.to, s) : len;
    const part: Pt[] = [pointAt(pts, a).p];
    for (const p of pts) if (p.s > a && p.s < b) part.push(p.p);
    part.push(pointAt(pts, b).p);
    if (i > 0) {
      const p = net.partner({ brick: steps[i - 1]!.brick, conn: steps[i - 1]!.to });
      if (!p || p.brick !== s.brick || p.conn !== s.from) {
        if (line.length > 1) lines.push(line);
        line = [];
      }
    }
    line.push(...part);
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

/** Brick ids in a route renamed (copy, paste, ids renumbered on reading); unchanged ids stay. */
export function renameRouteBricks<R extends Pick<Route, 'from' | 'to' | 'via' | 'steps'>>(route: R, rename: (id: string) => string): R {
  return {
    ...route,
    from: { ...route.from, brick: rename(route.from.brick) },
    to: { ...route.to, brick: rename(route.to.brick) },
    via: route.via.map((v) => ({ ...v, at: { ...v.at, brick: rename(v.at.brick) } })),
    steps: route.steps.map((s) => ({ ...s, brick: rename(s.brick) })),
  };
}
