// Regression tests: layout reads must include realtime edits that have
// not yet been compacted into layouts.doc_snapshot, and there is no
// wholesale snapshot PUT to race the live editor.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { docHub } from '../../ws/docHub.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(layoutRoutes);
  return app;
}

/** An update that sets m.k = value on top of `base`. */
function editOn(base: Uint8Array, value: string): Uint8Array {
  const d = new Y.Doc();
  Y.applyUpdate(d, base);
  const sv = Y.encodeStateVector(d);
  d.getMap('m').set('k', value);
  return Y.encodeStateAsUpdate(d, sv);
}

function readK(bytes: Buffer): unknown {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(bytes));
  return d.getMap('m').get('k');
}

describe('layout reads include unflushed realtime edits', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; id: string };
  let layoutId: string;
  let snapshot: Uint8Array;

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    owner = await loginAs(app, 'o@x.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: owner.cookie },
      payload: { title: 't' },
    });
    layoutId = (res.json() as { id: string }).id;
    const row = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    snapshot = new Uint8Array(row!.docSnapshot as Uint8Array);
  });

  afterEach(async () => {
    await docHub.close(layoutId);
    await app.close();
  });

  async function addPendingUpdate(value: string): Promise<void> {
    await db.insert(schema.layoutUpdates).values({
      layoutId,
      doc: 'main',
      updateBytes: Buffer.from(editOn(snapshot, value)),
      createdAt: new Date(),
    });
  }

  it('GET /snapshot replays layout_updates not yet compacted', async () => {
    await addPendingUpdate('pending');
    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${layoutId}/snapshot`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(readK(res.rawPayload)).toBe('pending');
  });

  it('GET /snapshot reflects the live in-memory doc while a session is open', async () => {
    const session = await docHub.getOrCreate(layoutId);
    Y.applyUpdate(session.doc, editOn(snapshot, 'live'), 'remote');
    // Even if the append-log is empty (e.g. just compacted elsewhere),
    // the live doc is authoritative.
    await new Promise((r) => setTimeout(r, 20));
    await db.delete(schema.layoutUpdates);
    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${layoutId}/snapshot`,
      headers: { cookie: owner.cookie },
    });
    expect(readK(res.rawPayload)).toBe('live');
  });

  it('the public-share snapshot includes pending edits too', async () => {
    await addPendingUpdate('public');
    const share = await app.inject({
      method: 'POST',
      url: `/api/layouts/${layoutId}/public-share`,
      headers: { cookie: owner.cookie },
    });
    const token = (share.json() as { token: string }).token;
    const res = await app.inject({ method: 'GET', url: `/api/public-layouts/${token}/snapshot` });
    expect(res.statusCode).toBe(200);
    expect(readK(res.rawPayload)).toBe('public');
  });

  it('there is no PUT /snapshot: live edits are the only way a layout changes', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${layoutId}/snapshot`,
      headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(editOn(snapshot, 'put')),
    });
    expect(res.statusCode).toBe(404);
    expect(readK(Buffer.from((await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get())!.docSnapshot as Uint8Array))).not.toBe('put');
  });
});
