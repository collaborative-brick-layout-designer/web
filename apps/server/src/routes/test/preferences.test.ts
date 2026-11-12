// Account preferences (theme, color, text size, expert mode, help
// icons, tours seen): session round-trip, validation, and which API
// token scopes may read or change them.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken, loginAs, resetDb } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { deviceRoutes } from '../auth/device.js';
import { preferencesRoutes, DEFAULT_PREFERENCES } from '../preferences.js';
import { db, schema } from '../../db/index.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(deviceRoutes);
  await app.register(preferencesRoutes);
  return app;
}

const URL = '/api/me/preferences';

describe('account preferences', () => {
  let app: FastifyInstance;
  let user: { cookie: string; id: string };
  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    user = await loginAs(app, 'prefs@example.com');
  });
  afterEach(async () => {
    await app.close();
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const put = (headers: Record<string, string>, prefs: unknown) =>
    app.inject({ method: 'PUT', url: URL, headers, payload: { prefs } });

  it('needs a signed-in user', async () => {
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    expect((await put({}, { theme: 'dark' })).statusCode).toBe(401);
  });

  it('starts at the defaults with no updatedAt', async () => {
    const res = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: DEFAULT_PREFERENCES, updatedAt: null });
  });

  it('saves, merges and reads back', async () => {
    const first = await put({ cookie: user.cookie }, { theme: 'dark', accent: 'ocean' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { prefs: typeof DEFAULT_PREFERENCES; updatedAt: string };
    expect(firstBody.prefs).toEqual({ ...DEFAULT_PREFERENCES, theme: 'dark', accent: 'ocean' });
    expect(Number.isNaN(Date.parse(firstBody.updatedAt))).toBe(false);

    // A second client changing one other key keeps the first change.
    const second = await put({ cookie: user.cookie }, { largeText: true, toursSeen: ['welcome', 'welcome', 'sheets'] });
    expect(second.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    const body = got.json() as { prefs: typeof DEFAULT_PREFERENCES; updatedAt: string };
    expect(body.prefs).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      accent: 'ocean',
      largeText: true,
      toursSeen: ['welcome', 'sheets'],
    });
    expect(Date.parse(body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(firstBody.updatedAt));

    // Another account sees only its own.
    const other = await loginAs(app, 'other@example.com');
    const theirs = await app.inject({ method: 'GET', url: URL, headers: { cookie: other.cookie } });
    expect(theirs.json()).toEqual({ prefs: DEFAULT_PREFERENCES, updatedAt: null });
  });

  it('keeps the parts picture size only once it is set, from 32 to 160 px', async () => {
    const before = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect('partsIconSize' in (before.json() as { prefs: object }).prefs).toBe(false);
    for (const size of [32, 160, 96]) {
      const res = await put({ cookie: user.cookie }, { partsIconSize: size });
      expect(res.statusCode).toBe(200);
    }
    await put({ cookie: user.cookie }, { theme: 'dark' });
    const got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs).toEqual({ ...DEFAULT_PREFERENCES, theme: 'dark', partsIconSize: 96 });
  });

  it('keeps the Snap strength: gentle until set, then off, gentle or strong', async () => {
    const before = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect((before.json() as { prefs: { connectionSnap: string } }).prefs.connectionSnap).toBe('gentle');
    for (const v of ['off', 'strong', 'gentle', 'strong']) {
      const res = await put({ cookie: user.cookie }, { connectionSnap: v });
      expect(res.statusCode).toBe(200);
      expect(res.json().prefs.connectionSnap).toBe(v);
    }
    await put({ cookie: user.cookie }, { largeText: true });
    const got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs.connectionSnap).toBe('strong');
    expect(got.json().prefs.largeText).toBe(true);
  });

  it('keeps a LEGO color and how far the color reaches, and clears the LEGO color with null', async () => {
    let got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    // Always returned, so the desktop knows this server can store them.
    // The whole app is the default for anyone who never chose.
    expect(got.json().prefs).toMatchObject({ legoColor: null, colorStyle: 'full' });
    expect((await put({ cookie: user.cookie }, { legoColor: 24, colorStyle: 'original' })).statusCode).toBe(200);
    got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs).toMatchObject({ legoColor: 24, colorStyle: 'original', accent: 'brick' });
    // "Just the highlights", once chosen, stays when other settings change.
    expect((await put({ cookie: user.cookie }, { legoColor: null, accent: 'ocean' })).statusCode).toBe(200);
    got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs).toMatchObject({ legoColor: null, colorStyle: 'original', accent: 'ocean' });
  });

  it('gives the whole app to settings saved before there was a choice, and keeps a chosen one', async () => {
    // Saved before colorStyle existed: no key, so the new default.
    await db.insert(schema.userPreferences).values({ userId: user.id, prefs: JSON.stringify({ theme: 'dark', accent: 'ocean' }), updatedAt: new Date() });
    let got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs).toMatchObject({ theme: 'dark', accent: 'ocean', colorStyle: 'full' });
    // A stored "original" is someone's choice and stays.
    await db
      .update(schema.userPreferences)
      .set({ prefs: JSON.stringify({ theme: 'dark', colorStyle: 'original' }) });
    got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json().prefs).toMatchObject({ theme: 'dark', colorStyle: 'original' });
  });

  it('refuses unknown keys and wrong values without storing anything', async () => {
    const bad: unknown[] = [
      { theme: 'purple' },
      { accent: 'chartreuse' },
      { largeText: 'yes' },
      { expertMode: 1 },
      { helpIcons: null },
      { toursSeen: 'welcome' },
      { toursSeen: ['has space'] },
      { toursSeen: Array.from({ length: 201 }, (_, i) => `t${i}`) },
      { fontSize: 20 },
      { partsIconSize: 31 },
      { partsIconSize: 161 },
      { partsIconSize: 48.5 },
      { partsIconSize: '48' },
      { connectionSnap: 'medium' },
      { connectionSnap: true },
      { connectionSnap: 'Gentle' },
      { legoColor: 99999 },
      { legoColor: '24' },
      { legoColor: 24.5 },
      { legoColor: 41 }, // Trans-Red: see-through colors aren't offered
      { colorStyle: 'bold' },
      { colorStyle: null },
      ['theme'],
      null,
    ];
    for (const prefs of bad) {
      const res = await put({ cookie: user.cookie }, prefs);
      expect(res.statusCode, JSON.stringify(prefs)).toBe(400);
    }
    const missing = await app.inject({ method: 'PUT', url: URL, headers: { cookie: user.cookie }, payload: { theme: 'dark' } });
    expect(missing.statusCode).toBe(400);
    const got = await app.inject({ method: 'GET', url: URL, headers: { cookie: user.cookie } });
    expect(got.json()).toEqual({ prefs: DEFAULT_PREFERENCES, updatedAt: null });
  });

  it('tokens: layouts:read may read, account:prefs may read and write, others may not', async () => {
    const reader = await issueToken(app, user.cookie, 'layouts:read');
    expect((await app.inject({ method: 'GET', url: URL, headers: bearer(reader) })).statusCode).toBe(200);
    expect((await put(bearer(reader), { theme: 'dark' })).statusCode).toBe(403);

    const prefsOnly = await issueToken(app, user.cookie, 'account:prefs');
    const saved = await put(bearer(prefsOnly), { accent: 'forest' });
    expect(saved.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: URL, headers: bearer(prefsOnly) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { prefs: { accent: string } }).prefs.accent).toBe('forest');

    const venuesOnly = await issueToken(app, user.cookie, 'venues:write');
    expect((await app.inject({ method: 'GET', url: URL, headers: bearer(venuesOnly) })).statusCode).toBe(403);
    expect((await put(bearer(venuesOnly), { theme: 'dark' })).statusCode).toBe(403);
  });

  it('device sign-in without a scope list grants account:prefs', async () => {
    const all = await issueToken(app, user.cookie);
    expect((await put(bearer(all), { theme: 'light' })).statusCode).toBe(200);
  });
});
