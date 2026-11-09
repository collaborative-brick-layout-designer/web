// Integration tests for layout ownership transfers:
//   POST   /api/layouts/:id/transfer         — initiate (user→user or user→org)
//   GET    /api/transfers/:token             — preview
//   POST   /api/transfers/:token             — accept
//   DELETE /api/layouts/:id/transfer/:tid   — revoke

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, schema, testVerificationToken } from '../../test/helpers.js';
import { eq } from 'drizzle-orm';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';
import { collaboratorRoutes } from '../collaborators.js';
import { inviteRoutes } from '../invites.js';
import { transferRoutes } from '../transfers.js';
import { orgRoutes } from '../orgs.js';
import { orgInviteRoutes } from '../orgInvites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  await app.register(collaboratorRoutes);
  await app.register(inviteRoutes);
  await app.register(transferRoutes);
  await app.register(orgRoutes);
  await app.register(orgInviteRoutes);
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

async function createLayout(app: FastifyInstance, cookieStr: string, title = 'Transfer Layout'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/layouts',
    headers: { cookie: cookieStr },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createOrg(app: FastifyInstance, cookieStr: string, name: string): Promise<{ id: string; slug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: { cookie: cookieStr },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string };
}

describe('transfers — initiate user→user', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can initiate a user→user transfer and get a token back', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; transferUrl: string; expiresAt: number };
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
    expect(body.transferUrl).toContain(body.token);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects transfer to self', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'owner@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('cannot_transfer_to_self');
  });

  it('rejects when neither email nor org slug is provided', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('specify_recipient_email_xor_org');
  });

  it('rejects when both email and org slug are provided', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'x@example.com', recipientOrgSlug: 'some-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid email format', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_email');
  });

  it('returns 403 for non-owner', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const editorCookie = await registerAndLogin(app, 'editor@example.com');
    const id = await createLayout(app, ownerCookie);

    // Make editor a collaborator first.
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { email: 'editor@example.com', role: 'editor' },
    });
    const { token } = inviteRes.json() as { token: string };
    await app.inject({ method: 'POST', url: `/api/invites/${token}`, headers: { cookie: editorCookie } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: editorCookie },
      payload: { recipientEmail: 'anyone@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for non-existent layout', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/does-not-exist/transfer',
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'x@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('transfers — preview', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('GET /api/transfers/:token returns transfer metadata', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie, 'Precious Layout');

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { token } = initRes.json() as { token: string };

    const res = await app.inject({ method: 'GET', url: `/api/transfers/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recipientEmail: string; forYou: boolean | null; layoutTitle: string; layoutId: string };
    // Signed out, whoever holds the link sees only a masked address.
    expect(body.recipientEmail).toBe('r…@example.com');
    expect(body.forYou).toBeNull();
    expect(body.layoutTitle).toBe('Precious Layout');
    expect(body.layoutId).toBe(id);
  });

  it('shows the full address only to the recipient, signed in', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie, 'Precious Layout');
    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'Recipient@Example.com' },
    });
    const { token } = initRes.json() as { token: string };
    const as = async (cookie: string) => (await app.inject({ method: 'GET', url: `/api/transfers/${token}`, headers: { cookie } })).json() as { recipientEmail: string; forYou: boolean | null };

    const recipient = await registerAndLogin(app, 'recipient@example.com');
    const mine = await as(recipient);
    expect(mine.forYou).toBe(true);
    expect(mine.recipientEmail.toLowerCase()).toBe('recipient@example.com');

    const other = await registerAndLogin(app, 'eve@example.com');
    const theirs = await as(other);
    expect(theirs.forYou).toBe(false);
    expect(theirs.recipientEmail).toBe('r…@example.com');
    // The owner who sent it sees it masked here too (their own list of transfers shows it).
    expect((await as(ownerCookie)).recipientEmail).toBe('r…@example.com');
  });

  it('returns 404 for unknown token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transfers/no-such-token' });
    expect(res.statusCode).toBe(404);
  });
});

describe('transfers — accept', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('recipient can accept and gains ownership', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const recipientCookie = await registerAndLogin(app, 'recipient@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { token } = initRes.json() as { token: string };

    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/transfers/${token}`,
      headers: { cookie: recipientCookie },
    });
    expect(acceptRes.statusCode).toBe(200);
    expect((acceptRes.json() as { layoutId: string }).layoutId).toBe(id);

    // Recipient can now GET the layout (as owner).
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: recipientCookie },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it('original owner is added back as editor after transfer', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const recipientCookie = await registerAndLogin(app, 'recipient@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { token } = initRes.json() as { token: string };
    await app.inject({ method: 'POST', url: `/api/transfers/${token}`, headers: { cookie: recipientCookie } });

    // Original owner should still be able to access the layout.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it('returns 403 for email mismatch', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const wrongCookie = await registerAndLogin(app, 'wrong@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { token } = initRes.json() as { token: string };

    const res = await app.inject({
      method: 'POST',
      url: `/api/transfers/${token}`,
      headers: { cookie: wrongCookie },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('email_mismatch');
  });

  it('returns 410 on double-accept', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const recipientCookie = await registerAndLogin(app, 'recipient@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { token } = initRes.json() as { token: string };
    await app.inject({ method: 'POST', url: `/api/transfers/${token}`, headers: { cookie: recipientCookie } });
    const second = await app.inject({ method: 'POST', url: `/api/transfers/${token}`, headers: { cookie: recipientCookie } });
    expect(second.statusCode).toBe(410);
    expect((second.json() as { error: string }).error).toBe('transfer_already_accepted');
  });
});

describe('transfers — revoke', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can revoke a pending transfer', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { id: transferId, token } = initRes.json() as { id: string; token: string };

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}/transfer/${transferId}`,
      headers: { cookie: ownerCookie },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect((revokeRes.json() as { ok: boolean }).ok).toBe(true);

    // Token preview should still resolve (DELETE doesn't mark as accepted).
    // The token is orphaned — recipient can no longer accept.
    const previewRes = await app.inject({ method: 'GET', url: `/api/transfers/${token}` });
    expect([200, 404]).toContain(previewRes.statusCode);
  });

  it('non-owner gets 403 when trying to revoke a transfer', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const editorCookie = await registerAndLogin(app, 'editor@example.com');
    const id = await createLayout(app, ownerCookie);

    const initRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientEmail: 'recipient@example.com' },
    });
    const { id: transferId } = initRes.json() as { id: string };

    // Give editor direct collaborator access via DB so resolveResourceRole returns non-null.
    const editorUser = await db.select().from(schema.users).where(eq(schema.users.email, 'editor@example.com')).get();
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: editorUser!.id, role: 'editor', addedAt: new Date() });

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}/transfer/${transferId}`,
      headers: { cookie: editorCookie },
    });
    expect(revokeRes.statusCode).toBe(403);
    expect((revokeRes.json() as { error: string }).error).toBe('forbidden');
  });
});

describe('transfers — user→org (immediate)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('owner can transfer layout to an org they belong to', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);
    const org = await createOrg(app, ownerCookie, 'My Org');

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientOrgSlug: org.slug },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transferred: boolean; ownerKind: string; ownerSlug: string };
    expect(body.transferred).toBe(true);
    expect(body.ownerKind).toBe('org');
    expect(body.ownerSlug).toBe(org.slug);
  });

  it('returns 404 for unknown org slug', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientOrgSlug: 'no-such-org' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('recipient_org_not_found');
  });

  it('returns 403 if caller is not a member of the destination org', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const otherCookie = await registerAndLogin(app, 'other@example.com');
    const id = await createLayout(app, ownerCookie);
    const org = await createOrg(app, otherCookie, 'Other Org');

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/transfer`,
      headers: { cookie: ownerCookie },
      payload: { recipientOrgSlug: org.slug },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('not_a_member_of_recipient_org');
  });
});
