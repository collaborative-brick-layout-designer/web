// Layout version history: who may list, keep, restore and copy versions;
// a restore is one change in the live room with a version of the layout as
// it was kept first; a copy out is a new layout as the version was; while
// people edit, a version is kept at most every half hour; many parts
// deleted at once keep one first; the nightly thinning keeps what it says.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { layoutVersionRoutes } from '../layoutVersions.js';
import { createDefaultLayoutDoc, OPS_JOBS_KEY, readRecordsFromDoc, WAYBILLS_KEY, writeRecord } from '@cld/ydoc';
import { docHub } from '../../ws/docHub.js';
import { autoVersion, takeVersion, versionsToDrop } from '../../history/layoutVersions.js';
import { syncDocTo } from '../../history/syncDoc.js';
import { deletedEntries } from '../../history/bulkDelete.js';
import type { DecodedUpdate } from '../../ws/decoded.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let viewer: { cookie: string; id: string };
let stranger: { cookie: string; id: string };
let layoutId: string;
const AUTO_EVERY_MS = 30 * 60 * 1000;

beforeEach(async () => {
  resetDb();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  for (const r of [passwordRoutes, layoutRoutes, layoutVersionRoutes]) await app.register(r);
  owner = await loginAs(app, 'hist-owner@example.com');
  viewer = await loginAs(app, 'hist-viewer@example.com');
  stranger = await loginAs(app, 'hist-stranger@example.com');
  const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title: 'Yard' } });
  layoutId = (res.json() as { id: string }).id;
  db.insert(schema.layoutCollaborators).values({ layoutId, userId: viewer.id, role: 'viewer', addedAt: new Date() }).run();
});

afterEach(async () => {
  await docHub.close(layoutId);
  await app.close();
});

const as = (u: { cookie: string }) => ({ cookie: u.cookie });
const keep = (who = owner, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions`, headers: as(who), payload });
const list = async (who = owner) => (await app.inject({ url: `/api/layouts/${layoutId}/versions`, headers: as(who) })).json() as { versions: { id: string; reason: string; label: string | null; createdBy: { id: string } | null }[]; canRestore: boolean };

async function setMeta(key: string, value: string): Promise<void> {
  const session = await docHub.getOrCreate(layoutId);
  session.doc.getMap('meta').set(key, value);
  await session.flushBatch();
  await docHub.settle(session);
}
async function meta(key: string): Promise<unknown> {
  const session = await docHub.getOrCreate(layoutId);
  return session.doc.getMap('meta').get(key);
}

describe('who may', () => {
  it('viewers see the history; only editors keep or restore; strangers find nothing', async () => {
    const made = await keep(owner, { label: 'Before the show' });
    expect(made.statusCode).toBe(201);
    const { id } = made.json() as { id: string };
    expect((await list(viewer)).versions).toHaveLength(1);
    expect((await list(viewer)).canRestore).toBe(false);
    expect((await list(owner)).canRestore).toBe(true);
    expect((await keep(viewer)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${id}/restore`, headers: as(viewer) })).statusCode).toBe(403);
    for (const [m, url] of [
      ['GET', `/api/layouts/${layoutId}/versions`],
      ['GET', `/api/layouts/${layoutId}/versions/${id}/snapshot`],
      ['POST', `/api/layouts/${layoutId}/versions`],
      ['POST', `/api/layouts/${layoutId}/versions/${id}/restore`],
      ['POST', `/api/layouts/${layoutId}/versions/${id}/copy`],
    ] as const) {
      expect((await app.inject({ method: m, url, headers: as(stranger), ...(m === 'POST' ? { payload: {} } : {}) })).statusCode, `${m} ${url}`).toBe(404);
    }
    // A version id from another layout is not found here.
    const other = (await app.inject({ method: 'POST', url: '/api/layouts', headers: as(stranger), payload: { title: 'Theirs' } })).json() as { id: string };
    const theirs = (await app.inject({ method: 'POST', url: `/api/layouts/${other.id}/versions`, headers: as(stranger), payload: {} })).json() as { id: string };
    expect((await app.inject({ url: `/api/layouts/${layoutId}/versions/${theirs.id}/snapshot`, headers: as(owner) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${theirs.id}/restore`, headers: as(owner) })).statusCode).toBe(404);
  });

  it('the apps may ask for a version before an import or a merge, nothing else', async () => {
    expect((await keep(owner, { reason: 'before-import' })).statusCode).toBe(201);
    expect((await keep(owner, { reason: 'before-restore' })).statusCode).toBe(400);
    expect((await keep(owner, { reason: 'auto' })).statusCode).toBe(400);
    expect((await keep(owner, { label: 7 })).statusCode).toBe(400);
  });
});

describe('restore and copy', () => {
  it('puts a version back as one change, keeping the layout as it was first', async () => {
    await setMeta('author', 'first');
    const v1 = (await keep(owner, { label: 'One' })).json() as { id: string };
    await setMeta('author', 'second');
    const res = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${v1.id}/restore`, headers: as(owner) });
    expect(res.statusCode).toBe(200);
    expect(await meta('author')).toBe('first');
    const { safety } = res.json() as { safety: string };
    const versions = (await list()).versions;
    expect(versions.find((v) => v.id === safety)?.reason).toBe('before-restore');
    // Restoring that one undoes the restore.
    await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${safety}/restore`, headers: as(owner) });
    expect(await meta('author')).toBe('second');
    const audit = db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.layoutId, layoutId), eq(schema.auditEvents.eventType, 'restore_version'))).all();
    expect(audit).toHaveLength(2);
  });

  it('waybills and jobs go back with it; a version from before there were any leaves their maps empty', async () => {
    const session = await docHub.getOrCreate(layoutId);
    const bare = createDefaultLayoutDoc();
    const old = { id: (await takeVersion({ layoutId, state: Y.encodeStateAsUpdate(bare), reason: 'manual', by: owner.id, editors: [] }))! };
    session.doc.transact(() => {
      writeRecord(session.doc, WAYBILLS_KEY, { id: 'wb-1', car: 'c1', leg: 1, to1: 'pl-1' });
      writeRecord(session.doc, OPS_JOBS_KEY, { id: 'jb-1', name: 'Turn', stop_a: { place: 'pl-1', at: 1 } });
    });
    await session.flushBatch();
    const then = (await keep(owner, { label: 'Then' })).json() as { id: string };
    const restore = async (id: string) => expect((await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${id}/restore`, headers: as(owner) })).statusCode).toBe(200);
    await restore(old.id);
    for (const key of [WAYBILLS_KEY, OPS_JOBS_KEY] as const) {
      expect(session.doc.getMap('meta').get(key)).toBeInstanceOf(Y.Map);
      expect(readRecordsFromDoc(session.doc, key)).toEqual([]);
    }
    await restore(then.id);
    expect(readRecordsFromDoc(session.doc, WAYBILLS_KEY)).toEqual([{ id: 'wb-1', car: 'c1', leg: 1, to1: 'pl-1' }]);
    expect(readRecordsFromDoc(session.doc, OPS_JOBS_KEY)).toEqual([{ id: 'jb-1', name: 'Turn', stop_a: { place: 'pl-1', at: 1 } }]);
  });

  it('copies a version out as a new layout, leaving this one as it is', async () => {
    await setMeta('author', 'then');
    const v = (await keep(owner, {})).json() as { id: string };
    await setMeta('author', 'now');
    const res = await app.inject({ method: 'POST', url: `/api/layouts/${layoutId}/versions/${v.id}/copy`, headers: as(viewer), payload: {} });
    expect(res.statusCode).toBe(201);
    const copy = res.json() as { id: string; title: string };
    expect(copy.title).toBe('Yard (earlier version)');
    const row = db.select().from(schema.layouts).where(eq(schema.layouts.id, copy.id)).get()!;
    expect(row.ownerUserId).toBe(viewer.id);
    const d = new Y.Doc();
    Y.applyUpdate(d, row.docSnapshot as Uint8Array);
    expect(d.getMap('meta').get('author')).toBe('then');
    expect(await meta('author')).toBe('now');
  });
});

describe('when versions are kept', () => {
  it('while editing: the first at once, then not again within half an hour, and never the same twice', async () => {
    const state = (await docHub.getOrCreate(layoutId)).doc;
    const now = Date.now();
    const a = await autoVersion(layoutId, Y.encodeStateAsUpdate(state), [{ id: owner.id, name: 'O' }], now);
    expect(a).not.toBeNull();
    state.getMap('meta').set('x', 1);
    expect(await autoVersion(layoutId, Y.encodeStateAsUpdate(state), [], now + 60_000)).toBeNull();
    const b = await autoVersion(layoutId, Y.encodeStateAsUpdate(state), [], now + AUTO_EVERY_MS + 1);
    expect(b).not.toBe(a);
    // Unchanged since: the newest is kept, not a copy.
    expect(await autoVersion(layoutId, Y.encodeStateAsUpdate(state), [], now + 2 * AUTO_EVERY_MS + 2)).toBe(b);
    expect((await list()).versions).toHaveLength(2);
  });

  it('counts the parts one edit deletes', () => {
    const doc = new Y.Doc();
    const bricks = doc.getArray<Y.Map<unknown>>('bricks');
    bricks.push(Array.from({ length: 60 }, (_, i) => new Y.Map([['id', `b${i}`]])));
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(other);
    other.getArray('bricks').delete(0, 55);
    const update = Y.encodeStateAsUpdate(other, sv);
    const decoded = Y.decodeUpdate(update) as unknown as DecodedUpdate;
    expect(deletedEntries(doc, decoded.ds)).toBe(55);
    expect(deletedEntries(doc, decoded.ds, 50)).toBeGreaterThanOrEqual(50);
  });

  it('thins out: all of the last day, one a day for a month, one a week for half a year; named ones stay', () => {
    const DAY = 86_400_000;
    const now = 1000 * DAY;
    const rows = [
      { id: 'today-1', reason: 'auto', label: null, createdAt: now - 1000 },
      { id: 'today-2', reason: 'auto', label: null, createdAt: now - 2000 },
      { id: 'd3-new', reason: 'auto', label: null, createdAt: now - 3 * DAY + 3_600_000 },
      { id: 'd3-old', reason: 'auto', label: null, createdAt: now - 3 * DAY },
      { id: 'before-old', reason: 'before-import', label: null, createdAt: now - 40 * DAY },
      { id: 'before-new', reason: 'before-import', label: null, createdAt: now - 20 * DAY },
      { id: 'named', reason: 'manual', label: 'Show', createdAt: now - 400 * DAY },
      { id: 'ancient', reason: 'auto', label: null, createdAt: now - 400 * DAY },
    ];
    expect(versionsToDrop(rows, now).sort()).toEqual(['ancient', 'before-old', 'd3-old']);
  });
});

describe('syncDocTo', () => {
  it('makes a doc hold what another holds, keeping unchanged entries by id', () => {
    const target = new Y.Doc();
    target.getMap('meta').set('author', 'A');
    const ld = new Y.Map();
    const bricks = new Y.Array();
    bricks.push([new Y.Map([['id', 'a'], ['x', 1]]), new Y.Map([['id', 'b'], ['x', 2]])]);
    ld.set('bricks', bricks);
    target.getMap('layerData').set('L1', ld);
    target.getArray('layers').push(['L1']);
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(target));
    const keptA = (live.getMap('layerData').get('L1') as Y.Map<Y.Array<Y.Map<unknown>>>).get('bricks')!.get(0);
    // Change the live one: move a, delete b, add c, a new sheet, a new meta key.
    live.transact(() => {
      const lb = (live.getMap('layerData').get('L1') as Y.Map<Y.Array<Y.Map<unknown>>>).get('bricks')!;
      lb.get(0).set('x', 9);
      lb.delete(1, 1);
      lb.push([new Y.Map([['id', 'c']])]);
      live.getMap('meta').set('extra', true);
      live.getArray('layers').push(['L2']);
    });
    // From a decoded copy, as the server reads a stored version.
    const stored = new Y.Doc();
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(target));
    syncDocTo(live, stored, 'test');
    expect(live.getMap('meta').toJSON()).toEqual({ author: 'A' });
    expect(live.getArray('layers').toJSON()).toEqual(['L1']);
    expect(live.getMap('layerData').toJSON()).toEqual(target.getMap('layerData').toJSON());
    // The same entry, edited back, not deleted and inserted.
    const nowA = (live.getMap('layerData').get('L1') as Y.Map<Y.Array<Y.Map<unknown>>>).get('bricks')!.get(0);
    expect(nowA).toBe(keptA);
  });
});

it('takeVersion returns null for a layout that is gone', async () => {
  expect(await takeVersion({ layoutId: '00000000-0000-0000-0000-000000000000', state: new Uint8Array([0, 0]), reason: 'manual' })).toBeNull();
});
