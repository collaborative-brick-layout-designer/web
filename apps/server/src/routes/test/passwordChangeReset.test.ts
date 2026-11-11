// Changing a password (needs the current one; signs out every other
// browser and desktop app, keeps this one) and "Forgot password?" (a
// one-time link for an hour, hashed in the database, the same answer for
// every address, rate-limited).

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { to: string; url: string; purpose: string }[] = [];
vi.mock('../../email/sendVerification.js', () => ({
  sendVerificationEmail: async (args: { to: string; verifyUrl: string; purpose?: string }) => {
    sent.push({ to: args.to, url: args.verifyUrl, purpose: args.purpose ?? 'verify' });
    return true;
  },
}));

const { db, issueToken, loginAs, resetDb, schema } = await import('../../test/helpers.js');
const { attachUser } = await import('../../auth/cookie.js');
const { passwordRoutes, resetPasswordResetThrottleForTests } = await import('../auth/password.js');
const { sessionRoutes } = await import('../auth/session.js');
const { deviceRoutes } = await import('../auth/device.js');
const { tokenRoutes } = await import('../tokens.js');
const { resetLoginPacing } = await import('../../auth/loginPacing.js');
const { hashToken } = await import('../../auth/session.js');

const PASS = 'correct horse battery';
const NEW = 'a brand new passphrase';

async function buildApp(limits = false): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  if (limits) await app.register(rateLimit, { global: false });
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, sessionRoutes, deviceRoutes, tokenRoutes]) await app.register(r);
  return app;
}

let app: FastifyInstance;
beforeEach(async () => {
  resetDb();
  sent.length = 0;
  resetPasswordResetThrottleForTests();
  resetLoginPacing();
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});

const me = (c: string) => app.inject({ url: '/api/auth/me', headers: { cookie: c } });
const signedIn = async (c: string) => ((await me(c)).json() as { user: unknown }).user !== null;
const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/password/login', payload: { email, password } });
function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  return Array.isArray(sc) ? sc.join('; ') : ((sc as string | undefined) ?? '');
}
const tokenOf = (url: string) => url.split('/reset-password/')[1]!;
const forgot = (email: string) => app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email } });
/** The forgot route emails after it answers; wait for that. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** A desktop sign-in approved in the browser `c`, its token not collected yet. */
async function approvedDesktopSignIn(c: string): Promise<() => Promise<{ statusCode: number; body: { error?: string; access_token?: string } }>> {
  const code = (await app.inject({ method: 'POST', url: '/api/auth/device/code', payload: { client_name: 'Waiting desktop' } })).json() as { device_code: string; user_code: string };
  const ok = await app.inject({ method: 'POST', url: '/api/auth/device/approve', headers: { cookie: c }, payload: { user_code: code.user_code } });
  expect(ok.statusCode).toBe(200);
  return async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/device/token', payload: { device_code: code.device_code } });
    return { statusCode: res.statusCode, body: res.json() };
  };
}

describe('change password', () => {
  it('ends a desktop sign-in that was approved but not collected yet', async () => {
    const here = await loginAs(app, 'ann@example.com');
    const other = cookieOf(await login('ann@example.com', PASS));
    const collect = await approvedDesktopSignIn(other);
    const res = await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: here.cookie }, payload: { currentPassword: PASS, newPassword: NEW } });
    expect(res.statusCode, res.body).toBe(200);
    const polled = await collect();
    expect(polled.statusCode).toBe(400);
    expect(polled.body).toEqual({ error: 'access_denied' });
    expect(db.select().from(schema.apiTokens).all()).toHaveLength(0);
    // One approved after the change works as ever.
    const after = await (await approvedDesktopSignIn(here.cookie))();
    expect(after.statusCode).toBe(200);
    expect(after.body.access_token).toBeTruthy();
  });

  it('needs the current password, then signs out other browsers and desktop apps but keeps this one', async () => {
    const here = await loginAs(app, 'ada@example.com');
    const other = cookieOf(await login('ada@example.com', PASS));
    expect(await signedIn(other)).toBe(true);
    const desktop = await issueToken(app, here.cookie);
    expect((await app.inject({ url: '/api/tokens/current', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(200);

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: here.cookie }, payload: { currentPassword: 'not it at all', newPassword: NEW } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'wrong_current_password' });
    expect(await signedIn(other)).toBe(true);

    const ok = await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: here.cookie }, payload: { currentPassword: PASS, newPassword: NEW } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, signedOutBrowsers: 1, signedOutDesktops: 1 });
    expect(await signedIn(here.cookie)).toBe(true);
    expect(await signedIn(other)).toBe(false);
    expect((await app.inject({ url: '/api/tokens/current', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(401);
    expect((await login('ada@example.com', PASS)).statusCode).toBe(401);
    expect((await login('ada@example.com', NEW)).statusCode).toBe(200);
  });

  it('checks the new password, and refuses accounts with no password, the demo, and signed-out callers', async () => {
    const u = await loginAs(app, 'bo@example.com');
    const short = await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: u.cookie }, payload: { currentPassword: PASS, newPassword: 'short' } });
    expect(short.json()).toMatchObject({ error: 'invalid_password' });
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/change', payload: { currentPassword: PASS, newPassword: NEW } })).statusCode).toBe(401);
    db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, u.id)).run();
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: u.cookie }, payload: { currentPassword: PASS, newPassword: NEW } })).json()).toMatchObject({ error: 'no_password_yet' });
    db.update(schema.users).set({ isDemoAccount: true }).where(eq(schema.users.id, u.id)).run();
    const demo = await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: u.cookie }, payload: { currentPassword: PASS, newPassword: NEW } });
    expect(demo.statusCode).toBe(403);
  });

  it('paces wrong current passwords like sign-in', async () => {
    const u = await loginAs(app, 'cy@example.com');
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await app.inject({ method: 'POST', url: '/api/auth/password/change', headers: { cookie: u.cookie }, payload: { currentPassword: `nope-${i}-wrong`, newPassword: NEW } })).statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('forgot password', () => {
  it('answers the same for every address, and emails only a real account', async () => {
    await loginAs(app, 'dee@example.com');
    sent.length = 0;
    const known = await forgot('dee@example.com');
    const unknown = await forgot('nobody@example.com');
    await settle();
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'dee@example.com', purpose: 'reset-password' });
    // Only a hash is stored.
    const row = db.select().from(schema.passwordResets).get()!;
    expect(row.tokenHash).toBe(hashToken(tokenOf(sent[0]!.url)));
    expect(row.tokenHash).not.toBe(tokenOf(sent[0]!.url));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(60 * 60 * 1000);
  });

  it('a link also ends a desktop sign-in that was approved but not collected yet', async () => {
    const u = await loginAs(app, 'eli@example.com');
    const collect = await approvedDesktopSignIn(u.cookie);
    await forgot('eli@example.com');
    await settle();
    const reset = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: tokenOf(sent.at(-1)!.url), password: NEW } });
    expect(reset.statusCode, reset.body).toBe(200);
    const polled = await collect();
    expect(polled.statusCode).toBe(400);
    expect(polled.body).toEqual({ error: 'access_denied' });
    expect(db.select().from(schema.apiTokens).all()).toHaveLength(0);
  });

  it('a link works once: it sets the password, signs out everywhere else and signs this browser in', async () => {
    const u = await loginAs(app, 'eve@example.com');
    const desktop = await issueToken(app, u.cookie);
    await forgot('eve@example.com');
    await settle();
    const token = tokenOf(sent.at(-1)!.url);
    expect((await app.inject({ url: `/api/auth/password/reset/${token}` })).statusCode).toBe(200);

    const reset = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token, password: NEW } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await signedIn(cookieOf(reset))).toBe(true);
    expect(await signedIn(u.cookie)).toBe(false);
    expect((await app.inject({ url: '/api/tokens/current', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(401);
    expect((await login('eve@example.com', PASS)).statusCode).toBe(401);
    expect((await login('eve@example.com', NEW)).statusCode).toBe(200);

    // Used: it never works again.
    const again = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token, password: 'yet another passphrase' } });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ url: `/api/auth/password/reset/${token}` })).statusCode).toBe(404);
    expect((await login('eve@example.com', NEW)).statusCode).toBe(200);
  });

  it('expires after an hour, and a newer link replaces an older one', async () => {
    await loginAs(app, 'fay@example.com');
    await forgot('fay@example.com');
    await settle();
    const first = tokenOf(sent.at(-1)!.url);
    resetPasswordResetThrottleForTests();
    await forgot('fay@example.com');
    await settle();
    const second = tokenOf(sent.at(-1)!.url);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: first, password: NEW } })).statusCode).toBe(404);

    db.update(schema.passwordResets).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await app.inject({ url: `/api/auth/password/reset/${second}` })).statusCode).toBe(410);
    const late = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: second, password: NEW } });
    expect([404, 410]).toContain(late.statusCode);
    expect((await login('fay@example.com', PASS)).statusCode).toBe(200);
  });

  it('sends one email per account every few minutes, however often it is asked', async () => {
    await loginAs(app, 'gil@example.com');
    sent.length = 0;
    for (let i = 0; i < 3; i++) expect((await forgot('gil@example.com')).statusCode).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('is rate-limited per address', async () => {
    const limited = await buildApp(true);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await limited.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: `x${i}@example.com` } })).statusCode);
      expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('never emails the demo account; an unconfirmed account gets its confirmation link instead', async () => {
    const d = await loginAs(app, 'demo-like@example.com');
    db.update(schema.users).set({ isDemoAccount: true }).where(eq(schema.users.id, d.id)).run();
    sent.length = 0;
    await forgot('demo-like@example.com');
    await settle();
    expect(sent).toHaveLength(0);

    await app.inject({ method: 'POST', url: '/api/auth/password/register', payload: { email: 'new@example.com', password: PASS, displayName: 'New' } });
    sent.length = 0;
    await forgot('new@example.com');
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'new@example.com', purpose: 'verify' });
    expect(db.select().from(schema.passwordResets).all()).toHaveLength(0);
  });

  it('refuses a malformed or unknown token, and a short password', async () => {
    expect((await app.inject({ url: '/api/auth/password/reset/not-a-token' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: 'a'.repeat(64), password: NEW } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: 'a'.repeat(64), password: 'short' } })).json()).toMatchObject({ error: 'invalid_password' });
  });
});
