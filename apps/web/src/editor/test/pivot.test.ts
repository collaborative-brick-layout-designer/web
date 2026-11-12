// BlueBrick pivot geometry in the editor (G1): a part with a <hull> has
// its sprite centre — the pivot — off its displayArea centre, and
// placement, rotation, snapping, connections, labels, rulers and the
// marquee all work from the pivot (desktop BrickPlacement.h).

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { AnchoredLabel } from '@cld/bbm';
import type { BbmMap, Brick } from '@cld/model';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import type { PartWire } from '../../api';
import { areaForPivot, connectionWorld, pivotOf, rotateAroundPivots, staleAreaFix } from '../brickGeometry';
import { moveBrick, moveBrickAndOrient, placeBrick, rotateBricksAboutCentroid } from '../mutations';
import { buildLabelIndex, labelAnchorStuds } from '../mixedSelection';
import { bricksInMarquee } from '../render/marqueeMath';
import { electricOverlay } from '../render/electricCircuits';
import { freeConnectionsCached, nearestConnectionIndex, snapPlacement } from '../snap';
import { fixStaleAreasInDoc, watchPartChanges } from '../useConnectivity';

// A 4 x 2 stud sprite (32 x 16 px) whose <hull> is its left half: the
// displayArea is that 2 x 2 box and the sprite centre sits 1 stud right of
// it. One rail connection on the sprite's right edge, one on its left.
const HULL = {
  key: 'hull.1',
  partNumber: 'hull',
  colorCode: '1',
  kind: 'leaf',
  pxPerStud: 8,
  spriteSize: { w: 32, h: 16 },
  hullPts: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 15 }],
  connections: [
    { type: '1', x: -2, y: 0, angle: 180, electricPlug: 1 },
    { type: '1', x: 2, y: 0, angle: 0, electricPlug: -1 },
  ],
  subparts: [],
} as unknown as PartWire;
const parts = new Map([['hull.1', HULL]]);
const partOf = (pn: string) => parts.get(pn.toLowerCase());

/** The hull brick with its pivot at (px, py). */
function hullBrick(id: string, px: number, py: number, orientation = 0): Brick {
  const area = areaForPivot(HULL, orientation, { x: px, y: py });
  return {
    id,
    partNumber: 'hull.1',
    displayArea: area,
    orientation,
    myGroup: '',
    activeConnectionPointIndex: 0,
    altitude: 0,
    connexions: [
      { id: `${id}_0`, linkedTo: '' },
      { id: `${id}_1`, linkedTo: '' },
    ],
  };
}

function mapOf(bricks: Brick[]): BbmMap {
  return { layers: [{ type: 'brick', id: 'L', name: 'Tracks', visible: true, bricks, groups: [] }] } as unknown as BbmMap;
}

const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 4);
  expect(p.y).toBeCloseTo(y, 4);
};

describe('pivot and box', () => {
  it('the box is the hull footprint, the pivot sits off its centre', () => {
    const b = hullBrick('a', 10, 5);
    expect(b.displayArea).toEqual({ x: 8, y: 4, width: 2, height: 2 });
    close(pivotOf(b, HULL), 10, 5);
    // Without the part the pivot falls back to the box centre.
    close(pivotOf(b, undefined), 9, 5);
  });

  it('connections hang off the pivot', () => {
    const b = hullBrick('a', 10, 5);
    close(connectionWorld(b, HULL, 1), 12, 5);
    close(connectionWorld(b, HULL, 0), 8, 5);
  });

  it('one brick turns in place around its pivot, the box following the turned hull', () => {
    const b = hullBrick('a', 10, 5);
    const [turned] = rotateAroundPivots([{ brick: b, part: HULL }], 90);
    expect(turned!.orientation).toBe(90);
    const after = { displayArea: turned!.displayArea, orientation: 90 };
    close(pivotOf(after, HULL), 10, 5);
    // The hull (left half) now lies above the pivot: box centre (10, 4).
    close({ x: turned!.displayArea.x + 1, y: turned!.displayArea.y + 1 }, 10, 4);
  });

  it('a box of the wrong size is resized around its old centre; a right one is left alone', () => {
    const b = hullBrick('a', 10, 5);
    expect(staleAreaFix(b, HULL)).toBeNull();
    // An earlier build kept the sprite size (4 x 2) and drew the sprite at the box centre (10, 5).
    const stale = { displayArea: { x: 8, y: 4, width: 4, height: 2 }, orientation: 0 };
    const fixed = staleAreaFix(stale, HULL)!;
    expect(fixed).toEqual({ x: 8, y: 4, width: 2, height: 2 });
    close(pivotOf({ displayArea: fixed, orientation: 0 }, HULL), 10, 5);
  });
});

describe('mutations work from the pivot', () => {
  function docWith(pivotX: number, pivotY: number) {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const a = areaForPivot(HULL, 0, { x: pivotX, y: pivotY });
    const id = placeBrick(doc, layerId, { partNumber: 'hull.1', x: a.x, y: a.y, width: a.width, height: a.height });
    const get = () => docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : [])).find((b) => b.id === id)!;
    return { doc, layerId, id, get };
  }

  it('rotate turns the selection around its pivot and resizes the box', () => {
    const { doc, layerId, id, get } = docWith(10, 5);
    rotateBricksAboutCentroid(doc, new Map([[layerId, [id]]]), 90, partOf);
    const b = get();
    expect(b.orientation).toBe(90);
    close(pivotOf(b, HULL), 10, 5);
    expect(b.displayArea.width).toBeCloseTo(2, 4);
    expect(b.displayArea.height).toBeCloseTo(2, 4);
  });

  it('move and move-and-orient put the pivot where asked', () => {
    const { doc, layerId, id, get } = docWith(10, 5);
    moveBrick(doc, layerId, id, 20, 30, HULL);
    close(pivotOf(get(), HULL), 20, 30);
    moveBrickAndOrient(doc, layerId, id, 0, 0, 180, HULL);
    const b = get();
    expect(b.orientation).toBe(180);
    close(pivotOf(b, HULL), 0, 0);
    // Turned 180°, the hull is right of the pivot.
    expect(b.displayArea).toMatchObject({ width: 2, height: 2 });
    expect(b.displayArea.x).toBeCloseTo(0, 4);
  });
});

describe('snapping and picking from the pivot', () => {
  it('free connections of placed bricks are measured from their pivot', () => {
    const map = mapOf([hullBrick('a', 10, 5)]);
    const conns = freeConnectionsCached(map, parts);
    expect(conns.map((c) => [Math.round(c.x * 1000) / 1000, c.y])).toEqual([[8, 5], [12, 5]]);
  });

  it('on the grid, a new part is held by its box, not its pivot', () => {
    const r = snapPlacement(
      { part: { ...HULL, connections: [] }, centreX: 10.3, centreY: 5.2, orientation: 0, width: 2, height: 2, pivotOffsetX: 1, pivotOffsetY: 0, snapStepStuds: 1, reach: 3 },
      mapOf([]),
      parts,
    );
    // As BlueBrick drops a part: the box's middle at the cursor puts its
    // corner at (9.3, 4.2), a step up and left of it, so (9, 4); the pivot
    // is the corner + (1, 1) + (1, 0).
    expect([r.centreX, r.centreY]).toEqual([11, 5]);
  });

  it('the grabbed connection is the one nearest the click, from the pivot', () => {
    const b = hullBrick('a', 10, 5);
    // x = 11.5 is nearer the right connection (12) measured from the pivot;
    // from the box centre (9) the connections would sit at 7 and 11.
    expect(nearestConnectionIndex(b, HULL, 11.5, 5)).toBe(1);
    expect(nearestConnectionIndex(b, HULL, 8.5, 5)).toBe(0);
  });
});

describe('annotations and overlays follow the pivot', () => {
  it('a Brick label anchors on the pivot when the catalog is known', () => {
    const map = mapOf([hullBrick('a', 10, 5)]);
    const label = { id: 'l', kind: 1, targetId: 'a', offset: { x: 0, y: 0 } } as unknown as AnchoredLabel;
    close(labelAnchorStuds(label, buildLabelIndex(map, [], parts)), 10, 5);
    close(labelAnchorStuds(label, buildLabelIndex(map, [])), 9, 5);
  });

  it('the marquee tests the sprite around the pivot', () => {
    const b = hullBrick('a', 10, 5);
    // The sprite spans x 8..12; a marquee over x 11.2..11.8 only touches it
    // when the shape is centred on the pivot (box-centred it ends at 11).
    const marquee = { x0: 11.2, y0: 4, x1: 11.8, y1: 6 };
    const sprite = () => ({ w: 4, h: 2 });
    expect(bricksInMarquee(marquee, [b], sprite, (x) => pivotOf(x, HULL))).toEqual(['a']);
    expect(bricksInMarquee(marquee, [b], sprite)).toEqual([]);
  });

  it('electric rails run between the pivot-relative connection points', () => {
    const { strokes } = electricOverlay(mapOf([hullBrick('a', 10, 5)]), parts);
    const xs = strokes.flatMap((l) => l.points.filter((_, i) => i % 2 === 0)).map((x) => Math.round(x / 8));
    expect(Math.min(...xs)).toBe(8);
    expect(Math.max(...xs)).toBe(12);
  });
});

describe('stale boxes are repaired in the doc', () => {
  it('resizes only bricks whose box does not match, outside the undo stack', () => {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    placeBrick(doc, layerId, { partNumber: 'hull.1', x: 8, y: 4, width: 4, height: 2 });
    const good = areaForPivot(HULL, 0, { x: 30, y: 5 });
    placeBrick(doc, layerId, { partNumber: 'hull.1', x: good.x, y: good.y, width: good.width, height: good.height });
    placeBrick(doc, layerId, { partNumber: 'unknown.1', x: 0, y: 0, width: 7, height: 3 });
    const um = new Y.UndoManager([doc.getMap('layerData')]);
    expect(fixStaleAreasInDoc(doc, parts)).toBe(1);
    const bricks = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []));
    expect(bricks.map((b) => b.displayArea)).toEqual([
      { x: 8, y: 4, width: 2, height: 2 },
      good,
      { x: 0, y: 0, width: 7, height: 3 },
    ]);
    expect(um.undoStack.length).toBe(0);
    expect(fixStaleAreasInDoc(doc, parts)).toBe(0);
  });

  // After someone else's edit only the parts it changed are looked at: on
  // 7,520 parts each look through them all took about 34 ms at 4x slowed CPU.
  it("after someone else's edits, looks only at the parts they changed", () => {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const good = areaForPivot(HULL, 0, { x: 30, y: 5 });
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push(placeBrick(doc, layerId, { partNumber: 'hull.1', x: good.x + i * 4, y: good.y, width: good.width, height: good.height }));
    const changes = watchPartChanges(doc);
    // The first time: all of them.
    expect(changes.take()).toBeNull();
    expect(changes.take()).toEqual({ bricks: new Set() });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerBricks = () => {
      const data = peer.getMap('layerData').get(layerId) as Y.Map<unknown>;
      return data.get('bricks') as Y.Array<Y.Map<unknown>>;
    };
    peer.on('update', (u: Uint8Array) => Y.applyUpdate(doc, u, 'remote'));
    // A part given a stale box, one moved, one added with a stale box.
    peer.transact(() => peerBricks().get(5).set('displayArea', { x: 1, y: 1, width: 4, height: 2 }));
    peer.transact(() => peerBricks().get(9).set('displayArea', { ...good, x: good.x + 999 }));
    peer.transact(() => {
      const b = new Y.Map<unknown>();
      b.set('id', 'added');
      b.set('partNumber', 'hull.1');
      b.set('orientation', 0);
      b.set('displayArea', { x: 2, y: 2, width: 4, height: 2 });
      peerBricks().insert(100, [b]);
    });
    const only = changes.take()!;
    expect(only.bricks.size).toBe(3);
    expect(fixStaleAreasInDoc(doc, parts, only)).toBe(2);
    // A new sheet: all of them again.
    peer.transact(() => peer.getArray('layers').push(['another']));
    expect(changes.take()).toBeNull();
    changes.stop();
  });
});

describe('selection halo (I10)', () => {
  it('uses the tint, or desktop\'s green while a connection snap is live', async () => {
    const { selectionHalo } = await import('../render/BrickLayer');
    expect(selectionHalo('FFD700', false)).toEqual({ stroke: '#FFD700', fill: '#FFD7004D' });
    expect(selectionHalo('FFD700', true)).toEqual({ stroke: 'rgb(80,255,120)', fill: 'rgba(80,255,120,0.353)' });
  });
});
