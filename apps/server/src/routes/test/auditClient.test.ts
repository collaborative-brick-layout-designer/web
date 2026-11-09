// A refused live update's audit event names the sender's app only roughly,
// and only site admins see it (docs/PRIVACY-DATA.md: no user agents).
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { sqlite } from '../../db/index.js';
import { auditClient } from '../../ws/handler.js';
import { scrubPayload } from '../../privacy/retention.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 BobsLaptop';

let app: FastifyInstance;
let port = 0;
beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => {
  closeAll();
  await app.close();
});

describe('the sender of a refused live update in the audit log', () => {
  it('is a rough name, never the user agent', () => {
    expect(auditClient(UA)).toBe('Chrome on Windows');
    expect(auditClient('CollaborativeBrickLayoutDesigner/2.0.12 (desktop)')).toBe('Desktop app 2.0.12');
    expect(auditClient('')).toBeNull();
  });

  it('is shown to site admins only, and the retention scrub removes it', async () => {
    resetDb();
    const owner = await loginAs(app, 'own@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const admin = await loginAs(app, 'admin@example.com');
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id));
    const made = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title: 'Club show' } });
    const id = (made.json() as { id: string }).id;
    const now = new Date();
    await db.insert(schema.layoutCollaborators).values([
      { layoutId: id, userId: bob.id, role: 'editor', addedAt: now },
      { layoutId: id, userId: carol.id, role: 'viewer', addedAt: now },
      // A site admin who can also open this layout.
      { layoutId: id, userId: admin.id, role: 'viewer', addedAt: now },
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${id}`, { headers: { cookie: bob.cookie, 'user-agent': UA, origin: 'http://localhost:3000' } });
    ws.on('error', () => {});
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise((r) => ws.once('close', r));
    // An update with an empty GC block: the update guard refuses it.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, new Uint8Array([1, 1, 99, 0, 0, 0, 0]));
    ws.send(encoding.toUint8Array(enc));
    await closed;

    let stored: string | undefined;
    for (let i = 0; i < 50 && !stored; i++) {
      const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_update_refused'));
      stored = rows[0]?.payload;
      if (!stored) await new Promise((r) => setTimeout(r, 20));
    }
    expect(stored).toBeDefined();
    expect(stored).not.toContain('BobsLaptop');
    expect(stored).not.toContain('Mozilla');
    expect(JSON.parse(stored!).client).toBe('Chrome on Windows');

    const read = async (who: { cookie: string }) => {
      const res = await app.inject({ method: 'GET', url: `/api/layouts/${id}/audit`, headers: { cookie: who.cookie } });
      expect(res.statusCode).toBe(200);
      const events = (res.json() as { events: Array<{ eventType: string; payload: Record<string, unknown> }> }).events;
      return events.find((e) => e.eventType === 'layout_update_refused')!.payload;
    };
    expect(await read(carol)).not.toHaveProperty('client');
    expect(await read(owner)).not.toHaveProperty('client');
    expect((await read(admin)).client).toBe('Chrome on Windows');

    expect(JSON.parse(scrubPayload(stored!)!)).not.toHaveProperty('client');
  });

  it('is removed from events stored before by migration 0043, and nothing else changes', async () => {
    resetDb();
    const owner = await loginAs(app, 'own@example.com');
    const made = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title: 'Club show' } });
    const layoutId = (made.json() as { id: string }).id;
    const old = { client: UA, via: 'session', updateBytes: 7, kind: 'update', why: 'empty_gc' };
    const other = { client: 'not a user agent', title: 'Club show' };
    await db.insert(schema.auditEvents).values([
      { layoutId, userId: owner.id, eventType: 'layout_update_refused', payload: JSON.stringify(old), createdAt: new Date() },
      { layoutId, userId: owner.id, eventType: 'layout_merge_refused', payload: JSON.stringify({ ...old, foreignLayers: 2 }), createdAt: new Date() },
      { layoutId, userId: owner.id, eventType: 'rename', payload: JSON.stringify(other), createdAt: new Date() },
    ]);
    sqlite.exec(readFileSync(new URL('../../../migrations/0043_scrub_audit_client.sql', import.meta.url), 'utf8'));
    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.layoutId, layoutId));
    const byType = new Map(rows.map((r) => [r.eventType, JSON.parse(r.payload) as Record<string, unknown>]));
    expect(byType.get('layout_update_refused')).toEqual({ via: 'session', updateBytes: 7, kind: 'update', why: 'empty_gc' });
    expect(byType.get('layout_merge_refused')).toEqual({ via: 'session', updateBytes: 7, kind: 'update', why: 'empty_gc', foreignLayers: 2 });
    expect(byType.get('rename')).toEqual(other);
  });
});
