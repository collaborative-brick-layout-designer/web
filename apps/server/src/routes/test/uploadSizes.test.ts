// Upload sizes are counted from the bytes that arrive, not from what the
// request declares: a chunked request has no Content-Length. Covers the
// background-image upload, layout create, venue edits and custom-part
// sprites, and that stored pictures are the type they claim.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { bufConcat, db, loginAs, resetDb, schema } from '../../test/helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const FORDYCE_BBM = readFileSync(resolve(FIXTURES, 'fordyce-2026.bbm'), 'utf-8');
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size: number) => bufConcat([PNG_HEAD, Buffer.alloc(Math.max(0, size - PNG_HEAD.length), 0x41)]);

let app: FastifyInstance;
let user: { cookie: string; id: string };
let admin: string;

function multipart(parts: { name: string; filename?: string; type?: string; body: Buffer }[]) {
  const boundary = '----UploadSizes' + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = p.filename ? `form-data; name="${p.name}"; filename="${p.filename}"` : `form-data; name="${p.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
    chunks.push(p.body);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { chunks, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function setLimits(patch: Record<string, number | null>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/admin/limits', headers: { cookie: admin }, payload: patch });
  expect(res.statusCode, res.body).toBe(200);
}

async function newLayout(cookieStr: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function uploadBg(layoutId: string, cookieStr: string, body: Buffer, opts: { chunked?: boolean; type?: string; extra?: number } = {}) {
  const fields = Array.from({ length: opts.extra ?? 0 }, (_, i) => ({ name: `f${i}`, body: Buffer.from('x') }));
  const mp = multipart([...fields, { name: 'file', filename: 'a.png', type: opts.type ?? 'image/png', body }]);
  return app.inject({
    method: 'POST',
    url: `/api/layouts/${layoutId}/background-image`,
    headers: { cookie: cookieStr, 'content-type': mp.contentType },
    payload: opts.chunked ? Readable.from(mp.chunks) : bufConcat(mp.chunks),
  });
}

beforeAll(async () => {
  resetDb();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  await app.ready();
  const a = await loginAs(app, 'admin@uploads.test');
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, a.id));
  admin = a.cookie;
  user = await loginAs(app, 'user@uploads.test');
});

afterAll(async () => {
  closeAll();
  await app.close();
});

beforeEach(async () => {
  await setLimits({ uploadBytes: null, storagePerUser: null });
});

describe('background image upload sizes', () => {
  it('applies the largest-upload limit to a chunked upload', async () => {
    const id = await newLayout(user.cookie);
    await setLimits({ uploadBytes: 64 * 1024 });
    const big = png(1024 * 1024);
    expect((await uploadBg(id, user.cookie, big)).statusCode).toBe(413);
    const chunked = await uploadBg(id, user.cookie, big, { chunked: true });
    expect(chunked.statusCode).toBe(413);
    const get = await app.inject({ method: 'GET', url: `/api/layouts/${id}/background-image`, headers: { cookie: user.cookie } });
    expect(get.statusCode).toBe(404);
  });

  it('counts a chunked upload against the storage limit', async () => {
    const other = await loginAs(app, 'quota@uploads.test');
    const id = await newLayout(other.cookie);
    await setLimits({ storagePerUser: 256 * 1024 });
    const big = png(1024 * 1024);
    const chunked = await uploadBg(id, other.cookie, big, { chunked: true });
    expect(chunked.statusCode).toBe(403);
    expect(chunked.json()).toMatchObject({ error: 'limit_reached' });
    const small = await uploadBg(id, other.cookie, png(1024), { chunked: true });
    expect(small.statusCode).toBe(200);
  });

  it('takes one file and no other form fields', async () => {
    const id = await newLayout(user.cookie);
    const res = await uploadBg(id, user.cookie, png(64), { extra: 3, chunked: true });
    expect(res.statusCode).toBe(413);
    expect((await uploadBg(id, user.cookie, png(64))).statusCode).toBe(200);
  });

  it('stores only pictures of the type they claim', async () => {
    const id = await newLayout(user.cookie);
    const html = Buffer.from('<html><body>not a picture</body></html>');
    expect((await uploadBg(id, user.cookie, html)).statusCode).toBe(415);
    expect((await uploadBg(id, user.cookie, png(64), { type: 'image/jpeg' })).statusCode).toBe(415);
    const fromFile = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: user.cookie },
      payload: { title: 'with picture', backgroundImage: { type: 'image/png', data: html.toString('base64') } },
    });
    expect(fromFile.statusCode).toBe(415);
  });
});

describe('layout create size', () => {
  it('applies the largest-upload limit to a chunked body', async () => {
    await setLimits({ uploadBytes: 64 * 1024 });
    const json = Buffer.from(JSON.stringify({ title: 'big', bbm: FORDYCE_BBM }));
    const chunked = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: Readable.from([json]),
    });
    expect(chunked.statusCode).toBe(413);
  });
});

describe('venue edit size', () => {
  it('applies the storage limit to an edit as it does to a new venue', async () => {
    const owner = await loginAs(app, 'venues@uploads.test');
    const made = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: { cookie: owner.cookie },
      payload: { name: 'Hall', data: { walls: [] } },
    });
    expect(made.statusCode).toBe(201);
    await setLimits({ storagePerUser: 100 * 1024 });
    const big = { walls: [], notes: [{ text: 'x'.repeat(500 * 1024) }] };
    const created = await app.inject({ method: 'POST', url: '/api/venues', headers: { cookie: owner.cookie }, payload: { name: 'Big', data: big } });
    expect(created.statusCode).toBe(403);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/venues/${made.json().id}`,
      headers: { cookie: owner.cookie },
      payload: { data: big },
    });
    expect(edited.statusCode).toBe(403);
    expect(edited.json()).toMatchObject({ error: 'limit_reached' });
    const small = await app.inject({
      method: 'PATCH',
      url: `/api/venues/${made.json().id}`,
      headers: { cookie: owner.cookie },
      payload: { data: { walls: [1] } },
    });
    expect(small.statusCode).toBe(200);
  });
});

describe('custom part sprites', () => {
  const XML = Buffer.from('<part><Description><en>p</en></Description></part>').toString('base64');
  async function create(spriteBase64: string, spriteMime: string) {
    return app.inject({
      method: 'POST',
      url: '/api/custom-parts',
      headers: { cookie: user.cookie },
      payload: { partNumber: `P${Math.random().toString(36).slice(2, 8)}`, displayName: 'P', xmlBase64: XML, spriteBase64, spriteMime },
    });
  }

  it('stores only sprites that are the picture type they claim, at a sane size', async () => {
    expect((await create(Buffer.from('<svg/>').toString('base64'), 'image/gif')).statusCode).toBe(400);
    expect((await create(Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64'), 'image/png')).statusCode).toBe(400);
    const huge = bufConcat([PNG_HEAD, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff])]);
    expect((await create(huge.toString('base64'), 'image/png')).statusCode).toBe(400);
    expect((await create(Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64'), 'image/gif')).statusCode).toBe(201);
  });
});
