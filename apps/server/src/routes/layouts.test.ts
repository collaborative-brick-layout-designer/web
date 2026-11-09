import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, resetDb, schema, testVerificationToken } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { passwordRoutes } from './auth/password.js';
import { sessionRoutes } from './auth/session.js';
import { layoutRoutes } from './layouts.js';

// Path to the vendored sample `.bbm` files inside packages/bbm. Tests
// import the same fixtures the bbm package's round-trip tests do.
const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/bbm/tests/fixtures',
);
const FORDYCE_BBM = readFileSync(resolve(FIXTURES, 'fordyce-2026.bbm'), 'utf-8');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  return app;
}

async function registerAndLogin(
  app: FastifyInstance,
  email: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/password/register',
    payload: { email, password: 'correct horse battery', displayName: email },
  });
  expect(res.statusCode).toBe(200);
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const verification = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.userId, user!.id))
    .get();
  const verifyRes = await app.inject({
    method: 'POST',
    url: `/api/auth/password/verify-email/${await testVerificationToken(verification!)}`,
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
}

describe('layout routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects unauthenticated /api/layouts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts' });
    expect(res.statusCode).toBe(401);
  });

  it('creates an empty layout, lists it, gets it', async () => {
    const cookieStr = await registerAndLogin(app, 'alice@example.com');

    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'My First Layout' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; title: string };
    expect(created.title).toBe('My First Layout');

    const list = await app.inject({
      method: 'GET',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
    });
    const listBody = list.json() as { layouts: { id: string; title: string }[] };
    expect(listBody.layouts).toHaveLength(1);
    expect(listBody.layouts[0]?.title).toBe('My First Layout');

    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${created.id}`,
      headers: { cookie: cookieStr },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { role: string }).role).toBe('owner');
  });

  it('creates a layout from a real .bbm fixture and exports it back', async () => {
    const cookieStr = await registerAndLogin(app, 'bob@example.com');
    const bbm = readFileSync(resolve(FIXTURES, 'tight-corner.bbm'), 'utf8');

    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Tight Corner', bbm },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { id: string }).id;

    const exp = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie: cookieStr },
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toContain('application/xml');
    expect(exp.headers['content-disposition']).toContain('Tight Corner.bbm');

    // Round-trip: the exported XML must parse back into the same model.
    const exported = exp.body;
    const { readBbm } = await import('@cld/bbm');
    const reparsed = readBbm(exported);
    const original = readBbm(bbm);
    expect(reparsed.map).toEqual(original.map);
  });

  it('downloads a layout as one .bld-layout file (desktop "Download a copy")', async () => {
    const cookieStr = await registerAndLogin(app, 'dora@example.com');
    const bbm = readFileSync(resolve(FIXTURES, 'tight-corner.bbm'), 'utf8');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Tight Corner', bbm },
    });
    const id = (create.json() as { id: string }).id;
    const exp = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bld-layout`, headers: { cookie: cookieStr } });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toContain('application/zip');
    expect(exp.headers['content-disposition']).toContain('Tight Corner.bld-layout');
    const body = exp.rawPayload;
    // A zip whose entries are the manifest (with where it came from) and the map.
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const text = body.toString('latin1');
    expect(text).toContain('manifest.json');
    expect(text).toContain('layout.bbm');
    expect(text).toContain(`"layoutId":"${id}"`);

    // Someone else can't, and isn't told it exists.
    const other = await registerAndLogin(app, 'eve@example.com');
    const refused = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bld-layout`, headers: { cookie: other } });
    expect(refused.statusCode).toBe(404);
  });

  it('names an untitled layout after the .bbm event, but not BlueBrick\'s "Unknown Event"', async () => {
    const cookieStr = await registerAndLogin(app, 'nina@example.com');
    const fordyce = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload: { bbm: FORDYCE_BBM } });
    expect((fordyce.json() as { title: string }).title).toBe('Fordyce 2026');
    const unnamed = readFileSync(resolve(FIXTURES, 'tight-corner.bbm'), 'utf8');
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload: { bbm: unnamed } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { title: string }).title).not.toBe('Unknown Event');
  });

  it('rejects garbage .bbm payloads with 400', async () => {
    const cookieStr = await registerAndLogin(app, 'carol@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'broken', bbm: '<not-a-bbm/>' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('bbm_parse_failed');
  });

  it('renames a layout (PATCH)', async () => {
    const cookieStr = await registerAndLogin(app, 'dave@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Old Name' },
    });
    const id = (create.json() as { id: string }).id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
      payload: { title: 'New Name' },
    });
    expect(patch.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
    });
    expect((get.json() as { layout: { title: string } }).layout.title).toBe('New Name');
  });

  it('rejects empty rename payloads', async () => {
    const cookieStr = await registerAndLogin(app, 'evie@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Layout' },
    });
    const id = (create.json() as { id: string }).id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
      payload: { title: '   ' },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('deletes a layout (DELETE)', async () => {
    const cookieStr = await registerAndLogin(app, 'frank@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Delete me' },
    });
    const id = (create.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
    });
    expect(del.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
    });
    expect(get.statusCode).toBe(404);
  });

  it('does not leak existence: another user gets 404, not 403', async () => {
    // Security invariant: a non-collaborator must not learn that a layout
    // exists. Both `not_found` (no row) and `unauthorized` (row but no
    // role) MUST return 404 with the same body. A 403 here would leak
    // existence to an attacker probing IDs.
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: aliceCookie },
      payload: { title: "Alice's Layout" },
    });
    const id = (create.json() as { id: string }).id;

    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: bobCookie },
    });
    expect(get.statusCode).toBe(404);
  });

  it('GET /snapshot returns the binary doc and the doc-version header', async () => {
    const cookieStr = await registerAndLogin(app, 'snapshot@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'snap' },
    });
    const id = (create.json() as { id: string }).id;

    const snap = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr },
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers['content-type']).toBe('application/octet-stream');
    expect(snap.headers['x-doc-version']).toBe('0');
    expect(snap.rawPayload.length).toBeGreaterThan(0);
  });

  it('PUT /snapshot stores new bytes and bumps doc-version', async () => {
    const cookieStr = await registerAndLogin(app, 'snap2@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'snap2' },
    });
    const id = (create.json() as { id: string }).id;

    const initial = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr },
    });
    const initialBytes = initial.rawPayload;

    // Build a fresh y-doc with a small mutation, then PUT its bytes.
    const Y = await import('yjs');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(initialBytes));
    doc.getMap('meta').set('event', 'edited via test');
    const updated = Y.encodeStateAsUpdate(doc);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(updated),
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr },
    });
    expect(after.headers['x-doc-version']).toBe('1');

    const reread = new Y.Doc();
    Y.applyUpdate(reread, new Uint8Array(after.rawPayload));
    expect(reread.getMap('meta').get('event')).toBe('edited via test');
  });

  it('PUT /snapshot rejects empty bodies', async () => {
    const cookieStr = await registerAndLogin(app, 'snap3@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'snap3' },
    });
    const id = (create.json() as { id: string }).id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([]),
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /snapshot rejects non-editor users with 403', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice-snap@example.com');
    const bobCookie = await registerAndLogin(app, 'bob-snap@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: aliceCookie },
      payload: { title: 'alice' },
    });
    const id = (create.json() as { id: string }).id;

    // Bob is not a collaborator → returns 404 (existence-leak protection).
    const noShare = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: bobCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    });
    expect(noShare.statusCode).toBe(404);

    // Now grant Bob viewer; PUT should be 403 (not 404 — he knows the layout exists).
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob-snap@example.com')).get();
    await db.insert(schema.layoutCollaborators).values({
      layoutId: id,
      userId: bob!.id,
      role: 'viewer',
      addedAt: new Date(),
    });

    const viewerPut = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: bobCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    });
    expect(viewerPut.statusCode).toBe(403);
  });

  it('a viewer collaborator can read but cannot delete', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: aliceCookie },
      payload: { title: "Alice's Layout" },
    });
    const id = (create.json() as { id: string }).id;

    // Manually grant Bob the 'viewer' role (no share API yet — Phase 5).
    const bob = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'bob@example.com'))
      .get();
    expect(bob).toBeDefined();
    await db.insert(schema.layoutCollaborators).values({
      layoutId: id,
      userId: bob!.id,
      role: 'viewer',
      addedAt: new Date(),
    });

    // Bob can GET.
    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}`,
      headers: { cookie: bobCookie },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { role: string }).role).toBe('viewer');

    // Bob cannot DELETE.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}`,
      headers: { cookie: bobCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('shared layout appears in GET /api/layouts for a non-owner collaborator', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: aliceCookie },
      payload: { title: 'Shared Layout' },
    });
    const { id } = create.json() as { id: string };
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: bob!.id, role: 'viewer', addedAt: new Date() });

    const list = await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie: bobCookie } });
    expect(list.statusCode).toBe(200);
    const layouts = (list.json() as { layouts: { id: string }[] }).layouts;
    expect(layouts.some((l) => l.id === id)).toBe(true);
  });

  it('list deduplicates when user is both owner and collaborator on same layout', async () => {
    const cookieStr = await registerAndLogin(app, 'dedup@example.com');
    const owner = await db.select().from(schema.users).where(eq(schema.users.email, 'dedup@example.com')).get();
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Dedup Layout' },
    });
    const { id } = create.json() as { id: string };

    // Also add the owner as a collaborator on their own layout.
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: owner!.id, role: 'editor', addedAt: new Date() });

    const list = await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie: cookieStr } });
    const layouts = (list.json() as { layouts: { id: string }[] }).layouts;
    const ids = layouts.map((l) => l.id);
    expect(ids.filter((i) => i === id).length).toBe(1);

    // Also call single-get to exercise resolveResourceRole with owner+collaborator rows for the same user.
    const single = await app.inject({ method: 'GET', url: `/api/layouts/${id}`, headers: { cookie: cookieStr } });
    expect(single.statusCode).toBe(200);
    expect((single.json() as { role: string }).role).toBe('owner');
  });

  it('POST returns 400 when sidecar JSON is invalid', async () => {
    const cookieStr = await registerAndLogin(app, 'sidecarfail@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Bad Sidecar', bbm: FORDYCE_BBM, sidecar: 'not-valid-json{{' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('sidecar_parse_failed');
  });

  it('GET /export.bbm returns 400 for in-app layout with no BbmMap (no meta.version)', async () => {
    const cookieStr = await registerAndLogin(app, 'nobbm@example.com');
    // Create a default layout (with meta.version).
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'No BbmMap' },
    });
    const { id } = create.json() as { id: string };

    // Overwrite the docSnapshot with an empty Y.Doc (no meta.version).
    const Y = await import('yjs');
    const emptyDoc = new Y.Doc();
    const emptyBytes = Buffer.from(Y.encodeStateAsUpdate(emptyDoc));
    await db.update(schema.layouts).set({ docSnapshot: emptyBytes }).where(eq(schema.layouts.id, id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('export_unavailable_for_in_app_layout');
  });

  it('PATCH /api/layouts/:id returns 400 when no updatable fields are provided', async () => {
    const cookieStr = await registerAndLogin(app, 'patch@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Patch Test' },
    });
    const { id } = create.json() as { id: string };

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/layouts/${id}`,
      headers: { cookie: cookieStr },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('no_updates');
  });

  it('PUT /snapshot returns 400 when body is not binary', async () => {
    const cookieStr = await registerAndLogin(app, 'snaptext@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: cookieStr },
      payload: { title: 'Binary Test' },
    });
    const { id } = create.json() as { id: string };

    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${id}/snapshot`,
      headers: { cookie: cookieStr, 'content-type': 'application/json' },
      payload: { notBinary: true },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('expected_binary_body');
  });

});
