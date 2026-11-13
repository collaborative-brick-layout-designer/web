// users.email_proven_at (0049): when an account proved it owns its address.
// Set by opening a verification or confirmation link, by a password reset
// link, and (oauthFlows / linkAndShareToken tests) by a provider vouching
// for the same address. Never by signing up while email checks are off.
// "Confirm your email" sends the link whatever the site's setting; opened
// in the browser that asked nothing else changes, opened anywhere else the
// account goes to whoever opened it. Invites and transfers by email need it.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { to: string; url: string; purpose: string }[] = [];
let smtpWorks = true;
vi.mock('../../email/sendVerification.js', () => ({
  sendVerificationEmail: async (args: { to: string; verifyUrl: string; purpose?: string }) => {
    if (!smtpWorks) return false;
    sent.push({ to: args.to, url: args.verifyUrl, purpose: args.purpose ?? 'verify' });
    return true;
  },
}));

const { db, loginAs, resetDb, schema, signupCookieOf } = await import('../../test/helpers.js');
const { attachUser } = await import('../../auth/cookie.js');
const { passwordRoutes, resetPasswordResetThrottleForTests } = await import('../auth/password.js');
const { sessionRoutes } = await import('../auth/session.js');
const { inviteRoutes } = await import('../invites.js');
const { collaboratorRoutes } = await import('../collaborators.js');
const { layoutRoutes } = await import('../layouts.js');
const { hasProvenEmail } = await import('../../auth/users.js');

const PASS = 'correct horse battery';

let app: FastifyInstance;
beforeEach(async () => {
  resetDb();
  sent.length = 0;
  smtpWorks = true;
  resetPasswordResetThrottleForTests();
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, sessionRoutes, inviteRoutes, collaboratorRoutes, layoutRoutes]) await app.register(r);
});
afterEach(async () => {
  await app.close();
});

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  return Array.isArray(sc) ? sc.join('; ') : ((sc as string | undefined) ?? '');
}
const provenAt = (id: string) => db.select().from(schema.users).where(eq(schema.users.id, id)).get()?.emailProvenAt ?? null;
const me = async (c: string) => (await app.inject({ url: '/api/auth/me', headers: { cookie: c } })).json() as { user: { emailProven?: boolean } | null };
const linkToken = (url: string) => new URL(url).pathname.split('/').pop()!;

async function checks(on: boolean): Promise<void> {
  const row = { requireEmailVerification: on, updatedAt: new Date() };
  await db.insert(schema.platformSettings).values({ id: 'singleton', ...row }).onConflictDoUpdate({ target: schema.platformSettings.id, set: row });
}

/** Sign up while the site doesn't ask for confirmation: signed in at once, stored verified, not proven. */
async function signUpWithChecksOff(email: string): Promise<{ cookie: string; id: string }> {
  await checks(false);
  const reg = await app.inject({ method: 'POST', url: '/api/auth/password/register', payload: { email, password: PASS, displayName: 'Pat' } });
  expect(reg.json()).toEqual({ ok: true, verificationRequired: false });
  const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get()!;
  return { cookie: cookieOf(reg), id: user.id };
}

describe('the proven-email marker', () => {
  it('is set by the sign-up verification link, and /api/auth/me says so', async () => {
    const u = await loginAs(app, 'vera@example.com');
    expect(provenAt(u.id)).toBeInstanceOf(Date);
    expect((await me(u.cookie)).user?.emailProven).toBe(true);
  });

  it('is not set by signing up while email checks are off, though the account is stored verified', async () => {
    const u = await signUpWithChecksOff('pat@example.com');
    const row = db.select().from(schema.users).where(eq(schema.users.id, u.id)).get()!;
    expect(row.emailVerified).toBe(true);
    expect(row.emailProvenAt).toBeNull();
    expect(hasProvenEmail(row)).toBe(false);
    expect((await me(u.cookie)).user?.emailProven).toBe(false);
  });

  it('is set by a password reset link, and kept at its first time afterwards', async () => {
    const u = await signUpWithChecksOff('rae@example.com');
    await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: 'rae@example.com' } });
    await new Promise((r) => setTimeout(r, 50));
    const reset = sent.find((m) => m.purpose === 'reset-password')!;
    const res = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: reset.url.split('/reset-password/')[1], password: 'a brand new passphrase' } });
    expect(res.statusCode, res.body).toBe(200);
    const first = provenAt(u.id);
    expect(first).toBeInstanceOf(Date);
    // A later link doesn't move it.
    await db.update(schema.users).set({ emailProvenAt: new Date(1_000) }).where(eq(schema.users.id, u.id));
    await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: 'rae@example.com' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(provenAt(u.id)?.getTime()).toBe(1_000);
  });
});

describe('POST /api/auth/password/confirm-email', () => {
  it('sends a confirmation link even while the site does not ask for one; opened in the same browser, only the marker changes', async () => {
    const u = await signUpWithChecksOff('sam@example.com');
    const ask = await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', headers: { cookie: u.cookie }, payload: { next: '/org-invite/abc' } });
    expect(ask.statusCode, ask.body).toBe(200);
    expect(ask.json()).toEqual({ ok: true, alreadyConfirmed: false, sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'sam@example.com', purpose: 'confirm' });
    expect(new URL(sent[0]!.url).searchParams.get('next')).toBe('/org-invite/abc');
    expect(provenAt(u.id)).toBeNull();

    const opened = await app.inject({
      method: 'POST',
      url: `/api/auth/password/verify-email/${linkToken(sent[0]!.url)}`,
      headers: { cookie: signupCookieOf(ask) },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toEqual({ ok: true, needsPassword: false });
    expect(provenAt(u.id)).toBeInstanceOf(Date);
    // Still signed in where it asked, with the same password.
    expect((await me(u.cookie)).user?.emailProven).toBe(true);
    const login = await app.inject({ method: 'POST', url: '/api/auth/password/login', payload: { email: 'sam@example.com', password: PASS } });
    expect(login.statusCode).toBe(200);
  });

  it('opened in another browser, the account goes to whoever opened it: everyone else is signed out and they choose a password', async () => {
    const u = await signUpWithChecksOff('tia@example.com');
    await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', headers: { cookie: u.cookie }, payload: {} });
    const opened = await app.inject({ method: 'POST', url: `/api/auth/password/verify-email/${linkToken(sent[0]!.url)}` });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toEqual({ ok: true, needsPassword: true });
    expect(provenAt(u.id)).toBeInstanceOf(Date);
    expect((await me(u.cookie)).user).toBeNull();
    expect((await me(cookieOf(opened))).user?.emailProven).toBe(true);
    const oldPassword = await app.inject({ method: 'POST', url: '/api/auth/password/login', payload: { email: 'tia@example.com', password: PASS } });
    expect(oldPassword.statusCode).toBe(401);
  });

  it('says when the site could not send the email, when it is already confirmed, and asks to wait between emails', async () => {
    const u = await signUpWithChecksOff('uma@example.com');
    smtpWorks = false;
    const noMail = await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', headers: { cookie: u.cookie }, payload: {} });
    expect(noMail.json()).toEqual({ ok: true, alreadyConfirmed: false, sent: false });
    smtpWorks = true;
    const again = await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', headers: { cookie: u.cookie }, payload: {} });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'confirm_email_sent_recently' });

    await checks(true);
    const v = await loginAs(app, 'val@example.com');
    const done = await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', headers: { cookie: v.cookie }, payload: {} });
    expect(done.json()).toEqual({ ok: true, alreadyConfirmed: true, sent: false });
    expect(sent.filter((m) => m.purpose === 'confirm')).toHaveLength(0);
  });

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/confirm-email', payload: {} })).statusCode).toBe(401);
  });
});

describe('accepting by email needs a proven address', () => {
  it('a layout invite waits until the invited account confirms its email, whatever the site asks for', async () => {
    const owner = await loginAs(app, 'own@example.com');
    const id = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: {} })).json().id as string;
    const invite = await app.inject({ method: 'POST', url: `/api/layouts/${id}/invites`, headers: { cookie: owner.cookie }, payload: { email: 'wes@example.com', role: 'viewer' } });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = (invite.json() as { token: string }).token;
    const wes = await signUpWithChecksOff('wes@example.com');
    const early = await app.inject({ method: 'POST', url: `/api/invites/${token}`, headers: { cookie: wes.cookie } });
    expect(early.statusCode).toBe(403);
    expect(early.json()).toEqual({ error: 'email_not_verified' });
    await db.update(schema.users).set({ emailProvenAt: new Date() }).where(eq(schema.users.id, wes.id));
    expect((await app.inject({ method: 'POST', url: `/api/invites/${token}`, headers: { cookie: wes.cookie } })).statusCode).toBe(200);
  });
});
