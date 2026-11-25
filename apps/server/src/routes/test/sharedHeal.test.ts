// Putting a layout in shape when it opens (sharedModules/heal.ts): the layout
// as it was kept first whatever its settings, else nothing changes; logged
// and audited by ids and counts; and never for anything the apps, imports,
// uploads or restores make.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modulePlaces } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { invalidateHistorySettings } from '../../history/settings.js';
import * as versions from '../../history/layoutVersions.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { needsHeal } from '../../ws/sharedGuard.js';
import { forgetLayout } from '../../sharedModules/placed.js';
import { SHEET, contents, moduleOf, oddParts, oddSidecar, partsOf, place } from '../../test/sharedWorld.js';
import { readZip } from '../../test/zip.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const V1 = contents([{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }]);

let app: FastifyInstance;
let alice: { cookie: string; id: string };
let crane: string;
const opened: string[] = [];

beforeEach(async () => {
  resetDb();
  forgetLayout();
  invalidateHistorySettings();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  alice = await loginAs(app, 'alice@example.com');
  crane = ((await call('POST', '/api/modules', { title: 'Crane' })).json() as { id: string }).id;
  const r = await app.inject({ method: 'PUT', url: `/api/modules/${crane}/snapshot`, headers: { cookie: alice.cookie, 'content-type': 'application/octet-stream' }, payload: V1 });
  expect(r.statusCode).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await docHub.closeMany(opened.splice(0));
  closeAll();
  await app.close();
});

const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { cookie: alice.cookie }, ...(payload ? { payload } : {}) });
async function layout(build: (doc: Y.Doc) => void): Promise<{ id: string; bytes: Buffer }> {
  const id = randomUUID();
  const doc = createDefaultLayoutDoc();
  place(doc, { placedId: 'placed', moduleId: crane, version: 1, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
  build(doc);
  const bytes = Buffer.from(encodeDoc(doc));
  const now = new Date();
  await db.insert(schema.layouts).values({ id, title: 'Plan', ownerUserId: alice.id, createdBy: alice.id, createdAt: now, updatedAt: now, docSnapshot: bytes });
  opened.push(id);
  return { id, bytes };
}
const open = async (id: string) => {
  const s = await docHub.getOrCreate(id);
  await s.flushBatch();
  return s;
};
const kept = (id: string) => db.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.layoutId, id)).all();
const audits = () => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'shared_module_repair')).all();
const rows = (id: string) => db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id)).all();

describe('putting a layout in shape on opening', () => {
  it('keeps it as it was first, with history off too; logs and audits ids and counts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await db.update(schema.platformSettings).set({ history: JSON.stringify({ enabled: false }) });
    invalidateHistorySettings();
    const { id, bytes } = await layout((d) => {
      oddSidecar(d);
      oddParts(d);
    });
    const before = new Y.Doc();
    Y.applyUpdate(before, bytes);
    const s = await open(id);
    expect(needsHeal(s.doc)).toBe(false);
    expect(partsOf(s.doc).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    expect(modulePlaces(moduleOf(s.doc, 'placed')!)).toEqual([]);
    const versions = await kept(id);
    expect(versions.map((v) => v.reason)).toEqual(['before-repair']);
    // It is the layout as it was, whole.
    const was = new Y.Doc();
    Y.applyUpdate(was, (await import('node:zlib')).inflateRawSync(versions[0]!.docSnapshot as Buffer));
    expect(was.toJSON()).toEqual(before.toJSON());
    expect(await vi.waitFor(async () => { const a = await audits(); expect(a).toHaveLength(1); return a[0]!.payload; })).toBeTruthy();
    const payload = JSON.parse(String((await audits())[0]!.payload)) as object;
    expect(payload).toEqual({ nested: 1, second: 1, fields: 1, entries: 1, sheets: 0, places: 1, safety: versions[0]!.id });
    expect(log.mock.calls.some((c) => String(c[0]).includes('put layout %s in shape') && c[1] === id)).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Other|Crane|alice/);
    // Once.
    await docHub.close(id);
    await open(id);
    expect(await kept(id)).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('changes nothing when the layout can’t be kept first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(versions, 'takeVersion').mockResolvedValue(null);
    const { id } = await layout(oddSidecar);
    const s = await open(id);
    expect(needsHeal(s.doc)).toBe(true);
    expect(await rows(id)).toEqual([]);
    expect(await audits()).toEqual([]);
    // It is open and can be edited all the same.
    writeSidecarCache(s.doc, { ...readSidecarCache(s.doc)!, note: 'x' });
    expect(readSidecarCache(s.doc)).toMatchObject({ note: 'x' });
  });

  it('is never asked for by what the apps make: placed, moved to another sheet, duplicated ids of ordinary modules, updated, made the layout’s own, restored', async () => {
    const take = vi.spyOn(versions, 'takeVersion');
    const { id } = await layout((d) => {
      // Two ordinary modules with one id, as a file edited by hand may have.
      const cache = readSidecarCache(d)!;
      d.getMap('meta').set('cache', { ...cache, modules: [...(cache.modules as object[]), { id: 'same', name: 'A', members: [] }, { id: 'same', name: 'B', members: [] }] });
    });
    const s = await open(id);
    expect(needsHeal(s.doc)).toBe(false);
    const list = s.doc.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks') as Y.Array<Y.Map<unknown>>;
    s.doc.transact(() => {
      const all = list.toArray().map((b) => b.toJSON());
      list.delete(0, list.length);
      const sheet = new Y.Map<unknown>(Object.entries({ id: 'b2', type: 'brick', name: 'Two' }));
      s.doc.getMap('layerData').set('b2', sheet);
      const bricks = new Y.Array<unknown>();
      sheet.set('bricks', bricks);
      bricks.push(all.map((b) => new Y.Map(Object.entries(b))));
      s.doc.getArray('layers').push(['b2']);
    });
    expect(needsHeal(s.doc)).toBe(false);
    expect((await call('POST', `/api/layouts/${id}/shared-modules/placed/apply`, { version: 1, again: true })).statusCode).toBe(200);
    expect(needsHeal(s.doc)).toBe(false);
    expect((await call('POST', `/api/layouts/${id}/shared-modules/placed/detach`)).statusCode).toBe(200);
    expect(needsHeal(s.doc)).toBe(false);
    expect(take.mock.calls.filter((c) => c[0].reason === 'before-repair')).toEqual([]);
  });

  it('is never asked for by a .bbm or a layout file, of either app, uploaded and opened', async () => {
    const files = readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(bbm|bld-layout)$/.test(f));
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) {
      const bytes = readFileSync(join(FIXTURES, f));
      const zip = f.endsWith('.bbm') ? null : readZip(bytes);
      const text = (end: RegExp) => [...(zip ?? [])].find(([name]) => end.test(name))?.[1].toString('utf8');
      const bbm = zip ? text(/\.bbm$/)! : bytes.toString('utf8');
      const sidecar = text(/sidecar|\.bld$/);
      const r = await call('POST', '/api/layouts', { title: f, bbm, ...(sidecar ? { sidecar } : {}) });
      expect(r.statusCode, `${f}: ${r.body.slice(0, 200)}`).toBeLessThan(300);
      const { id } = r.json() as { id: string };
      opened.push(id);
      const s = await open(id);
      expect(needsHeal(s.doc), f).toBe(false);
      expect((await kept(id)).filter((v) => v.reason === 'before-repair'), f).toEqual([]);
    }
  });
});
