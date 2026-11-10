// Regression tests for the metadata-only list queries, the parsed
// custom-part XML cache, and the per-layout daily compaction.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { orgRoutes } from '../orgs.js';
import { customPartRoutes } from '../customParts.js';
import { partsRoutes, invalidatePartsCache } from '../parts.js';
import { dailyCompaction } from '../../workers/index.js';
import { docHub } from '../../ws/docHub.js';

const parseSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@cld/parts-catalog', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@cld/parts-catalog')>();
  return {
    ...mod,
    parsePartXml: (...args: Parameters<typeof mod.parsePartXml>) => {
      parseSpy.calls++;
      return mod.parsePartXml(...args);
    },
  };
});

const SAMPLE_XML = Buffer.from('<?xml version="1.0"?><part><Author>T</Author></part>').toString('base64');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(layoutRoutes);
  await app.register(orgRoutes);
  await app.register(customPartRoutes);
  await app.register(partsRoutes);
  return app;
}

describe('list endpoints (metadata-only selects)', () => {
  beforeEach(() => {
    resetDb();
    invalidatePartsCache();
  });

  it('GET /api/layouts and /api/orgs/:slug/layouts still report hasSidecar correctly', async () => {
    const app = await buildApp();
    const u = await loginAs(app, 'u@x.com');
    const h = { cookie: u.cookie };
    await app.inject({ method: 'POST', url: '/api/orgs', headers: h, payload: { name: 'Org' } });
    const plain = (await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: { title: 'plain' } })).json().id;
    const withSidecar = (
      await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: { title: 'org', orgSlug: 'org' } })
    ).json().id;
    await db
      .update(schema.layouts)
      .set({ sidecarSnapshot: Buffer.from([0, 0]) })
      .where(eq(schema.layouts.id, withSidecar));

    const list = (await app.inject({ method: 'GET', url: '/api/layouts', headers: h })).json().layouts as Array<{
      id: string;
      hasSidecar: boolean;
      title: string;
    }>;
    expect(list.find((l) => l.id === plain)).toMatchObject({ hasSidecar: false, title: 'plain' });
    expect(list.find((l) => l.id === withSidecar)).toMatchObject({ hasSidecar: true, title: 'org' });

    const orgList = (await app.inject({ method: 'GET', url: '/api/orgs/org/layouts', headers: h })).json().layouts;
    expect(orgList).toHaveLength(1);
    expect(orgList[0]).toMatchObject({ id: withSidecar, hasSidecar: true });

    const one = (await app.inject({ method: 'GET', url: `/api/layouts/${withSidecar}`, headers: h })).json();
    expect(one.layout.hasSidecar).toBe(true);
    await app.close();
  });

  it('parses each custom part XML once across catalog requests (cache keyed by id + updatedAt)', async () => {
    const app = await buildApp();
    const u = await loginAs(app, 'p@x.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/custom-parts',
      headers: { cookie: u.cookie },
      payload: { partNumber: 'C1', displayName: 'C1', xmlBase64: SAMPLE_XML, spriteBase64: 'R0lGODlh', spriteMime: 'image/gif' },
    });
    expect(created.statusCode).toBe(201);

    parseSpy.calls = 0;
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/parts/catalog', headers: { cookie: u.cookie } });
      expect(res.statusCode).toBe(200);
      const parts = res.json().parts as Array<{ customPartId: string | null }>;
      expect(parts.some((p) => p.customPartId === created.json().id)).toBe(true);
    }
    expect(parseSpy.calls).toBe(1);

    const mine = (await app.inject({ method: 'GET', url: '/api/custom-parts', headers: { cookie: u.cookie } })).json().parts;
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toHaveProperty('xmlBlob');
    await app.close();
  });
});

describe('dailyCompaction', () => {
  beforeEach(() => resetDb());

  it('compacts layouts with pending updates and skips ones with a live session', async () => {
    const app = await buildApp();
    const u = await loginAs(app, 'c@x.com');
    const h = { cookie: u.cookie };
    const idle = (await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: {} })).json().id as string;
    const live = (await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: {} })).json().id as string;

    const d = new Y.Doc();
    d.getMap('m').set('k', 'v');
    const upd = Buffer.from(Y.encodeStateAsUpdate(d));
    for (const layoutId of [idle, live]) {
      await db.insert(schema.layoutUpdates).values({ layoutId, doc: 'main', updateBytes: upd, createdAt: new Date() });
    }
    await docHub.getOrCreate(live);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dailyCompaction();
    } finally {
      log.mockRestore();
    }

    const left = await db.select().from(schema.layoutUpdates);
    expect(left.map((r) => r.layoutId)).toEqual([live]);
    const row = await db.select().from(schema.layouts).where(eq(schema.layouts.id, idle)).get();
    const snap = new Y.Doc();
    Y.applyUpdate(snap, row!.docSnapshot as Uint8Array);
    expect(snap.getMap('m').get('k')).toBe('v');
    await docHub.close(live);
    await app.close();
  });

  it('one layout whose saved copy can\'t be read is skipped and reported; the others are still compacted', async () => {
    const app = await buildApp();
    const u = await loginAs(app, 'c2@x.com');
    const h = { cookie: u.cookie };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await app.inject({ method: 'POST', url: '/api/layouts', headers: h, payload: {} })).json().id as string);
    const d = new Y.Doc();
    d.getMap('m').set('k', 'v');
    const upd = Buffer.from(Y.encodeStateAsUpdate(d));
    for (const layoutId of ids) await db.insert(schema.layoutUpdates).values({ layoutId, doc: 'main', updateBytes: upd, createdAt: new Date() });
    const bad = ids[1]!;
    await db.update(schema.layouts).set({ docSnapshot: Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x03]) }).where(eq(schema.layouts.id, bad));
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    try {
      await dailyCompaction();
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    const left = await db.select().from(schema.layoutUpdates);
    expect(left.map((r) => r.layoutId)).toEqual([bad]);
    const { compactionSkipped } = await import('../../workers/compactionReport.js');
    expect(compactionSkipped()).toEqual([bad]);
    await app.close();
  });
});
