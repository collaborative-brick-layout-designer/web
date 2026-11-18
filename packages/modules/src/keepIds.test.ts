// Updates that keep the ids of unchanged parts (keepIds.ts, replace.ts
// updateModuleParts) and finishing an undo for a shared module (settle.ts):
// the shared vectors the desktop's copy passes too
// (fixtures/contracts/shared-module-keep.json, shared-module-settle.json),
// the update on a live document (only what changed is touched, the drawing
// order and sets come out as the version's, z-ordered sheets included), and
// how much less the document grows than putting every part in again.
//
// BLD_WRITE_CONTRACTS=1 writes the vectors' `expect` again from this code.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { createDefaultLayoutDoc, docToBbm, itemsInOrder, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import {
  appendBricks,
  areaForPivot,
  planKeep,
  planSheets,
  replaceModuleParts,
  settleShared,
  updateModuleParts,
  type KeepPlan,
  type ModuleBatch,
  type PartGeom,
  type PartLookup,
  type PlanBatch,
  type PlanSheet,
  type SettleSide,
  type Settled,
} from './index.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts');
const KEEP_FILE = join(DIR, 'shared-module-keep.json');
const SETTLE_FILE = join(DIR, 'shared-module-settle.json');
const WRITE = process.env.BLD_WRITE_CONTRACTS === '1';

interface KeepVector {
  name: string;
  sheets: PlanSheet[];
  members: string[];
  next: PlanBatch[];
  expect?: ReturnType<typeof flatPlan>;
}
interface SettleVector {
  name: string;
  before: SettleSide;
  after: SettleSide;
  expect?: Settled;
}

const keepFile = JSON.parse(readFileSync(KEEP_FILE, 'utf8')) as { parts: Record<string, PartGeom>; keep: KeepVector[] };
const settleFile = JSON.parse(readFileSync(SETTLE_FILE, 'utf8')) as { parts: Record<string, PartGeom>; settle: SettleVector[] };
const lookup = (parts: Record<string, PartGeom>): PartLookup => (pn) => parts[pn.toLowerCase()];

/** A plan as the vectors keep it: plain objects, keys sorted. */
function flatPlan(p: KeepPlan) {
  const obj = <T>(m: Map<string, T>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { kept: obj(p.kept), removed: p.removed, added: p.added, sheets: obj(p.sheets), newGroups: obj(p.newGroups) };
}

const round = (v: unknown): unknown => {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 || 0;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
};

describe('shared vectors (fixtures/contracts/shared-module-keep.json, shared-module-settle.json)', () => {
  const partOf = lookup(keepFile.parts);
  for (const v of keepFile.keep) {
    it(`keep: ${v.name}`, () => {
      const got = flatPlan(planKeep(v.sheets, new Set(v.members), v.next, partOf));
      if (WRITE) v.expect = got;
      else expect(got).toEqual(v.expect);
    });
  }
  const settleParts = lookup(settleFile.parts);
  for (const v of settleFile.settle) {
    it(`settle: ${v.name}`, () => {
      const got = round(settleShared(v.before, v.after, settleParts)) as Settled;
      if (WRITE) v.expect = got;
      else expect(got).toEqual(v.expect);
    });
  }
  if (WRITE) {
    it('writes the vectors', () => {
      writeFileSync(KEEP_FILE, `${JSON.stringify(keepFile, null, 2)}\n`);
      writeFileSync(SETTLE_FILE, `${JSON.stringify(settleFile, null, 2)}\n`);
    });
  }
});

// ---- On a live document ---------------------------------------------------------

const A = (x: number, y: number) => ({ x, y, width: 2, height: 2 });
const none: PartLookup = () => undefined;

/** A layout with a loose part under and over a module of `n` parts in a row (one set around the first two), linked at version 1. */
function layout(n: number, z = false): { doc: Y.Doc; members: string[]; under: string; over: string } {
  const doc = createDefaultLayoutDoc();
  let members: string[] = [];
  let under = '';
  let over = '';
  doc.transact(() => {
    under = appendBricks(doc, 'brick-1', [{ partNumber: 'loose.1', displayArea: A(-50, -50) }])[0]!;
    members = appendBricks(
      doc,
      'brick-1',
      Array.from({ length: n }, (_, i) => ({ partNumber: `p${i % 7}.1`, displayArea: A(i * 2, 0), ...(i < 2 ? { myGroup: 'g1' } : {}) })),
      [{ id: 'g1', partNumber: 'set.1', myGroup: '' }],
    );
    over = appendBricks(doc, 'brick-1', [{ partNumber: 'loose.2', displayArea: A(50, 50) }])[0]!;
    const m: SidecarModule = { id: 'm1', name: 'Harbor crane', members, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], libraryModuleId: 'lib', libraryVersion: 1 };
    writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules: [m] });
    if (z) {
      const bricks = (doc.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
      bricks.toArray().forEach((b, i) => b.set('z', i * 10));
    }
  });
  return { doc, members, under, over };
}

/** The version as batches: `n` parts in a row (the first two in a set), with `change` applied. */
function version(n: number, change: (bricks: ModuleBatch['bricks']) => void = () => {}): ModuleBatch[] {
  const bricks: ModuleBatch['bricks'] = Array.from({ length: n }, (_, i) => ({ partNumber: `p${i % 7}.1`, displayArea: A(i * 2, 0), ...(i < 2 ? { myGroup: 'vg' } : {}) }));
  change(bricks);
  return [{ layerName: 'Track', bricks, groups: [{ id: 'vg', partNumber: 'set.1', myGroup: '' }] }];
}

const order = (doc: Y.Doc) => itemsInOrder((doc.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).map((b) => b.get('id') as string);
const moduleOf = (doc: Y.Doc) => (readSidecarCache(doc)!.modules as SidecarModule[])[0]!;

describe('updateModuleParts', () => {
  it('a version with nothing changed touches no part', () => {
    const { doc, members, under, over } = layout(5);
    const before = order(doc);
    const r = updateModuleParts(doc, 'm1', version(5), () => 'brick-1', none, { libraryVersion: 2 })!;
    expect(r).toMatchObject({ kept: 5, added: 0, removed: 0 });
    expect(order(doc)).toEqual(before);
    expect(moduleOf(doc)).toMatchObject({ members, libraryVersion: 2 });
    expect(doc.getMap('meta').get('schemaVersion')).toBe(5);
    expect([under, over].every((id) => order(doc).includes(id))).toBe(true);
  });

  it('swaps only the changed parts, each where the version has it in the drawing order, in its set', () => {
    for (const z of [false, true]) {
      const { doc, members, under, over } = layout(5, z);
      // Part 2 moved, part 0 recolored, and a part added on top.
      const v = version(5, (b) => {
        b[2]!.displayArea = A(4, 6);
        b[0]!.partNumber = 'p0.4';
        b.push({ partNumber: 'p9.1', displayArea: A(20, 0), myGroup: 'vg' });
      });
      const r = updateModuleParts(doc, 'm1', v, () => 'brick-1', none)!;
      expect(r, `z ${z}`).toMatchObject({ kept: 3, added: 3, removed: 2 });
      const now = order(doc);
      // (The module's parts in the version's order; its record lists the same parts, kept ones first: module-members.md.)
      const m = r.members;
      expect(new Set(moduleOf(doc).members)).toEqual(new Set(m));
      // The kept parts keep their ids; the module's parts are in the version's order, between the loose ones.
      expect(m[1]).toBe(members[1]);
      expect(m[3]).toBe(members[3]);
      expect(m[4]).toBe(members[4]);
      const at = (id: string) => now.indexOf(id);
      for (let i = 1; i < m.length; i++) expect(at(m[i]!), `z ${z}: part ${i}`).toBeGreaterThan(at(m[i - 1]!));
      expect(at(under)).toBe(0);
      // The new first part shares the kept second part's set; the added part too.
      const bbm = docToBbm(doc).layers.find((l) => l.type === 'brick' && l.id === 'brick-1');
      const groupOf = (id: string) => (bbm as { bricks: { id: string; myGroup: string }[] }).bricks.find((b) => b.id === id)!.myGroup;
      expect(groupOf(m[0]!)).toBe(groupOf(m[1]!));
      expect(groupOf(m[5]!)).toBe(groupOf(m[1]!));
    }
  });

  it('puts everything in again when the sets changed', () => {
    const { doc, members } = layout(4);
    const v = version(4, (b) => {
      delete b[1]!.myGroup;
    });
    const r = updateModuleParts(doc, 'm1', v, () => 'brick-1', none)!;
    expect(r).toMatchObject({ kept: 0, added: 4, removed: 4 });
    expect(moduleOf(doc).members.some((id) => members.includes(id))).toBe(false);
  });

  it('works out pivots of turned parts with a hull from the catalog', () => {
    const parts = lookup(keepFile.parts);
    const doc = createDefaultLayoutDoc();
    const at = (pn: string, o: number, x: number, y: number) => ({ partNumber: pn, orientation: o, displayArea: areaForPivot(parts(pn), o, { x, y }) });
    const bricks = [at('switch.1', 33, 10, 10), at('ramp.1', 123, 30, 5)];
    let members: string[] = [];
    doc.transact(() => {
      members = appendBricks(doc, 'brick-1', bricks);
      writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm1', name: 'Yard', members, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] } as SidecarModule] });
    });
    const r = updateModuleParts(doc, 'm1', [{ layerName: 'Track', bricks: bricks.map((b) => ({ ...b, displayArea: { ...b.displayArea, x: b.displayArea.x + 0.01 } })) }], () => 'brick-1', parts)!;
    expect(r).toMatchObject({ kept: 2, added: 0, removed: 0 });
  });

  it('the document grows by about the changed parts only (measured against putting every part in again)', () => {
    const N = 200;
    const changed = (b: ModuleBatch['bricks']) => {
      b[10]!.displayArea = A(20, 8);
      b[50]!.partNumber = 'p1.4';
      b[150]!.displayArea = A(300, 8);
    };
    const grow = (step: (doc: Y.Doc) => void) => {
      const { doc } = layout(N);
      const before = Y.encodeStateAsUpdate(doc).length;
      step(doc);
      return Y.encodeStateAsUpdate(doc).length - before;
    };
    const old = grow((doc) => replaceModuleParts(doc, 'm1', version(N, changed), () => 'brick-1', { libraryVersion: 2 }));
    const kept = grow((doc) => updateModuleParts(doc, 'm1', version(N, changed), () => 'brick-1', none, { libraryVersion: 2 }));
    const nothing = grow((doc) => updateModuleParts(doc, 'm1', version(N), () => 'brick-1', none, { libraryVersion: 2 }));
    const onePart = grow((doc) => updateModuleParts(doc, 'm1', version(N, (b) => (b[10]!.displayArea = A(20, 8))), () => 'brick-1', none, { libraryVersion: 2 }));
    // (Printed for the pull request.)
    console.log(`doc growth, ${N}-part module: every part again ${old} bytes; 3 parts changed ${kept} bytes; 1 changed ${onePart}; none changed ${nothing}`);
    // What is left besides the parts is the module's record (its sidecar value and the sidecar blob), the same either way.
    const perPart = (kept - nothing) / 3;
    expect(onePart - nothing).toBeLessThan(perPart * 1.5);
    expect(kept).toBeLessThan(old / 5);
  });

  it('a selection or undo step another person holds stays good for the unchanged parts', () => {
    const { doc: server, members } = layout(6);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server));
    const undo = new Y.UndoManager([bob.getMap('layerData')], { trackedOrigins: new Set(['bob']) });
    // Bob nudges a loose part (his own step), and has some of the module's parts picked.
    const loose = order(bob)[0]!;
    bob.transact(() => {
      const b = ((bob.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray().find((x) => x.get('id') === loose)!;
      b.set('displayArea', A(-40, -50));
    }, 'bob');
    const picked = [members[0]!, members[3]!];
    Y.applyUpdate(server, Y.encodeStateAsUpdate(bob));
    updateModuleParts(server, 'm1', version(6, (b) => (b[5]!.displayArea = A(40, 0))), () => 'brick-1', none, { libraryVersion: 2 });
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server, Y.encodeStateVector(bob)));
    // His pick is still there, and his undo still works.
    expect(picked.every((id) => order(bob).includes(id))).toBe(true);
    undo.undo();
    const back = ((bob.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray().find((x) => x.get('id') === loose)!;
    expect((back.get('displayArea') as { x: number }).x).toBe(-50);
  });
});

it('planSheets reads sheets in layer order, bottom to top', () => {
  const { doc, members } = layout(3, true);
  const s = planSheets(doc);
  expect(s[0]!.parts.map((p) => p.id).slice(1, 4)).toEqual(members);
});
