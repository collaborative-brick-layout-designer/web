// The desktop's Sign Out (DELETE /api/tokens/current) always ends its
// token: for an account on hold, one waiting to be deleted, and a desktop
// older than the server allows. Everything else stays refused for them.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, issueToken, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerDesktopGate, resetDesktopPolicy } from '../../compat.js';
import { passwordRoutes } from '../auth/password.js';
import { deviceRoutes } from '../auth/device.js';
import { tokenRoutes } from '../tokens.js';
import { layoutRoutes } from '../layouts.js';

let app: FastifyInstance;
let who: { cookie: string; id: string };
let token: string;
const OLD = 'BrickLayoutDesigner/1.0.0 (desktop)';
const NEW = 'BrickLayoutDesigner/99.0.0 (desktop)';

const as = (method: 'GET' | 'POST' | 'DELETE', url: string, agent = NEW, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'user-agent': agent }, ...(payload ? { payload } : {}) });
const tokensLeft = () => db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, who.id)).all().filter((t) => !t.revokedAt).length;

beforeEach(async () => {
  resetDb();
  resetDesktopPolicy();
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  registerDesktopGate(app);
  for (const r of [passwordRoutes, deviceRoutes, tokenRoutes, layoutRoutes]) await app.register(r);
  who = await loginAs(app, 'dana@example.com');
  token = await issueToken(app, who.cookie);
});
afterEach(async () => {
  await app.close();
});

describe('the desktop’s Sign Out always ends its token', () => {
  it('for an account on hold: other changes are refused, Sign Out works, and the token is dead after', async () => {
    db.update(schema.users).set({ restrictedAt: new Date() }).where(eq(schema.users.id, who.id)).run();
    const refused = await as('POST', '/api/layouts', NEW, { title: 'No' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'account_restricted' });
    const out = await as('DELETE', '/api/tokens/current');
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(tokensLeft()).toBe(0);
    expect((await as('GET', '/api/tokens/current')).statusCode).toBe(401);
    // It is recorded like any other sign-out.
    const events = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'api_token_revoke')).all();
    expect(events).toHaveLength(1);
  });

  it('for an account waiting to be deleted: reads say why, Sign Out works', async () => {
    db.update(schema.users).set({ deletionRequestedAt: new Date(), deletionDueAt: new Date(Date.now() + 14 * 86_400_000) }).where(eq(schema.users.id, who.id)).run();
    const refused = await as('GET', '/api/tokens/current');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'account_pending_deletion' });
    expect((await as('DELETE', '/api/tokens/current')).statusCode).toBe(200);
    expect(tokensLeft()).toBe(0);
  });

  it('for a desktop older than the server allows: everything else says to update, Sign Out works', async () => {
    const refused = await as('GET', '/api/tokens/current', OLD);
    expect(refused.statusCode).toBe(426);
    expect(refused.json()).toMatchObject({ error: 'update_required' });
    expect((await as('DELETE', '/api/tokens/current?x=1', OLD)).statusCode).toBe(200);
    expect(tokensLeft()).toBe(0);
  });

  it('only that one request is let through: another token’s id, or another method, is not', async () => {
    db.update(schema.users).set({ restrictedAt: new Date() }).where(eq(schema.users.id, who.id)).run();
    expect((await as('DELETE', '/api/tokens/some-other-id')).statusCode).toBe(403);
    expect((await as('DELETE', '/api/tokens/current/extra')).statusCode).not.toBe(200);
    expect((await as('DELETE', '/api/tokens/some-other-id', OLD)).statusCode).not.toBe(200);
    expect(tokensLeft()).toBe(1);
    // With no token at all it's the usual 401, on hold or not.
    expect((await app.inject({ method: 'DELETE', url: '/api/tokens/current' })).statusCode).toBe(401);
  });
});
