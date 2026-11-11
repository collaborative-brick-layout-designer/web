// Doc shape 2 (@cld/ydoc shape.ts): rulers, area sheets and the order of
// parts edited in place, docs in shape 1 read and moved over lazily, and
// the vectors the desktop checks too (fixtures/contracts/doc-shape.json).
//
// BLD_WRITE_CONTRACTS=1 writes the concurrent-edit vectors afresh into the
// copy here (then copy it to fixtures/contracts/, update MANIFEST.sha256 and
// copy that to the desktop repo).

// A copy of fixtures/contracts/doc-shape.json (the image build has no
// fixtures/; the server's contracts test checks the copy is the same).
import contractJson from './fixtures/doc-shape.json';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DOC_BASE_SCHEMA,
  DOC_SCHEMA_VERSION,
  assignZ,
  bbmToDoc,
  canReadDoc,
  createDefaultLayoutDoc,
  docToBbm,
  orderByZ,
  removeDuplicateItems,
} from '@cld/ydoc';
import type { LayerArea, LayerBrick, LayerRuler } from '@cld/model';
import {
  addLinearRuler,
  deleteBricks,
  deleteRulerItem,
  ensureAreaLayer,
  ensureBrickLayer,
  ensureRulerLayer,
  moveArea,
  moveBrick,
  moveRulerItem,
  paintAreaCells,
  placeBrick,
  reorderBricks,
} from '../mutations';
import { createUndoManager } from '../useUndoManager';

const contract = contractJson as unknown as Contract;
// (Node in tests; the app's types are the browser's.)
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const brick = { partNumber: '3001.1', width: 4, height: 2 };

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(''));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function decoded(base: string): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, unb64(base));
  return d;
}

/** A layout doc made by client `id` (fixed, so vectors don't depend on chance). */
function layoutDoc(id: number): Y.Doc {
  const d = new Y.Doc();
  d.clientID = id;
  bbmToDoc(docToBbm(createDefaultLayoutDoc()), d);
  return d;
}
function copyOf(d: Y.Doc, id: number): Y.Doc {
  const c = new Y.Doc();
  c.clientID = id;
  Y.applyUpdate(c, Y.encodeStateAsUpdate(d));
  return c;
}
function sync(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua);
  Y.applyUpdate(a, ub);
}
/** What `edit` sends, made on a copy of `base`. */
function editOf(base: Y.Doc, id: number, edit: (d: Y.Doc) => void): Uint8Array {
  const d = copyOf(base, id);
  const sv = Y.encodeStateVector(d);
  edit(d);
  return Y.encodeStateAsUpdate(d, sv);
}
const layer = <T>(d: Y.Doc, id: string) => docToBbm(d).layers.find((l) => l.id === id) as T;
const schema = (d: Y.Doc) => d.getMap('meta').get('schemaVersion');

describe('order by z (shared with the desktop)', () => {
  const c = contract;
  it.each(c.orderByZ)('orders $z', ({ z, order }) => {
    expect(orderByZ(z.map((v) => (v === null ? undefined : v)))).toEqual(order);
  });
  it.each(c.assignZ)('reorders to $want', ({ cur, want, z }) => {
    const got = assignZ(cur.map((e) => ({ id: e.id, z: e.z ?? undefined })), want);
    expect(Object.fromEntries(got)).toEqual(z);
    // And the order is then `want`.
    const zs = new Map(cur.map((e) => [e.id, e.z ?? undefined] as const));
    for (const [id, v] of got) zs.set(id, v);
    const ids = want.filter((id) => zs.has(id));
    expect(orderByZ(ids.map((id) => zs.get(id)!)).map((i) => ids[i])).toEqual(ids);
  });
});

describe('docs in shape 1', () => {
  it('a doc is made in shape 1 and stays there until an edit needs shape 2', () => {
    const d = layoutDoc(1);
    expect(schema(d)).toBe(DOC_BASE_SCHEMA);
    const L = ensureBrickLayer(d);
    placeBrick(d, L, { ...brick, x: 0, y: 0 });
    const p = placeBrick(d, L, { ...brick, x: 8, y: 0 });
    moveBrick(d, L, p, 20, 0);
    expect(schema(d)).toBe(1);
    reorderBricks(d, [p], 'back');
    expect(schema(d)).toBe(DOC_SHAPE_IN_PLACE);
    expect(DOC_SCHEMA_VERSION).toBeGreaterThanOrEqual(DOC_SHAPE_IN_PLACE);
    expect(canReadDoc(1)).toBe(true);
    expect(canReadDoc(2)).toBe(true);
    // A build that reads only shape 1 refuses it.
    expect(canReadDoc(2, 1, 1)).toBe(false);
  });

  it('plain-object rulers read, and the first edit turns them into Y.Maps, losing nothing', () => {
    const d = layoutDoc(1);
    const R = ensureRulerLayer(d);
    const plain = { id: 'r1', kind: 'linear', point1: { x: 0, y: 0 }, point2: { x: 10, y: 0 }, displayArea: { x: 0, y: 0, width: 10, height: 0 }, color: { kind: 'known', name: 'Red' }, extra: [1, 2] };
    d.transact(() => ((d.getMap('layerData').get(R) as Y.Map<unknown>).get('rulerItems') as Y.Array<unknown>).push([plain, { ...plain, id: 'r2' }]));
    expect(layer<LayerRuler>(d, R).rulerItems).toEqual([plain, { ...plain, id: 'r2' }]);
    const undo = createUndoManager(d);
    moveRulerItem(d, R, 'r1', 0, 5);
    const arr = (d.getMap('layerData').get(R) as Y.Map<unknown>).get('rulerItems') as Y.Array<unknown>;
    expect(arr.toArray().every((v) => v instanceof Y.Map)).toBe(true);
    expect(schema(d)).toBe(2);
    const [r1, r2] = layer<LayerRuler>(d, R).rulerItems as unknown as Record<string, unknown>[];
    expect(r1).toEqual({ ...plain, point1: { x: 0, y: 5 }, point2: { x: 10, y: 5 }, displayArea: { x: 0, y: 5, width: 10, height: 0 } });
    expect(r2).toEqual({ ...plain, id: 'r2' });
    // Undo takes back the move, not the conversion.
    undo.undo();
    expect(layer<LayerRuler>(d, R).rulerItems).toEqual([plain, { ...plain, id: 'r2' }]);
    expect(arr.toArray().every((v) => v instanceof Y.Map)).toBe(true);
  });

  it('two people turning the same rulers into Y.Maps at once keep each ruler once', () => {
    const a = layoutDoc(1);
    const R = ensureRulerLayer(a);
    a.transact(() => ((a.getMap('layerData').get(R) as Y.Map<unknown>).get('rulerItems') as Y.Array<unknown>).push([{ id: 'r1', kind: 'linear', point1: { x: 0, y: 0 }, point2: { x: 1, y: 0 }, displayArea: { x: 0, y: 0, width: 1, height: 0 } }]));
    const b = copyOf(a, 2);
    moveRulerItem(a, R, 'r1', 1, 0);
    moveRulerItem(b, R, 'r1', 0, 1);
    sync(a, b);
    removeDuplicateItems(a, 'repair');
    removeDuplicateItems(b, 'repair');
    sync(a, b);
    expect(layer<LayerRuler>(a, R).rulerItems).toHaveLength(1);
    expect(layer<LayerRuler>(b, R).rulerItems).toEqual(layer<LayerRuler>(a, R).rulerItems);
  });

  it('an area sheet without an offset reads as before, and painting after a move lands where it was painted', () => {
    const d = layoutDoc(1);
    const A = ensureAreaLayer(d);
    paintAreaCells(d, A, [{ x: 1, y: 1, color: 'FF000000' }]);
    expect(schema(d)).toBe(1);
    moveArea(d, A, 2, 3);
    expect(schema(d)).toBe(2);
    paintAreaCells(d, A, [{ x: 0, y: 0, color: 'FFFF0000' }, { x: 3, y: 4, color: null }]);
    expect(layer<LayerArea>(d, A).areas).toEqual([{ x: 0, y: 0, color: 'FFFF0000' }]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent edits across the apps: the web's half of each case is an
// update in the contract; the desktop makes the other half itself
// (SyncDocTest.DocShapeContract*) and must end where `expect` says.
// ---------------------------------------------------------------------------

interface Contract {
  orderByZ: { z: (number | null)[]; order: number[] }[];
  assignZ: { cur: { id: string; z: number | null }[]; want: string[]; z: Record<string, number> }[];
  concurrent: {
    name: string;
    base: string;
    web: string;
    desktop: string;
    expect: Record<string, unknown>;
  }[];
  /** A doc in shape 1 with two plain-object rulers (r1, r2), an area sheet and two parts. */
  shapeOne: string;
}

function shapeOneDoc(): Y.Doc {
  const d = layoutDoc(1);
  const R = ensureRulerLayer(d);
  const ruler = (id: string, y: number) => ({
    id, kind: 'linear', displayArea: { x: 0, y, width: 10, height: 0 }, myGroup: '',
    color: { kind: 'known', name: 'Red' }, lineThickness: 1, displayDistance: true, displayUnit: true,
    guidelineColor: { kind: 'known', name: 'Black' }, guidelineThickness: 1, guidelineDashPattern: [], unit: 0,
    measureFont: { family: 'Arial', size: 8, style: 'Regular' }, measureFontColor: { kind: 'known', name: 'Black' },
    point1: { x: 0, y }, point2: { x: 10, y }, attachedBrick1Id: '', attachedBrick2Id: '', offsetDistance: 0, allowOffset: false,
  });
  d.transact(() => ((d.getMap('layerData').get(R) as Y.Map<unknown>).get('rulerItems') as Y.Array<unknown>).push([ruler('r1', 0), ruler('r2', 20)]));
  const A = ensureAreaLayer(d);
  paintAreaCells(d, A, [{ x: 1, y: 1, color: 'FF000000' }]);
  const L = ensureBrickLayer(d);
  placeBrick(d, L, { ...brick, x: 0, y: 0 });
  placeBrick(d, L, { ...brick, x: 10, y: 0 });
  return d;
}

// Found by what they are, not by id (the vectors' ids were minted once).
const sheetOf = (d: Y.Doc, type: string) => docToBbm(d).layers.find((l) => l.type === type)!.id;
const theRuler = (d: Y.Doc) => layer<LayerRuler>(d, sheetOf(d, 'ruler')).rulerItems[0]!.id;
const partAt = (d: Y.Doc, x: number) => layer<LayerBrick>(d, 'brick-1').bricks.find((b) => b.displayArea.x === x)!.id;

function concurrentCases(): { name: string; base: Y.Doc; web: (d: Y.Doc) => void; desktop: string; local: (d: Y.Doc) => void; expect: Record<string, unknown> }[] {
  const base = layoutDoc(1);
  const R = ensureRulerLayer(base);
  addLinearRuler(base, R, { x: 0, y: 0 }, { x: 10, y: 0 });
  const A = ensureAreaLayer(base);
  paintAreaCells(base, A, [{ x: 1, y: 1, color: 'FF000000' }, { x: 2, y: 1, color: 'FF00FF00' }]);
  const L = ensureBrickLayer(base);
  placeBrick(base, L, { ...brick, x: 0, y: 0 });
  const q = placeBrick(base, L, { ...brick, x: 10, y: 0 });
  reorderBricks(base, [q], 'front'); // ordered by z from here
  const moveRuler = (dy: number) => (d: Y.Doc) => moveRulerItem(d, sheetOf(d, 'ruler'), theRuler(d), 0, dy);
  const dropRuler = (d: Y.Doc) => deleteRulerItem(d, sheetOf(d, 'ruler'), theRuler(d));
  const toFront = (d: Y.Doc) => reorderBricks(d, [partAt(d, 0)], 'front');
  return [
    {
      name: 'web moves a ruler while the desktop deletes it',
      base, web: moveRuler(5), desktop: 'delete the ruler', local: dropRuler,
      expect: { rulers: 0 },
    },
    {
      name: 'web deletes a ruler while the desktop moves it by (0, 5)',
      base, web: dropRuler, desktop: 'move the ruler by (0, 5)', local: moveRuler(5),
      expect: { rulers: 0 },
    },
    {
      name: 'web and desktop move the same area sheet at once',
      base, web: (d) => moveArea(d, sheetOf(d, 'area'), 1, 0), desktop: 'move the area sheet by (0, 1) cells', local: (d) => moveArea(d, sheetOf(d, 'area'), 0, 1),
      expect: { cells: 2, cellsAtOneOf: [[[2, 1], [3, 1]], [[1, 2], [2, 2]]] },
    },
    {
      name: 'web brings a part to front while the desktop deletes it',
      base, web: toFront, desktop: 'delete the part at x 0', local: (d) => deleteBricks(d, 'brick-1', [partAt(d, 0)]),
      expect: { bricksX: [10] },
    },
    {
      name: 'web brings a part to front while the desktop drags it to x 40',
      base, web: toFront, desktop: 'move the part at x 0 to x 40', local: (d) => moveBrick(d, 'brick-1', partAt(d, 0), 42, 1),
      expect: { bricksX: [10, 40] },
    },
  ];
}

function check(d: Y.Doc, expectation: Record<string, unknown>): void {
  const map = docToBbm(d);
  const rulers = map.layers.filter((l): l is LayerRuler => l.type === 'ruler').flatMap((l) => l.rulerItems);
  const cells = map.layers.filter((l): l is LayerArea => l.type === 'area').flatMap((l) => l.areas);
  const bricks = map.layers.filter((l): l is LayerBrick => l.type === 'brick').flatMap((l) => l.bricks);
  if ('rulers' in expectation) expect(rulers).toHaveLength(expectation.rulers as number);
  if ('cells' in expectation) {
    expect(cells).toHaveLength(expectation.cells as number);
    const at = cells.map((c) => [c.x, c.y]).sort();
    expect(expectation.cellsAtOneOf as number[][][]).toContainEqual(at);
  }
  // Bottom first.
  if ('bricksX' in expectation) expect(bricks.map((b) => b.displayArea.x)).toEqual(expectation.bricksX);
}

describe('concurrent edits across the apps (contract)', () => {
  if (nodeEnv.BLD_WRITE_CONTRACTS === '1') {
    it('writes the vectors', async () => {
      const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { writeFileSync: (p: string, s: string) => void };
      const c: Contract = { ...contract };
      c.shapeOne = b64(Y.encodeStateAsUpdate(shapeOneDoc()));
      c.concurrent = concurrentCases().map((k) => ({
        name: k.name,
        base: b64(Y.encodeStateAsUpdate(k.base)),
        web: b64(editOf(k.base, 2, k.web)),
        desktop: k.desktop,
        expect: k.expect,
      }));
      const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd(); // apps/web
      fs.writeFileSync(`${cwd}/src/editor/test/fixtures/doc-shape.json`, `${JSON.stringify(c, null, 2)}\n`);
    });
    return;
  }
  const c = contract;
  it('the shape-1 doc reads, and the first ruler edit moves it to shape 2 keeping both rulers', () => {
    const d = decoded(c.shapeOne);
    expect(schema(d)).toBe(1);
    const R = sheetOf(d, 'ruler');
    expect(layer<LayerRuler>(d, R).rulerItems.map((r) => r.id)).toEqual(['r1', 'r2']);
    moveRulerItem(d, R, 'r1', 0, 5);
    expect(schema(d)).toBe(2);
    expect(layer<LayerRuler>(d, R).rulerItems.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
  const local = new Map(concurrentCases().map((k) => [k.name, k.local] as const));
  it.each(c.concurrent)('$name', ({ name, base, web, expect: want }) => {
    // The web's edit, and (standing in for the desktop's) the same edit made
    // here on base at the same time, arriving in either order.
    const mine = editOf(decoded(base), 3, local.get(name)!);
    for (const order of [[web, mine], [mine, web]] as const) {
      const d = decoded(base);
      for (const u of order) Y.applyUpdate(d, typeof u === 'string' ? unb64(u) : u);
      check(d, want);
    }
  });
});
