// Named routes (trains design 2.5, 3.4, 4): finding a way along the track
// from one place to another, the switch settings it needs, and checking a
// saved route against the track as it is now. The desktop's
// src/track/Routes.cpp is the twin; both check
// fixtures/contracts/route-search.json.
//
// A search state is a directed step: a way through one brick, entered at
// `from` and left at `to`. From a step, the next ones are the ways through
// the brick linked at `to`, entered there. Inside a switch a train can't go
// frog to frog (the part's paths leave that out). Cost is length; the
// shortest way wins, ties going to the lower brick id and connection.

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
}

export type RouteProblem = 'noTrack' | 'turnAround' | 'samePlace';

export interface FindOptions {
  via?: readonly TrackPosition[];
  /** Follow the switches as they are set (where does a train go now?), not any way. */
  followSwitches?: boolean;
  states?: Readonly<Record<string, number>>;
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

interface Leg {
  steps: RouteStep[];
  cost: number;
}

/** The shortest way from a start step (at offset s0) to a position, or null. */
function searchLeg(
  net: TrackNetwork,
  start: RouteStep,
  s0: number,
  target: TrackPosition,
  opts: FindOptions,
): Leg | null {
  // The target is on the start step, ahead: done at once.
  if (onStep(target, start) && offsetOnStep(net, target, start) >= s0 - 1e-9) {
    return { steps: [start], cost: offsetOnStep(net, target, start) - s0 };
  }
  const states = opts.states ?? {};
  const dist = new Map<string, number>();
  const prev = new Map<string, RouteStep | null>();
  const startKey = stepKey(start);
  const startLen = net.pathLength(start.brick, start.from, start.to);
  dist.set(startKey, startLen - s0);
  prev.set(startKey, null);
  // A small heap would do; layouts have thousands of parts, so a sorted frontier is fine.
  const open: { step: RouteStep; d: number }[] = [{ step: start, d: startLen - s0 }];
  const done = new Set<string>();
  let found: { step: RouteStep; cost: number } | null = null;
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[bi]!;
      if (a.d < b.d - 1e-9 || (Math.abs(a.d - b.d) <= 1e-9 && stepKey(a.step) < stepKey(b.step))) bi = i;
    }
    const { step, d } = open.splice(bi, 1)[0]!;
    const key = stepKey(step);
    if (done.has(key)) continue;
    done.add(key);
    if (found && d >= found.cost) break;
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
      if (onStep(target, ns)) {
        const cost = d + offsetOnStep(net, target, ns);
        if (!found || cost < found.cost - 1e-9) {
          found = { step: ns, cost };
          prev.set(nk, step);
        }
        continue;
      }
      const nd = d + net.pathLength(ns.brick, ns.from, ns.to);
      if (nd < (dist.get(nk) ?? Infinity) - 1e-9) {
        dist.set(nk, nd);
        prev.set(nk, step);
        open.push({ step: ns, d: nd });
      }
    }
  }
  if (!found) return null;
  const steps: RouteStep[] = [found.step];
  let p = prev.get(stepKey(found.step)) ?? null;
  while (p) {
    steps.unshift(p);
    p = prev.get(stepKey(p)) ?? null;
  }
  return { steps, cost: found.cost };
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

/** The switch settings a way needs: each step that leaves a switch's heel. */
export function routeSwitches(net: TrackNetwork, steps: readonly RouteStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) {
    const sw = net.switchAt(switchKey(s.brick, s.from));
    if (sw && sw.exits.includes(s.to)) out[sw.key] = s.to;
  }
  return out;
}

/** Bricks a way runs through both ways round. */
function turnsAroundIn(steps: readonly RouteStep[]): string[] {
  const seen = new Set(steps.map(stepKey));
  const out = new Set<string>();
  for (const s of steps) if (seen.has(stepKey({ brick: s.brick, from: s.to, to: s.from }))) out.add(s.brick);
  return [...out].sort();
}

/**
 * The shortest way from `from` through each `via` to `to`, or what stops
 * it: no track joins them, or only a way that needs the train to turn
 * round on the spot. The train may leave `from` either way; after a stop
 * it carries on the way it was going.
 */
export function findRoute(net: TrackNetwork, from: TrackPosition, to: TrackPosition, opts: FindOptions = {}): RouteFound | RouteProblem {
  const points = [from, ...(opts.via ?? []), to];
  for (const p of points) if (net.pathLength(p.brick, p.from, p.to) <= 0) return 'noTrack';
  if (points.length === 2 && from.brick === to.brick && from.from === to.from && from.to === to.to && Math.abs(from.s - to.s) < 0.5) return 'samePlace';
  const starts: RouteStep[] = [
    { brick: from.brick, from: from.from, to: from.to },
    { brick: from.brick, from: from.to, to: from.from },
  ];
  let best: { steps: RouteStep[]; cost: number } | null = null;
  for (const start of starts) {
    let steps: RouteStep[] = [];
    let cost = 0;
    let at = start;
    let s0 = offsetOnStep(net, from, start);
    let ok = true;
    for (let i = 1; i < points.length; i++) {
      const target = points[i]!;
      const leg = searchLeg(net, at, s0, target, opts);
      if (!leg) {
        ok = false;
        break;
      }
      steps = steps.length ? [...steps, ...leg.steps.slice(1)] : leg.steps;
      cost += leg.cost;
      at = leg.steps[leg.steps.length - 1]!;
      s0 = offsetOnStep(net, target, at);
    }
    if (ok && (!best || cost < best.cost - 1e-9)) best = { steps, cost };
  }
  if (!best) return points.every((p) => joined(net, from.brick, p.brick)) ? 'turnAround' : 'noTrack';
  return { steps: best.steps, length: best.cost, switches: routeSwitches(net, best.steps), turnsAround: turnsAroundIn(best.steps) };
}

export type RouteStatus =
  | { status: 'ok'; length: number; switches: Record<string, number>; setAgainst: string[]; turnsAround: string[] }
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
  return { status: 'ok', length: Math.max(0, length), switches, setAgainst, turnsAround: turnsAroundIn(steps) };
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
