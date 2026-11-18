// Delivery settings (Settings › Notifications): the defaults, checking what
// is saved, in-app off, per-club mute and email, pause all email, quiet
// hours (in the person's zone, across midnight), the hourly cap (never for
// warnings), daily and weekly summaries that never go twice (a restart
// included), and "Stop these emails" with no sign-in (RFC 8058 one-click).

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; items: { title: string }[]; unsubscribePath: string | null; oneClickPath: string | null }> }));
vi.mock('../../email/sendNotification.js', async (orig) => ({
  ...(await orig<typeof import('../../email/sendNotification.js')>()),
  sendNotificationEmail: vi.fn(async (a: (typeof mail.sent)[number]) => {
    mail.sent.push(a);
    return true;
  }),
}));
vi.mock('../../email/transporter.js', async (orig) => ({
  ...(await orig<typeof import('../../email/transporter.js')>()),
  emailConfigured: vi.fn(async () => true),
}));

import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { registerChangeHints } from '../../events/routeHints.js';
import { notify } from '../../notifications/notify.js';
import { EMAILS_PER_HOUR, sendDue, sendSummaries } from '../../notifications/delivery.js';
import { inQuietHours, parseSettings, periodKey, quietEnds, resolve, summaryDue } from '../../notifications/settings.js';
import { readUnsubscribeToken, unsubscribeToken } from '../../notifications/unsubscribe.js';

type Who = { cookie: string; id: string };
type View = {
  types: { type: string; app: boolean; email: string; push: boolean; appLocked: boolean; emailApart: string | null }[];
  quiet: { on: boolean; start: string; end: string };
  timeZone: string | null;
  dailyAt: string;
  weeklyDay: number;
  pauseEmail: boolean;
  clubs: { id: string; mute: boolean; email: boolean }[];
  emailAvailable: boolean;
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  registerChangeHints(app);
  await registerApiRoutes(app);
  return app;
}

describe('notification settings and email', () => {
  let app: FastifyInstance;
  let ann: Who;
  let bob: Who;
  let orgId: string;
  const call = (who: Who, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const view = async (who: Who) => (await call(who, 'GET', '/api/me/notification-settings')).json() as View;
  const put = (who: Who, settings: object) => call(who, 'PUT', '/api/me/notification-settings', { settings });
  const type = (v: View, t: string) => v.types.find((x) => x.type === t)!;

  beforeEach(async () => {
    resetDb();
    mail.sent.length = 0;
    app = await buildApp();
    ann = await loginAs(app, 'ann@example.com');
    bob = await loginAs(app, 'bob@example.com');
    orgId = ((await call(ann, 'POST', '/api/orgs', { name: 'ArkLUG', slug: 'arklug' })).json() as { id: string }).id;
    await db.insert(schema.orgMembers).values({ orgId, userId: bob.id, role: 'member', joinedAt: new Date() });
  });
  afterEach(async () => {
    await app.close();
  });

  it('starts with the defaults: all in the app; email and push for what waits', async () => {
    const v = await view(bob);
    expect(type(v, 'club.join_request')).toMatchObject({ app: true, email: 'now', push: true });
    expect(type(v, 'account.export_ready')).toMatchObject({ app: true, email: 'now', push: true });
    expect(type(v, 'club.role_changed')).toMatchObject({ app: true, email: 'off', push: false });
    expect(type(v, 'moderation.warning')).toMatchObject({ appLocked: true, email: 'now' });
    expect(type(v, 'sharing.layout_invite')).toMatchObject({ emailApart: 'invite', email: 'off' });
    expect(v).toMatchObject({ quiet: { on: false }, timeZone: null, dailyAt: '08:00', weeklyDay: 1, pauseEmail: false, emailAvailable: true });
    expect(v.clubs.map((c) => c.id)).toEqual([orgId]);
  });

  it('saves only good settings, merged onto what is there', async () => {
    expect((await put(bob, { types: { 'club.role_changed': { email: 'daily' } } })).statusCode).toBe(200);
    expect((await put(bob, { timeZone: 'America/Chicago', dailyAt: '18:30' })).statusCode).toBe(200);
    const v = await view(bob);
    expect(type(v, 'club.role_changed').email).toBe('daily');
    expect(v).toMatchObject({ timeZone: 'America/Chicago', dailyAt: '18:30' });
    for (const bad of [
      { types: { 'moderation.warning': { app: false } } },
      { types: { 'sharing.layout_invite': { email: 'now' } } },
      { types: { 'no.such': { email: 'off' } } },
      { types: { 'club.removed': { email: 'hourly' } } },
      { timeZone: 'Mars/Olympus' },
      { quiet: { start: '25:00' } },
      { weeklyDay: 7 },
      { clubs: { 'not-my-club': { mute: true } } },
      { nope: 1 },
    ]) {
      const r = await put(bob, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json()).toMatchObject({ error: 'invalid_settings', message: expect.any(String) });
    }
    expect((await call(bob, 'PUT', '/api/me/notification-settings', {})).statusCode).toBe(400);
  });

  it('turned off in the app: gone from the list and the count, still in the summary', async () => {
    await notify({ type: 'club.role_changed', to: [bob.id], club: orgId, needsMembership: true, title: 'Roles' });
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { unread: number }).unread).toBe(1);
    await put(bob, { types: { 'club.role_changed': { app: false, email: 'daily' } } });
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { unread: number }).unread).toBe(0);
    await notify({ type: 'club.role_changed', to: [bob.id], club: orgId, needsMembership: true, title: 'Roles again' });
    expect(((await call(bob, 'GET', '/api/notifications')).json() as { notifications: unknown[] }).notifications).toHaveLength(0);
    const morning = new Date('2026-11-18T09:00:00Z');
    expect(await sendSummaries(morning)).toBe(1);
    expect(mail.sent[0]!.items.map((i) => i.title).sort()).toEqual(['Roles', 'Roles again']);
    // Back on: they come back.
    await put(bob, { types: { 'club.role_changed': { app: true } } });
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { unread: number }).unread).toBe(2);
  });

  it('a muted club stays out of the app and email; email off for a club, or paused for all, stops email only', async () => {
    await put(bob, { clubs: { [orgId]: { mute: true } } });
    await notify({ type: 'club.join_request', to: [bob.id], club: orgId, needsMembership: true, title: 'Muted' });
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { unread: number }).unread).toBe(0);
    await put(bob, { clubs: { [orgId]: { mute: false, email: false } } });
    await notify({ type: 'club.join_request', to: [bob.id], club: orgId, needsMembership: true, title: 'No email' });
    await put(bob, { clubs: { [orgId]: null }, pauseEmail: true });
    await notify({ type: 'account.export_ready', to: [bob.id], title: 'Paused' });
    await sendDue();
    expect(mail.sent).toEqual([]);
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { unread: number }).unread).toBe(3);
  });

  it('a warning can’t be muted out of the app', async () => {
    await put(bob, { clubs: { [orgId]: { mute: true } } });
    await notify({ type: 'moderation.warning', to: [bob.id], club: orgId, title: 'Warning from ArkLUG' });
    expect(((await call(bob, 'GET', '/api/notifications/count')).json() as { warnings: number }).warnings).toBe(1);
  });

  describe('quiet hours', () => {
    const zone = resolve({ v: 1, quiet: { on: true, start: '22:00', end: '07:00' }, timeZone: 'America/Chicago' });
    it('hold across midnight, in the person’s zone', () => {
      // 23:30 in Chicago (CST, UTC-6) is 05:30 UTC.
      expect(inQuietHours(zone, new Date('2026-11-18T05:30:00Z'))).toBe(true);
      // 06:59 there: still quiet; 07:00: not.
      expect(inQuietHours(zone, new Date('2026-11-18T12:59:00Z'))).toBe(true);
      expect(inQuietHours(zone, new Date('2026-11-18T13:00:00Z'))).toBe(false);
      // Noon there.
      expect(inQuietHours(zone, new Date('2026-11-18T18:00:00Z'))).toBe(false);
      expect(quietEnds(zone, new Date('2026-11-18T05:30:00Z')).toISOString()).toBe('2026-11-18T13:00:00.000Z');
      expect(quietEnds(zone, new Date('2026-11-18T18:00:00Z')).toISOString()).toBe('2026-11-18T18:00:00.000Z');
      // Off, or the same start and end: never quiet.
      expect(inQuietHours(resolve({ v: 1, quiet: { on: false, start: '00:00', end: '23:59' } }), new Date())).toBe(false);
      expect(inQuietHours(resolve({ v: 1, quiet: { on: true, start: '09:00', end: '09:00' } }), new Date())).toBe(false);
      // Within one day (13:00 to 14:00).
      const day = resolve({ v: 1, quiet: { on: true, start: '13:00', end: '14:00' }, timeZone: 'UTC' });
      expect(inQuietHours(day, new Date('2026-11-18T13:30:00Z'))).toBe(true);
      expect(inQuietHours(day, new Date('2026-11-18T14:00:00Z'))).toBe(false);
    });

    it('hold a right-away email until they end, then it goes', async () => {
      await put(bob, { quiet: { on: true, start: '22:00', end: '07:00' }, timeZone: 'America/Chicago' });
      const night = new Date('2026-11-18T05:30:00Z');
      vi.useFakeTimers({ now: night, toFake: ['Date'] });
      try {
        await notify({ type: 'account.export_ready', to: [bob.id], title: 'Ready at night' });
      } finally {
        vi.useRealTimers();
      }
      expect(await sendDue(night)).toBe(0);
      expect(await sendDue(new Date('2026-11-18T12:59:00Z'))).toBe(0);
      expect(await sendDue(new Date('2026-11-18T13:00:00Z'))).toBe(1);
      expect(mail.sent.map((m) => m.subject)).toEqual(['Ready at night']);
    });

    it('don’t hold summaries', () => {
      const r = resolve({ v: 1, quiet: { on: true, start: '00:00', end: '23:00' }, timeZone: 'UTC', dailyAt: '08:00' });
      expect(summaryDue('daily', r, new Date('2026-11-18T09:00:00Z'))).toBe(true);
    });
  });

  it('an email already read in the app isn’t sent', async () => {
    const [n] = await notify({ type: 'account.export_ready', to: [bob.id], title: 'Read first' });
    await call(bob, 'POST', `/api/notifications/${n!.id}/read`);
    expect(await sendDue()).toBe(0);
    expect(mail.sent).toEqual([]);
  });

  it('past the hourly cap, the rest wait for the daily summary; warnings still go', async () => {
    for (let i = 0; i < EMAILS_PER_HOUR + 3; i++) await notify({ type: 'account.export_ready', to: [bob.id], title: `N${i}` });
    await notify({ type: 'moderation.warning', to: [bob.id], title: 'A warning' });
    await sendDue();
    expect(mail.sent).toHaveLength(EMAILS_PER_HOUR + 1);
    expect(mail.sent.some((m) => m.subject === 'A warning')).toBe(true);
    const deferred = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.state, 'deferred')).all();
    expect(deferred).toHaveLength(3);
    mail.sent.length = 0;
    // The next morning's summary carries them, once.
    const morning = new Date(Date.now() + 86_400_000);
    morning.setUTCHours(9, 0, 0, 0);
    expect(await sendSummaries(morning)).toBe(1);
    expect(mail.sent[0]!.items).toHaveLength(3);
    expect(await sendSummaries(morning)).toBe(0);
  });

  describe('summaries', () => {
    it('daily: once its time comes, once a day, with what is unread since the last one; never twice across a restart', async () => {
      await put(bob, { types: { 'club.role_changed': { email: 'daily' } }, timeZone: 'UTC', dailyAt: '08:00' });
      const at = (iso: string) => new Date(iso);
      vi.useFakeTimers({ now: at('2026-11-18T06:00:00Z'), toFake: ['Date'] });
      try {
        await notify({ type: 'club.role_changed', to: [bob.id], title: 'One' });
        await notify({ type: 'club.role_changed', to: [bob.id], title: 'Two' });
        // Right-away types don't go in it.
        await notify({ type: 'club.removed', to: [bob.id], title: 'Off' });
      } finally {
        vi.useRealTimers();
      }
      expect(await sendSummaries(at('2026-11-18T07:59:00Z'))).toBe(0);
      expect(await sendSummaries(at('2026-11-18T08:00:00Z'))).toBe(1);
      expect(mail.sent[0]).toMatchObject({ subject: 'Your daily summary: 2 new notifications' });
      expect(mail.sent[0]!.items.map((i) => i.title)).toEqual(['Two', 'One']);
      // A restart in the middle: the run that was sending had already written its row.
      expect(await sendSummaries(at('2026-11-18T08:05:00Z'))).toBe(0);
      const rows = await db.select().from(schema.notificationDigests).where(eq(schema.notificationDigests.userId, bob.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'daily', period: '2026-11-18', state: 'sent', items: 2 });
      // A run killed after writing its row but before sending: nothing is sent again that day.
      await db.update(schema.notificationDigests).set({ state: 'sending' }).where(eq(schema.notificationDigests.id, rows[0]!.id));
      expect(await sendSummaries(at('2026-11-18T09:00:00Z'))).toBe(0);
      expect(mail.sent).toHaveLength(1);
      // The next day: only what came since.
      vi.useFakeTimers({ now: at('2026-11-18T20:00:00Z'), toFake: ['Date'] });
      try {
        await notify({ type: 'club.role_changed', to: [bob.id], title: 'Three' });
      } finally {
        vi.useRealTimers();
      }
      expect(await sendSummaries(at('2026-11-19T08:00:00Z'))).toBe(1);
      expect(mail.sent[1]!.items.map((i) => i.title)).toEqual(['Three']);
    });

    it('weekly: on its day, at its time', async () => {
      // 2026-11-23 is a Monday.
      await put(bob, { types: { 'club.role_changed': { email: 'weekly' } }, timeZone: 'UTC', dailyAt: '08:00', weeklyDay: 1 });
      await notify({ type: 'club.role_changed', to: [bob.id], title: 'Week', at: new Date('2026-11-20T10:00:00Z') });
      expect(await sendSummaries(new Date('2026-11-22T09:00:00Z'))).toBe(0);
      expect(await sendSummaries(new Date('2026-11-23T09:00:00Z'))).toBe(1);
      expect(mail.sent[0]!.subject).toBe('Your weekly summary: 1 new notification');
      expect(await sendSummaries(new Date('2026-11-23T10:00:00Z'))).toBe(0);
      expect(periodKey('weekly', resolve({ v: 1, timeZone: 'UTC' }), new Date('2026-11-23T09:00:00Z'))).toBe('week-of-2026-11-23');
    });

    it('nothing new: no email, and the day is marked', async () => {
      await put(bob, { types: { 'club.role_changed': { email: 'daily' } }, timeZone: 'UTC' });
      expect(await sendSummaries(new Date('2026-11-18T09:00:00Z'))).toBe(0);
      expect((await db.select().from(schema.notificationDigests).get())!.state).toBe('empty');
    });
  });

  describe('Stop these emails', () => {
    it('every email has the one-click link; the page asks first; it needs no sign-in', async () => {
      await notify({ type: 'account.export_ready', to: [bob.id], title: 'Ready' });
      await sendDue();
      const m = mail.sent[0]!;
      expect(m.unsubscribePath).toMatch(/^\/unsubscribe\?t=/);
      expect(m.oneClickPath).toMatch(/^\/api\/notifications\/unsubscribe\?t=/);
      const url = m.oneClickPath!;
      // Looking (a mail scanner opening the link) changes nothing.
      const look = await app.inject({ method: 'GET', url });
      expect(look.json()).toMatchObject({ ok: true, scope: 'account.export_ready', what: 'emails about “Your data download is ready”' });
      expect(type(await view(bob), 'account.export_ready').email).toBe('now');
      // RFC 8058 one-click: a form POST, no cookie.
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
      expect(res.statusCode, res.body).toBe(200);
      expect(type(await view(bob), 'account.export_ready').email).toBe('off');
      expect(type(await view(bob), 'club.join_request').email).toBe('now');
    });

    it('the summary link stops all notification email', async () => {
      const t = unsubscribeToken(bob.id, 'all')!;
      expect((await app.inject({ method: 'POST', url: '/api/notifications/unsubscribe', payload: { t } })).statusCode).toBe(200);
      expect((await view(bob)).pauseEmail).toBe(true);
    });

    it('a forged or changed token does nothing', async () => {
      const t = unsubscribeToken(bob.id, 'all')!;
      const [body, sig] = t.split('.');
      const other = Buffer.from(JSON.stringify({ u: ann.id, s: 'all' })).toString('base64url');
      for (const bad of [`${other}.${sig}`, `${body}.AAAA`, 'nonsense', '']) {
        expect(readUnsubscribeToken(bad)).toBeNull();
        expect((await app.inject({ method: 'POST', url: `/api/notifications/unsubscribe?t=${encodeURIComponent(bad)}` })).statusCode).toBe(404);
      }
      expect((await view(ann)).pauseEmail).toBe(false);
    });
  });

  it('the privacy download has the settings; erasing the account takes them', async () => {
    await put(bob, { pauseEmail: true });
    expect(await db.select().from(schema.notificationSettings).where(eq(schema.notificationSettings.userId, bob.id)).get()).toBeTruthy();
    const { eraseUser } = await import('../../privacy/accountDeletion.js');
    await eraseUser(bob.id, 'self', null);
    expect(await db.select().from(schema.notificationSettings).where(and(eq(schema.notificationSettings.userId, bob.id))).get()).toBeFalsy();
  });

  it('parseSettings keeps what it is given, on top of what was there', () => {
    const a = parseSettings({ types: { 'club.removed': { email: 'weekly' } } });
    expect('ok' in a && a.ok.types).toEqual({ 'club.removed': { email: 'weekly' } });
    const b = parseSettings({ types: { 'club.removed': { push: true } } }, 'ok' in a ? a.ok : { v: 1 });
    expect('ok' in b && b.ok.types).toEqual({ 'club.removed': { email: 'weekly', push: true } });
  });
});
