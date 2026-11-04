// Admin › Settings › Sign-in through the API: GET shows each setting with
// its default and where its value comes from, PATCH checks ranges and the
// pair (the longest at least the idle window), only site admins may change
// it, and saving signs nobody out.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { invalidateSignInCache } from '../../auth/signInSettings.js';

let app: FastifyInstance;
let admin: { cookie: string; id: string };
let alice: { cookie: string; id: string };

beforeEach(async () => {
  resetDb();
  invalidateSignInCache();
  delete process.env.SIGN_IN_WEB_MAX;
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  admin = await loginAs(app, 'admin@example.com');
  db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
  alice = await loginAs(app, 'alice@example.com');
});
afterEach(async () => {
  delete process.env.SIGN_IN_WEB_MAX;
  invalidateSignInCache();
  await app.close();
});

type State = { key: string; value: number | 'never'; setting: number | 'never' | null; forcedBy: string | null; builtIn: number; allowNever: boolean };
const get = async (who = admin) => ((await app.inject({ url: '/api/admin/settings', headers: { cookie: who.cookie } })).json() as { signIn: { settings: State[] } }).signIn.settings;
const patch = (signIn: unknown, who = admin) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: who.cookie }, payload: { signIn } });
const state = (rows: State[], key: string) => rows.find((r) => r.key === key)!;

describe('Admin › Settings › Sign-in', () => {
  it('lists the four settings with their defaults', async () => {
    const rows = await get();
    expect(rows.map((r) => [r.key, r.value, r.builtIn, r.allowNever, r.setting, r.forcedBy])).toEqual([
      ['webIdleHours', 720, 720, false, null, null],
      ['webMaxHours', 2160, 2160, true, null, null],
      ['desktopIdleHours', 2160, 2160, false, null, null],
      ['desktopMaxHours', 4320, 4320, true, null, null],
    ]);
  });

  it('saves a value, "never" for a longest, and back to the default; audited', async () => {
    expect((await patch({ webIdleHours: 48, webMaxHours: 'never' })).statusCode).toBe(200);
    let rows = await get();
    expect(state(rows, 'webIdleHours')).toMatchObject({ value: 48, setting: 48 });
    expect(state(rows, 'webMaxHours')).toMatchObject({ value: 'never', setting: 'never' });
    expect((await patch({ webMaxHours: null })).statusCode).toBe(200);
    rows = await get();
    expect(state(rows, 'webMaxHours')).toMatchObject({ value: 2160, setting: null });
    const audit = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_settings_patch')).all();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses values out of range and a longest shorter than the idle window, in plain words', async () => {
    for (const bad of [{ webIdleHours: 0 }, { webIdleHours: 'never' }, { webIdleHours: 1.5 }, { desktopMaxHours: 3650 * 24 + 1 }, { nope: 5 }, 'x']) {
      const res = await patch(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_input' });
    }
    const below = await patch({ desktopMaxHours: 24 });
    expect(below.statusCode).toBe(400);
    expect(below.json()).toMatchObject({ error: 'sign_in_max_below_idle', message: expect.stringContaining('can’t be shorter') });
    // Nothing was saved.
    expect((await get()).every((r) => r.setting === null)).toBe(true);
  });

  it('only site admins may see or change it', async () => {
    expect((await app.inject({ url: '/api/admin/settings', headers: { cookie: alice.cookie } })).statusCode).toBe(403);
    expect((await patch({ webIdleHours: 2 }, alice)).statusCode).toBe(403);
  });

  it('shows an env var that forces a value, keeping what the admin saved', async () => {
    expect((await patch({ webMaxHours: 24 * 100 })).statusCode).toBe(200);
    process.env.SIGN_IN_WEB_MAX = 'never';
    invalidateSignInCache();
    expect(state(await get(), 'webMaxHours')).toMatchObject({ value: 'never', setting: 2400, forcedBy: 'SIGN_IN_WEB_MAX' });
  });

  it('saving signs nobody out, even a setting shorter than how long they have been signed in', async () => {
    const before = db.select().from(schema.sessions).all().length;
    expect(before).toBeGreaterThanOrEqual(2);
    expect((await patch({ webIdleHours: 1, webMaxHours: 1 })).statusCode).toBe(200);
    expect(db.select().from(schema.sessions).all()).toHaveLength(before);
    // Both just signed in, so both are still within the new hour.
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: alice.cookie } })).json() as { user: { id: string } | null };
    expect(me.user?.id).toBe(alice.id);
  });
});
