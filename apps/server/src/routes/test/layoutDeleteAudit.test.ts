// Web #498: an owner's layout delete leaves a record, and site admins can
// still read a deleted layout's whole history.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { orgRoutes } from '../orgs.js';
import { adminRoutes } from '../admin.js';

type Who = { cookie: string; id: string };
let app: FastifyInstance;
let ada: Who;
let root: Who;
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });

beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, layoutRoutes, orgRoutes, adminRoutes]) await app.register(r);
  ada = await loginAs(app, 'ada@example.com');
  root = await loginAs(app, 'root@example.com');
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, root.id));
});
afterEach(async () => {
  await app.close();
});

describe('layout deletes are recorded', () => {
  it('the owner’s delete writes layout_delete with who, the title and whose it was; admins list it and read its history', async () => {
    const { id } = (await call(ada, 'POST', '/api/layouts', { title: 'Main yard' })).json() as { id: string };
    await call(ada, 'PATCH', `/api/layouts/${id}`, { title: 'Main yard 2' });
    expect((await call(ada, 'DELETE', `/api/layouts/${id}`)).statusCode).toBe(200);
    const rows = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.layoutId, id), eq(schema.auditEvents.eventType, 'layout_delete'))).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(ada.id);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ title: 'Main yard 2', owner: 'self' });

    const list = (await call(root, 'GET', '/api/admin/deleted-layouts')).json() as { layouts: { layoutId: string; title: string; by: string; deletedBy: string; events: number }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.layouts[0]).toMatchObject({ layoutId: id, title: 'Main yard 2', by: 'owner' });
    expect(list.layouts[0]!.events).toBeGreaterThanOrEqual(1);
    const history = (await call(root, 'GET', `/api/admin/audit?layout=${id}`)).json() as { events: { eventType: string; layoutId: string }[] };
    expect(history.events.every((e) => e.layoutId === id)).toBe(true);
    expect(history.events.map((e) => e.eventType)).toContain('layout_delete');
    // Only site admins.
    expect((await call(ada, 'GET', '/api/admin/deleted-layouts')).statusCode).toBe(403);
  });

  it('a club’s layout records the club, and no user agent or address', async () => {
    await call(ada, 'POST', '/api/orgs', { name: 'ArkLUG', slug: 'arklug' });
    const { id } = (await call(ada, 'POST', '/api/layouts', { title: 'Club yard', orgSlug: 'arklug' })).json() as { id: string };
    expect((await call(ada, 'DELETE', `/api/layouts/${id}`)).statusCode).toBe(200);
    const row = (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.layoutId, id), eq(schema.auditEvents.eventType, 'layout_delete'))).get())!;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ title: 'Club yard', owner: 'club', clubName: 'ArkLUG' });
    expect(JSON.stringify(payload)).not.toMatch(/userAgent|user_agent|client|ip/i);
  });
});
