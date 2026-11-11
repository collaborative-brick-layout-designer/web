// How long sign-ins last (Admin › Settings › Sign-in): web sessions and
// desktop tokens slide with use inside their idle window, end at their
// longest however much they are used, follow a changed setting at their
// next check, and an env var forces a value.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, schema } from '../test/helpers.js';
import { createSession, hashToken, isSessionActive, validateSession } from './session.js';
import { createApiToken, isApiTokenActive, listApiTokens, validateApiToken } from './apiTokens.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from './platformSettings.js';
import {
  cleanSignIn,
  forcedSignIn,
  invalidateSignInCache,
  mergeSignInPatch,
  parseDuration,
  SIGN_IN_SETTINGS,
  signInLimits,
  signInSettingStates,
} from './signInSettings.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function makeUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    email: `${id}@example.com`,
    displayName: 'Test',
    avatarUrl: null,
    passwordHash: null,
    isDemoAccount: false,
    isGlobalAdmin: false,
    createdAt: new Date(),
  });
  return id;
}

/** Save sign-in settings the way Admin › Settings does (JSON, hours). */
async function saveSignIn(values: Record<string, number | 'never'>): Promise<void> {
  await getPlatformSettings();
  await db.update(schema.platformSettings).set({ signIn: JSON.stringify(values) }).where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
  invalidateSignInCache();
}

/** Move a session's start and end, as if it were made `ageMs` ago and last pushed back to `expiresInMs` from now. */
async function ageSession(token: string, ageMs: number, expiresInMs: number): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ createdAt: new Date(Date.now() - ageMs), expiresAt: new Date(Date.now() + expiresInMs) })
    .where(eq(schema.sessions.id, hashToken(token)));
}

const sessionRow = (token: string) => db.select().from(schema.sessions).where(eq(schema.sessions.id, hashToken(token))).get();

const ENV_KEYS = SIGN_IN_SETTINGS.map((s) => s.envVar);
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetDb();
  invalidateSignInCache();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  invalidateSignInCache();
});

describe('the defaults', () => {
  it('are 30 days unused and 90 days at most on the web, 90 and 180 in the desktop app', async () => {
    expect(await signInLimits()).toEqual({ web: { idleMs: 30 * DAY, maxMs: 90 * DAY }, desktop: { idleMs: 90 * DAY, maxMs: 180 * DAY } });
    const states = await signInSettingStates();
    expect(states.map((s) => [s.key, s.value, s.setting, s.forcedBy])).toEqual([
      ['webIdleHours', 720, null, null],
      ['webMaxHours', 2160, null, null],
      ['desktopIdleHours', 2160, null, null],
      ['desktopMaxHours', 4320, null, null],
    ]);
  });
});

describe('web sessions', () => {
  it('start with the idle window and remember when they were made', async () => {
    const userId = await makeUser();
    const before = Date.now();
    const { token, expiresAt } = await createSession(userId);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(sessionRow(token)!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('slide: a use in the second half of the window pushes the end back a full window', async () => {
    const { token } = await createSession(await makeUser());
    await ageSession(token, 20 * DAY, 10 * DAY);
    const r = await validateSession(token);
    expect(r?.refreshed).toBe(true);
    expect(r!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    // In the first half: left alone (no write on every request).
    expect((await validateSession(token))?.refreshed).toBe(false);
  });

  it('never slide past their longest, however much they are used', async () => {
    const { token } = await createSession(await makeUser());
    // 80 days old, 5 days left: the longest (90 days) is 10 days away, so the push back stops there.
    await ageSession(token, 80 * DAY, 5 * DAY);
    const r = await validateSession(token);
    expect(r?.refreshed).toBe(true);
    const end = r!.session.expiresAt.getTime();
    expect(end).toBeGreaterThan(Date.now() + 9.9 * DAY);
    expect(end).toBeLessThanOrEqual(Date.now() + 10 * DAY);
    // At the cap already: nothing more to write.
    expect((await validateSession(token))?.refreshed).toBe(false);
  });

  it('end at their longest even while in use: the row is deleted and the WebSocket check agrees', async () => {
    const { token } = await createSession(await makeUser());
    await ageSession(token, 91 * DAY, 25 * DAY);
    expect(await isSessionActive(hashToken(token))).toBe(false);
    expect(await validateSession(token)).toBeNull();
    expect(sessionRow(token)).toBeUndefined();
  });

  it('with "never" as the longest, only time unused ends them', async () => {
    await saveSignIn({ webMaxHours: 'never' });
    const { token } = await createSession(await makeUser());
    await ageSession(token, 400 * DAY, 10 * DAY);
    const r = await validateSession(token);
    expect(r).not.toBeNull();
    expect(r!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('follow a changed setting at their next check, without anyone being signed out on save', async () => {
    const a = await createSession(await makeUser());
    const b = await createSession(await makeUser());
    await ageSession(a.token, 3 * DAY, 27 * DAY);
    await ageSession(b.token, 1 * HOUR, 30 * DAY - HOUR);
    // A shorter longest (2 days) and a shorter idle window (1 day).
    await saveSignIn({ webIdleHours: 24, webMaxHours: 48 });
    // Saving touched no row.
    expect(sessionRow(a.token)).toBeDefined();
    expect(sessionRow(b.token)).toBeDefined();
    // a is past the new longest: it ends at its next check.
    expect(await validateSession(a.token)).toBeNull();
    // b is within it: its end comes forward to the new window.
    const r = await validateSession(b.token);
    expect(r?.refreshed).toBe(true);
    expect(r!.session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY);
    expect(r!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + DAY - 60_000);
  });
});

describe('desktop tokens', () => {
  async function token(ageMs = 0): Promise<{ token: string; id: string; userId: string }> {
    const userId = await makeUser();
    const made = await createApiToken(userId, 'Desktop', ['layouts:read']);
    if (ageMs) {
      await db
        .update(schema.apiTokens)
        .set({ createdAt: new Date(Date.now() - ageMs), lastUsedAt: null })
        .where(eq(schema.apiTokens.id, made.row.id));
    }
    return { token: made.token, id: made.row.id, userId };
  }
  const tokenRow = (id: string) => db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get()!;

  it('start with the 90-day window and slide on use, never past 180 days from when they were made', async () => {
    const t = await token();
    expect(tokenRow(t.id).expiresAt.getTime()).toBeGreaterThan(Date.now() + 89.9 * DAY);
    // 120 days old: a use pushes it to its longest, 60 days away, not 90.
    await db.update(schema.apiTokens).set({ createdAt: new Date(Date.now() - 120 * DAY), lastUsedAt: null }).where(eq(schema.apiTokens.id, t.id));
    expect(await validateApiToken(t.token)).not.toBeNull();
    const end = tokenRow(t.id).expiresAt.getTime();
    expect(end).toBeGreaterThan(Date.now() + 59.9 * DAY);
    expect(end).toBeLessThanOrEqual(Date.now() + 60 * DAY);
  });

  it('end at their longest even while in use, and leave the Devices list', async () => {
    const t = await token(181 * DAY);
    // Its stored end is still weeks away, as the idle window would have it.
    expect(tokenRow(t.id).expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await listApiTokens(t.userId)).toEqual([]);
    expect(await validateApiToken(t.token)).toBeNull();
    expect(await isApiTokenActive(t.id)).toBe(false);
    // Written down as ended, so the clean-up sees it too.
    expect(tokenRow(t.id).expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('show when they really end in the Devices list', async () => {
    const t = await token(170 * DAY);
    const [listed] = await listApiTokens(t.userId);
    expect(listed!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * DAY);
  });

  it('follow a changed setting at their next check', async () => {
    const t = await token(10 * DAY);
    await saveSignIn({ desktopIdleHours: 24, desktopMaxHours: 24 * 7 });
    expect(await validateApiToken(t.token)).toBeNull();
    await saveSignIn({ desktopMaxHours: 'never' });
    // With no longest, an old token that is still used keeps working.
    const u = await token(400 * DAY);
    expect(await validateApiToken(u.token)).not.toBeNull();
  });
});

describe('the settings', () => {
  it('take hours in range, "never" only for the longest, and drop anything else', () => {
    expect(cleanSignIn({ webIdleHours: 48, webMaxHours: 'never', desktopIdleHours: 0, desktopMaxHours: 1.5, other: 3 })).toEqual({ webIdleHours: 48, webMaxHours: 'never' });
    expect(cleanSignIn({ webIdleHours: 'never' })).toEqual({});
    expect(cleanSignIn({ webIdleHours: 366 * 24 })).toEqual({});
    expect(cleanSignIn('nope')).toEqual({});
  });

  it('refuse a patch with an unknown key, a value out of range, or a longest shorter than the idle window', () => {
    expect(mergeSignInPatch(null, { nope: 1 }, {})).toEqual({ error: 'invalid_sign_in_key:nope' });
    expect(mergeSignInPatch(null, { webIdleHours: 0 }, {})).toEqual({ error: 'invalid_sign_in_value:webIdleHours' });
    expect(mergeSignInPatch(null, { webIdleHours: 'never' }, {})).toEqual({ error: 'invalid_sign_in_value:webIdleHours' });
    expect(mergeSignInPatch(null, { desktopMaxHours: 3650 * 24 + 1 }, {})).toEqual({ error: 'invalid_sign_in_value:desktopMaxHours' });
    expect(mergeSignInPatch(null, { webMaxHours: 24 }, {})).toEqual({ error: 'sign_in_max_below_idle:web' });
    expect(mergeSignInPatch(null, { desktopIdleHours: 200 * 24 }, {})).toEqual({ error: 'sign_in_max_below_idle:desktop' });
    expect(mergeSignInPatch(null, [], {})).toEqual({ error: 'invalid_sign_in' });
  });

  it('merge a good patch, and null puts a key back to its default', () => {
    const one = mergeSignInPatch(null, { webIdleHours: 1, webMaxHours: 'never' }, {});
    expect(one).toEqual({ json: JSON.stringify({ webIdleHours: 1, webMaxHours: 'never' }) });
    const two = mergeSignInPatch((one as { json: string }).json, { webMaxHours: null }, {});
    expect(two).toEqual({ json: JSON.stringify({ webIdleHours: 1 }) });
  });

  it('check the pair against what an env var forces', () => {
    // The env var forces the longest to 2 days: an idle window of 3 days can't be saved.
    expect(mergeSignInPatch(null, { webIdleHours: 72 }, { SIGN_IN_WEB_MAX: '2d' })).toEqual({ error: 'sign_in_max_below_idle:web' });
    expect(mergeSignInPatch(null, { webIdleHours: 24 }, { SIGN_IN_WEB_MAX: '2d' })).toHaveProperty('json');
  });
});

describe('env vars', () => {
  it('read durations in days, hours or never', () => {
    expect(parseDuration('30')).toBe(720);
    expect(parseDuration('30d')).toBe(720);
    expect(parseDuration(' 12H ')).toBe(12);
    expect(parseDuration('never')).toBe('never');
    expect(parseDuration('a week')).toBeNull();
    expect(parseDuration('-3d')).toBeNull();
    const max = SIGN_IN_SETTINGS.find((s) => s.key === 'webMaxHours')!;
    const idle = SIGN_IN_SETTINGS.find((s) => s.key === 'webIdleHours')!;
    expect(forcedSignIn(max, { SIGN_IN_WEB_MAX: 'never' })).toBe('never');
    // Out of range or not allowed: ignored, the admin's setting applies.
    expect(forcedSignIn(idle, { SIGN_IN_WEB_IDLE: 'never' })).toBeNull();
    expect(forcedSignIn(idle, { SIGN_IN_WEB_IDLE: '0' })).toBeNull();
    expect(forcedSignIn(idle, { SIGN_IN_WEB_IDLE: '' })).toBeNull();
  });

  it('win over the saved setting, which is kept, and the page is told which one', async () => {
    await saveSignIn({ webIdleHours: 48, desktopMaxHours: 'never' });
    process.env.SIGN_IN_WEB_IDLE = '12h';
    process.env.SIGN_IN_DESKTOP_MAX = '200d';
    invalidateSignInCache();
    const states = await signInSettingStates();
    expect(states.find((s) => s.key === 'webIdleHours')).toMatchObject({ value: 12, setting: 48, forcedBy: 'SIGN_IN_WEB_IDLE' });
    expect(states.find((s) => s.key === 'desktopMaxHours')).toMatchObject({ value: 200 * 24, setting: 'never', forcedBy: 'SIGN_IN_DESKTOP_MAX' });
    expect((await signInLimits()).web.idleMs).toBe(12 * HOUR);
    // A new session follows the forced window.
    const { expiresAt } = await createSession(await makeUser());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 12 * HOUR);
  });

  it('a forced longest below the idle window is raised to it, so nobody is signed out early', async () => {
    process.env.SIGN_IN_WEB_MAX = '1h';
    invalidateSignInCache();
    expect((await signInLimits()).web).toEqual({ idleMs: 30 * DAY, maxMs: 30 * DAY });
  });
});

describe('a mistyped SIGN_IN_* setting is said at start, not ignored without a word', () => {
  it('names each one that can’t be used, why, and what applies meanwhile; good and unset ones say nothing', async () => {
    const { signInEnvWarnings } = await import('./signInSettings.js');
    expect(signInEnvWarnings({})).toEqual([]);
    expect(signInEnvWarnings({ SIGN_IN_WEB_IDLE: '30d', SIGN_IN_WEB_MAX: 'never', SIGN_IN_DESKTOP_IDLE: '12h', SIGN_IN_DESKTOP_MAX: ' ' })).toEqual([]);
    const lines = signInEnvWarnings({ SIGN_IN_WEB_IDLE: '30 days', SIGN_IN_WEB_MAX: '0', SIGN_IN_DESKTOP_IDLE: 'never', SIGN_IN_DESKTOP_MAX: '90d' });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('SIGN_IN_WEB_IDLE="30 days" is ignored: it isn’t a duration. Use days ("30" or "30d"), hours ("12h"). Until it is fixed, the value from Admin › Settings › Sign-in (or the default) applies.');
    expect(lines[1]).toMatch(/^SIGN_IN_WEB_MAX="0" is ignored: it is out of range\. Use 1 to 87600 hours, or "never"\./);
    expect(lines[2]).toMatch(/^SIGN_IN_DESKTOP_IDLE="never" is ignored: "never" isn’t allowed for this one\./);
  });
});
