import { describe, expect, it } from 'vitest';
import type { BbmMap, Brick, Layer, LayerBrick } from '@cld/model';
import { connectionPoints, linkBricks, makeCatalogLookup, rebuildConnectivity } from './connectivity.js';
import { imageOffset } from './footprint.js';
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

// The rules of rebuildConnectivity written out the plain way (every pair
// of connections compared, every brick copied), for comparing the bucketed
// one against on layouts made at random.
function reference(map: BbmMap, catalog: Catalog): BbmMap {
  const out = structuredClone(map);
  const lookup = makeCatalogLookup(catalog);
  for (const layer of out.layers) {
    if (layer.type !== 'brick') continue;
    const unknown = new Set<string>();
    for (const b of layer.bricks) if (!lookup(b.partNumber)) for (const c of b.connexions) if (c.id) unknown.add(c.id);
    const previous = new Map<string, string>();
    const all: { b: Brick; i: number; x: number; y: number; type: string }[] = [];
    let fresh = 0;
    for (const b of layer.bricks) {
      const meta = lookup(b.partNumber);
      if (!meta) continue;
      const n = meta.connections.length;
      for (let k = b.connexions.length; k < n; k++) b.connexions.push({ id: `${b.id}_${k}`, linkedTo: '' });
      b.connexions.length = n;
      const off = imageOffset(meta, b.orientation);
      const t = (b.orientation * Math.PI) / 180;
      for (let i = 0; i < n; i++) {
        const cp = b.connexions[i]!;
        if (!cp.id) cp.id = `${b.id}_c${fresh++}`;
        if (cp.linkedTo && unknown.has(cp.linkedTo)) continue;
        if (cp.linkedTo) previous.set(cp.id, cp.linkedTo);
        cp.linkedTo = '';
        const c = meta.connections[i]!;
        if (c.type === '') continue;
        const cx = b.displayArea.x + b.displayArea.width / 2 + off.x;
        const cy = b.displayArea.y + b.displayArea.height / 2 + off.y;
        all.push({ b, i, x: cx + (c.x * Math.cos(t) - c.y * Math.sin(t)), y: cy + (c.x * Math.sin(t) + c.y * Math.cos(t)), type: c.type });
      }
    }
    const onLinked = (b: Brick, i: number) => {
      if (b.activeConnectionPointIndex !== i) return;
      const n = b.connexions.length;
      const pref = lookup(b.partNumber)!.connections[i]?.nextConnexionPreference ?? 0;
      b.activeConnectionPointIndex = Math.min(Math.max(pref, 0), n - 1);
      if (b.myGroup || b.connexions[b.activeConnectionPointIndex]!.linkedTo === '') return;
      for (let s = 1; s < n; s++) {
        const k = (b.activeConnectionPointIndex + s) % n;
        if (b.connexions[k]!.linkedTo === '') return void (b.activeConnectionPointIndex = k);
      }
    };
    for (let i = 0; i < all.length; i++) {
      const a = all[i]!;
      const ca = a.b.connexions[a.i]!;
      if (ca.linkedTo !== '') continue;
      const j = all.findIndex((o, k) => k !== i && o.b !== a.b && o.type === a.type && o.b.connexions[o.i]!.linkedTo === '' && Math.abs(o.x - a.x) < 0.5 && Math.abs(o.y - a.y) < 0.5);
      if (j < 0) continue;
      const o = all[j]!;
      const cb = o.b.connexions[o.i]!;
      const isNew = previous.get(ca.id) !== cb.id;
      if (isNew) onLinked(a.b, a.i);
      ca.linkedTo = cb.id;
      if (isNew) onLinked(o.b, o.i);
      cb.linkedTo = ca.id;
    }
    for (const w of all) {
      const cp = w.b.connexions[w.i]!;
      if (!previous.has(cp.id) || cp.linkedTo !== '') continue;
      const act = w.b.activeConnectionPointIndex;
      if (act >= 0 && act < w.b.connexions.length && w.b.connexions[act]!.linkedTo !== '') w.b.activeConnectionPointIndex = w.i;
    }
  }
  return out;
}

describe('rebuildConnectivity in buckets', () => {
  const STRAIGHT = makeMeta('STRAIGHT', [
    { x: -4, y: 0, type: 'rail' },
    { x: 4, y: 0, type: 'rail' },
  ]);
  const CROSS = { ...makeMeta('CROSS', [
    { x: -4, y: 0, type: 'rail' },
    { x: 4, y: 0, type: 'rail' },
    { x: 0, y: -4, type: 'rail' },
    { x: 0, y: 4, type: 'road' },
  ]), connections: makeMeta('CROSS', [
    { x: -4, y: 0, type: 'rail' },
    { x: 4, y: 0, type: 'rail' },
    { x: 0, y: -4, type: 'rail' },
    { x: 0, y: 4, type: 'road' },
  ]).connections.map((c, i) => ({ ...c, nextConnexionPreference: (i + 2) % 4 })) };
  const catalog: Catalog = new Map([[STRAIGHT.key, STRAIGHT], [CROSS.key, CROSS]]);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  function randomLayer(n: number, at = 0): Brick[] {
    const out: Brick[] = [];
    for (let i = 0; i < n; i++) {
      const b = makeBrick(`b${i}`, rnd() < 0.7 ? 'STRAIGHT' : rnd() < 0.9 ? 'CROSS' : 'GONE', at + Math.round(rnd() * 12) * 4 + (rnd() < 0.2 ? 0.3 : 0), at + Math.round(rnd() * 6) * 4, [0, 90, 180, 270][Math.floor(rnd() * 4)]!);
      b.myGroup = rnd() < 0.2 ? 'g' : '';
      b.activeConnectionPointIndex = Math.floor(rnd() * 3);
      const k = Math.floor(rnd() * 5);
      for (let c = 0; c < k; c++) b.connexions.push({ id: rnd() < 0.1 ? '' : `${b.id}:${c}`, linkedTo: '' });
      out.push(b);
    }
    // Some links as a file might have them, right or stale.
    for (const b of out) for (const c of b.connexions) if (rnd() < 0.3) c.linkedTo = out[Math.floor(rnd() * out.length)]!.connexions[0]?.id ?? '';
    return out;
  }

  it('links as the rules say, on layouts made at random', () => {
    for (let round = 0; round < 40; round++) {
      const map = makeMap([makeBrickLayer(randomLayer(60))]);
      const want = reference(map, catalog);
      rebuildConnectivity(map, catalog);
      expect(map).toEqual(want);
      // And again from there, as after a change elsewhere.
      const again = reference(map, catalog);
      rebuildConnectivity(map, catalog);
      expect(map).toEqual(again);
    }
  });

  it('links far from the origin too, where the buckets are named another way', () => {
    for (const at of [(1 << 24) - 6, 1e9, -1e9 - 50]) {
      const map = makeMap([makeBrickLayer(randomLayer(40, at))]);
      const want = reference(map, catalog);
      rebuildConnectivity(map, catalog);
      expect(map).toEqual(want);
    }
    const a = makeBrick('a', 'STRAIGHT', (1 << 24) - 4, 0);
    const b = makeBrick('b', 'STRAIGHT', (1 << 24) + 4, 0);
    expect(rebuildConnectivity(makeMap([makeBrickLayer([a, b])]), catalog).linkedCount).toBe(2);
  });

  it('linkBricks gives what rebuildConnectivity writes, leaving the bricks as they are', () => {
    const bricks = randomLayer(80);
    const before = structuredClone(bricks);
    const asked: Brick[] = [];
    const { links } = linkBricks(bricks, makeCatalogLookup(catalog), (b, meta) => {
      asked.push(b);
      return connectionPoints(b, meta);
    });
    expect(bricks).toEqual(before);
    // Each known brick's points are asked for once at most.
    expect(new Set(asked).size).toBe(asked.length);
    const map = makeMap([makeBrickLayer(structuredClone(bricks))]);
    rebuildConnectivity(map, catalog);
    const layer = map.layers[0] as LayerBrick;
    links.forEach((l, i) => {
      if (!l) expect(layer.bricks[i]).toEqual(before[i]);
      else expect({ connexions: layer.bricks[i]!.connexions, activeConnectionPointIndex: layer.bricks[i]!.activeConnectionPointIndex }).toEqual(l);
    });
  });
});
