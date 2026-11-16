// Shared modules over real sockets: the owner saves a new version, one
// person in the layout presses Update, and everyone in the room has the
// new parts (once); a change to a shared module's parts from an outdated
// app is refused (1008) and leaves the layout as it was, while moving the
// module goes through.

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

  it('refuses a change to a shared module’s part, and leaves the layout as it was', async () => {
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
    expect(await b.closed).toEqual([1008, 'unreadable_update']);
    const session = await docHub.getOrCreate(layoutId);
    expect(pns(session.doc)).toEqual(['a.1', 'b.1']);
    expect(pns(a.doc)).toEqual(['a.1', 'b.1']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('it changes a part of a shared module'))).toBe(true);
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_update_refused')).all();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payload)).toMatchObject({ kind: 'locked', why: 'it changes a part of a shared module' });
    await a.leave();
  });
});
