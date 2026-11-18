// Shared modules over real sockets: the owner saves a new version, one
// person in the layout presses Update, and everyone in the room has the
// new parts (once); a change to a shared module's parts from an outdated
// app, or a move that pulls its parts apart, is put back by the server
// (everyone, the sender too, sees it as it was) without closing anyone's
// connection, so the change isn't sent again and again; moving the module
// goes through.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { forgetLayout } from '../../sharedModules/placed.js';
import { automaticUpdatesSettled } from '../../sharedModules/auto.js';
import { contents, moduleOf, partsOf, place, type Part } from '../../test/sharedWorld.js';
import { Peer } from './wsPeer.js';

const V1: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }];
const V2: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }, { pn: 'c.1', x: 8, y: 2 }];

describe('shared modules, live', () => {
  let app: FastifyInstance;
  let port: number;
  let layoutId: string;
  let crane: string;
  let alice: { cookie: string; id: string };
  let bob: { cookie: string; id: string };

  beforeEach(async () => {
    resetDb();
    forgetLayout();
    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    await registerApiRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    alice = await loginAs(app, 'alice@example.com');
    bob = await loginAs(app, 'bob@example.com');
    crane = ((await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: alice.cookie }, payload: { title: 'Harbor crane' } })).json() as { id: string }).id;
    await save(V1);
    // Shared with Bob, who placed it in his layout; Alice edits that layout too.
    const now = new Date();
    await db.insert(schema.moduleCollaborators).values({ moduleId: crane, userId: bob.id, role: 'viewer', addedAt: now });
    layoutId = randomUUID();
    const doc = createDefaultLayoutDoc();
    place(doc, { placedId: 'placed-1', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 100, y: 50 } });
    await db.insert(schema.layouts).values({ id: layoutId, title: 'Yard', ownerUserId: bob.id, createdBy: bob.id, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(doc)) });
    await db.insert(schema.layoutCollaborators).values({ layoutId, userId: alice.id, role: 'editor', addedAt: now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await docHub.close(layoutId);
    closeAll();
    await app.close();
  });

  async function save(parts: Part[]) {
    const r = await app.inject({ method: 'PUT', url: `/api/modules/${crane}/snapshot`, headers: { cookie: alice.cookie, 'content-type': 'application/octet-stream' }, payload: contents(parts) });
    expect(r.statusCode).toBe(200);
  }
  const pns = (doc: Y.Doc) => partsOf(doc).map((p) => p.pn);

  it('the owner saves, one person presses Update, and both people in the layout have the new version once', async () => {
    const a = new Peer(port, layoutId, alice.cookie, new Y.Doc());
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await Promise.all([a.synced, b.synced]);
    expect(pns(a.doc)).toEqual(['a.1', 'b.1']);
    const idsBefore = partsOf(a.doc).map((p) => p.id);
    // The room knows what it places as soon as someone asks.
    const before = (await app.inject({ method: 'GET', url: `/api/layouts/${layoutId}/shared-modules`, headers: { cookie: bob.cookie } })).json() as { modules: { version: number; latest: number }[] };
    expect(before.modules[0]).toMatchObject({ version: 1, latest: 1 });

    await save(V2);
    const pressed = await Promise.all([
      app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/shared-modules/placed-1/apply`, headers: { cookie: bob.cookie }, payload: {} }),
      app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/shared-modules/placed-1/apply`, headers: { cookie: alice.cookie }, payload: {} }),
    ]);
    expect(pressed.map((r) => r.statusCode)).toEqual([200, 200]);
    for (const peer of [a, b]) {
      await expect.poll(() => pns(peer.doc)).toEqual(['a.1', 'b.1', 'c.1']);
      expect(partsOf(peer.doc).map((p) => [p.x, p.y])).toEqual([[100, 50], [104, 50], [108, 52]]);
      expect(moduleOf(peer.doc, 'placed-1')).toMatchObject({ libraryVersion: 2, shared: { review: { from: 1, to: 2 } } });
      // The unchanged parts kept their ids (doc shape 5): only c.1 is new.
      expect(partsOf(peer.doc).slice(0, 2).map((p) => p.id)).toEqual(idsBefore);
      expect(peer.doc.getMap('meta').get('schemaVersion')).toBe(5);
    }
    // Then Bob moves it: allowed, and Alice sees it move.
    b.doc.transact(() => {
      for (const layer of b.doc.getMap<Y.Map<unknown>>('layerData').values()) {
        const bricks = layer.get('bricks');
        if (!(bricks instanceof Y.Array)) continue;
        for (const brick of bricks as Y.Array<Y.Map<unknown>>) {
          const area = brick.get('displayArea') as { x: number; y: number; width: number; height: number };
          brick.set('displayArea', { ...area, x: area.x + 16 });
        }
      }
    });
    await expect.poll(() => partsOf(a.doc).map((p) => p.x)).toEqual([116, 120, 124]);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    await Promise.all([a.leave(), b.leave()]);
    // Stored with the room: the layout's row says version 2.
    await expect.poll(async () => (await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, layoutId)).get())?.version).toBe(2);
  });

  it('Automatically: the owner saves and everyone in the layout has the new version, nobody pressing anything; leaving notes the visit', async () => {
    await db.update(schema.layouts).set({ sharedModuleUpdates: 'auto' }).where(eq(schema.layouts.id, layoutId));
    const a = new Peer(port, layoutId, alice.cookie, new Y.Doc());
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await Promise.all([a.synced, b.synced]);
    const idsBefore = partsOf(a.doc).map((p) => p.id);
    // The room knows what it places once someone asks (as the editor does on opening).
    await app.inject({ method: 'GET', url: `/api/layouts/${layoutId}/shared-modules`, headers: { cookie: bob.cookie } });
    await save(V2);
    await automaticUpdatesSettled();
    for (const peer of [a, b]) {
      await expect.poll(() => pns(peer.doc)).toEqual(['a.1', 'b.1', 'c.1']);
      expect(moduleOf(peer.doc, 'placed-1')).toMatchObject({ libraryVersion: 2, shared: { review: { from: 1, to: 2 } } });
      // The unchanged parts kept their ids (doc shape 5): only c.1 is new.
      expect(partsOf(peer.doc).slice(0, 2).map((p) => p.id)).toEqual(idsBefore);
      expect(peer.doc.getMap('meta').get('schemaVersion')).toBe(5);
    }
    const before = Date.now();
    await b.leave();
    await expect
      .poll(async () => (await db.select().from(schema.layoutVisits).where(eq(schema.layoutVisits.userId, bob.id)).get())?.seenAt.getTime() ?? 0)
      .toBeGreaterThanOrEqual(before);
    await a.leave();
  });

  it('puts back a change to a shared module’s part, for everyone, and keeps the connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new Peer(port, layoutId, alice.cookie, new Y.Doc());
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await Promise.all([a.synced, b.synced]);
    // An app that doesn't know the lock recolors one of its parts.
    b.doc.transact(() => {
      for (const layer of b.doc.getMap<Y.Map<unknown>>('layerData').values()) {
        const bricks = layer.get('bricks');
        if (bricks instanceof Y.Array && bricks.length > 0) (bricks.get(0) as Y.Map<unknown>).set('partNumber', 'a.4');
      }
    });
    const session = await docHub.getOrCreate(layoutId);
    for (const doc of [session.doc, a.doc, b.doc]) await expect.poll(() => pns(doc)).toEqual(['a.1', 'b.1']);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('it changes a part of a shared module'))).toBe(true);
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_update_refused')).all();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payload)).toMatchObject({ kind: 'locked', why: 'it changes a part of a shared module', putBack: 1 });
    await Promise.all([a.leave(), b.leave()]);
  });

  it('an older app’s undo that moves only some of its parts back after an Update: put back, and no refuse-and-resend loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new Peer(port, layoutId, alice.cookie, new Y.Doc());
    const bobDoc = new Y.Doc();
    const b = new Peer(port, layoutId, bob.cookie, bobDoc);
    await Promise.all([a.synced, b.synced]);
    const bricksOf = (doc: Y.Doc) => [...doc.getMap<Y.Map<unknown>>('layerData').values()].flatMap((l) => (l.get('bricks') instanceof Y.Array ? ((l.get('bricks') as Y.Array<Y.Map<unknown>>).toArray()) : []));
    const xs = (doc: Y.Doc) => partsOf(doc).map((p) => p.x);
    // Bob moves the module (his own undo step), then Alice saves version 2 and it goes in (all new parts).
    const undo = new Y.UndoManager([bobDoc.getMap('layerData'), bobDoc.getMap('sidecarItems'), bobDoc.getMap('meta')], { trackedOrigins: new Set(['bob']) });
    bobDoc.transact(() => {
      for (const brick of bricksOf(bobDoc)) {
        const area = brick.get('displayArea') as { x: number; y: number; width: number; height: number };
        brick.set('displayArea', { ...area, x: area.x + 16 });
      }
    }, 'bob');
    await expect.poll(() => xs(a.doc)).toEqual([116, 120]);
    await save(V2);
    expect((await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/shared-modules/placed-1/apply`, headers: { cookie: alice.cookie }, payload: {} })).statusCode).toBe(200);
    await expect.poll(() => pns(bobDoc)).toEqual(['a.1', 'b.1', 'c.1']);
    const placed = xs(a.doc);
    // His undo now finds nothing of his (the parts it moved are gone): nothing is sent.
    undo.undo();
    expect(xs(bobDoc)).toEqual(placed);
    // An older app's undo that still moves one part back: put back by the server, for him too, and he stays connected.
    bobDoc.transact(() => {
      const brick = bricksOf(bobDoc)[0]!;
      const area = brick.get('displayArea') as { x: number; y: number; width: number; height: number };
      brick.set('displayArea', { ...area, x: area.x - 16 });
    }, 'bob');
    const session = await docHub.getOrCreate(layoutId);
    for (const doc of [session.doc, a.doc, bobDoc]) await expect.poll(() => xs(doc)).toEqual(placed);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    // He closes the layout and opens it again from his saved copy (as the desktop does): nothing is refused, nothing changes.
    await b.leave();
    const again = new Peer(port, layoutId, bob.cookie, bobDoc);
    await again.synced;
    await new Promise((r) => setTimeout(r, 200));
    expect(again.ws.readyState).toBe(again.ws.OPEN);
    expect(xs(session.doc)).toEqual(placed);
    expect(pns(session.doc)).toEqual(['a.1', 'b.1', 'c.1']);
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_update_refused')).all();
    expect(audit).toHaveLength(1);
    await Promise.all([a.leave(), again.leave()]);
  });
});
