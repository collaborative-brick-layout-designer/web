// Undo after someone else changed the same thing (full review area 4, Bug
// 7): Yjs drops the step without changing anything and without the event
// the Undo button listens for, so Undo did nothing, said nothing and stayed
// lit. Now the buttons refresh and the editor says why.

import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { LOCAL_ORIGIN } from '../useLayoutDoc';
import { NOTHING_TO_UNDO, createUndoManager, undoAndPick } from '../useUndoManager';
import { useEditorStore } from '../editorStore';

function link(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'b' && Y.applyUpdate(b, u, 'a'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'a' && Y.applyUpdate(a, u, 'b'));
}

describe('undo after someone else changed the same part', () => {
  it('says there was nothing to undo, and the Undo button goes out', () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    link(alice, bob);
    const part = new Y.Map<unknown>();
    alice.transact(() => alice.getMap('layerData').set('p1', part), 'setup');
    const um = createUndoManager(alice);
    // Alice moves it; Bob moves it after her.
    alice.transact(() => (alice.getMap('layerData').get('p1') as Y.Map<unknown>).set('x', 10), LOCAL_ORIGIN);
    bob.transact(() => (bob.getMap('layerData').get('p1') as Y.Map<unknown>).set('x', 99));
    expect(um.canUndo()).toBe(true);
    let refreshed = 0;
    const changed = undoAndPick(alice, um, 'undo', () => refreshed++);
    expect(changed).toBe(false);
    expect((bob.getMap('layerData').get('p1') as Y.Map<unknown>).get('x')).toBe(99);
    expect(refreshed).toBe(1);
    expect(um.canUndo()).toBe(false);
    expect(useEditorStore.getState().notice?.text).toBe(NOTHING_TO_UNDO);
  });

  it('says nothing when the undo did something', () => {
    useEditorStore.getState().dismissNotice();
    const doc = new Y.Doc();
    const um = createUndoManager(doc);
    doc.transact(() => doc.getMap('layerData').set('p1', 1), LOCAL_ORIGIN);
    expect(undoAndPick(doc, um, 'undo')).toBe(true);
    expect(doc.getMap('layerData').has('p1')).toBe(false);
    expect(useEditorStore.getState().notice).toBeNull();
  });
});
