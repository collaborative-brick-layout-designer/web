// The one-time fix clamp-drawing-values (clampDrawingValues.ts, run by
// dataFixes.ts): drawing settings saved out of range before the live route
// checked them are put back in range in every place a document is read
// from, as an ordinary Yjs update, and nothing else changes.
//   - every kind of value out of range, on every kind of sheet and both
//     ruler shapes, ends in range; values in range and other fields stay;
//   - a layout's snapshot, its stored updates, a module, a module version
//     (Restore) and a catalog version are fixed; documents in range keep
//     their bytes; no row is deleted;
//   - the dry run writes nothing; the fix runs only when asked, once;
//   - a browser in the layout gets the fix live, and a desktop that was
//     offline gets it on reconnecting, merged with its own edits.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBbm } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, seedFromBbm, toItemMap } from '@cld/ydoc';
import { db, loginAs, resetDb, schema } from '../test/helpers.js';
import { sqlite } from '../db/index.js';
import { attachUser } from '../auth/cookie.js';
import { passwordRoutes } from '../routes/auth/password.js';
import { layoutRoutes } from '../routes/layouts.js';
import { moduleRoutes } from '../routes/modules.js';
import { wsRoutes } from '../routes/ws.js';
import { docHub } from '../ws/docHub.js';
import { checkGridSizes, drawingProblems } from '../ws/gridGuard.js';
import { Peer } from '../routes/test/wsPeer.js';
import { CLAMP_FIX_ID, clampDocDrawing, clampDrawingValues, type FixedItem } from './clampDrawingValues.js';
import { askedFixes, runDataFixes } from './dataFixes.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sheets of a doc by type. */
const sheet = (doc: Y.Doc, type: string) => [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l.get('type') === type)!;

/** The default layout, with an area sheet and a ruler sheet (a shape-1 JSON ruler and a shape-2 map ruler), all in range. */
function goodDoc(): Y.Doc {
  const doc = createDefaultLayoutDoc();
  doc.transact(() => {
    const layerData = doc.getMap<Y.Map<unknown>>('layerData');
    const order = doc.getArray<string>('layers');
    const area = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ type: 'area', name: 'Area', visible: true, transparency: 80, areaCellSize: 32 })) area.set(k, v);
    area.set('areas', new Y.Array());
    layerData.set('area-1', area);
    order.push(['area-1']);
    const rulers = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ type: 'ruler', name: 'Rulers', visible: true, transparency: 100 })) rulers.set(k, v);
    const items = new Y.Array<unknown>();
    const font = { family: 'Arial', size: 10, style: 'Regular' };
    items.push([
      { id: 'plain', kind: 'linear', point1: { x: 0, y: 0 }, point2: { x: 32, y: 0 }, lineThickness: 4, guidelineThickness: 1, guidelineDashPattern: [4, 2], unit: 0, measureFont: font, offsetDistance: 0 },
      toItemMap({ id: 'map', kind: 'circular', center: { x: 5, y: 5 }, radius: 10, lineThickness: 2, guidelineThickness: 1, guidelineDashPattern: [], unit: 1, measureFont: font }),
    ]);
    rulers.set('rulerItems', items);
    layerData.set('ruler-1', rulers);
    order.push(['ruler-1']);
  });
  return doc;
}

/** Set values out of range on every kind of sheet and both rulers. */
function spoil(doc: Y.Doc): void {
  doc.transact(() => {
    const grid = sheet(doc, 'grid');
    grid.set('subDivisionNumber', 1_000_000);
    grid.set('gridThickness', Number.NaN);
    grid.set('gridSizeInStud', 0);
    grid.set('cellIndexFont', { family: 'Arial', size: 1e9, style: 'Bold' });
    grid.set('cellIndexCorner', { x: 5e6, y: 3 });
    grid.set('transparency', -40);
    sheet(doc, 'area').set('areaCellSize', 99_999);
    // A font that isn't one: nothing to clamp, so it goes (the apps use their default).
    sheet(doc, 'brick').set('cellIndexFont', 'huge');
    sheet(doc, 'brick').set('hullProperties', { isVisible: true, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1e6 });
    const items = sheet(doc, 'ruler').get('rulerItems') as Y.Array<unknown>;
    const plain = items.get(0) as Record<string, unknown>;
    items.delete(0, 1);
    items.insert(0, [{ ...plain, lineThickness: 1e9, unit: 77, guidelineDashPattern: new Array(100).fill(1), point1: { x: 1e12, y: 0 }, offsetDistance: Number.POSITIVE_INFINITY }]);
    const map = items.get(1) as Y.Map<unknown>;
    map.set('measureFont', { family: 'Arial', size: 100_000, style: 'Regular' });
    map.set('radius', -5);
    map.set('guidelineThickness', 500);
  });
}

function badDoc(): Y.Doc {
  const doc = goodDoc();
  spoil(doc);
  return doc;
}

const json = (doc: Y.Doc) => doc.getMap('layerData').toJSON() as Record<string, Record<string, unknown>>;

describe('clampDocDrawing', () => {
  it('puts every value out of range back in range and leaves the rest as it was', () => {
    const doc = badDoc();
    expect(drawingProblems(doc).size).toBeGreaterThan(10);
    const before = json(doc);
    const fix = clampDocDrawing(doc);
    expect(fix.update).not.toBeNull();
    expect(fix.left).toEqual([]);
    expect([...drawingProblems(doc)]).toEqual([]);
    // The whole document is one the live route and the snapshot routes take.
    expect(checkGridSizes(null, Y.encodeStateAsUpdate(doc))).toBeNull();

    const grid = sheet(doc, 'grid');
    expect(grid.get('subDivisionNumber')).toBe(100);
    expect(grid.get('gridThickness')).toBe(2); // not a number: the default
    expect(grid.get('gridSizeInStud')).toBe(1);
    expect(grid.get('cellIndexFont')).toEqual({ family: 'Arial', size: 500, style: 'Bold' });
    expect(grid.get('cellIndexCorner')).toEqual({ x: 1_000_000, y: 3 });
    expect(grid.get('transparency')).toBe(0);
    expect(sheet(doc, 'area').get('areaCellSize')).toBe(1024);
    expect(sheet(doc, 'brick').has('cellIndexFont')).toBe(false);
    expect(sheet(doc, 'brick').get('hullProperties')).toEqual({ isVisible: true, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 100 });

    const items = (sheet(doc, 'ruler').get('rulerItems') as Y.Array<unknown>).toArray();
    expect(items).toHaveLength(2);
    // The JSON ruler stays JSON, in its place, with only its bad fields changed.
    const plain = items[0] as Record<string, unknown>;
    expect(plain).toEqual({
      ...(before['ruler-1']!.rulerItems as Record<string, unknown>[])[0],
      lineThickness: 100,
      unit: 0,
      guidelineDashPattern: [],
      point1: { x: 1e7, y: 0 },
      offsetDistance: 0,
    });
    expect(Object.keys(plain)).toEqual(Object.keys((before['ruler-1']!.rulerItems as Record<string, unknown>[])[0]!));
    const map = items[1] as Y.Map<unknown>;
    expect(map).toBeInstanceOf(Y.Map);
    expect(map.get('measureFont')).toEqual({ family: 'Arial', size: 500, style: 'Regular' });
    expect(map.get('radius')).toBe(0);
    expect(map.get('guidelineThickness')).toBe(100);
    expect(map.get('center')).toEqual({ x: 5, y: 5 });

    // Everything else is as it was.
    const after = json(doc);
    const changed = new Set(fix.changes.map((c) => `${c.sheet}.${c.ruler ?? ''}.${c.setting.split('.')[1]}`));
    for (const [id, layer] of Object.entries(before)) {
      for (const [k, v] of Object.entries(layer)) {
        if (k === 'rulerItems' || changed.has(`${id}..${k}`)) continue;
        expect(after[id]![k], `${id}.${k}`).toEqual(v);
      }
    }
    expect(fix.changes.map((c) => c.setting).sort()).toEqual(
      [
        'area.areaCellSize',
        'grid.cellIndexCorner',
        'grid.cellIndexFont',
        'grid.cellIndexFont',
        'grid.gridSizeInStud',
        'grid.gridThickness',
        'grid.subDivisionNumber',
        'ruler.guidelineDashPattern',
        'ruler.guidelineThickness',
        'ruler.lineThickness',
        'ruler.measureFont',
        'ruler.offsetDistance',
        'ruler.point1',
        'ruler.radius',
        'ruler.unit',
        'sheet.hullProperties',
        'sheet.transparency',
      ].sort(),
    );
  });

  it('makes the same document from the update on another copy, and nothing the second time', () => {
    const doc = badDoc();
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const fix = clampDocDrawing(doc);
    Y.applyUpdate(copy, fix.update!);
    expect(copy.getMap('layerData').toJSON()).toEqual(doc.getMap('layerData').toJSON());
    expect(clampDocDrawing(doc)).toEqual({ update: null, changes: [], left: [] });
  });

  it('changes nothing in a real layout that is in range', () => {
    const doc = seedFromBbm(readBbm(readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8')).map);
    const state = Y.encodeStateAsUpdate(doc);
    expect(clampDocDrawing(doc).update).toBeNull();
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state))).toBe(true);
  });
});

// Values of the wrong shape (the dry run on collab's backup found the grid
// cell-index corner of a layout imported before 2026-09-27 holding the XML
// element's whitespace text): never spread into an object of characters.
const OLD_CORNER = '\n        \n        \n      ';
const WRONG_SHAPES: [string, unknown][] = [
  ['the old whitespace text', OLD_CORNER],
  ['whitespace', '  \t '],
  ['an empty string', ''],
  ['a number', 7],
  ['an array', [1, 2]],
];

describe('clampDocDrawing on values of the wrong shape', () => {
  it('gives the grid of the old Fordyce 2026 import the default cell-index corner', () => {
    const doc = goodDoc();
    sheet(doc, 'grid').set('cellIndexCorner', OLD_CORNER);
    expect([...drawingProblems(doc)]).toEqual(['grid-1.cellIndexCorner']);
    const fix = clampDocDrawing(doc);
    expect(sheet(doc, 'grid').get('cellIndexCorner')).toEqual({ x: 0, y: 0 });
    expect(fix.changes).toEqual([{ setting: 'grid.cellIndexCorner', sheet: 'grid-1', from: OLD_CORNER, to: { x: 0, y: 0 } }]);
    expect(fix.left).toEqual([]);
  });

  it.each(WRONG_SHAPES)('gives a cell-index corner that is %s the default corner', (_what, v) => {
    const doc = goodDoc();
    sheet(doc, 'grid').set('cellIndexCorner', v);
    clampDocDrawing(doc);
    expect(sheet(doc, 'grid').get('cellIndexCorner')).toEqual({ x: 0, y: 0 });
    expect([...drawingProblems(doc)]).toEqual([]);
  });

  // (A whole number 0 to 16 is one the live route takes, so a number here is one past that.)
  it.each([
    ...WRONG_SHAPES.filter(([, v]) => typeof v !== 'number'),
    ['a number past the last', 99] as [string, unknown],
    ['a fraction', 2.5] as [string, unknown],
    ['an object', { unit: 1 }] as [string, unknown],
  ])('gives a ruler unit that is %s studs, in both ruler shapes', (_what, v) => {
    const doc = goodDoc();
    const items = sheet(doc, 'ruler').get('rulerItems') as Y.Array<unknown>;
    const plain = items.get(0) as Record<string, unknown>;
    doc.transact(() => {
      items.delete(0, 1);
      items.insert(0, [{ ...plain, unit: v }]);
      (items.get(1) as Y.Map<unknown>).set('unit', v);
    });
    clampDocDrawing(doc);
    expect((items.get(0) as Record<string, unknown>).unit).toBe(0);
    expect((items.get(1) as Y.Map<unknown>).get('unit')).toBe(0);
    expect([...drawingProblems(doc)]).toEqual([]);
  });

  it.each(WRONG_SHAPES)('removes a font, hull or point that is %s (the apps use their default), never spreading it', (_what, v) => {
    const doc = goodDoc();
    const grid = sheet(doc, 'grid');
    const items = sheet(doc, 'ruler').get('rulerItems') as Y.Array<unknown>;
    const plain = items.get(0) as Record<string, unknown>;
    const map = items.get(1) as Y.Map<unknown>;
    doc.transact(() => {
      grid.set('cellIndexFont', v);
      grid.set('hullProperties', v);
      items.delete(0, 1);
      items.insert(0, [{ ...plain, measureFont: v, point1: v, point2: v }]);
      map.set('measureFont', v);
      map.set('center', v);
    });
    const fix = clampDocDrawing(doc);
    expect(fix.left).toEqual([]);
    expect([...drawingProblems(doc)]).toEqual([]);
    expect(grid.has('cellIndexFont')).toBe(false);
    expect(grid.has('hullProperties')).toBe(false);
    const p = items.get(0) as Record<string, unknown>;
    expect(['measureFont', 'point1', 'point2'].filter((k) => k in p)).toEqual([]);
    expect(map.has('measureFont')).toBe(false);
    expect(map.has('center')).toBe(false);
    for (const c of fix.changes) expect(c.to).toBeUndefined();
  });
});

describe('the clamp-drawing-values fix on a database', () => {
  let app: FastifyInstance;
  let port: number;
  let owner: { cookie: string; id: string };
  const opened: string[] = [];

  beforeEach(async () => {
    resetDb();
    sqlite.exec('DELETE FROM data_fixes');
    app = Fastify();
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(moduleRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    owner = await loginAs(app, 'clamp@example.com');
  });

  afterEach(async () => {
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function layout(title: string, snapshot: Y.Doc, updates: Uint8Array[] = []): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    opened.push(id);
    // As saved before the guard: written straight to the database.
    db.update(schema.layouts).set({ docSnapshot: Buffer.from(encodeDoc(snapshot)) }).where(eq(schema.layouts.id, id)).run();
    for (const u of updates) db.insert(schema.layoutUpdates).values({ layoutId: id, doc: 'main', updateBytes: Buffer.from(u), createdAt: new Date() }).run();
    return id;
  }

  function module(title: string, doc: Y.Doc, versions: Y.Doc[] = []): string {
    const id = randomUUID();
    const now = new Date();
    db.insert(schema.modules)
      .values({ id, title, ownerUserId: owner.id, createdBy: owner.id, docSnapshot: Buffer.from(encodeDoc(doc)), docVersion: 3, latestVersion: versions.length, createdAt: now, updatedAt: now })
      .run();
    versions.forEach((v, i) =>
      db.insert(schema.moduleVersions).values({ id: randomUUID(), moduleId: id, version: i + 1, docSnapshot: Buffer.from(encodeDoc(v)), authorId: owner.id, createdAt: now }).run(),
    );
    return id;
  }

  function catalogItem(kind: 'layout' | 'module' | 'venue', bytes: Uint8Array): string {
    const id = randomUUID();
    const now = new Date();
    db.insert(schema.catalogItems).values({ id, kind, sourceId: randomUUID(), ownerUserId: owner.id, title: `${kind} item`, status: 'public', publicVersion: 1, createdAt: now, updatedAt: now }).run();
    db.insert(schema.catalogItemVersions).values({ id: randomUUID(), itemId: id, version: 1, status: 'public', docSnapshot: Buffer.from(bytes), createdAt: now }).run();
    return id;
  }

  /** Every row's bytes the fix may touch, to compare. */
  function dump(): Record<string, string> {
    const out: Record<string, string> = {};
    const hex = (b: unknown) => (b ? Buffer.from(b as Uint8Array).toString('hex') : 'null');
    for (const r of sqlite.prepare('select id, doc_snapshot, doc_version from layouts').all() as { id: string; doc_snapshot: Buffer; doc_version: number }[]) out[`layout ${r.id}`] = `${r.doc_version}:${hex(r.doc_snapshot)}`;
    for (const r of sqlite.prepare('select id, layout_id, update_bytes from layout_updates').all() as { id: number; layout_id: string; update_bytes: Buffer }[]) out[`update ${r.id} ${r.layout_id}`] = hex(r.update_bytes);
    for (const r of sqlite.prepare('select id, doc_snapshot, doc_version from modules').all() as { id: string; doc_snapshot: Buffer; doc_version: number }[]) out[`module ${r.id}`] = `${r.doc_version}:${hex(r.doc_snapshot)}`;
    for (const r of sqlite.prepare('select id, doc_snapshot from module_versions').all() as { id: string; doc_snapshot: Buffer }[]) out[`module version ${r.id}`] = hex(r.doc_snapshot);
    for (const r of sqlite.prepare('select id, doc_snapshot from catalog_item_versions').all() as { id: string; doc_snapshot: Buffer }[]) out[`catalog version ${r.id}`] = hex(r.doc_snapshot);
    return out;
  }

  /** A layout's document as the server reads it (snapshot, then its updates). */
  function layoutDoc(id: string): Y.Doc {
    const doc = new Y.Doc();
    const row = sqlite.prepare('select doc_snapshot from layouts where id = ?').get(id) as { doc_snapshot: Buffer };
    Y.applyUpdate(doc, row.doc_snapshot);
    for (const u of sqlite.prepare("select update_bytes from layout_updates where layout_id = ? and doc = 'main' order by id").all(id) as { update_bytes: Buffer }[]) Y.applyUpdate(doc, u.update_bytes);
    return doc;
  }
  const snapshotDoc = (sql: string, id: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (sqlite.prepare(sql).get(id) as { doc_snapshot: Buffer }).doc_snapshot);
    return doc;
  };

  /** One of each place, out of range, and one of each in range. */
  async function world() {
    // Out of range in the snapshot.
    const inSnapshot = await layout('Snapshot', badDoc());
    // Out of range only in a stored update not compacted yet.
    const base = goodDoc();
    const spoiled = new Y.Doc();
    Y.applyUpdate(spoiled, Y.encodeStateAsUpdate(base));
    const sv = Y.encodeStateVector(spoiled);
    spoil(spoiled);
    const inUpdates = await layout('Updates', base, [Y.encodeStateAsUpdate(spoiled, sv)]);
    const fine = await layout('Fine', goodDoc());
    const badModule = module('Bad module', badDoc(), [goodDoc(), badDoc()]);
    const fineModule = module('Fine module', goodDoc(), [goodDoc()]);
    const catalogLayout = catalogItem('layout', encodeDoc(badDoc()));
    const catalogModule = catalogItem('module', encodeDoc(badDoc()));
    const venueJson = JSON.stringify({ edges: [], obstacles: [], size: 1e12 });
    const venue = catalogItem('venue', Buffer.from(venueJson, 'utf8'));
    return { inSnapshot, inUpdates, fine, badModule, fineModule, catalogLayout, catalogModule, venue, venueJson };
  }

  it('reports in a dry run what it would change, writing nothing', async () => {
    await world();
    const before = dump();
    const items: FixedItem[] = [];
    const s = clampDrawingValues(sqlite, { apply: false, onItem: (i) => items.push(i), pageSize: 2 });
    expect(dump()).toEqual(before);
    expect(s.layouts).toMatchObject({ checked: 3, changed: 2, values: 34, unreadable: 0 });
    expect(s.modules).toMatchObject({ checked: 2, changed: 1, values: 17 });
    expect(s.moduleVersions).toMatchObject({ checked: 3, changed: 1, values: 17 });
    expect(s.catalogVersions).toMatchObject({ checked: 2, changed: 2, values: 34 });
    expect(s.bySetting['grid.subDivisionNumber']).toBe(6);
    expect(s.notClean).toBe(0);
    expect(items.map((i) => i.label).sort()).toEqual(['Bad module', 'Bad module v2', 'Snapshot', 'Updates', 'layout layout item v1', 'module module item v1']);
  });

  it('fixes every place with an ordinary update, keeps documents in range byte for byte, and deletes nothing', async () => {
    const w = await world();
    const before = dump();
    const s = clampDrawingValues(sqlite, { apply: true });
    expect(s.layouts.changed + s.modules.changed + s.moduleVersions.changed + s.catalogVersions.changed).toBe(6);
    const after = dump();

    // Nothing gone; each fixed layout has one more stored update and the same snapshot.
    for (const key of Object.keys(before)) expect(after[key], key).toBeDefined();
    for (const id of [w.inSnapshot, w.inUpdates]) {
      expect(after[`layout ${id}`]).toBe(before[`layout ${id}`]);
      expect(Object.keys(after).filter((k) => k.startsWith('update ') && k.endsWith(id))).toHaveLength(Object.keys(before).filter((k) => k.startsWith('update ') && k.endsWith(id)).length + 1);
      expect([...drawingProblems(layoutDoc(id))]).toEqual([]);
    }
    // In range: untouched.
    expect(after[`layout ${w.fine}`]).toBe(before[`layout ${w.fine}`]);
    expect(Object.keys(after).filter((k) => k.endsWith(w.fine))).toEqual(Object.keys(before).filter((k) => k.endsWith(w.fine)));
    expect(after[`module ${w.fineModule}`]).toBe(before[`module ${w.fineModule}`]);
    const changedKeys = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changedKeys).toHaveLength(6);

    // The module: in range, with a new doc_version so apps fetch it again.
    const m = db.select().from(schema.modules).where(eq(schema.modules.id, w.badModule)).get()!;
    expect(m.docVersion).toBe(4);
    expect([...drawingProblems(snapshotDoc('select doc_snapshot from modules where id = ?', w.badModule))]).toEqual([]);
    for (const v of db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, w.badModule)).all()) {
      expect([...drawingProblems(snapshotDoc('select doc_snapshot from module_versions where id = ?', v.id))]).toEqual([]);
    }
    // The catalog's layout and module; the venue (JSON, no drawing settings) as it was.
    for (const v of sqlite.prepare("select v.id from catalog_item_versions v join catalog_items i on i.id = v.item_id where i.kind != 'venue'").all() as { id: string }[]) {
      expect([...drawingProblems(snapshotDoc('select doc_snapshot from catalog_item_versions where id = ?', v.id))]).toEqual([]);
    }
    const venue = sqlite.prepare('select v.doc_snapshot from catalog_item_versions v where v.item_id = ?').get(w.venue) as { doc_snapshot: Buffer };
    expect(venue.doc_snapshot.toString('utf8')).toBe(w.venueJson);

    // Restoring the old version puts back nothing out of range.
    const restore = await app.inject({ method: 'POST', url: `/api/modules/${w.badModule}/versions/2/restore`, headers: { cookie: owner.cookie } });
    expect(restore.statusCode, restore.body).toBe(200);
    expect([...drawingProblems(snapshotDoc('select doc_snapshot from modules where id = ?', w.badModule))]).toEqual([]);

    // A layout fixed opens with the fix: the server's room reads it in range.
    const room = await docHub.getOrCreate(w.inUpdates);
    expect([...drawingProblems(room.doc)]).toEqual([]);

    // A second run changes nothing.
    const again = dump();
    const s2 = clampDrawingValues(sqlite, { apply: true });
    expect(s2.layouts.changed + s2.modules.changed + s2.moduleVersions.changed + s2.catalogVersions.changed).toBe(0);
    expect(dump()).toEqual(again);
  });

  it('runs at start only when asked, records it, and never runs twice', async () => {
    const w = await world();
    const before = dump();
    const log: string[] = [];
    // Not asked: one line, nothing written.
    /** What the start log said about this fix. */
    const said = () => log.filter((l) => l.includes(CLAMP_FIX_ID));
    let run = runDataFixes(sqlite, askedFixes(undefined), (l) => log.push(l));
    expect(run).toEqual({ ran: [], pending: [CLAMP_FIX_ID] });
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain(`CBLD_DATA_FIX=<name>`);
    expect(said()[0]).toContain(`not run yet: ${CLAMP_FIX_ID}`);
    expect(dump()).toEqual(before);
    expect(sqlite.prepare('select count(*) as n from data_fixes where id = ?').get(CLAMP_FIX_ID)).toEqual({ n: 0 });

    // Asked: it runs and is recorded.
    log.length = 0;
    run = runDataFixes(sqlite, askedFixes(` ${CLAMP_FIX_ID} `), (l) => log.push(l));
    expect(run.ran.map((r) => r.id)).toEqual([CLAMP_FIX_ID]);
    expect(run.pending).toEqual([]);
    expect(log.join('\n')).toMatch(/layouts: 3 checked, 2 changed \(34 values\)/);
    expect(log.join('\n')).toMatch(/by setting: .*grid\.subDivisionNumber 6/);
    expect([...drawingProblems(layoutDoc(w.inSnapshot))]).toEqual([]);
    const rec = sqlite.prepare('select id, summary from data_fixes where id = ?').all(CLAMP_FIX_ID) as { id: string; summary: string }[];
    expect(rec.map((r) => r.id)).toEqual([CLAMP_FIX_ID]);
    expect(JSON.parse(rec[0]!.summary)).toMatchObject({ apply: true, layouts: { changed: 2 } });

    // Spoil a layout again: asked again, it doesn't run (it ran once).
    const later = await layout('Later', badDoc());
    const afterRun = dump();
    log.length = 0;
    run = runDataFixes(sqlite, askedFixes(CLAMP_FIX_ID), (l) => log.push(l));
    expect(run).toEqual({ ran: [], pending: [] });
    expect(said()).toEqual([expect.stringContaining('already ran')]);
    expect(dump()).toEqual(afterRun);
    expect(drawingProblems(layoutDoc(later)).size).toBeGreaterThan(0);
    // And once recorded, not asked: every start says it already ran, and does nothing.
    log.length = 0;
    runDataFixes(sqlite, askedFixes(''), (l) => log.push(l));
    expect(said()).toEqual([expect.stringMatching(/already ran on \d{4}-.*; nothing to do$/)]);
    expect(dump()).toEqual(afterRun);
  });

  it('a server with nothing to fix records it as done and says so', () => {
    const log: string[] = [];
    const run = runDataFixes(sqlite, askedFixes(undefined), (l) => log.push(l));
    expect(run).toEqual({ ran: [], pending: [] });
    expect(log).toContain(`[dataFix] ${CLAMP_FIX_ID}: looked, nothing to fix; recorded as done`);
    const rec = sqlite.prepare('select id, summary from data_fixes where id = ?').all(CLAMP_FIX_ID) as { id: string; summary: string }[];
    expect(rec.map((r) => r.id)).toEqual([CLAMP_FIX_ID]);
    expect(JSON.parse(rec[0]!.summary)).toMatchObject({ apply: false });
    // Next start: it says it already ran, and that is all.
    log.length = 0;
    runDataFixes(sqlite, askedFixes(undefined), (l) => log.push(l));
    expect(log.filter((l) => l.includes(CLAMP_FIX_ID))).toEqual([expect.stringContaining('already ran on')]);
    expect(log.every((l) => l.includes('already ran on'))).toBe(true);
  });

  async function until(what: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !what(); i++) await sleep(10);
    expect(what()).toBe(true);
  }

  it('reaches a browser in the layout live, through its room', async () => {
    const id = await layout('Open', badDoc());
    const browser = new Peer(port, id, owner.cookie, new Y.Doc(), 'Mozilla/5.0');
    await browser.synced;
    expect(drawingProblems(browser.doc).size).toBeGreaterThan(0);
    const rowsBefore = sqlite.prepare('select count(*) as n from layout_updates where layout_id = ?').get(id) as { n: number };
    const s = clampDrawingValues(sqlite, { apply: true, liveDoc: (l) => docHub.peek(l)?.doc });
    expect(s.layouts.changed).toBe(1);
    await until(() => drawingProblems(browser.doc).size === 0);
    expect(sheet(browser.doc, 'grid').get('subDivisionNumber')).toBe(100);
    // The room stores it as it stores any edit.
    await docHub.peek(id)!.flushBatch();
    const rowsAfter = sqlite.prepare('select count(*) as n from layout_updates where layout_id = ?').get(id) as { n: number };
    expect(rowsAfter.n).toBe(rowsBefore.n + 1);
    await browser.leave();
  });

  it('reaches a desktop that was offline when it reconnects, merged with its own edits', async () => {
    const id = await layout('Offline', badDoc());
    const desktopDoc = new Y.Doc();
    const first = new Peer(port, id, owner.cookie, desktopDoc);
    await first.synced;
    await first.leave();
    await docHub.close(id);
    // Offline: the desktop renames the grid sheet.
    sheet(desktopDoc, 'grid').set('name', 'Offline grid');
    // The fix runs at server start (no room open).
    expect(clampDrawingValues(sqlite, { apply: true }).layouts.changed).toBe(1);
    // Back online: it gets the fix, the server gets its edit.
    const again = new Peer(port, id, owner.cookie, desktopDoc);
    await again.synced;
    await until(() => drawingProblems(desktopDoc).size === 0);
    expect(sheet(desktopDoc, 'grid').get('name')).toBe('Offline grid');
    await until(() => sheet(docHub.peek(id)!.doc, 'grid').get('name') === 'Offline grid');
    expect([...drawingProblems(docHub.peek(id)!.doc)]).toEqual([]);
    expect(docHub.peek(id)!.doc.getMap('layerData').toJSON()).toEqual(desktopDoc.getMap('layerData').toJSON());
    await again.leave();
  });
});
