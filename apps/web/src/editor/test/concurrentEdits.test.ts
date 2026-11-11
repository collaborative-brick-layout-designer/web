// Two people editing the same thing at once (audit 2026-10-20, track B).
// Yjs has no "move", so an edit made by deleting an entry and inserting a
// changed copy loses a concurrent edit or delete. Doc shape 2 (@cld/ydoc
// shape.ts) edits rulers, area sheets and the order of parts in place;
// removeDuplicateItems (run by every editor after someone else's change)
// still cleans up copies in docs and from builds that predate it.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mayAddDuplicates, readSidecarCache, removeDuplicateItems, repairSidecarCache } from '@cld/ydoc';
import {
  addAnchoredLabel,
  addLayer,
  addLinearRuler,
  deleteBricks,
  deleteRulerItem,
  ensureAreaLayer,
  ensureBrickLayer,
  ensureRulerLayer,
  moveArea,
  moveBrick,
  moveBricksToLayer,
  moveRulerItem,
  paintAreaCells,
  placeBrick,
  reorderBricks,
} from '../mutations';
import { createUndoManager } from '../useUndoManager';

function pair(seed: (d: Y.Doc) => void): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  seed(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const sa = Y.encodeStateVector(a);
  const sb = Y.encodeStateVector(b);
  const ua = Y.encodeStateAsUpdate(a, sb);
  const ub = Y.encodeStateAsUpdate(b, sa);
  Y.applyUpdate(b, ua);
  Y.applyUpdate(a, ub);
}

/** Whether a transaction on `d` from now may have left an item there twice (mayAddDuplicates). */
function watchDuplicates(d: Y.Doc): () => boolean {
  let may = false;
  const on = (tr: Y.Transaction) => {
    if (mayAddDuplicates(tr)) may = true;
  };
  d.on('afterTransaction', on);
  return () => {
    d.off('afterTransaction', on);
    return may;
  };
}

/**
 * What each editor does after someone else's change, then a resync: it
 * looks for copies only when the change may have made one, as the editor
 * does (useLayoutDoc.ts), so every case here also checks that gate.
 */
function settle(a: Y.Doc, b: Y.Doc): void {
  const mayA = watchDuplicates(a);
  const mayB = watchDuplicates(b);
  sync(a, b);
  if (mayA()) removeDuplicateItems(a, 'repair');
  if (mayB()) removeDuplicateItems(b, 'repair');
  sync(a, b);
}

const list = (d: Y.Doc, layerId: string, field: string): unknown[] =>
  ((d.getMap('layerData').get(layerId) as Y.Map<unknown>).get(field) as Y.Array<unknown>).toArray();
const cells = (d: Y.Doc, layerId: string) => list(d, layerId, 'areas') as { x: number; y: number; color: string }[];
const rulers = (d: Y.Doc, layerId: string) =>
  list(d, layerId, 'rulerItems').map((r) => (r instanceof Y.Map ? r.toJSON() : r)) as { id: string; point1: { x: number; y: number } }[];
const brick = { partNumber: '3001.1', width: 4, height: 2 };

describe('rulers', () => {
  it('two people moving the same ruler at once leave one ruler, the same on both, and deleting it removes it', () => {
    let L = '';
    let R = '';
    const { a, b } = pair((d) => {
      L = ensureRulerLayer(d);
      R = addLinearRuler(d, L, { x: 0, y: 0 }, { x: 10, y: 0 });
    });
    moveRulerItem(a, L, R, 5, 0);
    moveRulerItem(b, L, R, 0, 5);
    settle(a, b);
    expect(rulers(a, L)).toHaveLength(1);
    expect(rulers(b, L)).toEqual(rulers(a, L));
    deleteRulerItem(a, L, R);
    sync(a, b);
    expect(rulers(a, L)).toHaveLength(0);
    expect(rulers(b, L)).toHaveLength(0);
  });

  // A ruler is a Y.Map edited in place (doc shape 2), so the move lands
  // on the deleted entry. Repro: A deletes a ruler while B drags it.
  it('a ruler one person deletes while another moves it stays deleted', () => {
    let L = '';
    let R = '';
    const { a, b } = pair((d) => {
      L = ensureRulerLayer(d);
      R = addLinearRuler(d, L, { x: 0, y: 0 }, { x: 10, y: 0 });
    });
    deleteRulerItem(a, L, R);
    moveRulerItem(b, L, R, 0, 5);
    settle(a, b);
    expect(rulers(a, L)).toHaveLength(0);
  });
});

describe('area cells', () => {
  it('two people painting the same cell at once leave one cell, the same on both', () => {
    let L = '';
    const { a, b } = pair((d) => {
      L = ensureAreaLayer(d);
      paintAreaCells(d, L, [{ x: 1, y: 1, color: 'FF000000' }]);
    });
    paintAreaCells(a, L, [{ x: 1, y: 1, color: 'FFFF0000' }]);
    paintAreaCells(b, L, [{ x: 1, y: 1, color: 'FF00FF00' }]);
    settle(a, b);
    expect(cells(a, L)).toHaveLength(1);
    expect(cells(b, L)).toEqual(cells(a, L));
  });

  it('erasing a cell that is there twice erases it (before the copies are cleaned up)', () => {
    let L = '';
    const { a, b } = pair((d) => {
      L = ensureAreaLayer(d);
    });
    paintAreaCells(a, L, [{ x: 1, y: 1, color: 'FFFF0000' }]);
    paintAreaCells(b, L, [{ x: 1, y: 1, color: 'FF00FF00' }]);
    sync(a, b);
    expect(cells(a, L)).toHaveLength(2);
    paintAreaCells(a, L, [{ x: 1, y: 1, color: null }]);
    expect(cells(a, L)).toEqual([]);
  });

  it('the same cell twice in one stroke paints it once with the last color, leaving the others alone', () => {
    const doc = new Y.Doc();
    const L = ensureAreaLayer(doc);
    paintAreaCells(doc, L, [
      { x: 0, y: 0, color: 'FF0000FF' },
      { x: 1, y: 1, color: 'FF000000' },
    ]);
    paintAreaCells(doc, L, [
      { x: 1, y: 1, color: 'FFFF0000' },
      { x: 1, y: 1, color: 'FF00FF00' },
    ]);
    expect(cells(doc, L).map((c) => `${c.x},${c.y},${c.color}`).sort()).toEqual(['0,0,FF0000FF', '1,1,FF00FF00']);
  });

  // Moving a sheet sets its cellOffset (doc shape 2): one wins, cells once.
  it('two people moving the same area sheet at once leave each cell once', () => {
    let L = '';
    const { a, b } = pair((d) => {
      L = ensureAreaLayer(d);
      paintAreaCells(d, L, [{ x: 1, y: 1, color: 'FF000000' }]);
    });
    moveArea(a, L, 1, 0);
    moveArea(b, L, 0, 1);
    settle(a, b);
    expect(cells(a, L)).toHaveLength(1);
  });
});

describe('parts', () => {
  // Bring to Front / Send to Back set z on the same entry (doc shape 2).
  it('a part one person deletes while another brings it to front stays deleted', () => {
    let L = '';
    let p = '';
    const { a, b } = pair((d) => {
      L = ensureBrickLayer(d);
      p = placeBrick(d, L, { ...brick, x: 0, y: 0 });
      placeBrick(d, L, { ...brick, x: 10, y: 0 });
    });
    deleteBricks(a, L, [p]);
    reorderBricks(b, [p], 'front');
    settle(a, b);
    expect(list(a, L, 'bricks')).toHaveLength(1);
  });

  it('a part one person drags while another brings it to front keeps the drag', () => {
    let L = '';
    let p = '';
    const { a, b } = pair((d) => {
      L = ensureBrickLayer(d);
      p = placeBrick(d, L, { ...brick, x: 0, y: 0 });
      placeBrick(d, L, { ...brick, x: 10, y: 0 });
    });
    moveBrick(a, L, p, 50, 50);
    reorderBricks(b, [p], 'front');
    settle(a, b);
    const moved = (list(a, L, 'bricks') as Y.Map<unknown>[]).find((m) => m.get('id') === p)!;
    expect((moved.get('displayArea') as { x: number }).x).not.toBe(0);
  });
});

// The look through every item for copies (removeDuplicateItems) runs only
// after a change that may have made one (mayAddDuplicates): on a layout of
// 7,520 parts it took about 38 ms after each of someone else's moves.
describe('which changes may leave an item there twice', () => {
  /** Whether `change`, as it arrives in someone else's tab, may have. */
  function arrivesAsInsert(seed: (d: Y.Doc) => void, change: (d: Y.Doc) => void): boolean {
    const { a, b } = pair(seed);
    change(a);
    const may = watchDuplicates(b);
    sync(a, b);
    return may();
  }
  let L = '';
  let L2 = '';
  let p = '';
  const seed = (d: Y.Doc) => {
    L = ensureBrickLayer(d);
    p = placeBrick(d, L, { ...brick, x: 0, y: 0 });
    placeBrick(d, L, { ...brick, x: 10, y: 0 });
  };

  it('not a part moved, or brought to front, in place', () => {
    expect(arrivesAsInsert(seed, (d) => moveBrick(d, L, p, 50, 50))).toBe(false);
    expect(arrivesAsInsert(seed, (d) => reorderBricks(d, [p], 'front'))).toBe(false);
  });

  it('a part placed, deleted, or moved to another sheet', () => {
    expect(arrivesAsInsert(seed, (d) => placeBrick(d, L, { ...brick, x: 20, y: 0 }))).toBe(true);
    expect(arrivesAsInsert(seed, (d) => deleteBricks(d, L, [p]))).toBe(true);
    const two = (d: Y.Doc) => {
      seed(d);
      L2 = addLayer(d, 'brick');
    };
    expect(arrivesAsInsert(two, (d) => moveBricksToLayer(d, new Map([[L, [p]]]), L2))).toBe(true);
  });

  it('a new sheet, a ruler added and a cell painted, but not a ruler moved in place', () => {
    expect(arrivesAsInsert(seed, (d) => addLayer(d, 'brick'))).toBe(true);
    let R = '';
    let ruler = '';
    const withRuler = (d: Y.Doc) => {
      R = ensureRulerLayer(d);
      ruler = addLinearRuler(d, R, { x: 0, y: 0 }, { x: 10, y: 0 });
    };
    expect(arrivesAsInsert(withRuler, (d) => addLinearRuler(d, R, { x: 0, y: 5 }, { x: 10, y: 5 }))).toBe(true);
    expect(arrivesAsInsert(withRuler, (d) => moveRulerItem(d, R, ruler, 5, 0))).toBe(false);
    let A = '';
    const withArea = (d: Y.Doc) => {
      A = ensureAreaLayer(d);
    };
    expect(arrivesAsInsert(withArea, (d) => paintAreaCells(d, A, [{ x: 1, y: 1, color: 'FF000000' }]))).toBe(true);
  });

  // A build from before doc shape 2 moves a part to the front by deleting
  // it and inserting a copy: two of those at once are still cleaned up.
  it('two copies of a part, from builds that reorder by delete and insert, are still found', () => {
    const { a, b } = pair(seed);
    for (const d of [a, b]) {
      const arr = (d.getMap('layerData').get(L) as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
      d.transact(() => {
        const i = arr.toArray().findIndex((m) => m.get('id') === p);
        const copy = new Y.Map<unknown>(Object.entries(arr.get(i).toJSON() as Record<string, unknown>));
        arr.delete(i, 1);
        arr.push([copy]);
      });
    }
    settle(a, b);
    expect((list(a, L, 'bricks') as Y.Map<unknown>[]).filter((m) => m.get('id') === p)).toHaveLength(1);
    expect(list(b, L, 'bricks')).toHaveLength(2);
  });
});

describe('undo with someone else editing', () => {
  const label = (id: string) => ({
    id, text: id, font: { family: 'Arial', size: 10, style: 'Regular' }, color: { known: true, argb: 0, name: 'Black' },
    kind: 'World' as never, targetId: '', offset: { x: 0, y: 0 }, rot: 0, minZoom: 0,
  });
  const labels = (d: Y.Doc) => ((readSidecarCache(d)?.anchoredLabels ?? []) as { id: string }[]).map((l) => l.id).sort();

  it('undoing my move keeps the move someone made after it', () => {
    let L = '';
    let p = '';
    const { a, b } = pair((d) => {
      L = ensureBrickLayer(d);
      p = placeBrick(d, L, { ...brick, x: 0, y: 0 });
    });
    const undo = createUndoManager(a);
    moveBrick(a, L, p, 20, 20);
    sync(a, b);
    moveBrick(b, L, p, 40, 40);
    sync(a, b);
    undo.undo();
    sync(a, b);
    const area = (list(a, L, 'bricks')[0] as Y.Map<unknown>).get('displayArea') as { x: number };
    expect(area.x).toBe(38);
  });

  // sidecarItems is in the undo manager's scope: undoing my label takes
  // its key back, and readers merge from the keys.
  it('undoing my label removes it after someone else added one at the same time', () => {
    const { a, b } = pair((d) => {
      ensureBrickLayer(d);
      addAnchoredLabel(d, label('L0'));
    });
    const undo = createUndoManager(a);
    addAnchoredLabel(a, label('LA'));
    addAnchoredLabel(b, label('LB'));
    sync(a, b);
    repairSidecarCache(a, 'repair');
    repairSidecarCache(b, 'repair');
    sync(a, b);
    expect(labels(a)).toEqual(['L0', 'LA', 'LB']);
    undo.undo();
    sync(a, b);
    expect(labels(a)).toEqual(['L0', 'LB']);
  });
});
