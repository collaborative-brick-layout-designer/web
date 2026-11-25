// A spot on the track against the shared contract (fixtures/contracts/
// places.json `onTrack`, on route-search.json's network): the desktop's
// tests/track/PlacesOnTrackTest.cpp checks the same.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { TrackNetwork, type TrackBrickInput } from './network.js';
import type { TrackConn } from './partTrack.js';
import { trackRuns } from './fitChecks.js';
import { spotOnTrack } from './places.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'places.json');
const net0 = JSON.parse(readFileSync(join(DIR, 'route-search.json'), 'utf8')) as {
  parts: Record<string, TrackConn[]>;
  bricks: { id: string; part: string; points: [number, number][]; connexions: { id: string; linkedTo: string }[] }[];
};
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as { onTrack: { track: { brick: string; from: number; to: number }; wanted: number | null; expect?: unknown }[] };
const net = new TrackNetwork(
  net0.bricks.map((b): TrackBrickInput => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })),
);
const r = (v: number) => Math.round(v * 1e4) / 1e4 || 0;

it('where a spot is on the track, and what a train can stand in there', () => {
  const runs = trackRuns(net);
  for (const c of doc.onTrack) {
    const s = spotOnTrack(net, runs, c.track, c.wanted);
    const got = s
      ? { usable: s.usable === null ? null : r(s.usable), length: r(s.length), middle: [r(s.middle.x), r(s.middle.y)], from: [r(s.line[0]!.x), r(s.line[0]!.y)], to: [r(s.line.at(-1)!.x), r(s.line.at(-1)!.y)], points: s.line.length }
      : null;
    if (process.env.BLD_WRITE_CONTRACTS === '1') c.expect = got;
    else expect(got, JSON.stringify(c)).toEqual(c.expect);
  }
  if (process.env.BLD_WRITE_CONTRACTS === '1') writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`);
});
