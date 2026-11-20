// The track network against the shared contracts (fixtures/contracts/
// track-kinds.json, track-paths.json, track-network.json): the desktop's
// tests/track/TrackNetworkTest.cpp checks the same files, so both apps
// find the same ways through, the same switches and the same network.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRACK_KINDS, TRACK_PATHS } from './tables.js';
import { partTrack, trackKindOf, wrapDegrees, type TrackConn } from './partTrack.js';
import { cleanSwitchStates, nextExit, parseSwitchKey, switchKey, TrackNetwork, type TrackBrickInput } from './network.js';
import { withoutGoneSwitches } from './fromMap.js';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const read = (name: string) => JSON.parse(readFileSync(join(CONTRACTS, name), 'utf8')) as unknown;

interface PartVector {
  connections: TrackConn[];
  expect: {
    kinds: (string | null)[];
    paths: [number, number][];
    switches: { heel: number; exits: number[]; default: number; legs: Record<string, string> }[];
  };
}
interface LayoutVector {
  name: string;
  bricks: { id: string; part: string; pivot: [number, number]; orientation: number; connexions: { id: string; linkedTo: string }[] }[];
  expect: {
    bricks: string[];
    switches: { key: string; exits: number[]; default: number }[];
    partners: Record<string, string | null>;
    exits: Record<string, number[]>;
    ports: Record<string, [number, number, number]>;
    lengths: Record<string, number>;
  };
}
const NETWORK_FILE = join(CONTRACTS, 'track-network.json');
const network = read('track-network.json') as { _about: string; parts: Record<string, PartVector>; layouts: LayoutVector[] };

/** The layout's bricks, placed as the contract says: world = pivot + rotate(local). */
function placed(layout: LayoutVector): TrackBrickInput[] {
  return layout.bricks.map((b) => {
    const conns = network.parts[b.part]!.connections;
    const r = (b.orientation * Math.PI) / 180;
    const points: number[] = [];
    for (const c of conns) points.push(b.pivot[0] + c.x * Math.cos(r) - c.y * Math.sin(r), b.pivot[1] + c.x * Math.sin(r) + c.y * Math.cos(r));
    return { id: b.id, partKey: b.part, conns, points, orientation: b.orientation, connexions: b.connexions };
  });
}

describe('track tables', () => {
  it('are the shared contracts word for word', () => {
    expect(TRACK_KINDS).toEqual(read('track-kinds.json'));
    expect(TRACK_PATHS).toEqual(read('track-paths.json'));
  });

  it('say which types are track, and what kind', () => {
    expect(trackKindOf('1', false)).toBe('rail');
    expect(trackKindOf('mono45', false)).toBe('monorail');
    expect(trackKindOf('trixbrix_sw_r40_left_turn', false)).toBe('rail');
    expect(trackKindOf('NT_SPLITWYE', false)).toBe('rail');
    expect(trackKindOf('NT_SPLITTER', true)).toBeNull(); // not track, though it starts like a split
    expect(trackKindOf('magnet', false)).toBeNull();
    expect(trackKindOf('2', false)).toBeNull(); // road
    expect(trackKindOf('trixbrix_mils', true)).toBeNull();
    // A new 9V-style package: a type in a circuit is rail; one that isn't, isn't track.
    expect(trackKindOf('acme_rail', true)).toBe('rail');
    expect(trackKindOf('acme_rail', false)).toBeNull();
  });
});

describe('ways through a part', () => {
  for (const [key, v] of Object.entries(network.parts)) {
    it(key, () => {
      const t = partTrack(key, v.connections);
      expect(t.kinds).toEqual(v.expect.kinds);
      expect(t.paths).toEqual(v.expect.paths);
      expect(t.switches.map((s) => ({ ...s, legs: Object.fromEntries(Object.entries(s.legs).map(([k, n]) => [String(k), n])) }))).toEqual(v.expect.switches);
    });
  }

  it('never goes frog to frog', () => {
    for (const key of ['2861.8', '2859.8', '948AC01.1', '2889.7', '6379CX1.8', 'TS_WYEDIVERGER.8']) {
      const t = partTrack(key, network.parts[key]!.connections);
      const legs = t.switches[0]!.exits;
      expect(t.paths).not.toContainEqual([legs[0], legs[1]]);
    }
  });

  it('wraps angles into (-180, 180]', () => {
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(-337.5)).toBeCloseTo(22.5);
    expect(wrapDegrees(270)).toBe(-90);
  });
});

describe('the network of a layout', () => {
  const writing = process.env.BLD_WRITE_CONTRACTS === '1';
  for (const layout of network.layouts) {
    it(layout.name, () => {
      const net = new TrackNetwork(placed(layout));
      const e = layout.expect;
      expect(net.brickIds).toEqual(e.bricks);
      expect(net.switches.map((s) => ({ key: s.key, exits: s.exits, default: s.default }))).toEqual(e.switches);
      for (const [port, want] of Object.entries(e.partners)) {
        const p = parseSwitchKey(port)!;
        const got = net.partner({ brick: p.brick, conn: p.heel });
        expect(got ? switchKey(got.brick, got.conn) : null, port).toBe(want);
      }
      for (const [port, want] of Object.entries(e.exits)) {
        const p = parseSwitchKey(port)!;
        expect(net.exits(p.brick, p.heel), port).toEqual(want);
      }
      const ports: Record<string, [number, number, number]> = {};
      const lengths: Record<string, number> = {};
      for (const id of net.brickIds) {
        const t = net.trackOf(id)!;
        t.kinds.forEach((k, i) => {
          if (k === null) return;
          const at = net.port(id, i)!;
          ports[`${id}/${i}`] = [round(at.p.x), round(at.p.y), round(at.angle)];
        });
        for (const [i, j] of t.paths) lengths[`${id}/${i}-${j}`] = round(net.pathLength(id, i, j));
      }
      if (writing) {
        e.ports = ports;
        e.lengths = lengths;
        return;
      }
      for (const [k, [x, y, a]] of Object.entries(e.ports)) {
        expect(ports[k]![0], k).toBeCloseTo(x, 6);
        expect(ports[k]![1], k).toBeCloseTo(y, 6);
        expect(ports[k]![2], k).toBeCloseTo(a, 6);
      }
      expect(Object.keys(ports).sort()).toEqual(Object.keys(e.ports).sort());
      for (const [k, len] of Object.entries(e.lengths)) expect(lengths[k], k).toBeCloseTo(len, 6);
      expect(Object.keys(lengths).sort()).toEqual(Object.keys(e.lengths).sort());
    });
  }
  if (writing) {
    it('writes the contract', () => {
      writeFileSync(NETWORK_FILE, `${JSON.stringify(network, null, 1)}\n`);
    });
  }
});

describe('switch settings', () => {
  const net = new TrackNetwork(placed(network.layouts[0]!));
  const p = net.switchAt('P/0')!;

  it('read the stored exit, or the default for none or a wrong one', () => {
    expect(net.settingOf(p, {})).toBe(1);
    expect(net.settingOf(p, { 'P/0': 2 })).toBe(2);
    expect(net.settingOf(p, { 'P/0': 0 })).toBe(1);
    expect(net.settingOf(p, { 'P/0': 7 })).toBe(1);
  });

  it('flip round their exits', () => {
    expect(nextExit(p, 1)).toBe(2);
    expect(nextExit(p, 2)).toBe(1);
  });

  it('keep only keys for switches here (reading) and for bricks still on the map (writing)', () => {
    const states = { 'P/0': 2, 'P/1': 0, 'Gone/0': 1, 'M/0': 9 };
    expect(cleanSwitchStates(states, net)).toEqual({ 'P/0': 2 });
    expect(withoutGoneSwitches(states, new Set(['P', 'M']))).toEqual({ 'P/0': 2, 'P/1': 0, 'M/0': 9 });
  });

  it('keys are "<brick>/<heel>", and brick ids may hold a slash', () => {
    expect(switchKey('a/b', 2)).toBe('a/b/2');
    expect(parseSwitchKey('a/b/2')).toEqual({ brick: 'a/b', heel: 2 });
    expect(parseSwitchKey('nope')).toBeNull();
    expect(parseSwitchKey('B/1.5')).toBeNull();
    expect(parseSwitchKey('B/01')).toBeNull();
  });
});

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
