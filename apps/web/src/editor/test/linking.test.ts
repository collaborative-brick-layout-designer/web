// Connectivity write-back in the editor: links and the handed-over active
// connection (BlueBrick onLinked) reach the doc, outside the undo stack.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import type { PartWire } from '../../api';
import { moveBrick, placeBrick } from '../mutations';
import { catalogFromParts, connectivityStats, CONNECTIVITY_ORIGIN, recomputeConnectivity, useConnectivity } from '../useConnectivity';
import { rebuildConnectivity } from '@cld/parts-catalog/browser';
import { createUndoManager } from '../useUndoManager';
import { LOCAL_ORIGIN } from '../useLayoutDoc';

// 2865.8-style straight: connection 0 prefers 1 next, 1 prefers 0.
const STRAIGHT = {
  key: 'straight.8',
  partNumber: 'straight',
  colorCode: '8',
  kind: 'leaf',
  pxPerStud: 8,
  hullPts: [],
  connections: [
    { type: '1', x: -8, y: 0, angle: 180, electricPlug: 1, nextConnexionPreference: 1 },
    { type: '1', x: 8, y: 0, angle: 0, electricPlug: -1, nextConnexionPreference: 0 },
  ],
  subparts: [],
} as unknown as PartWire;

describe('connectivity write-back', () => {
  it('catalogFromParts keeps nextConnexionPreference for the hand-over', () => {
    const meta = catalogFromParts([STRAIGHT]).get('straight.8')!;
    expect(meta.connections.map((c) => c.nextConnexionPreference)).toEqual([1, 0]);
  });

  it('writes links and the handed-over active connection, not as an undo step', () => {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const um = new Y.UndoManager([doc.getMap('layerData')], { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    // b sits right of a; a's active connection is its right end (1), which gets linked.
    const a = placeBrick(doc, layerId, { partNumber: 'straight.8', x: 0, y: 0, width: 16, height: 8, activeConnectionPointIndex: 1 });
    const b = placeBrick(doc, layerId, { partNumber: 'straight.8', x: 16, y: 0, width: 16, height: 8 });
    const undoSteps = um.undoStack.length;

    recomputeConnectivity(doc, catalogFromParts([STRAIGHT]));

    const bricks = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []));
    const A = bricks.find((x) => x.id === a)!;
    const B = bricks.find((x) => x.id === b)!;
    expect(A.connexions[1]!.linkedTo).toBe(B.connexions[0]!.id);
    // Each brick's active end got linked, so it moves to that end's
    // preference: the other, free end.
    expect(A.activeConnectionPointIndex).toBe(0);
    expect(B.activeConnectionPointIndex).toBe(1);
    expect(um.undoStack.length).toBe(undoSteps);
  });
});

describe('links after an undo', () => {
  afterEach(() => vi.useRealTimers());

  it('come back with the parts at once, not after the debounce', () => {
    vi.useFakeTimers();
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const a = placeBrick(doc, layerId, { partNumber: 'straight.8', x: 0, y: 0, width: 16, height: 8 });
    const b = placeBrick(doc, layerId, { partNumber: 'straight.8', x: 16, y: 0, width: 16, height: 8 });
    const parts = [STRAIGHT];
    const { unmount } = renderHook(() => useConnectivity(doc, parts));
    const linked = () => {
      const bricks = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []));
      return bricks.find((x) => x.id === a)!.connexions[1]!.linkedTo === bricks.find((x) => x.id === b)!.connexions[0]!.id;
    };
    vi.advanceTimersByTime(1000);
    expect(linked()).toBe(true);

    const um = createUndoManager(doc);
    moveBrick(doc, layerId, b, 100, 4); // pulled away: the joint opens
    um.stopCapturing();
    vi.advanceTimersByTime(1000);
    expect(linked()).toBe(false);

    // A slow page: no timer gets to run between the undo and the next draw or click.
    um.undo();
    expect(linked()).toBe(true);
    um.redo();
    expect(linked()).toBe(false);
    unmount();
  });
});

describe('placing a set (desktop MapView::addPartAtScenePos)', () => {
  it('adds its bricks and its named group, never a module, as one undo step', async () => {
    const { insertSet } = await import('../mutations');
    const { readSidecarFromDoc } = await import('@cld/ydoc');
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const um = new Y.UndoManager([doc.getMap('layerData'), doc.getMap('meta')], { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    const brick = (x: number) => ({ partNumber: 'straight.8', displayArea: { x, y: 0, width: 16, height: 8 }, orientation: 0, myGroup: 'g1' });

    const ids = insertSet(doc, layerId, { bricks: [brick(0), brick(16)], groups: [{ id: 'g1', partNumber: 'PACK.GROUP', myGroup: '' }] });

    expect(ids).toHaveLength(2);
    const layer = docToBbm(doc).layers.find((l) => l.type === 'brick');
    expect(layer?.type === 'brick' && layer.groups.map((g) => g.partNumber)).toEqual(['PACK.GROUP']);
    expect(layer?.type === 'brick' && layer.bricks.map((b) => b.myGroup)).toEqual(['g1', 'g1']);
    expect(readSidecarFromDoc(doc)?.modules ?? []).toHaveLength(0);
    expect(um.undoStack.length).toBe(1);
    um.undo();
    const after = docToBbm(doc).layers.find((l) => l.type === 'brick');
    expect(after?.type === 'brick' && [after.bricks.length, after.groups.length]).toEqual([0, 0]);
  });
});

describe('links after a move on a big layout', () => {
  afterEach(() => vi.useRealTimers());
  const N = 600;
  /** A row of N straights end to end, linked, with a recompute's cache warm. */
  function row() {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < N; i++) ids.push(placeBrick(doc, layerId, { partNumber: 'straight.8', x: i * 16, y: (i % 50 === 49 ? 3 : 0), width: 16, height: 8 }));
    }, LOCAL_ORIGIN);
    const catalog = catalogFromParts([STRAIGHT]);
    recomputeConnectivity(doc, catalog);
    // (The links it wrote made new parts of the ones it linked: their points are worked out once more.)
    recomputeConnectivity(doc, catalog);
    return { doc, layerId, ids, catalog };
  }

  it('comes out as the whole recompute on a copy does, move after move', () => {
    const { doc, layerId, ids, catalog } = row();
    for (const [i, dx, dy] of [[10, 100, 0], [11, 3, 0], [200, -16, 0], [10, -100, 0], [599, 0, 40], [0, 16, 0]] as const) {
      const want = docToBbm(doc);
      const b = want.layers.flatMap((l) => (l.type === 'brick' ? l.bricks : [])).find((x) => x.id === ids[i])!;
      moveBrick(doc, layerId, ids[i]!, b.displayArea.x + dx, b.displayArea.y + dy);
      const copy = docToBbm(doc);
      rebuildConnectivity(copy, catalog);
      recomputeConnectivity(doc, catalog);
      expect(docToBbm(doc)).toEqual(copy);
    }
  });

  it("writes only the parts whose links changed, and works out only the moved part's points", () => {
    const { doc, layerId, ids, catalog } = row();
    const written = new Set<unknown>();
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin !== CONNECTIVITY_ORIGIN) return;
      for (const t of tr.changed.keys()) written.add(t);
    });
    connectivityStats.pointsWorkedOut = 0;
    // Pulled out of the row: it and its two neighbours lose their links.
    moveBrick(doc, layerId, ids[310]!, 310 * 16, 100);
    recomputeConnectivity(doc, catalog);
    expect(written.size).toBe(3);
    expect(connectivityStats.pointsWorkedOut).toBe(1);
    // Nothing moved since: nothing written, and only the parts whose links
    // were written are worked out again.
    written.clear();
    recomputeConnectivity(doc, catalog);
    expect(written.size).toBe(0);
    expect(connectivityStats.pointsWorkedOut).toBe(1 + 3);
  });

  it("a local move's recompute reads only the parts it changed from the doc", () => {
    vi.useFakeTimers();
    const { doc, layerId, ids } = row();
    const parts = [STRAIGHT];
    const { unmount } = renderHook(() => useConnectivity(doc, parts));
    vi.advanceTimersByTime(1000);
    const get = Y.Map.prototype.get;
    let reads = 0;
    Y.Map.prototype.get = function (this: Y.Map<unknown>, k: string) {
      reads++;
      return get.call(this, k);
    };
    try {
      moveBrick(doc, layerId, ids[5]!, 5 * 16 + 4, 0);
      reads = 0;
      vi.advanceTimersByTime(1000);
      // The stale-box look and the links: a few reads for the moved part
      // (it read every part's box, part number and links: thousands here).
      expect(reads).toBeLessThan(60);
    } finally {
      Y.Map.prototype.get = get;
    }
    unmount();
  });
});
