// An import into the open layout goes down as the editor's own change: one
// Undo takes all of it back, Redo brings it back, and a collaborator's copy
// of the layout gets it through the editor's sync.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDefaultLayoutDoc } from '@cld/ydoc';
import { createUndoManager } from '../../editor/useUndoManager';
import { partToPlace, partsSheetFor, placeImported } from '../placeImport';
import type { ToPlace } from '../importApi';

const bricksOn = (doc: Y.Doc, sheet: string) => ((doc.getMap('layerData').get(sheet) as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray();
const groupsOn = (doc: Y.Doc, sheet: string) => ((doc.getMap('layerData').get(sheet) as Y.Map<unknown>).get('groups') as Y.Array<Y.Map<unknown>>).toArray();

const yard: ToPlace = {
  bricks: [
    { partNumber: '3001.8', displayArea: { x: 0, y: 0, width: 2, height: 4 }, myGroup: 'g1' },
    { partNumber: '3001.8', displayArea: { x: 8, y: 0, width: 2, height: 4 }, myGroup: 'g1' },
    { partNumber: '3003.8', displayArea: { x: 4, y: 6, width: 2, height: 2 } },
  ],
  groups: [{ id: 'g1', partNumber: 'Yard' }],
};

describe('placing an import in the open layout', () => {
  it('puts it on the sheet, its middle on the view’s middle, with its sets as new sets', () => {
    const doc = createDefaultLayoutDoc();
    const sheet = partsSheetFor(doc, null)!;
    const { ids, sheetId } = placeImported(doc, sheet, { x: 100, y: 50 }, yard);
    expect(sheetId).toBe(sheet);
    const bricks = bricksOn(doc, sheet);
    expect(bricks.map((b) => b.get('id'))).toEqual(ids);
    expect(ids).toHaveLength(3);
    // The centres averaged (5, 4) before: now (100, 50).
    const cx = bricks.reduce((n, b) => n + (b.get('displayArea') as { x: number; width: number }).x + 1, 0) / 3;
    expect(cx).toBeCloseTo(100);
    const groups = groupsOn(doc, sheet);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.get('id')).not.toBe('g1');
    expect(bricks[0]!.get('myGroup')).toBe(groups[0]!.get('id'));
    expect(bricks[2]!.get('myGroup')).toBe('');
  });

  it('is one Undo step, after an edit made just before it; Redo brings it back', () => {
    const doc = createDefaultLayoutDoc();
    const undo = createUndoManager(doc);
    const sheet = partsSheetFor(doc, null)!;
    // Something the person did a moment before: it must not go with the import.
    placeImported(doc, sheet, { x: 0, y: 0 }, { bricks: [{ partNumber: '3001.8', displayArea: { x: 0, y: 0, width: 2, height: 4 } }], groups: [] });
    undo.stopCapturing();
    placeImported(doc, sheet, { x: 0, y: 0 }, yard);
    undo.stopCapturing();
    expect(bricksOn(doc, sheet)).toHaveLength(4);
    undo.undo();
    expect(bricksOn(doc, sheet)).toHaveLength(1);
    expect(groupsOn(doc, sheet)).toHaveLength(0);
    undo.redo();
    expect(bricksOn(doc, sheet)).toHaveLength(4);
    expect(groupsOn(doc, sheet)).toHaveLength(1);
  });

  it('reaches a collaborator’s copy of the layout as an ordinary update', () => {
    const mine = createDefaultLayoutDoc();
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
    mine.on('update', (u: Uint8Array) => Y.applyUpdate(theirs, u));
    const sheet = partsSheetFor(mine, null)!;
    const { ids } = placeImported(mine, sheet, { x: 0, y: 0 }, yard);
    expect(bricksOn(theirs, sheet).map((b) => b.get('id'))).toEqual(ids);
  });

  it('uses the first parts sheet when the one picked is gone, and places nothing without one', () => {
    const doc = createDefaultLayoutDoc();
    const first = partsSheetFor(doc, null)!;
    expect(placeImported(doc, 'gone', { x: 0, y: 0 }, yard).sheetId).toBe(first);
    const bare = new Y.Doc();
    expect(placeImported(bare, 'gone', { x: 0, y: 0 }, yard)).toEqual({ sheetId: null, ids: [] });
  });

  it('a saved part is one brick, centered on its own middle', () => {
    expect(partToPlace({ part: { id: 'p1', partNumber: 'Loop', displayName: 'Loop' }, widthStuds: 8, heightStuds: 2 })).toEqual({
      bricks: [{ partNumber: 'custom:p1', displayArea: { x: -4, y: -1, width: 8, height: 2 }, orientation: 0 }],
      groups: [],
    });
    expect(partToPlace({ part: null, widthStuds: 8, heightStuds: 2 })).toBeNull();
  });
});
