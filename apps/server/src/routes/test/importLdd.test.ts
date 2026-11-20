// LDD's brick database for the browser's importer (imports/lddFiles.ts,
// routes/importLibraries.ts) on a LIF archive made here (LDD's own is
// proprietary), and Admin › Model import › Server import as a backup:
//   - the table of contents is read once; each brick is one seek and read;
//   - a brick by its design ID only, one at a time or a batch; never a path,
//     never a listing, never the archive;
//   - Materials.xml and the ldraw.xml mapping;
//   - the backup switch (and IMPORTS_SERVER_BACKUP) turns the server's
//     importer off: the status says the browser reads models, uploads are refused.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { importRoutes } from '../imports.js';
import { importLibraryRoutes } from '../importLibraries.js';
import { env } from '../../env.js';
import { forgetLddIndex, lifIndex } from '../../imports/lddFiles.js';
import { forgetLibraryIndexes } from '../../imports/libraryFiles.js';
import { invalidateImportSettings } from '../../imports/settings.js';
import { forgetConverterState } from '../../imports/converter.js';

type Node = { name: string; data?: Buffer; children?: Node[] };

/** A LIF archive as LDD's LifReader reads it (src/import/lif/LifReader.cpp). */
function lif(root: Node[]): Buffer {
  const packed: Buffer[] = [];
  const pack = (nodes: Node[]) => {
    for (const n of nodes) {
      packed.push(Buffer.alloc(20));
      if (n.children) pack(n.children);
      else packed.push(n.data!);
    }
  };
  pack(root);
  const body = Buffer.concat(packed);
  const tocStart = 84 + body.length;
  const toc = Buffer.alloc(64 * 1024);
  const rel = (o: number) => o - tocStart;
  const walk = (nodes: Node[], prefix: boolean, off: number): number => {
    off += prefix ? 4 : 36;
    toc.writeUInt32BE(nodes.length, rel(off));
    for (const n of nodes) {
      off += 4;
      toc.writeUInt16BE(n.children ? 1 : 2, rel(off));
      off += 6;
      for (const ch of n.name) {
        toc.writeUInt8(0, rel(off));
        toc.writeUInt8(ch.charCodeAt(0), rel(off) + 1);
        off += 2;
      }
      off += 6;
      if (n.children) off = walk(n.children, true, off);
      else {
        toc.writeUInt32BE(n.data!.length + 20, rel(off));
        off += 24;
      }
    }
    return off;
  };
  const end = walk(root, false, tocStart);
  const header = Buffer.alloc(84);
  header.write('LIFF', 0, 'latin1');
  header.writeUInt32BE(tocStart - 64, 72);
  return Buffer.concat([header, body, toc.subarray(0, rel(end) + 8)]);
}

const G3001 = Buffer.from('10GB-the-shape-of-3001');
const G3022 = Buffer.from('10GB-the-shape-of-3022');
const MATERIALS = Buffer.from('<Materials><Material MatID="21" Red="180" Green="0" Blue="0"/></Materials>');
const DB = lif([
  { name: 'Materials.xml', data: MATERIALS },
  { name: 'Primitives', children: [{ name: 'LOD0', children: [{ name: '3001.g', data: G3001 }, { name: '3022.g', data: G3022 }] }] },
  { name: 'secret.txt', data: Buffer.from('never served') },
]);
const ASSETS = lif([{ name: 'Readme.txt', data: Buffer.from('x') }, { name: 'db.lif', data: DB }]);

const tmp = mkdtempSync(join(tmpdir(), 'cld-ldd-'));
const LDD = join(tmp, 'ldd');
mkdirSync(LDD);
writeFileSync(join(LDD, 'Assets.lif'), ASSETS);
writeFileSync(join(LDD, 'ldraw.xml'), '<LDrawMapping><Brick ldraw="3001.dat" lego="3001"/></LDrawMapping>');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(importRoutes);
  await app.register(importLibraryRoutes);
  return app;
}

describe('LDD for the browser, and the server as a backup', () => {
  let app: FastifyInstance;
  let c: string;
  const saved = { assets: env.importLddAssets, xml: env.importLddLdrawXml, backup: env.importsServerBackupForced };
  beforeAll(() => {
    env.importLddAssets = LDD;
    env.importLddLdrawXml = join(LDD, 'ldraw.xml');
  });
  afterAll(() => {
    env.importLddAssets = saved.assets;
    env.importLddLdrawXml = saved.xml;
    env.importsServerBackupForced = saved.backup;
  });
  beforeEach(async () => {
    resetDb();
    invalidateImportSettings();
    forgetLddIndex();
    forgetLibraryIndexes();
    forgetConverterState();
    env.importsServerBackupForced = null;
    app = await buildApp();
    ({ cookie: c } = await loginAs(app, 'ldd-browser@x.com'));
  });
  afterEach(async () => {
    await app.close();
  });

  const get = (url: string, who: string | null = c) => app.inject({ method: 'GET', url, headers: who ? { cookie: who } : {} });
  const versions = async () => (await get('/api/import-library')).json() as { ldd: string; lddMapping: string };

  it('indexes the nested database as the desktop reads it', async () => {
    const fh = await open(join(LDD, 'Assets.lif'), 'r');
    const outer = await lifIndex(fh, 0, ASSETS.length);
    const inner = await lifIndex(fh, outer.get('/db.lif')!.offset, outer.get('/db.lif')!.size);
    await fh.close();
    expect([...inner.keys()].sort()).toEqual(['/Materials.xml', '/Primitives/LOD0/3001.g', '/Primitives/LOD0/3022.g', '/secret.txt']);
  });

  it('serves one brick by its design ID, cached for good; nothing else', async () => {
    const { ldd, lddMapping } = await versions();
    expect(ldd).toMatch(/^[0-9a-f]{16}$/);
    expect(lddMapping).toMatch(/^[0-9a-f]{16}$/);
    const one = await get(`/api/import-library/ldd/${ldd}/geometry?id=3001`);
    expect(one.statusCode).toBe(200);
    expect(one.rawPayload.equals(G3001)).toBe(true);
    expect(one.headers['cache-control']).toContain('immutable');
    expect((await get(`/api/import-library/ldd/${ldd}/geometry?id=4242`)).statusCode).toBe(204);
    for (const bad of ['../secret.txt', 'secret', '3001.g', '/Primitives/LOD0/3001', '30 01', '']) {
      const r = await get(`/api/import-library/ldd/${ldd}/geometry?id=${encodeURIComponent(bad)}`);
      expect(r.statusCode, bad).toBe(400);
      expect(r.body).not.toContain('never served');
    }
  });

  it('serves bricks in a batch, Materials.xml and the mapping', async () => {
    const { ldd, lddMapping } = await versions();
    const r = await app.inject({ method: 'POST', url: `/api/import-library/ldd/${ldd}/geometry`, headers: { cookie: c }, payload: { ids: ['3001', '3022', '4242'] } });
    const j = r.json();
    expect(Buffer.from(j.files['3001'], 'base64').equals(G3001)).toBe(true);
    expect(Buffer.from(j.files['3022'], 'base64').equals(G3022)).toBe(true);
    expect(j.files['4242']).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/import-library/ldd/${ldd}/geometry`, headers: { cookie: c }, payload: { ids: ['../x'] } })).statusCode).toBe(400);
    expect((await get(`/api/import-library/ldd/${ldd}/materials`)).rawPayload.equals(MATERIALS)).toBe(true);
    expect((await get(`/api/import-library/ldd-mapping/${lddMapping}/ldraw-xml`)).body).toContain('lego="3001"');
    expect((await get(`/api/import-library/ldd/${ldd}/geometry?id=3001`, null)).statusCode).toBe(401);
    const s = (await get('/api/imports/status')).json();
    expect(s.browser.extensions).toContain('lxf');
    expect(s.browser.ldd).toBe(ldd);
  });

  it('Server import as a backup: on by default; off, the server reads nothing and says the browser does', async () => {
    const admin = await loginAs(app, 'ldd-admin@x.com');
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id));
    const view = (await get('/api/admin/imports', admin.cookie)).json();
    expect(view).toMatchObject({ serverBackup: true, serverBackupSetting: true, serverBackupForcedBy: null });
    const off = await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: admin.cookie }, payload: { serverBackup: false } });
    expect(off.json()).toMatchObject({ serverBackup: false, serverBackupSetting: false });
    const s = (await get('/api/imports/status')).json();
    expect(s).toMatchObject({ available: false, reason: 'backup_off', message: 'This site reads models only in your browser: its own importer is off.' });
    expect(s.browser.available).toBe(true);
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: admin.cookie }, payload: { serverBackup: 'no' } })).statusCode).toBe(400);
    // The env var wins, and the page is told which.
    env.importsServerBackupForced = true;
    invalidateImportSettings();
    expect((await get('/api/admin/imports', admin.cookie)).json()).toMatchObject({ serverBackup: true, serverBackupSetting: false, serverBackupForcedBy: 'IMPORTS_SERVER_BACKUP' });
  });
});
