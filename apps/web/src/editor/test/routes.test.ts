// The editor's routes (trains design 6.2): saved routes read back whole, new
// ones take the next free color, edits are undo steps, problems in words.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readRoutesFromDoc } from '@cld/ydoc';
import { asRoute, newRoute, problemText, removeRoute, ROUTE_COLORS, saveRoute } from '../routes';
import { createUndoManager } from '../useUndoManager';

const at = { brick: 'A', from: 0, to: 1, s: 2 };
const found = { steps: [{ brick: 'A', from: 0, to: 1 }], length: 10, switches: {}, turnsAround: [] };

describe('editor routes', () => {
  it('read back whole, with defaults for what is missing and unknown fields kept', () => {
    const r = asRoute({ id: 'r1', name: 'Main', from: at, future: 3 });
    expect(r).toMatchObject({ id: 'r1', name: 'Main', train: null, from: at, to: { brick: '', from: 0, to: 1, s: 0 }, via: [], steps: [], color: ROUTE_COLORS[0], future: 3 });
  });

  it('a new route takes the first color not in use', () => {
    const first = newRoute('One', at, at, [], found, []);
    const second = newRoute('Two', at, at, [at], found, [first]);
    expect(first.color).toBe(ROUTE_COLORS[0]);
    expect(second.color).toBe(ROUTE_COLORS[1]);
    expect(second.via).toEqual([{ at, reverse: false }]);
    expect(first.id).not.toBe(second.id);
  });

  it('saving, renaming and deleting are each one undo step', () => {
    const doc = new Y.Doc();
    const undo = createUndoManager(doc);
    const r = newRoute('One', at, at, [], found, []);
    saveRoute(doc, r);
    undo.stopCapturing();
    saveRoute(doc, { ...r, name: 'Renamed' });
    undo.stopCapturing();
    removeRoute(doc, r.id);
    expect(readRoutesFromDoc(doc)).toEqual([]);
    undo.undo();
    expect(readRoutesFromDoc(doc).map((x) => x.name)).toEqual(['Renamed']);
    undo.undo();
    expect(readRoutesFromDoc(doc).map((x) => x.name)).toEqual(['One']);
  });

  it('says what stops a search in plain words', () => {
    expect(problemText('noTrack')).toMatch(/no track joining/);
    expect(problemText('turnAround')).toMatch(/turn around/);
  });
});
