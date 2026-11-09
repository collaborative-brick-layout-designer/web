// A layout's background picture is only ever this server's own copy
// (ws/backgroundGuard.ts): a new layout drops any other address, a live
// edit or a snapshot that sets one is refused, a copy doesn't keep one,
// and a layout that already had one can still be edited.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultLayoutDoc, decodeDoc, encodeDoc, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { bufConcat, db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes, prepareLayoutCopy } from '../layouts.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { allowedBackgroundUrl, backgroundUrlProblem } from '../../ws/backgroundGuard.js';
import { decodeIncoming } from '../../ws/decoded.js';

const TRACKER = 'https://tracker.example.net/pixel.png';
const own = (id: string) => `/api/layouts/${id}/background-image`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const png = bufConcat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);

function updateMsg(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function rawSocket(port: number, layoutId: string, cookieStr: string): Promise<{ ws: WebSocket; closed: Promise<[number, string]> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, { headers: { cookie: cookieStr } });
  ws.on('error', () => {});
  const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
  return new Promise((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen({ ws, closed }));
    ws.once('error', reject);
  });
}

const sidecarWith = (url: string | undefined) => JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', backgroundImage: { ...(url === undefined ? {} : { url }), opacity: 0.5 } });
const bgOf = (doc: Y.Doc) => (readSidecarCache(doc)?.backgroundImage ?? null) as { url?: string } | null;
const setBg = (doc: Y.Doc, url: string) => writeSidecarCache(doc, { ...readSidecarCache(doc), backgroundImage: { url, opacity: 0.5 } });

describe('background image address', () => {
  let app: FastifyInstance;
  let port: number;
  let cookieStr: string;
  const opened: string[] = [];

  beforeEach(async () => {
    resetDb();
    app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    cookieStr = (await loginAs(app, 'bg-url@example.com')).cookie;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function create(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    opened.push(id);
    return id;
  }
  async function stored(id: string): Promise<Y.Doc> {
    const snap = await app.inject({ method: 'GET', url: `/api/layouts/${id}/snapshot`, headers: { cookie: cookieStr } });
    return decodeDoc(new Uint8Array(snap.rawPayload));
  }
  /** Give layout `id` a background address as if stored before the server checked it. */
  async function storeLegacy(id: string, url: string): Promise<void> {
    const doc = await stored(id);
    doc.transact(() => setBg(doc, url));
    await db.update(schema.layouts).set({ docSnapshot: Buffer.from(encodeDoc(doc)) }).where(eq(schema.layouts.id, id));
    await db.delete(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id));
  }
  /** Send `edit` of the room's document over a live connection; resolves with the close, or null if it stayed open. */
  async function liveEdit(id: string, edit: (d: Y.Doc) => void): Promise<[number, string] | null> {
    const peer = await rawSocket(port, id, cookieStr);
    await sleep(50);
    const room = docHub.peek(id)!;
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(room.doc));
    const sv = Y.encodeStateVector(mine);
    mine.transact(() => edit(mine));
    peer.ws.send(updateMsg(Y.encodeStateAsUpdate(mine, sv)));
    const result = await Promise.race([peer.closed, sleep(300).then(() => null)]);
    peer.ws.close();
    return result;
  }

  it('a new layout drops a background address on another host (the probe)', async () => {
    const id = await create({ title: 'BG', sidecar: sidecarWith(TRACKER) });
    const bg = bgOf(await stored(id));
    expect(bg?.url ?? '').toBe('');
  });

  it("a new layout with its picture points at this server's copy", async () => {
    const id = await create({ title: 'BG', sidecar: sidecarWith(TRACKER), backgroundImage: { type: 'image/png', data: png.toString('base64') } });
    expect(bgOf(await stored(id))?.url).toBe(own(id));
  });

  it('a live edit that points the background at another host is refused and changes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create({ title: 'Live' });
    const close = await liveEdit(id, (d) => setBg(d, TRACKER));
    expect(close).toEqual([1008, 'unreadable_update']);
    expect(bgOf(docHub.peek(id)!.doc)).toBeNull();
    const audit = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_update_refused')).all();
    expect(audit).toHaveLength(1);
  });

  it("a live edit to the layout's own picture is taken", async () => {
    const id = await create({ title: 'Live' });
    expect(await liveEdit(id, (d) => setBg(d, own(id)))).toBeNull();
    expect(bgOf(docHub.peek(id)!.doc)?.url).toBe(own(id));
  });

  it("another layout's picture on this server is refused too", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await create({ title: 'Other' });
    const id = await create({ title: 'Live' });
    expect(await liveEdit(id, (d) => setBg(d, own(other)))).toEqual([1008, 'unreadable_update']);
  });

  it('a layout that already had an outside address can still be edited, and can drop it', async () => {
    const id = await create({ title: 'Legacy' });
    await storeLegacy(id, TRACKER);
    // A module or label edit writes the whole sidecar again, address and all.
    expect(await liveEdit(id, (d) => writeSidecarCache(d, { ...readSidecarCache(d), anchoredLabels: [] }))).toBeNull();
    expect(bgOf(docHub.peek(id)!.doc)?.url).toBe(TRACKER);
    // But not moved to another outside address.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await liveEdit(id, (d) => setBg(d, 'https://other.example.net/x.png'))).toEqual([1008, 'unreadable_update']);
    // Pointing it at the layout's own picture is fine.
    expect(await liveEdit(id, (d) => setBg(d, own(id)))).toBeNull();
    expect(bgOf(docHub.peek(id)!.doc)?.url).toBe(own(id));
  });

  it('a snapshot PUT with an outside address is refused; one with its own is taken', async () => {
    const id = await create({ title: 'Snap' });
    await docHub.close(id);
    const bad = createDefaultLayoutDoc();
    bad.transact(() => setBg(bad, TRACKER));
    const put = (doc: Y.Doc) =>
      app.inject({ method: 'PUT', url: `/api/layouts/${id}/snapshot`, headers: { cookie: cookieStr, 'content-type': 'application/octet-stream' }, payload: Buffer.from(encodeDoc(doc)) });
    const refused = await put(bad);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'invalid_background_image' });
    const good = createDefaultLayoutDoc();
    good.transact(() => setBg(good, own(id)));
    expect((await put(good)).statusCode).toBe(200);
  });

  it('a snapshot PUT keeping the outside address the layout already had is taken', async () => {
    const id = await create({ title: 'Snap' });
    await docHub.close(id);
    await storeLegacy(id, TRACKER);
    const doc = createDefaultLayoutDoc();
    doc.transact(() => setBg(doc, TRACKER));
    const res = await app.inject({ method: 'PUT', url: `/api/layouts/${id}/snapshot`, headers: { cookie: cookieStr, 'content-type': 'application/octet-stream' }, payload: Buffer.from(encodeDoc(doc)) });
    expect(res.statusCode).toBe(200);
  });

  it("a copy doesn't keep an outside address", async () => {
    const id = await create({ title: 'Legacy' });
    await docHub.close(id);
    await storeLegacy(id, TRACKER);
    const src = (await db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get())!;
    const { values } = await prepareLayoutCopy(src, { title: 'Copy', ownerUserId: src.ownerUserId, ownerOrgId: null, createdBy: src.createdBy });
    expect(bgOf(decodeDoc(values.docSnapshot as Uint8Array))?.url ?? '').toBe('');
  });
});

describe('backgroundUrlProblem', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const edit = (room: Y.Doc, change: (d: Y.Doc) => void) => {
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(room));
    const sv = Y.encodeStateVector(mine);
    mine.transact(() => change(mine));
    return decodeIncoming(Y.encodeStateAsUpdate(mine, sv))!;
  };

  it('takes no address, an empty one, and the layout’s own', () => {
    for (const url of [undefined, '', own(id)]) expect(allowedBackgroundUrl(url, id)).toBe(true);
    for (const url of [TRACKER, '//tracker.example.net/x', `${own(id)}?x=1`, `/api/layouts/${id}/background-image/../x`, own('other')]) {
      expect(allowedBackgroundUrl(url, id)).toBe(false);
    }
  });

  it('refuses an update that sets an outside address, and not one that sets it and takes it back', () => {
    const room = createDefaultLayoutDoc();
    expect(backgroundUrlProblem(room, id, edit(room, (d) => setBg(d, TRACKER)))).not.toBeNull();
    expect(backgroundUrlProblem(room, id, edit(room, (d) => { setBg(d, TRACKER); setBg(d, own(id)); }))).toBeNull();
    expect(backgroundUrlProblem(room, id, edit(room, (d) => d.getArray('layers').push(['x'])))).toBeNull();
  });
});
