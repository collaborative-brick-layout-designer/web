// A layout's shared modules on the server (docs/shared-modules.md;
// routes/layoutSharedModules.ts, sharedModules/): what the layout places
// and whether each copy still follows its module; the server putting a
// version in (once, however many people press Update at once), going back,
// putting the owner's version back; who may; what happens to placed copies
// when the module is unshared, deleted, restored or its owner's account is
// erased; "Make it mine"; and the parts a module brings, seen through the
// layout it is placed in.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { invalidateLimitCaches } from '../../limits/limits.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { forgetLayout, syncLayoutSharedModules } from '../../sharedModules/placed.js';
import { eraseUser } from '../../privacy/accountDeletion.js';
import { contents, moduleOf, partsOf, place, type Part } from '../../test/sharedWorld.js';

type Who = { cookie: string; id: string };

const V1: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }];
const V2: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }, { pn: 'c.1', x: 8, y: 2 }];
const V3: Part[] = [{ pn: 'd.1', x: -6, y: -6 }];
const FAKE_GIF = Buffer.from('GIF89a    \xff\xff\xff   !\xf9    ,       D ;', 'binary').toString('base64');
const PART_XML = Buffer.from('<?xml version="1.0"?><part/>').toString('base64');

describe('a layout’s shared modules', () => {
  let app: FastifyInstance;
  const open: string[] = [];
  beforeAll(async () => {
    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    await registerApiRoutes(app);
    await app.ready();
  });
  afterAll(async () => {
    closeAll();
    await app.close();
  });
  beforeEach(async () => {
    await docHub.closeMany(open.splice(0));
    resetDb();
    forgetLayout();
    invalidateLimitCaches();
  });

  const call = (who: Who | null, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
  async function club(admin: Who, name: string, ...members: Who[]): Promise<{ id: string; slug: string }> {
    const made = await call(admin, 'POST', '/api/orgs', { name });
    const { id, slug } = made.json() as { id: string; slug: string };
    for (const m of members) await db.insert(schema.orgMembers).values({ orgId: id, userId: m.id, role: 'member', joinedAt: new Date() });
    return { id, slug };
  }
  async function save(who: Who, id: string, parts: Part[], note?: string) {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot${note ? `?note=${encodeURIComponent(note)}` : ''}`,
      headers: { cookie: who.cookie, 'content-type': 'application/octet-stream' },
      payload: contents(parts),
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { version: number }).version;
  }
  async function module(who: Who, title: string, parts: Part[] = V1): Promise<string> {
    const id = ((await call(who, 'POST', '/api/modules', { title })).json() as { id: string }).id;
    await save(who, id, parts);
    return id;
  }
  /** A layout of `owner` (a person, or a club) with `build` run on its document. */
  async function layout(owner: { ownerUserId?: string; ownerOrgId?: string }, createdBy: string, build: (doc: Y.Doc) => void): Promise<string> {
    const id = randomUUID();
    const doc = createDefaultLayoutDoc();
    build(doc);
    const now = new Date();
    await db.insert(schema.layouts).values({ id, title: 'Show plan', ...owner, createdBy, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(doc)) });
    await syncLayoutSharedModules(id, doc);
    doc.destroy();
    open.push(id);
    return id;
  }
  const docOf = async (id: string) => (await docHub.getOrCreate(id)).doc;
  type Listed = { placedId: string; moduleId: string; state: string; version: number; title: string | null; owner: { kind: string; name: string } | null; latest: number | null; latestNote: string | null };
  const list = async (who: Who, id: string) => (await call(who, 'GET', `/api/layouts/${id}/shared-modules`)).json() as { canUpdate: boolean; canDetach: boolean; modules: Listed[] };

  /** Alice's module shared with Riverside LUG and placed, as version 1, in the club's layout at (100, 50). */
  async function world() {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const eve = await loginAs(app, 'eve@example.com');
    const lug = await club(bob, 'Riverside LUG', alice, carol);
    const crane = await module(alice, 'Harbor crane');
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug })).statusCode).toBe(201);
    const v1 = contents(V1);
    const plan = await layout({ ownerOrgId: lug.id }, bob.id, (doc) => {
      place(doc, { placedId: 'placed-1', moduleId: crane, version: 1, bytes: v1, placement: { degrees: 0, x: 100, y: 50 } });
    });
    return { alice, bob, carol, eve, lug, crane, plan };
  }

  it('lists what the layout places, its owner and whether a newer version waits', async () => {
    const { alice, bob, carol, eve, crane, plan } = await world();
    const before = await list(carol, plan);
    expect(before).toMatchObject({ canUpdate: true, canDetach: false });
    expect(before.modules).toEqual([
      { placedId: 'placed-1', moduleId: crane, state: 'shared', version: 1, title: 'Harbor crane', owner: { kind: 'user', name: 'alice' }, latest: 1, latestNote: null, hasPicture: false },
    ]);
    expect((await list(bob, plan)).canDetach).toBe(true);
    await save(alice, crane, V2, 'longer pier');
    expect((await list(carol, plan)).modules[0]).toMatchObject({ version: 1, latest: 2, latestNote: 'longer pier' });
    // Someone who can't open the layout learns nothing.
    expect((await call(eve, 'GET', `/api/layouts/${plan}/shared-modules`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/api/layouts/${plan}/shared-modules`)).statusCode).toBe(401);
  });

  it('Update puts the new version where the module sits, once', async () => {
    const { alice, carol, crane, plan } = await world();
    await save(alice, crane, V2, 'longer pier');
    const r = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 2 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, placedId: 'placed-1', changed: true, version: 2, from: 1, parts: 3 });
    const doc = await docOf(plan);
    expect(partsOf(doc).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 100, 50], ['b.1', 104, 50], ['c.1', 108, 52]]);
    const mod = moduleOf(doc, 'placed-1')!;
    expect(mod).toMatchObject({ name: 'Harbor crane', libraryModuleId: crane, libraryVersion: 2 });
    expect(mod.shared).toMatchObject({ by: 'alice', placement: { degrees: 0, x: 100, y: 50, sheets: { Layout: 'brick-1' } }, review: { from: 1, to: 2 } });
    expect([...mod.members].sort()).toEqual(partsOf(doc).map((p) => p.id).sort());
    // Pressed again: already there, nothing changes.
    const again = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 2 });
    expect(again.json()).toMatchObject({ ok: true, changed: false, version: 2 });
    expect(partsOf(doc)).toHaveLength(3);
    // The list and the stored layout follow.
    expect((await list(carol, plan)).modules[0]).toMatchObject({ version: 2, latest: 2 });
    await docHub.close(plan);
    expect(partsOf(await docOf(plan))).toHaveLength(3);
  });

  it('two people pressing Update at once get the parts once', async () => {
    const { alice, bob, carol, crane, plan } = await world();
    await save(alice, crane, V2);
    const both = await Promise.all([
      call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {}),
      call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {}),
      call(carol, 'POST', `/api/layouts/${plan}/shared-modules/apply-all`),
    ]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const changed = [both[0]!.json().changed, both[1]!.json().changed, (both[2]!.json() as { updated: unknown[] }).updated.length > 0];
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(partsOf(await docOf(plan)).map((p) => p.pn)).toEqual(['a.1', 'b.1', 'c.1']);
  });

  it('with no version named it takes the newest; Go back puts an older one in; a version that is not kept is refused', async () => {
    const { alice, carol, crane, plan } = await world();
    await save(alice, crane, V2);
    await save(alice, crane, V3);
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).json()).toMatchObject({ changed: true, version: 3, from: 1, parts: 1 });
    expect(partsOf(await docOf(plan)).map((p) => [p.pn, p.x, p.y])).toEqual([['d.1', 94, 44]]);
    const back = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 2 });
    expect(back.json()).toMatchObject({ changed: true, version: 2, from: 3, parts: 3 });
    expect(partsOf(await docOf(plan)).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 100, 50], ['b.1', 104, 50], ['c.1', 108, 52]]);
    expect(moduleOf(await docOf(plan), 'placed-1')!.shared).toMatchObject({ review: { from: 3, to: 2 } });
    const noSuch = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 9 });
    expect([noSuch.statusCode, noSuch.json()]).toEqual([409, { error: 'version_not_found' }]);
    for (const bad of [0, -1, 1.5, 'two', true]) {
      expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: bad })).statusCode).toBe(400);
    }
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/no-such/apply`, {})).statusCode).toBe(409);
  });

  it('the update lands where the module was moved and turned to, also when an older app moved it', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const crane = await module(alice, 'Harbor crane');
    const v1 = contents(V1);
    // Turned a quarter and moved, the placement kept up to date.
    const kept = await layout({ ownerUserId: alice.id }, alice.id, (doc) => {
      place(doc, { placedId: 'p', moduleId: crane, version: 1, bytes: v1, placement: { degrees: 90, x: 20, y: 30 } });
    });
    // Placed at (100, 50), then moved by an app that doesn't keep the placement.
    const stale = await layout({ ownerUserId: alice.id }, alice.id, (doc) => {
      place(doc, { placedId: 'p', moduleId: crane, version: 1, bytes: v1, placement: { degrees: 0, x: 100, y: 50 } });
      for (const layer of doc.getMap<Y.Map<unknown>>('layerData').values()) {
        const bricks = layer.get('bricks');
        if (!(bricks instanceof Y.Array)) continue;
        for (const b of bricks as Y.Array<Y.Map<unknown>>) {
          const a = b.get('displayArea') as { x: number; y: number; width: number; height: number };
          b.set('displayArea', { ...a, x: a.x + 16, y: a.y - 8 });
        }
      }
    });
    await save(alice, crane, V2);
    expect((await call(alice, 'POST', `/api/layouts/${kept}/shared-modules/p/apply`, {})).json()).toMatchObject({ changed: true, version: 2 });
    // (x, y) of the version turns to (-y, x): the part at (8, 2), middle (9, 3), lands with its middle at (20 - 3, 30 + 9).
    expect(partsOf(await docOf(kept)).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 18, 30], ['b.1', 18, 34], ['c.1', 16, 38]]);
    expect((await call(alice, 'POST', `/api/layouts/${stale}/shared-modules/p/apply`, {})).json()).toMatchObject({ changed: true, version: 2 });
    expect(partsOf(await docOf(stale)).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 116, 42], ['b.1', 120, 42], ['c.1', 124, 44]]);
    expect(moduleOf(await docOf(stale), 'p')!.shared).toMatchObject({ placement: { degrees: 0, x: 116, y: 42 } });
  });

  it('putting the owner’s version back replaces a copy that was changed outside the app', async () => {
    const { carol, plan } = await world();
    const doc = await docOf(plan);
    // BlueBrick, or an older app, swapped a part: the server's own doc is changed here as a file would be.
    doc.transact(() => {
      for (const layer of doc.getMap<Y.Map<unknown>>('layerData').values()) {
        const bricks = layer.get('bricks');
        if (bricks instanceof Y.Array) (bricks.get(0) as Y.Map<unknown>).set('partNumber', 'zzz.9');
      }
    });
    expect(partsOf(doc).map((p) => p.pn)).toEqual(['b.1', 'zzz.9']);
    // Same version: nothing to do, unless asked to put it back.
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 1 })).json()).toMatchObject({ changed: false });
    const back = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, { version: 1, again: true });
    expect(back.json()).toMatchObject({ changed: true, version: 1, from: 1, parts: 2 });
    expect(partsOf(doc).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 100, 50], ['b.1', 104, 50]]);
    // Not news: no "now version N" notice for the same version.
    expect(moduleOf(doc, 'placed-1')!.shared).not.toHaveProperty('review');
  });

  it('only people who may edit the layout update it, and only its owner makes it theirs', async () => {
    const { alice, bob, carol, eve, lug, crane, plan } = await world();
    await save(alice, crane, V2);
    const viewer = await loginAs(app, 'vi@example.com');
    await db.insert(schema.layoutCollaborators).values({ layoutId: plan, userId: viewer.id, role: 'viewer', addedAt: new Date() });
    // A viewer sees the list and the versions, and can't change anything.
    expect(await list(viewer, plan)).toMatchObject({ canUpdate: false, canDetach: false });
    expect((await call(viewer, 'GET', `/api/layouts/${plan}/shared-modules/placed-1/versions`)).statusCode).toBe(200);
    expect((await call(viewer, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).statusCode).toBe(403);
    expect((await call(viewer, 'POST', `/api/layouts/${plan}/shared-modules/apply-all`)).statusCode).toBe(403);
    expect((await call(viewer, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/detach`)).statusCode).toBe(403);
    for (const path of ['placed-1/apply', 'apply-all', 'placed-1/detach']) {
      expect((await call(eve, 'POST', `/api/layouts/${plan}/shared-modules/${path}`, {})).statusCode).toBe(404);
      expect((await call(null, 'POST', `/api/layouts/${plan}/shared-modules/${path}`, {})).statusCode).toBe(401);
    }
    // A member who edits the club's layouts updates it; making it the club's own is for its admins and managers.
    const refused = await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/detach`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'only_the_layouts_owner' });
    // A member whose role may no longer edit layouts can't update any more.
    await call(bob, 'PATCH', `/api/orgs/${lug.slug}/roles/${lug.id}:member`, { permissions: ['view_items'] });
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).statusCode).toBe(403);
    expect(partsOf(await docOf(plan))).toHaveLength(2);
    expect((await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).statusCode).toBe(200);
  });

  it('Make it mine unlocks the copy, keeps its parts and remembers what it was made from', async () => {
    const { bob, carol, crane, plan } = await world();
    const r = await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/detach`);
    expect(r.json()).toEqual({ ok: true, changed: true });
    const doc = await docOf(plan);
    const mod = moduleOf(doc, 'placed-1')!;
    expect(mod).toMatchObject({ name: 'Harbor crane', basedOn: { moduleId: crane, by: 'alice', version: 1 } });
    expect(mod).not.toHaveProperty('shared');
    expect(mod).not.toHaveProperty('libraryModuleId');
    expect(mod).not.toHaveProperty('libraryVersion');
    expect(partsOf(doc).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    expect([...mod.members].sort()).toEqual(partsOf(doc).map((p) => p.id).sort());
    expect((await list(carol, plan)).modules).toEqual([]);
    // Again: nothing left to do. It no longer follows anything.
    expect((await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/detach`)).json()).toEqual({ ok: true, changed: false });
    expect((await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).statusCode).toBe(409);
    expect((await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/nope/detach`)).statusCode).toBe(409);
  });

  it('a co-editor sees the module’s versions through the layout, without a share of their own', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const dan = await loginAs(app, 'dan@example.com');
    const crane = await module(alice, 'Harbor crane');
    const inv = (await call(alice, 'POST', `/api/modules/${crane}/invites`, { email: 'bob@example.com', role: 'viewer' })).json() as { token: string };
    await call(bob, 'POST', `/api/module-invites/${inv.token}`);
    const yard = await layout({ ownerUserId: bob.id }, bob.id, (doc) => {
      place(doc, { placedId: 'p', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } });
    });
    await db.insert(schema.layoutCollaborators).values({ layoutId: yard, userId: dan.id, role: 'editor', addedAt: new Date() });
    await save(alice, crane, V2, 'longer pier');
    // Dan has no share of the module itself...
    expect((await call(dan, 'GET', `/api/modules/${crane}`)).statusCode).toBe(404);
    expect((await call(dan, 'GET', `/api/modules/${crane}/versions/2/snapshot`)).statusCode).toBe(404);
    // ...and sees it, its versions and their contents through Bob's layout, and may update it there.
    expect((await list(dan, yard)).modules[0]).toMatchObject({ state: 'shared', title: 'Harbor crane', owner: { name: 'alice' }, version: 1, latest: 2 });
    const versions = (await call(dan, 'GET', `/api/layouts/${yard}/shared-modules/p/versions`)).json() as { placed: number; versions: { version: number; note: string | null; author: string | null }[] };
    expect(versions.placed).toBe(1);
    expect(versions.versions.map((v) => [v.version, v.note, v.author])).toEqual([[2, 'longer pier', 'alice'], [1, null, 'alice']]);
    const snap = await call(dan, 'GET', `/api/layouts/${yard}/shared-modules/p/versions/2/snapshot`);
    expect(snap.statusCode).toBe(200);
    expect(snap.headers['content-type']).toBe('application/octet-stream');
    expect(snap.rawPayload.equals(contents(V2))).toBe(false); // a fresh doc each time, so compare what it holds
    const got = new Y.Doc();
    Y.applyUpdate(got, new Uint8Array(snap.rawPayload));
    expect(partsOf(got).map((p) => p.pn)).toEqual(['a.1', 'b.1', 'c.1']);
    for (const n of ['0', '3', 'x', '1.5', '-1']) {
      expect((await call(dan, 'GET', `/api/layouts/${yard}/shared-modules/p/versions/${n}/snapshot`)).statusCode).toBe(404);
    }
    expect((await call(dan, 'GET', `/api/layouts/${yard}/shared-modules/other/versions/1/snapshot`)).statusCode).toBe(404);
    expect((await call(dan, 'POST', `/api/layouts/${yard}/shared-modules/p/apply`, {})).json()).toMatchObject({ changed: true, version: 2 });
  });

  it('a module shared with a person does not follow in a club’s layout, nor a club’s share in a member’s own', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const lug = await club(bob, 'Riverside LUG', alice);
    const mine = await module(alice, 'Shared with Bob');
    const clubs = await module(alice, 'Shared with the club');
    const inv = (await call(alice, 'POST', `/api/modules/${mine}/invites`, { email: 'bob@example.com', role: 'viewer' })).json() as { token: string };
    await call(bob, 'POST', `/api/module-invites/${inv.token}`);
    await call(alice, 'POST', `/api/modules/${clubs}/club-shares`, { orgSlug: lug.slug });
    const both = (doc: Y.Doc) => {
      place(doc, { placedId: 'a-mine', moduleId: mine, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } });
      place(doc, { placedId: 'b-clubs', moduleId: clubs, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 40, y: 0 } });
    };
    const clubLayout = await layout({ ownerOrgId: lug.id }, bob.id, both);
    const bobsOwn = await layout({ ownerUserId: bob.id }, bob.id, both);
    expect((await list(bob, clubLayout)).modules.map((m) => [m.placedId, m.state, m.title])).toEqual([['a-mine', 'unshared', null], ['b-clubs', 'shared', 'Shared with the club']]);
    expect((await list(bob, bobsOwn)).modules.map((m) => [m.placedId, m.state, m.title])).toEqual([['a-mine', 'shared', 'Shared with Bob'], ['b-clubs', 'unshared', null]]);
    await save(alice, mine, V2);
    await save(alice, clubs, V2);
    // Before placing, the apps ask whether a module would follow its owner here, and whom to ask when not.
    const ask = async (who: Who, layoutId: string, moduleId: string) =>
      ((await call(who, 'GET', `/api/layouts/${layoutId}/shared-modules?check=${moduleId}`)).json() as { check?: { state: string; title: string; moduleOwner: { name: string }; layoutOwner: { kind: string; name: string; mine: boolean } } }).check;
    expect(await ask(bob, clubLayout, mine)).toEqual({ moduleId: mine, state: 'unshared', title: 'Shared with Bob', moduleOwner: { kind: 'user', name: 'alice', mine: false }, layoutOwner: { kind: 'org', name: 'Riverside LUG', mine: false } });
    expect(await ask(bob, clubLayout, clubs)).toMatchObject({ state: 'shared' });
    expect(await ask(bob, bobsOwn, mine)).toMatchObject({ state: 'shared', layoutOwner: { kind: 'user', name: 'bob', mine: true } });
    expect(await ask(bob, bobsOwn, clubs)).toMatchObject({ state: 'unshared' });
    // Nothing about a module the caller can't see, or one that doesn't exist.
    const eve = await loginAs(app, 'eve@example.com');
    await db.insert(schema.layoutCollaborators).values({ layoutId: bobsOwn, userId: eve.id, role: 'editor', addedAt: new Date() });
    expect(await ask(eve, bobsOwn, mine)).toBeUndefined();
    expect(await ask(bob, bobsOwn, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
    expect(await ask(bob, bobsOwn, 'x')).toBeUndefined();
    const refused = await call(bob, 'POST', `/api/layouts/${clubLayout}/shared-modules/a-mine/apply`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'no_longer_shared', state: 'unshared' });
    const all = (await call(bob, 'POST', `/api/layouts/${clubLayout}/shared-modules/apply-all`)).json() as { updated: { placedId: string }[]; skipped: { placedId: string; error: string }[] };
    expect(all.updated.map((u) => u.placedId)).toEqual(['b-clubs']);
    expect(all.skipped).toEqual([{ placedId: 'a-mine', error: 'no_longer_shared' }]);
    // The owner's own layout always follows the owner's own module.
    const alices = await layout({ ownerUserId: alice.id }, alice.id, both);
    expect((await list(alice, alices)).modules.map((m) => m.state)).toEqual(['shared', 'shared']);
  });

  it('unsharing and deleting leave the copy in place at its version; sharing again and restoring bring the updates back', async () => {
    const { alice, bob, carol, lug, crane, plan } = await world();
    await save(alice, crane, V2);
    expect((await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(200);
    expect((await list(carol, plan)).modules[0]).toMatchObject({ state: 'unshared', version: 1, title: null, owner: null, latest: null });
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).json()).toEqual({ error: 'no_longer_shared', state: 'unshared' });
    // Its parts stay, and only the version it holds can still be read through the layout.
    expect(partsOf(await docOf(plan)).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    expect((await call(carol, 'GET', `/api/layouts/${plan}/shared-modules/placed-1/versions/1/snapshot`)).statusCode).toBe(200);
    expect((await call(carol, 'GET', `/api/layouts/${plan}/shared-modules/placed-1/versions/2/snapshot`)).statusCode).toBe(404);
    // (An empty list, not a 404: asking about a copy that no longer follows its module is normal use.)
    expect((await call(carol, 'GET', `/api/layouts/${plan}/shared-modules/placed-1/versions`)).json()).toEqual({ placed: 1, versions: [] });
    expect((await call(carol, 'GET', `/api/layouts/${plan}/shared-modules/never-placed/versions`)).json()).toEqual({ placed: 0, versions: [] });

    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect((await list(carol, plan)).modules[0]).toMatchObject({ state: 'shared', latest: 2 });

    const gone = await call(alice, 'DELETE', `/api/modules/${crane}`);
    expect((await list(carol, plan)).modules[0]).toMatchObject({ state: 'gone', version: 1, title: null });
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).json()).toEqual({ error: 'module_gone', state: 'gone' });
    expect((await call(carol, 'GET', `/api/layouts/${plan}/shared-modules/placed-1/versions/1/snapshot`)).statusCode).toBe(404);
    expect(partsOf(await docOf(plan))).toHaveLength(2);
    // The layout's owner can still make it theirs.
    expect((await call(alice, 'POST', `/api/trash/${(gone.json() as { trashId: string }).trashId}/restore`)).statusCode).toBe(200);
    expect((await list(carol, plan)).modules[0]).toMatchObject({ state: 'shared', latest: 2 });
    expect((await call(carol, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/apply`, {})).json()).toMatchObject({ changed: true, version: 2 });
    expect((await call(bob, 'POST', `/api/layouts/${plan}/shared-modules/placed-1/detach`)).statusCode).toBe(200);
  });

  it('a layout that changes owner keeps only the modules shared with its new owner', async () => {
    const { bob, crane, plan } = await world();
    // The club's layout becomes Bob's own: the module is shared with the club, not with him.
    await db.update(schema.layouts).set({ ownerOrgId: null, ownerUserId: bob.id }).where(eq(schema.layouts.id, plan));
    const { notifyAccessChanged } = await import('../../ws/liveAccess.js');
    notifyAccessChanged({ layoutId: plan });
    await expect.poll(async () => (await list(bob, plan)).modules[0]?.state).toBe('unshared');
    expect((await db.select().from(schema.layoutSharedModules).all())[0]).toMatchObject({ moduleId: crane, state: 'unshared' });
  });

  it('a copy of the layout, and the layout restored from Recently deleted, place what it placed', async () => {
    const { bob, carol, crane, plan } = await world();
    // Into the club: the module is shared with the club. Into Carol's own things: it isn't shared with her in person.
    const clubCopy = ((await call(carol, 'POST', `/api/layouts/${plan}/copy`, { orgSlug: 'riverside-lug' })).json() as { id: string }).id;
    const ownCopy = ((await call(carol, 'POST', `/api/layouts/${plan}/copy`, {})).json() as { id: string }).id;
    open.push(clubCopy, ownCopy);
    expect((await list(carol, clubCopy)).modules.map((m) => [m.placedId, m.moduleId, m.state])).toEqual([['placed-1', crane, 'shared']]);
    expect((await list(carol, ownCopy)).modules.map((m) => [m.placedId, m.state])).toEqual([['placed-1', 'unshared']]);
    const gone = await call(bob, 'DELETE', `/api/layouts/${plan}`);
    expect(gone.statusCode).toBe(200);
    expect(await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, plan)).all()).toEqual([]);
    expect((await call(bob, 'POST', `/api/trash/${(gone.json() as { trashId: string }).trashId}/restore`)).statusCode).toBe(200);
    expect((await list(carol, plan)).modules.map((m) => m.state)).toEqual(['shared']);
  });

  it('erasing the owner’s account takes the lock off, credited to "Builder #…"', async () => {
    const { alice, bob, carol, plan } = await world();
    await eraseUser(alice.id, 'self', null);
    const doc = await docOf(plan);
    const mod = moduleOf(doc, 'placed-1')!;
    expect(mod).not.toHaveProperty('shared');
    expect(mod).not.toHaveProperty('libraryModuleId');
    expect(mod.basedOn).toEqual({ by: expect.stringMatching(/^Builder #[0-9a-z]{6}$/) });
    expect(JSON.stringify(mod)).not.toContain('alice');
    expect(partsOf(doc).map((p) => p.pn)).toEqual(['a.1', 'b.1']);
    expect((await list(carol, plan)).modules).toEqual([]);
    expect((await call(bob, 'GET', `/api/layouts/${plan}`)).statusCode).toBe(200);
  });

  it('an ordinary linked module updates through the server too, for someone who can see its library copy', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const crane = await module(alice, 'Harbor crane');
    const yard = await layout({ ownerUserId: alice.id }, alice.id, (doc) => {
      place(doc, { placedId: 'p', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 10, y: 10 }, shared: false });
    });
    await db.insert(schema.layoutCollaborators).values({ layoutId: yard, userId: bob.id, role: 'editor', addedAt: new Date() });
    await save(alice, crane, V2);
    // Not a shared module: it isn't listed, and Bob, who can't see Alice's module, can't pull it in.
    expect((await list(alice, yard)).modules).toEqual([]);
    expect((await call(bob, 'POST', `/api/layouts/${yard}/shared-modules/p/apply`, {})).json()).toEqual({ error: 'module_not_found' });
    const both = await Promise.all([
      call(alice, 'POST', `/api/layouts/${yard}/shared-modules/p/apply`, {}),
      call(alice, 'POST', `/api/layouts/${yard}/shared-modules/p/apply`, {}),
    ]);
    expect(both.map((r) => r.json().changed).sort()).toEqual([false, true]);
    const doc = await docOf(yard);
    // No placement was kept: it is worked out from the parts.
    expect(partsOf(doc).map((p) => [p.pn, p.x, p.y])).toEqual([['a.1', 10, 10], ['b.1', 14, 10], ['c.1', 18, 12]]);
    expect(moduleOf(doc, 'p')).toMatchObject({ libraryVersion: 2 });
    expect(moduleOf(doc, 'p')).not.toHaveProperty('shared');
  });

  it('the parts a shared module brings are seen by everyone who can open a layout it is placed in', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const dan = await loginAs(app, 'dan@example.com');
    const made = await call(alice, 'POST', '/api/custom-parts', { partNumber: 'TOWER', displayName: 'Tower', xmlBase64: PART_XML, spriteBase64: FAKE_GIF, spriteMime: 'image/gif' });
    const tower = (made.json() as { id: string }).id;
    const crane = await module(alice, 'Harbor crane', [{ pn: 'TOWER', x: 0, y: 0 }]);
    const inv = (await call(alice, 'POST', `/api/modules/${crane}/invites`, { email: 'bob@example.com', role: 'viewer' })).json() as { token: string };
    await call(bob, 'POST', `/api/module-invites/${inv.token}`);
    const yard = await layout({ ownerUserId: bob.id }, bob.id, (doc) => {
      place(doc, { placedId: 'p', moduleId: crane, version: 1, bytes: contents([{ pn: 'TOWER', x: 0, y: 0 }]), placement: { degrees: 0, x: 0, y: 0 } });
    });
    const sees = async (who: Who) => ((await call(who, 'GET', '/api/custom-parts')).json() as { parts: { id: string }[] }).parts.some((p) => p.id === tower);
    expect(await sees(dan)).toBe(false);
    await db.insert(schema.layoutCollaborators).values({ layoutId: yard, userId: dan.id, role: 'viewer', addedAt: new Date() });
    expect(await sees(dan)).toBe(true);
    expect((await call(dan, 'GET', `/api/custom-parts/${tower}`)).statusCode).toBe(200);
    // Unshared: the copy stays, the part's picture no longer comes with it.
    await call(alice, 'DELETE', `/api/modules/${crane}/collaborators/${bob.id}`);
    expect(await sees(dan)).toBe(false);
    expect((await call(dan, 'GET', `/api/custom-parts/${tower}`)).statusCode).toBe(404);
  });
});
