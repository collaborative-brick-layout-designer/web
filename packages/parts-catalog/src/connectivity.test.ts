import { describe, expect, it } from 'vitest';
import type { BbmMap, Brick, Layer, LayerBrick } from '@cld/model';
import { rebuildConnectivity } from './connectivity.js';
import type { Catalog, PartMetadata } from './types.js';

// Helpers for building synthetic test scenarios. Each part has
// its own connection list; bricks placed at world coordinates.
function makeMeta(
  partNumber: string,
  connections: { x: number; y: number; type: string }[],
): PartMetadata {
  return {
    key: partNumber.toLowerCase(),
    partNumber,
    colorCode: '',
    kind: 'leaf',
    descriptions: {},
    author: '',
    sortingKey: '',
    spritePath: '',
    pxPerStud: 8,
    connections: connections.map((c) => ({
      type: c.type,
      x: c.x,
      y: c.y,
      angle: 0,
      electricPlug: -1,
    })),
    subparts: [],
    canUngroup: true,
    hullPts: [],
  };
}

function makeBrick(id: string, partNumber: string, x: number, y: number, orientation = 0): Brick {
  return {
    id,
    displayArea: { x, y, width: 0, height: 0 }, // size-0 keeps centre at (x, y)
    myGroup: '',
    partNumber,
    orientation,
    activeConnectionPointIndex: 0,
    altitude: 0,
    connexions: [],
  };
}

function makeBrickLayer(bricks: Brick[]): LayerBrick {
  return {
    type: 'brick',
    id: 'L1',
    name: 'L',
    visible: true,
    transparency: 100,
    hullProperties: {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' },
      hullThickness: 1,
    },
    displayBrickElevation: false,
    bricks,
    groups: [],
  };
}

function makeMap(layers: Layer[]): BbmMap {
  return {
    version: 9,
    nbItems: layers.reduce(
      (n, l) => n + (l.type === 'brick' ? l.bricks.length : 0),
      0,
    ),
    backgroundColor: { kind: 'known', name: 'White' },
    author: '',
    lug: '',
    event: '',
    date: { day: 1, month: 1, year: 2026 },
    comment: '',
    exportInfo: {
      exportPath: '',
      exportFileType: 0,
      exportArea: { x: 0, y: 0, width: 0, height: 0 },
      exportScale: 1,
      exportWatermark: false,
      exportElectricCircuit: false,
      exportConnectionPoints: false,
    },
    selectedLayerIndex: 0,
    layers,
  };
}

describe('rebuildConnectivity', () => {
  it('links two bricks whose connection points coincide within tolerance', () => {
    // Two straight tracks placed end-to-end. Each has a connection at
    // (-5, 0) and (5, 0) relative to its centre. Brick A at (0, 0),
    // Brick B at (10, 0). The shared coordinate is (5, 0).
    const meta = makeMeta('TRACK', [
      { x: -5, y: 0, type: 'rail' },
      { x: 5, y: 0, type: 'rail' },
    ]);
    const catalog: Catalog = new Map([[meta.key, meta]]);

    const a = makeBrick('a', 'TRACK', 0, 0);
    const b = makeBrick('b', 'TRACK', 10, 0);
    const map = makeMap([makeBrickLayer([a, b])]);

    const result = rebuildConnectivity(map, catalog);

    expect(result.linkedCount).toBe(2);
    // Inner endpoints are linked to each other.
    expect(a.connexions[1]?.linkedTo).toBe(b.connexions[0]?.id);
    expect(b.connexions[0]?.linkedTo).toBe(a.connexions[1]?.id);
    // Outer endpoints stay unlinked.
    expect(a.connexions[0]?.linkedTo).toBe('');
    expect(b.connexions[1]?.linkedTo).toBe('');
  });



  it('keeps a link to a part the library does not know, as the file has it', () => {
    // A known straight joined to a BrickTracks curve this library lacks:
    // the curve's points can't be placed, so the join stays.
    const meta = makeMeta('TRACK', [
      { x: -5, y: 0, type: 'rail' },
      { x: 5, y: 0, type: 'rail' },
    ]);
    const catalog: Catalog = new Map([[meta.key, meta]]);
    const a = makeBrick('a', 'TRACK', 0, 0);
    a.connexions = [{ id: 'a0', linkedTo: '' }, { id: 'a1', linkedTo: 'c0' }];
    const curve = makeBrick('c', 'BT R104.8', 40, 40);
    curve.connexions = [{ id: 'c0', linkedTo: 'a1' }, { id: 'c1', linkedTo: '' }];
    const map = makeMap([makeBrickLayer([a, curve])]);

    rebuildConnectivity(map, catalog);

    expect(a.connexions[1]?.linkedTo).toBe('c0');
    expect(curve.connexions[0]?.linkedTo).toBe('a1');
    expect(a.activeConnectionPointIndex).toBe(0);
    // A link between two known parts that no longer meet still breaks.
    const b = makeBrick('b', 'TRACK', 100, 0);
    b.connexions = [{ id: 'b0', linkedTo: 'a0' }, { id: 'b1', linkedTo: '' }];
    a.connexions[0]!.linkedTo = 'b0';
    rebuildConnectivity(makeMap([makeBrickLayer([a, curve, b])]), catalog);
    expect(a.connexions[0]?.linkedTo).toBe('');
    expect(a.connexions[1]?.linkedTo).toBe('c0');
  });

  it('does not link points with mismatched types', () => {
    const railMeta = makeMeta('RAIL', [{ x: 0, y: 0, type: 'rail' }]);
    const roadMeta = makeMeta('ROAD', [{ x: 0, y: 0, type: 'road' }]);
    const catalog: Catalog = new Map([
      [railMeta.key, railMeta],
      [roadMeta.key, roadMeta],
    ]);

    const a = makeBrick('a', 'RAIL', 0, 0);
    const b = makeBrick('b', 'ROAD', 0, 0); // coincident, but different type
    const map = makeMap([makeBrickLayer([a, b])]);

    const result = rebuildConnectivity(map, catalog);
    expect(result.linkedCount).toBe(0);
  });

  it('skips connections whose type is empty', () => {
    const meta = makeMeta('NONE', [{ x: 0, y: 0, type: '' }]);
    const catalog: Catalog = new Map([[meta.key, meta]]);

    const a = makeBrick('a', 'NONE', 0, 0);
    const b = makeBrick('b', 'NONE', 0, 0);
    const map = makeMap([makeBrickLayer([a, b])]);

    const result = rebuildConnectivity(map, catalog);
    expect(result.linkedCount).toBe(0);
  });

  it('respects orientation when rotating local connection points to world space', () => {
    // Brick A at origin, orientation 0, has a connexion at local (5, 0)
    // → world (5, 0). Brick B at (5, 5), orientation -90° (clockwise 90),
    // has a connexion at local (0, 5) which after −90° rotation is (5, 0)
    // → world (10, 5).  No coincidence here. Now place B with
    // orientation 90° (counter-clockwise) so local (0, 5) becomes (-5, 0)
    // → world (0, 5). Still no match. The point of this test is to confirm
    // the rotation matrix doesn't accidentally match arbitrary points.
    //
    // For the positive case, we use orientation 180°: local (5, 0) →
    // world (5 - 10, 0) = (-5, 0). Place A at (-5, 0) with cp at (0, 0)
    // and the world points coincide.
    const a = makeMeta('A', [{ x: 5, y: 0, type: 'rail' }]);
    const b = makeMeta('B', [{ x: 0, y: 0, type: 'rail' }]);
    const catalog: Catalog = new Map([[a.key, a], [b.key, b]]);

    const ba = makeBrick('a', 'A', 0, 0, 180);
    const bb = makeBrick('b', 'B', -5, 0, 0);
    const map = makeMap([makeBrickLayer([ba, bb])]);

    const result = rebuildConnectivity(map, catalog);
    expect(result.linkedCount).toBe(2);
  });

  it('links to the first free point in brick order, not the nearest (BlueBrick)', () => {
    // a at 0; c (0.4 away) comes before b (0.1 away) in the layer, so a
    // links to c, as BlueBrick's in-order walk does.
    const meta = makeMeta('TRACK', [{ x: 0, y: 0, type: 'rail' }]);
    const catalog: Catalog = new Map([[meta.key, meta]]);
    const a = makeBrick('a', 'TRACK', 0, 0);
    const c = makeBrick('c', 'TRACK', 0.4, 0);
    const b = makeBrick('b', 'TRACK', 0.1, 0);
    const map = makeMap([makeBrickLayer([a, c, b])]);

    rebuildConnectivity(map, catalog);

    expect(a.connexions[0]?.linkedTo).toBe(c.connexions[0]?.id);
    expect(c.connexions[0]?.linkedTo).toBe(a.connexions[0]?.id);
    expect(b.connexions[0]?.linkedTo).toBe('');
  });

  it('equal positions are within half a stud on each axis', () => {
    const meta = makeMeta('TRACK', [{ x: 0, y: 0, type: 'rail' }]);
    const catalog: Catalog = new Map([[meta.key, meta]]);
    const link = (dx: number, dy: number) => {
      const a = makeBrick('a', 'TRACK', 0, 0);
      const b = makeBrick('b', 'TRACK', dx, dy);
      return rebuildConnectivity(makeMap([makeBrickLayer([a, b])]), catalog).linkedCount > 0;
    };
    // 0.45 on both axes is 0.64 apart in a straight line: still equal.
    expect(link(0.45, 0.45)).toBe(true);
    expect(link(0.5, 0)).toBe(false);
    expect(link(0, -0.5)).toBe(false);
    expect(link(0.9, 0)).toBe(false);
  });

  describe('active connection hand-over (BlueBrick ConnectionLink setter)', () => {
    // A 3-connection part; connection 1 prefers 2 next, the others default to 0.
    const meta = makeMeta('SW', [
      { x: -5, y: 0, type: 'rail' },
      { x: 5, y: 0, type: 'rail' },
      { x: 5, y: 3, type: 'rail' },
    ]);
    meta.connections[1]!.nextConnexionPreference = 2;
    const straight = makeMeta('TRACK', [
      { x: -5, y: 0, type: 'rail' },
      { x: 5, y: 0, type: 'rail' },
    ]);
    const catalog: Catalog = new Map([[meta.key, meta], [straight.key, straight]]);

    it('a new link on the active connection moves it to <nextConnexionPreference>', () => {
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 1 };
      const t = makeBrick('t', 'TRACK', 10, 0);
      rebuildConnectivity(makeMap([makeBrickLayer([sw, t])]), catalog);
      expect(sw.connexions[1]!.linkedTo).toBe(t.connexions[0]!.id);
      expect(sw.activeConnectionPointIndex).toBe(2);
    });

    it('when the preferred connection is taken, the next free one wraps round', () => {
      // `t2`, first in the layer, links to connection 2 before connection
      // 1 links to `t1`; 1 prefers 2, which is taken, so 0 becomes active.
      const t2 = makeBrick('t2', 'TRACK', 10, 3);
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 1 };
      const t1 = makeBrick('t1', 'TRACK', 10, 0);
      rebuildConnectivity(makeMap([makeBrickLayer([t2, sw, t1])]), catalog);
      expect(sw.connexions[2]!.linkedTo).toBe(t2.connexions[0]!.id);
      expect(sw.connexions[1]!.linkedTo).toBe(t1.connexions[0]!.id);
      expect(sw.activeConnectionPointIndex).toBe(0);
    });

    it('the connection being linked still counts as free, so it can stay active', () => {
      // Connection 0 prefers 0 (the default): BlueBrick hands over before
      // storing the link, finds 0 free and keeps it.
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 0 };
      const t = makeBrick('t', 'TRACK', -10, 0);
      rebuildConnectivity(makeMap([makeBrickLayer([sw, t])]), catalog);
      expect(sw.connexions[0]!.linkedTo).toBe(t.connexions[1]!.id);
      expect(sw.activeConnectionPointIndex).toBe(0);
    });

    it('a brick in a group keeps the preferred connection even when it is taken', () => {
      // Same as the wrap-round case, but grouped: BlueBrick moves the
      // group's active connection instead, leaving the brick on 2.
      const t2 = makeBrick('t2', 'TRACK', 10, 3);
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 1, myGroup: 'g' };
      const t1 = makeBrick('t1', 'TRACK', 10, 0);
      rebuildConnectivity(makeMap([makeBrickLayer([t2, sw, t1])]), catalog);
      expect(sw.connexions[2]!.linkedTo).toBe(t2.connexions[0]!.id);
      expect(sw.activeConnectionPointIndex).toBe(2);
    });

    it('a link that already existed does not hand over again', () => {
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 1 };
      const t = makeBrick('t', 'TRACK', 10, 0);
      const map = makeMap([makeBrickLayer([sw, t])]);
      rebuildConnectivity(map, catalog);
      sw.activeConnectionPointIndex = 1;
      rebuildConnectivity(map, catalog);
      expect(sw.activeConnectionPointIndex).toBe(1);
    });

    it('a broken link frees its connection, which becomes active if the active one is taken', () => {
      const sw = { ...makeBrick('sw', 'SW', 0, 0), activeConnectionPointIndex: 1 };
      const left = makeBrick('l', 'TRACK', -10, 0);
      const right = makeBrick('r', 'TRACK', 10, 0);
      const layer = makeBrickLayer([sw, left, right]);
      const map = makeMap([layer]);
      rebuildConnectivity(map, catalog);
      // Make connection 1 (linked to `right`) active again, then take `left` away.
      sw.activeConnectionPointIndex = 1;
      layer.bricks.splice(1, 1);
      left.displayArea = { ...left.displayArea, x: -100 };
      rebuildConnectivity(map, catalog);
      expect(sw.connexions[0]!.linkedTo).toBe('');
      expect(sw.activeConnectionPointIndex).toBe(0);
    });
  });

  it('grows brick.connexions to match the catalog count', () => {
    const meta = makeMeta('TRACK', [
      { x: 0, y: 0, type: 'rail' },
      { x: 1, y: 0, type: 'rail' },
    ]);
    const catalog: Catalog = new Map([[meta.key, meta]]);

    const a = makeBrick('a', 'TRACK', 0, 0); // empty connexions
    const map = makeMap([makeBrickLayer([a])]);

    rebuildConnectivity(map, catalog);

    expect(a.connexions).toHaveLength(2);
    expect(a.connexions[0]?.id).toBeTruthy();
    expect(a.connexions[1]?.id).toBeTruthy();
  });

  it('shrinks brick.connexions when stale entries exceed the catalog count', () => {
    const meta = makeMeta('TRACK', [{ x: 0, y: 0, type: 'rail' }]);
    const catalog: Catalog = new Map([[meta.key, meta]]);

    const a = makeBrick('a', 'TRACK', 0, 0);
    a.connexions = [
      { id: 'a_0', linkedTo: '' },
      { id: 'a_1', linkedTo: 'leftover-link' }, // stale extra
    ];
    const map = makeMap([makeBrickLayer([a])]);

    rebuildConnectivity(map, catalog);

    expect(a.connexions).toHaveLength(1);
  });

  it('never links bricks on different layers (vanilla links within a layer)', () => {
    const meta = makeMeta('TRACK', [
      { x: -5, y: 0, type: 'rail' },
      { x: 5, y: 0, type: 'rail' },
    ]);
    const catalog: Catalog = new Map([[meta.key, meta]]);
    const a = makeBrick('a', 'TRACK', 0, 0);
    const b = makeBrick('b', 'TRACK', 10, 0);
    const other = { ...makeBrickLayer([b]), id: 'L2' };
    const map = makeMap([makeBrickLayer([a]), other]);

    expect(rebuildConnectivity(map, catalog).linkedCount).toBe(0);
    expect(a.connexions.every((c) => c.linkedTo === '')).toBe(true);
    expect(b.connexions.every((c) => c.linkedTo === '')).toBe(true);
  });

  it('resolves a brick saved under an old part number (<OldNameList>)', () => {
    const meta = {
      ...makeMeta('TRACK', [
        { x: -5, y: 0, type: 'rail' },
        { x: 5, y: 0, type: 'rail' },
      ]),
      oldNames: ['OLDTRACK'],
    };
    const catalog: Catalog = new Map([[meta.key, meta]]);
    const a = makeBrick('a', 'TRACK', 0, 0);
    const b = makeBrick('b', 'OldTrack', 10, 0);
    const map = makeMap([makeBrickLayer([a, b])]);

    expect(rebuildConnectivity(map, catalog).linkedCount).toBe(2);
    expect(b.connexions).toHaveLength(2);
  });

  it('measures connection points from the sprite centre of a part with a <hull>', () => {
    // 32 x 16 px sprite whose hull is its left half: the 2 x 2 displayArea
    // centre sits 1 stud left of the sprite centre (the pivot).
    const meta: PartMetadata = {
      ...makeMeta('HULL', [
        { x: -2, y: 0, type: 'rail' },
        { x: 2, y: 0, type: 'rail' },
      ]),
      spriteSize: { w: 32, h: 16 },
      hullPts: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 15 }],
    };
    const catalog: Catalog = new Map([[meta.key, meta]]);
    // a: pivot 0, box centre -1. b turned 180°: pivot 4, hull now to the
    // right, box centre 5. Their right-hand connections meet at x = 2 from
    // the pivots; from the box centres they would sit at 1 and 3.
    const a = { ...makeBrick('a', 'HULL', 0, 0), displayArea: { x: -2, y: -1, width: 2, height: 2 } };
    const b = { ...makeBrick('b', 'HULL', 0, 0, 180), displayArea: { x: 4, y: -1, width: 2, height: 2 } };
    const map = makeMap([makeBrickLayer([a, b])]);

    expect(rebuildConnectivity(map, catalog).linkedCount).toBe(2);
    expect(a.connexions[1]!.linkedTo).toBe(b.connexions[1]!.id);
  });
});
