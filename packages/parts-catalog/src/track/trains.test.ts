// Train placement against the shared contract (fixtures/contracts/
// train-geometry.json, on route-search.json's network): the desktop's
// tests/track/TrainsTest.cpp checks the same, so a train sits the same way
// in both apps. And the records: defaults, reading back, part-mode length.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrackNetwork, type TrackBrickInput } from './network.js';
import type { TrackConn } from './partTrack.js';
import { asStock, partStockLength, placeTrain, simpleStock, trackBehind, trainLength, turnedAround, type RollingStock, type TrainPosition } from './trains.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'train-geometry.json');
const net0 = JSON.parse(readFileSync(join(DIR, 'route-search.json'), 'utf8')) as {
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
};
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  _about: string;
  network: string;
  stock: Record<string, { length: number; trucks: { at: number; swivelMax: number }[] }>;
  cases: { name: string; units: { stock: string; reversed: boolean }[]; position: TrainPosition; states?: Record<string, number>; expect: unknown }[];
};
const net = new TrackNetwork(
  net0.bricks.map((b): TrackBrickInput => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })),
);
const stock = new Map<string, RollingStock>(Object.entries(doc.stock).map(([id, s]) => [id, simpleStock(id, { length: s.length, trucks: s.trucks })]));
const r = (v: number) => Math.round(v * 1e6) / 1e6;
const pt = (p: { x: number; y: number }) => [r(p.x), r(p.y)];
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

describe('train placement', () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const train = { id: 't', name: '', trackKind: 'rail', units: c.units, position: c.position, color: '', speed: 40 };
      const placed = placeTrain(net, train, stock, c.states ?? {})!;
      const turned = turnedAround(net, train, stock, c.states ?? {}).position!;
      const got = {
        offTrack: placed.offTrack,
        units: placed.units.map((u) => ({
          stock: u.stock,
          frontTruck: pt(u.frontTruck),
          rearTruck: pt(u.rearTruck),
          centre: pt(u.centre),
          angle: r(u.angle),
          frontCoupler: pt(u.frontCoupler),
          rearCoupler: pt(u.rearCoupler),
        })),
        turned: { brick: turned.brick, from: turned.from, to: turned.to, s: r(turned.s), facing: turned.facing },
      };
      if (writing) {
        c.expect = got;
        return;
      }
      const want = c.expect as typeof got;
      expect(got.offTrack).toBe(want.offTrack);
      expect(got.units.length).toBe(want.units.length);
      got.units.forEach((u, i) => {
        const w = want.units[i]!;
        expect(u.stock).toBe(w.stock);
        for (const k of ['frontTruck', 'rearTruck', 'centre', 'frontCoupler', 'rearCoupler'] as const) {
          expect(u[k][0]).toBeCloseTo(w[k][0]!, 4);
          expect(u[k][1]).toBeCloseTo(w[k][1]!, 4);
        }
        expect(u.angle).toBeCloseTo(w.angle, 3);
      });
      expect({ ...got.turned, s: 0 }).toEqual({ ...want.turned, s: 0 });
      expect(got.turned.s).toBeCloseTo(want.turned.s, 3);
    });
  }
  if (writing) it('writes the contract', () => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));

  it('keeps each car on the track, its trucks the truck spacing apart; on straight track the couplers meet', () => {
    const bent = placeTrain(net, { units: doc.cases[1]!.units, position: doc.cases[1]!.position }, stock, doc.cases[1]!.states)!;
    for (const u of bent.units) {
      const s = stock.get(u.stock)!;
      expect(Math.hypot(u.frontTruck.x - u.rearTruck.x, u.frontTruck.y - u.rearTruck.y)).toBeCloseTo(s.trucks[0]!.at - s.trucks[1]!.at, 4);
    }
    // (On a bend as sharp as this made-up point's legs they can't quite: the coupler check says so.)
    const placed = placeTrain(net, { units: doc.cases[0]!.units, position: doc.cases[0]!.position }, stock)!;
    for (const u of placed.units) {
      const s = stock.get(u.stock)!;
      const spacing = s.trucks[0]!.at - s.trucks[1]!.at;
      expect(Math.hypot(u.frontTruck.x - u.rearTruck.x, u.frontTruck.y - u.rearTruck.y)).toBeCloseTo(spacing, 4);
    }
    for (let i = 1; i < placed.units.length; i++) {
      const a = placed.units[i - 1]!.rearCoupler;
      const b = placed.units[i]!.frontCoupler;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.05);
    }
  });

  it('walks back through switches as they are set', () => {
    const head: TrainPosition = { brick: 'E', from: 0, to: 1, s: 8, facing: 'to' };
    const straight = trackBehind(net, head, 60);
    const diverging = trackBehind(net, head, 60, { 'Q/0': 2 });
    expect(straight.pts.some((p) => Math.abs(p.p.y) > 1)).toBe(false);
    expect(diverging.pts.some((p) => Math.abs(p.p.y - 8) < 0.01)).toBe(true);
  });
});

describe('rolling stock records', () => {
  it('a simple car has its trucks a quarter in from each end', () => {
    const s = simpleStock('c1', { length: 40 });
    expect(s.trucks.map((t) => t.at)).toEqual([10, -10]);
    expect(s.bodyLength).toBe(38);
    expect(s.look.mode).toBe('simple');
  });

  it('read back with defaults and unknown fields kept', () => {
    const s = asStock({ id: 'x', number: 'SP 4449', length: 34, future: 1, kind: 'rocket' });
    expect(s).toMatchObject({ id: 'x', number: 'SP 4449', length: 34, kind: 'car', future: 1 });
    expect(s.trucks).toHaveLength(2);
    expect(trainLength({ units: [{ stock: 'x', reversed: false }, { stock: 'y', reversed: false }] }, new Map([['x', s]]))).toBe(34);
  });

  it('a BlueBrick train part is as long as its two magnet couplers are apart', () => {
    expect(partStockLength([{ type: 'magnet', x: -16.75, y: 0 }, { type: 'magnet', x: 16.75, y: 0 }])).toBeCloseTo(33.5);
    expect(partStockLength([{ type: '1', x: 0, y: 0 }])).toBeNull();
  });
});
