// /api/admin/stats/series and /api/admin/insights/* — the admin dashboard.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { env } from '../../env.js';
import { passwordRoutes } from '../auth/password.js';
import { adminInsightsRoutes, bucketRollup, compareVersions, computeAlerts, partsInDoc, rangeSpec, resetContentScan } from '../adminInsights.js';
import { dayKey, rollup } from '../../metrics/rollup.js';

const DAY = 24 * 60 * 60 * 1000;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(adminInsightsRoutes);
  return app;
}

async function admin(app: FastifyInstance): Promise<{ cookie: string; id: string }> {
  const who = await loginAs(app, 'root@example.com');
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, who.id));
  return who;
}

function addUser(createdAt: number, extra: Partial<typeof schema.users.$inferInsert> = {}): string {
  const id = randomUUID();
  db.insert(schema.users)
    .values({ id, email: `${id}@example.com`, displayName: 'x', createdAt: new Date(createdAt), ...extra })
    .run();
  return id;
}

function docWithParts(parts: string[]): Buffer {
  const doc = new Y.Doc();
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const layer = new Y.Map<unknown>();
  const bricks = new Y.Array<Y.Map<unknown>>();
  for (const pn of parts) {
    const b = new Y.Map<unknown>();
    b.set('partNumber', pn);
    bricks.push([b]);
  }
  layer.set('type', 'brick');
  layer.set('bricks', bricks);
  layerData.set('L1', layer);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

function addLayout(ownerUserId: string, opts: { parts?: string[]; updatedAt?: number; lastOpenedAt?: number | null } = {}): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(schema.layouts)
    .values({
      id,
      title: `Layout ${id.slice(0, 4)}`,
      ownerUserId,
      createdBy: ownerUserId,
      createdAt: new Date(opts.updatedAt ?? now),
      updatedAt: new Date(opts.updatedAt ?? now),
      lastOpenedAt: opts.lastOpenedAt == null ? null : new Date(opts.lastOpenedAt),
      docSnapshot: docWithParts(opts.parts ?? []),
    })
    .run();
  return id;
}

const ENDPOINTS = [
  '/api/admin/stats/series',
  '/api/admin/insights/usage',
  '/api/admin/insights/content',
  '/api/admin/insights/people',
  '/api/admin/insights/health',
  '/api/admin/insights/alerts',
];

describe('admin insights — access', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    rollup.reset();
    app = await buildApp();
  });
  afterEach(async () => app.close());

  it('refuses everyone but platform admins', async () => {
    const { cookie: c } = await loginAs(app, 'pleb@example.com');
    for (const url of ENDPOINTS) {
      expect((await app.inject({ url })).statusCode, url).toBe(401);
      expect((await app.inject({ url, headers: { cookie: c } })).statusCode, url).toBe(403);
    }
  });
});

describe('rangeSpec', () => {
  it('buckets by day up to 90 days and by week for 12 months', () => {
    const now = Date.UTC(2026, 9, 1, 15);
    expect(rangeSpec('7d', now)).toMatchObject({ bucket: 'day', buckets: 7, end: Date.UTC(2026, 9, 2) });
    expect(rangeSpec('90d', now)).toMatchObject({ bucket: 'day', buckets: 90 });
    expect(rangeSpec('12m', now)).toMatchObject({ bucket: 'week', buckets: 52, bucketMs: 7 * DAY });
    expect(rangeSpec('drop table', now).id).toBe('30d');
  });
});

describe('bucketRollup', () => {
  beforeEach(() => resetDb());
  it('sums, averages, keeps the last or the highest value per bucket', () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const r = rangeSpec('12m', now);
    // Two days in the last week bucket.
    const d1 = dayKey(r.end - 2 * DAY);
    const d2 = dayKey(r.end - 1 * DAY);
    db.insert(schema.dailyStats).values([
      { day: d1, metric: 'm', key: '', value: 4 },
      { day: d2, metric: 'm', key: '', value: 10 },
      { day: d2, metric: 'm', key: 'other', value: 1 },
    ]).run();
    expect(bucketRollup('m', r, 'sum').at(-1)).toBe(15);
    expect(bucketRollup('m', r, 'sum', '').at(-1)).toBe(14);
    expect(bucketRollup('m', r, 'avg', '').at(-1)).toBe(7);
    expect(bucketRollup('m', r, 'last', '').at(-1)).toBe(10);
    expect(bucketRollup('m', r, 'max', '').at(-1)).toBe(10);
    expect(bucketRollup('m', r, 'sum').slice(0, -1).every((v) => v === 0)).toBe(true);
  });
});

describe('admin insights — data', () => {
  let app: FastifyInstance;
  let backups: string;
  const savedBackupsDir = env.backupsDir;
  beforeEach(async () => {
    resetDb();
    rollup.reset();
    resetContentScan();
    backups = mkdtempSync(join(tmpdir(), 'cld-backups-'));
    env.backupsDir = backups;
    app = await buildApp();
  });
  afterEach(async () => {
    env.backupsDir = savedBackupsDir;
    rmSync(backups, { recursive: true, force: true });
    await app.close();
  });

  it('graphs new users per day inside the range only', async () => {
    const { cookie: c } = await admin(app);
    const now = Date.now();
    addUser(now - 2 * DAY);
    addUser(now - 2 * DAY);
    addUser(now - 40 * DAY);
    const res = await app.inject({ url: '/api/admin/stats/series?range=7d', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { buckets: number[]; series: { newUsers: number[] } };
    expect(body.buckets).toHaveLength(7);
    expect(body.series.newUsers[4]).toBe(2);
    // today: the admin account itself
    expect(body.series.newUsers[6]).toBe(1);
    expect(body.series.newUsers.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('counts active people from last-seen times, and says since when it collects', async () => {
    const { cookie: c } = await admin(app);
    const now = Date.now();
    addUser(now - 100 * DAY, { lastSeenAt: new Date(now - 60_000) });
    addUser(now - 100 * DAY, { lastSeenAt: new Date(now - 3 * DAY) });
    addUser(now - 100 * DAY, { lastSeenAt: new Date(now - 20 * DAY) });
    addUser(now - 100 * DAY, { lastSeenAt: new Date(now - 90 * DAY) });
    const res = await app.inject({ url: '/api/admin/insights/usage', headers: { cookie: c } });
    const body = res.json() as { now: { dau: number; wau: number; mau: number }; collectingSince: Record<string, string> };
    // The admin's own requests don't touch last_seen here (no request hook in this app).
    expect(body.now).toEqual({ dau: 1, wau: 2, mau: 3 });
    expect(body.collectingSince.dau).toBe(dayKey());
  });

  it('lists placed parts that no library knows, and stale layouts', async () => {
    const { cookie: c, id } = await admin(app);
    db.insert(schema.customParts)
      .values({
        id: randomUUID(),
        partNumber: 'MY-CUSTOM-1',
        displayName: 'Mine',
        ownerUserId: id,
        createdBy: id,
        xmlBlob: Buffer.from('<x/>'),
        spriteBlob: Buffer.from('x'),
        spriteMime: 'image/png',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const now = Date.now();
    addLayout(id, { parts: ['zz-nowhere-1', 'zz-nowhere-1', 'my-custom-1'] });
    const old = addLayout(id, { parts: ['zz-nowhere-1'], updatedAt: now - 120 * DAY });
    addLayout(id, { updatedAt: now - 120 * DAY, lastOpenedAt: now - DAY });
    const res = await app.inject({ url: '/api/admin/insights/content', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      missingParts: { partNumber: string; placements: number; layouts: number }[];
      topParts: { partNumber: string }[];
      staleLayouts: { id: string }[];
      totals: { staleLayouts: number; layouts: number };
    };
    expect(body.missingParts).toEqual([{ partNumber: 'zz-nowhere-1', placements: 3, layouts: 2 }]);
    expect(body.topParts.map((p) => p.partNumber)).toContain('my-custom-1');
    expect(body.totals.layouts).toBe(3);
    expect(body.totals.staleLayouts).toBe(1);
    expect(body.staleLayouts.map((l) => l.id)).toEqual([old]);
  });

  it('counts each club’s own layouts, rooms, modules and members', async () => {
    const { cookie: c, id } = await admin(app);
    const orgId = randomUUID();
    db.insert(schema.orgs).values({ id: orgId, name: 'Train Club', slug: 'train-club', createdAt: new Date() }).run();
    db.insert(schema.orgMembers).values({ orgId, userId: id, role: 'admin', joinedAt: new Date() }).run();
    const layoutId = addLayout(id);
    db.update(schema.layouts).set({ ownerUserId: null, ownerOrgId: orgId }).where(eq(schema.layouts.id, layoutId)).run();
    addLayout(id);
    db.insert(schema.venueLibrary).values({ id: randomUUID(), ownerOrgId: orgId, name: 'Hall', data: '{}', createdAt: new Date() }).run();
    const content = (await app.inject({ url: '/api/admin/insights/content', headers: { cookie: c } })).json() as {
      byOwner: { personal: { layouts: number }; clubs: { name: string; layouts: number; rooms: number; bytes: number }[] };
    };
    expect(content.byOwner.personal.layouts).toBe(1);
    expect(content.byOwner.clubs).toEqual([expect.objectContaining({ name: 'Train Club', layouts: 1, rooms: 1 })]);
    expect(content.byOwner.clubs[0]!.bytes).toBeGreaterThan(0);
    const people = (await app.inject({ url: '/api/admin/insights/people', headers: { cookie: c } })).json() as {
      clubs: { name: string; layouts: number; members: number; lastChange: number | null }[];
    };
    expect(people.clubs).toEqual([expect.objectContaining({ name: 'Train Club', layouts: 1, members: 1 })]);
    expect(people.clubs[0]!.lastChange).not.toBeNull();
  });

  it('reports sign-in methods, unverified and dormant accounts', async () => {
    const { cookie: c } = await admin(app);
    const now = Date.now();
    addUser(now - 400 * DAY, { emailVerified: false });
    addUser(now - 400 * DAY, { lastSeenAt: new Date(now - DAY) });
    const res = await app.inject({ url: '/api/admin/insights/people', headers: { cookie: c } });
    const body = res.json() as { totals: { unverified: number; dormant6m: number }; signInMethods: { method: string; users: number }[] };
    expect(body.totals.unverified).toBe(1);
    expect(body.totals.dormant6m).toBe(1);
    expect(body.signInMethods).toContainEqual({ method: 'password', users: 1 });
  });

  it('reports health with backups, live editing and error rates', async () => {
    const { cookie: c } = await admin(app);
    writeFileSync(join(backups, 'cbld-2026-09-30.sqlite.gz'), 'x'.repeat(10));
    rollup.count('requests', '', 200);
    rollup.count('errors_5xx', '', 2);
    const res = await app.inject({ url: '/api/admin/insights/health', headers: { cookie: c } });
    const body = res.json() as {
      version: string;
      live: { connections: number; rooms: number };
      requests: { total: number; errors5xx: number; errorRatePct: number };
      backups: { files: { name: string; bytes: number }[] };
    };
    expect(typeof body.version).toBe('string');
    expect(body.live).toEqual({ connections: 0, rooms: 0 });
    expect(body.requests.errors5xx).toBe(2);
    expect(body.requests.errorRatePct).toBeCloseTo(1, 0);
    expect(body.backups.files).toEqual([expect.objectContaining({ name: 'cbld-2026-09-30.sqlite.gz', bytes: 10 })]);
  });

  it('records whether a web client runs installed or in a browser tab', async () => {
    const { cookie: c } = await loginAs(app, 'pwa@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/metrics/client', headers: { cookie: c }, payload: { display: 'standalone' } });
    expect(res.statusCode).toBe(204);
    const signedOut = await app.inject({ method: 'POST', url: '/api/metrics/client', payload: { display: 'standalone' } });
    expect(signedOut.statusCode).toBe(202);
    await app.inject({ method: 'POST', url: '/api/metrics/client', headers: { cookie: c }, payload: { display: 'bogus' } });
    rollup.flush();
    const rows = db.select().from(schema.dailyStats).where(eq(schema.dailyStats.metric, 'display')).all();
    expect(rows.map((r) => [r.key, r.value])).toEqual([['standalone', 1]]);
  });
});

describe('computeAlerts', () => {
  let backups: string;
  const saved = { dir: env.backupsDir };
  beforeEach(() => {
    resetDb();
    rollup.reset();
    backups = mkdtempSync(join(tmpdir(), 'cld-backups-'));
    env.backupsDir = backups;
  });
  afterEach(() => {
    env.backupsDir = saved.dir;
    rmSync(backups, { recursive: true, force: true });
  });

  it('flags old backups, refusal floods, error spikes and desktop apps that need updating', () => {
    const now = Date.now();
    const f = join(backups, 'cbld-2026-01-01.sqlite.gz');
    writeFileSync(f, 'x');
    utimesSync(f, (now - 3 * DAY) / 1000, (now - 3 * DAY) / 1000);
    const today = dayKey(now);
    db.insert(schema.dailyStats).values([
      { day: today, metric: 'refused', key: '403 GET /api/layouts', value: 60 },
      { day: today, metric: 'refused', key: '403 GET /api/orgs', value: 5 },
      { day: today, metric: 'errors_5xx', key: '', value: 30 },
      { day: dayKey(now - DAY), metric: 'errors_5xx', key: '', value: 2 },
      { day: today, metric: 'desktop_version', key: '1.4.0', value: 3 },
      { day: today, metric: 'desktop_version', key: '1.2.0', value: 2 },
      { day: today, metric: 'desktop_version', key: '1.1.0', value: 1 },
      { day: dayKey(now - DAY), metric: 'desktop_version', key: '1.0.0', value: 4 },
    ]).run();
    const ids = computeAlerts(now).map((a) => a.id);
    expect(ids).toContain('backup-old');
    expect(ids).toContain('refused:403 GET /api/layouts');
    expect(ids).not.toContain('refused:403 GET /api/orgs');
    expect(ids).toContain('error-spike');
    // People seen today on apps below the minimum / recommended version.
    const policy = { minimum: '1.2.0', recommended: '1.3.0' };
    const alerts = computeAlerts(now, policy);
    expect(alerts.find((a) => a.id === 'desktop-update-required')?.text).toBe(
      '1 person tried a desktop app too old for this server today (1.1.0). They need version 1.2.0 or newer.',
    );
    expect(alerts.find((a) => a.id === 'desktop-update-suggested')?.text).toBe(
      '2 people used an older desktop app today (1.2.0). Version 1.3.0 is recommended.',
    );
    // An admin raising the minimum moves 1.2.0 into "must update".
    const raised = computeAlerts(now, { minimum: '1.3.0', recommended: '1.3.0' });
    expect(raised.find((a) => a.id === 'desktop-update-required')?.text).toContain('3 people');
    expect(raised.some((a) => a.id === 'desktop-update-suggested')).toBe(false);
  });

  it('is quiet when all is well', () => {
    writeFileSync(join(backups, 'cbld-2026-01-01.sqlite.gz'), 'x');
    expect(computeAlerts().filter((a) => a.id !== 'disk-full')).toEqual([]);
  });

  it('orders versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('partsInDoc', () => {
  it('counts bricks by part number', () => {
    expect([...partsInDoc(docWithParts(['a', 'b', 'a']))]).toEqual([['a', 2], ['b', 1]]);
    expect(partsInDoc(new Uint8Array()).size).toBe(0);
  });
});
