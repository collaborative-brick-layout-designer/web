// Cars on the track against the shared contract (fixtures/contracts/
// cuts.json, on route-search.json's network): the desktop's
// tests/track/CutsTest.cpp checks the same, so a drag does the same in both
// apps, and a layout two people changed at once reads the same.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CUT_LIMITS, settleTrains, startDrag, takeOut, type CutChange } from './cuts.js';
import { TrackNetwork, type TrackBrickInput } from './network.js';
import type { TrackConn } from './partTrack.js';
import { asStock, placeTrain, type RollingStock, type Train } from './trains.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'cuts.json');
const net0 = JSON.parse(readFileSync(join(DIR, 'route-search.json'), 'utf8')) as {
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
};
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  limits: unknown;
  stock: Record<string, Record<string, unknown>>;
  settle: { name: string; trains: Train[]; cars?: Record<string, string>; expect: unknown }[];
  moves: { name: string; trains: Train[]; train: string; unit: number; to: [number, number]; states?: Record<string, number>; expect: unknown }[];
  takeOuts: { name: string; trains: Train[]; car: string; expect: unknown }[];
};
const net = new TrackNetwork(
  net0.bricks.map((b): TrackBrickInput => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })),
);
const stockOf = (cars: Record<string, string> = {}) =>
  new Map<string, RollingStock>(Object.entries(doc.stock).map(([id, s]) => [id, asStock({ ...s, id, ...(cars[id] ? { opsCut: cars[id] } : {}) })]));
const stock = stockOf();
const r = (v: number) => Math.round(v * 1e3) / 1e3 + 0;
const unitsText = (t: Train) => t.units.map((u) => (u.reversed ? '-' : '') + u.stock);
const shown = (c: CutChange) => ({
  trains: c.trains.map((t) => ({
    id: t.id,
    name: t.name,
    cut: !!t.cut,
    units: unitsText(t),
    position: t.position && { ...t.position, s: r(t.position.s) },
    over: Object.fromEntries(Object.entries(t.over ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
  })),
  cars: Object.fromEntries(Object.entries(c.cars).sort(([a], [b]) => (a < b ? -1 : 1))),
  emptied: c.emptied,
});
const writing = process.env.BLD_WRITE_CONTRACTS === '1';
/** Compare, with a thousandth's slack on the numbers. */
const same = (c: { expect: unknown }, got: unknown) => {
  if (writing) c.expect = got;
  else expect(got).toEqual(c.expect);
};

describe('settling', () => {
  for (const c of doc.settle)
    it(c.name, () => {
      const out = settleTrains(c.trains, stockOf(c.cars));
      same(c, Object.fromEntries(out.map((t) => [t.id, unitsText(t)])));
      // Settling again changes nothing, whatever order they come in.
      expect(settleTrains(out, stockOf(c.cars)).map(unitsText)).toEqual(out.map(unitsText));
      const back = settleTrains([...c.trains].reverse(), stockOf(c.cars)).reverse();
      expect(back.map(unitsText)).toEqual(out.map(unitsText));
    });
});

describe('dragging', () => {
  for (const c of doc.moves)
    it(c.name, () => {
      const drag = startDrag(net, c.trains, stock, c.states ?? {}, c.train, c.unit, 'new');
      const m = drag ? drag.to({ x: c.to[0], y: c.to[1] }) : null;
      same(c, drag && m && { moved: m.moved, by: r(m.by), couples: m.couples, blockedBy: m.blockedBy, why: m.why, change: shown(m.change) });
      if (!m) return;
      // No car is lost or doubled: every car that stood somewhere stands in one record.
      const after = new Map(c.trains.map((t) => [t.id, t]));
      for (const t of m.change.trains) after.set(t.id, t);
      for (const id of m.change.emptied) after.set(id, { ...after.get(id)!, units: [] });
      const cars = (ts: Iterable<Train>) => [...ts].flatMap((t) => t.units.map((u) => u.stock)).sort();
      expect(cars(after.values())).toEqual(cars(c.trains));
      // What moved together sits together; the cars that weren't dragged didn't move.
      const before = new Map(c.trains.flatMap((t) => placeTrain(net, t, stock, c.states ?? {})?.units.map((u) => [u.stock, u.centre] as const) ?? []));
      for (const t of m.change.trains)
        for (const u of placeTrain(net, t, stock, c.states ?? {})?.units ?? []) {
          if (m.moved.includes(u.stock)) continue;
          const b = before.get(u.stock)!;
          expect(Math.hypot(u.centre.x - b.x, u.centre.y - b.y), `${u.stock} stayed`).toBeLessThan(1.1);
        }
    });
});

describe('taking a car out', () => {
  for (const c of doc.takeOuts) it(c.name, () => same(c, shown(takeOut(net, c.trains, stock, {}, c.car, 'new'))));
});

it('the limits', () => expect(CUT_LIMITS).toEqual(doc.limits));

it('a switch flipped under a standing cut leaves its cars where they were', () => {
  const t = { ...(doc.moves.find((m) => m.name.startsWith('backing over'))!.trains[0] as Train) };
  const at = (states: Record<string, number>) => placeTrain(net, t, stock, states)!.units.map((u) => [r(u.centre.x), r(u.centre.y)]);
  expect(at({ 'P/0': 2 })).toEqual(at({ 'P/0': 1 }));
});

if (writing) it('writes the contract', () => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));
