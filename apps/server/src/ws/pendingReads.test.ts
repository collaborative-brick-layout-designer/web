// Changes that wait in a room (ws/pending.ts) and what the layout reads as:
// reopened, for someone who joins, and through the live handler.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from '@fastify/websocket';
import { createDefaultLayoutDoc, readSidecarCache } from '@cld/ydoc';
import { appendBricks } from '@cld/modules';
import { DocSession } from './docHub.js';
import { handleMessage, type Sender } from './handler.js';
import { applyStoredUpdate } from './yjsWork.js';
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
function room(): { ask: (sv: Uint8Array) => Uint8Array; doc: Y.Doc; locked: string[]; send: (u: Uint8Array) => void; client: (id: number) => Y.Doc } {
  resetCopyBudgets();
  const s = new DocSession('fuzz-room');
  open.push(s);
  const base = createDefaultLayoutDoc();
  const locked = place(base, { placedId: 'locked', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
  base.transact(() => appendBricks(base, SHEET, [{ partNumber: 'loose.1', displayArea: { x: 200, y: 200, width: 2, height: 2 } }]));
  Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(base));
  const out: Uint8Array[] = [];
  const ws = { OPEN: 1, readyState: 1, send(b: Uint8Array) { out.push(b); }, close() { ws.readyState = 3; } };
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
    ask: (sv: Uint8Array) => {
      out.length = 0;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      encoding.writeVarUint(enc, 0);
      encoding.writeVarUint8Array(enc, sv);
      handleMessage(ws as unknown as WebSocket, s, encoding.toUint8Array(enc), 'editor', sender);
      const d = decoding.createDecoder(out[0]!);
      decoding.readVarUint(d); decoding.readVarUint(d);
      return decoding.readVarUint8Array(d);
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
/** What `change` writes in `d`, one update per step. */
function step(d: Y.Doc, change: () => void): Uint8Array {
  const sv = Y.encodeStateVector(d);
  d.transact(change);
  return Y.encodeStateAsUpdate(d, sv);
}


/** A waiting run (depends on a client nobody has) of plain values at client:clock. */
function waitingRun(client: number, clock: number, values: unknown[]): Uint8Array {
  const nobody = new Y.Doc(); nobody.clientID = 4242; nobody.getArray('zz').push(['x']);
  const d = new Y.Doc(); d.clientID = client;
  if (clock > 0) d.getArray('pad').push(Array(clock).fill(0));
  Y.applyUpdate(d, Y.encodeStateAsUpdate(nobody));
  const sv = Y.encodeStateVector(d);
  d.getArray('zz').push(values);
  return Y.encodeStateAsUpdate(d, sv);
}
function reopen(doc: Y.Doc): Y.Doc { const s = new DocSession('r'); open.push(s); s.load(Y.encodeStateAsUpdate(doc), []); return s.doc; }
function join(doc: Y.Doc): Y.Doc { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(d))); return d; }


const last = (d: Y.Doc, c: number) => Y.getState(d.store, c);

describe('values the room reads stay as they were', () => {
  it('a part', () => {
    for (const [f, other] of [['partNumber', 'other.1'], ['altitude', 99]] as const) {
      const r = room();
      // the placer's last write is this field (same value, so the lock takes it)
      const c = r.client(500); const b = withId(c, r.locked[1]!)[0]!;
      r.send(step(c, () => b.set(f, b.get(f))));
      const want = withId(r.doc, r.locked[1]!)[0]!.get(f);
      r.send(waitingRun(500, last(r.doc, 500) - 1, [other, other]));
      expect.soft(withId(reopen(r.doc), r.locked[1]!)[0]!.get(f), f + ' reopen').toBe(want);
      expect.soft(withId(join(r.doc), r.locked[1]!)[0]!.get(f), f + ' join').toBe(want);
    }
  });
  it('the sidecar', () => {
    const r = room(); const c = r.client(500);
    r.send(step(c, () => withId(c, r.locked[1]!)[0]!.set('partNumber', 'other.1'))); // put back: the server writes
    const n = last(r.doc, r.doc.clientID); expect(n).toBeGreaterThan(0);
    const list = Y.Doc.prototype.toJSON.call(r.doc) as Record<string, unknown>;
    const before = JSON.stringify(list.sidecarItems) + JSON.stringify(list.meta);
    r.send(waitingRun(r.doc.clientID, n - 1, [{ n: 1 }, { n: 1 }]));
    const a = reopen(r.doc); a.getMap('sidecarItems'); a.getMap('meta');
    const j = a.toJSON() as Record<string, unknown>;
    expect(JSON.stringify(j.sidecarItems) + JSON.stringify(j.meta)).toBe(before);
  });
  it('a grid size', () => {
    const r = room(); const c = r.client(500);
    const id = [...c.getMap<Y.Map<unknown>>('layerData').entries()].find(([, l]) => l.get('type') === 'grid')![0];
    r.send(step(c, () => c.getMap<Y.Map<unknown>>('layerData').get(id)!.set('gridSizeInStud', 16)));
    expect(r.doc.getMap<Y.Map<unknown>>('layerData').get(id)!.get('gridSizeInStud')).toBe(16);
    r.send(waitingRun(500, last(r.doc, 500) - 1, [-5, -5]));
    expect(reopen(r.doc).getMap<Y.Map<unknown>>('layerData').get(id)!.get('gridSizeInStud')).toBe(16);
  });
  it('background picture', () => {
    const r = room(); const c = r.client(500);
    r.send(step(c, () => c.getMap('meta').set('cache', { ...(c.getMap('meta').get('cache') as object), tag: 1 })));
    expect((r.doc.getMap('meta').get('cache') as Record<string, unknown>).tag).toBe(1);
    for (const v of [{ schemaVersion: 1, bbmHashSha256: '', backgroundImage: { url: 'https://other.example/x.png' } }]) {
      r.send(waitingRun(500, last(r.doc, 500) - 1, [v, v]));
      for (const d of [reopen(r.doc), join(r.doc)]) expect((readSidecarCache(d) as { backgroundImage?: { url?: string } } | null)?.backgroundImage?.url).toBeUndefined();
    }
  });
  it('a module part', () => {
    const r = room(); const c = r.client(500); const k = 'p:4:free:777';
    r.send(step(c, () => c.getMap('sidecarItems').set(k, 5)));
    expect(r.doc.getMap('sidecarItems').get(k)).toBe(5);
    r.send(waitingRun(500, last(r.doc, 500) - 1, ['text', 'text']));
    for (const d of [reopen(r.doc), join(r.doc)]) expect(d.getMap('sidecarItems').get(k)).toBe(5);
  });
  it('edits made after joining, kept and sent', () => {
    const r = room();
    r.send(waitingRun(500, 0, ['x', 'x', 'x', 'x']));
    // joins with what the server answers to step 1 (the real answer)
    const c = new Y.Doc(); c.clientID = 500;
    Y.applyUpdate(c, r.ask(Y.encodeStateVector(c)));
    for (const k of ['a', 'b', 'c']) c.getMap('edits').set(k, k);
    const want = { a: 'a', b: 'b', c: 'c' };
    expect(c.getMap('edits').toJSON(), 'what the page reads').toEqual(want);
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(c));
    expect.soft(copy.getMap('edits').toJSON(), 'kept copy').toEqual(want);
    r.send(Y.encodeStateAsUpdate(c, Y.encodeStateVector(r.doc)));
    expect.soft(r.doc.getMap('edits').toJSON(), 'server after reconnect').toEqual(want);
  });
});

describe('a layout put together from its stored rows', () => {
  it('reads as its updates left it', () => {
    const d = new Y.Doc();
    d.clientID = 500;
    const updates = ['a', 'b', 'c'].map((k) => step(d, () => d.getMap('edits').set(k, k)));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, waitingRun(500, 0, ['x', 'x', 'x', 'x']));
    for (const u of updates) applyStoredUpdate(doc, u, 'test');
    expect(join(doc).getMap('edits').toJSON()).toEqual({ a: 'a', b: 'b', c: 'c' });
  });
});
