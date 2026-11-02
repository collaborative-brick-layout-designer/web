// The live route checks every incoming update the way the desktop does
// (ws/updateGuard.ts) and keeps what waits for missing changes under a limit
// (ws/pending.ts), over a real socket:
//   - the flows people use pass, with nothing left waiting: a desktop's first
//     sync of a large layout, a paste of 1000 parts, an offline session sent
//     on reconnect, and an update that arrives before the one it follows;
//   - an update the desktop can't read closes the connection with 1008
//     unreadable_update and leaves the layout as it was;
//   - past the limit, what an update leaves waiting is dropped, the
//     connection closed, and no snapshot holds more than the limit;
//   - each connection logs and audits such things once;
//   - the snapshot routes take only documents both apps read.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { moduleRoutes } from '../modules.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { MAX_PENDING_BYTES, MAX_PENDING_DS_BYTES, pendingBytes, pendingDsBytes } from '../../ws/pending.js';
import { guardWork } from '../../ws/decoded.js';
import { checkUpdate } from '../../ws/updateGuard.js';
import { Peer } from './wsPeer.js';
import { resetCopyBudgets, wsPacing } from '../../ws/pacing.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Raw {
  ws: WebSocket;
  closed: Promise<[number, string]>;
}

function rawSocket(port: number, layoutId: string, cookieStr: string): Promise<Raw> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, { headers: { cookie: cookieStr } });
  ws.on('error', () => {});
  const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
  return new Promise((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen({ ws, closed }));
    ws.once('error', reject);
  });
}

function updateMsg(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

/** meta[key] = values, hand-encoded (one client, one block), with `content` after the key. */
function setMetaRaw(key: string, content: Buffer, ref: number): Buffer {
  return Buffer.concat([Buffer.from([1, 1, 7, 0, ref | 0x20, 1, 4]), Buffer.from('meta'), Buffer.from([key.length]), Buffer.from(key), content, Buffer.from([0])]);
}

describe('WS update guard', () => {
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
    await app.register(moduleRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    cookieStr = (await loginAs(app, 'update-guard@example.com')).cookie;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function create(payload: Record<string, unknown> = { title: 'Yard' }): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    opened.push(id);
    return id;
  }

  const rows = (id: string) => db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id)).all().length;
  const audits = (type: string) => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, type)).all();
  const room = (id: string) => docHub.peek(id)!;

  it('passes a desktop first sync of a large layout, a paste of 1000 parts and an offline session, leaving nothing waiting', async () => {
    const id = await create({ title: 'Fordyce', bbm: readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8') });
    // First sync: an empty doc gets the whole layout.
    const doc = new Y.Doc();
    let t = performance.now();
    const peer = new Peer(port, id, cookieStr, doc);
    await peer.synced;
    const firstSync = performance.now() - t;
    const docBytes = Y.encodeStateAsUpdate(doc).length;
    expect(pendingBytes(room(id).doc)).toBe(0);

    // A paste of 1000 parts: one update.
    const layerData = doc.getMap<Y.Map<unknown>>('layerData');
    const bricks = [...layerData.values()].map((l) => l.get('bricks')).find((b) => b instanceof Y.Array) as Y.Array<Y.Map<unknown>>;
    const before = rows(id);
    t = performance.now();
    doc.transact(() => {
      const pasted: Y.Map<unknown>[] = [];
      for (let i = 0; i < 1000; i++) {
        const y = new Y.Map<unknown>();
        y.set('id', `paste-${i}-😀`);
        y.set('displayArea', { x: i, y: i, width: 8, height: 8 });
        y.set('partNumber', '3001.1');
        y.set('orientation', 0);
        y.set('connexions', []);
        pasted.push(y);
      }
      bricks.push(pasted);
    });
    const pasteBytes = peer.sent.at(-1)!.bytes;
    for (let i = 0; i < 100 && rows(id) === before; i++) await sleep(20);
    const pasteMs = performance.now() - t;
    expect(rows(id)).toBe(before + 1);
    expect(pendingBytes(room(id).doc)).toBe(0);

    // Offline: 500 edits, then reconnect (one step 2 carries them all).
    await peer.leave();
    for (let i = 0; i < 500; i++) bricks.get(i % bricks.length).set('orientation', i % 360);
    const back = new Peer(port, id, cookieStr, doc);
    await back.synced;
    for (let i = 0; i < 100 && room(id).doc.getMap<Y.Map<unknown>>('layerData').size === 0; i++) await sleep(20);
    await sleep(200);
    const offlineBytes = back.largestStep2();
    expect(Y.encodeStateVector(room(id).doc)).toEqual(Y.encodeStateVector(doc));
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(back.ws.readyState).toBe(WebSocket.OPEN);
    console.log(
      `[measure] first sync of Fordyce: ${docBytes} bytes in ${firstSync.toFixed(0)} ms; paste of 1000 parts: one ${pasteBytes}-byte update, stored in ${pasteMs.toFixed(0)} ms; ` +
        `500 offline edits: one ${offlineBytes}-byte step 2; left waiting: 0 bytes each`,
    );
    await back.leave();
  });

  it('applies an update that arrives before the one it follows once that one arrives', async () => {
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    const d = new Y.Doc();
    const sv0 = Y.encodeStateVector(d);
    d.getMap('meta').set('a', 1);
    const first = Y.encodeStateAsUpdate(d, sv0);
    const sv1 = Y.encodeStateVector(d);
    d.getMap('meta').set('b', 2);
    const second = Y.encodeStateAsUpdate(d, sv1);
    peer.ws.send(updateMsg(second));
    await sleep(100);
    expect(pendingBytes(room(id).doc)).toBeGreaterThan(0);
    peer.ws.send(updateMsg(first));
    await sleep(100);
    expect(room(id).doc.getMap('meta').get('b')).toBe(2);
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    peer.ws.close();
  });

  it('rejects malformed documents without crashing, live and in older snapshots', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const varUint = (v: number): number[] => {
      const out: number[] = [];
      for (; v > 0x7f; v = Math.floor(v / 128)) out.push(0x80 | (v % 128));
      out.push(v);
      return out;
    };
    // meta[key] = 2 from client 7777 at `clock` (hand-encoded: Yjs never writes such a clock).
    const setAt = (clock: number, key: string) =>
      Uint8Array.from([1, 1, ...varUint(7777), ...varUint(clock), 8 | 0x20, 1, 4, ...Buffer.from('meta'), 1, key.charCodeAt(0), 1, 0x7d, 2, 0]);
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    peer.ws.send(updateMsg(setAt(0, 'a')));
    for (let i = 0; i < 50 && room(id).doc.getMap('meta').get('a') !== 2; i++) await sleep(20);
    expect(room(id).doc.getMap('meta').get('a')).toBe(2);
    // The next change from the same editor, at a clock past the limit.
    peer.ws.send(updateMsg(setAt(0xffff_ff00, 'b')));
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(checkUpdate(Y.encodeStateAsUpdate(room(id).doc))).toBeNull();
    const fuzz = Buffer.from('AwGAgJYAlgEAAgGAgJYAlv////8BAAIAAAAAAAAAAAQA', 'base64');
    const next = await rawSocket(port, id, cookieStr);
    await sleep(50);
    next.ws.send(updateMsg(fuzz));
    expect(await next.closed).toEqual([1008, 'unreadable_update']);
    expect(pendingBytes(room(id).doc)).toBe(0);

    // A snapshot stored before the server refused them: what waits with
    // such a clock is dropped when the room opens, so no sync hands it out.
    await docHub.close(id);
    const stored = new Y.Doc();
    Y.applyUpdate(stored, db.select({ s: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, id)).get()!.s as Uint8Array);
    Y.applyUpdate(stored, setAt(0xffff_ff00, 'b'));
    expect(pendingBytes(stored)).toBeGreaterThan(0);
    expect(checkUpdate(Y.encodeStateAsUpdate(stored))).not.toBeNull();
    db.update(schema.layouts).set({ docSnapshot: Buffer.from(Y.encodeStateAsUpdate(stored)) }).where(eq(schema.layouts.id, id)).run();
    const reader = new Y.Doc();
    const again = new Peer(port, id, cookieStr, reader);
    await again.synced;
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(reader.getMap('meta').get('a')).toBe(2);
    expect(checkUpdate(Y.encodeStateAsUpdate(reader))).toBeNull();
    await again.leave();
  });

  it('closes on an update the desktop cannot read, leaves the layout as it was, and audits it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    const stateBefore = Y.encodeStateAsUpdate(room(id).doc);
    const d = new Y.Doc();
    d.getMap('meta').set('nul', 'a\u0000b');
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = [deep];
    const e = new Y.Doc();
    e.getMap('meta').set('deep', deep);
    for (let i = 0; i < 20; i++) peer.ws.send(updateMsg(Y.encodeStateAsUpdate(i % 2 ? e : d)));
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    await sleep(100);
    expect(rows(id)).toBe(0);
    expect(room(id).doc.getMap('meta').get('nul')).toBeUndefined();
    expect(room(id).doc.getMap('meta').get('deep')).toBeUndefined();
    expect(Y.encodeStateAsUpdate(room(id).doc)).toEqual(stateBefore);
    const refused = audits('layout_update_refused');
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!.payload!)).toMatchObject({ kind: 'unreadable' });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('refused an update'))).toHaveLength(1);

    // Viewers and readers still get the layout; a weak link is refused too.
    const next = await rawSocket(port, id, cookieStr);
    await sleep(50);
    next.ws.send(updateMsg(setMetaRaw('x', Buffer.from([7]), 7)));
    expect(await next.closed).toEqual([1008, 'unreadable_update']);
  });

  it('closes on an update that leaves a grid with a size the apps do not draw, and takes a valid size', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const gridOf = (doc: Y.Doc) =>
      [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l instanceof Y.Map && l.get('type') === 'grid')!;
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    const before = gridOf(room(id).doc).get('gridSizeInStud');
    const edit = (size: unknown): Uint8Array => {
      const mine = new Y.Doc();
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(room(id).doc));
      const sv = Y.encodeStateVector(mine);
      gridOf(mine).set('gridSizeInStud', size);
      return Y.encodeStateAsUpdate(mine, sv);
    };
    peer.ws.send(updateMsg(edit(48)));
    for (let i = 0; i < 50 && gridOf(room(id).doc).get('gridSizeInStud') !== 48; i++) await sleep(20);
    expect(gridOf(room(id).doc).get('gridSizeInStud')).toBe(48);
    expect(before).not.toBe(48);
    peer.ws.send(updateMsg(edit(0)));
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    expect(gridOf(room(id).doc).get('gridSizeInStud')).toBe(48);
    const refused = audits('layout_update_refused');
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!.payload!)).toMatchObject({ kind: 'unreadable' });
  });

  it('drops what an update leaves waiting past the limit, closes that connection, and never stores more', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    // Each update here is worked out on a copy of the room (it has changes
    // waiting): room enough in the copy budget (ws/pacing.ts) to reach the limit.
    const budget = wsPacing.copyByteBurst;
    wsPacing.copyByteBurst = 1024 * 1024 * 1024;
    resetCopyBudgets();
    onTestFinished(() => {
      wsPacing.copyByteBurst = budget;
      resetCopyBudgets();
    });
    const d = new Y.Doc();
    d.clientID = 123456;
    d.getMap('p').set('seed', 1); // never sent: everything after it waits
    let sv = Y.encodeStateVector(d);
    const chunk = 'z'.repeat(100 * 1024);
    for (let i = 0; i < 60 && peer.ws.readyState === WebSocket.OPEN; i++) {
      d.getMap('p').set('k' + i, chunk);
      peer.ws.send(updateMsg(Y.encodeStateAsUpdate(d, sv)));
      sv = Y.encodeStateVector(d);
      await sleep(5);
    }
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    const waiting = pendingBytes(room(id).doc);
    expect(waiting).toBeGreaterThan(0);
    expect(waiting).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    expect(rows(id)).toBe(0);
    const refused = audits('layout_update_refused');
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!.payload!)).toMatchObject({ kind: 'incomplete' });
    // The snapshot holds no more than the limit either.
    await room(id).flushSnapshot();
    const snap = db.select({ s: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, id)).get()!.s as Uint8Array;
    expect(snap.length).toBeLessThan(MAX_PENDING_BYTES + 64 * 1024);
    // Others keep editing.
    const other = new Peer(port, id, cookieStr, new Y.Doc());
    await other.synced;
    other.doc.getMap('meta').set('after', 'yes');
    for (let i = 0; i < 50 && room(id).doc.getMap('meta').get('after') !== 'yes'; i++) await sleep(20);
    expect(room(id).doc.getMap('meta').get('after')).toBe('yes');
    await other.leave();
  });

  it('refuses an update leaving more deletions waiting than a room holds, and keeps the room as it was', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    // Deletions of clocks of a client the room has never seen: they all wait.
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint(e, 4242);
    const n = 20_000;
    encoding.writeVarUint(e, n);
    for (let i = 0; i < n; i++) {
      encoding.writeVarUint(e, i * 2);
      encoding.writeVarUint(e, 1);
    }
    peer.ws.send(updateMsg(encoding.toUint8Array(e)));
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    expect(pendingDsBytes(room(id).doc)).toBe(0);
    expect(JSON.parse(audits('layout_update_refused')[0]!.payload!)).toMatchObject({ kind: 'incomplete' });
    expect(MAX_PENDING_DS_BYTES).toBeLessThan(n);
  });

  it('with a change waiting in the room, everyone else edits as quickly as before', { timeout: 60_000 }, async () => {
    const id = await create({ title: 'Fordyce', bbm: readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8') });
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    const d = new Y.Doc();
    d.clientID = 123457;
    d.getMap('p').set('seed', 1); // never sent: the next one waits for it
    const sv = Y.encodeStateVector(d);
    d.getMap('p').set('waits', 1);
    peer.ws.send(updateMsg(Y.encodeStateAsUpdate(d, sv)));
    for (let i = 0; i < 50 && pendingBytes(room(id).doc) === 0; i++) await sleep(20);
    expect(pendingBytes(room(id).doc)).toBeGreaterThan(0);
    // Another editor's 200 small edits: none worked out on a copy of the layout, none slowed down.
    const other = new Peer(port, id, cookieStr, new Y.Doc());
    await other.synced;
    const copies = guardWork.docCopies;
    for (let i = 0; i < 200; i++) other.doc.getMap('meta').set('comment', `edit ${i}`);
    for (let i = 0; i < 100 && room(id).doc.getMap('meta').get('comment') !== 'edit 199'; i++) await sleep(20);
    expect(room(id).doc.getMap('meta').get('comment')).toBe('edit 199');
    expect(guardWork.docCopies - copies).toBe(0);
    await other.leave();
    peer.ws.close();
  });

  it('opens a snapshot holding more waiting than the limit with that dropped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, db.select({ s: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, id)).get()!.s as Uint8Array);
    const d = new Y.Doc();
    d.getMap('p').set('seed', 1);
    const sv = Y.encodeStateVector(d);
    d.getMap('p').set('big', 'q'.repeat(MAX_PENDING_BYTES + 1024));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(d, sv));
    expect(pendingBytes(doc)).toBeGreaterThan(MAX_PENDING_BYTES);
    db.update(schema.layouts).set({ docSnapshot: Buffer.from(Y.encodeStateAsUpdate(doc)) }).where(eq(schema.layouts.id, id)).run();
    const peer = new Peer(port, id, cookieStr, new Y.Doc());
    await peer.synced;
    expect(pendingBytes(room(id).doc)).toBe(0);
    expect(room(id).doc.getArray('layers').length).toBeGreaterThan(0);
    await peer.leave();
  });

  it('logs an update it cannot apply, and flags many unseen editors, once per connection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create();
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(100);
    // A nested type kind the web's Yjs doesn't know (the desktop reads it).
    for (let i = 0; i < 20; i++) peer.ws.send(updateMsg(setMetaRaw('x' + i, Buffer.from([9]), 7)));
    // Updates bringing items from many editors the layout has never seen.
    for (let n = 0; n < 5; n++) {
      const d = new Y.Doc();
      for (let c = 0; c < 5; c++) {
        d.clientID = 9_000_000 + n * 10 + c;
        d.getMap('meta').set(`k${n}-${c}`, c);
      }
      peer.ws.send(updateMsg(Y.encodeStateAsUpdate(d)));
    }
    await sleep(300);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(error.mock.calls.filter((c) => String(c[0]).includes('could not apply an update'))).toHaveLength(1);
    expect(audits('layout_merge_suspected')).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('never seen'))).toHaveLength(1);
    peer.ws.close();
  });

  it('the snapshot routes take only documents both apps read', async () => {
    const id = await create();
    const put = (url: string, payload: Buffer) =>
      app.inject({ method: 'PUT', url, headers: { cookie: cookieStr, 'content-type': 'application/octet-stream' }, payload });
    const nul = setMetaRaw('x', Buffer.from([1, 0x77, 3, 0x61, 0, 0x62]), 8);
    const good = Buffer.from(encodeDoc(createDefaultLayoutDoc()));
    expect((await put(`/api/layouts/${id}/snapshot`, nul)).json()).toEqual({ error: 'unreadable_snapshot' });
    expect((await put(`/api/layouts/${id}/snapshot`, good)).statusCode).toBe(200);
    const mod = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: cookieStr }, payload: { title: 'Siding' } });
    expect(mod.statusCode).toBe(201);
    const modId = (mod.json() as { id: string }).id;
    const bad = await put(`/api/modules/${modId}/snapshot`, nul);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'unreadable_snapshot' });
    expect((await put(`/api/modules/${modId}/snapshot`, good)).statusCode).toBe(200);
    // A document whose grid has no size both apps draw.
    const zeroGrid = createDefaultLayoutDoc();
    for (const l of zeroGrid.getMap<Y.Map<unknown>>('layerData').values()) if (l.get('type') === 'grid') l.set('gridSizeInStud', 0);
    const zero = Buffer.from(encodeDoc(zeroGrid));
    expect((await put(`/api/layouts/${id}/snapshot`, zero)).json()).toEqual({ error: 'unreadable_snapshot' });
    expect((await put(`/api/modules/${modId}/snapshot`, zero)).json()).toEqual({ error: 'unreadable_snapshot' });
    // …or a grid of a billion sub-divisions (drawingSettings.ts).
    const busyGrid = createDefaultLayoutDoc();
    for (const l of busyGrid.getMap<Y.Map<unknown>>('layerData').values()) if (l.get('type') === 'grid') l.set('subDivisionNumber', 1e9);
    const busy = Buffer.from(encodeDoc(busyGrid));
    expect((await put(`/api/layouts/${id}/snapshot`, busy)).json()).toEqual({ error: 'unreadable_snapshot' });
    expect((await put(`/api/modules/${modId}/snapshot`, busy)).json()).toEqual({ error: 'unreadable_snapshot' });
  });
});
