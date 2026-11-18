// Read-only module sharing (docs/shared-modules.md, routes/moduleShares.ts):
// a module's owner shares it with a club they're in; its members then see
// it under "Shared with me" and may open it, never change it or share it
// on; the owner's custom parts it uses come along and go with the share;
// the owner sees where it's used as counts and club names only.

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
import { partNumbersIn } from '../../access/moduleShares.js';

type Who = { cookie: string; id: string };

const FAKE_GIF = Buffer.from('GIF89a    \xff\xff\xff   !\xf9    ,       D ;', 'binary').toString('base64');
const PART_XML = Buffer.from('<?xml version="1.0"?><part/>').toString('base64');

/** A module's contents with one part of each number. */
function contents(...partNumbers: string[]): Buffer {
  const doc = createDefaultLayoutDoc();
  const bricks = (doc.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<unknown>;
  partNumbers.forEach((partNumber, i) => {
    const b = new Y.Map<unknown>();
    b.set('id', `b${i}`);
    b.set('partNumber', partNumber);
    b.set('displayArea', { x: i * 8, y: 0, width: 8, height: 8 });
    b.set('orientation', 0);
    bricks.push([b]);
  });
  return Buffer.from(encodeDoc(doc));
}

describe('sharing a module read-only', () => {
  let app: FastifyInstance;
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
  beforeEach(() => {
    resetDb();
    invalidateLimitCaches();
  });

  const call = (who: Who | null, method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
  async function club(admin: Who, name: string, ...members: Who[]): Promise<{ id: string; slug: string }> {
    const made = await call(admin, 'POST', '/api/orgs', { name });
    expect(made.statusCode).toBe(201);
    const { id, slug } = made.json() as { id: string; slug: string };
    for (const m of members) await db.insert(schema.orgMembers).values({ orgId: id, userId: m.id, role: 'member', joinedAt: new Date() });
    return { id, slug };
  }
  async function module(who: Who, title: string, bytes = contents('3001.1'), orgSlug?: string): Promise<string> {
    const made = await call(who, 'POST', '/api/modules', { title, ...(orgSlug ? { orgSlug } : {}) });
    expect(made.statusCode).toBe(201);
    const id = (made.json() as { id: string }).id;
    await save(who, id, bytes);
    return id;
  }
  async function save(who: Who, id: string, bytes: Buffer) {
    const r = await app.inject({ method: 'PUT', url: `/api/modules/${id}/snapshot`, headers: { cookie: who.cookie, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(r.statusCode).toBe(200);
  }
  async function part(who: Who, partNumber: string) {
    const r = await call(who, 'POST', '/api/custom-parts', { partNumber, displayName: `${partNumber} name`, xmlBase64: PART_XML, spriteBase64: FAKE_GIF, spriteMime: 'image/gif' });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  }
  async function invite(from: Who, id: string, to: Who, email: string, role: 'viewer' | 'editor' = 'viewer') {
    const inv = await call(from, 'POST', `/api/modules/${id}/invites`, { email, role });
    expect(inv.statusCode).toBe(200);
    expect((await call(to, 'POST', `/api/module-invites/${(inv.json() as { token: string }).token}`)).statusCode).toBe(200);
  }
  type Listed = { id: string; role: string; owner?: { name: string } | null; sharedVia?: { direct: boolean; clubs: { name: string; slug: string }[] } };
  const sharedWith = async (who: Who) => ((await call(who, 'GET', '/api/modules?owner=shared')).json() as { modules: Listed[] }).modules;
  const parts = async (who: Who) => ((await call(who, 'GET', '/api/custom-parts')).json() as { parts: { id: string; role: string }[] }).parts;

  it('reads the part numbers a module uses', () => {
    expect(partNumbersIn(contents('3001.1', 'TOWER', 'tower')).sort()).toEqual(['3001.1', 'tower']);
    expect(partNumbersIn(Buffer.from('not a doc'))).toEqual([]);
    expect(partNumbersIn(null)).toEqual([]);
  });

  it('a club share puts the module under Shared with me for its members, to look at only', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const eve = await loginAs(app, 'eve@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const crane = await module(alice, 'Harbor crane');

    expect(await sharedWith(bob)).toEqual([]);
    expect((await call(bob, 'GET', `/api/modules/${crane}`)).statusCode).toBe(404);
    const shared = await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect(shared.statusCode).toBe(201);
    expect(shared.json()).toMatchObject({ ok: true, orgId: lug.id, name: 'Riverside LUG' });
    // Again: nothing new, and it says so.
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug })).json()).toMatchObject({ ok: true, already: true });

    const list = await sharedWith(bob);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: crane, role: 'viewer', owner: { name: 'alice' }, sharedVia: { direct: false, clubs: [{ name: 'Riverside LUG', slug: lug.slug }] } });
    // Not among bob's own or his club's modules, and not in the owner's "shared with me".
    expect(((await call(bob, 'GET', '/api/modules')).json() as { modules: Listed[] }).modules).toEqual([]);
    expect(await sharedWith(alice)).toEqual([]);
    expect(await sharedWith(eve)).toEqual([]);

    // He may open it, its versions and its picture route; never change, delete or share it.
    expect((await call(bob, 'GET', `/api/modules/${crane}`)).json()).toMatchObject({ role: 'viewer' });
    expect((await call(bob, 'GET', `/api/modules/${crane}/snapshot`)).statusCode).toBe(200);
    expect((await call(bob, 'GET', `/api/modules/${crane}/versions`)).statusCode).toBe(200);
    expect((await call(bob, 'GET', `/api/modules/${crane}/versions/1/snapshot`)).statusCode).toBe(200);
    expect((await call(bob, 'PATCH', `/api/modules/${crane}`, { title: 'Mine now' })).statusCode).toBe(403);
    expect((await call(bob, 'DELETE', `/api/modules/${crane}`)).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/modules/${crane}/snapshot`, headers: { cookie: bob.cookie, 'content-type': 'application/octet-stream' }, payload: contents('3001.1') })).statusCode).toBe(403);
    expect((await call(bob, 'POST', `/api/modules/${crane}/invites`, { email: 'eve@example.com', role: 'viewer' })).statusCode).toBe(403);
    expect((await call(bob, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug })).statusCode).toBe(403);
    expect((await call(bob, 'GET', `/api/modules/${crane}/shares`)).statusCode).toBe(403);
    // Someone outside the club sees nothing.
    expect((await call(eve, 'GET', `/api/modules/${crane}`)).statusCode).toBe(404);
    expect((await call(eve, 'GET', `/api/modules/${crane}/shares`)).statusCode).toBe(404);

    // Stopping takes it away again; a second stop finds nothing.
    expect((await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(200);
    expect(await sharedWith(bob)).toEqual([]);
    expect((await call(bob, 'GET', `/api/modules/${crane}`)).statusCode).toBe(404);
    expect((await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(404);
  });

  it('the club’s admins and managers can take a module off the club; its owner is told', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const mia = await loginAs(app, 'mia@example.com');
    const lug = await club(bob, 'Riverside LUG', alice, carol);
    await db.insert(schema.orgMembers).values({ orgId: lug.id, userId: mia.id, role: 'manager', joinedAt: new Date() });
    const other = await club(carol, 'Train Club North');
    const crane = await module(alice, 'Harbor crane');
    const share = () => call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    await share();
    // A plain member can't; nor can an admin of some other club.
    expect((await call(carol, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(403);
    expect((await call(carol, 'DELETE', `/api/modules/${crane}/club-shares/${other.id}`)).statusCode).toBe(404);
    expect(await sharedWith(carol)).toHaveLength(1);
    // The club's admin can, and Alice gets a note saying so.
    expect((await call(bob, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(200);
    expect(await sharedWith(carol)).toEqual([]);
    const notes = await db.select().from(schema.warnings).where(eq(schema.warnings.subjectUserId, alice.id)).all();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain('Riverside LUG took your module “Harbor crane” off the club’s shared modules');
    expect(notes[0]!.reason).toContain('Copies already placed in its layouts stay as they are');
    // So can a manager. The owner stopping it herself gets no note.
    await share();
    expect((await call(mia, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(200);
    await share();
    expect((await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`)).statusCode).toBe(200);
    expect(await db.select().from(schema.warnings).where(eq(schema.warnings.subjectUserId, alice.id)).all()).toHaveLength(2);
  });

  it('only with a club you are in; a club’s own module not with itself', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const theirs = await club(bob, 'Train Club North');
    const mine = await club(alice, 'Riverside LUG');
    const crane = await module(alice, 'Harbor crane');
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: theirs.slug })).statusCode).toBe(404);
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: 'no-such-club' })).statusCode).toBe(404);
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, {})).statusCode).toBe(400);
    expect((await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: 7 })).statusCode).toBe(400);
    const clubs = await module(alice, 'Club depot', contents('3001.1'), mine.slug);
    const r = await call(alice, 'POST', `/api/modules/${clubs}/club-shares`, { orgSlug: mine.slug });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'same_club' });
    expect((await call(alice, 'GET', `/api/modules/${clubs}/shares`)).json()).toMatchObject({ canShareWithClubs: false, canShareWithOtherClubs: true, myClubs: [], partners: [], offers: [] });
  });

  it('shared with a person too: both ways show, and each stops on its own', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const crane = await module(alice, 'Harbor crane');
    await invite(alice, crane, bob, 'bob@example.com');
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect((await sharedWith(bob))[0]?.sharedVia).toEqual({ direct: true, clubs: [{ id: lug.id, name: 'Riverside LUG', slug: lug.slug }] });
    await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`);
    expect((await sharedWith(bob))[0]?.sharedVia).toEqual({ direct: true, clubs: [] });
    await call(alice, 'DELETE', `/api/modules/${crane}/collaborators/${bob.id}`);
    expect(await sharedWith(bob)).toEqual([]);
  });

  it('a member who leaves the club loses its shares; the club going takes them all', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const lug = await club(alice, 'Riverside LUG', bob, carol);
    const crane = await module(alice, 'Harbor crane');
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect(await sharedWith(bob)).toHaveLength(1);
    await db.delete(schema.orgMembers).where(eq(schema.orgMembers.userId, bob.id));
    expect(await sharedWith(bob)).toEqual([]);
    expect((await call(bob, 'GET', `/api/modules/${crane}/snapshot`)).statusCode).toBe(404);
    expect(await sharedWith(carol)).toHaveLength(1);
    await db.delete(schema.orgs).where(eq(schema.orgs.id, lug.id));
    expect(await sharedWith(carol)).toEqual([]);
    expect(((await call(alice, 'GET', `/api/modules/${crane}/shares`)).json() as { clubs: unknown[] }).clubs).toEqual([]);
  });

  it('the owner’s custom parts the module uses come along, and go with the share', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const carol = await loginAs(app, 'carol@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const tower = await part(alice, 'TOWER');
    const shed = await part(alice, 'SHED');
    const unused = await part(alice, 'BARN');
    const crane = await module(alice, 'Harbor crane', contents('3001.1', 'tower'));

    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    await invite(alice, crane, carol, 'carol@example.com');
    for (const who of [bob, carol]) {
      const list = await parts(who);
      expect(list.find((p) => p.id === tower)?.role).toBe('viewer');
      expect(list.some((p) => p.id === shed || p.id === unused)).toBe(false);
      expect((await call(who, 'GET', `/api/custom-parts/${tower}`)).statusCode).toBe(200);
      expect((await call(who, 'GET', `/api/custom-parts/${unused}`)).statusCode).toBe(404);
      // To look at, never to change or delete.
      expect((await call(who, 'DELETE', `/api/custom-parts/${tower}`)).statusCode).toBe(403);
    }
    // A new version that uses another part brings that one, and drops the one it no longer uses.
    await save(alice, crane, contents('SHED'));
    for (const who of [bob, carol]) {
      const list = await parts(who);
      expect(list.some((p) => p.id === shed)).toBe(true);
      expect(list.some((p) => p.id === tower)).toBe(false);
    }
    // Stopping each share takes its parts back.
    await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`);
    expect((await parts(bob)).some((p) => p.id === shed)).toBe(false);
    expect((await parts(carol)).some((p) => p.id === shed)).toBe(true);
    await call(alice, 'DELETE', `/api/modules/${crane}/collaborators/${carol.id}`);
    expect((await parts(carol)).some((p) => p.id === shed)).toBe(false);
    expect((await call(carol, 'GET', `/api/custom-parts/${shed}`)).statusCode).toBe(404);
  });

  it('a part shared on its own keeps its role when a module also brings it', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const tower = await part(alice, 'TOWER');
    await db.insert(schema.customPartCollaborators).values({ customPartId: tower, userId: bob.id, role: 'editor', addedAt: new Date() });
    const crane = await module(alice, 'Harbor crane', contents('TOWER'));
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect((await parts(bob)).filter((p) => p.id === tower)).toEqual([expect.objectContaining({ role: 'editor' })]);
    await call(alice, 'DELETE', `/api/modules/${crane}/club-shares/${lug.id}`);
    expect((await parts(bob)).find((p) => p.id === tower)?.role).toBe('editor');
  });

  it('deleting the module ends its shares; restoring it brings them back', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const tower = await part(alice, 'TOWER');
    const crane = await module(alice, 'Harbor crane', contents('TOWER'));
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    const gone = await call(alice, 'DELETE', `/api/modules/${crane}`);
    expect(gone.statusCode).toBe(200);
    expect(await sharedWith(bob)).toEqual([]);
    expect((await parts(bob)).some((p) => p.id === tower)).toBe(false);
    const back = await call(alice, 'POST', `/api/trash/${(gone.json() as { trashId: string }).trashId}/restore`);
    expect(back.statusCode).toBe(200);
    expect((await sharedWith(bob)).map((m) => m.id)).toEqual([crane]);
    expect((await parts(bob)).some((p) => p.id === tower)).toBe(true);
  });

  it('the owner sees who it is shared with and where it is used: counts and club names, never a title', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const dan = await loginAs(app, 'dan@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const crane = await module(alice, 'Harbor crane');
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    await invite(alice, crane, bob, 'bob@example.com');
    const now = new Date();
    const doc = Buffer.from(encodeDoc(createDefaultLayoutDoc()));
    const place = async (title: string, owner: { ownerUserId?: string; ownerOrgId?: string }, createdBy: string, placed = 1) => {
      const id = randomUUID();
      await db.insert(schema.layouts).values({ id, title, ...owner, createdBy, createdAt: now, updatedAt: now, docSnapshot: doc });
      for (let i = 0; i < placed; i++) {
        await db.insert(schema.layoutSharedModules).values({ layoutId: id, placedId: `placed-${i}`, moduleId: crane, version: 1, state: 'shared', updatedAt: now });
      }
    };
    await place('Show plan SECRET-A', { ownerOrgId: lug.id }, bob.id, 2);
    await place('Yard SECRET-B', { ownerOrgId: lug.id }, bob.id);
    await place('Bob at home SECRET-C', { ownerUserId: bob.id }, bob.id);
    await place('Dan private SECRET-D', { ownerUserId: dan.id }, dan.id);

    const r = await call(alice, 'GET', `/api/modules/${crane}/shares`);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { people: { userId: string; email: string; role: string }[]; clubs: { orgId: string; name: string }[]; myClubs: { orgId: string }[]; usedIn: unknown; canShareWithClubs: boolean };
    expect(body.canShareWithClubs).toBe(true);
    expect(body.people).toEqual([expect.objectContaining({ userId: bob.id, email: 'bob@example.com', role: 'viewer' })]);
    expect(body.clubs).toEqual([expect.objectContaining({ orgId: lug.id, name: 'Riverside LUG' })]);
    expect(body.myClubs.map((c) => c.orgId)).toEqual([lug.id]);
    // Two layouts of the club (one places it twice), one of bob's, one of someone it isn't shared with.
    expect(body.usedIn).toEqual({
      layouts: 4,
      clubs: [{ orgId: lug.id, name: 'Riverside LUG', layouts: 2 }],
      people: [{ userId: bob.id, name: 'bob', layouts: 1 }],
      others: 1,
    });
    expect(r.body).not.toContain('SECRET');
    expect(r.body).not.toContain(dan.id);
  });

  it('moving the module into the club it is shared with ends that share', async () => {
    const alice = await loginAs(app, 'alice@example.com');
    const bob = await loginAs(app, 'bob@example.com');
    const lug = await club(alice, 'Riverside LUG', bob);
    const crane = await module(alice, 'Harbor crane');
    await call(alice, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: lug.slug });
    expect((await call(alice, 'POST', `/api/modules/${crane}/transfer`, { recipientOrgSlug: lug.slug })).statusCode).toBe(200);
    expect(await db.select().from(schema.moduleClubShares).all()).toEqual([]);
    // It's the club's own now: under Clubs, not Shared with me.
    expect(await sharedWith(bob)).toEqual([]);
    expect(((await call(bob, 'GET', '/api/modules')).json() as { modules: Listed[] }).modules.map((m) => m.id)).toEqual([crane]);
  });
});
