// Offline changes someone else's replaced are counted (full review area 4, Unclear UI 3).

import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { OfflineEditWatch, replacedText } from '../offlineEdits';

function layoutWith(ids: string[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const layer = new Y.Map<unknown>();
    const bricks = new Y.Array<Y.Map<unknown>>();
    for (const id of ids) {
      const b = new Y.Map<unknown>();
      b.set('id', id);
      b.set('x', 0);
      bricks.push([b]);
    }
    layer.set('bricks', bricks);
    doc.getMap('layerData').set('L', layer);
  });
  return doc;
}
const brick = (doc: Y.Doc, i: number) => ((doc.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).get(i);

describe('OfflineEditWatch', () => {
  it('counts the parts changed offline that someone else changed or removed', () => {
    const mine = layoutWith(['a', 'b', 'c']);
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
    const watch = new OfflineEditWatch();
    // (Only this page's own changes, as useLayoutDoc notes them.)
    mine.on('afterTransaction', (tr: Y.Transaction) => tr.origin === 'me' && watch.note(tr));
    // Offline: I move a, b and c.
    for (let i = 0; i < 3; i++) mine.transact(() => brick(mine, i).set('x', 10), 'me');
    expect(watch.size).toBe(3);
    // Meanwhile they delete b and move c.
    theirs.transact(() => ((theirs.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<unknown>).delete(1, 1));
    theirs.transact(() => brick(theirs, 1).set('x', 99));
    // Back in step (their clientID decides who wins c; b is gone either way).
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs));
    const { replaced, of } = watch.settle(mine);
    expect(of).toBe(3);
    const cNow = brick(mine, 1).get('x');
    expect(replaced).toBe(cNow === 10 ? 1 : 2);
    expect(watch.size).toBe(0);
  });

  it('words it plainly', () => {
    expect(replacedText(1, 1)).toBe("Your offline change was replaced by someone else's change to the same part.");
    expect(replacedText(2, 5)).toBe("2 of your 5 offline changes were replaced by someone else's changes to the same parts.");
  });
});
