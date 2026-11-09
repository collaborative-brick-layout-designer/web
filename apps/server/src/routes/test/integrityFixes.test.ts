// Area 2 review fixes: a deleted layout or venue leaves an audit record;
// the venue library takes only venues (and never two of one name); a club
// invite opened while the club waits to be deleted is kept, and works again
// once the club is restored.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { orgRoutes } from '../orgs.js';
import { orgInviteRoutes } from '../orgInvites.js';
import { venueRoutes, venueDataProblem } from '../venues.js';
import { requestClubDeletion, restoreClub } from '../../privacy/clubDeletion.js';

type Who = { cookie: string; id: string };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, layoutRoutes, orgRoutes, orgInviteRoutes, venueRoutes]) await app.register(r);
  return app;
}

let app: FastifyInstance;
let ada: Who;
let bob: Who;
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });

beforeEach(async () => {
  resetDb();
  app = await buildApp();
  ada = await loginAs(app, 'ada@example.com');
  bob = await loginAs(app, 'bob@example.com');
});
afterEach(async () => {
  await app.close();
});

const VENUE = { name: 'Hall', enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 100, h: 50 }, edges: [], obstacles: [] };

describe('deleting leaves a record', () => {
  it('a layout: who deleted it, its title and owner', async () => {
    const { id } = (await call(ada, 'POST', '/api/layouts', { title: 'Main yard' })).json() as { id: string };
    expect((await call(ada, 'DELETE', `/api/layouts/${id}`)).statusCode).toBe(200);
    const rows = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.layoutId, id), eq(schema.auditEvents.eventType, 'delete'))).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(ada.id);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ title: 'Main yard', ownerUserId: ada.id });
  });

  it('a venue: who deleted it and its name', async () => {
    const { id } = (await call(ada, 'POST', '/api/venues', { name: 'Hall', data: VENUE })).json() as { id: string };
    expect((await call(ada, 'DELETE', `/api/venues/${id}`)).statusCode).toBe(200);
    const rows = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.resourceKind, 'venue'), eq(schema.auditEvents.resourceId, id))).all();
    expect(rows.map((r) => r.eventType)).toEqual(['delete']);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ name: 'Hall' });
  });
});

describe('the venue library takes only venues', () => {
  it.each([5, 'text', [1, 2, 3], { bounds: 'wide' }, { bounds: { x: 'a' } }, { edges: 'none' }, { obstacles: [1] }])('refuses %j', async (data) => {
    const res = await call(ada, 'POST', '/api/venues', { name: 'Bad', data });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_venue' });
  });

  it('refuses one that is too big, on save and on change', async () => {
    const big = { ...VENUE, notes: [{ text: 'x'.repeat(1024 * 1024) }] };
    expect((await call(ada, 'POST', '/api/venues', { name: 'Big', data: big })).statusCode).toBe(413);
    const { id } = (await call(ada, 'POST', '/api/venues', { name: 'Hall', data: VENUE })).json() as { id: string };
    expect((await call(ada, 'PATCH', `/api/venues/${id}`, { data: [1] })).statusCode).toBe(400);
    expect((await call(ada, 'PATCH', `/api/venues/${id}`, { data: big })).statusCode).toBe(413);
  });

  it('a second venue of the same name gets "(2)", never a duplicate', async () => {
    const a = (await call(ada, 'POST', '/api/venues', { name: 'Hall', data: VENUE })).json() as { name: string };
    const b = (await call(ada, 'POST', '/api/venues', { name: 'hall', data: VENUE })).json() as { name: string };
    expect(a.name).toBe('Hall');
    expect(b.name).not.toBe('hall');
    expect(b.name.toLowerCase()).not.toBe('hall');
  });

  it('takes a real venue file’s contents', () => {
    expect(venueDataProblem(VENUE)).toBeNull();
    expect(venueDataProblem({})).toBeNull();
  });
});

describe('a club waiting to be deleted', () => {
  it('keeps its invites: the link says why, and works again once the club is restored', async () => {
    await call(ada, 'POST', '/api/orgs', { name: 'ArkLUG', slug: 'arklug' });
    const invite = (await call(ada, 'POST', '/api/orgs/arklug/invites', { email: 'bob@example.com', role: 'member' })).json() as { token: string };
    const org = (await db.select().from(schema.orgs).where(eq(schema.orgs.slug, 'arklug')).get())!;
    const actor = { id: ada.id, displayName: 'Ada' };
    await requestClubDeletion(org, actor, { catalog: 'hand', heirUserId: null });

    const preview = await call(bob, 'GET', `/api/org-invites/${invite.token}`);
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: 'club_being_deleted' });
    const accept = await call(bob, 'POST', `/api/org-invites/${invite.token}`);
    expect(accept.statusCode).toBe(409);
    expect(accept.json()).toEqual({ error: 'club_being_deleted' });
    // Still there.
    expect(await db.select().from(schema.orgInvites).where(eq(schema.orgInvites.token, invite.token)).get()).toBeTruthy();

    await restoreClub((await db.select().from(schema.orgs).where(eq(schema.orgs.slug, 'arklug')).get())!, actor);
    expect((await call(bob, 'POST', `/api/org-invites/${invite.token}`)).statusCode).toBe(200);
  });
});
