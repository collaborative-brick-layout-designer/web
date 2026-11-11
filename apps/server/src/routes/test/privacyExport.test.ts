// "Download my data" (routes/privacy.ts, privacy/*): who may ask and
// download, what the zip holds (and never holds), the once-a-day limit,
// the Privacy settings, and the clean-up of expired downloads.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { sqlite } from '../../db/index.js';
import { readZip } from '../../test/zip.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { venueRoutes } from '../venues.js';
import { moduleRoutes } from '../modules.js';
import { adminRoutes } from '../admin.js';
import { warningRoutes } from '../warnings.js';
import { privacyRoutes } from '../privacy.js';
import { exportPath, settleExports } from '../../privacy/exports.js';
import { READ_TABLES, NO_PERSONAL_DATA } from '../../privacy/collect.js';
import { invalidatePrivacyCache, privacySettings } from '../../privacy/settings.js';
import { privacyTick } from '../../privacy/tick.js';
import { ZipFileWriter, ZipTooBigError } from '../../privacy/zipWriter.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const BBM = readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf-8');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(layoutRoutes);
  await app.register(venueRoutes);
  await app.register(moduleRoutes);
  await app.register(adminRoutes);
  await app.register(warningRoutes);
  await app.register(privacyRoutes);
  return app;
}

type Who = { cookie: string; id: string };

async function exportNow(app: FastifyInstance, who: Who) {
  const res = await app.inject({ method: 'POST', url: '/api/me/privacy/exports', headers: { cookie: who.cookie } });
  await settleExports();
  return res;
}

async function list(app: FastifyInstance, who: Who) {
  const res = await app.inject({ method: 'GET', url: '/api/me/privacy/exports', headers: { cookie: who.cookie } });
  return res.json() as { exports: { id: string; status: string; downloadUrl: string | null; error: string | null }[]; nextAllowedAt: number | null };
}

describe('Download my data', () => {
  let app: FastifyInstance;
  let ann: Who;
  let bob: Who;

  beforeEach(async () => {
    resetDb();
    sqlite.exec('DELETE FROM data_exports; DELETE FROM venue_library;');
    invalidatePrivacyCache();
    app = await buildApp();
    ann = await loginAs(app, 'ann@example.com');
    bob = await loginAs(app, 'bob@example.com');
  });
  afterEach(async () => {
    await settleExports();
    delete process.env.PRIVACY_EXPORT_EVERY_HOURS;
    invalidatePrivacyCache();
    await app.close();
  });

  it('builds a zip with a README, every table about the person, and their layouts as files', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: ann.cookie }, payload: { title: 'Main yard', bbm: BBM } });
    expect(made.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: { cookie: ann.cookie },
      payload: { name: 'Hall', data: { name: 'Hall', enabled: true, edges: [], obstacles: [], minWalkwayStuds: 0 } },
    });

    const res = await exportNow(app, ann);
    expect(res.statusCode).toBe(202);
    const { exports } = await list(app, ann);
    expect(exports).toHaveLength(1);
    expect(exports[0]!.status).toBe('ready');
    const url = exports[0]!.downloadUrl!;
    expect(url).toMatch(/^\/api\/privacy\/exports\/[0-9a-f-]+\/download$/);

    const dl = await app.inject({ method: 'GET', url, headers: { cookie: ann.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const zip = readZip(dl.rawPayload);
    expect(zip.get('README.txt')!.toString()).toContain('Your data from Collaborative Brick Layout Designer');
    const account = JSON.parse(zip.get('data/account.json')!.toString()) as { rows: Record<string, unknown>[] };
    expect(account.rows[0]!.email).toBe('ann@example.com');
    expect(account.rows[0]!.hasPassword).toBe(true);
    const names = [...zip.keys()];
    expect(names).toContain('layouts/Main yard.bld-layout');
    expect(names).toContain('venues/Hall.json');
    // Nothing waits in Recently deleted: no such folder, and the README doesn't mention one.
    expect(names.some((n) => n.startsWith('recently-deleted/'))).toBe(false);
    expect(zip.get('README.txt')!.toString()).not.toContain('recently-deleted/');
    // The .bld-layout inside is itself a layout file.
    const inner = readZip(zip.get('layouts/Main yard.bld-layout')!);
    expect(JSON.parse(inner.get('manifest.json')!.toString()).format).toBe('bld-layout');
    expect(inner.get('layout.bbm')!.toString()).toContain('<Map');

    // Never a secret: no password hash, no session id.
    const user = await db.select().from(schema.users).where(eq(schema.users.id, ann.id)).get();
    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, ann.id)).get();
    const everything = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    expect(everything).not.toContain(user!.passwordHash!);
    expect(everything).not.toContain(session!.id);
    // Nothing of Bob's.
    expect(everything).not.toContain('bob@example.com');

    // A note says it's ready.
    const notices = await db.select().from(schema.warnings).where(eq(schema.warnings.subjectUserId, ann.id)).all();
    expect(notices.some((n) => n.reason.includes('is ready'))).toBe(true);
    // And the download is audit-logged.
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, ann.id)).all();
    expect(audit.map((a) => a.eventType)).toEqual(expect.arrayContaining(['data_export', 'data_export_download']));
  });

  // What waits in Recently deleted is still theirs: the download carries
  // its contents too, not only the line saying it was deleted.
  it('includes what is in Recently deleted as files, and only the person’s own', async () => {
    const h = { cookie: ann.cookie };
    const layout = (await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: { title: 'Old yard', bbm: BBM } })).json() as { id: string };
    const venue = (
      await app.inject({
        method: 'POST',
        url: '/api/venues',
        headers: h,
        payload: { name: 'Barn', data: { name: 'Barn', enabled: true, edges: [], obstacles: [], minWalkwayStuds: 0 } },
      })
    ).json() as { id: string };
    const module = (await app.inject({ method: 'POST', url: '/api/modules', headers: h, payload: { title: 'Depot' } })).json() as { id: string };
    await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: { title: 'Kept yard', bbm: BBM } });
    // Bob deletes one of his own: never in Ann's download.
    const bobs = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: bob.cookie }, payload: { title: 'Bobs secret yard', bbm: BBM } })).json() as { id: string };
    expect((await app.inject({ method: 'DELETE', url: `/api/layouts/${bobs.id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(200);
    for (const url of [`/api/layouts/${layout.id}`, `/api/venues/${venue.id}`, `/api/modules/${module.id}`]) {
      expect((await app.inject({ method: 'DELETE', url, headers: h })).statusCode).toBe(200);
    }
    expect(await db.select().from(schema.trashItems).where(eq(schema.trashItems.ownerUserId, ann.id)).all()).toHaveLength(3);

    await exportNow(app, ann);
    const { exports } = await list(app, ann);
    expect(exports[0]!.status).toBe('ready');
    const zip = readZip((await app.inject({ method: 'GET', url: exports[0]!.downloadUrl!, headers: h })).rawPayload);
    const names = [...zip.keys()];
    expect(names).toContain('layouts/Kept yard.bld-layout');
    expect(names).not.toContain('layouts/Old yard.bld-layout');
    expect(names).toContain('recently-deleted/layouts/Old yard.bld-layout');
    expect(names).toContain('recently-deleted/venues/Barn.json');
    expect(names.some((n) => n.startsWith('recently-deleted/modules/Depot.'))).toBe(true);
    // The deleted layout is a whole layout file, as the ones that weren't deleted are.
    const inner = readZip(zip.get('recently-deleted/layouts/Old yard.bld-layout')!);
    expect(JSON.parse(inner.get('manifest.json')!.toString()).format).toBe('bld-layout');
    expect(inner.get('layout.bbm')!.toString()).toContain('<Map');
    expect(JSON.parse(zip.get('recently-deleted/venues/Barn.json')!.toString())).toMatchObject({ name: 'Barn', venue: { name: 'Barn' } });
    // The README says what the folder is, and the list still says what was deleted and when.
    expect(zip.get('README.txt')!.toString()).toContain('3 layout(s), module(s) and venue(s) waiting in Recently deleted');
    const listed = JSON.parse(zip.get('data/recently-deleted.json')!.toString()) as { rows: { title: string }[] };
    expect(listed.rows.map((r) => r.title).sort()).toEqual(['Barn', 'Depot', 'Old yard']);
    expect(names.some((n) => n.includes('Bobs secret yard'))).toBe(false);

  });

  it('only the person who asked can download it', async () => {
    await exportNow(app, ann);
    const url = (await list(app, ann)).exports[0]!.downloadUrl!;
    expect((await app.inject({ method: 'GET', url, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await list(app, bob)).exports).toHaveLength(0);
    // Someone not signed in can't ask for one either.
    expect((await app.inject({ method: 'POST', url: '/api/me/privacy/exports' })).statusCode).toBe(401);
  });

  it('allows one download every 24 hours by default, adjustable in Settings', async () => {
    expect((await exportNow(app, ann)).statusCode).toBe(202);
    const again = await exportNow(app, ann);
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe('export_too_soon');
    expect((await list(app, ann)).nextAllowedAt).toBeGreaterThan(Date.now() + 23 * 3600_000);

    // An admin sets it to every hour; it still applies (the last one was just now).
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, bob.id));
    const patch = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: bob.cookie }, payload: { privacy: { exportEveryHours: 1 } } });
    expect(patch.statusCode).toBe(200);
    expect((await privacySettings()).exportEveryHours).toBe(1);
    expect((await list(app, ann)).nextAllowedAt).toBeLessThan(Date.now() + 3600_001);
  });

  it('shows each privacy setting with its default, the saved value and whether the server forces it', async () => {
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, bob.id));
    const bad = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: bob.cookie }, payload: { privacy: { exportKeepDays: 99 } } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: bob.cookie }, payload: { privacy: { nope: 1 } } });
    expect(unknown.statusCode).toBe(400);
    // Not an admin: no.
    const denied = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: ann.cookie }, payload: { privacy: { exportKeepDays: 3 } } });
    expect(denied.statusCode).toBe(403);

    await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: bob.cookie }, payload: { privacy: { exportKeepDays: 3, exportEveryHours: 2 } } });
    process.env.PRIVACY_EXPORT_EVERY_HOURS = '48';
    invalidatePrivacyCache();
    const got = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: bob.cookie } });
    const states = got.json().privacy.settings as { key: string; value: number; setting: number | null; forcedBy: string | null; builtIn: number }[];
    const keep = states.find((s) => s.key === 'exportKeepDays')!;
    expect(keep).toMatchObject({ value: 3, setting: 3, forcedBy: null, builtIn: 7 });
    const every = states.find((s) => s.key === 'exportEveryHours')!;
    expect(every).toMatchObject({ value: 48, setting: 2, forcedBy: 'PRIVACY_EXPORT_EVERY_HOURS' });
    expect((await privacySettings()).exportEveryHours).toBe(48);
    // The change is audit-logged with the rest of the settings.
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_settings_patch')).all();
    expect(audit.some((a) => a.payload.includes('exportKeepDays'))).toBe(true);
  });

  it('deletes downloads after their keep-by date (fake time)', async () => {
    await exportNow(app, ann);
    const id = (await list(app, ann)).exports[0]!.id;
    expect(existsSync(exportPath(id))).toBe(true);
    // Six days on, it stays.
    expect((await privacyTick(new Date(Date.now() + 6 * 86_400_000))).exportsPurged).toBe(0);
    expect(existsSync(exportPath(id))).toBe(true);
    // Eight days on, it goes: row and file.
    expect((await privacyTick(new Date(Date.now() + 8 * 86_400_000))).exportsPurged).toBe(1);
    expect(existsSync(exportPath(id))).toBe(false);
    expect((await list(app, ann)).exports).toHaveLength(0);
  });

  it('lists an expired download as expired and refuses it', async () => {
    await exportNow(app, ann);
    const row = (await list(app, ann)).exports[0]!;
    await db.update(schema.dataExports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.dataExports.id, row.id));
    const now = (await list(app, ann)).exports[0]!;
    expect(now.downloadUrl).toBeNull();
    expect(now.error).toContain('expired');
    const dl = await app.inject({ method: 'GET', url: `/api/privacy/exports/${row.id}/download`, headers: { cookie: ann.cookie } });
    expect(dl.statusCode).toBe(410);
  });
});

describe('privacy data map', () => {
  it('every table is either read for a download or listed as holding no personal data', () => {
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    const unknown = tables.filter((t) => !READ_TABLES.includes(t) && !(t in NO_PERSONAL_DATA));
    expect(unknown).toEqual([]);
  });

  it('the data map doc names every table', () => {
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/PRIVACY-DATA.md'), 'utf-8');
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as { name: string }[]).map((r) => r.name);
    expect(tables.filter((t) => !doc.includes(`\`${t}\``))).toEqual([]);
  });
});

describe('zip writer', () => {
  it('stops at the size cap', () => {
    const path = join(dirname(process.env.DB_PATH!), 'cap.zip');
    const zip = new ZipFileWriter(path, 1000);
    expect(() => zip.add('big.bin', randomBytes(5000))).toThrow(ZipTooBigError);
    zip.close();
  });

  it('round-trips names and contents, and makes clashing names unique', () => {
    const path = join(dirname(process.env.DB_PATH!), 'names.zip');
    const zip = new ZipFileWriter(path);
    expect(zip.add('a/b.txt', 'one')).toBe('a/b.txt');
    expect(zip.add('a/b.txt', 'two')).toBe('a/b (2).txt');
    expect(zip.add('a/x:y.txt', 'x'.repeat(500))).toBe('a/x_y.txt');
    zip.finish();
    const back = readZip(readFileSync(path));
    expect(back.get('a/b.txt')!.toString()).toBe('one');
    expect(back.get('a/b (2).txt')!.toString()).toBe('two');
    expect(back.get('a/x_y.txt')!.toString()).toBe('x'.repeat(500));
  });
});
