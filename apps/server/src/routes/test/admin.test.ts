// Integration tests for /api/admin/* routes.
// All admin endpoints require the caller to be a global admin (isGlobalAdmin=true).
// This file covers: stats, users (list/get/patch/delete/revoke-sessions),
// orgs (list/delete), and layouts (list/delete).

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, resetDb, schema, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';
import { orgRoutes } from '../orgs.js';
import { adminRoutes } from '../admin.js';
import { clubDeletionRoutes } from '../clubDeletion.js';
import { readSecret } from '../../secrets/secretBox.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  await app.register(orgRoutes);
  await app.register(adminRoutes);
  await app.register(clubDeletionRoutes);
  return app;
}

async function registerAndLogin(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/password/register',
    payload: { email, password: 'correct horse battery', displayName: email },
  });
  expect(res.statusCode).toBe(200);
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const verification = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.userId, user!.id))
    .get();
  const verifyRes = await app.inject({
    method: 'POST',
    url: `/api/auth/password/verify-email/${await testVerificationToken(verification!)}`,
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
}

/** Promote a user to global admin directly in the DB. */
async function promoteToAdmin(email: string): Promise<void> {
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.email, email));
}

async function getUserId(email: string): Promise<string> {
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (!user) throw new Error(`user not found: ${email}`);
  return user.id;
}

// ---- auth gate -----------------------------------------------------------

describe('admin routes — auth gate', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when authenticated but not a global admin', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});

// ---- stats ---------------------------------------------------------------

describe('admin stats', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns zero counts on empty DB', async () => {
    const cookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      users: number; globalAdmins: number;
      orgs: number; layouts: number; customParts: number; modules: number; activeSessions: number;
    };
    // The admin themselves is a user.
    expect(body.users).toBe(1);
    expect(body.globalAdmins).toBe(1);
    expect(body.orgs).toBe(0);
    expect(body.layouts).toBe(0);
    // No per-person demo count any more.
    expect(body).not.toHaveProperty('demoUsers');
  });

  it('reflects newly created resources', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');

    await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'L' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: adminCookie } });
    const body = res.json() as { users: number; layouts: number };
    expect(body.users).toBe(2);
    expect(body.layouts).toBe(1);
  });
});

// ---- users ---------------------------------------------------------------

describe('admin users — list', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('lists all users', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');

    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { users, total } = res.json() as { users: { email: string }[]; total: number };
    expect(total).toBe(2);
    expect(users.map((u) => u.email)).toContain('alice@example.com');
  });

  it('filters users by email prefix', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'bob@example.com');

    const res = await app.inject({ method: 'GET', url: '/api/admin/users?q=bob', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { users, total } = res.json() as { users: { email: string }[]; total: number };
    expect(total).toBe(1);
    expect(users[0]?.email).toBe('bob@example.com');
  });

  it('returns empty list when query matches nothing', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const res = await app.inject({ method: 'GET', url: '/api/admin/users?q=zzz-nobody', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { users } = res.json() as { users: unknown[] };
    expect(users).toHaveLength(0);
  });

  it('respects limit and offset', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    await registerAndLogin(app, 'bob@example.com');

    const page1 = (await app.inject({ method: 'GET', url: '/api/admin/users?limit=1&offset=0', headers: { cookie: adminCookie } })).json() as { users: unknown[]; total: number };
    expect(page1.users).toHaveLength(1);
    expect(page1.total).toBe(3);

    const page2 = (await app.inject({ method: 'GET', url: '/api/admin/users?limit=1&offset=1', headers: { cookie: adminCookie } })).json() as { users: unknown[] };
    expect(page2.users).toHaveLength(1);
  });
});

describe('admin users — get / patch / delete', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('GET /api/admin/users/:id returns user detail with stats', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({ method: 'GET', url: `/api/admin/users/${aliceId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { email: string }; stats: { layouts: number } };
    expect(body.user.email).toBe('alice@example.com');
    expect(typeof body.stats.layouts).toBe('number');
  });

  it('GET /api/admin/users/:id returns 404 for unknown id', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/admin/users/00000000-0000-0000-0000-000000000000', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH promotes a user to global admin', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${aliceId}`,
      headers: { cookie: adminCookie },
      payload: { isGlobalAdmin: true },
    });
    expect(res.statusCode).toBe(200);

    const alice = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get();
    expect(alice!.isGlobalAdmin).toBe(true);
  });

  it('PATCH can no longer make someone a demo account', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${aliceId}`,
      headers: { cookie: adminCookie },
      payload: { isDemoAccount: true },
    });
    expect(res.statusCode).toBe(400);
    const alice = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get();
    expect(alice!.isDemoAccount).toBe(false);
  });

  it('PATCH cannot demote self', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const adminId = await getUserId('admin@example.com');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { isGlobalAdmin: false },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('cannot_demote_self');
  });

  it('PATCH with empty body returns 400', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${aliceId}`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('empty_patch');
  });

  it('DELETE removes a user', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${aliceId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);

    const alice = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get();
    expect(alice).toBeUndefined();
  });

  it('DELETE cannot delete self', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const adminId = await getUserId('admin@example.com');

    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${adminId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('cannot_delete_self');
  });

  it('POST /revoke-all invalidates sessions', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${aliceId}/sessions/revoke-all`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});

// ---- orgs ----------------------------------------------------------------

describe('admin orgs', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('lists all orgs with member counts', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Acme', slug: 'acme' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/orgs', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { orgs, total } = res.json() as { orgs: { slug: string; memberCount: number }[]; total: number };
    expect(total).toBe(1);
    expect(orgs[0]?.slug).toBe('acme');
    expect(orgs[0]?.memberCount).toBe(1); // creator is a member
  });

  it('filters orgs by name', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Acme' },
    });
    await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Widgets Inc' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/orgs?q=acme', headers: { cookie: adminCookie } });
    const { orgs } = res.json() as { orgs: { name: string }[] };
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.name).toBe('Acme');
  });

  it('deletes an org', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const create = await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Delete Me', slug: 'delete-me' },
    });
    const orgId = (create.json() as { id: string }).id;

    // Deleting waits first (hidden, restorable)...
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/orgs/${orgId}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBe(200);
    const waiting = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
    expect(waiting!.deletionDueAt).not.toBeNull();
    // ...and "Erase now" skips the wait, after typing its name.
    expect((await app.inject({ method: 'POST', url: `/api/admin/orgs/${orgId}/erase`, headers: { cookie: adminCookie }, payload: { confirm: 'nope' } })).statusCode).toBe(400);
    const erase = await app.inject({ method: 'POST', url: `/api/admin/orgs/${orgId}/erase`, headers: { cookie: adminCookie }, payload: { confirm: 'delete me' } });
    expect(erase.statusCode).toBe(200);

    const org = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
    expect(org).toBeUndefined();
  });

  it('returns 404 when deleting a non-existent org', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const res = await app.inject({ method: 'DELETE', url: '/api/admin/orgs/00000000-0000-0000-0000-000000000000', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/admin/orgs/:id returns member list, layout stats, and 404 for an unknown id', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const create = await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Detail Org', slug: 'detail-org' },
    });
    const orgId = (create.json() as { id: string }).id;

    const res = await app.inject({ method: 'GET', url: `/api/admin/orgs/${orgId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      org: { slug: string };
      stats: { members: number; layouts: number; layoutSizeBytes: number };
      members: { email: string; role: string }[];
      layouts: unknown[];
    };
    expect(body.org.slug).toBe('detail-org');
    expect(body.stats.members).toBe(1);
    expect(body.members[0]?.email).toBe('admin@example.com');
    expect(body.members[0]?.role).toBe('admin');
    expect(body.stats.layouts).toBe(0);
    expect(body.layouts).toHaveLength(0);

    const notFound = await app.inject({
      method: 'GET', url: '/api/admin/orgs/00000000-0000-0000-0000-000000000000', headers: { cookie: adminCookie },
    });
    expect(notFound.statusCode).toBe(404);
  });
});

// ---- layout stats (count + size) — users, orgs, layouts list ---------------

describe('admin layout stats — size and count aggregation', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('GET /api/admin/users includes emailVerified, layoutCount, and layoutSizeBytes', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    const create = await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: aliceCookie }, payload: { title: 'Alice Layout' },
    });
    expect(create.statusCode).toBe(201);
    const layoutId = (create.json() as { id: string }).id;
    const layoutRow = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    const expectedSnapshotBytes = (layoutRow!.docSnapshot as Buffer).length;

    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    const { users } = res.json() as {
      users: { email: string; emailVerified: boolean; layoutCount: number; layoutSizeBytes: number }[];
    };
    const alice = users.find((u) => u.email === 'alice@example.com');
    expect(alice?.emailVerified).toBe(true);
    expect(alice?.layoutCount).toBe(1);
    expect(alice?.layoutSizeBytes).toBe(expectedSnapshotBytes);

    // Sanity: a user who registered but never verified should read false
    // (registerAndLogin always verifies — insert an unverified row directly).
    await db.insert(schema.users).values({
      id: 'unverified-1', email: 'pending@example.com', displayName: 'Pending', avatarUrl: null,
      passwordHash: null, isDemoAccount: false, isGlobalAdmin: false, emailVerified: false, createdAt: new Date(),
    });
    const res2 = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    const pending = (res2.json() as { users: { email: string; emailVerified: boolean }[] }).users
      .find((u) => u.email === 'pending@example.com');
    expect(pending?.emailVerified).toBe(false);
    void aliceId;
  });

  it('layout size includes pending layout_updates bytes, not just the snapshot', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');

    const create = await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: aliceCookie }, payload: { title: 'Hot Layout' },
    });
    const layoutId = (create.json() as { id: string }).id;
    const layoutRow = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    const snapshotBytes = (layoutRow!.docSnapshot as Buffer).length;

    // Simulate un-compacted Yjs updates sitting in layout_updates.
    const pendingBytes = 37;
    await db.insert(schema.layoutUpdates).values({
      layoutId, doc: 'main', updateBytes: Buffer.alloc(pendingBytes, 1), createdAt: new Date(),
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    const alice = (res.json() as { users: { email: string; layoutSizeBytes: number }[] }).users
      .find((u) => u.email === 'alice@example.com');
    expect(alice?.layoutSizeBytes).toBe(snapshotBytes + pendingBytes);
  });

  it('GET /api/admin/orgs includes layoutCount and layoutSizeBytes bounded to the current page', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const org = await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: adminCookie }, payload: { name: 'Org With Layouts', slug: 'org-with-layouts' },
    });
    const orgId = (org.json() as { id: string }).id;
    const transfer = await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'Org Layout' },
    });
    const layoutId = (transfer.json() as { id: string }).id;
    // Directly reassign ownership to the org (bypasses the transfer-accept flow — fine for this test's purposes).
    await db.update(schema.layouts).set({ ownerUserId: null, ownerOrgId: orgId }).where(eq(schema.layouts.id, layoutId));
    const layoutRow = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    const expectedBytes = (layoutRow!.docSnapshot as Buffer).length;

    const res = await app.inject({ method: 'GET', url: '/api/admin/orgs', headers: { cookie: adminCookie } });
    const acme = (res.json() as { orgs: { slug: string; layoutCount: number; layoutSizeBytes: number }[] }).orgs
      .find((o) => o.slug === 'org-with-layouts');
    expect(acme?.layoutCount).toBe(1);
    expect(acme?.layoutSizeBytes).toBe(expectedBytes);
  });

  it('GET /api/admin/layouts includes ownerUserEmail, ownerOrgName, and sizeBytes', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: aliceCookie }, payload: { title: 'Alice Layout' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/layouts', headers: { cookie: adminCookie } });
    const layout = (res.json() as {
      layouts: { title: string; ownerUserEmail: string | null; ownerOrgName: string | null; sizeBytes: number }[];
    }).layouts.find((l) => l.title === 'Alice Layout');
    expect(layout?.ownerUserEmail).toBe('alice@example.com');
    expect(layout?.ownerOrgName).toBeNull();
    expect(layout?.sizeBytes).toBeGreaterThan(0);
  });
});

// ---- layouts -------------------------------------------------------------

describe('admin layouts', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('lists all layouts', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'Awesome Layout' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/layouts', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { layouts, total } = res.json() as { layouts: { title: string }[]; total: number };
    expect(total).toBe(1);
    expect(layouts[0]?.title).toBe('Awesome Layout');
  });

  it('filters layouts by title', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'Alpha' } });
    await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'Beta' } });

    const res = await app.inject({ method: 'GET', url: '/api/admin/layouts?q=beta', headers: { cookie: adminCookie } });
    const { layouts } = res.json() as { layouts: { title: string }[] };
    expect(layouts).toHaveLength(1);
    expect(layouts[0]?.title).toBe('Beta');
  });

  it('filters layouts by ownerUserId', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const aliceId = await getUserId('alice@example.com');

    await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'Admin Layout' } });
    await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: aliceCookie }, payload: { title: 'Alice Layout' } });

    const res = await app.inject({
      method: 'GET', url: `/api/admin/layouts?ownerUserId=${aliceId}`, headers: { cookie: adminCookie },
    });
    const { layouts } = res.json() as { layouts: { title: string }[] };
    expect(layouts).toHaveLength(1);
    expect(layouts[0]?.title).toBe('Alice Layout');
  });

  it('deletes a layout', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const create = await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie: adminCookie }, payload: { title: 'To Delete' },
    });
    const layoutId = (create.json() as { id: string }).id;

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/layouts/${layoutId}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBe(200);

    const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    expect(layout).toBeUndefined();
  });

  it('returns 404 when deleting a non-existent layout', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const res = await app.inject({ method: 'DELETE', url: '/api/admin/layouts/00000000-0000-0000-0000-000000000000', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });
});

// ---- settings --------------------------------------------------------------

describe('admin settings', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('non-admins get 403 on GET and PATCH', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } });
    expect(get.statusCode).toBe(403);
    const patch = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie }, payload: { requireEmailVerification: false },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('sets the oldest desktop allowed, never below the code minimum, and clears it', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const get = async () =>
      (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } })).json().desktop;
    const patch = (minDesktopVersion: string | null) =>
      app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { minDesktopVersion } });

    expect(await get()).toEqual({ minimumSet: null, minimum: '1.2.0', recommended: '1.4.0', codeMinimum: '1.2.0' });
    expect((await patch('v1.4.0')).statusCode).toBe(200);
    expect(await get()).toEqual({ minimumSet: '1.4.0', minimum: '1.4.0', recommended: '1.4.0', codeMinimum: '1.2.0' });
    // Below the code's own minimum: kept, but not in force.
    expect((await patch('1.0.0')).statusCode).toBe(200);
    expect((await get()).minimum).toBe('1.2.0');
    expect((await patch('soon')).json()).toEqual({ error: 'invalid_desktop_version' });
    expect((await patch('')).statusCode).toBe(200);
    expect((await get()).minimumSet).toBeNull();
  });

  it('GET creates the singleton row on first access with the pre-existing default (verification required, no DB SMTP)', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { requireEmailVerification: boolean; smtp: { host: string | null; active: boolean; source: string | null; passSet: boolean } };
    expect(body.requireEmailVerification).toBe(true);
    expect(body.smtp.host).toBeNull();
    expect(body.smtp.passSet).toBe(false);
    // No SMTP_HOST env var set in this test process, so nothing is active.
    expect(body.smtp.active).toBe(false);
    expect(body.smtp.source).toBeNull();
  });

  it('PATCH toggling requireEmailVerification off persists and reflects on GET', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const patch = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { requireEmailVerification: false },
    });
    expect(patch.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect((get.json() as { requireEmailVerification: boolean }).requireEmailVerification).toBe(false);
  });

  it('never sends or audits the saved SMTP password', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const secret = 'S3cret-never-shown-9x';
    const patch = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpHost: 'smtp.example.com', smtpPort: 587, smtpPass: secret },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.body).not.toContain(secret);
    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(get.body).not.toContain(secret);
    expect((get.json() as { smtp: { passSet: boolean } }).smtp.passSet).toBe(true);
    const audits = await app.inject({ method: 'GET', url: '/api/admin/audit?limit=50', headers: { cookie: adminCookie } });
    expect(audits.body).not.toContain(secret);
  });

  it('PATCH with an empty body returns 400 empty_patch', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('empty_patch');
  });

  it('PATCH with an out-of-range smtpPort returns 400', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpHost: 'smtp.example.com', smtpPort: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_smtp_port');
  });

  it('PATCH sets a DB SMTP config; GET reports it active with source=database and never echoes the password', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    const patch = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: {
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'bot@example.com',
        smtpPass: 'super-secret',
        smtpFrom: 'noreply@example.com',
      },
    });
    expect(patch.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    const body = get.json() as { smtp: { host: string | null; passSet: boolean; active: boolean; source: string | null } };
    expect(body.smtp.host).toBe('smtp.example.com');
    expect(body.smtp.passSet).toBe(true);
    expect(body.smtp.active).toBe(true);
    expect(body.smtp.source).toBe('database');
    // Never leaked in the response body at all.
    expect(JSON.stringify(get.json())).not.toContain('super-secret');
  });

  it('PATCH with smtpPass omitted leaves a previously-saved password untouched', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpHost: 'smtp.example.com', smtpPass: 'first-secret' },
    });
    // Second PATCH changes only the from-address; smtpPass field absent.
    await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpFrom: 'updated@example.com' },
    });

    const row = await db.select().from(schema.platformSettings).get();
    // Stored encrypted (secrets/secretBox.ts), and still the same password.
    expect(row?.smtpPass).not.toContain('first-secret');
    expect(readSecret(row?.smtpPass)).toEqual({ state: 'ok', value: 'first-secret' });
    expect(row?.smtpFrom).toBe('updated@example.com');
  });

  it('PATCH with smtpPass="" explicitly clears a previously-saved password', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    await promoteToAdmin('admin@example.com');

    await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpHost: 'smtp.example.com', smtpPass: 'to-be-cleared' },
    });
    await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpPass: '' },
    });

    const row = await db.select().from(schema.platformSettings).get();
    expect(row?.smtpPass).toBeNull();
  });

  it('PATCH writes an audit event with the password redacted', async () => {
    const adminCookie = await registerAndLogin(app, 'admin@example.com');
    const adminId = await getUserId('admin@example.com');
    await promoteToAdmin('admin@example.com');

    await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { smtpHost: 'smtp.example.com', smtpPass: 'do-not-leak' },
    });

    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'admin_settings_patch'))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]?.userId).toBe(adminId);
    expect(events[0]?.payload).not.toContain('do-not-leak');
    expect(events[0]?.payload).toContain('redacted');
  });
});
