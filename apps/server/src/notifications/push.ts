// Browser push (Web Push with VAPID): a pop-up from the browser for a
// notification, as each person chose (settings.ts), held through their
// quiet hours like email.
//
// Must hold (docs/notifications.md):
//   - a subscription's endpoint is https on a known push service
//     (PUSH_HOSTS), checked when saved and before every send;
//   - its host must resolve only to public addresses, checked as the
//     connection is made (a lookup hook on the agent, so DNS can't change
//     between the check and the connection); no redirects (the sender
//     never follows them);
//   - a few per person (the oldest goes);
//   - gone at the push service (404 or 410): deleted;
//   - every send times out;
//   - what is sent holds only the title, a short body, the link and the
//     notification's id: words the person sees in the app anyway;
//   - the VAPID private key is stored encrypted, never sent, logged or
//     downloaded.

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
import webpush from 'web-push';
import { and, asc, eq, lte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { encryptSecret, readSecret } from '../secrets/secretBox.js';

/** Push services browsers use (suffixes match their subdomains). */
export const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge (Chromium), Android, Opera, Samsung
  'android.googleapis.com', // older Chrome
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com',
  'web.push.apple.com', // Safari, iOS home-screen apps
  'notify.windows.com', // Edge (legacy) / Windows (WNS): *.notify.windows.com
  'push.apple.com',
] as const;

/** Browsers one person may have signed up for pop-ups. */
export const MAX_SUBSCRIPTIONS = 10;
/** Every send gives up after this long. */
export const SEND_TIMEOUT_MS = 10_000;
const BODY_MAX = 140;
const ENDPOINT_MAX = 1000;

let logError: (msg: string, err: unknown) => void = (msg, err) => console.error(msg, err instanceof Error ? err.message : err);
export function setPushErrorLogger(fn: (msg: string, err: unknown) => void): void {
  logError = fn;
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return PUSH_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

/** An address that isn't on the public internet (loopback, private, link-local, CGNAT, multicast, reserved). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** Why an endpoint can't be used, or null when it can (before the DNS check). */
export function endpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return 'invalid_endpoint';
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'invalid_endpoint';
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return 'invalid_endpoint';
  if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) return 'unknown_push_service';
  if (!hostAllowed(u.hostname)) return 'unknown_push_service';
  return null;
}

type Resolver = (host: string) => Promise<string[]>;
let resolveHost: Resolver = (host) =>
  new Promise((ok, fail) => dnsLookup(host, { all: true }, (err, addrs: LookupAddress[]) => (err ? fail(err) : ok(addrs.map((a) => a.address)))));
/** Tests: answer DNS lookups from a table. */
export function setResolverForTests(fn: Resolver | null): void {
  resolveHost = fn ?? ((host) => new Promise((ok, fail) => dnsLookup(host, { all: true }, (err, addrs: LookupAddress[]) => (err ? fail(err) : ok(addrs.map((a) => a.address))))));
}

/** Whether the endpoint's host resolves, and only to public addresses. */
export async function resolvesPublic(endpoint: string): Promise<boolean> {
  try {
    const addrs = await resolveHost(new URL(endpoint).hostname);
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

type LookupCb = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/** The connection's own lookup: it refuses a private address, whatever DNS answered before. */
export function checkedLookup(host: string, opts: { all?: boolean }, cb: LookupCb): void {
  resolveHost(host)
    .then((addrs) => {
      const ok = addrs.filter((a) => !isPrivateAddress(a));
      if (ok.length === 0 || ok.length !== addrs.length) return cb(new Error('push service address refused'), '', 4);
      if (opts.all) return cb(null, ok.map((x) => ({ address: x, family: isIP(x) })));
      return cb(null, ok[0]!, isIP(ok[0]!));
    })
    .catch((err: Error) => cb(err, '', 4));
}

const agent = new Agent({
  keepAlive: false,
  lookup: checkedLookup as unknown as NonNullable<ConstructorParameters<typeof Agent>[0]>['lookup'],
});


// ---- the keys ------------------------------------------------------------

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  source: 'env' | 'stored';
}

let cachedKeys: VapidKeys | null = null;
/** Tests: forget the cached keys. */
export function forgetVapidKeys(): void {
  cachedKeys = null;
}

/** The site's VAPID keys: from the environment (both set), else stored, else made now and stored. Null without a secret key to store them under. */
export async function vapidKeys(): Promise<VapidKeys | null> {
  if (env.vapidPublicKey && env.vapidPrivateKey) return { publicKey: env.vapidPublicKey, privateKey: env.vapidPrivateKey, source: 'env' };
  if (cachedKeys) return cachedKeys;
  const s = await getPlatformSettings();
  if (s.vapidPublicKey && s.vapidPrivateKey) {
    const priv = readSecret(s.vapidPrivateKey);
    if (priv.state === 'ok') return (cachedKeys = { publicKey: s.vapidPublicKey, privateKey: priv.value, source: 'stored' });
    // The key file changed: make a new pair (browsers sign up again).
  }
  const made = webpush.generateVAPIDKeys();
  const enc = encryptSecret(made.privateKey);
  if (!enc) return null;
  await db.update(schema.platformSettings).set({ vapidPublicKey: made.publicKey, vapidPrivateKey: enc }).where(eq(schema.platformSettings.id, s.id));
  // Browsers signed up with the old key can't be reached with the new one.
  if (s.vapidPublicKey) await db.delete(schema.pushSubscriptions);
  return (cachedKeys = { publicKey: made.publicKey, privateKey: made.privateKey, source: 'stored' });
}

/** Whether push is on for the site: the admin's switch, unless PUSH_ENABLED forces it. */
export async function pushSetting(): Promise<{ value: boolean; setting: boolean; forcedBy: string | null }> {
  const s = await getPlatformSettings();
  return env.pushEnabledForced === null ? { value: s.pushEnabled, setting: s.pushEnabled, forcedBy: null } : { value: env.pushEnabledForced, setting: s.pushEnabled, forcedBy: 'PUSH_ENABLED' };
}

export async function pushAvailable(): Promise<boolean> {
  return (await pushSetting()).value && !!(await vapidKeys());
}

// ---- subscriptions -------------------------------------------------------

export interface SubscriptionInput {
  endpoint: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  name?: unknown;
}

const KEY = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

/** Save a browser's subscription for `userId`. Returns its id, or the reason it was refused. */
export async function saveSubscription(userId: string, input: SubscriptionInput, userAgentName: string): Promise<{ id: string } | { error: string; status: number }> {
  const problem = endpointProblem(input.endpoint);
  if (problem) return { error: problem, status: 400 };
  const endpoint = input.endpoint as string;
  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !KEY.test(p256dh) || !KEY.test(auth)) return { error: 'invalid_keys', status: 400 };
  if (!(await resolvesPublic(endpoint))) return { error: 'unknown_push_service', status: 400 };
  const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : userAgentName).slice(0, 80);
  const now = new Date();
  const p = schema.pushSubscriptions;
  const existing = await db.select().from(p).where(eq(p.endpoint, endpoint)).get();
  if (existing) {
    // The same browser signing up again (or for someone else now: it's theirs now).
    await db.update(p).set({ userId, p256dh, auth, name, lastUsedAt: now }).where(eq(p.id, existing.id));
    return { id: existing.id };
  }
  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(p).values({ id, userId, endpoint, p256dh, auth, name, createdAt: now, lastUsedAt: now }).run();
    const mine = tx.select({ id: p.id }).from(p).where(eq(p.userId, userId)).orderBy(asc(p.createdAt)).all();
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SUBSCRIPTIONS))) tx.delete(p).where(eq(p.id, old.id)).run();
  });
  return { id };
}

// ---- sending -------------------------------------------------------------

export interface PushPayload {
  id: string;
  title: string;
  body: string;
  link: string;
}

export function payloadFor(n: Pick<schema.Notification, 'id' | 'title' | 'body' | 'link'>): PushPayload {
  const body = n.body.length > BODY_MAX ? `${n.body.slice(0, BODY_MAX - 1)}…` : n.body;
  return { id: n.id, title: n.title, body, link: n.link ?? '/notifications' };
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: webpush.RequestOptions) => Promise<{ statusCode: number }>;
let sender: Sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
/** Tests: a fake push service. */
export function setPushSenderForTests(fn: Sender | null): void {
  sender = fn ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
}

function subject(): string {
  if (env.vapidSubject) return env.vapidSubject;
  return env.publicUrl.startsWith('https://') ? env.publicUrl : 'mailto:admin@example.invalid';
}

/** Send one notification to every browser `userId` signed up. Returns how many took it. */
export async function pushTo(userId: string, payload: PushPayload): Promise<number> {
  const keys = await vapidKeys();
  if (!keys || !(await pushSetting()).value) return 0;
  const p = schema.pushSubscriptions;
  const subs = await db.select().from(p).where(eq(p.userId, userId)).all();
  let took = 0;
  for (const s of subs) {
    if (endpointProblem(s.endpoint)) {
      await db.delete(p).where(eq(p.id, s.id));
      continue;
    }
    try {
      const res = await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
        timeout: SEND_TIMEOUT_MS,
        agent,
        TTL: 24 * 3600,
        urgency: 'normal',
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        took++;
        await db.update(p).set({ lastUsedAt: new Date() }).where(eq(p.id, s.id));
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // The browser unsubscribed, or the push service forgot it: it's gone.
        await db.delete(p).where(eq(p.id, s.id));
      } else {
        // Never the keys or the payload: just which service and what it said.
        logError(`[push] couldn't send to ${new URL(s.endpoint).hostname}${status ? ` (${status})` : ''}`, err);
      }
    }
  }
  return took;
}

/** Send the pop-ups that are due (quiet hours over). Returns how many went. */
export async function sendDuePush(now = new Date()): Promise<number> {
  const d = schema.notificationDeliveries;
  const due = await db.select().from(d).where(and(eq(d.state, 'waiting'), eq(d.channel, 'push'), lte(d.dueAt, now))).orderBy(d.dueAt).limit(200).all();
  if (due.length === 0) return 0;
  const on = await pushAvailable();
  let sent = 0;
  for (const job of due) {
    const claimed = db.update(d).set({ state: 'sending' }).where(and(eq(d.id, job.id), eq(d.state, 'waiting'))).run();
    if (claimed.changes === 0) continue;
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.id, job.notificationId)).get();
    // Off for the site, gone, or read or answered meanwhile: nothing to pop up.
    if (!on || !n || n.readAt || n.doneAt) {
      db.update(d).set({ state: 'skipped' }).where(eq(d.id, job.id)).run();
      continue;
    }
    const took = await pushTo(job.userId, payloadFor(n));
    db.update(d).set({ state: took > 0 ? 'sent' : 'failed', sentAt: took > 0 ? new Date() : null }).where(eq(d.id, job.id)).run();
    if (took > 0) sent++;
  }
  return sent;
}
