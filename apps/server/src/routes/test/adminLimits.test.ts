// Usage limits: every limit is enforced on its create/upload/copy path
// with a 403 limit_reached naming it, overrides raise or lower it, an
// account over a limit can still read and delete, suspension makes an
// account or club read-only, request rates are capped per person and per
// token, and the admin endpoints are admin-only and audited.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, issueToken, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { deviceRoutes } from '../auth/device.js';
import { layoutRoutes } from '../layouts.js';
import { orgRoutes } from '../orgs.js';
import { orgInviteRoutes } from '../orgInvites.js';
import { customPartRoutes } from '../customParts.js';
import { moduleRoutes } from '../modules.js';
import { venueRoutes } from '../venues.js';
import { transferRoutes } from '../transfers.js';
import { adminLimitsRoutes, flagRows, median } from '../adminLimits.js';
import { adminRoutes } from '../admin.js';
import { registerLimitHooks, resetRateWindows } from '../../limits/hooks.js';
import { checkGrowth, envDefaults, invalidateLimitCaches, orgLimits, usageOf } from '../../limits/limits.js';
import { usage } from '../../metrics/usage.js';
import { env } from '../../env.js';
import type { User } from '../../db/schema.js';

const DAY = 24 * 60 * 60 * 1000;
// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PART_XML = (pn: string) =>
  `<?xml version="1.0"?><part><Author>t</Author><Description><en>${pn}</en></Description><ImageURL/><SnapMargin>0</SnapMargin><ImageSize><width>8</width><height>8</height></ImageSize></part>`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  registerLimitHooks(app);
  for (const r of [passwordRoutes, sessionRoutes, deviceRoutes, layoutRoutes, orgRoutes, orgInviteRoutes, customPartRoutes, moduleRoutes, venueRoutes, transferRoutes, adminLimitsRoutes, adminRoutes]) {
    await app.register(r);
  }
  return app;
}

let app: FastifyInstance;
let admin: { cookie: string; id: string };

async function setGlobal(limits: Record<string, number | null>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: admin.cookie }, payload: limits });
  expect(res.statusCode, res.body).toBe(200);
}

async function newLayout(c: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: c }, payload: { title: 'L', ...extra } });
}

function body(res: { json(): unknown }) {
  return res.json() as { error: string; limit?: string; message?: string; used?: number; max?: number };
}

beforeEach(async () => {
  resetDb();
  invalidateLimitCaches();
  resetRateWindows();
  usage.reset();
  app = await buildApp();
  admin = await loginAs(app, 'admin@example.com');
  db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
});
afterEach(async () => {
  await app.close();
});

describe('limit values', () => {
  it('start from generous built-ins, overlaid by LIMIT_* env vars', () => {
    const d = envDefaults({});
    expect(d.layoutsPerUser).toBe(500);
    expect(d.storagePerClub).toBe(10 * 1024 ** 3);
    expect(d.clubsPerUser).toBe(5);
    expect(d.newAccountClubs).toBe(1);
    expect(envDefaults({ LIMIT_LAYOUTS_PER_USER: '7', LIMIT_LAYOUTS_PER_CLUB: 'lots', LIMIT_MEMBERS_PER_CLUB: '-1' })).toMatchObject({
      layoutsPerUser: 7,
      layoutsPerClub: 2000,
      membersPerClub: 500,
    });
  });

  it('gives clubs more space for each member', async () => {
    const l = await orgLimits('x', 4);
    const d = envDefaults();
    expect(l.storagePerClub.value).toBe(d.storagePerClub + 4 * d.storagePerClubMember);
    expect(l.storagePerClub.source).toBe('smart');
  });
});

describe('admin endpoints', () => {
  it('are admin-only', async () => {
    const plain = await loginAs(app, 'plain@example.com');
    const urls: [string, string][] = [
      ['GET', '/api/admin/limits'],
      ['PATCH', '/api/admin/limits'],
      ['GET', '/api/admin/abuse/users'],
      ['GET', '/api/admin/abuse/clubs'],
      ['GET', `/api/admin/users/${plain.id}/usage`],
      ['PUT', `/api/admin/users/${plain.id}/limits`],
      ['GET', `/api/admin/orgs/x/usage`],
      ['PUT', `/api/admin/orgs/x/limits`],
    ];
    for (const [method, url] of urls) {
      const res =
        method === 'GET'
          ? await app.inject({ method: 'GET', url, headers: { cookie: plain.cookie } })
          : await app.inject({ method: method as 'PUT' | 'PATCH', url, headers: { cookie: plain.cookie }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('reject unknown limits and bad values', async () => {
    for (const payload of [{ nope: 1 }, { layoutsPerUser: -1 }, { layoutsPerUser: 1.5 }, { layoutsPerUser: '3' }]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: admin.cookie }, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('show where each global value comes from, and audit changes', async () => {
    await setGlobal({ layoutsPerUser: 3 });
    const res = await app.inject({ url: '/api/admin/limits', headers: { cookie: admin.cookie } });
    const row = (res.json() as { limits: { key: string; value: number; default: number; changedHere: boolean }[] }).limits.find((l) => l.key === 'layoutsPerUser');
    expect(row).toMatchObject({ value: 3, default: 500, changedHere: true });
    await setGlobal({ layoutsPerUser: null });
    const back = (await app.inject({ url: '/api/admin/limits', headers: { cookie: admin.cookie } })).json() as { limits: { key: string; value: number }[] };
    expect(back.limits.find((l) => l.key === 'layoutsPerUser')!.value).toBe(500);
    const audits = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_limits_patch')).all();
    expect(audits).toHaveLength(2);
  });
});

describe('enforcement', () => {
  it('stops new layouts at the limit, while reading and deleting still work', async () => {
    const u = await loginAs(app, 'u@example.com');
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
    const second = await newLayout(u.cookie);
    expect(second.statusCode).toBe(201);
    await setGlobal({ layoutsPerUser: 1 }); // already over: nothing removed
    const refused = await newLayout(u.cookie);
    expect(refused.statusCode).toBe(403);
    expect(body(refused)).toMatchObject({ error: 'limit_reached', limit: 'layoutsPerUser', used: 2, max: 1 });
    expect(body(refused).message).toMatch(/You have 2 layouts/);
    const list = await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } });
    expect(list.statusCode).toBe(200);
    const id = (second.json() as { id: string }).id;
    expect((await app.inject({ url: `/api/layouts/${id}`, headers: { cookie: u.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/layouts/${id}`, headers: { cookie: u.cookie } })).statusCode).toBe(200);
    // Copies count too.
    const first = (list.json() as { layouts: { id: string }[] }).layouts.find((l) => l.id !== id)!.id;
    const copy = await app.inject({ method: 'POST', url: `/api/layouts/${first}/copy`, headers: { cookie: u.cookie }, payload: {} });
    expect(body(copy)).toMatchObject({ error: 'limit_reached', limit: 'layoutsPerUser' });
  });

  it('lets an override raise or lower a person’s limit, and audits it', async () => {
    const u = await loginAs(app, 'o@example.com');
    await setGlobal({ layoutsPerUser: 1 });
    await newLayout(u.cookie);
    expect((await newLayout(u.cookie)).statusCode).toBe(403);
    let res = await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { limits: { layoutsPerUser: 3 } } });
    expect(res.statusCode).toBe(200);
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
    res = await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { limits: { layoutsPerUser: null, customPartsPerUser: 0 } } });
    expect((res.json() as { limits: Record<string, number> }).limits).toEqual({ customPartsPerUser: 0 });
    expect((await newLayout(u.cookie)).statusCode).toBe(403);
    const audits = db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.eventType, 'admin_limits_override'), eq(schema.auditEvents.resourceId, u.id))).all();
    expect(audits).toHaveLength(2);
  });

  it('caps space, counting layouts, parts, modules and rooms', async () => {
    const u = await loginAs(app, 's@example.com');
    await newLayout(u.cookie);
    const before = usageOf({ kind: 'user', id: u.id }).storageBytes;
    expect(before).toBeGreaterThan(0);
    await setGlobal({ storagePerUser: before });
    const res = await newLayout(u.cookie);
    expect(body(res)).toMatchObject({ error: 'limit_reached', limit: 'storagePerUser' });
    expect(body(res).message).toMatch(/You have used your .* of space/);
    const mod = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: u.cookie }, payload: { title: 'M' } });
    expect(body(mod)).toMatchObject({ limit: 'storagePerUser' });
    const room = await app.inject({ method: 'POST', url: '/api/venues', headers: { cookie: u.cookie }, payload: { name: 'R', data: { walls: [] } } });
    expect(body(room)).toMatchObject({ limit: 'storagePerUser' });
  });

  it('counts custom parts in space, and allows growth right up to the limit', async () => {
    const u = await loginAs(app, 'edge@example.com');
    const before = usageOf({ kind: 'user', id: u.id }).storageBytes;
    const xml = Buffer.from(PART_XML('E1'));
    const res = await app.inject({ method: 'POST', url: '/api/custom-parts', headers: { cookie: u.cookie }, payload: { partNumber: 'E1', displayName: 'E1', xmlBase64: xml.toString('base64'), spriteBase64: PNG, spriteMime: 'image/png' } });
    expect(res.statusCode).toBe(201);
    const after = usageOf({ kind: 'user', id: u.id }).storageBytes;
    expect(after - before).toBe(xml.length + Buffer.from(PNG, 'base64').length);
    await setGlobal({ storagePerUser: after + 100 });
    const me = db.select().from(schema.users).where(eq(schema.users.id, u.id)).get()!;
    expect(await checkGrowth({ actor: me, owner: { kind: 'user', id: u.id }, add: { bytes: 100 } })).toBeNull();
    expect((await checkGrowth({ actor: me, owner: { kind: 'user', id: u.id }, add: { bytes: 101 } }))?.body.limit).toBe('storagePerUser');
  });

  it('caps custom parts by count and a single upload by size', async () => {
    const u = await loginAs(app, 'p@example.com');
    const part = (pn: string) =>
      app.inject({ method: 'POST', url: '/api/custom-parts', headers: { cookie: u.cookie }, payload: { partNumber: pn, displayName: pn, xmlBase64: Buffer.from(PART_XML(pn)).toString('base64'), spriteBase64: PNG, spriteMime: 'image/png' } });
    const ok = await part('A1');
    expect(ok.statusCode, ok.body).toBe(201);
    await setGlobal({ customPartsPerUser: 1 });
    expect(body(await part('A2'))).toMatchObject({ error: 'limit_reached', limit: 'customPartsPerUser' });
    await setGlobal({ customPartsPerUser: null, uploadBytes: 10 });
    const big = await part('A3');
    expect(big.statusCode).toBe(413);
    expect(body(big)).toMatchObject({ error: 'limit_reached', limit: 'uploadBytes' });
  });

  it('caps share links and club members', async () => {
    const u = await loginAs(app, 'sh@example.com');
    const id = ((await newLayout(u.cookie)).json() as { id: string }).id;
    await setGlobal({ shareLinksPerUser: 0 });
    const share = await app.inject({ method: 'POST', url: `/api/layouts/${id}/public-share`, headers: { cookie: u.cookie } });
    expect(body(share)).toMatchObject({ error: 'limit_reached', limit: 'shareLinksPerUser' });

    const club = (await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'Club' } })).json() as { slug: string };
    await setGlobal({ membersPerClub: 1 });
    const invite = await app.inject({ method: 'POST', url: `/api/orgs/${club.slug}/invites`, headers: { cookie: u.cookie }, payload: { email: 'x@example.com', role: 'member' } });
    expect(body(invite)).toMatchObject({ error: 'limit_reached', limit: 'membersPerClub' });
    expect(body(invite).message).toMatch(/This club has 1 member, the most allowed/);
  });

  it('blocks a move into a full club', async () => {
    const u = await loginAs(app, 'grow@example.com');
    const id = ((await newLayout(u.cookie)).json() as { id: string }).id;

    const club = (await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'Full' } })).json() as { slug: string };
    await setGlobal({ layoutsPerClub: 0 });
    const move = await app.inject({ method: 'POST', url: `/api/layouts/${id}/transfer`, headers: { cookie: u.cookie }, payload: { recipientOrgSlug: club.slug } });
    expect(body(move)).toMatchObject({ error: 'limit_reached', limit: 'layoutsPerClub' });
    expect(body(move).message).toMatch(/Your club has 0 layouts/);
  });

  it('limits how many clubs a person starts, and records who started one', async () => {
    const u = await loginAs(app, 'c@example.com');
    await setGlobal({ clubsPerUser: 1 });
    const first = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'One' } });
    expect(first.statusCode).toBe(201);
    const org = db.select().from(schema.orgs).where(eq(schema.orgs.id, (first.json() as { id: string }).id)).get();
    expect(org?.createdBy).toBe(u.id);
    const second = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'Two' } });
    expect(body(second)).toMatchObject({ error: 'limit_reached', limit: 'clubsPerUser' });
  });
});

describe('smart defaults for new and unverified accounts', () => {
  const saved = process.env.LIMIT_NEW_ACCOUNT_CLUBS;
  const savedClubs = process.env.LIMIT_CLUBS_PER_USER;
  beforeEach(() => {
    process.env.LIMIT_NEW_ACCOUNT_CLUBS = '1';
    process.env.LIMIT_CLUBS_PER_USER = '3';
    invalidateLimitCaches();
  });
  afterEach(() => {
    process.env.LIMIT_NEW_ACCOUNT_CLUBS = saved;
    process.env.LIMIT_CLUBS_PER_USER = savedClubs;
    invalidateLimitCaches();
  });

  function person(createdAt: number, emailVerified = true): User {
    const id = randomUUID();
    db.insert(schema.users).values({ id, email: `${id}@example.com`, displayName: 'n', emailVerified, createdAt: new Date(createdAt) }).run();
    return db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
  }
  function startedClubs(user: User, n: number) {
    for (let i = 0; i < n; i++) {
      db.insert(schema.orgs).values({ id: randomUUID(), name: 'c', slug: randomUUID(), createdAt: new Date(), createdBy: user.id }).run();
    }
  }

  it('needs a confirmed email before starting a club', async () => {
    const u = person(Date.now() - 30 * DAY, false);
    const r = await checkGrowth({ actor: u, owner: { kind: 'user', id: u.id }, add: { clubs: 1 } });
    expect(r?.body).toMatchObject({ error: 'verify_email_first' });
  });

  it('allows one club in the first week, then the normal limit', async () => {
    const fresh = person(Date.now() - DAY);
    expect(await checkGrowth({ actor: fresh, owner: { kind: 'user', id: fresh.id }, add: { clubs: 1 } })).toBeNull();
    startedClubs(fresh, 1);
    const r = await checkGrowth({ actor: fresh, owner: { kind: 'user', id: fresh.id }, add: { clubs: 1 } });
    expect(r?.body).toMatchObject({ error: 'limit_reached', limit: 'clubsPerUser', max: 1 });
    expect(r?.body.message).toMatch(/first week/);

    const settled = person(Date.now() - 30 * DAY);
    startedClubs(settled, 2);
    expect(await checkGrowth({ actor: settled, owner: { kind: 'user', id: settled.id }, add: { clubs: 1 } })).toBeNull();
    startedClubs(settled, 1);
    expect((await checkGrowth({ actor: settled, owner: { kind: 'user', id: settled.id }, add: { clubs: 1 } }))?.body.max).toBe(3);
  });

  it('shows the smart rule on the admin usage page', async () => {
    const fresh = person(Date.now() - DAY);
    const res = await app.inject({ url: `/api/admin/users/${fresh.id}/usage`, headers: { cookie: admin.cookie } });
    const row = (res.json() as { limits: { key: string; value: number; source: string; reason: string }[] }).limits.find((l) => l.key === 'clubsPerUser');
    expect(row).toMatchObject({ value: 1, source: 'smart', reason: 'Account is less than a week old' });
  });
});

describe('suspension', () => {
  it('makes a person read-only: they can read, delete and sign out, not add or change', async () => {
    const u = await loginAs(app, 'bad@example.com');
    const id = ((await newLayout(u.cookie)).json() as { id: string }).id;
    const res = await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true, reason: 'spam' } });
    expect(res.statusCode).toBe(200);
    const blocked = await newLayout(u.cookie);
    expect(blocked.statusCode).toBe(403);
    expect(body(blocked)).toMatchObject({ error: 'suspended' });
    const rename = await app.inject({ method: 'PATCH', url: `/api/layouts/${id}`, headers: { cookie: u.cookie }, payload: { title: 'x' } });
    expect(rename.statusCode).toBe(403);
    expect((await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/layouts/${id}`, headers: { cookie: u.cookie } })).statusCode).toBe(200);

    const events = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.resourceId, u.id)).all().map((e) => e.eventType);
    expect(events).toContain('admin_suspend');
    await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: false } });
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
    expect(db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_unsuspend')).all()).toHaveLength(1);
  });

  it('makes a club read-only without touching its members’ own things', async () => {
    const u = await loginAs(app, 'member@example.com');
    const club = (await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'Sus' } })).json() as { id: string; slug: string };
    await app.inject({ method: 'PUT', url: `/api/admin/orgs/${club.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true } });
    const inClub = await newLayout(u.cookie, { orgSlug: club.slug });
    expect(body(inClub)).toMatchObject({ error: 'suspended' });
    expect(body(inClub).message).toMatch(/club is read-only/);
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
  });

  it('refuses any growth by a suspended person, wherever it would go', async () => {
    const u = await loginAs(app, 'sus2@example.com');
    db.insert(schema.limitOverrides).values({ subjectKind: 'user', subjectId: u.id, suspended: true, updatedAt: new Date() }).run();
    invalidateLimitCaches();
    const me = db.select().from(schema.users).where(eq(schema.users.id, u.id)).get()!;
    const r = await checkGrowth({ actor: me, owner: { kind: 'org', id: 'any-club' }, add: { layouts: 1 } });
    expect(r?.body).toMatchObject({ error: 'suspended' });
    expect(r?.body.message).toMatch(/Your account is read-only/);
  });

  it('won’t let an admin suspend themselves', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/admin/users/${admin.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true } });
    expect(res.statusCode).toBe(400);
  });
});

describe('request rates', () => {
  it('caps requests per minute per person and, separately, per desktop token', async () => {
    const u = await loginAs(app, 'fast@example.com');
    const token = await issueToken(app, u.cookie);
    await setGlobal({ requestsPerMinuteUser: 3, requestsPerMinuteToken: 2 });
    resetRateWindows();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } });
    expect(body(limited)).toMatchObject({ error: 'rate_limited', limit: 'requestsPerMinuteUser' });
    expect(limited.headers['retry-after']).toBe('60');
    // Part pictures don't count against the cap (a big library fetches hundreds).
    const sprite = await app.inject({ url: '/api/custom-parts/none/sprite', headers: { cookie: u.cookie } });
    expect(sprite.statusCode).not.toBe(429);
    const t: number[] = [];
    for (let i = 0; i < 3; i++) t.push((await app.inject({ url: '/api/layouts', headers: { authorization: `Bearer ${token}` } })).statusCode);
    expect(t).toEqual([200, 200, 429]);
  });

  it('counts each person’s requests and refusals by day', async () => {
    const u = await loginAs(app, 'count@example.com');
    usage.reset();
    await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } });
    await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } });
    await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: u.cookie }, payload: {} });
    usage.flush();
    const rows = db.select().from(schema.usageDaily).where(eq(schema.usageDaily.subjectId, u.id)).all();
    const by = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
    expect(by.requests).toBe(3);
    expect(by.refused).toBe(1);
  });
});

describe('abuse view', () => {
  it('sorts people by use and flags the outlier and the one near a limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await loginAs(app, `n${i}@example.com`)).id);
    const day = new Date().toISOString().slice(0, 10);
    db.insert(schema.usageDaily)
      .values([
        ...ids.slice(0, 4).map((id) => ({ day, subjectKind: 'user' as const, subjectId: id, metric: 'requests', value: 300 })),
        { day, subjectKind: 'user', subjectId: ids[4]!, metric: 'requests', value: 9000 },
      ])
      .run();
    await setGlobal({ layoutsPerUser: 5 });
    for (let i = 0; i < 4; i++) {
      db.insert(schema.layouts)
        .values({ id: randomUUID(), title: 't', ownerUserId: ids[0]!, createdBy: ids[0]!, createdAt: new Date(), updatedAt: new Date(), docSnapshot: Buffer.alloc(10) })
        .run();
    }
    const res = await app.inject({ url: '/api/admin/abuse/users?sort=requests1d', headers: { cookie: admin.cookie } });
    const list = res.json() as { rows: { id: string; requests1d: number; flags: string[] }[]; flagged: number };
    expect(list.rows[0]).toMatchObject({ id: ids[4], requests1d: 9000 });
    expect(list.rows[0]!.flags.join()).toMatch(/requests 30× usual/);
    expect(list.rows.find((r) => r.id === ids[0])!.flags).toContain('layouts at 80% of limit');
    expect(list.rows.find((r) => r.id === ids[1])!.flags).toEqual([]);
  });

  it('shows catalog submissions, counted in space used', async () => {
    const u = await loginAs(app, 'sharer@example.com');
    const now = new Date();
    db.insert(schema.catalogItems)
      .values({ id: 'ci1', kind: 'module', sourceId: 'm1', ownerUserId: u.id, title: 'Yard', status: 'in_review', createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.catalogItemVersions)
      .values([1, 2].map((version) => ({ id: `cv${version}`, itemId: 'ci1', version, status: 'in_review' as const, docSnapshot: Buffer.alloc(500), createdAt: now })))
      .run();
    const res = await app.inject({ url: '/api/admin/abuse/users?sort=submissions', headers: { cookie: admin.cookie } });
    const row = (res.json() as { rows: { id: string; submissions: number; storageBytes: number }[] }).rows.find((r) => r.id === u.id)!;
    expect(row.submissions).toBe(2);
    expect(row.storageBytes).toBeGreaterThanOrEqual(1000);
  });

  it('works out a median and flags', () => {
    expect(median([0, 1, 2, 3, 100])).toBe(2.5);
    const rows = [1, 1, 1, 1000].map((v) => ({ storageBytes: 0, layouts: 0, customParts: 0, modules: 0, rooms: 0, submissions: 0, shareLinks: 0, uploads1d: 0, uploads7d: v, uploadsPrev7d: 0, requests1d: 0, requestsPrev1d: 0, refused7d: 0, shareViews7d: 0, live: 0, limits: {} }));
    expect(flagRows(rows).map((f) => f.length)).toEqual([0, 0, 0, 1]);
  });

  it('shows a person’s usage against limits, graphs and activity', async () => {
    const u = await loginAs(app, 'detail@example.com');
    await newLayout(u.cookie);
    await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: u.cookie }, payload: { name: 'Detail Club' } });
    usage.flush();
    const res = await app.inject({ url: `/api/admin/users/${u.id}/usage`, headers: { cookie: admin.cookie } });
    const d = res.json() as {
      usage: { layouts: number; clubsCreated: number };
      limits: { key: string; used: number | null }[];
      series: { days: number[]; requests: number[] };
      activity: { eventType: string }[];
    };
    expect(d.usage).toMatchObject({ layouts: 1, clubsCreated: 1 });
    expect(d.limits.find((l) => l.key === 'layoutsPerUser')!.used).toBe(1);
    expect(d.series.days).toHaveLength(30);
    expect(d.series.requests.at(-1)).toBeGreaterThan(0);
    expect(d.activity.map((a) => a.eventType)).toContain('create');
  });
});

describe('LIMITS_ENFORCE=off', () => {
  beforeEach(() => {
    env.limitsEnforceForced = 'off';
  });
  afterEach(() => {
    env.limitsEnforceForced = null;
  });

  it('counts and shows use but refuses no limit and no rate cap', async () => {
    const u = await loginAs(app, 'free@example.com');
    await setGlobal({ layoutsPerUser: 1, requestsPerMinuteUser: 2 });
    resetRateWindows();
    usage.reset();
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
    expect((await newLayout(u.cookie)).statusCode).toBe(201); // over the limit of 1
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } })).statusCode).toBe(200);
    // Still counted, and the admin page says limits are off.
    usage.flush();
    const rows = db.select().from(schema.usageDaily).where(eq(schema.usageDaily.subjectId, u.id)).all();
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value])).requests).toBeGreaterThanOrEqual(5);
    const page = await app.inject({ url: '/api/admin/limits', headers: { cookie: admin.cookie } });
    expect((page.json() as { enforced: boolean }).enforced).toBe(false);
    expect(await checkGrowth({ actor: { id: u.id } as User, owner: { kind: 'user', id: u.id }, add: { layouts: 1 } })).toBeNull();
  });

  it('still holds a read-only account and club: read-only never depends on the switch', async () => {
    const u = await loginAs(app, 'held@example.com');
    const before = await newLayout(u.cookie);
    expect(before.statusCode).toBe(201);
    const { id: layoutId } = before.json() as { id: string };
    expect((await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true, reason: 't' } })).statusCode).toBe(200);
    // Growth refused, through the request hook and through checkGrowth.
    const blocked = await newLayout(u.cookie);
    expect(blocked.statusCode).toBe(403);
    expect(body(blocked)).toMatchObject({ error: 'suspended' });
    expect((await checkGrowth({ actor: { id: u.id } as User, owner: { kind: 'user', id: u.id }, add: { layouts: 1 } }))?.body).toMatchObject({ error: 'suspended' });
    // Reading and deleting still work.
    expect((await app.inject({ url: '/api/layouts', headers: { cookie: u.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/layouts/${layoutId}`, headers: { cookie: u.cookie } })).statusCode).toBeLessThan(300);
    // Lifted: back to normal.
    await app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: false } });
    expect((await newLayout(u.cookie)).statusCode).toBe(201);

    // A read-only club: nobody adds to it, even with limits off.
    const club = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: admin.cookie }, payload: { name: 'Held Club' } });
    expect(club.statusCode, club.body).toBe(201);
    const { id: orgId, slug } = club.json() as { id: string; slug: string };
    await app.inject({ method: 'PUT', url: `/api/admin/orgs/${orgId}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true } });
    const inClub = await newLayout(admin.cookie, { orgSlug: slug });
    expect(inClub.statusCode).toBe(403);
    expect(body(inClub)).toMatchObject({ error: 'suspended' });
  });
});

describe('the "Enforce usage limits" switch in Admin › Settings', () => {
  afterEach(() => {
    env.limitsEnforceForced = null;
  });

  it('takes effect at once, with no restart, and says where it comes from', async () => {
    const u = await loginAs(app, 'switch@example.com');
    await setGlobal({ layoutsPerUser: 1 });
    expect((await newLayout(u.cookie)).statusCode).toBe(201);
    expect((await newLayout(u.cookie)).statusCode).toBe(403); // on by default

    const off = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: admin.cookie }, payload: { limitsEnforced: false } });
    expect(off.statusCode).toBe(200);
    expect((await newLayout(u.cookie)).statusCode).toBe(201); // same process, straight away
    let page = (await app.inject({ url: '/api/admin/limits', headers: { cookie: admin.cookie } })).json() as {
      enforced: boolean; enforcedSetting: boolean; enforcementSource: string;
    };
    expect(page).toMatchObject({ enforced: false, enforcedSetting: false, enforcementSource: 'setting' });

    // The server's LIMITS_ENFORCE wins over the switch, and the page says so.
    env.limitsEnforceForced = 'on';
    expect((await newLayout(u.cookie)).statusCode).toBe(403);
    page = (await app.inject({ url: '/api/admin/limits', headers: { cookie: admin.cookie } })).json() as typeof page;
    expect(page).toMatchObject({ enforced: true, enforcedSetting: false, enforcementSource: 'forced-on' });

    const audit = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_settings_patch')).all();
    expect(audit.some((e) => JSON.stringify(e.payload).includes('limitsEnforced'))).toBe(true);
  });
});

