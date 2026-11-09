// Access changes reach open live connections at once, through the routes
// that make them (not at the next periodic check, which these tests leave
// at its 30 s default):
//   - a person suspended by an admin is held to viewer, and let back;
//   - a club suspended: its layouts are held to viewer;
//   - a collaborator downgraded to viewer is held to viewer; one removed
//     is disconnected;
//   - a club member removed from the club is disconnected from its layouts.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { collaboratorRoutes } from '../collaborators.js';
import { orgRoutes } from '../orgs.js';
import { adminLimitsRoutes } from '../adminLimits.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { wsTiming } from '../../ws/handler.js';
import { invalidateLimitCaches } from '../../limits/limits.js';
import { env } from '../../env.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  ws: WebSocket;
  closed: Promise<[number, string]>;
}

function connect(port: number, layoutId: string, cookieStr: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, { headers: { cookie: cookieStr } });
  ws.on('error', () => {});
  const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
  return new Promise((res, rej) => {
    ws.once('open', () => res({ ws, closed }));
    ws.once('error', rej);
  });
}

function edit(key: string, value: string): Uint8Array {
  const d = new Y.Doc();
  d.getMap('meta').set(key, value);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(d));
  return encoding.toUint8Array(enc);
}

describe('WS live access changes', () => {
  let app: FastifyInstance;
  let port: number;
  let owner: { cookie: string; id: string };
  let admin: { cookie: string; id: string };
  const opened: string[] = [];
  const open: Client[] = [];

  beforeEach(async () => {
    resetDb();
    invalidateLimitCaches();
    expect(wsTiming.revalidateMs).toBe(30_000);
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    for (const r of [passwordRoutes, layoutRoutes, collaboratorRoutes, orgRoutes, adminLimitsRoutes, wsRoutes]) await app.register(r);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    owner = await loginAs(app, 'owner@x.com');
    admin = await loginAs(app, 'admin@x.com');
    db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
  });

  afterEach(async () => {
    for (const c of open.splice(0)) c.ws.terminate();
    await sleep(50);
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function layout(payload: Record<string, unknown> = { title: 't' }, cookieStr = owner.cookie): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    opened.push(id);
    return id;
  }

  async function client(layoutId: string, cookieStr: string): Promise<Client> {
    const c = await connect(port, layoutId, cookieStr);
    open.push(c);
    await sleep(80);
    return c;
  }

  const meta = (id: string) => docHub.peek(id)!.doc.getMap('meta');

  async function share(layoutId: string, email: string, role: 'viewer' | 'editor') {
    const u = await loginAs(app, email);
    await db.insert(schema.layoutCollaborators).values({ layoutId, userId: u.id, role, addedAt: new Date() });
    return u;
  }

  it('a person suspended while editing is held to viewer at once, and edits again when let back', async () => {
    const id = await layout();
    const c = await client(id, owner.cookie);
    const put = (suspended: boolean) =>
      app.inject({ method: 'PUT', url: `/api/admin/users/${owner.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended } });
    expect((await put(true)).statusCode).toBe(200);
    c.ws.send(edit('while', 'suspended'));
    await sleep(150);
    expect(meta(id).get('while')).toBeUndefined();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect((await put(false)).statusCode).toBe(200);
    c.ws.send(edit('after', 'lifted'));
    await sleep(150);
    expect(meta(id).get('after')).toBe('lifted');
  });

  it('holds a suspended person to viewer even while usage limits are off', async () => {
    env.limitsEnforceForced = 'off';
    try {
      const id = await layout();
      const c = await client(id, owner.cookie);
      expect((await app.inject({ method: 'PUT', url: `/api/admin/users/${owner.id}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true } })).statusCode).toBe(200);
      c.ws.send(edit('off', 'suspended'));
      await sleep(150);
      expect(meta(id).get('off')).toBeUndefined();
      // A new connection is held to viewer from the start too.
      const c2 = await client(id, owner.cookie);
      c2.ws.send(edit('fresh', 'suspended'));
      await sleep(150);
      expect(meta(id).get('fresh')).toBeUndefined();
    } finally {
      env.limitsEnforceForced = null;
    }
  });

  it('the periodic check sees a suspension written without a route too', async () => {
    const id = await layout();
    wsTiming.revalidateMs = 50;
    try {
      const c = await client(id, owner.cookie);
      db.insert(schema.limitOverrides).values({ subjectKind: 'user', subjectId: owner.id, suspended: true, updatedAt: new Date() }).run();
      invalidateLimitCaches();
      await sleep(200);
      c.ws.send(edit('while', 'suspended'));
      await sleep(150);
      expect(meta(id).get('while')).toBeUndefined();
    } finally {
      wsTiming.revalidateMs = 30_000;
    }
  });

  it("a club suspended while its layout is open holds that layout to viewer", async () => {
    const club = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: owner.cookie }, payload: { name: 'Harbour Club' } });
    expect(club.statusCode).toBe(201);
    const { id: orgId, slug } = club.json() as { id: string; slug: string };
    const id = await layout({ title: 'club', orgSlug: slug });
    const c = await client(id, owner.cookie);
    expect((await app.inject({ method: 'PUT', url: `/api/admin/orgs/${orgId}/limits`, headers: { cookie: admin.cookie }, payload: { suspended: true } })).statusCode).toBe(200);
    c.ws.send(edit('club', 'suspended'));
    await sleep(150);
    expect(meta(id).get('club')).toBeUndefined();
  });

  it('a collaborator downgraded to viewer is held to viewer at once; removed, disconnected', async () => {
    const id = await layout();
    const ed = await share(id, 'editor@x.com', 'editor');
    const c = await client(id, ed.cookie);
    c.ws.send(edit('before', 'yes'));
    await sleep(100);
    expect(meta(id).get('before')).toBe('yes');
    const patch = await app.inject({ method: 'PATCH', url: `/api/layouts/${id}/collaborators/${ed.id}`, headers: { cookie: owner.cookie }, payload: { role: 'viewer' } });
    expect(patch.statusCode).toBe(200);
    c.ws.send(edit('after', 'downgrade'));
    await sleep(150);
    expect(meta(id).get('after')).toBeUndefined();
    const del = await app.inject({ method: 'DELETE', url: `/api/layouts/${id}/collaborators/${ed.id}`, headers: { cookie: owner.cookie } });
    expect(del.statusCode).toBe(200);
    expect(await Promise.race([c.closed, sleep(1000).then(() => 'still open')])).toEqual([4404, 'access_revoked']);
  });

  it("a member removed from a club is disconnected from the club's layout at once", async () => {
    const club = await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: owner.cookie }, payload: { name: 'Yard Club' } });
    const { id: orgId, slug } = club.json() as { id: string; slug: string };
    const id = await layout({ title: 'club', orgSlug: slug });
    const member = await loginAs(app, 'member@x.com');
    await db.insert(schema.orgMembers).values({ orgId, userId: member.id, role: 'member', joinedAt: new Date() });
    const c = await client(id, member.cookie);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    const del = await app.inject({ method: 'DELETE', url: `/api/orgs/${slug}/members/${member.id}`, headers: { cookie: owner.cookie } });
    expect(del.statusCode).toBe(200);
    expect(await Promise.race([c.closed, sleep(1000).then(() => 'still open')])).toEqual([4404, 'access_revoked']);
  });
});
