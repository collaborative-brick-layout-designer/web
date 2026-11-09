// Profile › Browsers and devices: a person sees their own web sign-ins
// (when made, when last used, a rough browser name; never the stored id
// or the user agent), signs out any one of them, or every one but this.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, issueToken, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { deviceRoutes } from '../auth/device.js';
import { tokenRoutes } from '../tokens.js';
import { deviceName } from '../../auth/session.js';
import { onCredentialRevoked, type CredentialRevocation } from '../../auth/revocation.js';

const PASS = 'correct horse battery';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let app: FastifyInstance;
beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, sessionRoutes, deviceRoutes, tokenRoutes]) await app.register(r);
});
afterEach(async () => {
  await app.close();
});

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  return Array.isArray(sc) ? sc.join('; ') : ((sc as string | undefined) ?? '');
}
async function signInFrom(email: string, ua: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/password/login', headers: { 'user-agent': ua }, payload: { email, password: PASS } });
  expect(res.statusCode).toBe(200);
  const c = cookieOf(res);
  await app.inject({ url: '/api/auth/me', headers: { cookie: c, 'user-agent': ua } });
  return c;
}
type Row = { id: string; current: boolean; device: string | null; createdAt: number; lastUsedAt: number | null };
const list = async (c: string, ua = FIREFOX) => (await app.inject({ url: '/api/auth/sessions', headers: { cookie: c, 'user-agent': ua } })).json() as { sessions: Row[] };
const signedIn = async (c: string) => ((await app.inject({ url: '/api/auth/me', headers: { cookie: c } })).json() as { user: unknown }).user !== null;

describe('browsers and devices', () => {
  it('lists my own sign-ins with a rough name and times, this one first, and never the stored ids', async () => {
    const ada = await loginAs(app, 'ada@example.com');
    await loginAs(app, 'bob@example.com');
    const laptop = await signInFrom('ada@example.com', FIREFOX);
    await signInFrom('ada@example.com', IPHONE);
    const { sessions } = await list(laptop);
    expect(sessions).toHaveLength(3); // loginAs's own, the laptop, the phone; none of Bob's
    expect(sessions[0]).toMatchObject({ current: true, device: 'Firefox on Linux' });
    expect(sessions.map((s) => s.device)).toContain('Safari on iPhone');
    expect(sessions.every((s) => s.createdAt > 0)).toBe(true);
    expect(sessions[0]!.lastUsedAt).toBeGreaterThan(0);
    const stored = db.select().from(schema.sessions).where(eq(schema.sessions.userId, ada.id)).all();
    for (const s of sessions) expect(stored.map((r) => r.id)).not.toContain(s.id);
    // Only the rough name is kept.
    expect(JSON.stringify(stored)).not.toContain('Gecko');
  });

  it('signs out one browser (its open layouts are told at once), and only my own', async () => {
    await loginAs(app, 'cy@example.com');
    const bob = await loginAs(app, 'dan@example.com');
    const laptop = await signInFrom('cy@example.com', FIREFOX);
    const phone = await signInFrom('cy@example.com', IPHONE);
    const phoneRow = (await list(laptop)).sessions.find((s) => s.device === 'Safari on iPhone')!;
    expect((await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${phoneRow.id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    const revoked: CredentialRevocation[] = [];
    const off = onCredentialRevoked((r) => revoked.push(r));
    try {
      expect((await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${phoneRow.id}`, headers: { cookie: laptop } })).statusCode).toBe(200);
    } finally {
      off();
    }
    expect(revoked).toHaveLength(1);
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(laptop)).toBe(true);
    expect((await list(laptop)).sessions.some((s) => s.id === phoneRow.id)).toBe(false);
  });

  it('"sign out of my other browsers" keeps this one and the desktop apps', async () => {
    const eve = await loginAs(app, 'eve@example.com');
    const laptop = await signInFrom('eve@example.com', FIREFOX);
    const phone = await signInFrom('eve@example.com', IPHONE);
    const desktop = await issueToken(app, laptop);
    const res = await app.inject({ method: 'POST', url: '/api/auth/sessions/sign-out-others', headers: { cookie: laptop } });
    expect(res.json()).toMatchObject({ ok: true, signedOut: 2 });
    expect(await signedIn(laptop)).toBe(true);
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(eve.cookie)).toBe(false);
    expect((await app.inject({ url: '/api/tokens/current', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(200);
  });

  it('is for signed-in browsers only, never the demo or a desktop token', async () => {
    expect((await app.inject({ url: '/api/auth/sessions' })).statusCode).toBe(401);
    const f = await loginAs(app, 'fay@example.com');
    const desktop = await issueToken(app, f.cookie);
    expect((await app.inject({ url: '/api/auth/sessions', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(403);
    db.update(schema.users).set({ isDemoAccount: true }).where(eq(schema.users.id, f.id)).run();
    expect((await app.inject({ url: '/api/auth/sessions', headers: { cookie: f.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/sessions/sign-out-others', headers: { cookie: f.cookie } })).statusCode).toBe(403);
  });

  it('names browsers roughly', () => {
    expect(deviceName(FIREFOX)).toBe('Firefox on Linux');
    expect(deviceName(IPHONE)).toBe('Safari on iPhone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on Windows');
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(deviceName('curl/8.0')).toBe('A browser');
    expect(deviceName(undefined)).toBeNull();
  });
});
