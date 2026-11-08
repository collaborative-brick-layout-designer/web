// A part library an admin installs on a fresh server (no PARTS_DIR/libraries
// folder yet) is in the catalog and its files are served at once: no
// restart, no "Reload parts". Removing it takes it out of the catalog.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bufConcat, db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { adminRoutes } from '../admin.js';
import { partsRoutes, invalidatePartsCache } from '../parts.js';
import { registerPartFiles } from '../partsFiles.js';
import { env } from '../../env.js';

const PART_XML = '<?xml version="1.0"?><part><Author>Test</Author><Description><en>Test rail</en></Description></part>';
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\xff\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00;', 'latin1');

/** A zip of stored (uncompressed) entries, as extractZip reads them. */
function storedZip(files: Record<string, Buffer | string>): Buffer {
  return bufConcat(
    Object.entries(files).map(([name, body]) => {
      const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const nameBytes = Buffer.from(name, 'utf8');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      return bufConcat([header, nameBytes, data]);
    }),
  );
}

describe('installing a part library on a fresh server', () => {
  let app: FastifyInstance;
  let dir: string;
  let savedPartsDir: string;
  let admin: string;

  beforeEach(async () => {
    resetDb();
    invalidatePartsCache();
    dir = mkdtempSync(join(tmpdir(), 'cld-fresh-parts-'));
    // A fresh server: the base library is there, no libraries folder yet.
    mkdirSync(join(dir, 'parts'));
    writeFileSync(join(dir, 'parts', 'BASE.1.xml'), PART_XML);
    writeFileSync(join(dir, 'parts', 'BASE.1.gif'), GIF);
    savedPartsDir = env.partsDir;
    env.partsDir = dir;

    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(adminRoutes);
    await app.register(partsRoutes);
    await registerPartFiles(app, dir);
    admin = (await loginAs(app, 'admin@example.com')).cookie;
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.email, 'admin@example.com'));
  });

  afterEach(async () => {
    await app.close();
    env.partsDir = savedPartsDir;
    invalidatePartsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function catalogKeys(): Promise<Map<string, string | undefined>> {
    const res = await app.inject({ method: 'GET', url: '/api/parts/catalog', headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const parts = (res.json() as { parts: { key: string; spritePath?: string }[] }).parts;
    return new Map(parts.map((p) => [p.key, p.spritePath]));
  }

  it('makes the libraries folder at startup', () => {
    expect(existsSync(join(dir, 'libraries'))).toBe(true);
  });

  it('lists and serves the new parts right after the install, then drops them on removal', async () => {
    // Someone has the catalog open already (the cache is warm).
    const before = await catalogKeys();
    expect(before.has('base.1')).toBe(true);
    expect(before.has('rail.1')).toBe(false);

    const zip = storedZip({ 'RAIL.1.xml': PART_XML, 'RAIL.1.gif': GIF });
    const install = await app.inject({
      method: 'POST',
      url: '/api/admin/part-libraries',
      headers: { cookie: admin },
      payload: { name: 'Rails', slug: 'rails', zipBase64: zip.toString('base64') },
    });
    expect(install.statusCode).toBe(201);

    const after = await catalogKeys();
    expect(after.get('rail.1')).toBe('libraries/rails/RAIL.1.gif');
    for (const file of ['RAIL.1.xml', 'RAIL.1.gif']) {
      const got = await app.inject({ method: 'GET', url: `/parts/libraries/rails/${file}` });
      expect(got.statusCode, file).toBe(200);
    }
    // The base library is still served beside it.
    expect((await app.inject({ method: 'GET', url: '/parts/BASE.1.gif' })).statusCode).toBe(200);

    const { id } = install.json() as { id: string };
    const removed = await app.inject({ method: 'DELETE', url: `/api/admin/part-libraries/${id}`, headers: { cookie: admin } });
    expect(removed.statusCode).toBe(200);
    expect((await catalogKeys()).has('rail.1')).toBe(false);
  });

  it('registers the base library only when PARTS_DIR has parts, not counting installed libraries', async () => {
    const zip = storedZip({ 'RAIL.1.xml': PART_XML, 'RAIL.1.gif': GIF });
    await app.inject({ method: 'POST', url: '/api/admin/part-libraries', headers: { cookie: admin }, payload: { name: 'Rails', slug: 'rails', zipBase64: zip.toString('base64') } });

    let list = (await app.inject({ method: 'GET', url: '/api/admin/part-libraries', headers: { cookie: admin } })).json() as { onDiskBaseParts: number };
    expect(list.onDiskBaseParts).toBe(1);

    // A Docker install: nothing in PARTS_DIR but the libraries folder.
    rmSync(join(dir, 'parts'), { recursive: true, force: true });
    list = (await app.inject({ method: 'GET', url: '/api/admin/part-libraries', headers: { cookie: admin } })).json() as { onDiskBaseParts: number };
    expect(list.onDiskBaseParts).toBe(0);
    const empty = await app.inject({ method: 'POST', url: '/api/admin/part-libraries/install-base', headers: { cookie: admin } });
    expect(empty.statusCode).toBe(409);
    expect((empty.json() as { error: string }).error).toBe('parts_dir_empty');
    const rows = await db.select().from(schema.partLibraries).where(eq(schema.partLibraries.slug, 'bluebrickparts'));
    expect(rows).toHaveLength(0);
  });
});
