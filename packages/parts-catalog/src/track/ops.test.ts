// Waybills, jobs and routing against the shared contract (fixtures/
// contracts/ops-routing.json): the desktop's tests/track/OpsTest.cpp checks
// the same, so a layout routes the same in both apps.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  asJob, asWaybill, brokenStops, currentSlot, JOB_KINDS, makeWaybills, OPS_LIMITS, orderBetween, pocketOf, ROUTE_STEPS, routeCars, spotUnder, turnedWaybill, WAYBILL_SLOTS,
  type MakeCar, type MakePlace, type OpsCar, type OpsJob, type OpsPlace, type OpsRouting,
} from './ops.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts/ops-routing.json');
interface Case { name: string; expect: unknown }
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  limits: unknown;
  routing: (Case & { places: OpsPlace[]; cars: OpsCar[]; jobs: OpsJob[]; maxSteps?: number })[];
  make: (Case & { cars: MakeCar[]; places: MakePlace[]; heading: Record<string, number>; seed: number })[];
  waybills: (Case & { record: Record<string, unknown>; load: string })[];
  jobs: (Case & { record: Record<string, unknown> })[];
  spotUnder: { spots: { place: string; spot: string; line: [number, number][] }[]; cases: { trucks: [number, number][]; expect: unknown }[] };
  broken: { places: OpsPlace[]; cases: (Case & { stops: string[] })[] };
  between: { a: number | null; b: number | null; expect: unknown }[];
};
const writing = process.env.BLD_WRITE_CONTRACTS === '1';
const same = (c: { expect: unknown }, got: unknown) => {
  if (writing) c.expect = got;
  else expect(got).toEqual(c.expect);
};
afterAll(() => {
  if (writing) writeFileSync(FILE, JSON.stringify(doc, null, 1) + '\n');
});
/** What a routing says, as the contract writes it (lists: no ids as keys). */
const shown = (r: OpsRouting) => ({
  cars: [...r.cars.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([car, v]) => ({ car, ...v })),
  arrived: r.arrived,
  cantRoute: r.cantRoute,
  lists: [...r.lists.entries()].map(([job, stops]) => ({ job, stops })),
});

describe('the contract', () => {
  it('limits', () => same({ get expect() { return doc.limits; }, set expect(v) { doc.limits = v; } }, { ...OPS_LIMITS, slots: WAYBILL_SLOTS, steps: ROUTE_STEPS, kinds: [...JOB_KINDS] }));
  for (const c of doc.routing)
    it(`routing: ${c.name}`, () => {
      const got = shown(routeCars(c));
      same(c, got);
      // Whatever order the cars come in (each id once).
      if (new Set(c.cars.map((x) => x.id)).size === c.cars.length) expect(shown(routeCars({ ...c, cars: [...c.cars].reverse() }))).toEqual(got);
    });
  for (const c of doc.make) it(`make: ${c.name}`, () => same(c, makeWaybills(c.cars, c.places, new Map(Object.entries(c.heading)), c.seed)));
  for (const c of doc.waybills)
    it(`waybill: ${c.name}`, () => {
      const w = asWaybill(c.record);
      same(c, { waybill: w, slot: currentSlot(w), turned: turnedWaybill(w, c.load) });
    });
  for (const c of doc.jobs) it(`job: ${c.name}`, () => same(c, asJob(c.record)));
  doc.spotUnder.cases.forEach((c, i) =>
    it(`spot under ${i}`, () => same(c, spotUnder(c.trucks.map(([x, y]) => ({ x, y })), doc.spotUnder.spots.map((s) => ({ ...s, line: s.line.map(([x, y]) => ({ x, y })) }))))));
  for (const c of doc.broken.cases) it(`broken: ${c.name}`, () => same(c, brokenStops(c.stops, doc.broken.places)));
  doc.between.forEach((c, i) => it(`between ${i}`, () => same(c, orderBetween(c.a, c.b))));
});

describe('in a big layout', () => {
  it('routes 2000 cars over 100 jobs of 40 stops without freezing, or says it is too much', () => {
    const places: OpsPlace[] = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, kind: i % 10 ? 'industry' : 'yard', spots: [{ id: 's', capacity: 5, usable: null, role: '', track: 1 }] }));
    const cars: OpsCar[] = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, length: 32, at: { place: `p${i % 1000}`, spot: 's' }, onTrack: true, train: '', unit: 0, fromEngine: 0, to: { place: `p${(i * 7 + 3) % 1000}`, spot: '', why: 'waybill' }, hold: false }));
    const jobs: OpsJob[] = Array.from({ length: 100 }, (_, j) => ({ id: `j${j}`, train: '', stops: Array.from({ length: 40 }, (_, k) => `p${(j * 37 + k * 11) % 1000}`) }));
    const t0 = performance.now();
    const r = routeCars({ places, cars, jobs });
    expect(performance.now() - t0).toBeLessThan(2000);
    // Every car is accounted for: going, there, or why not.
    expect(r.cars.size + r.arrived.length + r.cantRoute.length).toBe(2000);
    expect(r.cantRoute.some((c) => c.why === 'tooMuch')).toBe(true);
  });

  it('makes 2000 waybills over 2000 places', () => {
    const places: MakePlace[] = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, ships: ['boxcar'], accepts: ['boxcar'], capacity: 2 }));
    const t0 = performance.now();
    const r = makeWaybills(Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, type: 'boxcar', at: '' })), places, new Map(), 9);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.made.length + r.skipped.length).toBe(2000);
    expect(r.made.length).toBe(2000);
  });
});

describe('the pocket', () => {
  it('a waybill is a car’s when both say so', () => {
    const w = asWaybill({ id: 'w', car: 'a', leg: 1, to1: 'x' });
    const all = new Map([['w', w]]);
    expect(pocketOf({ id: 'a', opsWaybill: 'w' }, all)).toBe(w);
    expect(pocketOf({ id: 'b', opsWaybill: 'w' }, all)).toBeNull();
    expect(pocketOf({ id: 'a', opsWaybill: 'v' }, all)).toBeNull();
    expect(pocketOf({ id: 'a' }, all)).toBeNull();
  });
});
