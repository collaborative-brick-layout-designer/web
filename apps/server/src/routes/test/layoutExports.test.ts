// Integration tests for layout export endpoints:
//   GET /api/layouts/:id/export.bbm
//   GET /api/layouts/:id/export.bbm.bld (and the legacy export.bbm.cld URL)
//   GET /api/layouts/:id/export.zip
// And layout background image endpoints:
//   POST   /api/layouts/:id/background-image
//   GET    /api/layouts/:id/background-image
//   DELETE /api/layouts/:id/background-image

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { bufConcat, db, resetDb, schema, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/bbm/tests/fixtures',
);

const FORDYCE_BBM = readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf-8');
const MINIMAL_SIDECAR = readFileSync(join(FIXTURES, 'minimal.bbm.cld'), 'utf-8').trim();

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  return app;
}

async function registerAndLogin(app: FastifyInstance, email: string): Promise<string> {
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

async function createLayout(
  app: FastifyInstance,
  cookieStr: string,
  title = 'Export Layout',
  bbm?: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/layouts',
    headers: { cookie: cookieStr },
    payload: bbm ? { title, bbm } : { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('export — .bbm', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns XML with correct content-type for a BBM-seeded layout', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Fordyce Export', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.payload).toContain('<Map>');
    expect(res.payload).toContain('</Map>');
  });

  it('contains disposition header with .bbm filename', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'My Layout', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie },
    });
    expect(res.headers['content-disposition']).toContain('.bbm');
  });

  it('exports a layout whose title has characters outside Latin-1 (was a 500)', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Club show – 2026 ☃', FORDYCE_BBM);
    for (const [path, ext] of [
      ['export.bbm', '.bbm'],
      ['export.zip', '.zip'],
      ['export.bld-layout', '.bld-layout'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: `/api/layouts/${id}/${path}`, headers: { cookie } });
      expect(res.statusCode, path).toBe(200);
      const cd = String(res.headers['content-disposition']);
      expect(cd).toContain(`filename="Club show _ 2026 _${ext}"`);
      expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(`Club show – 2026 ☃${ext}`)}`);
    }
  });

  it('keeps quotes and line breaks in a title out of the download header', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'a"b\r\nSet-Cookie: x=1', FORDYCE_BBM);
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="a_b_Set-Cookie_ x=1\.bbm"; filename\*=UTF-8''[^\s"]+$/);
  });

  it('in-app layout: export returns 200 (createDefaultLayoutDoc seeds meta.version)', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'In-App Layout');

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie },
    });
    // createDefaultLayoutDoc always sets meta.version, so exportBbmFromDoc
    // returns a valid BbmMap and the route returns 200.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
  });

  it('returns 404 for a non-collaborator', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie, 'Private Layout', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('preserves the number of items in the round-trip', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Fordyce Round-trip', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm`,
      headers: { cookie },
    });
    // Fordyce has 949 bricks — Brick element count should be substantial.
    const matches = res.payload.match(/<Brick id="/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(100);
  });
});

describe('export — .bbm.bld (sidecar)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 404 when no sidecar exists', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'No Sidecar', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm.bld`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 to non-collaborator', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie, 'Sidecar Layout', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm.bld`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 JSON when a sidecar was provided at creation', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie },
      payload: { title: 'With Sidecar', bbm: FORDYCE_BBM, sidecar: MINIMAL_SIDECAR },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const cld = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.bbm.bld`,
      headers: { cookie },
    });
    expect(cld.statusCode).toBe(200);
    expect(cld.headers['content-type']).toContain('json');
  });

  it('uses the desktop file name and hashes the exported .bbm', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie },
      payload: { title: 'Desktop Pair', bbm: FORDYCE_BBM, sidecar: MINIMAL_SIDECAR },
    });
    const { id } = res.json() as { id: string };

    const bld = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm.bld`, headers: { cookie } });
    expect(bld.statusCode).toBe(200);
    // Desktop only opens `<file>.bbm.bld` (SidecarIO.cpp sidecarPathFor).
    expect(bld.headers['content-disposition']).toContain('Desktop Pair.bbm.bld');
    const json = bld.json() as { schemaVersion: number; bbmHashSha256: string };
    expect(json.schemaVersion).toBe(1);

    const bbm = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm`, headers: { cookie } });
    const hash = createHash('sha256').update(bbm.payload).digest('hex');
    expect(json.bbmHashSha256).toBe(hash);
  });

  it('keeps the legacy export.bbm.cld URL working', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie },
      payload: { title: 'Legacy', bbm: FORDYCE_BBM, sidecar: MINIMAL_SIDECAR },
    });
    const { id } = res.json() as { id: string };
    const cld = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm.cld`, headers: { cookie } });
    expect(cld.statusCode).toBe(200);
    expect(cld.headers['content-disposition']).toContain('.bbm.bld');
  });

  it('seeds the editor doc from an imported desktop sidecar and exports its edits', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const desktopSidecar = JSON.stringify({
      schemaVersion: 1,
      bbmHashSha256: '',
      anchoredLabels: [{
        id: '42', text: 'Yard', font: { family: 'Arial', size: 12, style: 'Regular' },
        color: { known: true, argb: 4278190080, name: 'Black' },
        kind: 0, targetId: '', offset: { x: 10, y: 20 }, rot: 0, minZoom: 0,
      }],
      modules: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie },
      payload: { title: 'Labels', bbm: FORDYCE_BBM, sidecar: desktopSidecar },
    });
    const { id } = res.json() as { id: string };

    // The editor edits the sidecar held in the main doc's meta.cache.
    const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, layout!.docSnapshot as Uint8Array);
    const cache = doc.getMap('meta').get('cache') as { anchoredLabels: { text: string }[] };
    expect(cache.anchoredLabels[0]!.text).toBe('Yard');
    doc.getMap('meta').set('cache', { ...cache, anchoredLabels: [{ ...cache.anchoredLabels[0]!, text: 'Depot' }] });
    await db
      .update(schema.layouts)
      .set({ docSnapshot: Buffer.from(Y.encodeStateAsUpdate(doc)) })
      .where(eq(schema.layouts.id, id));

    const bld = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm.bld`, headers: { cookie } });
    const out = bld.json() as { anchoredLabels: { text: string; color: { known: boolean; name: string } }[] };
    expect(out.anchoredLabels[0]!.text).toBe('Depot');
    expect(out.anchoredLabels[0]!.color).toMatchObject({ known: true, name: 'Black' });
  });
});

describe('create — sidecar import', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('seeds the editor cache without a .bbm and exports it', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const sidecar = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', venue: { name: 'Hall', enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 0, h: 0 }, edges: [], obstacles: [] } });
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie }, payload: { title: 'Venue only', sidecar } });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const bld = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm.bld`, headers: { cookie } });
    expect(bld.statusCode).toBe(200);
    const json = bld.json() as { venue: { name: string }; bbmHashSha256: string };
    expect(json.venue.name).toBe('Hall');
    // The default doc exports a .bbm, so the hash is filled in.
    expect(json.bbmHashSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // As the desktop does: a newer version's sidecar opens, and its version
  // and the fields this version doesn't know are written back.
  it('takes a sidecar from a newer version and exports it with its version and fields', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const sidecar = JSON.stringify({ schemaVersion: 2, bbmHashSha256: '', venue: { name: 'Hall', enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 0, h: 0 }, edges: [], obstacles: [] }, futureField: { x: 1 } });
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie }, payload: { title: 'Newer', sidecar } });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const bld = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm.bld`, headers: { cookie } });
    expect(bld.statusCode).toBe(200);
    const json = bld.json() as { schemaVersion: number; venue: { name: string }; futureField: unknown };
    expect(json.schemaVersion).toBe(2);
    expect(json.venue.name).toBe('Hall');
    expect(json.futureField).toEqual({ x: 1 });
  });

  it('rejects an unparseable sidecar', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie }, payload: { title: 'Bad', sidecar: '{nope' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('sidecar_parse_failed');
  });

  it('zip sidecar hash matches the zipped .bbm', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST', url: '/api/layouts', headers: { cookie },
      payload: { title: 'Hash', bbm: FORDYCE_BBM, sidecar: MINIMAL_SIDECAR },
    });
    const { id } = res.json() as { id: string };
    const bbm = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.bbm`, headers: { cookie } });
    const zip = await app.inject({ method: 'GET', url: `/api/layouts/${id}/export.zip`, headers: { cookie } });
    // Entries are stored uncompressed, so the sidecar JSON appears verbatim.
    const text = zip.rawPayload.toString('utf8');
    const hash = createHash('sha256').update(bbm.payload).digest('hex');
    expect(text).toContain(`"bbmHashSha256": "${hash}"`);
  });
});

describe('export — .zip', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('returns a zip file for a BBM-seeded layout', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Zip Export', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('.zip');
    // ZIP magic bytes: PK\x03\x04
    expect(res.rawPayload[0]).toBe(0x50);
    expect(res.rawPayload[1]).toBe(0x4b);
  });

  it('zip is non-trivial in size for Fordyce layout', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Fordyce Zip', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
      headers: { cookie },
    });
    expect(res.rawPayload.byteLength).toBeGreaterThan(500);
  });

  it('in-app layout: zip export returns 200 (createDefaultLayoutDoc seeds meta.version)', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'In-App Layout');

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
      headers: { cookie },
    });
    // createDefaultLayoutDoc always sets meta.version, so the zip export works.
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload[0]).toBe(0x50); // 'P'
    expect(res.rawPayload[1]).toBe(0x4b); // 'K'
  });

  it('returns 404 for a non-collaborator', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie, 'Private Zip', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie, 'Auth Zip', FORDYCE_BBM);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('zip includes a .bbm.bld entry when sidecar was provided', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie },
      payload: { title: 'Zip With Sidecar', bbm: FORDYCE_BBM, sidecar: MINIMAL_SIDECAR },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const zip = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/export.zip`,
      headers: { cookie },
    });
    expect(zip.statusCode).toBe(200);
    // PK magic bytes
    expect(zip.rawPayload[0]).toBe(0x50);
    expect(zip.rawPayload[1]).toBe(0x4b);
    // Entry names are stored uncompressed in the local headers.
    const names = zip.rawPayload.toString('latin1');
    expect(names).toContain('Zip With Sidecar.bbm.bld');
    expect(names).not.toContain('.bbm.cld');
  });
});

describe('background image', () => {
  let app: FastifyInstance;
  beforeEach(async () => { resetDb(); app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it('GET returns 404 when no background image has been uploaded', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE returns 200 even when no image exists (idempotent)', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('GET returns 404 to a non-collaborator', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE returns 403 to a non-editor', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie: outsiderCookie },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('POST returns 400 for invalid layout id', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const boundary = '----BoundaryABC';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/not-a-uuid/background-image',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_id');
  });

  it('POST returns 403 for a non-editor', async () => {
    const ownerCookie = await registerAndLogin(app, 'owner@example.com');
    const outsiderCookie = await registerAndLogin(app, 'outsider@example.com');
    const id = await createLayout(app, ownerCookie);
    const boundary = '----BoundaryABC';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie: outsiderCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST returns 415 for an unsupported mime type', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie);
    const boundary = '----BoundaryPDF';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: string }).error).toBe('unsupported_image_type');
  });

  it('POST uploads a PNG and GET serves it back', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie);

    // Minimal 1×1 PNG bytes.
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000' +
      '0a49444154789c6260000000020001e221bc330000000049454e44ae426082',
      'hex',
    );
    const boundary = '----BoundaryPNG';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bg.png"\r\nContent-Type: image/png\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = bufConcat([Buffer.from(header), pngBytes, Buffer.from(footer)]);

    const upload = await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(200);
    const { url } = upload.json() as { url: string };
    expect(url).toContain('/background-image');

    // Verify GET now serves the uploaded image.
    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toContain('image/png');
  });

  it('DELETE removes an uploaded background image', async () => {
    const cookie = await registerAndLogin(app, 'owner@example.com');
    const id = await createLayout(app, cookie);

    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000' +
      '0a49444154789c6260000000020001e221bc330000000049454e44ae426082',
      'hex',
    );
    const boundary = '----BoundaryDel';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bg.png"\r\nContent-Type: image/png\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = bufConcat([Buffer.from(header), pngBytes, Buffer.from(footer)]);

    await app.inject({
      method: 'POST',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    // GET should now return 404 again.
    const get = await app.inject({
      method: 'GET',
      url: `/api/layouts/${id}/background-image`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);
  });
});
