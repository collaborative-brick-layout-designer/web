// Replacing a placed module's parts with another version's (replace.ts):
// the old parts go from every sheet, the new ones land on the sheets
// asked for, the module holds exactly the new parts and keeps its id, name
// and look, the sets only its old parts were in go too, and doing it twice
// leaves one set of parts.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { createDefaultLayoutDoc, docToBbm, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { appendBricks, cloneGroups, groupChain, moduleBatchesFromBytes, moduleBatchesFromMap, replaceModuleParts, sheetKey, type ModuleBatch } from './index.js';

const A = (x: number, y: number) => ({ x, y, width: 2, height: 2 });

/** A layout with two parts sheets, loose parts, and a module "m1" of two parts (one in a set). */
function layout(): { doc: Y.Doc; track: string; scenery: string; loose: string[]; members: string[] } {
  const doc = createDefaultLayoutDoc();
  const track = 'brick-1';
  const scenery = 'brick-2';
  doc.transact(() => {
    const l = new Y.Map<unknown>();
    l.set('id', scenery);
    l.set('type', 'brick');
    l.set('name', 'Scenery');
    l.set('visible', true);
    l.set('transparency', 100);
    l.set('hullProperties', { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 });
    l.set('displayBrickElevation', false);
    l.set('bricks', new Y.Array());
    l.set('groups', new Y.Array());
    doc.getMap('layerData').set(scenery, l);
    doc.getArray<string>('layers').push([scenery]);
  });
  let loose: string[] = [];
  let members: string[] = [];
  doc.transact(() => {
    loose = appendBricks(doc, track, [{ partNumber: 'loose.1', displayArea: A(100, 100) }]);
    members = [
      ...appendBricks(doc, track, [{ partNumber: 'a.1', displayArea: A(0, 0), myGroup: 'g-set' }], [{ id: 'g-set', partNumber: 'set.1', myGroup: 'g-outer' }, { id: 'g-outer', myGroup: '' }]),
      ...appendBricks(doc, scenery, [{ partNumber: 'b.1', displayArea: A(4, 0) }]),
    ];
    const m: SidecarModule = { id: 'm1', name: 'Harbor crane', members, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], outlineColor: '#ff0000', libraryModuleId: 'lib', libraryVersion: 7 };
    writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules: [m, { id: 'm2', name: 'Other', members: loose, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] });
  });
  return { doc, track, scenery, loose, members };
}

const parts = (doc: Y.Doc) => docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks.map((b) => ({ sheet: l.name, pn: b.partNumber, id: b.id, x: b.displayArea.x, group: b.myGroup })) : []));
const groupsOf = (doc: Y.Doc) => docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.groups.map((g) => g.id) : []));
const moduleOf = (doc: Y.Doc, id: string) => (readSidecarCache(doc)!.modules as SidecarModule[]).find((m) => m.id === id);

const V8: ModuleBatch[] = [
  { layerName: 'Track', bricks: [{ partNumber: 'a.1', displayArea: A(0, 0) }, { partNumber: 'c.1', displayArea: A(2, 0), myGroup: 'vg' }], groups: [{ id: 'vg', partNumber: 'set.2', myGroup: '' }] },
  { layerName: ' scenery ', bricks: [{ partNumber: 'b.1', displayArea: A(4, 2) }] },
  { layerName: 'Empty', bricks: [] },
];

describe('replaceModuleParts', () => {
  it('swaps the module’s parts for the version’s, each on its sheet, and keeps everything else', () => {
    const { doc, track, scenery, loose, members } = layout();
    const bySheet = (name: string) => (sheetKey(name) === 'scenery' ? scenery : track);
    const ids = replaceModuleParts(doc, 'm1', V8, bySheet, { libraryVersion: 8 }, 'test')!;
    expect(ids).toHaveLength(3);
    const now = parts(doc);
    expect(now.filter((p) => members.includes(p.id))).toEqual([]);
    expect(now.filter((p) => ids.includes(p.id)).map((p) => `${p.sheet}:${p.pn}`).sort()).toEqual(['Layout:a.1', 'Layout:c.1', 'Scenery:b.1']);
    // What isn't the module's stays.
    expect(now.find((p) => p.id === loose[0])).toMatchObject({ pn: 'loose.1', x: 100 });
    expect(moduleOf(doc, 'm2')).toMatchObject({ members: loose });
    // The module holds exactly the new parts, and kept its id, name, look and link.
    expect(moduleOf(doc, 'm1')).toMatchObject({ id: 'm1', name: 'Harbor crane', outlineColor: '#ff0000', libraryModuleId: 'lib', libraryVersion: 8 });
    expect([...moduleOf(doc, 'm1')!.members].sort()).toEqual([...ids].sort());
    // The old set and its parent went with their only part; the version's set came, under a new id.
    const groups = groupsOf(doc);
    expect(groups).not.toContain('g-set');
    expect(groups).not.toContain('g-outer');
    expect(groups).not.toContain('vg');
    expect(groups).toHaveLength(1);
    expect(now.find((p) => p.pn === 'c.1')?.group).toBe(groups[0]);
  });

  it('twice leaves one set of parts', () => {
    const { doc, track } = layout();
    replaceModuleParts(doc, 'm1', V8, () => track, { libraryVersion: 8 });
    const second = replaceModuleParts(doc, 'm1', V8, () => track, { libraryVersion: 8 })!;
    const now = parts(doc).filter((p) => p.pn !== 'loose.1');
    expect(now).toHaveLength(3);
    expect(now.map((p) => p.id).sort()).toEqual([...second].sort());
    expect(groupsOf(doc)).toHaveLength(1);
  });

  it('a patch may be worked out from the module, and never changes its id or parts', () => {
    const { doc, track } = layout();
    const ids = replaceModuleParts(doc, 'm1', V8, () => track, (m) => ({ ...m, id: 'other', members: ['x'], shared: { by: 'Alice' } }))!;
    expect(moduleOf(doc, 'other')).toBeUndefined();
    expect(moduleOf(doc, 'm1')).toMatchObject({ shared: { by: 'Alice' } });
    expect([...moduleOf(doc, 'm1')!.members].sort()).toEqual([...ids].sort());
  });

  it('a set other parts are still in stays', () => {
    const { doc, track } = layout();
    doc.transact(() => appendBricks(doc, track, [{ partNumber: 'kept.1', displayArea: A(50, 50), myGroup: 'g-outer' }]));
    replaceModuleParts(doc, 'm1', [], () => track);
    expect(groupsOf(doc)).toEqual(['g-outer']);
    expect(moduleOf(doc, 'm1')?.members ?? []).toEqual([]);
  });

  it('an unknown module changes nothing', () => {
    const { doc, track } = layout();
    const before = Y.encodeStateAsUpdate(doc);
    expect(replaceModuleParts(doc, 'nope', V8, () => track)).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('is one transaction with the origin given', () => {
    const { doc, track } = layout();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    replaceModuleParts(doc, 'm1', V8, () => track, {}, 'server-apply');
    // (The doc-shape stamp that a module's part keys need is its own, later step.)
    expect(origins[0]).toBe('server-apply');
    expect(origins.filter((o) => o === 'server-apply')).toHaveLength(1);
  });
});

describe('batches and groups', () => {
  it('reads a module’s contents as one batch per sheet with parts', () => {
    const { doc } = layout();
    const batches = moduleBatchesFromMap(docToBbm(doc));
    expect(batches.map((b) => [b.layerName, b.bricks.length])).toEqual([['Layout', 2], ['Scenery', 1]]);
    expect(moduleBatchesFromBytes(Y.encodeStateAsUpdate(doc)).map((b) => b.layerName)).toEqual(['Layout', 'Scenery']);
    expect(() => moduleBatchesFromBytes(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('copies the groups above parts under new ids, parents first to last', () => {
    let n = 0;
    const src = [{ id: 'in', partNumber: 'set.1', myGroup: 'out' }, { id: 'out', myGroup: '' }, { id: 'unused', myGroup: '' }];
    const copied = cloneGroups(src, [{ myGroup: 'in' }, { myGroup: 'in' }, { myGroup: '' }, { myGroup: 'gone' }], () => `n${n++}`);
    expect(copied.bricks.map((b) => b.myGroup)).toEqual(['n0', 'n0', '', '']);
    expect(copied.groups).toEqual([{ id: 'n0', partNumber: 'set.1', myGroup: 'n1' }, { id: 'n1', myGroup: '' }]);
    expect(groupChain(src, 'in').map((g) => g.id)).toEqual(['in', 'out']);
    // A loop of groups ends.
    expect(groupChain([{ id: 'a', myGroup: 'b' }, { id: 'b', myGroup: 'a' }], 'a').map((g) => g.id)).toEqual(['a', 'b']);
  });
});
