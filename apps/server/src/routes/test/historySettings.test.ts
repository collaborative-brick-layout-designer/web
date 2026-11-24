// Admin › Backups › Version history: the switch and the numbers are admin
// settings (admins only, validated, an env var forces the switch and the
// page says which one); the retention, the automatic interval, the big
// delete threshold and the backup counts all follow them; switched off,
// nothing new is kept while what exists stays readable.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { layoutVersionRoutes } from '../layoutVersions.js';
import { docHub } from '../../ws/docHub.js';
import { autoVersion, takeVersion, thinVersions, versionsToDrop } from '../../history/layoutVersions.js';
import { backupKeeps, DEFAULT_HISTORY_LIMITS, HISTORY_SETTINGS, invalidateHistorySettings } from '../../history/settings.js';
import { keepBeforeBulkDelete } from '../../history/bulkDelete.js';
import { trimKinds } from '../../ops/dbBackups.js';
import { env } from '../../env.js';
import type { DecodedUpdate } from '../../ws/decoded.js';

let app: FastifyInstance;
let admin: { cookie: string; id: string };
let user: { cookie: string; id: string };
let layoutId: string;
const savedForced = env.versionHistoryEnabledForced;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  resetDb();
  invalidateHistorySettings();
  env.versionHistoryEnabledForced = null;
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, layoutRoutes, layoutVersionRoutes]) await app.register(r);
  admin = await loginAs(app, 'vh-admin@example.com');
  db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
  user = await loginAs(app, 'vh-user@example.com');
  const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: user.cookie }, payload: { title: 'Yard' } });
  layoutId = (res.json() as { id: string }).id;
});
afterEach(async () => {
  env.versionHistoryEnabledForced = savedForced;
  invalidateHistorySettings();
  await docHub.close(layoutId);
  await app.close();
});

const get = (who?: { cookie: string }) => app.inject({ url: '/api/admin/version-history', headers: who ? { cookie: who.cookie } : {} });
const patch = (payload: unknown, who: { cookie: string } = admin) => app.inject({ method: 'PATCH', url: '/api/admin/version-history', headers: { cookie: who.cookie }, payload: payload as object });
const status = async () => (await app.inject({ url: '/api/version-history/status', headers: { cookie: user.cookie } })).json() as { enabled: boolean };
const state = async (marker: string) => {
  const session = await docHub.getOrCreate(layoutId);
  session.doc.getMap('meta').set('m', marker);
  await session.flushBatch();
  return Y.encodeStateAsUpdate(session.doc);
};
const count = () => db.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.layoutId, layoutId)).all().length;

describe('GET/PATCH /api/admin/version-history', () => {
  it('is for site admins only', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await get(user)).statusCode).toBe(403);
    expect((await patch({ enabled: false }, user)).statusCode).toBe(403);
    expect((await status()).enabled).toBe(true);
  });

  it('shows the defaults, with each setting’s wording and range', async () => {
    const body = (await get(admin)).json() as { enabled: boolean; enabledSetting: boolean; enabledForcedBy: string | null; limits: { key: string; value: number; min: number; max: number; help: string }[] };
    expect(body).toMatchObject({ enabled: true, enabledSetting: true, enabledForcedBy: null });
    expect(Object.fromEntries(body.limits.map((l) => [l.key, l.value]))).toEqual({
      autoMinutes: 30,
      bulkDeleteParts: 50,
      keepAllDays: 1,
      keepDailyDays: 30,
      keepWeeklyWeeks: 26,
      keepBeforeDays: 30,
      keepNamed: 50,
      backupManualKeep: 5,
      backupBeforeRestoreKeep: 3,
      backupUploadKeep: 3,
    });
    for (const l of body.limits) expect(l.help.length).toBeGreaterThan(10);
  });

  it('saves a change, applies it at once, audits it, and null puts a value back', async () => {
    const res = await patch({ enabled: false, limits: { autoMinutes: 10, keepNamed: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, enabledSetting: false });
    expect((await status()).enabled).toBe(false);
    const after = (await patch({ limits: { autoMinutes: null } })).json() as { enabled: boolean; limits: { key: string; value: number }[] };
    expect(after.enabled).toBe(false);
    expect(after.limits.find((l) => l.key === 'autoMinutes')!.value).toBe(30);
    expect(after.limits.find((l) => l.key === 'keepNamed')!.value).toBe(5);
    const audit = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_history_settings')).all();
    expect(audit).toHaveLength(2);
  });

  it('refuses values out of range, not whole, of the wrong type, or unknown', async () => {
    for (const info of HISTORY_SETTINGS) {
      expect((await patch({ limits: { [info.key]: info.min - 1 } })).statusCode, info.key).toBe(400);
      expect((await patch({ limits: { [info.key]: info.max + 1 } })).statusCode, info.key).toBe(400);
      expect((await patch({ limits: { [info.key]: info.min } })).statusCode, info.key).toBe(200);
      expect((await patch({ limits: { [info.key]: info.max } })).statusCode, info.key).toBe(200);
    }
    expect((await patch({ limits: { autoMinutes: 10.5 } })).statusCode).toBe(400);
    expect((await patch({ limits: { autoMinutes: '10' } })).statusCode).toBe(400);
    expect((await patch({ limits: { nope: 1 } })).statusCode).toBe(400);
    expect((await patch({ limits: [] })).statusCode).toBe(400);
    expect((await patch({ enabled: 'yes' })).statusCode).toBe(400);
  });

  it('an env var forces the switch, and the page says which one', async () => {
    await patch({ enabled: false });
    env.versionHistoryEnabledForced = true;
    invalidateHistorySettings();
    const body = (await get(admin)).json() as { enabled: boolean; enabledSetting: boolean; enabledForcedBy: string | null };
    expect(body).toMatchObject({ enabled: true, enabledSetting: false, enabledForcedBy: 'VERSION_HISTORY_ENABLED' });
    expect((await status()).enabled).toBe(true);
    expect(await takeVersion({ layoutId, state: await state('forced'), reason: 'manual' })).not.toBeNull();
  });
});

describe('switched off', () => {
  beforeEach(async () => {
    await takeVersion({ layoutId, state: await state('before'), reason: 'manual', label: 'Kept' });
    await patch({ enabled: false });
  });

  it('keeps nothing new, anywhere', async () => {
    expect(await takeVersion({ layoutId, state: await state('a'), reason: 'manual' })).toBeNull();
    expect(await autoVersion(layoutId, await state('b'), [], Date.now() + 10 * DAY)).toBeNull();
    const decoded = { ds: { clients: new Map([[1, [{ clock: 0, len: 1 }]]]) } } as unknown as DecodedUpdate;
    keepBeforeBulkDelete(await docHub.getOrCreate(layoutId), decoded, null);
    expect(count()).toBe(1);
  });

  it('refuses a version by hand and a restore, lets an import’s keep pass, and still lists and copies', async () => {
    const hand = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions`, headers: { cookie: user.cookie }, payload: { reason: 'manual' } });
    expect(hand.statusCode).toBe(409);
    expect(hand.json()).toMatchObject({ error: 'version_history_off' });
    const imp = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions`, headers: { cookie: user.cookie }, payload: { reason: 'before-import' } });
    expect(imp.statusCode).toBe(200);
    expect(imp.json()).toEqual({ id: null });
    const listed = (await app.inject({ url: `/api/layouts/${layoutId}/versions`, headers: { cookie: user.cookie } })).json() as { versions: { id: string }[]; enabled: boolean };
    expect(listed.enabled).toBe(false);
    expect(listed.versions).toHaveLength(1);
    const vid = listed.versions[0]!.id;
    const restore = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${vid}/restore`, headers: { cookie: user.cookie } });
    expect(restore.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/layouts/${layoutId}/versions/${vid}/snapshot`, headers: { cookie: user.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${vid}/copy`, headers: { cookie: user.cookie }, payload: {} })).statusCode).toBe(201);
  });
});

describe('the numbers are used', () => {
  it('the automatic interval', async () => {
    await patch({ limits: { autoMinutes: 5 } });
    const now = Date.now();
    expect(await autoVersion(layoutId, await state('1'), [], now)).not.toBeNull();
    expect(await autoVersion(layoutId, await state('2'), [], now + 4 * 60_000)).toBeNull();
    expect(await autoVersion(layoutId, await state('3'), [], now + 6 * 60_000)).not.toBeNull();
  });

  it('the big delete threshold', async () => {
    await patch({ limits: { bulkDeleteParts: 7 } });
    invalidateHistorySettings();
    const session = await docHub.getOrCreate(layoutId);
    const doc = new Y.Doc();
    const bricks = doc.getArray<Y.Map<unknown>>('bricks');
    bricks.push(Array.from({ length: 10 }, (_, i) => new Y.Map([['id', `b${i}`]])));
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getArray('bricks').delete(0, 8);
    const ds = Y.decodeUpdate(Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc))).ds;
    // The room has those parts, then one edit deletes eight of them.
    session.doc.getArray('bricks');
    Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(doc));
    // Let the settings load (the check reads the last ones read).
    const { historySettings } = await import('../../history/settings.js');
    await historySettings();
    keepBeforeBulkDelete(session, { ds } as unknown as DecodedUpdate, user.id);
    await new Promise((r) => setTimeout(r, 100));
    const rows = db.select().from(schema.layoutVersions).all();
    expect(rows.map((r) => r.reason)).toEqual(['before-bulk-delete']);
  });

  it('retention follows the saved numbers', async () => {
    const now = Date.now();
    const rows = [
      { id: 'd1', reason: 'auto', label: null, createdAt: now - 3 * DAY },
      { id: 'd1b', reason: 'auto', label: null, createdAt: now - 3 * DAY - 1000 },
      { id: 'd10', reason: 'auto', label: null, createdAt: now - 10 * DAY },
      { id: 'w', reason: 'auto', label: null, createdAt: now - 40 * DAY },
      { id: 'before', reason: 'before-import', label: null, createdAt: now - 20 * DAY },
      { id: 'n1', reason: 'manual', label: 'one', createdAt: now - 2 * DAY },
      { id: 'n2', reason: 'manual', label: 'two', createdAt: now - 3 * DAY },
    ];
    expect(versionsToDrop(rows, now).sort()).toEqual(['d1b']);
    const tight = { ...DEFAULT_HISTORY_LIMITS, keepDailyDays: 5, keepWeeklyWeeks: 0, keepBeforeDays: 7, keepNamed: 1, keepAllDays: 2 };
    expect(versionsToDrop(rows, now, tight).sort()).toEqual(['before', 'd10', 'd1b', 'n2', 'w']);
  });

  it('the nightly thinning reads the saved numbers', async () => {
    const old = Date.now() - 10 * DAY;
    for (const [i, at] of [old, old - 60_000].entries()) {
      db.insert(schema.layoutVersions)
        .values({ id: `00000000-0000-4000-8000-00000000000${i}`, layoutId, reason: 'auto', title: 'Yard', docSnapshot: Buffer.from('x'), docHash: `h${i}`, summary: '{}', editors: '[]', bytes: 1, createdAt: new Date(at) })
        .run();
    }
    // The same day: the older one goes; with a keep-for of 5 days neither stays.
    expect(await thinVersions()).toBe(1);
    await patch({ limits: { keepDailyDays: 5, keepWeeklyWeeks: 0 } });
    expect(await thinVersions()).toBe(1);
    expect(count()).toBe(0);
  });

  it('the backup counts', async () => {
    await patch({ limits: { backupManualKeep: 2, backupBeforeRestoreKeep: 1, backupUploadKeep: 4 } });
    expect(await backupKeeps()).toEqual({ manual: 2, 'before-restore': 1, upload: 4 });
    const dir = mkdtempSync(join(tmpdir(), 'vh-backups-'));
    try {
      const mk = (name: string) => {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), new Date(), new Date());
      };
      for (let i = 1; i <= 4; i++) mk(`cbld-manual-2026010${i}-000000.sqlite.gz`);
      for (let i = 1; i <= 3; i++) mk(`cbld-before-restore-2026010${i}-000000.sqlite.gz`);
      trimKinds(dir, null, await backupKeeps());
      expect(readdirSync(dir).sort()).toEqual(['cbld-before-restore-20260103-000000.sqlite.gz', 'cbld-manual-20260103-000000.sqlite.gz', 'cbld-manual-20260104-000000.sqlite.gz']);
      trimKinds(dir);
      expect(readdirSync(dir)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
