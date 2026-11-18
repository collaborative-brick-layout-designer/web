// The guard's rigid-move check on shared modules (ws/sharedGuard.ts
// rigidMoveProblem, docs/shared-modules.md "Keeping it read-only", layer
// 2): what the apps do to a shared module as a whole is never refused
// (moves, turns by any angle, arrow keys, Move…, a group snap, a
// multi-select move with other parts, another sheet, two people at once),
// with parts that have a hull, and parts no catalog knows; what pulls its
// parts apart is; and a broken lock is put back by the server, ids and all.
//
// Property tests: random modules moved and turned at random, the way the
// apps move them (each part about its pivot, its box worked out again),
// are never refused; the same with one part off by a stud or more are.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import type { SidecarModule } from '@cld/bbm';
import { appendBricks, areaForPivot, pivotOf, rotated, type PartGeom, type PartLookup, type Pt } from '@cld/modules';
import { decodeIncoming } from './decoded.js';
import { racedParts, repairShared, rigidMoveProblem, sharedLockCheck, type LockBreak, type PartPose } from './sharedGuard.js';
import { SHEET } from '../test/sharedWorld.js';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';

/** Parts the catalog knows: a plain one, and two with a hull (from fixtures/contracts/shared-module-placement.json). */
const CATALOG: Record<string, PartGeom> = {
  'straight.1': { pxPerStud: 8, spriteSize: { w: 128, h: 32 } },
  'switch.1': { pxPerStud: 8, spriteSize: { w: 256, h: 96 }, hullPts: [{ x: 0, y: 0 }, { x: 255, y: 0 }, { x: 255, y: 31 }, { x: 128, y: 95 }, { x: 0, y: 31 }] },
  'ramp.1': { pxPerStud: 8, spriteSize: { w: 64, h: 48 }, hullPts: [{ x: 0, y: 47 }, { x: 63, y: 0 }, { x: 63, y: 47 }] },
};
const partOf: PartLookup = (pn) => CATALOG[pn.toLowerCase()];

/** A seeded random number generator (mulberry32): the same cases every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  pn: string;
  pivot: Pt;
  o: number;
}

/** A layout with one shared module of `parts` (placed where each pivot says) and a loose part. */
function room(parts: readonly Spec[]): { doc: Y.Doc; ids: string[]; loose: string } {
  const doc = createDefaultLayoutDoc();
  let ids: string[] = [];
  let loose = '';
  doc.transact(() => {
    ids = appendBricks(
      doc,
      SHEET,
      parts.map((p) => ({ partNumber: p.pn, orientation: p.o, displayArea: areaForPivot(partOf(p.pn), p.o, p.pivot, { width: 2, height: 2 }) })),
    );
    loose = appendBricks(doc, SHEET, [{ partNumber: 'loose.1', displayArea: { x: 500, y: 500, width: 2, height: 2 } }])[0]!;
    const cache = readSidecarCache(doc) ?? { schemaVersion: 1, bbmHashSha256: '' };
    const mod: SidecarModule = {
      id: 'locked',
      name: 'Harbor crane',
      members: ids,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      libraryModuleId: LIB,
      libraryVersion: 1,
      shared: { by: 'alice', placement: { degrees: 0, x: 0, y: 0, sheets: { Layout: SHEET } } },
    } as SidecarModule;
    writeSidecarCache(doc, { ...cache, modules: [mod] });
  });
  return { doc, ids, loose };
}

function partMaps(doc: Y.Doc): Map<string, Y.Map<unknown>> {
  const out = new Map<string, Y.Map<unknown>>();
  for (const layer of doc.getMap<Y.Map<unknown>>('layerData').values()) {
    const list = layer.get('bricks');
    if (!(list instanceof Y.Array)) continue;
    for (const b of list) if (b instanceof Y.Map) out.set(b.get('id') as string, b);
  }
  return out;
}

/** Turn part `m` by `degrees` about `about` and move it by (dx, dy), as the apps do: about its pivot, its box worked out again. */
function moveLikeApps(m: Y.Map<unknown>, degrees: number, about: Pt, dx: number, dy: number): void {
  const pn = m.get('partNumber') as string;
  const area = m.get('displayArea') as { x: number; y: number; width: number; height: number };
  const o = (m.get('orientation') as number) ?? 0;
  const part = partOf(pn);
  const p = pivotOf({ displayArea: area, orientation: o }, part);
  const r = rotated({ x: p.x - about.x, y: p.y - about.y }, degrees);
  const to = { x: about.x + r.x + dx, y: about.y + r.y + dy };
  const next = o + degrees;
  m.set('displayArea', areaForPivot(part, next, to, area));
  m.set('orientation', ((next % 360) + 360) % 360);
}

/** The update a client holding the room's document sends for `change`. */
function edit(doc: Y.Doc, change: (client: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  const sv = Y.encodeStateVector(client);
  client.transact(() => change(client));
  const u = Y.encodeStateAsUpdate(client, sv);
  client.destroy();
  return u;
}

const check = (doc: Y.Doc, u: Uint8Array, lookup: PartLookup | undefined = partOf) => {
  const r = sharedLockCheck(doc, u, decodeIncoming(u)!, undefined, lookup);
  return r === null || typeof r === 'string' ? r : r.why;
};

const CRANE: Spec[] = [
  { pn: 'straight.1', pivot: { x: 100, y: 50 }, o: 0 },
  { pn: 'straight.1', pivot: { x: 116, y: 50 }, o: 0 },
  { pn: 'switch.1', pivot: { x: 140, y: 52 }, o: 0 },
  { pn: 'ramp.1', pivot: { x: 120, y: 70 }, o: 30 },
  { pn: 'mystery.1', pivot: { x: 104, y: 64 }, o: 90 },
];

describe('moving a shared module as a whole', () => {
  it('lets every way the apps move one through: moves, turns, arrow keys, Move…, a snap, a multi-select, another sheet', () => {
    const { doc, ids, loose } = room(CRANE);
    const all = (c: Y.Doc, degrees: number, about: Pt, dx: number, dy: number, extra: string[] = []) => {
      const maps = partMaps(c);
      for (const id of [...ids, ...extra]) moveLikeApps(maps.get(id)!, degrees, about, dx, dy);
    };
    const cases: [string, Uint8Array][] = [
      ['a drag', edit(doc, (c) => all(c, 0, { x: 0, y: 0 }, 37.25, -12.5))],
      ['an arrow key', edit(doc, (c) => all(c, 0, { x: 0, y: 0 }, 1, 0))],
      ['Move… by a fraction', edit(doc, (c) => all(c, 0, { x: 0, y: 0 }, 0.001, 1234.5678))],
      ['a quarter turn', edit(doc, (c) => all(c, 90, { x: 120, y: 58 }, 0, 0))],
      ['turned back', edit(doc, (c) => all(c, -90, { x: 120, y: 58 }, 0, 0))],
      ['a 22.5° turn', edit(doc, (c) => all(c, 22.5, { x: 120, y: 58 }, 0, 0))],
      ['a snap: turned 33.333° about a connection and moved onto another', edit(doc, (c) => all(c, 33.333, { x: 92, y: 50 }, -40.125, 7.5))],
      ['a multi-select move with a loose part', edit(doc, (c) => all(c, 45, { x: 300, y: 300 }, 5, 5, [loose]))],
      [
        'another sheet, moved on the way',
        edit(doc, (c) => {
          const l = new Y.Map<unknown>();
          l.set('id', 'brick-2');
          l.set('type', 'brick');
          l.set('name', 'Scenery');
          l.set('bricks', new Y.Array());
          l.set('groups', new Y.Array());
          c.getMap('layerData').set('brick-2', l);
          c.getArray<string>('layers').push(['brick-2']);
          const to = l.get('bricks') as Y.Array<unknown>;
          const list = (c.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks')) as Y.Array<unknown>;
          for (let i = list.length - 1; i >= 0; i--) {
            const b = list.get(i) as Y.Map<unknown>;
            if (!ids.includes(b.get('id') as string)) continue;
            const copy = new Y.Map<unknown>();
            for (const [k, v] of b.entries()) copy.set(k, v);
            list.delete(i, 1);
            to.push([copy]);
            moveLikeApps(copy, 0, { x: 0, y: 0 }, 2, 2);
          }
        }),
      ],
    ];
    for (const [name, u] of cases) {
      expect(check(doc, u), name).toBeNull();
      // Without the catalog (the server hasn't read it yet): never refused either.
      expect(check(doc, u, undefined), `${name}, no catalog`).toBeNull();
    }
  });

  it('refuses parts moved apart, or turned by different amounts', () => {
    const { doc, ids } = room(CRANE);
    const one = edit(doc, (c) => moveLikeApps(partMaps(c).get(ids[0]!)!, 0, { x: 0, y: 0 }, 3, 0));
    expect(check(doc, one)).toBe('it moves the parts of a shared module apart');
    expect(check(doc, one, undefined)).toBe('it moves the parts of a shared module apart');
    const spun = edit(doc, (c) => moveLikeApps(partMaps(c).get(ids[1]!)!, 15, { x: 116, y: 50 }, 0, 0));
    expect(check(doc, spun)).toBe('it turns the parts of a shared module by different amounts');
    const halfTurned = edit(doc, (c) => {
      const maps = partMaps(c);
      for (const id of ids.slice(0, 3)) moveLikeApps(maps.get(id)!, 90, { x: 120, y: 58 }, 0, 0);
    });
    expect(check(doc, halfTurned)).toBe('it turns the parts of a shared module by different amounts');
    // Turned together but stretched: every part turned 90°, the parts spread out.
    const stretched = edit(doc, (c) => {
      const maps = partMaps(c);
      ids.forEach((id, i) => moveLikeApps(maps.get(id)!, 0, { x: 0, y: 0 }, i * 2, 0));
    });
    expect(check(doc, stretched)).toBe('it moves the parts of a shared module apart');
  });

  it('measures a turned module with parts no catalog knows by the ones it knows, and lets the rest off by their size', () => {
    const { doc, ids } = room(CRANE);
    // The unknown part (mystery.1) a little off after a turn: within its size, so not refused.
    const off = edit(doc, (c) => {
      const maps = partMaps(c);
      for (const id of ids) moveLikeApps(maps.get(id)!, 30, { x: 120, y: 58 }, 0, 0);
      const m = maps.get(ids[4]!)!;
      const a = m.get('displayArea') as { x: number; y: number; width: number; height: number };
      m.set('displayArea', { ...a, x: a.x + 0.5 });
    });
    expect(check(doc, off)).toBeNull();
    // A known part off by as much: refused.
    const known = edit(doc, (c) => {
      const maps = partMaps(c);
      for (const id of ids) moveLikeApps(maps.get(id)!, 30, { x: 120, y: 58 }, 0, 0);
      const m = maps.get(ids[0]!)!;
      const a = m.get('displayArea') as { x: number; y: number; width: number; height: number };
      m.set('displayArea', { ...a, x: a.x + 0.5 });
    });
    expect(check(doc, known)).toBe('it moves the parts of a shared module apart');
  });

  it('never refuses two people moving and turning it at the same moment, whichever arrives first', () => {
    const { doc, ids } = room(CRANE);
    const moveAll = (c: Y.Doc, deg: number, dx: number) => {
      const maps = partMaps(c);
      for (const id of ids) moveLikeApps(maps.get(id)!, deg, { x: 120, y: 58 }, dx, 0);
    };
    const turn = edit(doc, (c) => moveAll(c, 90, 0));
    const move = edit(doc, (c) => moveAll(c, 0, 10));
    for (const [first, second] of [[turn, move], [move, turn]] as const) {
      const r = new Y.Doc();
      Y.applyUpdate(r, Y.encodeStateAsUpdate(doc));
      expect(check(r, first)).toBeNull();
      Y.applyUpdate(r, first);
      const members = new Set(ids);
      expect(racedParts(r, decodeIncoming(second)!, members).size).toBe(ids.length);
      expect(check(r, second)).toBeNull();
    }
    // The same person's next move, made after they saw the other's: measured again.
    const r = new Y.Doc();
    Y.applyUpdate(r, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(r, turn);
    const bad = edit(r, (c) => moveLikeApps(partMaps(c).get(ids[0]!)!, 0, { x: 0, y: 0 }, 5, 0));
    expect(racedParts(r, decodeIncoming(bad)!, new Set(ids)).size).toBe(0);
    expect(check(r, bad)).toBe('it moves the parts of a shared module apart');
  });

  it('property: random modules moved and turned together are never refused; one part off by a stud or more always is', () => {
    const random = rng(20261117);
    const pns = ['straight.1', 'switch.1', 'ramp.1', 'mystery.1'];
    let refusedRight = 0;
    for (let n = 0; n < 300; n++) {
      const count = 2 + Math.floor(random() * 6);
      const far = random() < 0.2 ? 20000 : 300;
      const parts: Spec[] = Array.from({ length: count }, () => ({
        pn: pns[Math.floor(random() * pns.length)]!,
        pivot: { x: (random() - 0.5) * far, y: (random() - 0.5) * far },
        o: [0, 90, 180, 270, random() * 360][Math.floor(random() * 5)]!,
      }));
      // At least two known parts (a turn of only unknown ones isn't measured).
      parts[0]!.pn = 'straight.1';
      parts[1]!.pn = 'switch.1';
      const { doc, ids } = room(parts);
      const deg = [0, 90, -90, 180, random() * 720 - 360][Math.floor(random() * 5)]!;
      const about = { x: (random() - 0.5) * far, y: (random() - 0.5) * far };
      const dx = (random() - 0.5) * 1000;
      const dy = (random() - 0.5) * 1000;
      const good = edit(doc, (c) => {
        const maps = partMaps(c);
        for (const id of ids) moveLikeApps(maps.get(id)!, deg, about, dx, dy);
      });
      expect(check(doc, good), `case ${n}`).toBeNull();
      // One known part off by 1 to 50 studs.
      const off = 1 + random() * 49;
      const dir = random() * Math.PI * 2;
      const bad = edit(doc, (c) => {
        const maps = partMaps(c);
        for (const id of ids) moveLikeApps(maps.get(id)!, deg, about, dx, dy);
        moveLikeApps(maps.get(ids[0]!)!, 0, { x: 0, y: 0 }, off * Math.cos(dir), off * Math.sin(dir));
      });
      const why = check(doc, bad);
      if (why === 'it moves the parts of a shared module apart') refusedRight++;
      else expect.soft(why, `case ${n}: off by ${off}`).toBe('it moves the parts of a shared module apart');
    }
    expect(refusedRight).toBe(300);
  });

  it('rigidMoveProblem keeps distances: a mirror image is no move apart, a part left behind is', () => {
    const pose = (x: number, y: number, o = 0): PartPose => ({ area: { x: x - 1, y: y - 1, width: 2, height: 2 }, o, pn: 'tile' });
    const before = new Map([['a', pose(0, 0)], ['b', pose(10, 0)], ['c', pose(0, 5)]]);
    expect(rigidMoveProblem(before, new Map([['a', pose(0, 0)], ['b', pose(10, 0)], ['c', pose(0, -5)]]))).toBeNull();
    expect(rigidMoveProblem(before, new Map([['a', pose(0, 0)], ['b', pose(10, 0)], ['c', pose(0, 6)]]))).toBe('it moves the parts of a shared module apart');
    // One part: nothing to measure.
    expect(rigidMoveProblem(new Map([['a', pose(0, 0)]]), new Map([['a', pose(99, 99, 33)]]))).toBeNull();
  });
});

describe('putting a broken shared module back', () => {
  /** Apply `u` to the room and put back what it broke, as the live handler does. */
  function takeAndRepair(doc: Y.Doc, u: Uint8Array): LockBreak | null {
    const r = sharedLockCheck(doc, u, decodeIncoming(u)!, undefined, partOf);
    if (typeof r === 'string') throw new Error(r);
    Y.applyUpdate(doc, u, 'client');
    if (r) repairShared(doc, r, 'repair');
    return r;
  }
  const snapshot = (doc: Y.Doc) =>
    [...partMaps(doc).entries()].map(([id, m]) => ({ id, ...(m.toJSON() as object) })).sort((a, b) => (a.id < b.id ? -1 : 1));

  it('puts back parts moved apart, one changed, one deleted (with its id), and an unlocked record', () => {
    for (const [name, change] of [
      ['moved apart', (c: Y.Doc, ids: string[]) => moveLikeApps(partMaps(c).get(ids[0]!)!, 0, { x: 0, y: 0 }, 3, 0)],
      ['recolored', (c: Y.Doc, ids: string[]) => partMaps(c).get(ids[1]!)!.set('partNumber', 'straight.4')],
      [
        'one deleted',
        (c: Y.Doc, ids: string[]) => {
          const list = c.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks') as Y.Array<Y.Map<unknown>>;
          list.delete(list.toArray().findIndex((b) => b.get('id') === ids[2]), 1);
        },
      ],
      [
        'unlocked',
        (c: Y.Doc) => {
          const cache = readSidecarCache(c)!;
          writeSidecarCache(c, { ...cache, modules: (cache.modules as SidecarModule[]).map((m) => ({ ...m, shared: undefined })) });
        },
      ],
    ] as const) {
      const { doc, ids } = room(CRANE);
      const before = snapshot(doc);
      const members = () => (readSidecarCache(doc)!.modules as SidecarModule[])[0]!;
      const u = edit(doc, (c) => change(c, ids));
      const r = takeAndRepair(doc, u);
      expect(r?.modules, name).toEqual(['locked']);
      expect(snapshot(doc), name).toEqual(before);
      expect(members().members, name).toEqual(ids);
      expect((members() as { shared?: unknown }).shared, name).toBeTruthy();
      // The module can be moved as a whole again from here.
      const next = edit(doc, (c) => {
        const maps = partMaps(c);
        for (const id of ids) moveLikeApps(maps.get(id)!, 90, { x: 0, y: 0 }, 1, 1);
      });
      expect(check(doc, next), name).toBeNull();
    }
  });

  it('takes away again a part an update took out that an update brings back (settle rule 0)', () => {
    const { doc, ids } = room(CRANE);
    // The module's record remembers a part an earlier update took out; an app's undo puts it back.
    doc.transact(() => {
      const cache = readSidecarCache(doc)!;
      writeSidecarCache(doc, { ...cache, modules: (cache.modules as SidecarModule[]).map((m) => ({ ...m, shared: { ...(m.shared as object), retired: ['424242'] } })) });
    });
    const u = edit(doc, (c) => {
      const b = new Y.Map<unknown>();
      b.set('id', '424242');
      b.set('partNumber', 'straight.1');
      b.set('displayArea', { x: 0, y: 0, width: 16, height: 4 });
      ((c.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks')) as Y.Array<unknown>).push([b]);
    });
    const r = takeAndRepair(doc, u);
    expect(r?.why).toBe('it brings back a part an update of a shared module took out');
    expect(partMaps(doc).has('424242')).toBe(false);
    expect([...partMaps(doc).keys()]).toEqual(expect.arrayContaining(ids));
    // A new part with another id is no business of the guard's.
    const other = edit(doc, (c) => {
      const b = new Y.Map<unknown>();
      b.set('id', '515151');
      b.set('partNumber', 'straight.1');
      b.set('displayArea', { x: 0, y: 0, width: 16, height: 4 });
      ((c.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks')) as Y.Array<unknown>).push([b]);
    });
    expect(check(doc, other)).toBeNull();
  });

  it('keeps the rest of the update (a loose part moved with it)', () => {
    const { doc, ids, loose } = room(CRANE);
    const u = edit(doc, (c) => {
      const maps = partMaps(c);
      moveLikeApps(maps.get(ids[0]!)!, 0, { x: 0, y: 0 }, 3, 0);
      moveLikeApps(maps.get(loose)!, 0, { x: 0, y: 0 }, 7, 0);
    });
    takeAndRepair(doc, u);
    expect((partMaps(doc).get(loose)!.get('displayArea') as { x: number }).x).toBe(507);
    expect((partMaps(doc).get(ids[0]!)!.get('displayArea') as { x: number }).x).toBeCloseTo(areaForPivot(partOf('straight.1'), 0, { x: 100, y: 50 }).x);
  });
});
