// Extra copies of a shared module's parts (sharedModules/repair.ts): taken
// out when the layout opens, before an update and after a put-back, keeping
// the owner's; the layout as it was kept first, always; and everything that
// is left alone.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidecarModule } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { sharedModulesIn } from '@cld/modules';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { forgetLayout } from '../../sharedModules/placed.js';
import { planRepair, repairSharedParts, withExtraCopies } from '../../sharedModules/repair.js';
import { invalidateHistorySettings } from '../../history/settings.js';
import * as versions from '../../history/layoutVersions.js';
import { forgetSharedGeometry } from '../../ws/sharedGeometry.js';
import { SHEET, contents, moduleOf, noParts, partsOf, place, type Part } from '../../test/sharedWorld.js';
import { Peer } from './wsPeer.js';

const V1: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }, { pn: 'c.1', x: 8, y: 4 }, { pn: 'c.1', x: 12, y: 4 }];
const V2: Part[] = [...V1, { pn: 'd.1', x: 16, y: 0 }];
const OWNERS = [['a.1', 100, 50], ['b.1', 104, 50], ['c.1', 108, 54], ['c.1', 112, 54]];

let app: FastifyInstance;
let port: number;
let layoutId: string;
let crane: string;
let alice: { cookie: string; id: string };
let bob: { cookie: string; id: string };

type Brick = Y.Map<unknown>;
const list = (doc: Y.Doc, sheet = SHEET) => doc.getMap<Y.Map<unknown>>('layerData').get(sheet)!.get('bricks') as Y.Array<Brick>;
/** A copy of part `id` (with `patch`), first or last in its sheet. */
function copy(doc: Y.Doc, id: string, patch: Record<string, unknown> = {}, where: 'first' | 'last' = 'last', sheet = SHEET): void {
  const from = list(doc).toArray().find((b) => b.get('id') === id)!;
  const n = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ ...from.toJSON(), ...patch })) n.set(k, v);
  list(doc, sheet).insert(where === 'first' ? 0 : list(doc, sheet).length, [n]);
}
const area = (x: number, y: number) => ({ displayArea: { x, y, width: 2, height: 2 } });
const at = (doc: Y.Doc) => partsOf(doc).map((p) => [p.pn, p.x, p.y]);
function addSheet(doc: Y.Doc, id: string): void {
  const l = new Y.Map<unknown>();
  for (const [k, v] of [['id', id], ['type', 'brick'], ['name', 'Scenery'], ['visible', true], ['bricks', new Y.Array()], ['groups', new Y.Array()]] as const) l.set(k, v);
  doc.getMap('layerData').set(id, l);
  doc.getArray<string>('layers').push([id]);
}

/** Store a layout of Bob's that places the crane at (100, 50), changed by `change`. */
async function layout(change: (doc: Y.Doc, ids: string[]) => void, version = 1): Promise<string[]> {
  const doc = createDefaultLayoutDoc();
  const ids = place(doc, { placedId: 'placed-1', moduleId: crane, version, bytes: contents(V1), placement: { degrees: 0, x: 100, y: 50 } });
  doc.transact(() => change(doc, ids));
  layoutId = randomUUID();
  const now = new Date();
  await db.insert(schema.layouts).values({ id: layoutId, title: 'Yard', ownerUserId: bob.id, createdBy: bob.id, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(doc)) });
  return ids;
}
const kept = () => db.select().from(schema.layoutVersions).where(eq(schema.layoutVersions.layoutId, layoutId)).all();
const audits = () => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'shared_module_repair')).all().filter((e) => e.layoutId === layoutId);
/** Open the layout and wait for the look-over to finish. */
async function opened(): Promise<Y.Doc> {
  const s = await docHub.getOrCreate(layoutId);
  await new Promise((r) => setTimeout(r, 20));
  await repairSharedParts(s, { wait: true });
  return s.doc;
}
/** Nothing changed: the document's bytes, its history, the log. */
async function untouched(): Promise<void> {
  const row = db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get()!;
  const before = new Y.Doc();
  Y.applyUpdate(before, row.docSnapshot as Uint8Array);
  const doc = await opened();
  expect(at(doc)).toEqual(at(before));
  expect(doc.store.clients.has(doc.clientID)).toBe(false);
  expect(kept()).toEqual([]);
  expect(audits()).toEqual([]);
  expect(db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, layoutId)).all()).toEqual([]);
}

beforeEach(async () => {
  resetDb();
  forgetLayout();
  forgetSharedGeometry();
  invalidateHistorySettings();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  alice = await loginAs(app, 'alice@example.com');
  bob = await loginAs(app, 'bob@example.com');
  crane = ((await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: alice.cookie }, payload: { title: 'Harbor crane' } })).json() as { id: string }).id;
  await save(V1);
  await db.insert(schema.moduleCollaborators).values({ moduleId: crane, userId: bob.id, role: 'viewer', addedAt: new Date() });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await docHub.close(layoutId);
  closeAll();
  await app.close();
});
async function save(parts: Part[]) {
  const r = await app.inject({ method: 'PUT', url: `/api/modules/${crane}/snapshot`, headers: { cookie: alice.cookie, 'content-type': 'application/octet-stream' }, payload: contents(parts) });
  expect(r.statusCode).toBe(200);
}

describe('extra copies of a shared module’s parts', () => {
  it('go when the layout opens, the owner’s kept, wherever it is in the list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const where of ['first', 'last'] as const) {
      const ids = await layout((doc, all) => {
        copy(doc, all[1]!, { partNumber: 'other.1' }, where);
        copy(doc, all[2]!, area(300, 300), where);
      });
      const doc = await opened();
      expect(at(doc), where).toEqual(OWNERS);
      expect(partsOf(doc).map((p) => p.id).sort()).toEqual([...ids].sort());
      expect(moduleOf(doc, 'placed-1')!.members).toEqual(ids);
      const [v] = kept();
      expect(v).toMatchObject({ reason: 'before-repair' });
      expect(JSON.parse(v!.summary)).toMatchObject({ parts: 6 });
      expect(JSON.parse(audits().at(-1)!.payload!)).toMatchObject({ placedId: 'placed-1', removed: 2, restored: 0, safety: v!.id });
      // Ids and counts in the log, no names.
      const line = log.mock.calls.filter((c) => String(c[0]).includes('tidied up')).at(-1)!;
      expect(line.slice(1)).toEqual([layoutId, crane, 'placed-1', 2, 0, 1, v!.id]);
      await docHub.close(layoutId);
    }
  });

  it('the first is made the owner’s when no copy is', async () => {
    const ids = await layout((doc, all) => {
      const b = list(doc).toArray().find((x) => x.get('id') === all[1])!;
      b.set('partNumber', 'other.1');
      b.set('altitude', 9);
      copy(doc, all[1]!, { partNumber: 'other.2' });
    });
    const doc = await opened();
    expect(at(doc)).toEqual(OWNERS);
    const b = list(doc).toArray().filter((x) => x.get('id') === ids[1]);
    expect(b.map((x) => x.get('altitude'))).toEqual([0]);
  });

  it('once: a second look and a second opening change nothing more', async () => {
    await layout((doc, all) => copy(doc, all[0]!));
    const doc = await opened();
    const state = Y.encodeStateAsUpdate(doc);
    expect(await repairSharedParts((await docHub.getOrCreate(layoutId)), { wait: true })).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
    await (await docHub.getOrCreate(layoutId)).flushSnapshot();
    await docHub.close(layoutId);
    expect(at(await opened())).toEqual(OWNERS);
    expect(kept().filter((v) => v.reason === 'before-repair')).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });

  it('reach people already in the layout as one ordinary edit, and the version kept can be put back', async () => {
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await b.synced;
    await expect.poll(() => at(b.doc)).toEqual(OWNERS);
    // Bob goes on editing: taken, nothing said.
    b.doc.transact(() => b.doc.getMap('fuzzProbe').set('edit', 1));
    const s = await docHub.getOrCreate(layoutId);
    await expect.poll(() => s.doc.getMap('fuzzProbe').get('edit')).toBe(1);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    await expect.poll(() => audits().length).toBe(1);
    const r = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${kept()[0]!.id}/restore`, headers: { cookie: bob.cookie } });
    expect(r.statusCode).toBe(200);
    expect(at(s.doc)).toHaveLength(5);
    await b.leave();
  });

  it('a layout kept first even with version history off; nothing changes when it can’t be kept', async () => {
    await db.update(schema.platformSettings).set({ history: JSON.stringify({ enabled: false }) });
    invalidateHistorySettings();
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    expect(at(await opened())).toEqual(OWNERS);
    expect(kept().map((v) => v.reason)).toEqual(['before-repair']);
    await docHub.close(layoutId);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(versions, 'takeVersion').mockRejectedValue(new Error('disk full'));
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    await untouched();
    spy.mockResolvedValue(null);
    await docHub.close(layoutId);
    await untouched();
  });

  it('keeps what it starts from when someone edits meanwhile', async () => {
    const real = versions.takeVersion;
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    let n = 0;
    vi.spyOn(versions, 'takeVersion').mockImplementation(async (o) => {
      const id = await real(o);
      if (n++ === 0) (await docHub.getOrCreate(layoutId)).doc.getMap('fuzzProbe').set('edit', 1);
      return id;
    });
    const doc = await opened();
    expect(at(doc)).toEqual(OWNERS);
    const ids = JSON.parse(audits()[0]!.payload!) as { safety: string };
    const was = new Y.Doc();
    Y.applyUpdate(was, (await versions.versionState(layoutId, ids.safety))!);
    expect(was.getMap('fuzzProbe').get('edit')).toBe(1);
    expect(at(was)).toHaveLength(5);
  });

  it('opening does not wait for it', async () => {
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    let go!: () => void;
    const real = versions.takeVersion;
    const gate = new Promise<void>((r) => (go = r));
    vi.spyOn(versions, 'takeVersion').mockImplementation(async (o) => {
      await gate;
      return real(o);
    });
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await b.synced;
    expect(at(b.doc)).toHaveLength(5);
    go();
    await expect.poll(() => at(b.doc)).toEqual(OWNERS);
    await b.leave();
  });

  /** Both sets whole, one on each of two sheets; the record names the second sheet. */
  const twoSets = (patch: Record<string, unknown> = {}) => (doc: Y.Doc, all: string[]) => {
    addSheet(doc, 'brick-2');
    all.forEach((id, i) => copy(doc, id, i === 0 ? patch : {}, 'last', 'brick-2'));
    const cache = readSidecarCache(doc)!;
    writeSidecarCache(doc, { ...cache, modules: (cache.modules as SidecarModule[]).map((m) => ({ ...m, shared: { by: 'alice', placement: { degrees: 0, x: 100, y: 50, sheets: { Layout: 'brick-2' } } } })) });
  };
  const sizes = (doc: Y.Doc) => [list(doc).length, list(doc, 'brick-2').length];

  it('two whole sets (two people putting it on another sheet at once) stay on opening', async () => {
    await layout(twoSets());
    await untouched();
    // Each where someone moved it: still whole.
    await docHub.close(layoutId);
    await layout((doc, all) => {
      twoSets()(doc, all);
      for (const b of list(doc)) b.set('displayArea', { ...(b.get('displayArea') as object), x: (b.get('displayArea') as { x: number }).x + 40 });
    });
    await untouched();
  });

  it('… and one that differs at all is repaired', async () => {
    for (const patch of [{ partNumber: 'other.1' }, { altitude: 3 }, area(101, 50)]) {
      await layout(twoSets(patch));
      const doc = await opened();
      expect(at(doc), JSON.stringify(patch)).toEqual(OWNERS);
      expect(list(doc).length + list(doc, 'brick-2').length).toBe(4);
      await docHub.close(layoutId);
    }
  });

  it('… and go to one, on the sheet it is kept on, before an update and after a put-back', async () => {
    await layout(twoSets());
    await save(V2);
    const r = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/shared-modules/placed-1/apply`, headers: { cookie: bob.cookie }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(sizes((await docHub.getOrCreate(layoutId)).doc)).toEqual([0, 5]);
    await docHub.close(layoutId);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await layout(twoSets());
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await b.synced;
    const s = await docHub.getOrCreate(layoutId);
    await new Promise((x) => setTimeout(x, 50));
    expect(sizes(s.doc)).toEqual([4, 4]);
    list(b.doc).get(0).set('altitude', 5);
    await expect.poll(() => sizes(s.doc)).toEqual([0, 4]);
    await b.leave();
  });

  it('put back from its history, the next opening repairs it once more, with one more version; then nothing', async () => {
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    await opened();
    const repairs = () => kept().filter((v) => v.reason === 'before-repair').length;
    for (const n of [1, 2, 3]) {
      expect([repairs(), audits().length]).toEqual([n, n]);
      const first = kept().find((v) => v.reason === 'before-repair')!;
      const r = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${first.id}/restore`, headers: { cookie: bob.cookie } });
      expect(r.statusCode).toBe(200);
      for (let k = 0; k < 3; k++) {
        await (await docHub.getOrCreate(layoutId)).flushSnapshot();
        await docHub.close(layoutId);
        expect(at(await opened())).toEqual(OWNERS);
      }
    }
    expect([repairs(), audits().length]).toEqual([4, 4]);
  });

  it('that can’t be finished leaves no version, however often the layout opens', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = versions.takeVersion;
    // It stops being shared, or someone keeps editing, or the change itself fails, each time after the version was kept.
    const ends: ((doc: Y.Doc) => Promise<void>)[] = [
      async () => void (await db.delete(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, crane))),
      async (doc) => void doc.getMap('fuzzProbe').set('edit', Math.random()),
      async (doc) => void vi.spyOn(doc, 'transact').mockImplementation(() => { throw new Error('no'); }),
    ];
    for (const end of ends) {
      await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
      let made = 0;
      const spy = vi.spyOn(versions, 'takeVersion').mockImplementation(async (o) => {
        const id = await real(o);
        made += 1;
        await end((await docHub.getOrCreate(layoutId)).doc);
        return id;
      });
      for (let k = 0; k < 3; k++) {
        expect(at(await opened())).toHaveLength(5);
        await docHub.close(layoutId);
      }
      expect(made).toBeGreaterThan(0);
      expect(kept()).toEqual([]);
      expect(audits()).toEqual([]);
      spy.mockRestore();
      await db.insert(schema.moduleCollaborators).values({ moduleId: crane, userId: bob.id, role: 'viewer', addedAt: new Date() }).onConflictDoNothing();
    }
    await layout(() => {});
  });

  it('two people opening it at once make one repair, and what one of them changes meanwhile stays', async () => {
    const ids = await layout((doc, all) => {
      copy(doc, all[1]!, { partNumber: 'other.1' });
      copy(doc, all[1]!, { id: '777', ...area(300, 300) });
    });
    const now = new Date();
    await db.insert(schema.layoutCollaborators).values({ layoutId, userId: alice.id, role: 'editor', addedAt: now });
    const real = versions.takeVersion;
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    vi.spyOn(versions, 'takeVersion').mockImplementation(async (o) => {
      const id = await real(o);
      await gate;
      return id;
    });
    const [a, b] = [new Peer(port, layoutId, alice.cookie, new Y.Doc()), new Peer(port, layoutId, bob.cookie, new Y.Doc())];
    await Promise.all([a.synced, b.synced]);
    // Before the repair: a loose part moved, and the whole module moved by 8 (both copies).
    b.doc.transact(() => {
      for (const x of list(b.doc)) {
        const was = x.get('displayArea') as { x: number };
        x.set('displayArea', { ...was, x: was.x + 8 });
      }
    });
    const s = await docHub.getOrCreate(layoutId);
    await expect.poll(() => partsOf(s.doc).find((p) => p.id === '777')?.x).toBe(308);
    go();
    for (const doc of [s.doc, a.doc, b.doc]) {
      await expect.poll(() => partsOf(doc).length).toBe(5);
      expect(partsOf(doc).find((p) => p.id === '777')).toMatchObject({ x: 308, y: 300 });
      expect(partsOf(doc).filter((p) => ids.includes(p.id)).map((p) => [p.pn, p.x, p.y])).toEqual(OWNERS.map(([pn, x, y]) => [pn, (x as number) + 8, y]));
    }
    await expect.poll(() => audits().length).toBe(1);
    expect(kept().filter((v) => v.reason === 'before-repair')).toHaveLength(1);
    const was = new Y.Doc();
    Y.applyUpdate(was, (await versions.versionState(layoutId, kept().find((v) => v.reason === 'before-repair')!.id))!);
    expect(partsOf(was).find((p) => p.id === '777')?.x).toBe(308);
    await Promise.all([a.leave(), b.leave()]);
  });

  it('a moved and turned module stays where it is', async () => {
    const doc = createDefaultLayoutDoc();
    const ids = place(doc, { placedId: 'placed-1', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 90, x: 300, y: -20 } });
    const want = at(doc);
    doc.transact(() => copy(doc, ids[0]!, { partNumber: 'other.1' }, 'first'));
    const shared = sharedModulesIn(readSidecarCache(doc))[0]!;
    const { moduleBatchesFromBytes } = await import('@cld/modules');
    for (const placement of [shared.placement, null, { degrees: 0, x: 100, y: 50 }]) {
      const plan = planRepair(doc, { ...shared, placement }, moduleBatchesFromBytes(contents(V1)), noParts)!;
      expect([plan.remove.size, plan.restore.length]).toEqual([1, 0]);
      expect([...plan.remove][0]!.get('partNumber')).toBe('other.1');
    }
    expect(want).toHaveLength(4);
    await layout(() => {});
  });

  it('a layout at an older version keeps that version’s parts', async () => {
    await save(V2);
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    const doc = await opened();
    expect(at(doc)).toEqual(OWNERS);
    expect(moduleOf(doc, 'placed-1')!.libraryVersion).toBe(1);
  });

  it('go before an update too, so the new version has one of each', async () => {
    const now = new Date();
    await layout((doc, all) => copy(doc, all[1]!, { partNumber: 'other.1' }));
    await db.insert(schema.layoutCollaborators).values({ layoutId, userId: alice.id, role: 'editor', addedAt: now });
    await save(V2);
    const r = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/shared-modules/placed-1/apply`, headers: { cookie: bob.cookie }, payload: {} });
    expect(r.statusCode).toBe(200);
    const s = await docHub.getOrCreate(layoutId);
    expect(at(s.doc)).toEqual([...OWNERS, ['d.1', 116, 50]]);
    expect(kept().some((v) => v.reason === 'before-repair')).toBe(true);
  });

  it('go after a put-back, which leaves as many as there were', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = await layout(() => {});
    const b = new Peer(port, layoutId, bob.cookie, new Y.Doc());
    await b.synced;
    const s = await docHub.getOrCreate(layoutId);
    s.doc.transact(() => copy(s.doc, ids[1]!, { partNumber: 'other.1' }));
    await expect.poll(() => partsOf(b.doc).length).toBe(5);
    b.doc.transact(() => list(b.doc).toArray().find((x) => x.get('id') === ids[1])!.set('altitude', 5));
    await expect.poll(() => at(s.doc)).toEqual(OWNERS);
    await expect.poll(() => at(b.doc)).toEqual(OWNERS);
    expect(list(s.doc).toArray().map((x) => x.get('altitude'))).toEqual([0, 0, 0, 0]);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
    await b.leave();
  });
});

describe('left alone', () => {
  it('a layout with one of each, and one whose part differs (it is for people to decide)', async () => {
    await layout(() => {});
    await untouched();
    await docHub.close(layoutId);
    await layout((doc) => list(doc).get(0).set('partNumber', 'other.1'));
    await untouched();
  });

  it('parts near the module that are not its own, and the module placed twice', async () => {
    await layout((doc, all) => {
      copy(doc, all[1]!, { id: '777', ...area(104.02, 50) });
      place(doc, { placedId: 'placed-2', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 100, y: 50 } });
      place(doc, { placedId: 'placed-3', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 90, x: 400, y: 50 } });
    });
    await untouched();
  });

  it('… even next to a module that is repaired', async () => {
    await layout((doc, all) => {
      place(doc, { placedId: 'placed-2', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 100, y: 50 } });
      copy(doc, all[1]!, { id: '777', ...area(104.02, 50) });
      copy(doc, all[1]!, { partNumber: 'other.1' });
    });
    const doc = await opened();
    expect(at(doc)).toHaveLength(9);
    expect(withExtraCopies(doc)).toEqual([]);
    expect(list(doc).toArray().some((b) => b.get('id') === '777')).toBe(true);
  });

  it('a part left on a sheet the layout no longer lists', async () => {
    await layout((doc, all) => {
      addSheet(doc, 'old');
      copy(doc, all[1]!, { partNumber: 'other.1' }, 'last', 'old');
      doc.getArray('layers').delete(doc.getArray('layers').length - 1, 1);
    });
    const doc = await opened();
    expect(list(doc).length).toBe(4);
    expect(kept()).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('a detached module, and a part two modules list', async () => {
    const extra = (doc: Y.Doc, all: string[], change: (m: SidecarModule[]) => unknown[]) => {
      copy(doc, all[1]!, { partNumber: 'other.1' });
      const cache = readSidecarCache(doc)!;
      writeSidecarCache(doc, { ...cache, modules: change(cache.modules as SidecarModule[]) as SidecarModule[] });
    };
    await layout((doc, all) => extra(doc, all, (ms) => ms.map((m) => ({ ...m, shared: undefined }))));
    await untouched();
    await docHub.close(layoutId);
    await layout((doc, all) => extra(doc, all, (ms) => [...ms, { ...ms[0]!, id: 'other' }]));
    await untouched();
  });

  it('when the owner’s version can’t be had: not shared any more, no such version, no owner, gone', async () => {
    const damaged = (doc: Y.Doc, all: string[]) => copy(doc, all[1]!, { partNumber: 'other.1' });
    await layout(damaged, 7);
    await untouched();
    await docHub.close(layoutId);
    await db.delete(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, crane));
    await layout(damaged);
    await untouched();
    await docHub.close(layoutId);
    await db.insert(schema.moduleCollaborators).values({ moduleId: crane, userId: bob.id, role: 'viewer', addedAt: new Date() });
    await db.update(schema.modules).set({ ownerUserId: null } as never).where(eq(schema.modules.id, crane)).run();
    await layout(damaged);
    await untouched();
    await docHub.close(layoutId);
    await db.delete(schema.modules).where(eq(schema.modules.id, crane));
    await layout(damaged);
    await untouched();
  });

  it('a module most of whose parts are not the version’s', async () => {
    await layout((doc, all) => {
      for (const i of [0, 1, 2]) list(doc).get(i).set('partNumber', `mine.${i}`);
      copy(doc, all[3]!, { partNumber: 'other.1' });
    });
    await untouched();
  });

  it('costs one look at the parts on a large layout', async () => {
    const doc = createDefaultLayoutDoc();
    doc.transact(() => {
      const many = Array.from({ length: 5000 }, (_, i) => {
        const b = new Y.Map<unknown>();
        b.set('id', String(10_000 + i));
        b.set('partNumber', 'loose.1');
        return b;
      });
      list(doc).push(many);
    });
    place(doc, { placedId: 'placed-1', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 100, y: 50 } });
    const t = performance.now();
    expect(withExtraCopies(doc)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    await layout(() => {});
  });
});
