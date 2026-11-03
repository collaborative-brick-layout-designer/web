// Grid sizes the apps draw (ws/gridGuard.ts): the shared vectors
// (fixtures/contracts/update-guard.json, gridSize), every layout fixture as
// the server seeds it, a layout already holding such a size, changes that
// wait for others before they apply, which updates are worked out at all
// (only those that could break a grid), and that those are worked out from
// the keys they touch, answering exactly what a copy of the room's
// document would (a seeded random mix of edits, several clients, races).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { readBbm } from '@cld/bbm';
import { createDefaultLayoutDoc, seedFromBbm } from '@cld/ydoc';
import { checkGridSizes, checkGridSizesOnCopy, exactVerdict, invalidGridLayers, UNSURE, validGridSize } from './gridGuard.js';
import { decodeIncoming, guardWork } from './decoded.js';
import { checkUpdate } from './updateGuard.js';
import { LIMITS_TEXT } from './drawingSettings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(ROOT, 'packages/bbm/tests/fixtures');

interface GridVector {
  what: string;
  kind: 'update' | 'document';
  hex: string;
  refused: boolean;
}
const contract = JSON.parse(readFileSync(join(ROOT, 'fixtures/contracts/update-guard.json'), 'utf8')) as {
  gridSize: { base: string; vectors: GridVector[] };
  drawingSettings: { base: string; vectors: GridVector[]; limits: Record<string, string> };
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

function room(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes(contract.gridSize.base));
  return doc;
}

const gridOf = (doc: Y.Doc) =>
  [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l instanceof Y.Map && l.get('type') === 'grid')!;

describe('grid guard', () => {
  it.each(contract.gridSize.vectors.map((v) => [v.what, v] as const))('%s', (_what, v) => {
    const update = bytes(v.hex);
    // Both apps read it: only the grid size decides.
    expect(checkUpdate(update)).toBeNull();
    const copies = guardWork.docCopies;
    const why = checkGridSizes(v.kind === 'update' ? room() : null, update);
    if (v.refused) expect(why).toMatch(/cell size/);
    else expect(why).toBeNull();
    // Each is worked out from the keys it touches, the same as on a copy.
    expect(guardWork.docCopies).toBe(copies);
    expect(checkGridSizesOnCopy(v.kind === 'update' ? room() : null, update)).toEqual(why);
  });

  it.each(contract.drawingSettings.vectors.map((v) => [v.what, v] as const))('drawing settings: %s', (_what, v) => {
    const update = bytes(v.hex);
    expect(checkUpdate(update)).toBeNull();
    const room = () => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, bytes(contract.drawingSettings.base));
      return doc;
    };
    const copies = guardWork.docCopies;
    const why = checkGridSizes(v.kind === 'update' ? room() : null, update);
    if (v.refused) expect(why).toMatch(/outside/);
    else expect(why).toBeNull();
    // Worked out from the keys it touches, the same as on a copy.
    expect(guardWork.docCopies).toBe(copies);
    expect(checkGridSizesOnCopy(v.kind === 'update' ? room() : null, update)).toEqual(why);
  });

  it('lists the drawing-settings limits the desktop matches', () => {
    expect(contract.drawingSettings.limits).toEqual(LIMITS_TEXT);
    expect(contract.drawingSettings.vectors.filter((v) => v.refused).length).toBeGreaterThanOrEqual(15);
  });

  it('has vectors for each kind of size', () => {
    expect(contract.gridSize.vectors.filter((v) => v.refused).length).toBeGreaterThanOrEqual(10);
    expect(contract.gridSize.vectors.filter((v) => !v.refused).length).toBeGreaterThanOrEqual(5);
  });

  it('says which sizes both apps draw', () => {
    for (const ok of [1, 2, 32, 96, 1.5, 2147483647]) expect(validGridSize(ok), String(ok)).toBe(true);
    for (const bad of [0, -1, 0.99, 2147483648, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '32', null, undefined, 32n])
      expect(validGridSize(bad), String(bad)).toBe(false);
  });

  it('passes every layout fixture as the server seeds it, and the default layout', () => {
    const names = readdirSync(FIXTURES).filter((n) => n.endsWith('.bbm'));
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const doc = seedFromBbm(readBbm(readFileSync(join(FIXTURES, name), 'utf8')).map);
      expect(invalidGridLayers(doc), name).toEqual(new Set());
      expect(checkGridSizes(null, Y.encodeStateAsUpdate(doc)), name).toBeNull();
    }
    expect(checkGridSizes(null, Y.encodeStateAsUpdate(createDefaultLayoutDoc()))).toBeNull();
  });

  it('lets a layout that already holds such a size be edited and fixed', () => {
    const doc = room();
    gridOf(doc).set('gridSizeInStud', 0); // saved before the guard
    const edit = (fn: (d: Y.Doc) => void) => {
      const mine = new Y.Doc();
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
      const sv = Y.encodeStateVector(mine);
      fn(mine);
      return Y.encodeStateAsUpdate(mine, sv);
    };
    expect(checkGridSizes(doc, edit((d) => d.getMap('meta').set('title', 'Still here')))).toBeNull();
    expect(checkGridSizes(doc, edit((d) => gridOf(d).set('subDivisionNumber', 2)))).toBeNull();
    expect(checkGridSizes(doc, edit((d) => gridOf(d).set('gridSizeInStud', 32)))).toBeNull();
  });

  it('checks a size whose change waits for another to arrive first', () => {
    const doc = room();
    const ahead = (fn: (d: Y.Doc) => void): [Uint8Array, Uint8Array] => {
      const mine = new Y.Doc();
      mine.clientID = 7;
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
      const sv0 = Y.encodeStateVector(mine);
      mine.getMap('meta').set('note', 'first');
      const earlier = Y.encodeStateAsUpdate(mine, sv0);
      const sv1 = Y.encodeStateVector(mine);
      fn(mine);
      return [earlier, Y.encodeStateAsUpdate(mine, sv1)];
    };
    // A new size that waits still takes the old one away at once: refused.
    const [, replaced] = ahead((d) => gridOf(d).set('gridSizeInStud', 0));
    expect(checkGridSizes(doc, replaced)).toMatch(/cell size/);
    // A new grid layer that waits changes nothing yet; the change it waits
    // for is checked with it.
    const [earlier, later] = ahead((d) => {
      const g = new Y.Map<unknown>();
      d.getMap<Y.Map<unknown>>('layerData').set('G2', g);
      g.set('type', 'grid');
      g.set('gridSizeInStud', 0);
    });
    expect(checkGridSizes(doc, later)).toBeNull();
    Y.applyUpdate(doc, later);
    expect(doc.store.pendingStructs).not.toBeNull();
    expect(checkGridSizes(doc, earlier)).toMatch(/cell size/);
  });

  it('works out only the updates that could leave a grid without a valid size, from the keys they touch', () => {
    const doc = room();
    const edit = (fn: (d: Y.Doc) => void) => {
      const mine = new Y.Doc();
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
      const sv = Y.encodeStateVector(mine);
      fn(mine);
      return Y.encodeStateAsUpdate(mine, sv);
    };
    // [verdict, layers read]; never a copy of the document.
    const copies = (update: Uint8Array): [string | null, number] => {
      const before = { ...guardWork };
      const why = checkGridSizes(doc, update);
      expect(guardWork.docCopies - before.docCopies).toBe(0);
      expect(why).toEqual(checkGridSizesOnCopy(doc, update));
      return [why, guardWork.gridLayersRead - before.gridLayersRead];
    };
    const parts = (d: Y.Doc, n: number) => {
      const layer = new Y.Map<unknown>();
      layer.set('type', 'brick');
      const list = new Y.Array<Y.Map<unknown>>();
      layer.set('bricks', list);
      d.getMap('layerData').set('P', layer);
      d.getArray<string>('layers').push(['P']);
      list.push(
        Array.from({ length: n }, (_, i) => {
          const y = new Y.Map<unknown>();
          y.set('id', `p${i}`);
          y.set('orientation', 0);
          return y;
        }),
      );
    };
    // Nothing read: a title, a grid layer deleted.
    expect(copies(edit((d) => d.getMap('meta').set('title', 'Yard')))).toEqual([null, 0]);
    expect(copies(edit((d) => d.getMap('layerData').forEach((l, id) => l === gridOf(d) && d.getMap('layerData').delete(id))))).toEqual([null, 0]);
    // One sheet read, never the 2000 parts on it: a new sheet of parts, a type taken away or changed.
    expect(copies(edit((d) => parts(d, 2000)))).toEqual([null, 1]);
    expect(copies(edit((d) => gridOf(d).delete('type')))).toEqual([null, 0]);
    expect(copies(edit((d) => gridOf(d).set('type', 'brick')))).toEqual([null, 0]);
    // Read: a new size (valid: taken), a layer turned into a grid, a grid size deleted: one layer each.
    expect(copies(edit((d) => gridOf(d).set('gridSizeInStud', 48)))).toEqual([null, 1]);
    expect(copies(edit((d) => gridOf(d).set('gridSizeInStud', 0)))[1]).toBe(1);
    expect(copies(edit((d) => gridOf(d).delete('gridSizeInStud')))).toEqual([expect.stringMatching(/cell size/), 1]);
    expect(
      copies(
        edit((d) =>
          d.transact(() => {
            gridOf(d).set('gridSizeInStud', 48);
            gridOf(d).delete('gridSizeInStud');
          }),
        ),
      ),
    ).toEqual([expect.stringMatching(/cell size/), 1]);
    expect(copies(edit((d) => {
      const g = new Y.Map<unknown>();
      d.getMap('layerData').set('G2', g);
      g.set('type', 'grid');
    }))).toEqual([expect.stringMatching(/cell size/), 1]);
  });

  it('works out the hand-made update with two structs for one id on a copy', () => {
    const doc = room();
    // Two blocks for client 77 from clock 0: the first a note, the second a
    // grid size of 0. (Yjs reads the second; a lookup by id might find the first.)
    const block = (fn: (d: Y.Doc) => void): Uint8Array => {
      const mine = new Y.Doc();
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
      mine.clientID = 77;
      const sv = Y.encodeStateVector(mine);
      fn(mine);
      const u = Y.encodeStateAsUpdate(mine, sv);
      expect(u[0]).toBe(1); // one client
      return u.subarray(1);
    };
    // The first's delete set is empty (a new key): drop it; the second's follows its block.
    const a = block((d) => d.getMap('meta').set('note', 'x'));
    expect(a.at(-1)).toBe(0);
    const b = block((d) => gridOf(d).set('gridSizeInStud', 0));
    const both = new Uint8Array([2, ...a.subarray(0, a.length - 1), ...b]);
    expect(checkUpdate(both)).toBeNull();
    expect(decodeIncoming(both)?.overlapping).toBe(true);
    const before = guardWork.docCopies;
    expect(checkGridSizes(doc, both)).toMatch(/cell size/);
    expect(guardWork.docCopies - before).toBe(1);
  });

  it('sees a written size its own update deletes, whatever order the deleted ranges come in', () => {
    const doc = room();
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
    mine.clientID = 77;
    const sv = Y.encodeStateVector(mine);
    gridOf(mine).set('gridSizeInStud', 48); // client 77, clock 0: replaces the room's size
    const update = Y.encodeStateAsUpdate(mine, sv);
    // The update ends with mine's whole delete set: the same bytes as an update with no structs.
    const ds = Y.encodeStateAsUpdate(mine, Y.encodeStateVector(mine)).subarray(1);
    expect(update.subarray(update.length - ds.length)).toEqual(ds);
    // Hand-made: client 77's deleted ranges out of order, clock 5 then clock 0 (the new size).
    const crafted = new Uint8Array([...update.subarray(0, update.length - ds.length), 1, 77, 2, 5, 1, 0, 1]);
    // The update guard refuses it first (updateGuard.ts); the grid guard must still see it on its own.
    expect(checkUpdate(crafted)).toContain('out of order');
    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(after, crafted);
    expect(gridOf(after).has('gridSizeInStud')).toBe(false);
    expect(checkGridSizes(doc, crafted)).toMatch(/cell size/);
  });

  it('answers from the touched keys exactly what a copy answers, over a seeded mix of edits, clients and races', () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const SIZES = [0, -8, 0.5, 1, 32, 48, 2147483647, 2147483648, Number.NaN, Number.POSITIVE_INFINITY, '32', null] as const;
    const layers = (d: Y.Doc) => d.getMap<unknown>('layerData');
    const anyLayer = (d: Y.Doc): Y.Map<unknown> | null => {
      const ls = [...layers(d).values()].filter((l): l is Y.Map<unknown> => l instanceof Y.Map);
      return ls.length ? pick(ls) : null;
    };
    const NUMS = [0, 1, 2, 3.5, 32, 64, 100, 101, 4096, 1e9, -1, Number.NaN, Number.POSITIVE_INFINITY] as const;
    const fieldValue = (field: string): unknown => {
      if (field === 'hullProperties') return { isVisible: false, hullThickness: pick(NUMS) };
      if (field === 'cellIndexFont' || field === 'measureFont') return { name: 'Arial', size: pick(NUMS) };
      if (field === 'cellIndexCorner' || field === 'point1' || field === 'point2' || field === 'center') return { x: pick(NUMS), y: pick([0, 5, 2e7]) };
      if (field === 'guidelineDashPattern') return pick([[], [4, 2], [0, 0], [1e9], [3, Number.NaN]]);
      return rand() < 0.1 ? 'x' : pick(NUMS);
    };
    const SHEET_FIELDS = ['transparency', 'hullProperties', 'gridThickness', 'subGridThickness', 'subDivisionNumber', 'cellIndexFont', 'cellIndexCorner', 'areaCellSize'];
    const RULER_FIELDS = ['lineThickness', 'guidelineThickness', 'guidelineDashPattern', 'unit', 'measureFont', 'point1', 'point2', 'center', 'radius', 'offsetDistance'];
    const rulerList = (d: Y.Doc) => {
      let r = layers(d).get('R');
      if (!(r instanceof Y.Map)) {
        r = new Y.Map<unknown>();
        layers(d).set('R', r);
        (r as Y.Map<unknown>).set('type', 'ruler');
      }
      let arr = (r as Y.Map<unknown>).get('rulerItems');
      if (!(arr instanceof Y.Array)) {
        arr = new Y.Array<unknown>();
        (r as Y.Map<unknown>).set('rulerItems', arr);
      }
      return arr as Y.Array<unknown>;
    };
    const newRuler = (): Record<string, unknown> => {
      const o: Record<string, unknown> = { id: `r${Math.floor(rand() * 1e6)}`, kind: 'linear', point1: { x: 0, y: 0 }, point2: { x: 8, y: 0 }, lineThickness: 2 };
      if (rand() < 0.6) o[pick(RULER_FIELDS)] = fieldValue(pick(RULER_FIELDS));
      return o;
    };
    const ops: ((d: Y.Doc) => void)[] = [
      (d) => {
        const f = pick(SHEET_FIELDS);
        anyLayer(d)?.set(f, fieldValue(f));
      },
      (d) => anyLayer(d)?.delete(pick(SHEET_FIELDS)),
      // A ruler as plain JSON (older docs), or as a map (doc shape 2).
      (d) => rulerList(d).push([newRuler()]),
      (d) => rulerList(d).push([toMap(newRuler())]),
      (d) => {
        const maps = rulerList(d).toArray().filter((v): v is Y.Map<unknown> => v instanceof Y.Map);
        if (maps.length) {
          const f = pick(RULER_FIELDS);
          pick(maps).set(f, fieldValue(f));
        }
      },
      (d) => {
        const arr = rulerList(d);
        if (arr.length) arr.delete(Math.floor(rand() * arr.length), 1);
      },
      (d) => {
        // Move a plain ruler: its entry replaced, as the apps do.
        const arr = rulerList(d);
        const i = arr.toArray().findIndex((v) => !(v instanceof Y.Map));
        if (i < 0) return;
        const was = arr.get(i) as Record<string, unknown>;
        arr.delete(i, 1);
        arr.insert(i, [{ ...was, point1: fieldValue('point1') }]);
      },
      (d) => anyLayer(d)?.set('gridSizeInStud', pick(SIZES)),
      (d) => anyLayer(d)?.set('gridSizeInStud', pick([16, 32, 64])),
      (d) => anyLayer(d)?.delete('gridSizeInStud'),
      (d) => anyLayer(d)?.set('type', pick(['grid', 'brick', 'text'])),
      (d) => anyLayer(d)?.delete('type'),
      (d) => anyLayer(d)?.set('name', `n${Math.floor(rand() * 100)}`),
      (d) => {
        const g = new Y.Map<unknown>();
        layers(d).set(pick(['G', 'G2', 'G3', 'B', 'N1', `L${Math.floor(rand() * 4)}`]), g);
        if (rand() < 0.8) g.set('type', pick(['grid', 'grid', 'brick']));
        if (rand() < 0.7) g.set('gridSizeInStud', pick(SIZES));
      },
      (d) => {
        const ids = [...layers(d).keys()];
        if (ids.length) layers(d).delete(pick(ids));
      },
      (d) => d.getMap('meta').set('title', `t${Math.floor(rand() * 100)}`),
      (d) => {
        const l = anyLayer(d);
        const b = l?.get('bricks');
        if (b instanceof Y.Array) b.push([new Y.Map<unknown>([['id', `p${Math.floor(rand() * 1e6)}`]])]);
      },
    ];
    const toMap = (o: Record<string, unknown>) => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(o)) m.set(k, v);
      return m;
    };
    const edit = (d: Y.Doc) => {
      const n = 1 + Math.floor(rand() * 3);
      d.transact(() => {
        for (let i = 0; i < n; i++) pick(ops)(d);
      });
    };
    const copyOf = (d: Y.Doc, client: number) => {
      const c = new Y.Doc();
      c.clientID = client;
      Y.applyUpdate(c, Y.encodeStateAsUpdate(d));
      return c;
    };

    let decided = 0;
    let total = 0;
    let refused = 0;
    const compare = (doc: Y.Doc | null, update: Uint8Array) => {
      const decodedUpdate = decodeIncoming(update)!;
      const exact = exactVerdict(doc, update, decodedUpdate);
      const copied = checkGridSizesOnCopy(doc, update);
      total++;
      if (copied !== null) refused++;
      if (exact === UNSURE) return copied;
      decided++;
      expect(exact === null, `exact ${String(exact)} / copy ${String(copied)}`).toBe(copied === null);
      return copied;
    };

    for (let round = 0; round < 60; round++) {
      const roomDoc = room();
      let next = 1000 + round * 100;
      // Someone who went offline a while ago and comes back with their edits.
      const late = copyOf(roomDoc, next++);
      const lateSv = Y.encodeStateVector(late);
      for (let step = 0; step < 12; step++) {
        if (step === 6 || step === 11) {
          edit(late);
          const back = Y.encodeStateAsUpdate(late, lateSv);
          if (compare(roomDoc, back) === null) Y.applyUpdate(roomDoc, back);
        }
        // One to three people edit from the room as it is (or was a step ago).
        const peers = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => copyOf(roomDoc, next++));
        const svs = peers.map((p) => Y.encodeStateVector(p));
        for (const p of peers) edit(p);
        if (rand() < 0.3) edit(peers[0]!); // a second transaction from the same person
        const diffs = peers.map((p, i) => Y.encodeStateAsUpdate(p, svs[i]));
        const update = diffs.length === 1 || rand() < 0.5 ? diffs[0]! : Y.mergeUpdates(diffs);
        const why = compare(roomDoc, update);
        if (why === null) Y.applyUpdate(roomDoc, update);
        // Now and then a whole document on its own (a snapshot).
        if (rand() < 0.1) compare(null, Y.encodeStateAsUpdate(peers[0]!));
      }
    }
    console.log(`[grid exact] ${decided} of ${total} worked out from the touched keys; ${refused} refused`);
    expect(total).toBeGreaterThan(700);
    expect(refused).toBeGreaterThan(50);
    // Almost all are worked out from the touched keys; the rest on a copy.
    expect(decided / total).toBeGreaterThan(0.8);
  });
});
