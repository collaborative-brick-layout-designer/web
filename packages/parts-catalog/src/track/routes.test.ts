// Route search against the shared contract (fixtures/contracts/
// route-search.json): the desktop's tests/track/RoutesTest.cpp checks the
// same file, so both apps find the same way, the same length and the same
// switch settings, and say the same when there is none.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrackNetwork, type TrackBrickInput, type TrackPosition } from './network.js';
import type { TrackConn } from './partTrack.js';
import { findRoute, nearestPosition, renameRouteBricks, routeLines, routeStatus, type RouteStep } from './routes.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts/route-search.json');

interface Case {
  name: string;
  from: TrackPosition;
  to: TrackPosition;
  via?: TrackPosition[];
  followSwitches?: boolean;
  states?: Record<string, number>;
  expect: null | string | { steps: RouteStep[]; length: number; switches: Record<string, number>; turnsAround: string[] };
  status?: unknown;
}
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  _about: string;
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
  cases: Case[];
};

function network(without: string[] = []): TrackNetwork {
  const bricks: TrackBrickInput[] = doc.bricks
    .filter((b) => !without.includes(b.id))
    .map((b) => ({ id: b.id, partKey: b.part, conns: doc.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions }));
  return new TrackNetwork(bricks);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

describe('route search', () => {
  const net = network();
  const withoutM = network(['M']);
  for (const c of doc.cases) {
    it(c.name, () => {
      const got = findRoute(net, c.from, c.to, { ...(c.via ? { via: c.via } : {}), ...(c.followSwitches ? { followSwitches: true } : {}), ...(c.states ? { states: c.states } : {}) });
      const plain = typeof got === 'string' ? got : { ...got, length: round(got.length) };
      const status =
        typeof got === 'string'
          ? null
          : (() => {
              const st = routeStatus(withoutM, { steps: got.steps, from: c.from, to: c.to });
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
