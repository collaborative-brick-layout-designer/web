// Browser push, against a fake push service: only https endpoints on the
// known push services, never one that resolves to a private address (when
// saved and as the connection is made), a few per person, gone on 404/410,
// a timeout on every send, a payload with only what the app shows, held
// through quiet hours; the VAPID keys made once, the private one stored
// encrypted and never sent; the site switch and PUSH_ENABLED.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { registerChangeHints } from '../../events/routeHints.js';
import { env } from '../../env.js';
import { notify } from '../../notifications/notify.js';
import {
  MAX_SUBSCRIPTIONS,
  SEND_TIMEOUT_MS,
  checkedLookup,
  endpointProblem,
  forgetVapidKeys,
  vapidKeys,
  isPrivateAddress,
  sendDuePush,
  setPushSenderForTests,
  setResolverForTests,
} from '../../notifications/push.js';

type Who = { cookie: string; id: string };
type Sent = { endpoint: string; payload: Record<string, unknown>; opts: Record<string, unknown> };

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
// Made-up browser keys (not real ones), built so no scanner mistakes them for secrets.
const KEYS = { p256dh: `B${'p'.repeat(86)}`, auth: 'a'.repeat(22) };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  registerChangeHints(app);
  await registerApiRoutes(app);
  return app;
}

describe('the push rules', () => {
  it('takes https endpoints on the known push services only', () => {
    expect(endpointProblem(FCM)).toBeNull();
    expect(endpointProblem('https://updates.push.services.mozilla.com/wpush/v2/x')).toBeNull();
    expect(endpointProblem('https://web.push.apple.com/QGx')).toBeNull();
    expect(endpointProblem('https://wns2-par02p.notify.windows.com/w/?token=x')).toBeNull();
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://evil.example/push',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.attacker.example/x',
      'https://notfcm.googleapis.co/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'javascript:alert(1)',
      `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
      42,
    ]) {
      expect(endpointProblem(bad), String(bad)).not.toBeNull();
    }
  });

  it('knows private and loopback addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['142.250.80.10', '8.8.8.8', '172.32.0.1', '2607:f8b0:4004:c07::5f']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('the connection itself refuses a private address, however DNS changed since the check', async () => {
    setResolverForTests(async () => ['142.250.80.10', '10.0.0.5']);
    try {
      const err = await new Promise<Error | null>((ok) => checkedLookup('fcm.googleapis.com', {}, (e) => ok(e)));
      expect(err?.message).toBe('push service address refused');
      setResolverForTests(async () => ['142.250.80.10']);
      const got = await new Promise<string>((ok) => checkedLookup('fcm.googleapis.com', {}, (_e, a) => ok(a as string)));
      expect(got).toBe('142.250.80.10');
    } finally {
      setResolverForTests(null);
    }
  });
});

describe('push routes and sending', () => {
  let app: FastifyInstance;
  let ann: Who;
  let bob: Who;
  let sent: Sent[];
  let answer: number;
  const call = (who: Who, method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const subscribe = (who: Who, endpoint = FCM, extra: object = {}) => call(who, 'POST', '/api/push/subscriptions', { endpoint, keys: KEYS, ...extra });

  beforeEach(async () => {
    resetDb();
    forgetVapidKeys();
    env.pushEnabledForced = null;
    app = await buildApp();
    ann = await loginAs(app, 'ann@example.com');
    bob = await loginAs(app, 'bob@example.com');
    sent = [];
    answer = 201;
    setResolverForTests(async (host) => (host.includes('fcm') || host.includes('mozilla') ? ['142.250.80.10'] : ['10.0.0.7']));
    // The fake push service.
    setPushSenderForTests(async (sub, payload, opts) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown>, opts: opts as Record<string, unknown> });
      if (answer >= 400) throw Object.assign(new Error('Received unexpected response code'), { statusCode: answer });
      return { statusCode: answer };
    });
  });
  afterEach(async () => {
    setResolverForTests(null);
    setPushSenderForTests(null);
    env.pushEnabledForced = null;
    await app.close();
  });

  it('gives the public key only; the private one is stored encrypted and made once', async () => {
    const k = (await call(bob, 'GET', '/api/push/key')).json() as { enabled: boolean; publicKey: string };
    expect(k.enabled).toBe(true);
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const row = (await db.select().from(schema.platformSettings).get())!;
    expect(row.vapidPublicKey).toBe(k.publicKey);
    expect(row.vapidPrivateKey).toMatch(/^enc:v1:/);
    forgetVapidKeys();
    expect(((await call(bob, 'GET', '/api/push/key')).json() as { publicKey: string }).publicKey).toBe(k.publicKey);
    // Not on the admin page either.
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, ann.id));
    const admin = (await call(ann, 'GET', '/api/admin/settings')).body;
    expect(admin).not.toContain(row.vapidPrivateKey!);
    expect(admin).not.toContain('vapidPrivateKey');
    expect(JSON.parse(admin).push).toMatchObject({ value: true, forcedBy: null, keys: 'server' });
  });

  it('first asks at the same time share one pair, and a pair stored meanwhile wins', async () => {
    const keys = await Promise.all([vapidKeys(), vapidKeys(), call(bob, 'GET', '/api/push/key').then((r) => r.json() as { publicKey: string })]);
    const row = (await db.select().from(schema.platformSettings).get())!;
    expect(new Set(keys.map((k) => k!.publicKey))).toEqual(new Set([row.vapidPublicKey]));
    // Another process stored a different pair since this one cached nothing: this one takes the stored pair, not a new one.
    forgetVapidKeys();
    await db.update(schema.platformSettings).set({ vapidPublicKey: null, vapidPrivateKey: null });
    const a = await vapidKeys();
    forgetVapidKeys();
    const b = await vapidKeys();
    expect(b!.publicKey).toBe(a!.publicKey);
    expect((await db.select().from(schema.platformSettings).get())!.vapidPublicKey).toBe(a!.publicKey);
  });

  it('saves a browser on a known push service that resolves publicly; refuses the rest', async () => {
    const ok = await subscribe(bob);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await subscribe(bob, 'https://evil.example/x')).json()).toMatchObject({ error: 'unknown_push_service' });
    // Allowed name, private address.
    setResolverForTests(async () => ['192.168.0.10']);
    expect((await subscribe(bob, 'https://updates.push.services.mozilla.com/wpush/v2/z')).statusCode).toBe(400);
    expect((await call(bob, 'POST', '/api/push/subscriptions', { endpoint: FCM, keys: { p256dh: 'x', auth: 'y' } })).json()).toMatchObject({ error: 'invalid_keys' });
    const list = (await call(bob, 'GET', '/api/push/subscriptions')).json() as { subscriptions: Record<string, unknown>[] };
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0]).toMatchObject({ service: 'fcm.googleapis.com' });
    expect(JSON.stringify(list)).not.toContain(KEYS.auth);
    expect(JSON.stringify(list)).not.toContain('/fcm/send/abc');
  });

  it('keeps a few browsers per person, the newest', async () => {
    for (let i = 0; i <= MAX_SUBSCRIPTIONS; i++) expect((await subscribe(bob, `${FCM}${i}`)).statusCode).toBe(201);
    const rows = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, bob.id)).all();
    expect(rows).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(rows.some((r) => r.endpoint === `${FCM}0`)).toBe(false);
  });

  it('only its owner removes a browser', async () => {
    const { id } = (await subscribe(bob)).json() as { id: string };
    expect((await call(ann, 'DELETE', `/api/push/subscriptions/${id}`)).statusCode).toBe(404);
    expect((await call(bob, 'DELETE', `/api/push/subscriptions/${id}`)).statusCode).toBe(200);
  });

  it('sends what the app shows, with a timeout, and forgets a browser the service says is gone', async () => {
    await subscribe(bob);
    const [n] = await notify({ type: 'account.export_ready', to: [bob.id], title: 'Your data download is ready', body: 'x'.repeat(500), link: '/profile#download' });
    expect(await sendDuePush()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.payload).sort()).toEqual(['body', 'id', 'link', 'title']);
    expect(sent[0]!.payload).toMatchObject({ id: n!.id, title: 'Your data download is ready', link: '/profile#download' });
    expect((sent[0]!.payload.body as string).length).toBeLessThanOrEqual(140);
    expect(sent[0]!.opts).toMatchObject({ timeout: SEND_TIMEOUT_MS });
    expect(sent[0]!.opts.agent).toBeTruthy();
    // Gone at the push service: deleted.
    answer = 410;
    await notify({ type: 'account.export_ready', to: [bob.id], title: 'Again' });
    await sendDuePush();
    expect(await db.select().from(schema.pushSubscriptions).all()).toHaveLength(0);
  });

  it('types with push off, already-read ones, and quiet hours: no pop-up then', async () => {
    await subscribe(bob);
    await call(bob, 'PUT', '/api/me/notification-settings', { settings: { types: { 'account.export_ready': { push: false } } } });
    await notify({ type: 'account.export_ready', to: [bob.id], title: 'Off' });
    const [r] = await notify({ type: 'club.join_request', to: [bob.id], title: 'Read first' });
    await call(bob, 'POST', `/api/notifications/${r!.id}/read`);
    await sendDuePush();
    expect(sent).toEqual([]);
    // Quiet all day: held.
    await call(bob, 'PUT', '/api/me/notification-settings', { settings: { quiet: { on: true, start: '00:00', end: '23:59' }, timeZone: 'UTC' } });
    await notify({ type: 'club.join_request', to: [bob.id], title: 'Held' });
    await sendDuePush();
    expect(sent).toEqual([]);
    const waiting = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.channel, 'push')).all();
    expect(waiting.some((d) => d.state === 'waiting' && d.dueAt.getTime() > Date.now())).toBe(true);
  });

  it('the site switch, and PUSH_ENABLED forcing it, turn push off for everyone', async () => {
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, ann.id));
    expect((await call(ann, 'PATCH', '/api/admin/settings', { pushEnabled: false })).statusCode).toBe(200);
    expect((await call(bob, 'GET', '/api/push/key')).json()).toEqual({ enabled: false, publicKey: null });
    expect((await subscribe(bob)).statusCode).toBe(409);
    expect(((await call(bob, 'GET', '/api/me/notification-settings')).json() as { pushAvailable: boolean }).pushAvailable).toBe(false);
    env.pushEnabledForced = true;
    expect(((await call(bob, 'GET', '/api/push/key')).json() as { enabled: boolean }).enabled).toBe(true);
    expect(JSON.parse((await call(ann, 'GET', '/api/admin/settings')).body).push).toMatchObject({ value: true, setting: false, forcedBy: 'PUSH_ENABLED' });
  });

  it('the download lists browsers without their keys or address; erasing the account takes them', async () => {
    await subscribe(bob);
    const { collectUserData } = await import('../../privacy/collect.js');
    const sections = await collectUserData(bob.id);
    const text = JSON.stringify(sections);
    expect(text).toContain('pop-up-devices');
    expect(text).not.toContain(KEYS.p256dh);
    expect(text).not.toContain(KEYS.auth);
    expect(text).not.toContain('/fcm/send/abc');
    const { eraseUser } = await import('../../privacy/accountDeletion.js');
    await eraseUser(bob.id, 'self', null);
    expect(await db.select().from(schema.pushSubscriptions).all()).toHaveLength(0);
  });
});
