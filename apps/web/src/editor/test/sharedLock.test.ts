// The lock on shared modules in the editor (sharedLock.ts, mutations.ts):
// a shared module is placed locked; whatever tool asks, a change to its
// parts, its part list or its name does nothing and says why, while
// moving, turning, pinning, recoloring, another sheet, a duplicate and
// removing it whole all work; other modules are untouched by any of it;
// and what gets through is never something the server would refuse.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import { sharedPlaced } from '@cld/modules';
import {
  addLayer,
  addSidecarModule,
  cloneModuleBricks,
  createSidecarModule,
  deleteBricks,
  deleteBricksAcrossLayers,
  deleteModuleWithParts,
  deleteSidecarModule,
  editBrick,
  ensureBrickLayer,
  groupBricks,
  importBricksAsModule,
  moveBricksToLayer,
  moveModuleBricks,
  patchSidecarModule,
  placeBrick,
  renameSidecarModule,
  rotateModuleBricks,
  setSidecarModuleMembers,
  ungroupBricks,
  updateSidecarModule,
  type ModuleBatch,
} from '../mutations';
import { enterModuleEdit, setModulePinned, takeOutOfModule } from '../moduleActions';
import { useEditorStore } from '../editorStore';
import { keepsLock, lockMessage, onSharedLock, sharedLockOn, sharedModule, type LockedAction } from '../sharedLock';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const BATCHES: ModuleBatch[] = [
  { layerName: 'Track', bricks: [{ partNumber: 'a.1', displayArea: { x: 0, y: 0, width: 2, height: 2 } }, { partNumber: 'b.1', displayArea: { x: 4, y: 0, width: 2, height: 2 } }] },
];

let told: { name: string; what: LockedAction }[] = [];

function world() {
  const doc = new Y.Doc();
  const sheet = ensureBrickLayer(doc);
  const shared = importBricksAsModule(doc, BATCHES, {
    name: 'Harbor crane',
    offset: { dx: 100, dy: 50 },
    library: { id: LIB, version: 7, shared: { by: 'Alice', server: 'https://example.org', placement: { degrees: 0, x: 0, y: 0 } } },
  })!;
  const free = importBricksAsModule(doc, BATCHES, { name: 'Yard', offset: { dx: 0, dy: 0 }, library: { id: LIB, version: 7 } })!;
  const loose = placeBrick(doc, sheet, { partNumber: 'loose.1', x: 300, y: 300, width: 2, height: 2 });
  return { doc, sheet, shared, free, loose };
}

const mod = (doc: Y.Doc, id: string) => readSidecarFromDoc(doc)!.modules!.find((m) => m.id === id) as SidecarModule & { shared?: Record<string, unknown> };
const parts = (doc: Y.Doc) => docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks.map((b) => ({ ...b, sheet: l.id })) : []));
const part = (doc: Y.Doc, id: string) => parts(doc).find((p) => p.id === id)!;
/** Runs `fn` and says whether it changed the layout, and what the person was told. */
function attempt(doc: Y.Doc, fn: () => void): { changed: boolean; told: typeof told } {
  const state = () => Array.from(Y.encodeSnapshot(Y.snapshot(doc))).join(',');
  const before = state();
  told = [];
  fn();
  return { changed: state() !== before, told };
}

describe('the lock on shared modules, in the editor', () => {
  beforeEach(() => {
    onSharedLock((s, what) => told.push({ name: s.name, what }));
    useEditorStore.setState({ editingModuleId: null, selection: [] });
  });
  afterEach(() => onSharedLock(() => undefined));

  it('a shared module is placed locked, with who shared it and where it sits', () => {
    const { doc, sheet, shared, free } = world();
    const m = mod(doc, shared.moduleId);
    expect(m).toMatchObject({ name: 'Harbor crane', libraryModuleId: LIB, libraryVersion: 7 });
    expect(m.shared).toEqual({ by: 'Alice', server: 'https://example.org', placement: { degrees: 0, x: 100, y: 50, sheets: { Track: expect.any(String) } } });
    expect(sharedModule(doc, shared.moduleId)).toMatchObject({ moduleId: LIB, version: 7, by: 'Alice' });
    // One from your own library is linked, not locked, as before.
    expect(mod(doc, free.moduleId)).not.toHaveProperty('shared');
    expect(sharedModule(doc, free.moduleId)).toBeNull();
    // The layout is shape 4 from here: older apps are told it needs a newer version.
    expect(doc.getMap('meta').get('schemaVersion')).toBe(4);
    expect(sheet).toBeTruthy();
  });

  it('refuses changing, deleting, grouping or taking out one of its parts, with the reason', () => {
    const { doc, sheet, shared } = world();
    const [a, b] = shared.ids as [string, string];
    const track = part(doc, a).sheet;
    const refused: [string, () => void, LockedAction][] = [
      ['a new part number', () => editBrick(doc, track, a, { partNumber: 'zzz.9' }), 'parts'],
      ['a new color', () => editBrick(doc, track, a, { partNumber: 'a.4' }), 'parts'],
      ['a new height', () => editBrick(doc, track, a, { altitude: 3 }), 'parts'],
      ['one part deleted', () => deleteBricks(doc, track, [a]), 'parts'],
      ['one part deleted, across sheets', () => deleteBricksAcrossLayers(doc, new Map([[track, [a]]])), 'parts'],
      ['one part to another sheet', () => moveBricksToLayer(doc, new Map([[track, [a]]]), sheet), 'parts'],
      ['grouped', () => groupBricks(doc, track, [a, b]), 'parts'],
      ['ungrouped', () => ungroupBricks(doc, track, [a]), 'parts'],
      ['a part taken out', () => takeOutOfModule(doc, shared.moduleId, [a]), 'members'],
      ['its parts set', () => setSidecarModuleMembers(doc, shared.moduleId, [a]), 'members'],
      ['a part put in another module', () => createSidecarModule(doc, 'Mine', [a]), 'members'],
      ['renamed', () => renameSidecarModule(doc, shared.moduleId, 'Mine now'), 'rename'],
      ['dissolved', () => deleteSidecarModule(doc, shared.moduleId), 'dissolve'],
      ['unlocked', () => updateSidecarModule(doc, shared.moduleId, ({ shared: _s, ...rest }) => rest as SidecarModule), 'dissolve'],
      ['pointed elsewhere', () => patchSidecarModule(doc, shared.moduleId, { libraryModuleId: '11111111-1111-4111-8111-111111111111' }), 'dissolve'],
      ['Edit module', () => enterModuleEdit(doc, shared.moduleId, a), 'edit'],
    ];
    for (const [name, fn, what] of refused) {
      const r = attempt(doc, fn);
      expect(r.changed, name).toBe(false);
      expect(r.told, name).toEqual([{ name: 'Harbor crane', what }]);
    }
    expect(useEditorStore.getState().editingModuleId).toBeNull();
    expect(part(doc, a)).toMatchObject({ partNumber: 'a.1', altitude: 0 });
    expect(mod(doc, shared.moduleId).members).toEqual([a, b]);
  });

  it('moves, turns, pins, recolors, changes sheet, duplicates and removes it as a whole', () => {
    const { doc, shared } = world();
    const [a, b] = shared.ids as [string, string];
    const other = addLayer(doc, 'brick');
    const fine: [string, () => void][] = [
      ['moved', () => moveModuleBricks(doc, shared.ids, 8, 8)],
      ['turned', () => rotateModuleBricks(doc, shared.ids, 90)],
      ['pinned', () => setModulePinned(doc, shared.moduleId, true)],
      ['recolored', () => updateSidecarModule(doc, shared.moduleId, (m) => ({ ...m, outlineColor: '#ff0000', showName: false }))],
      ['another sheet', () => moveBricksToLayer(doc, new Map([[part(doc, a).sheet, [a, b]]]), other)],
    ];
    for (const [name, fn] of fine) {
      const r = attempt(doc, fn);
      expect(r.changed, name).toBe(true);
      expect(r.told, name).toEqual([]);
    }
    expect(part(doc, a).sheet).toBe(other);
    expect(mod(doc, shared.moduleId)).toMatchObject({ pinned: true, outlineColor: '#ff0000' });
    expect(sharedModule(doc, shared.moduleId)).not.toBeNull();

    // A duplicate is another shared placement: the owner's name, the same link, moved along.
    expect(attempt(doc, () => cloneModuleBricks(doc, mod(doc, shared.moduleId))).told).toEqual([]);
    const copies = readSidecarFromDoc(doc)!.modules!.filter((m) => sharedPlaced(m));
    expect(copies).toHaveLength(2);
    const copy = copies.find((m) => m.id !== shared.moduleId)!;
    expect(copy).toMatchObject({ name: 'Harbor crane', libraryModuleId: LIB, libraryVersion: 7 });
    expect(copy.pinned).toBeUndefined();
    expect(copy.members).toHaveLength(2);
    expect(copy.members.some((id) => shared.ids.includes(id))).toBe(false);

    // Removed whole: by its menu, and by deleting all of its parts.
    expect(attempt(doc, () => deleteModuleWithParts(doc, copy.id)).told).toEqual([]);
    expect(parts(doc).some((p) => copy.members.includes(p.id))).toBe(false);
    const r = attempt(doc, () => deleteBricksAcrossLayers(doc, new Map([[other, [a, b]]])));
    expect(r).toEqual({ changed: true, told: [] });
    expect(parts(doc).some((p) => p.id === a || p.id === b)).toBe(false);
  });

  it('leaves ordinary modules and loose parts as free as before', () => {
    const { doc, free, loose } = world();
    const [a] = free.ids as [string];
    const track = part(doc, a).sheet;
    const fine: (() => void)[] = [
      () => editBrick(doc, track, a, { partNumber: 'zzz.9' }),
      () => renameSidecarModule(doc, free.moduleId, 'Big yard'),
      () => takeOutOfModule(doc, free.moduleId, [a]),
      () => updateSidecarModule(doc, free.moduleId, (m) => ({ ...m, members: [...m.members, loose] })),
      () => enterModuleEdit(doc, free.moduleId),
      () => deleteBricks(doc, track, [a]),
      () => deleteSidecarModule(doc, free.moduleId),
      () => addSidecarModule(doc, { id: 'm9', name: 'Loose', members: [loose], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] }),
    ];
    for (const [i, fn] of fine.entries()) expect(attempt(doc, fn).told, `step ${i}`).toEqual([]);
    expect(useEditorStore.getState().editingModuleId).toBe(free.moduleId);
  });

  it('an ordinary module cannot take a shared module’s part either', () => {
    const { doc, shared, free } = world();
    const r = attempt(doc, () => updateSidecarModule(doc, free.moduleId, (m) => ({ ...m, members: [...m.members, shared.ids[0]!] })));
    expect(r).toEqual({ changed: false, told: [{ name: 'Harbor crane', what: 'members' }] });
  });

  it('says why in plain words, naming the module and who shared it', () => {
    const s = { name: 'Harbor crane', by: 'Alice' };
    expect(lockMessage(s, 'edit')).toBe('“Harbor crane” is shared by Alice, so its parts can’t be changed here. You can move it, turn it or remove it as a whole.');
    expect(lockMessage(s, 'rename')).toContain('its name is Alice’s');
    expect(lockMessage(s, 'members')).toContain('parts can’t be added to it or taken out of it');
    expect(lockMessage(s, 'dissolve')).toContain('stays one module');
    expect(lockMessage(s, 'bend')).toContain('track can’t be bent');
    // A file with no name for the owner, or an unnamed module, still reads well.
    expect(lockMessage({ name: '', by: null }, 'parts')).toBe('This module is a shared module, so its parts can’t be changed here. You can move it, turn it or remove it as a whole.');
  });

  it('tells which changes to a module’s value keep the lock', () => {
    const { doc, shared, free } = world();
    const m = mod(doc, shared.moduleId);
    expect(keepsLock(m, { ...m, pinned: true, outlineColor: '#00ff00', shared: { ...m.shared, placement: { degrees: 90, x: 1, y: 2 } } })).toBeNull();
    expect(keepsLock(m, { ...m, name: 'x' })).toBe('rename');
    expect(keepsLock(m, { ...m, members: [...m.members].reverse() })).toBe('members');
    expect(keepsLock(m, { ...m, members: [] })).toBe('members');
    expect(keepsLock(mod(doc, free.moduleId), { ...mod(doc, free.moduleId), name: 'x', members: [] })).toBeNull();
    // With `whole`, a selection holding all of a shared module is fine; part of it never is.
    expect(sharedLockOn(doc, shared.ids, true)).toBeNull();
    expect(sharedLockOn(doc, shared.ids)).toMatchObject({ name: 'Harbor crane' });
    expect(sharedLockOn(doc, [shared.ids[0]!], true)).toMatchObject({ name: 'Harbor crane' });
    expect(sharedLockOn(doc, free.ids)).toBeNull();
    expect(sharedLockOn(doc, [])).toBeNull();
  });
});
