// Running trains (trains design 5): each train runs at its scale speed,
// along a named route or, without one, the way the switches are set, and
// stops at the route's end or the end of the track. Its cars follow the
// way it came, each on its trucks (trains.ts placeOnLine). A train coming
// out of a switch's leg into a switch set the other way pushes through,
// like a spring switch: the switch flips for the run and a note says so.
// Two trains that would touch both stop, with a note where.
//
// Running is each person's own: nothing here writes to the layout. The
// switches a run flips are its own (`overlay`), on top of the layout's.
// The desktop's src/track/Animation.cpp is the twin; both check
// fixtures/contracts/train-animation.json.

import { pointAt, type Pt } from './circuitPath.js';
import { switchKey, type TrackNetwork, type TrackPosition } from './network.js';
import { offsetOnStep, type Route, type RouteStep } from './routes.js';
import { placeOnLine, trackBehind, trainLength, type PlacedTrain, type RollingStock, type TrackLine, type Train, type TrainPosition } from './trains.js';

/** Millimetres in a stud. */
export const STUD_MM = 8;
/** The scale speeds are at unless a layout says otherwise: LEGO track gauge (37.5 mm) against standard gauge (1435 mm). */
export const DEFAULT_SCALE = 38;
/** The scales a layout may pick (1:N). */
export const MIN_SCALE = 10;
export const MAX_SCALE = 220;
/** A train's speed when it has none, scale km/h. */
export const DEFAULT_SPEED = 40;
/** The speed choices for watching (times real speed). */
export const SPEED_MULTIPLIERS = [0.25, 0.5, 1, 2, 4] as const;

/** A layout's scale read back: a whole number in range, or the default. */
export function asScale(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE ? Math.round(v) : DEFAULT_SCALE;
}

/** How fast a model runs (studs a second) at `kmh` scale km/h, at 1:`scale`. */
export function studsPerSecond(kmh: number, scale: number): number {
  return ((kmh / 3.6) * 1000) / scale / STUD_MM;
}

/** How fast the model really runs, metres a second. */
export function realMetresPerSecond(kmh: number, scale: number): number {
  return kmh / 3.6 / scale;
}

/** What a run says happened. */
export type RunNoteKind = 'pushedThrough' | 'routeSet' | 'collision' | 'arrived' | 'endOfTrack';

export interface RunNote {
  kind: RunNoteKind;
  train: string;
  /** The other train (a collision). */
  other?: string;
  /** The switch (pushed through, set for the route). */
  switchKey?: string;
  /** Where, studs. */
  at: Pt;
}

/** How a train is getting on: running, at its route's end, at the end of the track, or stopped short of another train. */
export type RunState = 'running' | 'arrived' | 'endOfTrack' | 'blocked';

/** What to run: a train, on a route or (none) the way the switches are set. */
export interface RunPlan {
  train: Train;
  route?: Pick<Route, 'id' | 'steps' | 'from' | 'to'> | null;
}

interface Running {
  train: Train;
  routeId: string | null;
  /** The way ahead and behind: steps in the order the train takes them. */
  steps: RouteStep[];
  /** Each step's start, studs along the way. */
  starts: number[];
  /** The way's length so far (a free run grows it as it goes). */
  total: number;
  /** The head's start, studs along the way. */
  startAt: number;
  /** Where the head stops, studs along the way (a route's end); null: as far as the track goes. */
  endAt: number | null;
  /** The head, studs along the way. */
  at: number;
  /** The track behind the start (the cars at the start sit on it). */
  tail: TrackLine;
  /** The steps the head has entered (their switches done). */
  entered: number;
  free: boolean;
  state: RunState;
  speed: number;
  length: number;
  placed: PlacedTrain | null;
}

/** A car's body as a box: middle, unit heading, half length, half width. */
interface Box {
  c: Pt;
  ux: number;
  uy: number;
  hl: number;
  hw: number;
}

function boxesOf(placed: PlacedTrain | null | undefined, stock: ReadonlyMap<string, RollingStock>): Box[] {
  if (!placed) return [];
  const out: Box[] = [];
  for (const u of placed.units) {
    const s = stock.get(u.stock);
    if (!s) continue;
    const a = (u.angle * Math.PI) / 180;
    out.push({ c: u.centre, ux: Math.cos(a), uy: Math.sin(a), hl: (s.bodyLength || s.length - 2) / 2, hw: s.width / 2 });
  }
  return out;
}

/** Whether two boxes overlap (separating axes). */
export function boxesTouch(a: Box, b: Box): boolean {
  const dx = b.c.x - a.c.x;
  const dy = b.c.y - a.c.y;
  for (const [ax, ay] of [
    [a.ux, a.uy],
    [-a.uy, a.ux],
    [b.ux, b.uy],
    [-b.uy, b.ux],
  ] as const) {
    const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb) return false;
  }
  return true;
}

/** Where two placed trains touch (the middle between the two cars that do), or null when they don't. */
export function trainsTouch(a: PlacedTrain | null | undefined, b: PlacedTrain | null | undefined, stock: ReadonlyMap<string, RollingStock>): Pt | null {
  const ba = boxesOf(a, stock);
  const bb = boxesOf(b, stock);
  if (ba.length === 0 || bb.length === 0) return null;
  // Quick: far apart.
  const reach = (bs: Box[]) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of bs) {
      const r = b.hl + b.hw;
      x0 = Math.min(x0, b.c.x - r);
      y0 = Math.min(y0, b.c.y - r);
      x1 = Math.max(x1, b.c.x + r);
      y1 = Math.max(y1, b.c.y + r);
    }
    return { x0, y0, x1, y1 };
  };
  const ra = reach(ba);
  const rb = reach(bb);
  if (ra.x1 < rb.x0 || rb.x1 < ra.x0 || ra.y1 < rb.y0 || rb.y1 < ra.y0) return null;
  for (const p of ba) for (const q of bb) if (boxesTouch(p, q)) return { x: (p.c.x + q.c.x) / 2, y: (p.c.y + q.c.y) / 2 };
  return null;
}

const onStep = (pos: TrackPosition, step: RouteStep) =>
  pos.brick === step.brick && ((pos.from === step.from && pos.to === step.to) || (pos.from === step.to && pos.to === step.from));

/**
 * A run of some trains: `step(seconds)` moves each one on; `placed` is
 * where each one's cars are now. `parked` are trains on the map that
 * aren't running: a running train stops short of them too.
 */
export class TrainRun {
  private readonly runs: Running[] = [];
  /** The switches as this run has them, over the layout's (pushed through, set for a route). */
  readonly overlay: Record<string, number> = {};
  private layoutStates: Readonly<Record<string, number>>;
  /** Trains that touch another (or a parked one) where they start: they don't move. */
  readonly startNotes: RunNote[] = [];

  constructor(
    private readonly net: TrackNetwork,
    private readonly stock: ReadonlyMap<string, RollingStock>,
    plans: readonly RunPlan[],
    states: Readonly<Record<string, number>>,
    private readonly scale: number = DEFAULT_SCALE,
    private readonly parked: ReadonlyMap<string, PlacedTrain | null> = new Map(),
  ) {
    this.layoutStates = states;
    for (const plan of plans) {
      const r = this.start(plan);
      if (r) this.runs.push(r);
    }
    // Trains that start touching each other (or a parked one) don't move.
    this.collide(null, this.startNotes);
  }

  /** The switches as the run has them: the layout's, with the run's own on top. */
  get states(): Record<string, number> {
    return { ...this.layoutStates, ...this.overlay };
  }

  /** The layout's switches changed (someone flipped one): a switch flipped there is the layout's again. */
  setLayoutStates(states: Readonly<Record<string, number>>): void {
    for (const key of Object.keys(this.overlay)) if (states[key] !== this.layoutStates[key]) delete this.overlay[key];
    this.layoutStates = states;
  }

  /** Someone clicked a switch: it is set as the layout has it again (the click writes the layout). */
  dropOverlay(key: string): void {
    delete this.overlay[key];
  }

  /** The trains running (by id), in the order they were asked for. */
  get trainIds(): string[] {
    return this.runs.map((r) => r.train.id);
  }

  stateOf(id: string): RunState | null {
    return this.runs.find((r) => r.train.id === id)?.state ?? null;
  }

  /** How far the train's head has gone, studs. */
  distanceOf(id: string): number {
    const r = this.runs.find((x) => x.train.id === id);
    return r ? r.at - r.startAt : 0;
  }

  /** Where the train's head is now (on the track, facing the way it runs). */
  headOf(id: string): TrainPosition | null {
    const r = this.runs.find((x) => x.train.id === id);
    if (!r) return null;
    const { i, s } = this.locate(r, r.at);
    const st = r.steps[i]!;
    const len = this.net.pathLength(st.brick, st.from, st.to);
    // Written with from < to where it can be, like a click on the track.
    return st.from < st.to ? { brick: st.brick, from: st.from, to: st.to, s, facing: 'to' } : { brick: st.brick, from: st.to, to: st.from, s: len - s, facing: 'from' };
  }

  /** Where each running train's cars are now. */
  get placed(): Map<string, PlacedTrain | null> {
    return new Map(this.runs.map((r) => [r.train.id, r.placed]));
  }

  /** Whether any train is still running. */
  get moving(): boolean {
    return this.runs.some((r) => r.state === 'running');
  }

  /** Trains stopped short of another start again (Play after a collision); they stop again if they'd still touch. */
  resume(): void {
    for (const r of this.runs) if (r.state === 'blocked') r.state = 'running';
  }

  private start(plan: RunPlan): Running | null {
    const { train, route } = plan;
    const length = trainLength(train, this.stock);
    const speed = studsPerSecond(train.speed > 0 ? train.speed : DEFAULT_SPEED, this.scale);
    let head: TrainPosition;
    let steps: RouteStep[];
    let startAt: number;
    let endAt: number | null;
    if (route) {
      if (route.steps.length === 0) return null;
      for (const s of route.steps) if (this.net.pathLength(s.brick, s.from, s.to) <= 0) return null;
      steps = route.steps.map((s) => ({ brick: s.brick, from: s.from, to: s.to }));
      const first = steps[0]!;
      const last = steps[steps.length - 1]!;
      startAt = onStep(route.from, first) ? offsetOnStep(this.net, route.from, first) : 0;
      const lastLen = this.net.pathLength(last.brick, last.from, last.to);
      const endOff = onStep(route.to, last) ? offsetOnStep(this.net, route.to, last) : lastLen;
      let before = 0;
      for (let i = 0; i < steps.length - 1; i++) before += this.net.pathLength(steps[i]!.brick, steps[i]!.from, steps[i]!.to);
      endAt = before + endOff;
      const len0 = this.net.pathLength(first.brick, first.from, first.to);
      head = first.from < first.to ? { brick: first.brick, from: first.from, to: first.to, s: startAt, facing: 'to' } : { brick: first.brick, from: first.to, to: first.from, s: len0 - startAt, facing: 'from' };
    } else {
      const p = train.position;
      if (!p || this.net.pathLength(p.brick, p.from, p.to) <= 0) return null;
      const len = this.net.pathLength(p.brick, p.from, p.to);
      const s = Math.max(0, Math.min(p.s, len));
      steps = [p.facing === 'to' ? { brick: p.brick, from: p.from, to: p.to } : { brick: p.brick, from: p.to, to: p.from }];
      startAt = p.facing === 'to' ? s : len - s;
      endAt = null;
      head = { ...p, s };
    }
    const starts: number[] = [];
    let total = 0;
    for (const s of steps) {
      starts.push(total);
      total += this.net.pathLength(s.brick, s.from, s.to);
    }
    const r: Running = {
      train,
      routeId: route?.id ?? null,
      steps,
      starts,
      total,
      startAt,
      endAt,
      at: startAt,
      tail: trackBehind(this.net, head, length + 64, this.states),
      entered: 0,
      free: !route,
      state: 'running',
      speed,
      length,
      placed: null,
    };
    // The step it starts on: its switch is set as the route needs (a free train is already on its way).
    if (route) this.enter(r, 0, []);
    r.entered = 1;
    r.placed = this.place(r);
    return r;
  }

  /** The step the head is on at `at` along the way, and how far into it. */
  private locate(r: Running, at: number): { i: number; s: number } {
    let lo = 0;
    let hi = r.steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r.starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    const st = r.steps[lo]!;
    return { i: lo, s: Math.max(0, Math.min(at - r.starts[lo]!, this.net.pathLength(st.brick, st.from, st.to))) };
  }

  /**
   * The head goes into step `i`: a switch it leaves by its heel is set the
   * way it goes (a route's); one it comes into by a leg set the other way
   * is pushed through.
   */
  private enter(r: Running, i: number, notes: RunNote[]): void {
    const st = r.steps[i]!;
    const states = this.states;
    const facing = this.net.switchAt(switchKey(st.brick, st.from));
    if (facing && facing.exits.includes(st.to) && this.net.settingOf(facing, states) !== st.to) {
      this.overlay[facing.key] = st.to;
      notes.push({ kind: 'routeSet', train: r.train.id, switchKey: facing.key, at: this.net.port(st.brick, st.from)!.p });
    }
    const trailing = this.net.switchAt(switchKey(st.brick, st.to));
    if (trailing && trailing.exits.includes(st.from) && this.net.settingOf(trailing, states) !== st.from) {
      this.overlay[trailing.key] = st.from;
      notes.push({ kind: 'pushedThrough', train: r.train.id, switchKey: trailing.key, at: this.net.port(st.brick, st.to)!.p });
    }
  }

  /** A free train's next step past the end of its way: through the next brick as the switches are set; null at an end of track. */
  private nextStep(r: Running): RouteStep | null {
    const last = r.steps[r.steps.length - 1]!;
    const next = this.net.partner({ brick: last.brick, conn: last.to });
    if (!next) return null;
    const exits = this.net.exits(next.brick, next.conn);
    if (exits.length === 0) return null;
    const sw = this.net.switchAt(switchKey(next.brick, next.conn));
    const to = sw ? this.net.settingOf(sw, this.states) : exits[0]!;
    return { brick: next.brick, from: next.conn, to };
  }

  /** The track behind the head: back along the way to the start, then the track behind the start. */
  private lineOf(r: Running): TrackLine {
    const need = r.length + 64;
    const { i, s } = this.locate(r, r.at);
    const out: TrackLine['pts'] = [];
    let d = 0;
    const push = (p: Pt, brick: string) => {
      const prev = out[out.length - 1];
      if (prev) d += Math.hypot(p.x - prev.p.x, p.y - prev.p.y);
      out.push({ p, d, brick });
    };
    for (let k = i; k >= 0 && d < need; k--) {
      const st = r.steps[k]!;
      const pts = this.net.path(st.brick, st.from, st.to);
      const hi = k === i ? s : pts[pts.length - 1]!.s;
      const lo = k === 0 ? Math.min(r.startAt, hi) : 0;
      if (pts.length < 2) break;
      if (out.length === 0) push(pointAt(pts, hi).p, st.brick);
      for (let q = pts.length - 1; q >= 0 && d < need; q--) {
        const pt = pts[q]!;
        if (pt.s >= hi || pt.s <= lo) continue;
        push(pt.p, st.brick);
      }
      // Its start: the joint with the step before (or the run's start).
      if (d < need) push(pointAt(pts, lo).p, st.brick);
    }
    if (d < need) {
      const base = d;
      for (const q of r.tail.pts.slice(1)) {
        out.push({ p: q.p, d: base + q.d, brick: q.brick });
        if (base + q.d >= need) break;
      }
      d = out[out.length - 1]!.d;
    }
    return { pts: out, ended: d < need && r.tail.ended };
  }

  private place(r: Running): PlacedTrain | null {
    const line = this.lineOf(r);
    return line.pts.length < 2 ? null : placeOnLine(line, r.train.units, this.stock);
  }

  /** Move the head of `r` to `to` along its way (a free train finds its way on), taking the switches it meets. */
  private advance(r: Running, to: number, notes: RunNote[]): void {
    let target = r.endAt !== null ? Math.min(to, r.endAt) : to;
    for (;;) {
      if (target < r.total - 1e-9 || !r.free) break;
      const next = this.nextStep(r);
      if (!next) {
        target = Math.min(target, r.total);
        break;
      }
      r.starts.push(r.total);
      r.steps.push(next);
      r.total += this.net.pathLength(next.brick, next.from, next.to);
    }
    target = Math.min(target, r.total);
    // Each step the head comes into.
    while (r.entered < r.steps.length && r.starts[r.entered]! < target - 1e-9) {
      this.enter(r, r.entered, notes);
      r.entered++;
    }
    r.at = target;
    if (r.endAt !== null && r.at >= r.endAt - 1e-9) {
      r.state = 'arrived';
      notes.push({ kind: 'arrived', train: r.train.id, at: this.net.pointAt(this.headOf(r.train.id)!)!.p });
    } else if (r.free && r.at >= r.total - 1e-9 && !this.nextStep(r)) {
      r.state = 'endOfTrack';
      notes.push({ kind: 'endOfTrack', train: r.train.id, at: this.net.pointAt(this.headOf(r.train.id)!)!.p });
    }
  }

  /**
   * Move every running train on by `seconds` of its speed (already times
   * the viewer's speed choice). Trains that would touch stay where they
   * were and stop ('blocked'). What happened comes back as notes.
   */
  step(seconds: number): RunNote[] {
    const notes: RunNote[] = [];
    const before = new Map<Running, { at: number; placed: PlacedTrain | null }>();
    for (const r of this.runs) {
      if (r.state !== 'running' || seconds <= 0) continue;
      before.set(r, { at: r.at, placed: r.placed });
      this.advance(r, r.at + r.speed * seconds, notes);
      r.placed = this.place(r);
    }
    if (before.size > 0) this.collide(new Set(before.keys()), notes, before);
    return notes;
  }

  /** Stop the trains that touch another (those that moved go back to where they were). */
  private collide(moved: ReadonlySet<Running> | null, notes: RunNote[], before?: Map<Running, { at: number; placed: PlacedTrain | null }>): void {
    const hits: { a: Running; b: Running | null; other: string; at: Pt }[] = [];
    for (let i = 0; i < this.runs.length; i++) {
      const a = this.runs[i]!;
      for (let j = i + 1; j < this.runs.length; j++) {
        const b = this.runs[j]!;
        if (moved && !moved.has(a) && !moved.has(b)) continue;
        const at = trainsTouch(a.placed, b.placed, this.stock);
        if (at) hits.push({ a, b, other: b.train.id, at });
      }
      if (moved && !moved.has(a)) continue;
      for (const [id, p] of this.parked) {
        if (this.runs.some((r) => r.train.id === id)) continue;
        const at = trainsTouch(a.placed, p, this.stock);
        if (at) hits.push({ a, b: null, other: id, at });
      }
    }
    for (const h of hits) {
      for (const r of [h.a, h.b]) {
        if (!r) continue;
        const was = before?.get(r);
        if (was) {
          // It moved into the other: back where it was, stopped (not at an end it never reached).
          r.at = was.at;
          r.placed = was.placed;
          r.state = 'blocked';
        } else if (r.state === 'running') r.state = 'blocked';
      }
      // A route's own end, or the track's, isn't news when the train stopped short of another.
      for (let k = notes.length - 1; k >= 0; k--) {
        const n = notes[k]!;
        if ((n.kind === 'arrived' || n.kind === 'endOfTrack') && (n.train === h.a.train.id || n.train === h.b?.train.id)) notes.splice(k, 1);
      }
      notes.push({ kind: 'collision', train: h.a.train.id, other: h.other, at: h.at });
    }
  }
}
