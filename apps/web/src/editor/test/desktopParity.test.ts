// Desktop-parity behaviour of the multi-layer selection commands and the
// module commands (see references/PARITY.md, items D and E).

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import type { BbmMap } from '@cld/model';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import type { PartWire } from '../../api';
import {
  addLayer,
  addSidecarModule,
  allVisibleBrickIds,
  bricksByLayer,
  createSidecarModule,
  deleteBricks,
  deleteBricksAcrossLayers,
  ensureBrickLayer,
  groupBricksAcrossLayers,
  importBricksAsModule,
  placeBrick,
  renameLayer,
  rotateBricksAboutCentroid,
  setLayerVisible,
} from '../mutations';
import { moduleBatchesFromMap, moduleDropTranslation, placedModuleBatches } from '../moduleDrop';
import { SnapSession } from '../snapFeel';
import { LOCAL_ORIGIN } from '../useLayoutDoc';
import { rotateAroundPivots } from '../brickGeometry';

function twoLayerDoc() {
  const doc = new Y.Doc();
  const l1 = ensureBrickLayer(doc);
  const l2 = addLayer(doc, 'brick');
  const a = placeBrick(doc, l1, { partNumber: 'p', x: 0, y: 0, width: 2, height: 2 });
  const b = placeBrick(doc, l2, { partNumber: 'p', x: 10, y: 0, width: 2, height: 2 });
  return { doc, l1, l2, a, b };
}

function brick(map: BbmMap, id: string) {
  for (const l of map.layers) if (l.type === 'brick') for (const b of l.bricks) if (b.id === id) return b;
  return undefined;
}

describe('multi-layer selection commands (D)', () => {
  it('bricksByLayer groups a cross-layer selection and drops unknown ids', () => {
    const { doc, l1, l2, a, b } = twoLayerDoc();
    const by = bricksByLayer(docToBbm(doc), [b, a, 'nope']);
    expect([...by.entries()]).toEqual([[l1, [a]], [l2, [b]]]);
  });

  it('select-all takes every visible brick layer, not only the active one', () => {
    const { doc, l2, a, b } = twoLayerDoc();
    expect(allVisibleBrickIds(docToBbm(doc)).sort()).toEqual([a, b].sort());
    setLayerVisible(doc, l2, false);
    expect(allVisibleBrickIds(docToBbm(doc))).toEqual([a]);
  });

  it('rotateAroundPivots orbits pivots about their mean; one brick turns in place', () => {
    const box = (x: number) => ({ displayArea: { x: x - 1, y: -1, width: 2, height: 2 }, orientation: 0 });
    const out = rotateAroundPivots([{ brick: box(0), part: undefined }, { brick: box(10), part: undefined }], 90);
    expect(out[0]!.displayArea.x + 1).toBeCloseTo(5);
    expect(out[0]!.displayArea.y + 1).toBeCloseTo(-5);
    expect(out[1]!.displayArea.x + 1).toBeCloseTo(5);
    expect(out[1]!.displayArea.y + 1).toBeCloseTo(5);
    expect(out[0]!.orientation).toBe(90);
    const single = rotateAroundPivots([{ brick: { displayArea: { x: 2, y: 3, width: 2, height: 2 }, orientation: 0 }, part: undefined }], 45);
    expect(single[0]!.displayArea.x).toBeCloseTo(2);
    expect(single[0]!.displayArea.y).toBeCloseTo(3);
  });

  it('rotates a cross-layer selection about its centroid as one undo step', () => {
    const { doc, a, b } = twoLayerDoc();
    const um = new Y.UndoManager([doc.getMap('layerData')], { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    rotateBricksAboutCentroid(doc, bricksByLayer(docToBbm(doc), [a, b]), 90);
    const map = docToBbm(doc);
    // Centres (1,1) and (11,1) → pivot (6,1) → (6,-4) and (6,6).
    const A = brick(map, a)!;
    const B = brick(map, b)!;
    expect(A.orientation).toBe(90);
    expect(B.orientation).toBe(90);
    expect(A.displayArea.x + 1).toBeCloseTo(6);
    expect(A.displayArea.y + 1).toBeCloseTo(-4);
    expect(B.displayArea.x + 1).toBeCloseTo(6);
    expect(B.displayArea.y + 1).toBeCloseTo(6);
    um.undo();
    const back = docToBbm(doc);
    expect(brick(back, a)!.orientation).toBe(0);
    expect(brick(back, b)!.displayArea.x).toBeCloseTo(10);
  });

  it('groups a cross-layer selection with one group per layer', () => {
    const { doc, l1, a, b } = twoLayerDoc();
    const c = placeBrick(doc, l1, { partNumber: 'p', x: 4, y: 0, width: 2, height: 2 });
    const ids = groupBricksAcrossLayers(doc, bricksByLayer(docToBbm(doc), [a, b, c]));
    expect(ids).toHaveLength(2);
    const map = docToBbm(doc);
    expect(brick(map, a)!.myGroup).toBe(brick(map, c)!.myGroup);
    expect(brick(map, b)!.myGroup).not.toBe(brick(map, a)!.myGroup);
    expect(brick(map, b)!.myGroup).not.toBe('');
  });

  it('deletes across layers in one transaction', () => {
    const { doc, a, b } = twoLayerDoc();
    let txns = 0;
    doc.on('afterTransaction', () => txns++);
    deleteBricksAcrossLayers(doc, bricksByLayer(docToBbm(doc), [a, b]));
    expect(txns).toBe(1);
    expect(allVisibleBrickIds(docToBbm(doc))).toEqual([]);
  });
});

describe('modules (E)', () => {
  it('createSidecarModule registers the selection as a module', () => {
    const { doc, a, b } = twoLayerDoc();
    const id = createSidecarModule(doc, '  Station  ', [a, b, a]);
    const mods = readSidecarFromDoc(doc)?.modules ?? [];
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ id, name: 'Station', members: [a, b] });
    expect(createSidecarModule(doc, 'x', [])).toBeNull();
  });

  it('deleting bricks prunes module members and drops emptied modules', () => {
    const { doc, l1, l2, a, b } = twoLayerDoc();
    const keep: SidecarModule = { id: 'm1', name: 'keep', members: [a, b], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    const gone: SidecarModule = { id: 'm2', name: 'gone', members: [b], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    addSidecarModule(doc, keep);
    addSidecarModule(doc, gone);
    deleteBricks(doc, l2, [b]);
    const mods = readSidecarFromDoc(doc)?.modules ?? [];
    expect(mods.map((m) => m.id)).toEqual(['m1']);
    expect(mods[0]!.members).toEqual([a]);
    // Unrelated delete leaves the cache untouched.
    const before = doc.getMap('meta').get('cache');
    const c = placeBrick(doc, l1, { partNumber: 'p', x: 0, y: 0, width: 1, height: 1 });
    deleteBricks(doc, l1, [c]);
    expect(doc.getMap('meta').get('cache')).toBe(before);
  });

  it('importBricksAsModule matches layers by name, creates missing ones, and adds the module in one step', () => {
    const doc = new Y.Doc();
    const tracks = ensureBrickLayer(doc);
    renameLayer(doc, tracks, 'Tracks');
    let txns = 0;
    doc.on('afterTransaction', () => txns++);
    const res = importBricksAsModule(
      doc,
      [
        { layerName: 'Tracks', bricks: [{ partNumber: 't', displayArea: { x: 0, y: 0, width: 4, height: 2 } }] },
        { layerName: 'Scenery', bricks: [{ partNumber: 's', displayArea: { x: 0, y: 4, width: 2, height: 2 } }] },
      ],
      { name: 'Yard', offset: { dx: 10, dy: 0 }, sourceFile: 'yard.bbm' },
    )!;
    expect(txns).toBe(1);
    const map = docToBbm(doc);
    const names = map.layers.filter((l) => l.type === 'brick').map((l) => l.name);
    expect(names).toEqual(['Tracks', 'Scenery']);
    const byLayer = bricksByLayer(map, res.ids);
    expect(byLayer.get(tracks)).toHaveLength(1);
    expect(brick(map, res.ids[0]!)!.displayArea.x).toBe(10);
    const mod = (readSidecarFromDoc(doc)?.modules ?? [])[0]!;
    expect(mod).toMatchObject({ id: res.moduleId, name: 'Yard', members: res.ids, sourceFile: 'yard.bbm' });
  });
});

describe('module drop placement (E)', () => {
  const part = (connections: PartWire['connections']): PartWire => ({
    key: 'trk.0', partNumber: 'TRK', colorCode: '0', kind: 'leaf', description: '', sortingKey: '',
    spritePath: '', pxPerStud: 8, category: '', connections, subparts: [], hullPts: [],
    source: 'bundled', customPartId: null,
  });

  it('centres the module under the cursor and puts its lead part on the grid', () => {
    const batches = [{ layerName: 'L', bricks: [
      { partNumber: 'x', displayArea: { x: -3, y: -1, width: 3, height: 2 } },
      { partNumber: 'x', displayArea: { x: 0, y: -1, width: 3, height: 2 } },
    ] }];
    // Centroid (0,0); the lead (first) part's corner (-3,-1).
    expect(moduleDropTranslation(batches, { x: 5.2, y: 7.9 }, 0, null, null)).toEqual({ dx: 5.2, dy: 7.9 });
    const t = moduleDropTranslation(batches, { x: 5.2, y: 7.9 }, 1, null, null);
    // Under the cursor its corner is at (2.2, 6.9): on the nearest stud, (2, 7).
    expect(t.dx).toBeCloseTo(5);
    expect(t.dy).toBeCloseTo(8);
  });

  it('shifts the module onto a nearby free host connection', () => {
    const trk = part([{ type: '1', x: -4, y: 0, angle: 180, electricPlug: 0 }, { type: '1', x: 4, y: 0, angle: 0, electricPlug: 0 }]);
    const partsByKey = new Map([['trk.0', trk]]);
    const doc = new Y.Doc();
    const l = ensureBrickLayer(doc);
    placeBrick(doc, l, { partNumber: 'trk.0', x: 0, y: 0, width: 8, height: 2 }); // right end at (8,1)
    const host = docToBbm(doc);
    const batches = [{ layerName: 'L', bricks: [{ partNumber: 'trk.0', displayArea: { x: -4, y: -1, width: 8, height: 2 } }] }];
    // Dropped centre (13, 1.5): its left end at (9, 1.5) — 1.1 studs off.
    const t = moduleDropTranslation(batches, { x: 13, y: 1.5 }, 0, host, partsByKey, { reach: 4 });
    expect(t.dx).toBeCloseTo(12);
    expect(t.dy).toBeCloseTo(1);
  });

  it('turns a module as a whole to face an end at any angle', () => {
    const trk = part([{ type: '1', x: -4, y: 0, angle: 180, electricPlug: 0 }, { type: '1', x: 4, y: 0, angle: 0, electricPlug: 0 }]);
    const partsByKey = new Map([['trk.0', trk]]);
    const host = (orientation: number) => {
      const doc = new Y.Doc();
      const l = ensureBrickLayer(doc);
      // A straight turned `orientation` about (4, 1): its free end at (4 + 4cos, 1 + 4sin).
      placeBrick(doc, l, { partNumber: 'trk.0', x: 0, y: 0, width: 8, height: 2, orientation });
      return docToBbm(doc);
    };
    const batches = [{ layerName: 'L', bricks: [{ partNumber: 'trk.0', displayArea: { x: -4, y: -1, width: 8, height: 2 } }] }];
    const r = (deg: number) => (deg * Math.PI) / 180;
    // Host turned 45: its right end faces 45; the module's left end faces 180 → turn 45.
    const end45 = { x: 4 + 4 * Math.cos(r(45)), y: 1 + 4 * Math.sin(r(45)) };
    const drop = moduleDropTranslation(batches, { x: end45.x + 4.3, y: end45.y }, 0, host(45), partsByKey, { reach: 1 });
    expect(drop.turn?.degrees).toBeCloseTo(45);
    const placed = placedModuleBatches(batches, drop, partsByKey)[0]!.bricks[0]!;
    expect(placed.orientation).toBeCloseTo(45);
    // Its left end lands on the host's end.
    const c = { x: placed.displayArea.x + placed.displayArea.width / 2, y: placed.displayArea.y + placed.displayArea.height / 2 };
    expect(c.x - 4 * Math.cos(r(45))).toBeCloseTo(end45.x);
    expect(c.y - 4 * Math.sin(r(45))).toBeCloseTo(end45.y);
    // Host turned 135: a 135 degree turn joins too.
    const end135 = { x: 4 + 4 * Math.cos(r(135)), y: 1 + 4 * Math.sin(r(135)) };
    const far = moduleDropTranslation(batches, { x: end135.x + 4.3, y: end135.y }, 0, host(135), partsByKey, { reach: 1 });
    expect(far.turn?.degrees).toBeCloseTo(135);
    expect(far.ringStudX).toBeCloseTo(end135.x);
  });

  it('snaps a module with the same feel: reach, hold, Alt, the drop', () => {
    const trk = part([{ type: '1', x: -4, y: 0, angle: 180, electricPlug: 0 }, { type: '1', x: 4, y: 0, angle: 0, electricPlug: 0 }]);
    const partsByKey = new Map([['trk.0', trk]]);
    const doc = new Y.Doc();
    const l = ensureBrickLayer(doc);
    placeBrick(doc, l, { partNumber: 'trk.0', x: 0, y: 0, width: 8, height: 2 }); // right end at (8,1)
    const host = docToBbm(doc);
    const batches = [{ layerName: 'L', bricks: [{ partNumber: 'trk.0', displayArea: { x: -4, y: -1, width: 8, height: 2 } }] }];
    // Centre x 12 + gap: the module's left end is `gap` studs off the host's right end.
    const drop = (gap: number, snap: Parameters<typeof moduleDropTranslation>[5]) =>
      moduleDropTranslation(batches, { x: 12 + gap, y: 1 }, 0, host, partsByKey, snap);
    expect(drop(1.2, { reach: 1 }).dx).toBeCloseTo(13.2);
    expect(drop(0.8, { reach: 1, bypass: true }).dx).toBeCloseTo(12.8);
    const session = new SnapSession();
    const first = drop(0.8, { reach: 1, session });
    expect(first.dx).toBeCloseTo(12);
    expect(first.ringStudX).toBeCloseTo(8);
    expect(drop(1.5, { reach: 1, session }).dx).toBeCloseTo(12);
    expect(drop(1.7, { reach: 1, session }).dx).toBeCloseTo(13.7);
    const fast = new SnapSession();
    fast.sample(0, 0, 0);
    fast.sample(100, 0, 10);
    expect(drop(0.5, { reach: 1, session: fast }).dx).toBeCloseTo(12.5);
    expect(drop(0.5, { reach: 1, session: fast, final: true }).dx).toBeCloseTo(12);
  });

  it('moduleBatchesFromMap keeps one batch per non-empty brick layer', () => {
    const doc = new Y.Doc();
    const l1 = ensureBrickLayer(doc);
    addLayer(doc, 'brick');
    placeBrick(doc, l1, { partNumber: 'p', x: 0, y: 0, width: 1, height: 1 });
    const batches = moduleBatchesFromMap(docToBbm(doc));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.bricks).toHaveLength(1);
  });
});
