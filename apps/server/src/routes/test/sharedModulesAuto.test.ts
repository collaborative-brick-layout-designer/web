// Shared modules, phase 2 (docs/shared-modules.md): the layout setting
// "Updates from shared modules" (Ask first / Automatically), the server
// putting each new version in for Automatically layouts (in an open room
// and in a closed one, once), the "updates" count in the layout lists,
// and "Updated while you were away".

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc, decodeDoc } from '@cld/ydoc';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { invalidateLimitCaches } from '../../limits/limits.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { forgetLayout, syncLayoutSharedModules } from '../../sharedModules/placed.js';
import { automaticUpdatesSettled } from '../../sharedModules/auto.js';
import { stampVisit } from '../../sharedModules/visits.js';
import { contents, moduleOf, partsOf, place, type Part } from '../../test/sharedWorld.js';

type Who = { cookie: string; id: string };

const V1: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }];
const V2: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }, { pn: 'c.1', x: 8, y: 2 }];
const V3: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }, { pn: 'c.1', x: 8, y: 2 }, { pn: 'd.1', x: 12, y: 2 }];

describe('shared modules: Automatically, list badges, while you were away', () => {
  let app: FastifyInstance;
  const open: string[] = [];
  beforeAll(async () => {
    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    await registerApiRoutes(app);
    await app.ready();
  });
  afterAll(async () => {
    closeAll();
    await app.close();
  });
  beforeEach(async () => {
    await automaticUpdatesSettled();
    await docHub.closeMany(open.splice(0));
    resetDb();
    forgetLayout();
    invalidateLimitCaches();
  });

  const call = (who: Who | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
  async function club(admin: Who, name: string, ...members: Who[]): Promise<{ id: string; slug: string }> {
    const { id, slug } = (await call(admin, 'POST', '/api/orgs', { name })).json() as { id: string; slug: string };
    for (const m of members) await db.insert(schema.orgMembers).values({ orgId: id, userId: m.id, role: 'member', joinedAt: new Date() });
    return { id, slug };
  }
  async function save(who: Who, id: string, parts: Part[], note?: string) {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot${note ? `?note=${encodeURIComponent(note)}` : ''}`,
      headers: { cookie: who.cookie, 'content-type': 'application/octet-stream' },
      payload: contents(parts),
    });
    expect(r.statusCode).toBe(200);
    await automaticUpdatesSettled();
  }
  async function layout(owner: { ownerUserId?: string; ownerOrgId?: string }, title: string, createdBy: string, build: (doc: Y.Doc) => void): Promise<string> {
    const id = randomUUID();
    const doc = createDefaultLayoutDoc();
    build(doc);
    const now = new Date();
    await db.insert(schema.layouts).values({ id, title, ...owner, createdBy, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(doc)) });
    await syncLayoutSharedModules(id, doc);
    doc.destroy();
    open.push(id);
    return id;
  }
  /** The layout as it is stored (no room open). */
  async function stored(id: string): Promise<Y.Doc> {
    const row = await db.select({ docSnapshot: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, id)).get();
    return decodeDoc(row!.docSnapshot as Uint8Array);
  }

  /** Alice's crane shared with Riverside LUG and placed, as version 1, in two of the club's layouts. */
  async function world() {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const eve = await loginAs(app, 'eve@example.com');
    const lug = await club(bob, 'Riverside LUG', alice, carol);
    const crane = ((await call(alice, 'POST', '/api/modules', { title: 'Harbor crane' })).json() as { id: string }).id;
    await save(alice, crane, V1);
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug })).statusCode).toBe(201);
    const v1 = contents(V1);
    const build = (doc: Y.Doc) => place(doc, { placedId: 'placed-1', moduleId: crane, version: 1, bytes: v1, placement: { degrees: 0, x: 100, y: 50 } });
    const show = await layout({ ownerOrgId: lug.id }, 'Show plan', bob.id, build);
    const yard = await layout({ ownerOrgId: lug.id }, 'Yard', bob.id, build);
    return { alice, bob, carol, eve, lug, crane, show, yard };
  }

  it('the layout setting: Ask first by default; the layout’s editors change it, nobody else', async () => {
    const { alice, carol, eve, show } = await world();
    const get = async (who: Who) => (await call(who, 'GET', `/api/layouts/${show}`)).json() as { layout: { sharedModuleUpdates: string } };
    expect((await get(carol)).layout.sharedModuleUpdates).toBe('ask');
    expect(((await call(carol, 'GET', `/api/layouts/${show}/shared-modules`)).json() as { updates: string }).updates).toBe('ask');
    const r = await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, updates: 'auto' });
    expect((await get(alice)).layout.sharedModuleUpdates).toBe('auto');
    expect(((await call(carol, 'GET', `/api/layouts/${show}/shared-modules`)).json() as { updates: string }).updates).toBe('auto');
    expect((await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'always' })).statusCode).toBe(400);
    expect((await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 1 })).statusCode).toBe(400);
    expect((await call(eve, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'ask' })).statusCode).toBe(404);
    expect((await call(null, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'ask' })).statusCode).toBe(401);
    // A viewer can't.
    const vic = await loginAs(app, 'vic@example.com');
    await db.insert(schema.layoutCollaborators).values({ layoutId: show, userId: vic.id, role: 'viewer', addedAt: new Date() });
    expect((await call(vic, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'ask' })).statusCode).toBe(403);
    expect((await get(alice)).layout.sharedModuleUpdates).toBe('auto');
  });

  it('Automatically: the owner saves, and a layout nobody has open gets the new version once, where the module sits', async () => {
    const { alice, carol, crane, show, yard } = await world();
    expect((await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' })).statusCode).toBe(200);
    await automaticUpdatesSettled();
    await docHub.closeMany([show, yard]);
    await save(alice, crane, V2, 'longer pier');
    const doc = await stored(show);
    expect(partsOf(doc).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 100, 50], ['b.1', 104, 50], ['c.1', 108, 52]]);
    expect(moduleOf(doc, 'placed-1')).toMatchObject({ libraryVersion: 2, shared: { review: { from: 1, to: 2 } } });
    // Ask first: untouched.
    expect(partsOf(await stored(yard)).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    // Written down once, by nobody in particular.
    const events = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.layoutId, show), eq(schema.auditEvents.eventType, 'shared_module_auto_update'))).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBeNull();
    expect(JSON.parse(events[0]!.payload)).toEqual({ sharedModule: crane, placedId: 'placed-1', from: 1, version: 2, parts: 3 });
    // Its row follows.
    const row = await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, show)).get();
    expect(row?.version).toBe(2);
  });

  it('Automatically: in a room that is open, the change is there with no Update pressed', async () => {
    const { alice, carol, crane, show } = await world();
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    const session = await docHub.getOrCreate(show);
    await save(alice, crane, V2);
    expect(partsOf(session.doc).map((p) => p.pn)).toEqual(['a.1', 'b.1', 'c.1']);
    // Saved again: version 3 follows.
    await save(alice, crane, V3);
    expect(partsOf(session.doc).map((p) => p.pn)).toEqual(['a.1', 'b.1', 'c.1', 'd.1']);
    expect(moduleOf(session.doc, 'placed-1')).toMatchObject({ libraryVersion: 3 });
  });

  it('a module no longer shared with the layout gets no automatic updates', async () => {
    const { alice, carol, crane, lug, show } = await world();
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    expect((await app.inject({ method: 'DELETE', url: `/api/modules/${crane}/club-shares/${lug.id}`, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    await docHub.closeMany([show]);
    await save(alice, crane, V2);
    expect(partsOf(await stored(show)).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
  });

  it('switching to Automatically puts in what the layout was waiting on', async () => {
    const { alice, carol, crane, show } = await world();
    await save(alice, crane, V2);
    await docHub.closeMany([show]);
    expect(partsOf(await stored(show)).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    await automaticUpdatesSettled();
    await docHub.closeMany([show]);
    expect(partsOf(await stored(show)).map((p) => p.pn)).toEqual(['a.1', 'b.1', 'c.1']);
  });

  it('the layout lists count the updates waiting in Ask first layouts', async () => {
    const { alice, bob, carol, eve, crane, lug, show, yard } = await world();
    type Item = { id: string; sharedUpdates: number; sharedModuleUpdates: string };
    const listed = async (who: Who, q = '') => ((await call(who, 'GET', `/api/layouts${q}`)).json() as { layouts: Item[] }).layouts;
    expect((await listed(carol)).map((l) => l.sharedUpdates)).toEqual([0, 0]);
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    await save(alice, crane, V2);
    const byId = new Map((await listed(carol)).map((l) => [l.id, l]));
    expect(byId.get(yard)).toMatchObject({ sharedUpdates: 1, sharedModuleUpdates: 'ask' });
    expect(byId.get(show)).toMatchObject({ sharedUpdates: 0, sharedModuleUpdates: 'auto' });
    // The club's own list says the same.
    expect((await listed(bob, `?owner=${lug.slug}`)).find((l) => l.id === yard)?.sharedUpdates).toBe(1);
    // Someone outside the club sees neither layout.
    expect(await listed(eve)).toEqual([]);
    // Updated: the badge goes.
    expect((await call(carol, 'POST', `/api/layouts/${yard}/shared-modules/placed-1/apply`, {})).statusCode).toBe(200);
    expect((await listed(carol)).find((l) => l.id === yard)?.sharedUpdates).toBe(0);
  });

  it('Updated while you were away: what went in since you last had it open, once', async () => {
    const { alice, carol, crane, eve, show } = await world();
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    type Away = { updates: { placedId: string; moduleId: string; from: number | null; to: number; version: number; title: string | null; at: number }[] };
    const away = async (who: Who) => (await call(who, 'POST', `/api/layouts/${show}/shared-modules/away`)).json() as Away;
    // The first time ever: nothing to say, and the visit is noted.
    expect((await away(carol)).updates).toEqual([]);
    await save(alice, crane, V2, 'longer pier');
    await save(alice, crane, V3);
    const seen = await away(carol);
    expect(seen.updates).toEqual([{ placedId: 'placed-1', moduleId: crane, from: 1, to: 3, version: 3, title: 'Harbor crane', at: expect.any(Number) }]);
    // Said once.
    expect((await away(carol)).updates).toEqual([]);
    // Someone who can't open the layout learns nothing.
    expect((await call(eve, 'POST', `/api/layouts/${show}/shared-modules/away`)).statusCode).toBe(404);
    expect((await call(null, 'POST', `/api/layouts/${show}/shared-modules/away`)).statusCode).toBe(401);
  });

  it('an update made while you were in the layout is not news when you come back', async () => {
    const { alice, carol, crane, show } = await world();
    await call(carol, 'PUT', `/api/layouts/${show}/shared-modules/updates`, { updates: 'auto' });
    await stampVisit(show, carol.id, new Date(Date.now() - 60_000));
    await save(alice, crane, V2);
    // Leaving the room stamps the visit (ws/handler.ts does this on close).
    await stampVisit(show, carol.id);
    const r = (await call(carol, 'POST', `/api/layouts/${show}/shared-modules/away`)).json() as { updates: unknown[] };
    expect(r.updates).toEqual([]);
  });
});
