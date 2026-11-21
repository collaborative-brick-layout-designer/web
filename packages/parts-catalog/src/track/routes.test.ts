// Route search against the shared contract (fixtures/contracts/
// route-search.json): the desktop's tests/track/RoutesTest.cpp checks the
// same file, so both apps find the same way, the same length and the same
// switch settings, and say the same when there is none.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { switchKey, TrackNetwork, type TrackBrickInput, type TrackPosition } from './network.js';
import type { TrackConn } from './partTrack.js';
import { findRoute, nearestPosition, renameRouteBricks, routeFacing, routeLines, routeStatus, sameSpot, type RouteStep } from './routes.js';
import { fitChecks } from './fitChecks.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts/route-search.json');

interface Case {
  name: string;
  from: TrackPosition;
  to: TrackPosition;
  via?: TrackPosition[];
  followSwitches?: boolean;
  states?: Record<string, number>;
  facing?: 'to' | 'from';
  network?: 'loops';
  expect: null | string | { steps: RouteStep[]; length: number; switches: Record<string, number>; turnsAround: string[] };
  status?: unknown;
}
type BrickVector = { id: string; part: string; points: [number, number][]; orientation?: number; connexions: { id: string; linkedTo: string }[] };
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  _about: string;
  parts: Record<string, TrackConn[]>;
  bricks: BrickVector[];
  loopBricks: BrickVector[];
  cases: Case[];
  gaps: { a: string; b: string; at: [number, number]; gap: number }[];
};

function network(without: string[] = [], list: BrickVector[] = doc.bricks): TrackNetwork {
  const bricks: TrackBrickInput[] = list
    .filter((b) => !without.includes(b.id))
    .map((b) => ({ id: b.id, partKey: b.part, conns: doc.parts[b.part]!, points: b.points.flat(), orientation: b.orientation ?? 0, connexions: b.connexions }));
  return new TrackNetwork(bricks);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

describe('route search', () => {
  const main = network();
  const withoutM = network(['M']);
  const loops = network([], doc.loopBricks);
  for (const c of doc.cases) {
    it(c.name, () => {
      const net = c.network === 'loops' ? loops : main;
      const got = findRoute(net, c.from, c.to, {
        ...(c.via ? { via: c.via } : {}),
        ...(c.followSwitches ? { followSwitches: true } : {}),
        ...(c.states ? { states: c.states } : {}),
        ...(c.facing ? { facing: c.facing } : {}),
      });
      const plain = typeof got === 'string' ? got : { ...got, length: round(got.length) };
      const status =
        typeof got === 'string'
          ? null
          : (() => {
              const st = routeStatus(c.network === 'loops' ? loops : withoutM, { steps: got.steps, from: c.from, to: c.to });
              return st.status === 'ok' ? { status: 'ok', length: round(st.length) } : st;
            })();
      if (writing) {
        c.expect = plain;
        c.status = status;
        return;
      }
      expect(plain).toEqual(c.expect);
      expect(status).toEqual(c.status);
    });
  }
  it('joins loose ends that nearly meet, for trains', () => {
    expect(main.gaps).toEqual([]);
    const got = loops.gaps.map((g) => ({ a: switchKey(g.a.brick, g.a.conn), b: switchKey(g.b.brick, g.b.conn), at: [round(g.at.x), round(g.at.y)] as [number, number], gap: round(g.gap) }));
    if (writing) {
      doc.gaps = got;
      return;
    }
    expect(got).toEqual(doc.gaps);
    for (const g of loops.gaps) {
      expect(loops.partner(g.a)).toEqual(g.b);
      expect(loops.partner(g.b)).toEqual(g.a);
    }
  });
  it('says where track nearly meets, as a fit check', () => {
    const gaps = fitChecks(loops, { trains: [], stock: new Map() }).filter((c) => c.kind === 'gap');
    expect(gaps.map((c) => [c.key, c.severity, round(c.values.gap!)])).toEqual([
      ['gap:456/0:492/1', 'warning', 0.639312],
      ['gap:GL/0:GT/0', 'warning', 0.6],
    ]);
    expect(fitChecks(main, { trains: [], stock: new Map() }).filter((c) => c.kind === 'gap')).toEqual([]);
  });
  it('keeps the way a saved route runs when it finds a new one', () => {
    const c = doc.cases.find((x) => x.name.startsWith('heading on round an oval'))!;
    const got = findRoute(loops, c.from, c.to, { facing: 'to' });
    if (typeof got === 'string') throw new Error(got);
    expect(routeFacing({ steps: got.steps, from: c.from })).toBe('to');
    const back = findRoute(loops, c.from, c.to);
    if (typeof back === 'string') throw new Error(back);
    expect(routeFacing({ steps: back.steps, from: c.from })).toBe('from');
  });
  it('a click on a switch’s heel end is on each of its legs', () => {
    // P's legs share their first stud or so: a place there on the straight leg is on the diverging one too.
    const spots = sameSpot(main, { brick: 'P', from: 0, to: 1, s: 0.2 });
    expect(spots.map((p) => [p.from, p.to])).toEqual([[0, 1], [0, 2]]);
    expect(sameSpot(main, { brick: 'P', from: 0, to: 1, s: 12 })).toHaveLength(1);
  });
  if (writing) it('writes the contract', () => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));
});

describe('a saved route', () => {
  const net = network();
  const c = doc.cases[0]!;
  const found = findRoute(net, c.from, c.to);
  if (typeof found === 'string') throw new Error(found);
  const route = { steps: found.steps, from: c.from, to: c.to };

  it('is ok while the track is there, with its length and switches, and none set against it at their defaults', () => {
    const st = routeStatus(net, route, {});
    expect(st).toMatchObject({ status: 'ok', setAgainst: [] });
    if (st.status !== 'ok') return;
    expect(st.length).toBeCloseTo(found.length, 6);
    expect(Object.keys(st.switches).sort()).toEqual(['P/0']);
    // Set the other way: it says so.
    expect(routeStatus(net, route, { 'P/0': 2 })).toMatchObject({ status: 'ok', setAgainst: ['P/0'] });
  });

  it('turns broken, keeping its steps, when a part on it goes; and draws as far as it goes', () => {
    const st = routeStatus(network(['M']), route);
    expect(st).toEqual({ status: 'broken', at: 2, brick: 'M' });
    expect(routeLines(network(['M']), route).length).toBe(2); // A and P, then Q and E
    expect(routeLines(net, route).length).toBe(1);
  });

  it('a click finds the nearest track, within reach', () => {
    expect(nearestPosition(net, { x: 50, y: 7.5 }, 2)).toMatchObject({ brick: 'B', from: 0, to: 1 });
    expect(nearestPosition(net, { x: 50, y: 7.5 }, 2)!.s).toBeCloseTo(18, 6);
    expect(nearestPosition(net, { x: 50, y: 30 }, 2)).toBeNull();
  });

  it('follows bricks renamed', () => {
    const r = renameRouteBricks({ ...route, via: [{ at: c.from }] }, (id) => (id === 'A' ? 'A2' : id));
    expect(r.from.brick).toBe('A2');
    expect(r.via[0]!.at.brick).toBe('A2');
    expect(r.steps[0]!.brick).toBe('A2');
    expect(r.to.brick).toBe('E');
  });
});
