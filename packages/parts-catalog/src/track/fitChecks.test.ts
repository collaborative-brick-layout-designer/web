// Fit checks against the shared contract (fixtures/contracts/
// train-geometry.json: `overhang`, `runs` and `checks`, on route-search.json's
// network): the desktop's tests/track/FitChecksTest.cpp checks the same, so
// both apps find the same problems with the same numbers.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrackNetwork, type TrackBrickInput, type TrackPosition } from './network.js';
import type { TrackConn } from './partTrack.js';
import { findRoute, type Route } from './routes.js';
import { asStock, type RollingStock, type Train, type TrainPosition } from './trains.js';
import { fitChecks, foulingBeyond, overhang, trackRuns } from './fitChecks.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'train-geometry.json');
const net0 = JSON.parse(readFileSync(join(DIR, 'route-search.json'), 'utf8')) as {
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
};
type CheckCase = {
  name: string;
  states?: Record<string, number>;
  trains: { id: string; units: { stock: string; reversed: boolean }[]; position: TrainPosition }[];
  routes?: { id: string; from: TrackPosition; via?: TrackPosition[]; to: TrackPosition }[];
  expect?: unknown;
};
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  stock: Record<string, Record<string, unknown>>;
  overhang: { name: string; radius: number; spacing: number; body: number; width: number; expect?: unknown }[];
  runs?: unknown;
  checks: CheckCase[];
  [k: string]: unknown;
};
const net = new TrackNetwork(
  net0.bricks.map((b): TrackBrickInput => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })),
);
const stock = new Map<string, RollingStock>(Object.entries(doc.stock).map(([id, s]) => [id, asStock({ ...s, id })]));
const r = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

describe('fit checks', () => {
  it('overhang on a curve, as the design works it out', () => {
    const got = doc.overhang.map((o) => {
      const h = overhang(o.radius, o.spacing, o.body, o.width);
      return { middle: r(h.middle), end: r(h.end), corner: r(h.corner), swivel: r(h.swivel) };
    });
    // The design's example: middle 1.27 in, ends 1.18 out (corner 1.02), trucks 14.5°.
    expect(got[0]!.middle).toBeCloseTo(1.27, 2);
    expect(got[0]!.end).toBeCloseTo(1.18, 2);
    expect(got[0]!.corner).toBeCloseTo(1.02, 2);
    expect(got[0]!.swivel).toBeCloseTo(14.48, 2);
    if (writing) doc.overhang.forEach((o, i) => (o.expect = got[i]));
    else doc.overhang.forEach((o, i) => expect(got[i]).toEqual(o.expect));
  });

  it('track runs and their usable lengths', () => {
    const got = trackRuns(net).map((run) => ({
      steps: run.steps.map((s) => `${s.brick}/${s.from}/${s.to}`),
      length: r(run.length),
      usable: r(run.usable),
      ends: run.ends.map((e) => ({ kind: e.kind, switch: e.switch ?? null, foul: r(e.foul) })),
    }));
    if (writing) doc.runs = got;
    else expect(got).toEqual(doc.runs);
  });

  it('the fouling point of a leg, for a wider clearance', () => {
    const sw = net.switchAt('P/0')!;
    expect(foulingBeyond(net, sw, 1, 8)).toBe(0);
    // Wider than the parallel tracks are apart: it never clears, so the whole run is fouled.
    expect(foulingBeyond(net, sw, 1, 10, 50)).toBeCloseTo(50 - net.pathLength('P', 0, 1), 6);
  });

  for (const c of doc.checks) {
    it(c.name, () => {
      const trains: Train[] = c.trains.map((t) => ({ id: t.id, name: t.id, trackKind: 'rail', units: t.units, position: t.position, color: '', speed: 40 }));
      const routes: Route[] = (c.routes ?? []).map((x) => {
        const found = findRoute(net, x.from, x.to, { via: x.via ?? [] });
        if (typeof found === 'string') throw new Error(found);
        return { id: x.id, name: x.id, train: null, from: x.from, to: x.to, via: (x.via ?? []).map((at) => ({ at, reverse: false })), steps: found.steps, color: '' };
      });
      const got = fitChecks(net, { trains, stock, routes, states: c.states ?? {} }).map((k) => ({
        key: k.key,
        kind: k.kind,
        severity: k.severity,
        at: [r(k.at.x), r(k.at.y)],
        values: Object.fromEntries(Object.entries(k.values).map(([n, v]) => [n, r(v)])),
      }));
      if (writing) c.expect = got;
      else expect(got).toEqual(c.expect);
    });
  }
  if (writing) it('writes the contract', () => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));
});
