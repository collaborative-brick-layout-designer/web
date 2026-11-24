// A browser push from end to end through the real sender (web-push): a
// local https server stands in for the push service, and what it gets is
// checked the way a push service and a browser would: the VAPID signature,
// and the payload decrypted with the browser's own keys (RFC 8291,
// aes128gcm). And what happens when it says the browser is gone.

import { execFileSync } from 'node:child_process';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, schema } from '../../test/helpers.js';
import { env } from '../../env.js';
import { forgetVapidKeys, pushTo, setPushAgentForTests, setPushSenderForTests, vapidKeys } from '../../notifications/push.js';

interface Got {
  host: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let server: Server;
let dir: string;
let agent: Agent;
let got: Got[] = [];
let answer = 201;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cld-push-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=fcm.googleapis.com', '-addext', 'subjectAltName=DNS:fcm.googleapis.com', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({ host: req.headers.host, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  agent = new Agent({
    ca: readFileSync(cert),
    lookup: (_h, o, cb) => (o.all ? (cb as (e: null, a: object[]) => void)(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
  });
  (agent as unknown as { defaultPort: number }).defaultPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  setPushAgentForTests(null);
  agent.destroy();
  await new Promise((ok) => server.close(ok));
  rmSync(dir, { recursive: true, force: true });
});

const b64 = (b: Buffer): string => b.toString('base64url');

/** A browser: its keys, and how it reads a message (RFC 8188 and 8291). */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) },
    read(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idLen = body[20]!;
      const serverKey = body.subarray(21, 21 + idLen);
      const sealed = body.subarray(21 + idLen);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), auth, info, 32));
      const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
      const d = createDecipheriv('aes-128-gcm', key, nonce);
      d.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
      return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
    },
  };
}

describe('a push through the real sender', () => {
  let userId: string;
  const PAYLOAD = { id: 'n1', title: 'Harbor crane', body: 'A new version… 🚂', link: '/notifications' };
  const signUp = async (keys: { p256dh: string; auth: string }): Promise<void> => {
    const now = new Date();
    await db.insert(schema.pushSubscriptions).values({ id: randomUUID(), userId, endpoint: 'https://fcm.googleapis.com/fcm/send/abc?x=1', ...keys, name: 'Test', createdAt: now, lastUsedAt: now });
  };
  const left = async (): Promise<number> => (await db.select().from(schema.pushSubscriptions).all()).length;

  beforeEach(async () => {
    resetDb();
    forgetVapidKeys();
    env.pushEnabledForced = true;
    setPushSenderForTests(null);
    setPushAgentForTests(agent);
    got = [];
    answer = 201;
    userId = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: 'ann@example.com', displayName: 'Ann', createdAt: new Date(), updatedAt: new Date() } as typeof schema.users.$inferInsert);
  });

  it('is encrypted for the browser and signed with the site\'s key', async () => {
    const b = browser();
    await signUp(b.keys);
    expect(await pushTo(userId, PAYLOAD)).toBe(1);
    expect(got).toHaveLength(1);
    const { path, headers, body } = got[0]!;
    expect(path).toBe('/fcm/send/abc?x=1');
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.ttl).toBe(String(24 * 3600));
    expect(headers.urgency).toBe('normal');
    expect(body.includes('Harbor')).toBe(false);
    expect(JSON.parse(b.read(body))).toEqual(PAYLOAD);

    // The push service's check: the key is the site's, and it signed the token.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), ?k=(.+)$/.exec(headers.authorization!)!;
    const site = (await vapidKeys())!;
    expect(m[4]).toBe(site.publicKey);
    const raw = Buffer.from(m[4]!, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) } });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toMatch(/^(https:|mailto:)/);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600);
    expect(await left()).toBe(1);
  });

  for (const status of [404, 410]) {
    it(`forgets a browser the push service says is gone (${status})`, async () => {
      await signUp(browser().keys);
      answer = status;
      expect(await pushTo(userId, PAYLOAD)).toBe(0);
      expect(got).toHaveLength(1);
      expect(await left()).toBe(0);
    });
  }

  it('keeps a browser when the push service is busy or redirects, and follows no redirect', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await signUp(browser().keys);
    for (const status of [301, 429, 500]) {
      answer = status;
      expect(await pushTo(userId, PAYLOAD)).toBe(0);
    }
    expect(got).toHaveLength(3);
    expect(await left()).toBe(1);
    log.mockRestore();
  });

  it('does not reach a local address with the agent the server uses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { setResolverForTests } = await import('../../notifications/push.js');
    setPushAgentForTests(null);
    setResolverForTests(async () => ['127.0.0.1']);
    await signUp(browser().keys);
    expect(await pushTo(userId, PAYLOAD)).toBe(0);
    expect(String(log.mock.calls)).toContain('push service address refused');
    setResolverForTests(null);
    log.mockRestore();
  });
});
