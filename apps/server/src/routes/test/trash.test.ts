// Recently deleted: a deleted layout, module or venue waits 30 days and can
// be restored whole by its owner; others can't see it; the privacy
// clean-up erases it after its 30 days.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { moduleRoutes } from '../modules.js';
import { venueRoutes } from '../venues.js';
import { trashRoutes } from '../trash.js';
import { collectionRoutes } from '../collections.js';
import { purgeTrash } from '../../trash/trash.js';

type Who = { cookie: string; id: string };
let app: FastifyInstance;
let ada: Who;
let bob: Who;
const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object | Buffer, type?: string) =>
  app.inject({ method, url, headers: { cookie: who.cookie, ...(type ? { 'content-type': type } : {}) }, ...(payload ? { payload } : {}) });

beforeEach(async () => {
  resetDb();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, layoutRoutes, moduleRoutes, venueRoutes, trashRoutes, collectionRoutes]) await app.register(r);
  ada = await loginAs(app, 'ada@example.com');
  bob = await loginAs(app, 'bob@example.com');
});
afterEach(async () => {
  await app.close();
});

const trash = async (who: Who) => (await call(who, 'GET', '/api/trash')).json() as { days: number; items: { id: string; kind: string; itemId: string; title: string }[] };

describe('Recently deleted', () => {
  it('a layout comes back whole: its document and who it was shared with', async () => {
    const { id } = (await call(ada, 'POST', '/api/layouts', { title: 'Main yard' })).json() as { id: string };
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: bob.id, role: 'editor', addedAt: new Date() });
    const before = (await call(ada, 'GET', `/api/layouts/${id}/snapshot`)).rawPayload;
    const del = await call(ada, 'DELETE', `/api/layouts/${id}`);
    expect(del.statusCode).toBe(200);
    const { trashId } = del.json() as { trashId: string };
    expect(trashId).toBeTruthy();
    expect((await call(ada, 'GET', `/api/layouts/${id}`)).statusCode).toBe(404);
    const list = await trash(ada);
    expect(list.days).toBe(30);
    expect(list.items).toMatchObject([{ id: trashId, kind: 'layout', itemId: id, title: 'Main yard' }]);
    // Someone else's Recently deleted doesn't have it, and they can't restore it.
    expect((await trash(bob)).items).toEqual([]);
    expect((await call(bob, 'POST', `/api/trash/${trashId}/restore`)).statusCode).toBe(404);

    const back = await call(ada, 'POST', `/api/trash/${trashId}/restore`);
    expect(back.json()).toEqual({ ok: true, kind: 'layout', id });
    const after = (await call(ada, 'GET', `/api/layouts/${id}/snapshot`)).rawPayload;
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, new Uint8Array(before));
    Y.applyUpdate(b, new Uint8Array(after));
    expect(b.getMap('meta').toJSON()).toEqual(a.getMap('meta').toJSON());
    expect((await db.select().from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.layoutId, id)).all()).map((c) => c.userId)).toEqual([bob.id]);
    expect((await trash(ada)).items).toEqual([]);
    // Restored once: there's nothing left to restore.
    expect((await call(ada, 'POST', `/api/trash/${trashId}/restore`)).statusCode).toBe(404);
  });

  it('a module comes back with its versions; a venue comes back', async () => {
    const { id: mod } = (await call(ada, 'POST', '/api/modules', { title: 'Siding' })).json() as { id: string };
    expect((await call(ada, 'PUT', `/api/modules/${mod}/snapshot`, Buffer.from(encodeDoc(createDefaultLayoutDoc())), 'application/octet-stream')).statusCode).toBe(200);
    const versions = (await db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, mod)).all()).length;
    expect(versions).toBeGreaterThan(0);
    const m = (await call(ada, 'DELETE', `/api/modules/${mod}`)).json() as { trashId: string };
    const { id: venue } = (await call(ada, 'POST', '/api/venues', { name: 'Hall', data: { name: 'Hall', edges: [], obstacles: [] } })).json() as { id: string };
    const v = (await call(ada, 'DELETE', `/api/venues/${venue}`)).json() as { trashId: string };
    expect((await trash(ada)).items.map((i) => i.kind).sort()).toEqual(['module', 'venue']);
    expect((await call(ada, 'POST', `/api/trash/${m.trashId}/restore`)).statusCode).toBe(200);
    expect((await db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, mod)).all()).length).toBe(versions);
    expect((await call(ada, 'POST', `/api/trash/${v.trashId}/restore`)).statusCode).toBe(200);
    expect(await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, venue)).get()).toMatchObject({ name: 'Hall' });
  });

  it('a module goes back into its collections, in its old place; one deleted meanwhile is skipped and counted', async () => {
    const mk = async (title: string) => ((await call(ada, 'POST', '/api/modules', { title })).json() as { id: string }).id;
    const siding = await mk('Siding');
    const shed = await mk('Shed');
    const collection = async (title: string, ids: string[]) => {
      const r = await call(ada, 'POST', '/api/catalog/collections', { title, audience: 'private', entries: ids.map((id) => ({ source: 'library', kind: 'module', id })), coverModuleId: siding });
      expect(r.statusCode).toBe(201);
      return (r.json() as { id: string }).id;
    };
    const yard = await collection('Yard', [shed, siding]);
    const town = await collection('Town', [siding]);
    const goner = await collection('Old picks', [siding]);
    const members = async (cid: string) =>
      (await db.select().from(schema.catalogCollectionModules).where(eq(schema.catalogCollectionModules.collectionId, cid)).all()).sort((a, b) => a.position - b.position).map((m) => m.moduleId);
    expect(await members(yard)).toEqual([shed, siding]);

    // Deleting takes it out of all three; curators are told.
    const { trashId } = (await call(ada, 'DELETE', `/api/modules/${siding}`)).json() as { trashId: string };
    expect(await members(yard)).toEqual([shed]);
    expect(await members(town)).toEqual([]);
    expect((await db.select().from(schema.catalogCollections).where(eq(schema.catalogCollections.id, yard)).get())?.coverModuleId).toBeNull();
    // One of its collections is deleted while the module waits.
    expect((await call(ada, 'DELETE', `/api/catalog/collections/${goner}`)).statusCode).toBe(200);

    const back = await call(ada, 'POST', `/api/trash/${trashId}/restore`);
    expect(back.statusCode).toBe(200);
    const body = back.json() as { ok: true; collections: { back: { id: string; title: string }[]; gone: number } };
    expect(body.collections.gone).toBe(1);
    expect(body.collections.back.map((c) => c.title).sort()).toEqual(['Town', 'Yard']);
    expect(await members(yard)).toEqual([shed, siding]);
    expect(await members(town)).toEqual([siding]);
    const y = await db.select().from(schema.catalogCollections).where(eq(schema.catalogCollections.id, yard)).get();
    expect(y?.coverModuleId).toBe(siding);
    expect(y?.curatorNote).toContain("“Siding” was restored from Recently deleted, so it's back in this collection.");
    // A collection's page shows it again.
    const page = (await call(ada, 'GET', `/api/catalog/collections/${yard}`)).json() as { items: { id: string }[] };
    expect(page.items.map((i) => i.id)).toEqual([shed, siding]);

    // A module that was in no collection says nothing about them.
    const lone = await mk('Lone');
    const t2 = ((await call(ada, 'DELETE', `/api/modules/${lone}`)).json() as { trashId: string }).trashId;
    expect((await call(ada, 'POST', `/api/trash/${t2}/restore`)).json()).toEqual({ ok: true, kind: 'module', id: lone });
  });

  it('Delete now erases it; after 30 days the clean-up does', async () => {
    const one = (await call(ada, 'POST', '/api/layouts', { title: 'One' })).json() as { id: string };
    const two = (await call(ada, 'POST', '/api/layouts', { title: 'Two' })).json() as { id: string };
    const t1 = ((await call(ada, 'DELETE', `/api/layouts/${one.id}`)).json() as { trashId: string }).trashId;
    await call(ada, 'DELETE', `/api/layouts/${two.id}`);
    expect((await call(bob, 'DELETE', `/api/trash/${t1}`)).statusCode).toBe(404);
    expect((await call(ada, 'DELETE', `/api/trash/${t1}`)).statusCode).toBe(200);
    expect((await trash(ada)).items.map((i) => i.title)).toEqual(['Two']);
    expect(await purgeTrash(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await purgeTrash(new Date(Date.now() + 31 * 86_400_000))).toBe(1);
    expect((await trash(ada)).items).toEqual([]);
  });

  it('an account erased takes its Recently deleted with it', async () => {
    const one = (await call(ada, 'POST', '/api/layouts', { title: 'One' })).json() as { id: string };
    await call(ada, 'DELETE', `/api/layouts/${one.id}`);
    expect((await db.select().from(schema.trashItems).all()).length).toBe(1);
    await db.delete(schema.users).where(eq(schema.users.id, ada.id));
    expect((await db.select().from(schema.trashItems).all()).length).toBe(0);
  });
});
