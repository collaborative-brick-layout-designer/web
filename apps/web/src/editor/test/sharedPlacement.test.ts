// A shared module's placement follows it (sharedPlacement.ts, mutations.ts
// keepingPlacements): moved, turned or put on another sheet as a whole, by
// whichever tool, its `shared.placement` still puts the owner's version
// exactly on its parts, in the same undo step. Anything that isn't a move
// of the whole module leaves the placement alone.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import { partsInPlace, readPlacement, type Placement } from '@cld/modules';
import {
  addLayer,
  ensureBrickLayer,
  importBricksAsModule,
  keepingPlacements,
  moveBrick,
  moveBricksToLayer,
  moveModuleBricks,
  rotateModuleBricks,
  rotateSelection,
  translateBricksAcrossLayers,
  type ModuleBatch,
} from '../mutations';
import { LOCAL_ORIGIN } from '../useLayoutDoc';
import { followedPlacement, type PartPose } from '../sharedPlacement';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const BATCHES: ModuleBatch[] = [
  {
    layerName: 'Track',
    bricks: [
      { partNumber: 'a.1', displayArea: { x: 0, y: 0, width: 2, height: 2 } },
      { partNumber: 'b.1', displayArea: { x: 8, y: 0, width: 4, height: 2 }, orientation: 30 },
    ],
  },
  { layerName: 'Scenery', bricks: [{ partNumber: 'c.1', displayArea: { x: 2, y: 6, width: 2, height: 2 } }] },
];
const noPart = () => undefined;

function world() {
  const doc = new Y.Doc();
  ensureBrickLayer(doc);
  const placed = importBricksAsModule(doc, BATCHES, {
    name: 'Harbor crane',
    offset: { dx: 100, dy: 50 },
    library: { id: LIB, version: 3, shared: { by: 'Alice', placement: { degrees: 0, x: 0, y: 0 } } },
  })!;
  const other = importBricksAsModule(doc, BATCHES, { name: 'Yard', offset: { dx: -200, dy: 0 }, library: { id: LIB, version: 3 } })!;
  return { doc, placed, other };
}

const mod = (doc: Y.Doc, id: string) => readSidecarFromDoc(doc)!.modules!.find((m) => m.id === id) as SidecarModule & { shared?: Record<string, unknown> };
const placementOf = (doc: Y.Doc, id: string): Placement => readPlacement(mod(doc, id).shared!.placement)!;
const partsOf = (doc: Y.Doc, ids: readonly string[]) =>
  docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks.filter((b) => ids.includes(b.id)).map((b) => ({ ...b, sheet: l.id })) : []));
/** Every part of the module is where the placement puts the owner's version. */
const fits = (doc: Y.Doc, id: string) => partsInPlace(BATCHES, partsOf(doc, mod(doc, id).members), placementOf(doc, id), noPart) === 3;
const byLayer = (doc: Y.Doc, ids: readonly string[]) => {
  const out = new Map<string, string[]>();
  for (const p of partsOf(doc, ids)) out.set(p.sheet, [...(out.get(p.sheet) ?? []), p.id]);
  return out;
};

describe('a shared module’s placement follows it', () => {
  it('starts where it was placed', () => {
    const { doc, placed } = world();
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ degrees: 0, x: 100, y: 50 });
    expect(fits(doc, placed.moduleId)).toBe(true);
  });

  it('moved as a whole, from the Modules panel or a drag', () => {
    const { doc, placed } = world();
    moveModuleBricks(doc, placed.ids, 12, -4);
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ degrees: 0, x: 112, y: 46 });
    translateBricksAcrossLayers(doc, byLayer(doc, placed.ids), 0.5, 3);
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ degrees: 0, x: 112.5, y: 49 });
    expect(fits(doc, placed.moduleId)).toBe(true);
  });

  it('turned as a whole, by a quarter or any angle, about any point', () => {
    const { doc, placed } = world();
    rotateModuleBricks(doc, placed.ids, 90, noPart);
    expect(placementOf(doc, placed.moduleId).degrees).toBeCloseTo(90, 9);
    expect(fits(doc, placed.moduleId)).toBe(true);
    rotateSelection(doc, byLayer(doc, placed.ids), { texts: [], rulers: [] }, 22.5, noPart);
    expect(placementOf(doc, placed.moduleId).degrees).toBeCloseTo(112.5, 9);
    expect(fits(doc, placed.moduleId)).toBe(true);
    rotateSelection(doc, byLayer(doc, placed.ids), { texts: [], rulers: [] }, -112.5, noPart);
    expect(placementOf(doc, placed.moduleId).degrees).toBeCloseTo(0, 6);
    expect(fits(doc, placed.moduleId)).toBe(true);
  });

  it('put on another sheet: its version’s sheet goes there', () => {
    const { doc, placed } = world();
    const before = placementOf(doc, placed.moduleId).sheets!;
    const other = addLayer(doc, 'brick');
    const track = partsOf(doc, placed.ids).filter((p) => p.sheet === before.Track).map((p) => p.id);
    // The whole module goes, so the lock lets it; only the Track sheet's parts change sheet.
    moveBricksToLayer(doc, byLayer(doc, placed.ids), other);
    const after = placementOf(doc, placed.moduleId);
    expect(after.sheets).toEqual({ Track: other, Scenery: other });
    expect(after).toMatchObject({ degrees: 0, x: 100, y: 50 });
    expect(track.length).toBe(2);
  });

  it('one undo takes back the move and the placement together', () => {
    const { doc, placed } = world();
    const undo = new Y.UndoManager([doc.getMap('layerData'), doc.getMap('sidecarItems'), doc.getMap('meta')], { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    moveModuleBricks(doc, placed.ids, 10, 10);
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ x: 110, y: 60 });
    undo.undo();
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ x: 100, y: 50 });
    expect(fits(doc, placed.moduleId)).toBe(true);
  });

  it('a move of only some of its parts, or of other modules, leaves it alone', () => {
    const { doc, placed, other } = world();
    const first = partsOf(doc, [placed.ids[0]!])[0]!;
    moveBrick(doc, first.sheet, first.id, 500, 500);
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ degrees: 0, x: 100, y: 50 });
    moveModuleBricks(doc, other.ids, 40, 40);
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ degrees: 0, x: 100, y: 50 });
    expect(mod(doc, other.moduleId).shared).toBeUndefined();
  });

  it('steps inside one step are counted once, as one move', () => {
    const { doc, placed } = world();
    keepingPlacements(doc, () => {
      moveModuleBricks(doc, placed.ids, 5, 0);
      moveModuleBricks(doc, placed.ids, 5, 0);
    });
    expect(placementOf(doc, placed.moduleId)).toMatchObject({ x: 110, y: 50 });
    expect(fits(doc, placed.moduleId)).toBe(true);
  });
});

describe('followedPlacement', () => {
  const pose = (x: number, y: number, o = 0, layer = 'L'): PartPose => ({ at: { x, y }, o, layer });
  const p: Placement = { degrees: 0, x: 10, y: 0, sheets: { Track: 'L' } };

  it('nothing moved: nothing to change', () => {
    const before = new Map([['a', pose(0, 0)], ['b', pose(4, 0)]]);
    expect(followedPlacement(p, before, new Map(before))).toBeNull();
  });

  it('parts that moved apart are not a move of the module', () => {
    const before = new Map([['a', pose(0, 0)], ['b', pose(4, 0)]]);
    expect(followedPlacement(p, before, new Map([['a', pose(1, 0)], ['b', pose(4, 0)]]))).toBeNull();
    expect(followedPlacement(p, before, new Map([['a', pose(0, 0, 90)], ['b', pose(4, 0)]]))).toBeNull();
    expect(followedPlacement(p, before, new Map([['a', pose(0, 0)]]))).toBeNull();
  });

  it('a turn about the module’s middle', () => {
    const before = new Map([['a', pose(0, 0)], ['b', pose(4, 0)]]);
    // Turned 180° about (2, 0).
    const next = followedPlacement(p, before, new Map([['a', pose(4, 0, 180)], ['b', pose(0, 0, 180)]]))!;
    expect(next.degrees).toBeCloseTo(180, 9);
    expect(next.x).toBeCloseTo(-6, 9);
    expect(next.y).toBeCloseTo(0, 9);
    expect(next.sheets).toEqual({ Track: 'L' });
  });
});
