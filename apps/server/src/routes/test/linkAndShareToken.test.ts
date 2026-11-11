// Regression tests:
//   - POST /api/auth/link exists and only commits a pending OAuth link
//     from a session signed in to the account being linked
//   - the public-share token is only returned to layout owners

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { createPendingLink, PENDING_LINK_COOKIE } from '../../auth/pendingLinks.js';
import { passwordRoutes } from '../auth/password.js';
import { oauthRoutes } from '../auth/oauth.js';
import { layoutRoutes } from '../layouts.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(oauthRoutes);
  await app.register(layoutRoutes);
  return app;
}

describe('POST /api/auth/link', () => {
  beforeEach(() => resetDb());

  it('links the provider when signed in to the target account', async () => {
    const app = await buildApp();
    const alice = await loginAs(app, 'alice@x.com');
    const token = createPendingLink({ provider: 'github', providerUserId: 'gh-1', userId: alice.id });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      headers: { cookie: `${alice.cookie}; ${PENDING_LINK_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, alice.id));
    expect(rows).toEqual([{ provider: 'github', providerUserId: 'gh-1', issuer: null, userId: alice.id }]);
    await app.close();
  });

  it('refuses when signed in as someone else, or not signed in', async () => {
    const app = await buildApp();
    const alice = await loginAs(app, 'alice@x.com');
    const mallory = await loginAs(app, 'mallory@x.com');
    const token = createPendingLink({ provider: 'github', providerUserId: 'gh-2', userId: alice.id });
    const asMallory = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      headers: { cookie: `${mallory.cookie}; ${PENDING_LINK_COOKIE}=${token}` },
    });
    expect(asMallory.statusCode).toBe(403);
    const anon = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      headers: { cookie: `${PENDING_LINK_COOKIE}=${token}` },
    });
    expect(anon.statusCode).toBe(401);
    expect(await db.select().from(schema.oauthAccounts).all()).toHaveLength(0);
    await app.close();
  });

  it('does not trust a forged (client-written) pending-link cookie', async () => {
    const app = await buildApp();
    const mallory = await loginAs(app, 'mallory@x.com');
    const forged = encodeURIComponent(JSON.stringify({ provider: 'github', providerUserId: 'x', userId: mallory.id }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      headers: { cookie: `${mallory.cookie}; ${PENDING_LINK_COOKIE}=${forged}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('publicShareToken visibility', () => {
  beforeEach(() => resetDb());

  it('is returned to the owner but not to collaborators', async () => {
    const app = await buildApp();
    const owner = await loginAs(app, 'owner@x.com');
    const viewer = await loginAs(app, 'viewer@x.com');
    const id = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: {} })).json().id;
    const token = (
      await app.inject({ method: 'POST', url: `/api/layouts/${id}/public-share`, headers: { cookie: owner.cookie } })
    ).json().token as string;
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: viewer.id, role: 'editor', addedAt: new Date() });

    const ownerGet = (await app.inject({ method: 'GET', url: `/api/layouts/${id}`, headers: { cookie: owner.cookie } })).json();
    expect(ownerGet.layout.publicShareToken).toBe(token);
    const ownerList = (await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie: owner.cookie } })).json();
    expect(ownerList.layouts[0].publicShareToken).toBe(token);

    const collabGet = (await app.inject({ method: 'GET', url: `/api/layouts/${id}`, headers: { cookie: viewer.cookie } })).json();
    expect(collabGet.layout.publicShareToken).toBeNull();
    const collabList = (await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie: viewer.cookie } })).json();
    expect(collabList.layouts[0].publicShareToken).toBeNull();
    await app.close();
  });
});
