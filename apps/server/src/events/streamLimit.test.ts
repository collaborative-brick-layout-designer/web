// Opening the live stream (and the page-load beacon) is limited per person, not per address: club
// members on one show Wi-Fi share an address, and one busy phone must not
// cut everyone else's live updates.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loginAs, resetDb } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { eventRoutes } from '../routes/events.js';
import { adminInsightsRoutes } from '../routes/adminInsights.js';
import { passwordRoutes } from '../routes/auth/password.js';
import { closeAll } from './hub.js';

let app: FastifyInstance;
let port: number;

beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(eventRoutes);
  await app.register(adminInsightsRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  closeAll();
  await app.close();
});

/** Open the stream, note the status, and hang up. */
function openOnce(cookieHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie: cookieHeader } }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', (e) => (req.destroyed ? undefined : reject(e)));
  });
}

it('one person using up their opens leaves the others on the same address alone', async () => {
  const a = await loginAs(app, 'a@example.com');
  const b = await loginAs(app, 'b@example.com');
  for (let i = 0; i < 60; i++) expect(await openOnce(a.cookie)).toBe(200);
  expect(await openOnce(a.cookie)).toBe(429);
  expect(await openOnce(b.cookie)).toBe(200);
});

it("the page-load beacon is counted per person too", async () => {
  const a = await loginAs(app, 'a@example.com');
  const b = await loginAs(app, 'b@example.com');
  const beacon = (cookie: string) => app.inject({ method: 'POST', url: '/api/metrics/client', headers: { cookie }, payload: { display: 'browser' } });
  for (let i = 0; i < 60; i++) expect((await beacon(a.cookie)).statusCode).toBe(204);
  expect((await beacon(a.cookie)).statusCode).toBe(429);
  expect((await beacon(b.cookie)).statusCode).toBe(204);
});
