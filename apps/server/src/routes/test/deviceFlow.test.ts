// Desktop sign-in: the RFC 8628 device-code flow, the API tokens it
// mints, the Bearer allow-list, token management and GET /api/version.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, issueToken, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { TOKEN_PREFIX } from '../../auth/apiTokens.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { oauthRoutes } from '../auth/oauth.js';
import { deviceRoutes } from '../auth/device.js';
import { tokenRoutes } from '../tokens.js';
import { layoutRoutes } from '../layouts.js';
import { adminRoutes } from '../admin.js';
import { auditRoutes } from '../audit.js';
import { versionRoutes } from '../version.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(versionRoutes);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(oauthRoutes);
  await app.register(deviceRoutes);
  await app.register(tokenRoutes);
  await app.register(layoutRoutes);
  await app.register(adminRoutes);
  await app.register(auditRoutes);
  return app;
}

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function requestCode(app: FastifyInstance, payload: Record<string, unknown> = {}): Promise<CodeResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/device/code',
    payload: { client_name: 'Brick Layout Designer (test)', ...payload },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function poll(app: FastifyInstance, deviceCode: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/device/token',
    payload: { device_code: deviceCode, grant_type: GRANT_TYPE },
  });
}

function decide(app: FastifyInstance, cookieStr: string, userCode: string, action: 'approve' | 'deny' | 'lookup') {
  return app.inject({
    method: 'POST',
    url: `/api/auth/device/${action}`,
    headers: { cookie: cookieStr },
    payload: { user_code: userCode },
  });
}

/** Pretend the last poll happened long enough ago that the next isn't too fast. */
async function rewindLastPoll(): Promise<void> {
  await db.update(schema.deviceCodes).set({ lastPolledAt: new Date(Date.now() - 60_000) });
}

describe('device authorization flow', () => {
  let app: FastifyInstance;
  let user: { cookie: string; id: string };

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    user = await loginAs(app, 'desk@x.com');
  });
  afterEach(async () => {
    await app.close();
  });

  it('issues a code in the RFC 8628 shape, storing only hashes', async () => {
    const code = await requestCode(app);
    expect(code.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(code.verification_uri).toBe('http://localhost:3000/device');
    expect(code.verification_uri_complete).toBe(`http://localhost:3000/device?user_code=${code.user_code}`);
    expect(code.expires_in).toBe(600);
    expect(code.interval).toBe(5);
    const row = await db.select().from(schema.deviceCodes).get();
    expect(row!.deviceCodeHash).not.toContain(code.device_code);
    expect(JSON.stringify(row)).not.toContain(code.user_code.replace('-', ''));
  });

  it('rejects unknown scopes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/device/code', payload: { scope: 'admin' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
  });

  it('grants the P1b scopes: publishing layouts and parts', async () => {
    const code = await requestCode(app, { scope: 'layouts:create parts:write' });
    const lookup = await decide(app, user.cookie, code.user_code, 'lookup');
    expect(lookup.json().scopes).toEqual(['layouts:create', 'parts:write']);
    expect((await decide(app, user.cookie, code.user_code, 'approve')).statusCode).toBe(200);
    await rewindLastPoll();
    expect((await poll(app, code.device_code)).json().scope).toBe('layouts:create parts:write');
  });

  it('happy path: pending → approve → token, usable as Bearer', async () => {
    const code = await requestCode(app, { scope: 'layouts:read layouts:write' });
    const pending = await poll(app, code.device_code);
    expect(pending.statusCode).toBe(400);
    expect(pending.json().error).toBe('authorization_pending');

    const lookup = await decide(app, user.cookie, code.user_code.toLowerCase(), 'lookup');
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      clientName: 'Brick Layout Designer (test)',
      scopes: ['layouts:read', 'layouts:write'],
    });
    expect((await decide(app, user.cookie, code.user_code, 'approve')).statusCode).toBe(200);

    await rewindLastPoll();
    const res = await poll(app, code.device_code);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'layouts:read layouts:write', expires_in: 90 * 86400 });
    expect(body.access_token.startsWith(TOKEN_PREFIX)).toBe(true);

    const row = await db.select().from(schema.apiTokens).get();
    expect(row!.userId).toBe(user.id);
    expect(row!.name).toBe('Brick Layout Designer (test)');
    expect(row!.tokenHash).not.toContain(body.access_token);
    expect(body.access_token.endsWith(row!.last4)).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/api/layouts',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(list.statusCode).toBe(200);
    // The desktop asks who its token belongs to (to name its cursor); the
    // account routes stay closed to tokens.
    const current = await app.inject({ method: 'GET', url: '/api/tokens/current', headers: { authorization: `Bearer ${body.access_token}` } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ user: { id: user.id }, token: { scopes: ['layouts:read', 'layouts:write'] } });
    expect(Object.keys(current.json().user)).toEqual(['id', 'displayName']);
    // When the sign-in would end by itself: 90 days unused, 180 days at the longest (the defaults).
    expect(current.json().token.idleSeconds).toBe(90 * 24 * 3600);
    expect(current.json().token.longestAt).toBe(row!.createdAt.getTime() + 180 * 24 * 3600 * 1000);
    const byCookie = await app.inject({ method: 'GET', url: '/api/tokens/current', headers: { cookie: user.cookie } });
    expect(byCookie.statusCode).toBe(400);

    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'api_token_issue')).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).not.toContain(body.access_token);
  });

  it('answers slow_down to polls faster than the interval, growing it by 5s', async () => {
    const code = await requestCode(app);
    expect((await poll(app, code.device_code)).json().error).toBe('authorization_pending');
    const fast = await poll(app, code.device_code);
    expect(fast.statusCode).toBe(400);
    expect(fast.json()).toEqual({ error: 'slow_down', interval: 10 });
    await rewindLastPoll();
    expect((await poll(app, code.device_code)).json().error).toBe('authorization_pending');
  });

  it('expires after expires_in: expired_token, and the code can no longer be approved', async () => {
    const code = await requestCode(app);
    await db.update(schema.deviceCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await poll(app, code.device_code)).json().error).toBe('expired_token');
    expect((await decide(app, user.cookie, code.user_code, 'lookup')).statusCode).toBe(404);
    expect((await decide(app, user.cookie, code.user_code, 'approve')).statusCode).toBe(404);
  });

  it('deny → access_denied, and no token is minted', async () => {
    const code = await requestCode(app);
    expect((await decide(app, user.cookie, code.user_code, 'deny')).statusCode).toBe(200);
    const res = await poll(app, code.device_code);
    expect(res.json().error).toBe('access_denied');
    expect((await decide(app, user.cookie, code.user_code, 'approve')).statusCode).toBe(404);
    expect(await db.select().from(schema.apiTokens).all()).toHaveLength(0);
  });

  it('is single use: a second exchange fails and mints nothing', async () => {
    const code = await requestCode(app);
    await decide(app, user.cookie, code.user_code, 'approve');
    expect((await poll(app, code.device_code)).statusCode).toBe(200);
    const again = await poll(app, code.device_code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
    expect(await db.select().from(schema.apiTokens).all()).toHaveLength(1);
    // …and the user code is spent too.
    expect((await decide(app, user.cookie, code.user_code, 'approve')).statusCode).toBe(404);
  });

  it('rejects malformed polls', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/device/token', payload: {} })).json().error).toBe(
      'invalid_request',
    );
    expect((await poll(app, 'nope')).json().error).toBe('invalid_grant');
    const wrongGrant = await app.inject({
      method: 'POST',
      url: '/api/auth/device/token',
      payload: { device_code: 'x', grant_type: 'password' },
    });
    expect(wrongGrant.json().error).toBe('unsupported_grant_type');
  });

  it('approval needs a signed-in web session', async () => {
    const code = await requestCode(app);
    expect((await decide(app, '', code.user_code, 'approve')).statusCode).toBe(401);
    const token = await issueToken(app, user.cookie);
    const viaToken = await app.inject({
      method: 'POST',
      url: '/api/auth/device/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: { user_code: code.user_code },
    });
    expect(viaToken.statusCode).toBe(403);
  });
});

describe('Bearer allow-list', () => {
  let app: FastifyInstance;
  let user: { cookie: string; id: string };
  let token: string;
  let layoutId: string;
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    user = await loginAs(app, 'allow@x.com');
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, user.id));
    token = await issueToken(app, user.cookie);
    layoutId = (
      await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: user.cookie }, payload: {} })
    ).json().id;
  });
  afterEach(async () => {
    await app.close();
  });

  it('accepts the token on layouts list/detail/exports and /api/version', async () => {
    for (const url of [
      '/api/layouts',
      `/api/layouts/${layoutId}`,
      `/api/layouts/${layoutId}/export.bbm`,
      `/api/layouts/${layoutId}/export.zip`,
      '/api/version',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: bearer() });
      expect(res.statusCode, url).toBe(200);
    }
    // No sidecar → 404 from the route itself, i.e. auth passed.
    const bld = await app.inject({ method: 'GET', url: `/api/layouts/${layoutId}/export.bbm.bld`, headers: bearer() });
    expect(bld.json().error).toBe('no_sidecar');
  });

  it('rejects the token everywhere else — even for a global admin, even with a session cookie', async () => {
    const cases: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/stats'],
      ['POST', `/api/admin/users/${user.id}/sessions/revoke-all`],
      ['GET', '/api/auth/me'],
      ['PATCH', '/api/auth/me', { displayName: 'pwned' }],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/link'],
      ['DELETE', '/api/auth/link'],
      ['GET', '/api/tokens'],
      ['DELETE', '/api/tokens/whatever'],
      ['POST', '/api/auth/device/lookup', { user_code: 'BCDF-GHJK' }],
      // POST /api/layouts is allowed with layouts:create (layoutsPublish.test.ts).
      ['PATCH', `/api/layouts/${layoutId}`, { title: 'x' }],
      // DELETE /api/layouts/:id is allowed with layouts:write, for the owner (layoutsPublish.test.ts).
      ['GET', `/api/layouts/${layoutId}/snapshot`],
      ['PUT', `/api/layouts/${layoutId}/snapshot`],
      ['POST', `/api/layouts/${layoutId}/public-share`],
      ['GET', '/api/audit'],
      ['GET', '/api/no-such-route'],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { ...bearer(), cookie: user.cookie },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error, `${method} ${url}`).toBe('token_not_allowed');
    }
    // Nothing changed behind the rejected requests.
    const me = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
    expect(me!.displayName).toBe('allow');
    expect(await db.select().from(schema.sessions).all()).toHaveLength(1);
  });

  it('rejects unknown, revoked and expired tokens with 401', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/layouts', headers: { authorization: 'Bearer bld_pat_nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('invalid_token');

    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer() })).statusCode).toBe(401);

    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() });
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer() })).statusCode).toBe(401);
  });

  it('never reads a token from the query string', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/layouts?access_token=${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('slides expiry and records last use', async () => {
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() + 1000), lastUsedAt: null });
    await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer() });
    const row = await db.select().from(schema.apiTokens).get();
    expect(row!.lastUsedAt).not.toBeNull();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);
  });

  it("admin 'revoke all sessions' revokes the user's tokens too", async () => {
    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.id}/sessions/revoke-all`,
      headers: { cookie: user.cookie },
    });
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer() })).statusCode).toBe(401);
  });
});

describe('token management API', () => {
  let app: FastifyInstance;
  let user: { cookie: string; id: string };

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    user = await loginAs(app, 'mgmt@x.com');
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists own tokens without secrets, and revokes them', async () => {
    const token = await issueToken(app, user.cookie, 'layouts:read');
    const other = await loginAs(app, 'other@x.com');
    const otherToken = await issueToken(app, other.cookie);

    const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: user.cookie } });
    expect(list.statusCode).toBe(200);
    const { tokens } = list.json();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: 'Brick Layout Designer (test)', scopes: ['layouts:read'], last4: token.slice(-4) });
    expect(tokens[0].prefix.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(JSON.stringify(tokens)).not.toContain(token);
    expect(Object.keys(tokens[0]).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'last4', 'lastUsedAt', 'name', 'prefix', 'scopes'].sort(),
    );

    // Someone else's token id is a 404, and stays usable.
    const otherId = (await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, other.id)).get())!.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${otherId}`, headers: { cookie: user.cookie } })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/layouts', headers: { authorization: `Bearer ${otherToken}` } })).statusCode,
    ).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/tokens/${tokens[0].id}`, headers: { cookie: user.cookie } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: user.cookie } })).json().tokens).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${tokens[0].id}`, headers: { cookie: user.cookie } })).statusCode).toBe(404);

    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'api_token_revoke')).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resourceKind: 'user', resourceId: user.id, userId: user.id });
  });

  it('a token ends itself (the desktop’s Sign Out), whatever its scopes, and only itself', async () => {
    const token = await issueToken(app, user.cookie, 'account:prefs');
    const second = await issueToken(app, user.cookie);
    const other = await loginAs(app, 'other@x.com');
    const otherToken = await issueToken(app, other.cookie);
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    const ownId = (await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.last4, token.slice(-4))).get())!.id;

    // A web session isn't a token: nothing to end here (the website has its own list).
    expect((await app.inject({ method: 'DELETE', url: '/api/tokens/current', headers: { cookie: user.cookie } })).statusCode).toBe(400);
    // Signed out, or with a made-up token: refused.
    expect((await app.inject({ method: 'DELETE', url: '/api/tokens/current' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/tokens/current', headers: bearer(`${TOKEN_PREFIX}nope`) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: user.cookie } })).json().tokens).toHaveLength(2);

    const res = await app.inject({ method: 'DELETE', url: '/api/tokens/current', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // That sign-in is over at once; asking again is the usual 401.
    expect((await app.inject({ method: 'GET', url: '/api/tokens/current', headers: bearer(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/tokens/current', headers: bearer(token) })).statusCode).toBe(401);
    // The person's other desktop, and other people's, stay signed in.
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer(second) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/layouts', headers: bearer(otherToken) })).statusCode).toBe(200);
    // The website's list drops it.
    const left = (await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: user.cookie } })).json().tokens as { id: string }[];
    expect(left.map((t) => t.id)).not.toContain(ownId);
    expect(left).toHaveLength(1);

    // Audited like a revoke from the website: who and which token, nothing about the caller's address or app.
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'api_token_revoke')).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resourceKind: 'user', resourceId: user.id, userId: user.id });
    expect(JSON.parse(audit[0]!.payload as string)).toEqual({ tokenId: ownId, name: 'Brick Layout Designer (test)', self: true });
    expect(audit[0]!.payload).not.toContain(token);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tokens' })).statusCode).toBe(401);
  });
});
