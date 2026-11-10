// Extended integration tests for module routes:
//   GET    /api/modules               — list
//   GET    /api/modules/:id           — get one
//   PATCH  /api/modules/:id           — rename
//   DELETE /api/modules/:id           — delete
//   GET    /api/modules/:id/collaborators  — list collaborators
//   POST   /api/modules/:id/invites        — invite by link (accepted in moduleInvites.test.ts)
//   DELETE /api/modules/:id/collaborators/:userId — remove

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { db, resetDb, schema, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { orgRoutes } from '../orgs.js';
import { moduleRoutes } from '../modules.js';
import { moduleInviteRoutes } from '../moduleInvites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(orgRoutes);
  await app.register(moduleRoutes);
  await app.register(moduleInviteRoutes);
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

async function createModule(app: FastifyInstance, cookieStr: string, title = 'My Module'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/modules',
    headers: { cookie: cookieStr },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('modules — list', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns an empty list for a new user', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { modules: unknown[] }).modules).toHaveLength(0);
  });

  it('returns modules owned by the user', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    await createModule(app, cookie, 'A');
    await createModule(app, cookie, 'B');
    const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } });
    expect((res.json() as { modules: unknown[] }).modules).toHaveLength(2);
  });

  it('returns shared modules (not just owned)', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie, 'Shared');

    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'viewer', addedAt: new Date() });

    const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: bobCookie } });
    const modules = (res.json() as { modules: { id: string }[] }).modules;
    expect(modules.some((m) => m.id === id)).toBe(true);
  });

  it('flags a module with no parts as empty, and clears it once a part is added', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie, 'Blank');
    const one = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } });
      return (res.json() as { modules: { id: string; empty: boolean }[] }).modules.find((m) => m.id === id)!;
    };
    expect((await one()).empty).toBe(true);
    const detail = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie } });
    expect((detail.json() as { module: { empty: boolean } }).module.empty).toBe(true);

    const doc = createDefaultLayoutDoc();
    const sheet = [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l.get('type') === 'brick')!;
    const brick = new Y.Map<unknown>();
    brick.set('id', 'b1');
    brick.set('partNumber', '3001.1.0');
    (sheet.get('bricks') as Y.Array<Y.Map<unknown>>).push([brick]);
    await db.update(schema.modules).set({ docSnapshot: Buffer.from(encodeDoc(doc)) }).where(eq(schema.modules.id, id));
    expect((await one()).empty).toBe(false);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(401);
  });

  it('returns org-owned modules for org members', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');

    // Alice creates an org and an org-owned module.
    const orgRes = await app.inject({
      method: 'POST', url: '/api/orgs', headers: { cookie: aliceCookie },
      payload: { name: 'AliceOrg' },
    });
    const org = orgRes.json() as { id: string; slug: string };

    const modRes = await app.inject({
      method: 'POST', url: '/api/modules', headers: { cookie: aliceCookie },
      payload: { title: 'OrgModule', orgSlug: org.slug },
    });
    expect(modRes.statusCode).toBe(201);
    const moduleId = (modRes.json() as { id: string }).id;

    // Bob joins the org directly via DB.
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.orgMembers).values({ orgId: org.id, userId: bob!.id, role: 'member', joinedAt: new Date() });

    // Bob's module list should include the org module.
    const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: bobCookie } });
    const modules = (res.json() as { modules: { id: string }[] }).modules;
    expect(modules.some((m) => m.id === moduleId)).toBe(true);
  });
});

describe('modules — get one', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns module metadata + role for the owner', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie, 'Test Module');
    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { module: { id: string; title: string }; role: string };
    expect(body.module.id).toBe(id);
    expect(body.module.title).toBe('Test Module');
    expect(body.role).toBe('owner');
  });

  it('returns 404 for non-collaborator (existence-leak protection)', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns correct role for a viewer', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'viewer', addedAt: new Date() });

    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { role: string }).role).toBe('viewer');
  });
});

describe('modules — rename (PATCH)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can rename a module', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie, 'Old Title');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/modules/${id}`,
      headers: { cookie },
      payload: { title: 'New Title' },
    });
    expect(patch.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie } });
    expect((get.json() as { module: { title: string } }).module.title).toBe('New Title');
  });

  it('editor can rename a module', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });

    const res = await app.inject({ method: 'PATCH', url: `/api/modules/${id}`, headers: { cookie: bobCookie }, payload: { title: 'Editor Title' } });
    expect(res.statusCode).toBe(200);
  });

  it('viewer cannot rename', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'viewer', addedAt: new Date() });

    const res = await app.inject({ method: 'PATCH', url: `/api/modules/${id}`, headers: { cookie: bobCookie }, payload: { title: 'Viewer Title' } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for empty title', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({ method: 'PATCH', url: `/api/modules/${id}`, headers: { cookie }, payload: { title: '   ' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_title');
  });

  it('returns 400 when no fields to update', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({ method: 'PATCH', url: `/api/modules/${id}`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('no_updates');
  });

  it('returns 404 for non-existent module', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const res = await app.inject({ method: 'PATCH', url: '/api/modules/does-not-exist', headers: { cookie }, payload: { title: 'X' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('modules — delete', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can delete their module', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);

    const del = await app.inject({ method: 'DELETE', url: `/api/modules/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { ok: boolean }).ok).toBe(true);

    const get = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie } });
    expect(get.statusCode).toBe(404);
  });

  it('editor cannot delete', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });

    const res = await app.inject({ method: 'DELETE', url: `/api/modules/${id}`, headers: { cookie: bobCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for non-existent module', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const res = await app.inject({ method: 'DELETE', url: '/api/modules/no-such', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('modules — collaborators', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can list collaborators (empty by default)', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}/collaborators`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { collaborators: unknown[] }).collaborators).toHaveLength(0);
  });

  it('lists added collaborators with role + email', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = (await db.select().from(schema.users).where(eq(schema.users.email, (await registerAndLogin(app, 'bob@example.com'), 'bob@example.com'))).get())!;
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob.id, role: 'viewer', addedAt: new Date() });

    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}/collaborators`, headers: { cookie: aliceCookie } });
    const collabs = (res.json() as { collaborators: { email: string; role: string }[] }).collaborators;
    expect(collabs).toHaveLength(1);
    expect(collabs[0]!.email).toBe('bob@example.com');
    expect(collabs[0]!.role).toBe('viewer');
  });

  it('returns 404 for non-collaborator trying to list', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createModule(app, aliceCookie);
    const res = await app.inject({ method: 'GET', url: `/api/modules/${id}/collaborators`, headers: { cookie: outsiderCookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('modules — invite collaborator', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('an invited person becomes an editor once they accept the link', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie: aliceCookie },
      payload: { email: 'bob@example.com', role: 'editor' },
    });
    expect(res.statusCode).toBe(200);
    const { token, inviteUrl } = res.json() as { token: string; inviteUrl: string };
    expect(inviteUrl).toContain(`/module-invite/${token}`);
    // Not before accepting.
    expect((await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(404);

    const accept = await app.inject({ method: 'POST', url: `/api/module-invites/${token}`, headers: { cookie: bobCookie } });
    expect(accept.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { role: string }).role).toBe('editor');
  });

  it('returns 400 for invalid email', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie },
      payload: { email: 'not-an-email', role: 'editor' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_email');
  });

  it('returns 400 for invalid role', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie },
      payload: { email: 'bob@example.com', role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_role');
  });

  it('invites an address with no account here the same way', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie },
      payload: { email: 'ghost@example.com', role: 'editor' },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object).sort()).toEqual(['emailDelivered', 'expiresAt', 'id', 'inviteUrl', 'token']);
  });

  it('returns 403 for non-owner trying to invite', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    await registerAndLogin(app, 'carol@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie: bobCookie },
      payload: { email: 'carol@example.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('demo accounts cannot invite', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);
    await db.update(schema.users).set({ isDemoAccount: true }).where(eq(schema.users.email, 'alice@example.com'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie },
      payload: { email: 'bob@example.com', role: 'editor' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('demo_account_cannot_invite');
  });
});

describe('modules — remove collaborator', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can remove a collaborator', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/modules/${id}/collaborators/${bob!.id}`,
      headers: { cookie: aliceCookie },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { ok: boolean }).ok).toBe(true);

    const get = await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } });
    expect(get.statusCode).toBe(404);
  });

  it('a collaborator can remove themselves (self-leave)', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/modules/${id}/collaborators/${bob!.id}`,
      headers: { cookie: bobCookie },
    });
    expect(del.statusCode).toBe(200);
  });

  it('non-owner cannot remove another collaborator', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    await registerAndLogin(app, 'carol@example.com');
    const id = await createModule(app, aliceCookie);
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    const carol = await db.select().from(schema.users).where(eq(schema.users.email, 'carol@example.com')).get();
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: bob!.id, role: 'editor', addedAt: new Date() });
    await db.insert(schema.moduleCollaborators).values({ moduleId: id, userId: carol!.id, role: 'viewer', addedAt: new Date() });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/modules/${id}/collaborators/${carol!.id}`,
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('modules — snapshot PUT', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 400 when body is not binary (JSON content-type)', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'not binary' }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('expected_binary_body');
  });

  it('returns 400 for an empty binary body', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('empty_snapshot');
  });

  it('returns 200 for a valid binary snapshot', async () => {
    const cookie = await registerAndLogin(app, 'alice@example.com');
    const id = await createModule(app, cookie);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(encodeDoc(createDefaultLayoutDoc())),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});
