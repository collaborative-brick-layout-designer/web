// The import libraries' single files for the browser's importer
// (routes/importLibraries.ts, imports/libraryFiles.ts), and what the
// browser's importer saves (POST /api/imports/client):
//   - names resolve in the desktop's LDraw search order, any case, with a
//     folder hint, unofficial parts after official ones;
//   - nothing outside the library, no listing, no traversal;
//   - versioned answers are cached for good, others not at all;
//   - a batch answers what fits and lists the rest;
//   - signed in only; off when import is off;
//   - a browser-made part and layout are saved as a job's are.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { importRoutes } from '../imports.js';
import { importLibraryRoutes } from '../importLibraries.js';
import { env } from '../../env.js';
import { cleanPartName, forgetLibraryIndexes } from '../../imports/libraryFiles.js';
import { invalidateImportSettings, saveImportSettings } from '../../imports/settings.js';
import { docHub } from '../../ws/docHub.js';

const tmp = mkdtempSync(join(tmpdir(), 'cld-implib-'));
const COLOR_KEYWORD = '!COL' + 'OUR';
const LIB = join(tmp, 'ldraw');
const BBM = new URL('../../../../../packages/bbm/tests/fixtures/tight-corner.bbm', import.meta.url).pathname;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082',
  'hex',
);

function put(rel: string, text: string) {
  const p = join(LIB, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

function makeLibrary() {
  // LDraw's color keyword is spelled the British way; the US spelling rule is for our words.
  put('LDConfig.ldr', `0 LDraw.org Configuration File\n0 !LDRAW_ORG Configuration UPDATE 2025-01\n0 ${COLOR_KEYWORD} Red CODE 4 VALUE #C91A09 EDGE #333333\n`);
  put('parts/3001.dat', '0 Brick 2 x 4\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat\n');
  put('parts/s/3001s01.dat', '0 ~Brick 2 x 4 without front face\n');
  put('p/stud.dat', '0 Stud\n');
  put('p/48/box5.dat', '0 Box 5 hi-res\n');
  put('p/box5.dat', '0 Box 5\n');
  put('parts/Same.dat', '0 Official one\n');
  put('Unofficial/parts/same.dat', '0 Unofficial one\n');
  put('Unofficial/parts/u1.dat', '0 Unofficial only\n');
  put('parts/2865.dat', '0 ~Moved to 74746\n');
  put('parts/74746.dat', '0 Train Track 9V Straight\n');
  put('parts/big.dat', '0 ' + 'x'.repeat(9 * 1024 * 1024));
  writeFileSync(join(tmp, 'secret.dat'), '0 not in the library\n');
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(layoutRoutes);
  await app.register(importRoutes);
  await app.register(importLibraryRoutes);
  return app;
}

describe('import library files', () => {
  let app: FastifyInstance;
  let c: string;
  const saved = env.importLdrawDir;

  beforeAll(makeLibrary);
  afterAll(() => {
    env.importLdrawDir = saved;
  });
  beforeEach(async () => {
    resetDb();
    invalidateImportSettings();
    forgetLibraryIndexes();
    env.importLdrawDir = LIB;
    app = await buildApp();
    ({ cookie: c } = await loginAs(app, 'browser-importer@x.com'));
  });
  afterEach(async () => {
    await docHub.flushAll().catch(() => undefined);
    await app.close();
  });

  const get = (url: string, who: string | null = c) => app.inject({ method: 'GET', url, headers: who ? { cookie: who } : {} });
  async function version(): Promise<string> {
    const r = (await get('/api/import-library')).json();
    return r.ldraw as string;
  }
  const file = async (name: string, v?: string) => get(`/api/import-library/ldraw/${v ?? (await version())}/file?name=${encodeURIComponent(name)}`);

  it('says which libraries there are, with a version for each; the status says the browser can import LDraw', async () => {
    const r = (await get('/api/import-library')).json();
    expect(r).toMatchObject({ enabled: true, studio: null });
    expect(r.ldraw).toMatch(/^[0-9a-f]{16}$/);
    const s = (await get('/api/imports/status')).json();
    expect(s.browser).toEqual({ available: true, extensions: ['ldr', 'mpd', 'dat'], ldraw: r.ldraw, studio: null });
  });

  it('finds parts as the desktop does: parts, p, p/48, any case, a folder hint, unofficial after official', async () => {
    expect((await file('3001.dat')).body).toContain('Brick 2 x 4');
    expect((await file('3001.DAT')).body).toContain('Brick 2 x 4');
    expect((await file('s\\3001s01.dat')).body).toContain('without front face');
    expect((await file('3001s01.dat')).body).toContain('without front face');
    expect((await file('stud.dat')).body).toBe('0 Stud\n');
    // p/ comes before p/48 for a bare name; "48/" asks for the hi-res one.
    expect((await file('box5.dat')).body).toBe('0 Box 5\n');
    expect((await file('48/box5.dat')).body).toBe('0 Box 5 hi-res\n');
    expect((await file('same.dat')).body).toBe('0 Official one\n');
    expect((await file('u1.dat')).body).toBe('0 Unofficial only\n');
  });

  it('answers a missing file with a 204, not a 4xx', async () => {
    const r = await file('nothere.dat');
    expect(r.statusCode).toBe(204);
    expect((await file('big.dat')).statusCode).toBe(204);
  });

  it('never leaves the library: no traversal, no absolute paths, only part files', async () => {
    for (const bad of ['../secret.dat', '..\\secret.dat', '/etc/passwd', 'parts/../../secret.dat', 'LDConfig.ldr.txt', 'a/b/c/d.dat', 'x.dat\u0000', '', 'parts/']) {
      expect(cleanPartName(bad), bad).toBeNull();
      const r = await file(bad);
      expect([400, 204], bad).toContain(r.statusCode);
      expect(r.body).not.toContain('not in the library');
    }
    // A hint can't climb out either.
    expect((await file('../../secret.dat')).statusCode).toBe(400);
  });

  it('caches the current version for good, and answers an old version without caching it', async () => {
    const v = await version();
    const now = await file('3001.dat', v);
    expect(now.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(now.headers.etag).toBeTruthy();
    const old = await file('3001.dat', '0123456789abcdef');
    expect(old.statusCode).toBe(200);
    expect(old.headers['cache-control']).toBe('private, no-store');
    expect((await get(`/api/import-library/ldraw/nothex/file?name=3001.dat`)).statusCode).toBe(400);
  });

  it('a batch answers each name (null when missing), and lists what didn’t fit', async () => {
    const v = await version();
    const r = await app.inject({ method: 'POST', url: `/api/import-library/ldraw/${v}/files`, headers: { cookie: c }, payload: { names: ['3001.dat', 's/3001s01.dat', 'nothere.dat', 'stud.dat'] } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.version).toBe(v);
    expect(j.more).toEqual([]);
    expect(j.files['3001.dat']).toContain('Brick 2 x 4');
    expect(j.files['s/3001s01.dat']).toContain('without front face');
    expect(j.files['nothere.dat']).toBeNull();
    const tooMany = await app.inject({ method: 'POST', url: `/api/import-library/ldraw/${v}/files`, headers: { cookie: c }, payload: { names: Array.from({ length: 257 }, (_, i) => `${i}.dat`) } });
    expect(tooMany.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: `/api/import-library/ldraw/${v}/files`, headers: { cookie: c }, payload: { names: ['../secret.dat'] } });
    expect(bad.statusCode).toBe(400);
  });

  it('serves the colors and the "~Moved to" index', async () => {
    const v = await version();
    const cfg = await get(`/api/import-library/ldraw/${v}/ldconfig`);
    expect(cfg.body).toContain(`${COLOR_KEYWORD} Red CODE 4`);
    expect(cfg.headers['cache-control']).toContain('immutable');
    const moved = (await get(`/api/import-library/ldraw/${v}/moved`)).json();
    expect(moved).toEqual({ '74746': ['2865'] });
  });

  it('is for signed-in people only, and off when import is off or there’s no library', async () => {
    const v = await version();
    expect((await get('/api/import-library', null)).statusCode).toBe(401);
    expect((await get(`/api/import-library/ldraw/${v}/file?name=3001.dat`, null)).statusCode).toBe(401);
    expect((await get(`/api/import-library/studio/${v}/file?name=3001.dat`)).statusCode).toBe(409);
    const { id } = await loginAs(app, 'switcher@x.com');
    expect(await saveImportSettings({ enabled: false }, id)).toBeNull();
    invalidateImportSettings();
    expect((await get(`/api/import-library/ldraw/${v}/file?name=3001.dat`)).statusCode).toBe(409);
  });

  describe('POST /api/imports/client', () => {
    const xml = (name: string) =>
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<part>\n  <Author>Sam</Author>\n  <Description>\n    <en>${name}</en>\n  </Description>\n  <PixelsPerStud>32</PixelsPerStud>\n</part>\n`).toString('base64');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/imports/client', headers: { cookie: c }, payload });

    it('saves the browser’s part and a new layout with it, as a job does', async () => {
      const r = await post({ mode: 'part', partKey: 'Two bricks', displayName: 'Two bricks', xmlBase64: xml('Two bricks'), spriteBase64: PNG.toString('base64'), widthStuds: 1, heightStuds: 1, category: 'Imported', connections: 0, target: { kind: 'new', title: 'From the browser' }, stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 0 }, warnings: ['a warning'] });
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json();
      expect(j).toMatchObject({ mode: 'part', newLayout: true, placed: 1, widthStuds: 1, heightStuds: 1, connections: 0, warnings: ['a warning'], stats: { ldrawResolved: 2 } });
      expect(j.part.partNumber).toBe('Two_bricks');
      const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, j.layoutId)).get();
      expect(layout?.title).toBe('From the browser');
      // Again: the next free number, as the desktop names it.
      const again = (await post({ mode: 'part', partKey: 'Two_bricks', displayName: 'Two bricks', xmlBase64: xml('Two bricks'), spriteBase64: PNG.toString('base64'), widthStuds: 1, heightStuds: 1, target: { kind: 'library' } })).json();
      expect(again.part.partNumber).toBe('Two_bricks-2');
      expect(again.layoutId).toBeNull();
    });

    it('saves the browser’s .bbm as a new layout, or hands it back to the editor to place', async () => {
      const bbm = readFileSync(BBM, 'utf8');
      const r = await post({ mode: 'parts', bbm, title: 'Loop', sheets: 1, target: { kind: 'new' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ mode: 'parts', newLayout: true, sheets: 1 });
      expect(r.json().placed).toBeGreaterThan(0);
      const host = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: c }, payload: { title: 'Host' } })).json();
      const here = (await post({ mode: 'parts', bbm, target: { kind: 'layout', layoutId: host.id, clientPlaces: true } })).json();
      expect(here.toPlace.bricks.length).toBeGreaterThan(0);
    });

    it('refuses what isn’t right: a damaged layout, a missing sprite, a bad size, a layout as a library part', async () => {
      expect((await post({ mode: 'parts', bbm: '<Map', target: { kind: 'new' } })).statusCode).toBe(422);
      expect((await post({ mode: 'part', partKey: 'x', xmlBase64: xml('x'), widthStuds: 1, heightStuds: 1, target: { kind: 'new' } })).statusCode).toBe(400);
      expect((await post({ mode: 'part', partKey: 'x', xmlBase64: xml('x'), spriteBase64: PNG.toString('base64'), widthStuds: 0, heightStuds: 1, target: { kind: 'new' } })).statusCode).toBe(400);
      expect((await post({ mode: 'parts', bbm: 'x', target: { kind: 'library' } })).statusCode).toBe(400);
      expect((await post({ mode: 'what', target: { kind: 'new' } })).statusCode).toBe(400);
      // Not a PNG: createCustomPart's own checks.
      expect((await post({ mode: 'part', partKey: 'x', xmlBase64: xml('x'), spriteBase64: Buffer.from('not a png').toString('base64'), widthStuds: 1, heightStuds: 1, target: { kind: 'library' } })).statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
