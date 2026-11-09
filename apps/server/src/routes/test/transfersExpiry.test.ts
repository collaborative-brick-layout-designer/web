// Tests for transfer preview/accept edge cases not covered by transfers.test.ts:
//   GET  /api/transfers/:token → 410 when already accepted
//   GET  /api/transfers/:token → 410 when expired
//   POST /api/transfers/:token → 410 when already accepted
//   POST /api/transfers/:token → 410 when expired

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema, resetDb, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';
import { transferRoutes } from '../transfers.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  await app.register(transferRoutes);
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

async function createLayout(app: FastifyInstance, cookieStr: string, title = 'TL'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/layouts',
    headers: { cookie: cookieStr },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function getUserId(email: string): Promise<string> {
  const row = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  return row!.id;
}

async function insertTransfer(opts: {
  layoutId: string;
  initiatedBy: string;
  recipientEmail: string;
  expiresAt: Date;
  acceptedAt?: Date;
}): Promise<string> {
  const token = `tr-tok-${Math.random().toString(36).slice(2)}`;
  const id = `tr-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  await db.insert(schema.layoutTransfers).values({
    id,
    layoutId: opts.layoutId,
    initiatedBy: opts.initiatedBy,
    recipientEmail: opts.recipientEmail,
    token,
    expiresAt: opts.expiresAt,
    acceptedAt: opts.acceptedAt ?? null,
    createdAt: now,
  });
  return token;
}

// ---------------------------------------------------------------------------

describe('transfer preview — expiry edge cases', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 410 when the transfer has already been accepted', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const ownerId = await getUserId('owner@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const token = await insertTransfer({
      layoutId,
      initiatedBy: ownerId,
      recipientEmail: 'recipient@example.com',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: new Date(),
    });

    const res = await app.inject({ method: 'GET', url: `/api/transfers/${token}` });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('transfer_already_accepted');
  });

  it('returns 410 when the transfer has expired', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const ownerId = await getUserId('owner@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const token = await insertTransfer({
      layoutId,
      initiatedBy: ownerId,
      recipientEmail: 'recipient@example.com',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({ method: 'GET', url: `/api/transfers/${token}` });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('transfer_expired');
  });

  it('returns 200 with layout title for a valid pending transfer', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const ownerId = await getUserId('owner@example.com');
    const layoutId = await createLayout(app, ownerCookie, 'My Cool Layout');
    const token = await insertTransfer({
      layoutId,
      initiatedBy: ownerId,
      recipientEmail: 'recipient@example.com',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const res = await app.inject({ method: 'GET', url: `/api/transfers/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { layoutTitle: string; recipientEmail: string };
    expect(body.layoutTitle).toBe('My Cool Layout');
    // Signed out: masked (only the recipient, signed in, sees it whole).
    expect(body.recipientEmail).toBe('r…@example.com');
  });
});

describe('transfer accept — expiry edge cases', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 410 when the transfer has already been accepted', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const recipientCookie = await registerAndLogin(app, 'recipient@example.com');
    const ownerId = await getUserId('owner@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const token = await insertTransfer({
      layoutId,
      initiatedBy: ownerId,
      recipientEmail: 'recipient@example.com',
      expiresAt: new Date(Date.now() + 86400_000),
      acceptedAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/transfers/${token}`,
      headers: { cookie: recipientCookie },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('transfer_already_accepted');
  });

  it('returns 410 when the transfer has expired', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const recipientCookie = await registerAndLogin(app, 'recipient@example.com');
    const ownerId = await getUserId('owner@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const token = await insertTransfer({
      layoutId,
      initiatedBy: ownerId,
      recipientEmail: 'recipient@example.com',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/transfers/${token}`,
      headers: { cookie: recipientCookie },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('transfer_expired');
  });
});
