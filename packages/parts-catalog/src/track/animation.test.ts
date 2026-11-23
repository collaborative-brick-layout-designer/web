// Running trains against the shared contract (fixtures/contracts/
// train-animation.json, on route-search.json's network): the desktop's
// tests/track/AnimationTest.cpp checks the same, so a train runs the same
// way in both apps: its scale speed, a trailing point pushed through, a
// route's switches, its end, and two trains that would touch both stopping.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrackNetwork, type TrackBrickInput } from './network.js';
import type { TrackConn } from './partTrack.js';
import type { RouteStep } from './routes.js';
import { placeTrain, simpleStock, type RollingStock, type Train, type TrainPosition } from './trains.js';
import { asScale, realMetresPerSecond, studsPerSecond, trainsTouch, TrainRun, DEFAULT_SCALE, type RunNote } from './animation.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'train-animation.json');
const net0 = JSON.parse(readFileSync(join(DIR, 'route-search.json'), 'utf8')) as {
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
};
interface RunCase {
  name: string;
  scale: number;
  dt: number;
  frames: number;
  checkpoints: number[];
  states?: Record<string, number>;
  trains: Train[];
  parked?: Train[];
  routes?: Record<string, { id: string; from: TrainPosition; to: TrainPosition; steps: RouteStep[] }>;
  expect?: unknown;
}
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  stock: Record<string, { length: number; trucks: { at: number; swivelMax: number }[] }>;
  speeds: { kmh: number; scale: number; studsPerSecond?: number; realMetresPerSecond?: number }[];
  runs: RunCase[];
  touch: { name: string; a: Pick<Train, 'units' | 'position'>; b: Pick<Train, 'units' | 'position'>; expect?: unknown }[];
};
const net = new TrackNetwork(
  net0.bricks.map((b): TrackBrickInput => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })),
);
const stock = new Map<string, RollingStock>(Object.entries(doc.stock).map(([id, s]) => [id, simpleStock(id, { length: s.length, trucks: s.trucks })]));
const r = (v: number) => Math.round(v * 1e6) / 1e6;
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

interface Got {
  notes: { frame: number; kind: string; train: string; other?: string; switchKey?: string; at: number[] }[];
  checkpoints: { frame: number; distances: Record<string, number> }[];
  overlay: Record<string, number>;
  trains: Record<string, { state: string; distance: number; head: TrainPosition | null }>;
}

function runCase(c: RunCase): Got {
  const states = c.states ?? {};
  const parked = new Map((c.parked ?? []).map((t) => [t.id, placeTrain(net, t, stock, states)]));
  const run = new TrainRun(
    net,
    stock,
    c.trains.map((train) => ({ train, route: c.routes?.[train.id] ?? null })),
    states,
    c.scale,
    parked,
  );
  const got: Got = { notes: [], checkpoints: [], overlay: {}, trains: {} };
  const take = (frame: number, notes: RunNote[]) => {
    for (const n of notes) {
      got.notes.push({
        frame,
        kind: n.kind,
        train: n.train,
        ...(n.other ? { other: n.other } : {}),
        ...(n.switchKey ? { switchKey: n.switchKey } : {}),
        at: [r(n.at.x), r(n.at.y)],
      });
    }
  };
  for (let f = 1; f <= c.frames; f++) {
    take(f, run.step(c.dt));
    if (c.checkpoints.includes(f)) got.checkpoints.push({ frame: f, distances: Object.fromEntries(run.trainIds.map((id) => [id, r(run.distanceOf(id))])) });
  }
  got.overlay = { ...run.overlay };
  for (const id of run.trainIds) {
    const h = run.headOf(id);
    got.trains[id] = { state: run.stateOf(id)!, distance: r(run.distanceOf(id)), head: h ? { ...h, s: r(h.s) } : null };
  }
  return got;
}

describe('train speeds', () => {
  it('turns scale km/h into studs a second the model runs, and the metres a second it really runs', () => {
    for (const s of doc.speeds) {
      const got = { studsPerSecond: r(studsPerSecond(s.kmh, s.scale)), realMetresPerSecond: r(realMetresPerSecond(s.kmh, s.scale)) };
      if (writing) {
        Object.assign(s, got);
        continue;
      }
      expect(got.studsPerSecond).toBeCloseTo(s.studsPerSecond!, 5);
      expect(got.realMetresPerSecond).toBeCloseTo(s.realMetresPerSecond!, 5);
    }
    // The design's example: 40 km/h at 1:38 is about 36.5 studs a second.
    expect(studsPerSecond(40, 38)).toBeCloseTo(36.55, 2);
  });

  it('reads a layout scale, or the default', () => {
    expect(asScale(87)).toBe(87);
    expect(asScale(undefined)).toBe(DEFAULT_SCALE);
    expect(asScale(2)).toBe(DEFAULT_SCALE);
    expect(asScale('38')).toBe(DEFAULT_SCALE);
    expect(asScale(64.4)).toBe(64);
  });
});

describe('running trains', () => {
  for (const c of doc.runs) {
    it(c.name, () => {
      const got = runCase(c);
      if (writing) {
        c.expect = got;
        return;
      }
      const want = c.expect as Got;
      expect(got.notes.map((n) => ({ ...n, at: [0, 0] }))).toEqual(want.notes.map((n) => ({ ...n, at: [0, 0] })));
      got.notes.forEach((n, i) => {
        expect(n.at[0]).toBeCloseTo(want.notes[i]!.at[0]!, 3);
        expect(n.at[1]).toBeCloseTo(want.notes[i]!.at[1]!, 3);
      });
      expect(got.overlay).toEqual(want.overlay);
      got.checkpoints.forEach((cp, i) => {
        expect(cp.frame).toBe(want.checkpoints[i]!.frame);
        for (const [id, d] of Object.entries(cp.distances)) expect(d).toBeCloseTo(want.checkpoints[i]!.distances[id]!, 4);
      });
      for (const [id, t] of Object.entries(got.trains)) {
        const w = want.trains[id]!;
        expect(t.state).toBe(w.state);
        expect(t.distance).toBeCloseTo(w.distance, 4);
        expect({ ...t.head, s: 0 }).toEqual({ ...w.head, s: 0 });
        expect(t.head!.s).toBeCloseTo(w.head!.s, 4);
      }
    });
  }

  for (const c of doc.touch) {
    it(`touch: ${c.name}`, () => {
      const a = placeTrain(net, c.a, stock);
      const b = placeTrain(net, c.b, stock);
      const got = { touch: trainsTouch(a, b, stock) !== null };
      if (writing) {
        c.expect = got;
        return;
      }
      expect(got).toEqual(c.expect);
    });
  }
  if (writing) it('writes the contract', () => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));

  it('runs at its scale speed: 40 km/h at 1:38 goes about 36.5 studs in a second', () => {
    const c = doc.runs[0]!;
    const run = new TrainRun(net, stock, [{ train: c.trains[0]! }], {}, 38);
    for (let f = 0; f < 60; f++) run.step(1 / 60);
    expect(run.distanceOf('t1')).toBeCloseTo(studsPerSecond(40, 38), 6);
  });

  it("never changes the layout's switches: a push goes in the run's own", () => {
    const c = doc.runs[1]!;
    const states: Record<string, number> = {};
    const run = new TrainRun(net, stock, [{ train: c.trains[0]! }], states, 38);
    for (let f = 0; f < 120; f++) run.step(1 / 60);
    expect(states).toEqual({});
    expect(run.overlay['Q/0']).toBe(2);
    expect(run.states['Q/0']).toBe(2);
    // Someone flips it on the layout: the layout's setting is the one again.
    run.setLayoutStates({ 'Q/0': 1 });
    expect(run.overlay['Q/0']).toBeUndefined();
    expect(run.states['Q/0']).toBe(1);
  });

  it('starts at the train where it stands: the first frame places the cars as the map does', () => {
    const t = doc.runs[0]!.trains[0]!;
    const run = new TrainRun(net, stock, [{ train: t }], {}, 38);
    const still = placeTrain(net, t, stock)!;
    const moving = run.placed.get('t1')!;
    moving.units.forEach((u, i) => {
      expect(u.frontTruck.x).toBeCloseTo(still.units[i]!.frontTruck.x, 4);
      expect(u.rearTruck.x).toBeCloseTo(still.units[i]!.rearTruck.x, 4);
      expect(u.rearTruck.y).toBeCloseTo(still.units[i]!.rearTruck.y, 4);
    });
  });

  it('keeps each car on its trucks while it runs through the switches', () => {
    const c = doc.runs[3]!;
    const run = new TrainRun(net, stock, c.trains.map((train) => ({ train, route: c.routes![train.id]! })), {}, 38);
    for (let f = 0; f < 200; f++) {
      run.step(1 / 60);
      for (const u of run.placed.get('t1')!.units) {
        const s = stock.get(u.stock)!;
        expect(Math.hypot(u.frontTruck.x - u.rearTruck.x, u.frontTruck.y - u.rearTruck.y)).toBeCloseTo(s.trucks[0]!.at - s.trucks[1]!.at, 3);
      }
    }
  });

  it('a train stopped short of another starts again with Play, and stops again if they still meet', () => {
    const c = doc.runs[4]!;
    const run = new TrainRun(net, stock, c.trains.map((train) => ({ train })), {}, 38);
    let hit = false;
    for (let f = 0; f < 240 && !hit; f++) hit = run.step(1 / 60).some((n) => n.kind === 'collision');
    expect(hit).toBe(true);
    expect(run.stateOf('east')).toBe('blocked');
    expect(run.moving).toBe(false);
    run.resume();
    expect(run.moving).toBe(true);
    expect(run.step(1 / 60).map((n) => n.kind)).toEqual(['collision']);
  });

  it('runs a few trains on a big layout well inside a frame', () => {
    const c = doc.runs[0]!;
    const trains = [0, 1, 2].map((k) => ({ ...c.trains[0]!, id: `t${k}`, units: Array(6).fill({ stock: 'boxcar', reversed: false }), position: { brick: 'E', from: 0, to: 1, s: 4 + k, facing: 'to' as const } }));
    const run = new TrainRun(net, stock, trains.map((train) => ({ train })), {}, 38);
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) run.step(1 / 60);
    expect((performance.now() - t0) / 60).toBeLessThan(8);
  });
});
