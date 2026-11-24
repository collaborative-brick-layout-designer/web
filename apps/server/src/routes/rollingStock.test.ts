import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, resetDb, schema, testVerificationToken, signupCookieOf } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { passwordRoutes } from './auth/password.js';
import { sessionRoutes } from './auth/session.js';
import { orgRoutes } from './orgs.js';
import { ensureClubRoles, setMemberRoles } from '../access/clubPermissions.js';
import { rollingStockRoutes, stockProblem } from './rollingStock.js';

const BOXCAR = { number: '4021', name: 'Boxcar', type: 'boxcar', length: 32, trucks: [{ at: 8 }, { at: -8 }], look: { mode: 'simple', color: '#a33' } };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(orgRoutes);
  await app.register(rollingStockRoutes);
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
    headers: { cookie: signupCookieOf(res) },
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
}

type Entry = { id: string; number: string; name: string; version: number; canManage: boolean; ownerOrgId: string | null; record: Record<string, unknown> };

describe('rolling stock rosters', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const list = async (cookie: string, owner = 'all') =>
    ((await app.inject({ method: 'GET', url: `/api/rolling-stock?owner=${owner}`, headers: { cookie } })).json() as { stock: Entry[] }).stock;

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/rolling-stock' })).statusCode).toBe(401);
  });

  it('saves, lists, changes and deletes a personal car, bumping its version', async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const made = await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: alice }, payload: { record: { ...BOXCAR, id: 'layout-local', libraryId: 'x', libraryVersion: 9 } } });
    expect(made.statusCode).toBe(201);
    const car = made.json() as Entry;
    expect(car.version).toBe(1);
    // The layout's own id and stale library link are the server's to set.
    expect(car.record).toMatchObject({ number: '4021', length: 32, libraryId: car.id, libraryVersion: 1 });
    expect(car.record.id).toBeUndefined();
    expect((await list(alice)).map((e) => e.id)).toEqual([car.id]);
    expect(await list(bob)).toEqual([]);

    // Someone else can't see or change it.
    expect((await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: bob }, payload: { record: BOXCAR } })).statusCode).toBe(404);

    const changed = await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: alice }, payload: { record: { ...BOXCAR, name: 'Red boxcar' } } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ name: 'Red boxcar', version: 2, record: { libraryVersion: 2 } });

    expect((await app.inject({ method: 'DELETE', url: `/api/rolling-stock/${car.id}`, headers: { cookie: bob } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/rolling-stock/${car.id}`, headers: { cookie: alice } })).statusCode).toBe(200);
    expect(await list(alice)).toEqual([]);
  });

  it('keeps a club roster that members who may edit modules can change', async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const carol = await registerAndLogin(app, 'carol@example.com');
    await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: alice }, payload: { name: 'Acme', slug: 'acme' } });
    const made = await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: alice }, payload: { record: BOXCAR, orgSlug: 'acme' } });
    expect(made.statusCode).toBe(201);
    const car = made.json() as Entry;
    const acme = await db.select().from(schema.orgs).where(eq(schema.orgs.slug, 'acme')).get();
    expect(car.ownerOrgId).toBe(acme!.id);

    const user = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)).get())!;
    await db.insert(schema.orgMembers).values({ orgId: acme!.id, userId: (await user('bob@example.com')).id, role: 'member', joinedAt: new Date() });

    // Bob, a member, sees it and (members may edit modules) may change it.
    const bobs = await list(bob, 'acme');
    expect(bobs.map((e) => [e.id, e.canManage])).toEqual([[car.id, true]]);
    expect((await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: bob }, payload: { record: BOXCAR } })).statusCode).toBe(200);
    // Not a member: nothing to see.
    expect(await list(carol)).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/rolling-stock/${car.id}`, headers: { cookie: carol } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: carol }, payload: { record: BOXCAR, orgSlug: 'acme' } })).statusCode).not.toBe(201);

    // As a viewer, Bob sees the roster but can't change it.
    await ensureClubRoles(acme!.id);
    await setMemberRoles(acme!.id, (await user('bob@example.com')).id, [`${acme!.id}:viewer`]);
    expect((await list(bob)).map((e) => e.canManage)).toEqual([false]);
    const refused = await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: bob }, payload: { record: BOXCAR } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ permission: 'edit_modules' });
    expect((await app.inject({ method: 'DELETE', url: `/api/rolling-stock/${car.id}`, headers: { cookie: alice } })).statusCode).toBe(200);
  });

  it('turns away records that are not rolling stock', async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bad = await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: alice }, payload: { record: { name: 'No length' } } });
    expect(bad.statusCode).toBe(400);
    const huge = await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: alice }, payload: { record: { ...BOXCAR, notes: 'x'.repeat(70_000) } } });
    expect(huge.statusCode).toBe(413);
    expect(stockProblem({ ...BOXCAR, trucks: [{ at: 'front' }] })).toMatch(/truck/);
    expect(stockProblem({ ...BOXCAR, length: -3 })).toMatch(/length/);
    expect(stockProblem(BOXCAR)).toBeNull();
  });

  it('keeps an imported model car’s custom part as its model_part_id, when the part is on this server', async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const owner = (await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get())!.id;
    const partId = '0b6f3e52-7d55-4c8f-9a51-3f5bb0f1c2aa';
    const now = new Date();
    await db.insert(schema.customParts).values({
      id: partId,
      partNumber: 'SANTA_FE',
      displayName: 'Santa Fe',
      ownerUserId: owner,
      createdBy: owner,
      xmlBlob: Buffer.from('<part/>'),
      spriteBlob: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      spriteMime: 'image/png',
      createdAt: now,
      updatedAt: now,
    });
    const engine = { ...BOXCAR, kind: 'engine', look: { mode: 'model', color: '#a33', partKey: `custom:${partId}` }, model: { partKey: `custom:${partId}`, file: 'santa-fe.io', format: 'studio' } };
    const made = await app.inject({ method: 'POST', url: '/api/rolling-stock', headers: { cookie: alice }, payload: { record: engine } });
    expect(made.statusCode).toBe(201);
    const car = made.json() as Entry & { modelPartId: string | null };
    expect(car.modelPartId).toBe(partId);
    expect(car.record.model).toEqual(engine.model);
    // Back to a plain box: no model part. A part that isn't here: none either.
    const plain = await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: alice }, payload: { record: BOXCAR } });
    expect((plain.json() as { modelPartId: string | null }).modelPartId).toBeNull();
    const elsewhere = await app.inject({ method: 'PATCH', url: `/api/rolling-stock/${car.id}`, headers: { cookie: alice }, payload: { record: { ...BOXCAR, look: { mode: 'model', partKey: 'custom:11111111-2222-3333-4444-555555555555' } } } });
    expect((elsewhere.json() as { modelPartId: string | null }).modelPartId).toBeNull();
    const row = await db.select().from(schema.rollingStock).where(eq(schema.rollingStock.id, car.id)).get();
    expect(row!.modelPartId).toBeNull();
  });
});
