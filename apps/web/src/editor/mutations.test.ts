import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToBbm } from '@cld/ydoc';
import {
  deleteBricks,
  ensureBrickLayer,
  findBrickStats,
  insertBricks,
  moveBrick,
  placeBrick,
  rotateBricks,
  translateBricks,
} from './mutations';
import { LOCAL_ORIGIN } from './useLayoutDoc';

describe('ensureBrickLayer', () => {
  it('creates a new brick layer + meta defaults when called on a blank doc', () => {
    const doc = new Y.Doc();
    const id = ensureBrickLayer(doc);
    expect(id).toBeTruthy();

    const layerData = doc.getMap('layerData').get(id);
    expect(layerData).toBeInstanceOf(Y.Map);
    expect((layerData as Y.Map<unknown>).get('type')).toBe('brick');

    // Meta seeded with sensible defaults so docToBbm doesn't throw.
    const map = docToBbm(doc);
    expect(map.version).toBe(9);
    expect(map.layers).toHaveLength(1);
    expect(map.layers[0]?.type).toBe('brick');
  });

  it('returns the existing brick layer instead of creating another', () => {
    const doc = new Y.Doc();
    const a = ensureBrickLayer(doc);
    const b = ensureBrickLayer(doc);
    expect(a).toBe(b);
    expect(docToBbm(doc).layers).toHaveLength(1);
  });
});

describe('placeBrick', () => {
  it('appends a brick with the given partNumber and displayArea', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const brickId = placeBrick(doc, layerId, {
      partNumber: 'TS_TRACK18S',
      x: 10,
      y: 20,
      width: 16,
      height: 16,
    });

    const map = docToBbm(doc);
    const layer = map.layers[0];
    expect(layer?.type).toBe('brick');
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks).toHaveLength(1);
    expect(layer.bricks[0]?.id).toBe(brickId);
    expect(layer.bricks[0]?.partNumber).toBe('TS_TRACK18S');
    expect(layer.bricks[0]?.displayArea).toEqual({ x: 10, y: 20, width: 16, height: 16 });
  });

  it('tags transactions with LOCAL_ORIGIN so UndoManager can find them', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const seenOrigins: unknown[] = [];
    doc.on('update', (_u, origin) => seenOrigins.push(origin));
    placeBrick(doc, layerId, { partNumber: 'X', x: 0, y: 0, width: 8, height: 8 });
    expect(seenOrigins).toContain(LOCAL_ORIGIN);
  });
});

describe('deleteBricks', () => {
  it('removes the requested bricks and leaves the rest intact', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const a = placeBrick(doc, layerId, { partNumber: 'A', x: 0, y: 0, width: 8, height: 8 });
    const b = placeBrick(doc, layerId, { partNumber: 'B', x: 8, y: 0, width: 8, height: 8 });
    const c = placeBrick(doc, layerId, { partNumber: 'C', x: 16, y: 0, width: 8, height: 8 });

    deleteBricks(doc, layerId, [a, c]);

    const map = docToBbm(doc);
    const layer = map.layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks.map((br) => br.id)).toEqual([b]);
  });

  it('is a no-op for unknown brick ids', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    placeBrick(doc, layerId, { partNumber: 'A', x: 0, y: 0, width: 8, height: 8 });
    deleteBricks(doc, layerId, ['nonexistent']);
    expect(((docToBbm(doc).layers[0] as { bricks: unknown[] }).bricks)).toHaveLength(1);
  });
});

describe('moveBrick', () => {
  it('updates displayArea so the centre moves to the requested coords', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const id = placeBrick(doc, layerId, { partNumber: 'A', x: 0, y: 0, width: 16, height: 16 });
    moveBrick(doc, layerId, id, 100, 200);

    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    const area = layer.bricks[0]?.displayArea;
    // Centre at (100, 200) means top-left at (92, 192).
    expect(area).toEqual({ x: 92, y: 192, width: 16, height: 16 });
  });
});

describe('translateBricks', () => {
  it('shifts every brick by the same delta in a single transaction', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const a = placeBrick(doc, layerId, { partNumber: 'A', x: 0, y: 0, width: 8, height: 8 });
    const b = placeBrick(doc, layerId, { partNumber: 'B', x: 16, y: 16, width: 8, height: 8 });

    // Watch transaction count — translateBricks must be ONE transaction
    // (so undo treats the multi-brick move as a single step).
    let txnCount = 0;
    doc.on('afterTransaction', () => txnCount++);
    translateBricks(doc, layerId, [a, b], 5, -3);
    doc.off('afterTransaction', () => txnCount++);
    expect(txnCount).toBe(1);

    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks[0]?.displayArea).toEqual({ x: 5, y: -3, width: 8, height: 8 });
    expect(layer.bricks[1]?.displayArea).toEqual({ x: 21, y: 13, width: 8, height: 8 });
  });

  it('skips work when called with empty selection or zero delta', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    let txnCount = 0;
    doc.on('afterTransaction', () => txnCount++);
    translateBricks(doc, layerId, [], 5, 5);
    translateBricks(doc, layerId, ['x'], 0, 0);
    expect(txnCount).toBe(0);
  });
});

describe('rotateBricks', () => {
  it('adds the delta to each selected brick orientation', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const a = placeBrick(doc, layerId, {
      partNumber: 'A',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      orientation: 0,
    });
    const b = placeBrick(doc, layerId, {
      partNumber: 'B',
      x: 16,
      y: 0,
      width: 8,
      height: 8,
      orientation: 90,
    });

    rotateBricks(doc, layerId, [a, b], 15);

    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks[0]?.orientation).toBe(15);
    expect(layer.bricks[1]?.orientation).toBe(105);
  });

  it('wraps modulo 360', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const id = placeBrick(doc, layerId, {
      partNumber: 'A',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      orientation: 350,
    });
    rotateBricks(doc, layerId, [id], 30);
    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks[0]?.orientation).toBe(20);
  });

  it('preserves float orientation (matches desktop)', () => {
    // Desktop's RotateBricksCommand stores Brick.orientation as a float
    // and adds the float delta directly (MapView.cpp:964-967). The web
    // port now matches — rounding to an int would silently quantise a
    // float orientation that came in from a desktop-saved file.
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const id = placeBrick(doc, layerId, {
      partNumber: 'A',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      orientation: 1.5,
    });
    rotateBricks(doc, layerId, [id], 0.25);
    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks[0]?.orientation).toBeCloseTo(1.75, 6);
  });
});

describe('insertBricks', () => {
  it('appends every brick with a fresh id and applies the offset', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);

    // Existing brick with id 'a' at (0,0). The inserted brick should
    // get a different id even if the source brick id collides.
    placeBrick(doc, layerId, {
      partNumber: 'EXISTING',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    });

    const ids = insertBricks(
      doc,
      layerId,
      [
        {
          partNumber: 'A',
          displayArea: { x: 0, y: 0, width: 16, height: 16 },
        },
        {
          partNumber: 'B',
          displayArea: { x: 16, y: 0, width: 16, height: 16 },
          orientation: 90,
        },
      ],
      { dx: 100, dy: 50 },
    );

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks).toHaveLength(3); // existing + 2 inserted
    // First inserted brick should be at (100, 50).
    expect(layer.bricks[1]?.displayArea).toEqual({
      x: 100,
      y: 50,
      width: 16,
      height: 16,
    });
    expect(layer.bricks[2]?.orientation).toBe(90);
  });

  it('returns empty + does nothing for an empty input', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    expect(insertBricks(doc, layerId, [])).toEqual([]);
    const layer = docToBbm(doc).layers[0];
    if (layer?.type !== 'brick') throw new Error('not a brick layer');
    expect(layer.bricks).toHaveLength(0);
  });

  it('insertion is one Yjs transaction (one undo step for the whole insert)', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    let txnCount = 0;
    const onTx = () => txnCount++;
    doc.on('afterTransaction', onTx);
    insertBricks(doc, layerId, [
      { partNumber: 'A', displayArea: { x: 0, y: 0, width: 8, height: 8 } },
      { partNumber: 'B', displayArea: { x: 8, y: 0, width: 8, height: 8 } },
      { partNumber: 'C', displayArea: { x: 16, y: 0, width: 8, height: 8 } },
    ]);
    doc.off('afterTransaction', onTx);
    expect(txnCount).toBe(1);
  });
});

describe('finding a part by its id', () => {
  const pivot = (doc: Y.Doc, id: string) => {
    const b = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : [])).find((x) => x.id === id)!;
    return { x: b.displayArea.x + b.displayArea.width / 2, y: b.displayArea.y + b.displayArea.height / 2 };
  };

  it('looks through the sheet once, then goes straight to the part, and again only when the list changed under it', () => {
    const doc = new Y.Doc();
    const layerId = ensureBrickLayer(doc);
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < 400; i++) ids.push(placeBrick(doc, layerId, { partNumber: '3001.8', x: i * 10, y: 0, width: 4, height: 2 }));
    });
    findBrickStats.wholeLooks = 0;
    moveBrick(doc, layerId, ids[200]!, 5, 5);
    expect(findBrickStats.wholeLooks).toBe(1);
    for (const i of [10, 399, 200, 0]) moveBrick(doc, layerId, ids[i]!, i, 7);
    expect(findBrickStats.wholeLooks).toBe(1);
    expect(pivot(doc, ids[399]!)).toEqual({ x: 399, y: 7 });
    // Deleted: not found, and not moved by a stale index.
    deleteBricks(doc, layerId, [ids[10]!]);
    moveBrick(doc, layerId, ids[10]!, 1, 1);
    expect(docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : [])).some((b) => b.id === ids[10])).toBe(false);
    // The others are still found after it.
    moveBrick(doc, layerId, ids[300]!, 3, 4);
    expect(pivot(doc, ids[300]!)).toEqual({ x: 3, y: 4 });
  });
});
