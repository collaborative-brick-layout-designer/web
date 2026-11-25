// The lock on shared modules, through the live handler (ws/sharedGuard.ts):
// its parts read the same after updates of unusual shapes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from '@fastify/websocket';
import { createDefaultLayoutDoc, readSidecarCache } from '@cld/ydoc';
import { appendBricks, sharedModulesIn } from '@cld/modules';
import { DocSession } from './docHub.js';
import { handleMessage, type Sender } from './handler.js';
import { decodeIncoming } from './decoded.js';
import { newPace, resetCopyBudgets } from './pacing.js';
import { SHEET, contents, place } from '../test/sharedWorld.js';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const V1 = contents([{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }]);

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

let open: DocSession[] = [];
afterEach(() => {
  for (const s of open) {
    s.awareness.destroy();
    s.doc.destroy();
  }
  open = [];
});

/** A room with one shared module of two parts, and someone editing it. */
function room(): { doc: Y.Doc; locked: string[]; send: (u: Uint8Array) => void; client: (id: number) => Y.Doc } {
  resetCopyBudgets();
  const s = new DocSession('fuzz-room');
  open.push(s);
  const base = createDefaultLayoutDoc();
  const locked = place(base, { placedId: 'locked', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
  base.transact(() => appendBricks(base, SHEET, [{ partNumber: 'loose.1', displayArea: { x: 200, y: 200, width: 2, height: 2 } }]));
  Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(base));
  const ws = { OPEN: 1, readyState: 1, send() {}, close() { ws.readyState = 3; } };
  s.clients.add(ws);
  s.clientUsers.set(ws, 'alice');
  const sender: Sender = { layoutId: s.layoutId, userId: 'alice', client: 't', noted: new Set(), pace: newPace() };
  return {
    doc: s.doc,
    locked,
    send: (u) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      handleMessage(ws as unknown as WebSocket, s, encoding.toUint8Array(enc), 'editor', sender);
    },
    client: (id) => {
      const d = new Y.Doc();
      d.clientID = id;
      Y.applyUpdate(d, Y.encodeStateAsUpdate(s.doc));
      return d;
    },
  };
}

const sheet = (d: Y.Doc) => d.getMap<Y.Map<unknown>>('layerData').get(SHEET)!;
const bricks = (d: Y.Doc) => sheet(d).get('bricks') as Y.Array<Y.Map<unknown>>;
const withId = (d: Y.Doc, id: string) => bricks(d).toArray().filter((b) => b.get('id') === id);
/** What `change` writes in `d`. */
function step(d: Y.Doc, change: () => void): Uint8Array {
  const sv = Y.encodeStateVector(d);
  d.transact(change);
  return Y.encodeStateAsUpdate(d, sv);
}
/** An update without its deletions. */
const noDeletes = (u: Uint8Array): Uint8Array => {
  const d = Y.decodeUpdate(u);
  expect(d.structs.length).toBeGreaterThan(0);
  const ds = [...d.ds.clients.values()].flat().length;
  if (ds === 0) return u;
  // Where its delete set starts, an empty one instead.
  for (let cut = 1; cut < u.length; cut++) {
    const t = new Uint8Array([...u.slice(0, cut), 0]);
    try {
      const r = Y.decodeUpdate(t);
      if (r.structs.length === d.structs.length && r.ds.clients.size === 0) return t;
    } catch { /* not there */ }
  }
  throw new Error('no cut');
};
function copyOf(b: Y.Map<unknown>, patch: Record<string, unknown>): Y.Map<unknown> {
  const n = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ ...(b.toJSON() as object), ...patch })) n.set(k, v);
  return n;
}
const pnOf = (d: Y.Doc, id: string) => withId(d, id).map((b) => b.get('partNumber'));

describe('a shared module stays as it was', () => {
  it('one of each part', () => {
    const { doc, locked, send, client } = room();
    const c = client(9001);
    send(step(c, () => bricks(c).push([copyOf(withId(c, locked[1]!)[0]!, { partNumber: 'other.1' })])));
    expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
  });
  it('one of each part, over two updates', () => {
    const { doc, locked, send, client } = room();
    const c = client(9001);
    send(step(c, () => bricks(c).push([copyOf(withId(c, locked[1]!)[0]!, {})])));
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    send(step(c, () => withId(c, locked[1]!)[0]!.set('partNumber', 'other.1')));
    expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
  });
  it('updates out of order', () => {
    const { doc, locked, send, client } = room();
    const c = client(9001);
    const first = step(c, () => bricks(c).get(2).set('altitude', 3));
    const second = step(c, () => withId(c, locked[1]!)[0]!.set('partNumber', 'other.1'));
    send(noDeletes(second));
    send(first);
    expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
  });
  it('a parts list written again', () => {
    const { doc, locked, send, client } = room();
    const c = client(9001);
    send(noDeletes(step(c, () => {
      const list = new Y.Array<Y.Map<unknown>>();
      list.push(bricks(c).toArray().map((b) => copyOf(b, b.get('id') === locked[1] ? { partNumber: 'other.1' } : {})));
      sheet(c).set('bricks', list);
    })));
    expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
  });
  it('a sheet written again', () => {
    const { doc, locked, send } = room();
    const c = new Y.Doc();
    c.clientID = 4294967290;
    const l = new Y.Map<unknown>();
    const list = new Y.Array<Y.Map<unknown>>();
    for (const [k, v] of sheet(doc).entries()) if (!(v instanceof Y.AbstractType)) l.set(k, v);
    list.push(bricks(doc).toArray().map((b) => copyOf(b, b.get('id') === locked[1] ? { partNumber: 'other.1' } : {})));
    l.set('bricks', list);
    c.getMap('layerData').set(SHEET, l);
    send(Y.encodeStateAsUpdate(c));
    expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
  });
  it('two blocks of one client, in either order', () => {
    for (const swap of [false, true]) {
      const { doc, locked, send, client } = room();
      const c = client(9001);
      const bad = noDeletes(step(c, () => withId(c, locked[1]!)[0]!.set('partNumber', 'other.1')));
      // The same client's block again: clock 0 as something gone (1 block, 1 struct, client, clock 0, GC of 1).
      const gone = new Y.Doc();
      gone.clientID = 9001;
      gone.getMap('m').set('k', 1);
      const other = Y.encodeStateAsUpdate(gone);
      const a = bad.subarray(1, bad.length - 1);
      const b = other.subarray(1, other.length - 1);
      const u = new Uint8Array([2, ...(swap ? [...b, ...a] : [...a, ...b]), 0]);
      expect(decodeIncoming(u)!.overlapping).toBe(true);
      send(u);
      expect(pnOf(doc, locked[1]!)).toEqual(['b.1']);
    }
  });
  it('a sheet taken off the list', () => {
    const { doc, locked, send, client } = room();
    const c = client(9001);
    c.transact(() => {
      const l = new Y.Map<unknown>();
      l.set('id', 'other');
      l.set('type', 'brick');
      l.set('bricks', new Y.Array());
      c.getMap('layerData').set('other', l);
      c.getArray('layers').push(['other']);
    });
    send(Y.encodeStateAsUpdate(c, Y.encodeStateVector(doc)));
    send(
      step(c, () => {
        const order = c.getArray<string>('layers');
        order.delete(order.toArray().indexOf(SHEET), 1);
        bricks(c).delete(1, 1);
      }),
    );
    expect(sharedModulesIn(readSidecarCache(doc))[0]!.members).toEqual(locked);
    const here = (doc.getMap<Y.Map<unknown>>('layerData').get('other')!.get('bricks') as Y.Array<Y.Map<unknown>>).toArray();
    expect(here.map((b) => b.get('id')).sort()).toEqual([...locked].sort());
  });
});
