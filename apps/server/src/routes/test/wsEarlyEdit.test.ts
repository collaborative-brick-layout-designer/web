// An edit that reaches the room before an earlier edit of the same client
// it follows (an edit made as a connection comes back, sent before the
// sync step 2 with the offline ones; one editor's messages over two
// sockets), over real sockets:
//   - a drawing setting's change (the new value, and the deletion of the
//     old one) is held back whole (ws/held.ts): nothing of it is applied,
//     stored or relayed, so the sheet never lacks the value; once the
//     earlier edit arrives it is applied and relayed, and the connection
//     stays open;
//   - the same when the earlier edit comes over another socket;
//   - a value out of range held this way is still refused: at once when
//     the room can tell, else when it lands;
//   - what a room holds back is bounded (count and bytes) and goes when the
//     connection closes or the room unloads.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { MAX_HELD_UPDATES } from '../../ws/held.js';
import { MAX_PENDING_BYTES, pendingBytes } from '../../ws/pending.js';
import { Peer } from './wsPeer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Raw {
  ws: WebSocket;
  closed: Promise<[number, string]>;
}

function rawSocket(port: number, layoutId: string, cookieStr: string): Promise<Raw> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, { headers: { cookie: cookieStr } });
  ws.on('error', () => {});
  const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
  // Open once the server has attached it (its sync step 1 is the first message).
  return new Promise((resolveOpen, reject) => {
    ws.once('message', () => resolveOpen({ ws, closed }));
    ws.once('error', reject);
  });
}

function updateMsg(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

const grid = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('layerData').get('grid-1')!;

describe('an edit arriving before the edit it follows', () => {
  let app: FastifyInstance;
  let port: number;
  let cookieStr: string;
  const opened: string[] = [];

  beforeEach(async () => {
    resetDb();
    app = Fastify();
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    cookieStr = (await loginAs(app, 'early-edit@example.com')).cookie;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function create(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload: { title: 'Yard' } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    opened.push(id);
    return id;
  }

  const room = (id: string) => docHub.peek(id)!;
  const rows = (id: string) => db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id)).all().length;

  /** An editor's copy of the room, and the updates its edits make. */
  function editorOf(id: string, clientId: number): { doc: Y.Doc; edits: Uint8Array[] } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room(id).doc));
    doc.clientID = clientId;
    const edits: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => edits.push(u));
    return { doc, edits };
  }

  /** A desktop watching the room: every cell size it ever had. */
  async function watcher(id: string): Promise<{ peer: Peer; sizes: unknown[] }> {
    const peer = new Peer(port, id, cookieStr, new Y.Doc());
    await peer.synced;
    const sizes: unknown[] = [grid(peer.doc).get('gridSizeInStud')];
    peer.doc.on('update', () => sizes.push(grid(peer.doc).get('gridSizeInStud')));
    return { peer, sizes };
  }

  it('holds a new cell size back until the edit before it arrives, then applies and relays it, and the connection stays open', async () => {
    const id = await create();
    const sock = await rawSocket(port, id, cookieStr);
    const { peer, sizes } = await watcher(id);
    const a = editorOf(id, 4100);
    a.doc.getMap('meta').set('note', 'first edit');
    a.doc.transact(() => grid(a.doc).set('gridSizeInStud', 48));
    const [first, second] = a.edits;
    const stored = rows(id);

    sock.ws.send(updateMsg(second!));
    await sleep(150);
    // Held whole: the room keeps its cell size, nothing waits in Yjs, nothing is stored or relayed.
    expect(room(id).held.count).toBe(1);
    expect(grid(room(id).doc).get('gridSizeInStud')).toBe(96);
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(rows(id)).toBe(stored);
    expect(sizes.every((s) => s === 96)).toBe(true);

    sock.ws.send(updateMsg(first!));
    for (let i = 0; i < 50 && grid(peer.doc).get('gridSizeInStud') !== 48; i++) await sleep(20);
    expect(grid(room(id).doc).get('gridSizeInStud')).toBe(48);
    expect(room(id).doc.getMap('meta').get('note')).toBe('first edit');
    expect(room(id).held.count).toBe(0);
    expect(Y.encodeStateVector(room(id).doc)).toEqual(Y.encodeStateVector(a.doc));
    // The desktop got both, in order, and never saw the grid without a size.
    expect(grid(peer.doc).get('gridSizeInStud')).toBe(48);
    expect(peer.doc.getMap('meta').get('note')).toBe('first edit');
    expect(sizes.every((s) => s === 96 || s === 48)).toBe(true);
    for (let i = 0; i < 50 && rows(id) === stored; i++) await sleep(20);
    expect(rows(id)).toBeGreaterThan(stored);
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
    sock.ws.close();
    await peer.leave();
  });

  it('lands it when the edit before it comes over the same person’s other socket', async () => {
    const id = await create();
    const early = await rawSocket(port, id, cookieStr);
    const other = await rawSocket(port, id, cookieStr);
    const a = editorOf(id, 4200);
    a.doc.getMap('meta').set('note', 'first edit');
    a.doc.transact(() => grid(a.doc).set('transparency', 40));
    early.ws.send(updateMsg(a.edits[1]!));
    await sleep(100);
    expect(room(id).held.count).toBe(1);
    expect(grid(room(id).doc).get('transparency')).toBe(100);
    other.ws.send(updateMsg(a.edits[0]!));
    for (let i = 0; i < 50 && grid(room(id).doc).get('transparency') !== 40; i++) await sleep(20);
    expect(grid(room(id).doc).get('transparency')).toBe(40);
    expect(room(id).held.count).toBe(0);
    expect(early.ws.readyState).toBe(WebSocket.OPEN);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
    early.ws.close();
    other.ws.close();
  });

  it('refuses a value out of range held this way: at once when the room can tell, else when it lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();

    // A cell size of 0 for the room's grid: the room can tell now.
    const sock = await rawSocket(port, id, cookieStr);
    const a = editorOf(id, 4300);
    a.doc.getMap('meta').set('note', 'first edit');
    a.doc.transact(() => grid(a.doc).set('gridSizeInStud', 0));
    sock.ws.send(updateMsg(a.edits[1]!));
    expect(await sock.closed).toEqual([1008, 'unreadable_update']);
    expect(room(id).held.count).toBe(0);
    expect(grid(room(id).doc).get('gridSizeInStud')).toBe(96);

    // A cell size of 0 for a sheet the edit before it adds: told when it lands.
    const sock2 = await rawSocket(port, id, cookieStr);
    const b = editorOf(id, 4400);
    b.doc.transact(() => {
      const l = new Y.Map<unknown>();
      l.set('id', 'grid-2');
      l.set('type', 'grid');
      l.set('gridSizeInStud', 32);
      b.doc.getMap('layerData').set('grid-2', l);
      b.doc.getArray('layers').push(['grid-2']);
    });
    b.doc.transact(() => {
      grid(b.doc).set('transparency', 50);
      (b.doc.getMap('layerData').get('grid-2') as Y.Map<unknown>).set('gridSizeInStud', 0);
    });
    sock2.ws.send(updateMsg(b.edits[1]!));
    await sleep(100);
    expect(room(id).held.count).toBe(1);
    sock2.ws.send(updateMsg(b.edits[0]!));
    expect(await sock2.closed).toEqual([1008, 'unreadable_update']);
    // The sheet it added stays as it was added; the refused change is nowhere.
    expect((room(id).doc.getMap('layerData').get('grid-2') as Y.Map<unknown>).get('gridSizeInStud')).toBe(32);
    expect(grid(room(id).doc).get('transparency')).toBe(100);
    expect(room(id).held.count).toBe(0);
  });

  it('holds back a bounded amount, and lets it go when the connection closes or the room unloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heldFull = () => warn.mock.calls.filter((c) => String(c[0]).includes('waiting for the edits before them')).length;
    const id = await create();
    // Values another editor wrote, for this one to change.
    const setup = new Peer(port, id, cookieStr, new Y.Doc());
    await setup.synced;
    setup.doc.transact(() => {
      for (let i = 0; i <= MAX_HELD_UPDATES; i++) setup.doc.getMap('meta').set(`k${i}`, 0);
    });
    for (let i = 0; i < 50 && room(id).doc.getMap('meta').get(`k${MAX_HELD_UPDATES}`) !== 0; i++) await sleep(20);
    await setup.leave();

    // Each a change of a value the room has, all after an edit never sent.
    const sock = await rawSocket(port, id, cookieStr);
    const a = editorOf(id, 4500);
    a.doc.getMap('meta').set('note', 'never sent');
    for (let i = 0; i <= MAX_HELD_UPDATES; i++) a.doc.getMap('meta').set(`k${i}`, 1);
    for (let i = 1; i <= MAX_HELD_UPDATES; i++) sock.ws.send(updateMsg(a.edits[i]!));
    for (let i = 0; i < 50 && room(id).held.count < MAX_HELD_UPDATES; i++) await sleep(20);
    expect(room(id).held.count).toBe(MAX_HELD_UPDATES);
    expect(room(id).held.bytes).toBeLessThan(MAX_PENDING_BYTES);
    // One more: "try again later" (the app reconnects; its sync step 2 brings them all), and what it held goes.
    sock.ws.send(updateMsg(a.edits[MAX_HELD_UPDATES + 1]!));
    expect(await sock.closed).toEqual([1013, 'slow_down']);
    expect(heldFull()).toBe(1);
    expect(room(id).held.count).toBe(0);
    expect(room(id).held.bytes).toBe(0);
    expect(room(id).doc.getMap('meta').get('k0')).toBe(0);

    // More bytes than a room holds: the same, at once.
    const big = await rawSocket(port, id, cookieStr);
    const b = editorOf(id, 4600);
    b.doc.getMap('meta').set('note', 'never sent');
    b.doc.getMap('meta').set('k0', 'z'.repeat(MAX_PENDING_BYTES));
    big.ws.send(updateMsg(b.edits[1]!));
    expect(await big.closed).toEqual([1013, 'slow_down']);
    expect(heldFull()).toBe(2);
    expect(room(id).held.count).toBe(0);

    // A connection that closes on its own: what it held goes.
    const quits = await rawSocket(port, id, cookieStr);
    quits.ws.send(updateMsg(a.edits[1]!));
    quits.ws.send(updateMsg(a.edits[2]!));
    for (let i = 0; i < 50 && room(id).held.count < 2; i++) await sleep(20);
    expect(room(id).held.count).toBe(2);
    quits.ws.close();
    await quits.closed;
    for (let i = 0; i < 50 && room(id).held.count > 0; i++) await sleep(20);
    expect(room(id).held.count).toBe(0);

    // The room unloads: everything it held goes with it.
    const stays = await rawSocket(port, id, cookieStr);
    stays.ws.send(updateMsg(a.edits[1]!));
    for (let i = 0; i < 50 && room(id).held.count < 1; i++) await sleep(20);
    const session = room(id);
    expect(session.held.count).toBe(1);
    await docHub.close(id);
    expect(session.held.count).toBe(0);
    await stays.closed;
  });
});
