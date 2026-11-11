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
import { purgeTrash, TRASH_MAX_COLLECTION_ITEMS } from '../../trash/trash.js';
import { MAX_COLLECTION_ITEMS } from '../collections.js';
import { orgRoutes } from '../orgs.js';
import { adminLimitsRoutes } from '../adminLimits.js';
import { invalidateLimitCaches } from '../../limits/limits.js';
import { eraseUser } from '../../privacy/accountDeletion.js';
import { imagesDirFor } from '../../workers/backup.js';
import { env } from '../../env.js';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  for (const r of [passwordRoutes, layoutRoutes, moduleRoutes, venueRoutes, trashRoutes, collectionRoutes, orgRoutes, adminLimitsRoutes]) await app.register(r);
  invalidateLimitCaches();
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

describe('Recently deleted: restoring is safe', () => {
  const doc = () => Buffer.from(encodeDoc(createDefaultLayoutDoc()));
  const trashIdOf = (res: { json: () => unknown }) => (res.json() as { trashId: string }).trashId;

  it('a club layout and module come back after their maker’s account was erased, credited to the old id', async () => {
    const club = (await call(ada, 'POST', '/api/orgs', { name: 'Rail Club' })).json() as { id: string; slug: string };
    const orgId = (await db.select().from(schema.orgs).where(eq(schema.orgs.slug, club.slug)).get())!.id;
    await db.insert(schema.orgMembers).values({ orgId, userId: bob.id, role: 'member', joinedAt: new Date() } as never);
    const now = new Date();
    const layoutId = randomUUID();
    const moduleId = randomUUID();
    await db.insert(schema.layouts).values({ id: layoutId, title: 'Club yard', ownerOrgId: orgId, createdBy: bob.id, createdAt: now, updatedAt: now, docSnapshot: doc() });
    await db.insert(schema.modules).values({ id: moduleId, title: 'Club module', ownerOrgId: orgId, createdBy: bob.id, docSnapshot: doc(), latestVersion: 1, createdAt: now, updatedAt: now });
    await db.insert(schema.moduleVersions).values({ id: randomUUID(), moduleId, version: 1, docSnapshot: doc(), authorId: bob.id, createdAt: now } as never);
    const t1 = trashIdOf(await call(ada, 'DELETE', `/api/layouts/${layoutId}`));
    const t2 = trashIdOf(await call(ada, 'DELETE', `/api/modules/${moduleId}`));
    await eraseUser(bob.id, 'admin', ada.id);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, bob.id)).get()).toBeUndefined();

    expect((await call(ada, 'POST', `/api/trash/${t1}/restore`)).json()).toEqual({ ok: true, kind: 'layout', id: layoutId });
    expect((await call(ada, 'POST', `/api/trash/${t2}/restore`)).json()).toEqual({ ok: true, kind: 'module', id: moduleId });
    const layout = (await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get())!;
    expect(layout).toMatchObject({ ownerOrgId: orgId, createdBy: ada.id, deletedAuthorId: bob.id });
    const mod = (await db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get())!;
    expect(mod).toMatchObject({ ownerOrgId: orgId, createdBy: ada.id, deletedAuthorId: bob.id });
    expect((await db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, moduleId)).all()).map((v) => v.authorId)).toEqual([null]);
    expect((await trash(ada)).items).toEqual([]);
  });

  it('restoring past the layout limit is refused in plain words, and the item waits', async () => {
    db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, ada.id)).run();
    const mk = async (title: string) => ((await call(bob, 'POST', '/api/layouts', { title })).json() as { id: string }).id;
    const a = await mk('A');
    await mk('B');
    const t = trashIdOf(await call(bob, 'DELETE', `/api/layouts/${a}`));
    await mk('C');
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: ada.cookie }, payload: { layoutsPerUser: 2 } })).statusCode).toBe(200);
    invalidateLimitCaches();
    const refused = await call(bob, 'POST', `/api/trash/${t}/restore`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'limit_reached', limit: 'layoutsPerUser', message: 'You have 2 layouts, the most allowed. Delete one you don’t need, or ask the site admin for more.' });
    // Still there to restore once there's room.
    expect((await trash(bob)).items.map((i) => i.title)).toEqual(['A']);
    expect(await db.select().from(schema.layouts).where(eq(schema.layouts.id, a)).get()).toBeUndefined();
    const b = (await db.select().from(schema.layouts).where(eq(schema.layouts.title, 'B')).get())!.id;
    await call(bob, 'DELETE', `/api/layouts/${b}`);
    expect((await call(bob, 'POST', `/api/trash/${t}/restore`)).statusCode).toBe(200);
    // Space counts too.
    const big = trashIdOf(await call(bob, 'DELETE', `/api/layouts/${a}`));
    await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: ada.cookie }, payload: { layoutsPerUser: null, storagePerUser: 10 } });
    invalidateLimitCaches();
    const full = await call(bob, 'POST', `/api/trash/${big}/restore`);
    expect(full.statusCode).toBe(403);
    expect(full.json()).toMatchObject({ error: 'limit_reached', limit: 'storagePerUser' });
    await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: ada.cookie }, payload: { storagePerUser: null } });
    invalidateLimitCaches();
  });

  it('a collection that filled up meanwhile is left as it is, and the restore says which', async () => {
    expect(TRASH_MAX_COLLECTION_ITEMS).toBe(MAX_COLLECTION_ITEMS);
    const now = new Date();
    const mk = async (title: string) => {
      const id = randomUUID();
      await db.insert(schema.modules).values({ id, title, ownerUserId: ada.id, createdBy: ada.id, docSnapshot: doc(), latestVersion: 1, createdAt: now, updatedAt: now });
      return id;
    };
    const coll = randomUUID();
    await db.insert(schema.catalogCollections).values({ id: coll, title: 'Picks', ownerUserId: ada.id, status: 'draft', audience: 'private', createdAt: now, updatedAt: now } as never);
    const first = await mk('First');
    await db.insert(schema.catalogCollectionModules).values({ collectionId: coll, moduleId: first, position: 0 });
    const t = trashIdOf(await call(ada, 'DELETE', `/api/modules/${first}`));
    for (let i = 0; i < MAX_COLLECTION_ITEMS; i++) await db.insert(schema.catalogCollectionModules).values({ collectionId: coll, moduleId: await mk(`M${i}`), position: i });
    const res = (await call(ada, 'POST', `/api/trash/${t}/restore`)).json() as { ok: boolean; collections: { back: unknown[]; gone: number; full: { id: string; title: string }[] } };
    expect(res.ok).toBe(true);
    expect(res.collections).toEqual({ back: [], gone: 0, full: [{ id: coll, title: 'Picks' }] });
    expect((await db.select().from(schema.catalogCollectionModules).where(eq(schema.catalogCollectionModules.collectionId, coll)).all()).length).toBe(MAX_COLLECTION_ITEMS);
    // The module itself is back.
    expect(await db.select().from(schema.modules).where(eq(schema.modules.id, first)).get()).toBeTruthy();
  });

  it('a public link stops when the layout is deleted and stays stopped after a restore', async () => {
    const { id } = (await call(ada, 'POST', '/api/layouts', { title: 'Shared' })).json() as { id: string };
    const share = (await call(ada, 'POST', `/api/layouts/${id}/public-share`)).json() as { token: string };
    // A link that has stopped answers 200 with no layout (so old links don't add up to a burst of 404s).
    const open = async () => ((await app.inject({ method: 'GET', url: `/api/public-layouts/${share.token}` })).json() as { layout: { id: string } | null }).layout;
    expect((await open())?.id).toBe(id);
    const t = trashIdOf(await call(ada, 'DELETE', `/api/layouts/${id}`));
    expect(await open()).toBeNull();
    expect((await call(ada, 'POST', `/api/trash/${t}/restore`)).statusCode).toBe(200);
    expect(await open()).toBeNull();
    expect((await db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get())!.publicShareToken).toBeNull();
    // One kept before links were left out (the token still in its row) comes back private too.
    await db.update(schema.layouts).set({ publicShareToken: share.token }).where(eq(schema.layouts.id, id));
    const { trashLayout } = await import('../../trash/trash.js');
    const row = (await db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get())!;
    const t2 = (await trashLayout(id, row.docSnapshot as Uint8Array, ada.id))!;
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const kept = (await db.select().from(schema.trashItems).where(eq(schema.trashItems.id, t2)).get())!;
    const old = JSON.parse(gunzipSync(kept.payload as Uint8Array).toString('utf8')) as { rows: { layouts: { publicShareToken: string | null }[] } };
    expect(old.rows.layouts[0]!.publicShareToken).toBeNull();
    old.rows.layouts[0]!.publicShareToken = share.token;
    await db.update(schema.trashItems).set({ payload: gzipSync(Buffer.from(JSON.stringify(old))) }).where(eq(schema.trashItems.id, t2));
    await db.delete(schema.layouts).where(eq(schema.layouts.id, id));
    expect((await call(ada, 'POST', `/api/trash/${t2}/restore`)).statusCode).toBe(200);
    expect(await open()).toBeNull();
  });

  it('Delete now takes the background picture off the disk and leaves a record; a restored layout keeps its picture', async () => {
    const dir = imagesDirFor(env.dbPath);
    mkdirSync(dir, { recursive: true });
    const mk = async (title: string) => {
      const { id } = (await call(ada, 'POST', '/api/layouts', { title })).json() as { id: string };
      writeFileSync(join(dir, `${id}.png`), 'a picture');
      return id;
    };
    const gone = await mk('Gone');
    const kept = await mk('Kept');
    const t1 = trashIdOf(await call(ada, 'DELETE', `/api/layouts/${gone}`));
    const t2 = trashIdOf(await call(ada, 'DELETE', `/api/layouts/${kept}`));
    expect((await call(ada, 'POST', `/api/trash/${t2}/restore`)).statusCode).toBe(200);
    expect((await call(ada, 'DELETE', `/api/trash/${t1}`)).statusCode).toBe(200);
    const left = existsSync(dir) ? readdirSync(dir) : [];
    expect(left).not.toContain(`${gone}.png`);
    expect(left).toContain(`${kept}.png`);
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'delete_forever')).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: ada.id, resourceKind: 'layout', resourceId: gone });
    expect(JSON.parse(events[0]!.payload)).toEqual({ title: 'Gone' });
    // Someone else's try leaves no record.
    const t3 = trashIdOf(await call(ada, 'DELETE', `/api/layouts/${kept}`));
    expect((await call(bob, 'DELETE', `/api/trash/${t3}`)).statusCode).toBe(404);
    expect((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'delete_forever')).all()).length).toBe(1);
  });
});

describe('Recently deleted: Delete now reaches the club’s other admins', () => {
  it('a club item erased by one admin tells the club’s members to look again; a person’s own tells only them', async () => {
    const { ROUTE_HINTS } = await import('../../events/routeHints.js');
    const spec = ROUTE_HINTS['DELETE /api/trash/:id']!;
    const club = (await call(ada, 'POST', '/api/orgs', { name: 'Hint Club' })).json() as { slug: string };
    const orgId = (await db.select().from(schema.orgs).where(eq(schema.orgs.slug, club.slug)).get())!.id;
    await db.insert(schema.orgMembers).values({ orgId, userId: bob.id, role: 'member', joinedAt: new Date() } as never);
    const now = new Date();
    const layoutId = randomUUID();
    await db.insert(schema.layouts).values({ id: layoutId, title: 'Club yard', ownerOrgId: orgId, createdBy: ada.id, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(createDefaultLayoutDoc())) });
    const clubTrash = ((await call(ada, 'DELETE', `/api/layouts/${layoutId}`)).json() as { trashId: string }).trashId;
    const own = (await call(ada, 'POST', '/api/layouts', { title: 'Mine' })).json() as { id: string };
    const ownTrash = ((await call(ada, 'DELETE', `/api/layouts/${own.id}`)).json() as { trashId: string }).trashId;

    const hintsFor = async (trashId: string) => {
      const ctx = { req: { method: 'DELETE', routeOptions: { url: '/api/trash/:id' } }, params: { id: trashId }, body: {}, reply: { ok: true }, userId: ada.id, before: {} } as never;
      await spec.before!(ctx);
      expect((await call(ada, 'DELETE', `/api/trash/${trashId}`)).statusCode).toBe(200);
      return (await spec.after(ctx)) as unknown as { hint: { kind: string; id?: string; owner?: { kind: string; id: string } }; reach?: { users: string[] } }[];
    };
    const forClub = await hintsFor(clubTrash);
    expect(forClub.map((h) => h.hint.kind)).toEqual(['me', 'layout']);
    expect(forClub[1]!.hint).toMatchObject({ id: layoutId, owner: { kind: 'org', id: orgId } });
    expect([...forClub[1]!.reach!.users].sort()).toEqual([ada.id, bob.id].sort());
    const forOwn = await hintsFor(ownTrash);
    expect(forOwn.map((h) => h.hint.kind)).toEqual(['me']);
  });
});
