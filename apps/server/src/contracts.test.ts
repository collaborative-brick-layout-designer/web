// Web/desktop contracts, server side (fixtures/contracts/, the same files
// as the desktop repo's; see its README):
//   - every fixture matches MANIFEST.sha256 (identical in both repos)
//   - an imported part's XML from the desktop's ImportToPart, uploaded,
//     reads with the fields the desktop reads, and its <ImportSource>
//     (the model's path on the importer's computer) is never stored or
//     served
//   - every file made for BlueBrick or the desktop names a server custom
//     part by its number, never the website's "custom:<id>"

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { readBbm } from '@cld/bbm';
import { encodeDoc, seedFromBbm } from '@cld/ydoc';
import { db, loginAs, resetDb, schema } from './test/helpers.js';
import { readZip } from './test/zip.js';
import { attachUser } from './auth/cookie.js';
import { registerApiRoutes } from './routes/all.js';
import { closeAll } from './events/hub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACTS = join(ROOT, 'fixtures/contracts');
const fixture = (name: string) => readFileSync(join(CONTRACTS, name));
const json = <T>(name: string): T => JSON.parse(fixture(name).toString('utf8')) as T;

interface ImportedPart {
  author: string;
  description: string;
  pxPerStud: number;
  connections: { type: string; x: number; y: number; angle: number }[];
  snapMargin: { left: number; right: number; top: number; bottom: number };
  designer: { name: string; url: string };
  importedFrom: { file: string; format: string };
  neverOnTheServer: string[];
  pickShape: [number, number][][];
}
interface PartNaming {
  id: string;
  partNumber: string;
  displayName: string;
  xml: string;
}

describe('contract fixtures', () => {
  it('the web editor tests use the same doc-shape.json', () => {
    const copy = readFileSync(join(ROOT, 'apps/web/src/editor/test/fixtures/doc-shape.json'));
    expect(copy.equals(fixture('doc-shape.json'))).toBe(true);
  });

  it('the web editor tests use the same module-members.json', () => {
    const copy = readFileSync(join(ROOT, 'apps/web/src/editor/test/fixtures/module-members.json'));
    expect(copy.equals(fixture('module-members.json'))).toBe(true);
  });

  it('every file matches MANIFEST.sha256, which is the same in the desktop repo', () => {
    const lines = fixture('MANIFEST.sha256').toString('utf8').split('\n').filter((l) => l.trim());
    const listed: string[] = [];
    for (const line of lines) {
      const [hash, name] = line.split(/\s+/);
      listed.push(name!);
      expect(createHash('sha256').update(fixture(name!)).digest('hex'), `${name} differs from the manifest (and the desktop's copy)`).toBe(hash);
    }
    const onDisk = readdirSync(CONTRACTS).filter((f) => !f.startsWith('.') && f !== 'MANIFEST.sha256' && f !== 'README.md');
    expect(listed.sort()).toEqual(onDisk.sort());
  });
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  return app;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('an imported part on the server', () => {
  let app: FastifyInstance;
  let sam: { cookie: string; id: string };
  const want = json<ImportedPart>('imported-part.json');
  const xml = fixture('imported-part.xml');

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    sam = await loginAs(app, 'sam@example.com');
  });
  afterEach(async () => {
    closeAll();
    await app.close();
  });

  async function upload(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/custom-parts',
      headers: { cookie: sam.cookie },
      payload: { partNumber: 'HARBOUR_YARD', displayName: 'Harbour yard', xmlBase64: xml.toString('base64'), spriteBase64: PNG.toString('base64'), spriteMime: 'image/png' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  const expectNoImportSource = (text: string, where: string) => {
    for (const s of want.neverOnTheServer) expect(text, `${where} holds ${s}`).not.toContain(s);
  };

  it('is stored and served without its ImportSource; ImportedFrom and Designer stay', async () => {
    const id = await upload();
    const row = await db.select().from(schema.customParts).where(eq(schema.customParts.id, id)).get();
    expectNoImportSource(Buffer.from(row!.xmlBlob as Uint8Array).toString('utf8'), 'the stored XML');
    const served = await app.inject({ method: 'GET', url: `/api/custom-parts/${id}/xml`, headers: { cookie: sam.cookie } });
    expect(served.statusCode).toBe(200);
    expectNoImportSource(served.body, 'the served XML');
    expect(served.body).toContain(`<ImportedFrom file="${want.importedFrom.file}" format="${want.importedFrom.format}"`);
    expect(served.body).toContain(`<Designer url="${want.designer.url}">${want.designer.name}</Designer>`);
    // Replacing it strips it too.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/custom-parts/${id}`,
      headers: { cookie: sam.cookie },
      payload: { partNumber: 'HARBOUR_YARD', displayName: 'Harbour yard', xmlBase64: xml.toString('base64'), spriteBase64: PNG.toString('base64'), spriteMime: 'image/png' },
    });
    expect(put.statusCode).toBe(200);
    expectNoImportSource((await app.inject({ method: 'GET', url: `/api/custom-parts/${id}/xml`, headers: { cookie: sam.cookie } })).body, 'the replaced XML');
  });

  it('reads with the fields the desktop reads (connections, SnapMargin, PickShape, Designer)', async () => {
    const id = await upload();
    const res = await app.inject({ method: 'GET', url: '/api/parts/catalog', headers: { cookie: sam.cookie } });
    expect(res.statusCode).toBe(200);
    const parts = (res.json() as { parts: Record<string, unknown>[] }).parts;
    const part = parts.find((p) => String(p.key).toLowerCase() === `custom:${id}`) as Record<string, unknown> | undefined;
    expect(part, 'the uploaded part is in the catalog').toBeDefined();
    expect((part!.connections as { type: string; x: number; y: number; angle: number }[]).map(({ type, x, y, angle }) => ({ type, x, y, angle }))).toEqual(want.connections);
    expect(part!.snapMargin).toEqual(want.snapMargin);
    expect(part!.pickShape).toEqual(want.pickShape.map((ring) => ring.map(([x, y]) => ({ x, y }))));
    expect(part!.designer).toMatchObject({ name: want.designer.name, url: want.designer.url });
    expectNoImportSource(JSON.stringify(part), 'the catalog entry');
  });

  // Steps: a part row stored before the server stripped <ImportSource> (or
  // copied from one) still has it; GET /api/custom-parts/:id/xml serves the
  // stored bytes as they are, so the importer's local path (/home/<user>/…)
  // is shown to everyone the part is shared with.
  it('a part stored before stripping existed is not served with its ImportSource', async () => {
    const id = await upload();
    await db.update(schema.customParts).set({ xmlBlob: xml }).where(eq(schema.customParts.id, id));
    const served = await app.inject({ method: 'GET', url: `/api/custom-parts/${id}/xml`, headers: { cookie: sam.cookie } });
    expect(served.statusCode).toBe(200);
    expectNoImportSource(served.body, 'the served XML of an old row');
  });

  // Steps: as above, then "Copy to…" a club (POST /api/custom-parts/:id/copy,
  // collections.ts copyPartTo; ownership.ts's hand-over copy does the same):
  // the copy's XML is the stored bytes, ImportSource and all.
  it('copying a part stored before stripping existed drops its ImportSource', async () => {
    const id = await upload();
    await db.update(schema.customParts).set({ xmlBlob: xml }).where(eq(schema.customParts.id, id));
    expect((await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: sam.cookie }, payload: { name: 'Harbour Club' } })).statusCode).toBe(201);
    const copy = await app.inject({ method: 'POST', url: `/api/custom-parts/${id}/copy`, headers: { cookie: sam.cookie }, payload: { orgSlug: 'harbour-club' } });
    expect(copy.statusCode).toBe(201);
    const row = await db.select().from(schema.customParts).where(eq(schema.customParts.id, copy.json().id)).get();
    expectNoImportSource(Buffer.from(row!.xmlBlob as Uint8Array).toString('utf8'), 'the copy');
  });
});

describe('a server custom part in files for BlueBrick and the desktop', () => {
  let app: FastifyInstance;
  let sam: { cookie: string; id: string };
  const naming = json<PartNaming>('part-naming.json');

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    sam = await loginAs(app, 'sam@example.com');
  });
  afterEach(async () => {
    closeAll();
    await app.close();
  });

  async function layoutWithThePart(): Promise<string> {
    const now = new Date();
    await db.insert(schema.customParts).values({
      id: naming.id,
      partNumber: naming.partNumber,
      displayName: naming.displayName,
      ownerUserId: sam.id,
      createdBy: sam.id,
      xmlBlob: Buffer.from(naming.xml),
      spriteBlob: PNG,
      spriteMime: 'image/png',
      createdAt: now,
      updatedAt: now,
    });
    const map = readBbm(readFileSync(join(ROOT, 'packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8')).map;
    const layer = map.layers.find((l) => l.type === 'brick');
    if (!layer || layer.type !== 'brick') throw new Error('no brick sheet');
    layer.bricks = layer.bricks.slice(0, 2);
    layer.groups = [];
    layer.bricks[0]!.partNumber = `custom:${naming.id}`;
    map.layers = [layer];
    const id = '0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b';
    await db.insert(schema.layouts).values({ id, title: 'Harbour', ownerUserId: sam.id, createdBy: sam.id, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(seedFromBbm(map))) });
    return id;
  }

  const expectNamed = (text: string, where: string) => {
    expect(text, where).toContain(naming.partNumber);
    expect(text, where).not.toMatch(/custom:/i);
  };

  it('export.bbm, export.bbm.bld, export.zip and export.bld-layout name it by number', async () => {
    const id = await layoutWithThePart();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: sam.cookie } });

    const bbm = await get(`/api/layouts/${id}/export.bbm`);
    expect(bbm.statusCode).toBe(200);
    expectNamed(bbm.body, 'export.bbm');

    const sidecar = await get(`/api/layouts/${id}/export.bbm.bld`);
    if (sidecar.statusCode === 200) expect(sidecar.body, 'export.bbm.bld').not.toMatch(/custom:/i);

    const zip = await get(`/api/layouts/${id}/export.zip`);
    expect(zip.statusCode).toBe(200);
    const z = readZip(zip.rawPayload);
    expectNamed(z.get('Harbour.bbm')!.toString('utf8'), 'export.zip › .bbm');
    for (const [name, data] of z) expect(data.toString('utf8'), `export.zip › ${name}`).not.toMatch(/custom:/i);

    const bld = await get(`/api/layouts/${id}/export.bld-layout`);
    expect(bld.statusCode).toBe(200);
    const inner = readZip(bld.rawPayload);
    expectNamed(inner.get('layout.bbm')!.toString('utf8'), 'export.bld-layout › layout.bbm');
    for (const [name, data] of inner) expect(data.toString('utf8'), `export.bld-layout › ${name}`).not.toMatch(/custom:/i);
  });

  it('the part number the files use is the one the desktop caches the part under', async () => {
    // The desktop's PartsSync writes custom/<partNumber>.xml with an OldName
    // of custom:<id> (desktop tests/sync/ContractsTest.cpp): the manifest
    // must give it the same id and number.
    await layoutWithThePart();
    const res = await app.inject({ method: 'GET', url: '/api/parts/manifest', headers: { cookie: sam.cookie } });
    expect(res.statusCode).toBe(200);
    const custom = (res.json() as { customParts: { id: string; partNumber: string; xmlUrl: string }[] }).customParts;
    expect(custom).toEqual([expect.objectContaining({ id: naming.id, partNumber: naming.partNumber, xmlUrl: `/api/custom-parts/${naming.id}/xml` })]);
  });
});
