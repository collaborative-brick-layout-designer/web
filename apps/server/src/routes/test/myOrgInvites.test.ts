// The club invites waiting for someone who already has an account
// (GET /api/me/org-invites): theirs only, open ones only, and gone once
// accepted or when the club is waiting to be deleted.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema, signupCookieOf, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { orgRoutes } from '../orgs.js';
import { orgInviteRoutes } from '../orgInvites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(orgRoutes);
  await app.register(orgInviteRoutes);
  return app;
}

type Who = { cookie: string; id: string };

describe('GET /api/me/org-invites', () => {
  let app: FastifyInstance;
  let admin: Who;
  let bob: Who;
  let carol: Who;
  const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const mine = async (who: Who) => (await call(who, 'GET', '/api/me/org-invites')).json() as { invites: { token: string; orgName: string; roleName: string | null; invitedBy: string | null }[] };

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    admin = await loginAs(app, 'admin@example.com');
    bob = await loginAs(app, 'bob@example.com');
    carol = await loginAs(app, 'carol@example.com');
    await call(admin, 'POST', '/api/orgs', { name: 'ArkLUG', slug: 'arklug' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists an open invite for my address, not for anyone else, and drops it once accepted', async () => {
    const res = await call(admin, 'POST', '/api/orgs/arklug/invites', { email: 'Bob@Example.com', role: 'member' });
    expect(res.statusCode).toBe(200);
    const list = await mine(bob);
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]).toMatchObject({ orgName: 'ArkLUG' });
    expect((await mine(carol)).invites).toEqual([]);
    expect((await call(bob, 'POST', `/api/org-invites/${list.invites[0]!.token}`)).statusCode).toBe(200);
    expect((await mine(bob)).invites).toEqual([]);
  });

  it('leaves out expired invites and clubs waiting to be deleted', async () => {
    await call(admin, 'POST', '/api/orgs/arklug/invites', { email: 'bob@example.com', role: 'member' });
    await db.update(schema.orgInvites).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await mine(bob)).invites).toEqual([]);
    await db.update(schema.orgInvites).set({ expiresAt: new Date(Date.now() + 86_400_000) }).run();
    expect((await mine(bob)).invites).toHaveLength(1);
    await db.update(schema.orgs).set({ deletionDueAt: new Date(Date.now() + 86_400_000) }).where(eq(schema.orgs.slug, 'arklug')).run();
    expect((await mine(bob)).invites).toEqual([]);
  });

  /** Admin > Settings > "Require email verification". */
  async function requireVerification(on: boolean): Promise<void> {
    const row = { requireEmailVerification: on, updatedAt: new Date() };
    await db.insert(schema.platformSettings).values({ id: 'singleton', ...row }).onConflictDoUpdate({ target: schema.platformSettings.id, set: row });
  }

  it('lists nothing until the address is proven, whatever the site asks for', async () => {
    await call(admin, 'POST', '/api/orgs/arklug/invites', { email: 'bob@example.com', role: 'member' });
    expect((await mine(bob)).invites).toHaveLength(1);
    // Stored as verified but never proven (made while email checks were off).
    await db.update(schema.users).set({ emailProvenAt: null }).where(eq(schema.users.id, bob.id));
    for (const on of [true, false]) {
      await requireVerification(on);
      expect((await mine(bob)).invites, `checks ${on ? 'on' : 'off'}`).toEqual([]);
    }
    // Proven: listed, whether the site asks for confirmation or not.
    await db.update(schema.users).set({ emailProvenAt: new Date() }).where(eq(schema.users.id, bob.id));
    for (const on of [true, false]) {
      await requireVerification(on);
      expect((await mine(bob)).invites, `checks ${on ? 'on' : 'off'}`).toHaveLength(1);
    }
  });

  it('an account made while the site does not ask for confirmation sees and accepts an invite only once it confirms its email', async () => {
    await requireVerification(false);
    const res = await call(admin, 'POST', '/api/orgs/arklug/invites', { email: 'newbie@example.com', role: 'admin' });
    expect(res.statusCode).toBe(200);
    const inviteToken = (res.json() as { token: string }).token;
    const reg = await app.inject({ method: 'POST', url: '/api/auth/password/register', payload: { email: 'newbie@example.com', password: 'correct horse battery', displayName: 'Newbie' } });
    expect(reg.json()).toEqual({ ok: true, verificationRequired: false });
    const sc = reg.headers['set-cookie'];
    const newbie = { cookie: Array.isArray(sc) ? sc.join('; ') : (sc ?? ''), id: '' };
    const list = await call(newbie, 'GET', '/api/me/org-invites');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ invites: [] });
    expect(list.body).not.toContain(inviteToken);
    // Holding the link isn't enough: the address isn't proven yet.
    const early = await call(newbie, 'POST', `/api/org-invites/${inviteToken}`);
    expect(early.statusCode).toBe(403);
    expect(early.json()).toEqual({ error: 'email_not_verified' });

    // "Confirm your email", then the link opened in the same browser.
    const ask = await call(newbie, 'POST', '/api/auth/password/confirm-email', {});
    expect(ask.statusCode, ask.body).toBe(200);
    const row = db.select().from(schema.emailVerifications).all()[0]!;
    const opened = await app.inject({
      method: 'POST',
      url: `/api/auth/password/verify-email/${await testVerificationToken(row)}`,
      headers: { cookie: signupCookieOf(ask) },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toEqual({ ok: true, needsPassword: false });
    // The browser that asked stays signed in, and now sees the invite and can accept it.
    expect((await mine(newbie)).invites.map((i) => i.token)).toEqual([inviteToken]);
    expect((await call(newbie, 'POST', `/api/org-invites/${inviteToken}`)).statusCode).toBe(200);
  });

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me/org-invites' })).statusCode).toBe(401);
  });
});
