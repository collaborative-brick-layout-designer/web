// A picked part that leaves the map (someone else deleted it, or an undo
// took it away) leaves the selection.

import { describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import { brickIdsInDoc, stillPicked } from '../mixedSelection';
import { deleteBricks, moveBrick, placeBrick } from '../mutations';
import { pickedChecker, pickedCheckStats } from '../pickedCheck';
import { createUndoManager } from '../useUndoManager';

describe('stillPicked', () => {
  it('keeps the parts still on the map and says when nothing changed', () => {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const a = placeBrick(doc, layerId, { partNumber: 'x.1', x: 0, y: 0, width: 2, height: 2 });
    const b = placeBrick(doc, layerId, { partNumber: 'x.1', x: 4, y: 0, width: 2, height: 2 });
    expect(stillPicked(brickIdsInDoc(doc), [a, b])).toBeNull();
    expect(stillPicked(brickIdsInDoc(doc), [])).toBeNull();
    deleteBricks(doc, layerId, [a]);
    expect(stillPicked(brickIdsInDoc(doc), [a, b])).toEqual([b]);
    deleteBricks(doc, layerId, [b]);
    expect(stillPicked(brickIdsInDoc(doc), [a, b])).toEqual([]);
  });
});

describe('pickedChecker', () => {
  it('says what stillPicked says, through moves, deletions and undos, and looks through the doc only when a part went', () => {
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(placeBrick(doc, layerId, { partNumber: 'x.1', x: i * 4, y: 0, width: 2, height: 2 }));
    const um = createUndoManager(doc);
    const check = pickedChecker(doc);
    const same = (sel: string[]) => expect(check(sel)).toEqual(stillPicked(brickIdsInDoc(doc), sel));
    const sel = [ids[3]!, ids[7]!, ids[20]!];
    same(sel);
    pickedCheckStats.wholeLooks = 0;
    // Moves: the picked parts are asked directly.
    for (let i = 0; i < 10; i++) {
      moveBrick(doc, layerId, ids[3]!, i, 5);
      um.stopCapturing();
      same(sel);
    }
    expect(pickedCheckStats.wholeLooks).toBe(0);
    // One goes: it's looked for, and left out.
    deleteBricks(doc, layerId, [ids[7]!]);
    um.stopCapturing();
    same(sel);
    expect(pickedCheckStats.wholeLooks).toBe(1);
    // Undone: back (a new Y.Map with the same id), found again.
    um.undo();
    same(sel);
    expect(check(sel)).toBeNull();
    deleteBricks(doc, layerId, [ids[3]!, ids[20]!]);
    same(sel);
    same([]);
  });
});
