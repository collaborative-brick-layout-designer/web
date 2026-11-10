// GET /api/events: who gets which live hint, and the stream's upkeep
// (sign-in, heartbeat, the per-person cap, cleanup on disconnect). Also
// checks that every changing route is in the hint table.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, issueToken, loginAs, resetDb, schema } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { registerApiRoutes } from '../routes/all.js';
import { NO_HINT, ROUTE_HINTS, registerChangeHints, routeKey } from './routeHints.js';
import { MAX_CONNECTIONS_PER_USER, closeAll, connectionCount, heartbeatAll } from './hub.js';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';

async function buildApp(collect?: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  registerChangeHints(app);
  if (collect) {
    app.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') collect.push(routeKey(m, r.url));
      }
    });
  }
  await registerApiRoutes(app);
  return app;
}

interface Stream {
  status: number;
  type: string;
  text: () => string;
  hints: () => Array<Record<string, unknown>>;
  close: () => void;
  closed: () => boolean;
}

function openStream(port: number, headers: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let ended = false;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      const s: Stream = {
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        text: () => buf,
        hints: () => buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>),
        close: () => req.destroy(),
        closed: () => ended,
      };
      // Wait for the greeting (or the error body) before handing it over.
      const ready = () => (buf.includes(': connected') || s.status !== 200 ? resolve(s) : setTimeout(ready, 5));
      ready();
    });
    req.on('error', (e) => (ended ? undefined : reject(e)));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 150));

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('every changing route sends a live hint (or says why not)', () => {
  it('ROUTE_HINTS and NO_HINT cover exactly the POST/PUT/PATCH/DELETE routes', async () => {
    const routes: string[] = [];
    const app = await buildApp(routes);
    await app.ready();
    await app.close();
    const covered = new Set([...Object.keys(ROUTE_HINTS), ...Object.keys(NO_HINT)]);
    expect(routes.filter((r) => !covered.has(r))).toEqual([]);
    // No stale entries for routes that no longer exist.
    expect([...covered].filter((r) => !routes.includes(r))).toEqual([]);
    expect(Object.keys(ROUTE_HINTS).filter((k) => k in NO_HINT)).toEqual([]);
  });
});

describe('GET /api/events', () => {
  let app: FastifyInstance;
  let port: number;
  let a: { cookie: string; id: string };
  let b: { cookie: string; id: string };
  let outsider: { cookie: string; id: string };
  let orgId: string;
  let slug: string;
  const open: Stream[] = [];
  const stream = async (headers: Record<string, string>) => {
    const s = await openStream(port, headers);
    open.push(s);
    return s;
  };

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    a = await loginAs(app, 'a@example.com');
    b = await loginAs(app, 'b@example.com');
    outsider = await loginAs(app, 'c@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: a.cookie }, payload: { name: 'Train Club' } });
    ({ id: orgId, slug } = res.json() as { id: string; slug: string });
    await db.insert(schema.orgMembers).values({ orgId, userId: b.id, role: 'member', joinedAt: new Date() });
  });

  afterEach(async () => {
    for (const s of open.splice(0)) s.close();
    closeAll();
    await app.close();
  });

  it('needs a signed-in user', async () => {
    const s = await stream({});
    expect(s.status).toBe(401);
  });

  it('is an event stream that says hello', async () => {
    const s = await stream({ cookie: a.cookie });
    expect(s.status).toBe(200);
    expect(s.type).toMatch(/^text\/event-stream/);
    expect(s.text()).toContain('retry: 5000');
    expect(connectionCount(a.id)).toBe(1);
  });

  it('a club module reaches every member, and nobody outside the club', async () => {
    const sb = await stream({ cookie: b.cookie });
    const sc = await stream({ cookie: outsider.cookie });
    const res = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: a.cookie }, payload: { title: 'Station', orgSlug: slug } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    await until(() => sb.hints().length > 0);
    expect(sb.hints()).toEqual([{ kind: 'module', owner: { kind: 'org', id: orgId }, id, action: 'create' }]);
    await settle();
    expect(sc.hints()).toEqual([]);
  });

  it('a personal layout reaches its owner only, until it is shared', async () => {
    const sa = await stream({ cookie: a.cookie });
    const sb = await stream({ cookie: b.cookie });
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: a.cookie }, payload: { title: 'Mine' } });
    const id = (res.json() as { id: string }).id;
    await until(() => sa.hints().length > 0);
    expect(sa.hints()[0]).toMatchObject({ kind: 'layout', owner: { kind: 'user', id: a.id }, id });
    await settle();
    expect(sb.hints()).toEqual([]);
    // Shared with b: b now hears about its changes.
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: b.id, role: 'viewer', addedAt: new Date() });
    await app.inject({ method: 'PATCH', url: `/api/layouts/${id}`, headers: { cookie: a.cookie }, payload: { title: 'Renamed' } });
    await until(() => sb.hints().length > 0);
    expect(sb.hints()[0]).toMatchObject({ kind: 'layout', id, action: 'update' });
    // Removed again: b hears that one last change (so it drops off b's list), then nothing.
    await app.inject({ method: 'DELETE', url: `/api/layouts/${id}/collaborators/${b.id}`, headers: { cookie: a.cookie } });
    await until(() => sb.hints().length > 1);
    expect(sb.hints()).toHaveLength(2);
    await app.inject({ method: 'PATCH', url: `/api/layouts/${id}`, headers: { cookie: a.cookie }, payload: { title: 'Private again' } });
    await settle();
    expect(sb.hints()).toHaveLength(2);
  });

  it('two saves of a module close together are two hints, so an open tab hears the second', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: a.cookie }, payload: { title: 'Siding' } });
    const id = (res.json() as { id: string }).id;
    const sa = await stream({ cookie: a.cookie });
    const save = () =>
      app.inject({ method: 'PUT', url: `/api/modules/${id}/snapshot`, headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from(encodeDoc(createDefaultLayoutDoc())) });
    // Well inside the stream's squash window (the same hint twice is sent once).
    expect((await save()).statusCode).toBe(200);
    expect((await save()).statusCode).toBe(200);
    await until(() => sa.hints().filter((h) => h.action === 'update:snapshot').length >= 2);
    const saves = sa.hints().filter((h) => h.action === 'update:snapshot');
    expect(saves).toHaveLength(2);
    expect(saves.map((h) => h.v)).toEqual([1, 2]);
    expect(saves[0]).toMatchObject({ kind: 'module', id, owner: { kind: 'user', id: a.id } });
  });

  it('a refused change sends nothing', async () => {
    const res0 = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: a.cookie }, payload: { title: 'Mine' } });
    const id = (res0.json() as { id: string }).id;
    const sa = await stream({ cookie: a.cookie });
    // Someone else tries to rename a's layout: refused, and a hears nothing.
    const res = await app.inject({ method: 'PATCH', url: `/api/layouts/${id}`, headers: { cookie: outsider.cookie }, payload: { title: 'x' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await settle();
    expect(sa.hints()).toEqual([]);
  });

  it('deleting a shared layout tells the people it was shared with', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: a.cookie }, payload: { title: 'Shared' } });
    const id = (res.json() as { id: string }).id;
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: b.id, role: 'viewer', addedAt: new Date() });
    const sb = await stream({ cookie: b.cookie });
    expect((await app.inject({ method: 'DELETE', url: `/api/layouts/${id}`, headers: { cookie: a.cookie } })).statusCode).toBeLessThan(300);
    await until(() => sb.hints().length > 0);
    expect(sb.hints()[0]).toMatchObject({ kind: 'layout', id, action: 'delete' });
  });

  it('deleting a club tells its members', async () => {
    const sb = await stream({ cookie: b.cookie });
    const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${slug}`, headers: { cookie: a.cookie }, payload: { confirm: 'Train Club' } });
    expect(res.statusCode).toBeLessThan(300);
    // The club drops off their screens (a notice about it arrives too).
    await until(() => sb.hints().some((h) => h.kind === 'club'));
    expect(sb.hints().find((h) => h.kind === 'club')).toMatchObject({ kind: 'club', id: orgId, action: 'delete' });
  });

  it('a member removed from a club hears it; the club then goes quiet for them', async () => {
    const sb = await stream({ cookie: b.cookie });
    const sc = await stream({ cookie: outsider.cookie });
    const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${slug}/members/${b.id}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBeLessThan(300);
    await until(() => sb.hints().length > 0);
    expect(sb.hints()[0]).toMatchObject({ kind: 'club', owner: { kind: 'org', id: orgId } });
    await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: a.cookie }, payload: { title: 'After', orgSlug: slug } });
    await settle();
    expect(sb.hints()).toHaveLength(1);
    expect(sc.hints()).toEqual([]);
  });

  it('opens with a desktop API token too', async () => {
    const token = await issueToken(app, a.cookie, 'venues:read');
    const s = await stream({ authorization: `Bearer ${token}` });
    expect(s.status).toBe(200);
    await app.inject({ method: 'POST', url: '/api/venues', headers: { cookie: a.cookie }, payload: { name: 'Hall', data: { width: 10, depth: 10 } } });
    await until(() => s.hints().some((h) => h.kind === 'venue'));
    expect(s.hints().some((h) => h.kind === 'venue')).toBe(true);
  });

  it('sends a heartbeat comment', async () => {
    const s = await stream({ cookie: a.cookie });
    heartbeatAll();
    await until(() => s.text().includes(': ping'));
    expect(s.text()).toContain(': ping\n\n');
  });

  it(`keeps at most ${MAX_CONNECTIONS_PER_USER} streams per person, closing the oldest`, async () => {
    const first = await stream({ cookie: a.cookie });
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) await stream({ cookie: a.cookie });
    expect(connectionCount(a.id)).toBe(MAX_CONNECTIONS_PER_USER);
    await until(() => first.closed());
    expect(first.closed()).toBe(true);
  });

  it('forgets a stream when the client goes away', async () => {
    const s = await stream({ cookie: a.cookie });
    expect(connectionCount(a.id)).toBe(1);
    s.close();
    await until(() => connectionCount(a.id) === 0);
    expect(connectionCount(a.id)).toBe(0);
  });
});
