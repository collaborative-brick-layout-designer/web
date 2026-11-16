// A placed module and its Module library copy: the link (and older builds'
// links), what the menus offer, where a library version goes on the map
// (turned and moved like the placed copy), whether the placed copy was
// changed, and Update from Module library end to end (each part on its sheet,
// asking only when the module was changed in this layout).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import type { Brick } from '@cld/model';
import type { ModuleSummary } from '../../api';
import { addLayer, ensureBrickLayer, importBricksAsModule, moveBrick, placeBrick, renameLayer, type ModuleBatch } from '../mutations';
import {
  alignToPlaced,
  batchesFromBytes,
  libraryLink,
  libraryNote,
  libraryState,
  matchesVersion,
  moduleContents,
  placeVersion,
  placedParts,
  pullFromLibrary,
  sheetForUpdate,
} from '../moduleLibrary';

const ID = '11111111-1111-4111-8111-111111111111';
const summary = (o: Partial<ModuleSummary>): ModuleSummary => ({
  id: ID, title: 'Yard', ownerUserId: 'u', ownerOrgId: null, docVersion: 1, hasSidecar: false, createdAt: 0, updatedAt: 0, ...o,
});

describe('libraryLink', () => {
  it('reads the link, and the Module library id older builds kept in sourceFile', () => {
    expect(libraryLink({ libraryModuleId: ID, libraryVersion: 3 })).toEqual({ id: ID, version: 3 });
    expect(libraryLink({ libraryModuleId: ID })).toEqual({ id: ID, version: null });
    expect(libraryLink({ sourceFile: ID })).toEqual({ id: ID, version: null });
    expect(libraryLink({ sourceFile: `https://bricks.example/modules/${ID}` })).toEqual({ id: ID, version: null });
    expect(libraryLink({ sourceFile: 'C:/modules/yard.bbm' })).toBeNull();
    expect(libraryLink({ libraryModuleId: 'not an id' })).toBeNull();
    expect(libraryLink({})).toBeNull();
  });
});

describe('libraryState', () => {
  it('says unlinked, gone, up to date or newer, and whether you may publish', () => {
    expect(libraryState({}, [])).toEqual({ kind: 'unlinked' });
    expect(libraryState({ libraryModuleId: ID }, [])).toEqual({ kind: 'missing', id: ID });
    const same = libraryState({ libraryModuleId: ID, libraryVersion: 3 }, [summary({ latestVersion: 3, role: 'owner' })]);
    expect(same).toMatchObject({ kind: 'linked', newer: false, canPublish: true, latest: 3 });
    expect(libraryNote(same)).toBe('in the Module library v3');
    const newer = libraryState({ libraryModuleId: ID, libraryVersion: 3 }, [summary({ latestVersion: 5, role: 'viewer' })]);
    expect(newer).toMatchObject({ kind: 'linked', newer: true, canPublish: false });
    expect(libraryNote(newer)).toBe('in the Module library v3 · v5 is newer');
    // An unknown version: the Module library's may be newer.
    expect(libraryState({ sourceFile: ID }, [summary({ latestVersion: 1 })])).toMatchObject({ newer: true });
    expect(libraryNote({ kind: 'missing', id: ID })).toBe('its Module library copy is gone');
  });
});

/** A library version's contents from parts at (x, y) on sheet `sheet`. */
function version(parts: { pn: string; x: number; y: number }[], sheet = 'Track'): Uint8Array {
  const doc = new Y.Doc();
  const l = ensureBrickLayer(doc);
  renameLayer(doc, l, sheet);
  const ids = parts.map((p) => placeBrick(doc, l, { partNumber: p.pn, x: p.x, y: p.y, width: 2, height: 2 }));
  return moduleContents(docToBbm(doc), ids)!.bytes;
}

const centre = (b: Pick<Brick, 'displayArea'>) => ({ x: b.displayArea.x + b.displayArea.width / 2, y: b.displayArea.y + b.displayArea.height / 2 });

describe('where a library version goes', () => {
  const v1 = () => batchesFromBytes(version([{ pn: 'a', x: 0, y: 0 }, { pn: 'b', x: 10, y: 0 }, { pn: 'b', x: 10, y: 10 }]));

  it('finds the turn and the shift of the placed copy, and the copy matches', () => {
    const lib = v1();
    const placed = placeVersion(lib, { degrees: 90, x: 100.0123, y: 50.0371 }, null)[0]!.bricks as Brick[];
    const p = alignToPlaced(lib, placed, null);
    expect(p.degrees).toBe(90);
    expect(p.x).toBeCloseTo(100.0123, 6);
    expect(p.y).toBeCloseTo(50.0371, 6);
    expect(p.matched).toBe(3);
    expect(matchesVersion(lib, placed, null)).toBe(true);
  });

  it('still finds it when a part was changed, and then says the copy was changed', () => {
    const lib = v1();
    const placed = placeVersion(lib, { degrees: 180, x: -20, y: 7 }, null)[0]!.bricks.map((b) => ({ ...b })) as Brick[];
    placed[2] = { ...placed[2]!, displayArea: { ...placed[2]!.displayArea, x: placed[2]!.displayArea.x + 3 } };
    const p = alignToPlaced(lib, placed, null);
    expect(p).toMatchObject({ degrees: 180, matched: 2 });
    expect(p.x).toBeCloseTo(-20);
    expect(p.y).toBeCloseTo(7);
    expect(matchesVersion(lib, placed, null)).toBe(false);
    expect(matchesVersion(lib, placed.slice(0, 2), null)).toBe(false);
  });

  it('with nothing alike, puts the middle on the middle, unturned', () => {
    const lib = v1();
    const other = [{ id: 'x', partNumber: 'zzz', displayArea: { x: 49, y: 49, width: 2, height: 2 }, orientation: 30 }] as Brick[];
    expect(alignToPlaced(lib, other, null)).toMatchObject({ degrees: 0, matched: 0 });
    const p = alignToPlaced(lib, other, null);
    const mid = lib[0]!.bricks.map(centre).reduce((a, c) => ({ x: a.x + c.x / 3, y: a.y + c.y / 3 }), { x: 0, y: 0 });
    expect(p.x + mid.x).toBeCloseTo(50);
    expect(p.y + mid.y).toBeCloseTo(50);
  });
});

describe('sheetForUpdate', () => {
  it('keeps each part on its sheet: same name first, else where most of the module is', () => {
    const doc = new Y.Doc();
    const track = addLayer(doc, 'brick');
    renameLayer(doc, track, 'Track');
    const scenery = addLayer(doc, 'brick');
    renameLayer(doc, scenery, 'Scenery');
    const ids = [
      placeBrick(doc, scenery, { partNumber: 'a', x: 0, y: 0, width: 2, height: 2 }),
      placeBrick(doc, scenery, { partNumber: 'a', x: 2, y: 0, width: 2, height: 2 }),
      placeBrick(doc, track, { partNumber: 'a', x: 4, y: 0, width: 2, height: 2 }),
    ];
    const pick = sheetForUpdate(docToBbm(doc), ids, track);
    expect(pick(' track ')).toBe(track);
    expect(pick('Scenery')).toBe(scenery);
    expect(pick('Buildings')).toBe(scenery);
  });
});

describe('Update from Module library', () => {
  const v1 = version([{ pn: 'a', x: 0, y: 0 }, { pn: 'b', x: 10, y: 0 }]);
  const v2 = version([{ pn: 'a', x: 0, y: 0 }, { pn: 'b', x: 10, y: 0 }, { pn: 'c', x: 20, y: 0 }]);
  let latest: number;

  beforeEach(() => {
    latest = 2;
    vi.stubGlobal('fetch', async (input: string) => {
      const bytes = (b: Uint8Array) => new Response(b as unknown as BodyInit, { status: 200 });
      if (input === `/api/modules/${ID}`)
        return new Response(JSON.stringify({ module: summary({ latestVersion: latest }), role: 'owner' }), { status: 200 });
      if (input === `/api/modules/${ID}/snapshot`) return bytes(latest === 2 ? v2 : v1);
      if (input === `/api/modules/${ID}/versions/1/snapshot`) return bytes(v1);
      return new Response('{}', { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A layout with version 1 placed turned 90° at (100, 50), on the "Track" sheet, after a "Scenery" sheet. */
  function layout() {
    const doc = new Y.Doc();
    const scenery = addLayer(doc, 'brick');
    renameLayer(doc, scenery, 'Scenery');
    const track = addLayer(doc, 'brick');
    renameLayer(doc, track, 'Track');
    const placed = placeVersion(batchesFromBytes(v1), { degrees: 90, x: 100, y: 50 }, null);
    const res = importBricksAsModule(doc, placed as ModuleBatch[], { name: 'Yard', library: { id: ID, version: 1 } })!;
    const mod = () => readSidecarFromDoc(doc)!.modules!.find((m) => m.id === res.moduleId)!;
    return { doc, track, scenery, moduleId: res.moduleId, mod };
  }

  it('brings the newer version in where the module sits, turned like it, without asking when unchanged', async () => {
    const { doc, track, moduleId, mod } = layout();
    const before = placedParts(docToBbm(doc), mod().members).map((b) => ({ pn: b.partNumber, ...centre(b) }));
    const confirm = vi.fn(async () => true);
    expect(await pullFromLibrary(doc, moduleId, { parts: null, activeLayerId: null, confirm })).toBe('updated');
    expect(confirm).not.toHaveBeenCalled();
    const map = docToBbm(doc);
    const after = placedParts(map, mod().members);
    expect(after).toHaveLength(3);
    expect(mod()).toMatchObject({ name: 'Yard', libraryModuleId: ID, libraryVersion: 2 });
    // The parts it had stay put; the new one is 10 studs further along, turned.
    for (const b of before) {
      const same = after.find((a) => a.partNumber === b.pn)!;
      expect(centre(same).x).toBeCloseTo(b.x);
      expect(centre(same).y).toBeCloseTo(b.y);
    }
    const bPart = before.find((b) => b.pn === 'b')!;
    const c = after.find((a) => a.partNumber === 'c')!;
    expect(centre(c).x).toBeCloseTo(bPart.x);
    expect(centre(c).y).toBeCloseTo(bPart.y + 10);
    expect(c.orientation).toBe(90);
    // On its sheet.
    const trackLayer = map.layers.find((l) => l.id === track)!;
    expect(trackLayer.type === 'brick' && trackLayer.bricks).toHaveLength(3);
  });

  it('asks first when the module was changed here; No keeps it as it is', async () => {
    const { doc, track, moduleId, mod } = layout();
    const first = mod().members[0]!;
    moveBrick(doc, track, first, 0, 0);
    const confirm = vi.fn(async () => false);
    expect(await pullFromLibrary(doc, moduleId, { parts: null, activeLayerId: null, confirm })).toBe('cancelled');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mod()).toMatchObject({ libraryVersion: 1 });
    expect(mod().members).toContain(first);
  });

  it('says up to date when the Module library has nothing newer', async () => {
    latest = 1;
    const { doc, moduleId } = layout();
    expect(await pullFromLibrary(doc, moduleId, { parts: null, activeLayerId: null, confirm: async () => true })).toBe('up-to-date');
  });
});
