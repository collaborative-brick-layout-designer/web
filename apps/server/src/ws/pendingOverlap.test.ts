// What waits in a room for changes it doesn't have, next to the changes it
// has: in a snapshot, and for someone who joins (ws/pending.ts trimPending).

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocSession } from './docHub.js';
import { pendingBytes, restorePending, savePending } from './pending.js';

let open: DocSession[] = [];
afterEach(() => {
  for (const s of open) {
    s.awareness.destroy();
    s.doc.destroy();
  }
  open = [];
});
function session(): DocSession {
  const s = new DocSession('overlap');
  open.push(s);
  return s;
}

const doc = (id: number): Y.Doc => {
  const d = new Y.Doc();
  d.clientID = id;
  return d;
};

/** A run of five changes of client `id` that waits for a change of a client nobody has. */
function waitingChange(id: number, clock = 0): Uint8Array {
  const nobody = doc(4242);
  nobody.getArray('list').push(['never sent']);
  const d = doc(id);
  if (clock > 0) d.getMap('pad').set('text', new Y.Text('x'.repeat(clock - 1)));
  expect(Y.getState(d.store, id)).toBe(clock);
  Y.applyUpdate(d, Y.encodeStateAsUpdate(nobody));
  const before = Y.encodeStateVector(d);
  d.getArray('list').push(['waits', 'waits', 'waits', 'waits', 'waits']);
  return Y.encodeStateAsUpdate(d, before);
}

/** A person's edits: three keys of a map, written by client `id`. */
function edits(id: number): Uint8Array[] {
  const d = doc(id);
  const out: Uint8Array[] = [];
  d.on('update', (u: Uint8Array) => out.push(u));
  for (const k of ['a', 'b', 'c']) d.getMap('edits').set(k, k);
  expect(Y.getState(d.store, id)).toBe(3);
  return out;
}
const ALL = { a: 'a', b: 'b', c: 'c' };

/** What the room reads as once opened from its snapshot. */
function reopened(room: Y.Doc): unknown {
  const again = session();
  again.load(Y.encodeStateAsUpdate(room), []);
  return again.doc.getMap('edits').toJSON();
}
/** What someone who joins now reads. */
function joined(room: Y.Doc): unknown {
  const d = doc(77);
  Y.applyUpdate(d, Y.encodeStateAsUpdate(room, Y.encodeStateVector(d)));
  return d.getMap('edits').toJSON();
}

describe('changes that wait', () => {
  it('and edits that arrive later', () => {
    const { doc: room } = session();
    Y.applyUpdate(room, waitingChange(9));
    expect(pendingBytes(room)).toBeGreaterThan(0);
    for (const u of edits(9)) Y.applyUpdate(room, u);
    expect(room.getMap('edits').toJSON()).toEqual(ALL);
    expect(reopened(room)).toEqual(ALL);
    expect(joined(room)).toEqual(ALL);
  });

  it('and edits the room already has', () => {
    const { doc: room } = session();
    for (const u of edits(9)) Y.applyUpdate(room, u);
    Y.applyUpdate(room, waitingChange(9));
    expect(reopened(room)).toEqual(ALL);
    expect(joined(room)).toEqual(ALL);
    expect(pendingBytes(room)).toBe(0);
  });

  it('and the server\'s own steps', () => {
    const { doc: room } = session();
    Y.applyUpdate(room, waitingChange(room.clientID));
    for (const k of ['a', 'b', 'c']) room.getMap('edits').set(k, k);
    expect(reopened(room)).toEqual(ALL);
    expect(joined(room)).toEqual(ALL);
  });

  it('and edits, put back as they were', () => {
    const { doc: room } = session();
    Y.applyUpdate(room, waitingChange(9));
    const before = savePending(room);
    for (const u of edits(9)) Y.applyUpdate(room, u);
    restorePending(room, before);
    expect(reopened(room)).toEqual(ALL);
  });

  it('keep waiting when the room has none of them, and land when what they wait for arrives', () => {
    const { doc: room } = session();
    for (const u of edits(9)) Y.applyUpdate(room, u);
    Y.applyUpdate(room, waitingChange(9, 3));
    Y.applyUpdate(room, waitingChange(8));
    expect(pendingBytes(room)).toBeGreaterThan(0);
    const other = doc(5);
    other.getMap('edits').set('d', 'd');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(other));
    const nobody = doc(4242);
    nobody.getArray('list').push(['never sent']);
    const again = session();
    again.load(Y.encodeStateAsUpdate(room), []);
    for (const r of [room, again.doc]) {
      Y.applyUpdate(r, Y.encodeStateAsUpdate(nobody));
      expect(r.getArray('list').toArray()).toEqual(['never sent', ...Array(10).fill('waits')]);
      expect(r.getMap('edits').toJSON()).toEqual({ ...ALL, d: 'd' });
    }
  });
});
