// The demo account: an admin switches it on in Admin › Settings, "Try the
// demo" signs visitors in to it, it resets itself (deleting only its own
// things and putting the samples back), and it can't reach anyone else.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import http from 'node:http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { registerApiRoutes } from '../routes/all.js';
import { registerChangeHints } from '../events/routeHints.js';
import { closeAll } from '../events/hub.js';
import { DEMO_DISPLAY_NAME, DEMO_USER_ID, demoResetDue, demoStatus, isDemoUser, nextDemoReset } from './demoAccount.js';
import { DEMO_SAMPLES } from './reset.js';
import { demoTick } from '../workers/index.js';
import { getPlatformSettings } from '../auth/platformSettings.js';

let app: FastifyInstance;
let admin: { cookie: string; id: string };
let alice: { cookie: string; id: string };

beforeEach(async () => {
  resetDb();
  db.delete(schema.venueLibrary).run();
  db.delete(schema.catalogItems).run();
  app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  registerChangeHints(app);
  await registerApiRoutes(app);
  admin = await loginAs(app, 'admin@example.com');
  db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
  alice = await loginAs(app, 'alice@example.com');
});
afterEach(async () => {
  closeAll();
  await app.close();
});

type Req = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; cookie?: string; payload?: unknown };
const call = (r: Req) =>
  app.inject({
    method: r.method ?? 'GET',
    url: r.url,
    headers: r.cookie ? { cookie: r.cookie } : {},
    ...(r.payload === undefined ? {} : { payload: r.payload as Record<string, unknown> }),
  });
const setDemo = (payload: Record<string, unknown>, who = admin) => call({ method: 'PATCH', url: '/api/admin/settings', cookie: who.cookie, payload });
const resetNow = (who: { cookie: string } = admin) => call({ method: 'POST', url: '/api/admin/demo/reset', cookie: who.cookie, payload: {} });
const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const sc = res.headers['set-cookie'];
  return Array.isArray(sc) ? sc.join('; ') : String(sc ?? '');
};
async function tryDemo(): Promise<string> {
  const res = await call({ method: 'POST', url: '/api/auth/demo', payload: {} });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/json');
  return cookieOf(res);
}
const owned = (table: typeof schema.layouts | typeof schema.modules | typeof schema.venueLibrary | typeof schema.customParts, userId: string) =>
  db.select().from(table).where(eq(table.ownerUserId, userId)).all();
const titles = (userId: string) => (owned(schema.layouts, userId) as { title: string }[]).map((l) => l.title).sort();

describe('the demo account is off until an admin turns it on', () => {
  it('starts off: no account, no "Try the demo", and signing in to it is refused', async () => {
    expect((await call({ url: '/api/auth/providers' })).json()).toMatchObject({ demoEnabled: false });
    expect((await call({ method: 'POST', url: '/api/auth/demo' })).statusCode).toBe(404);
    expect(db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get()).toBeUndefined();
    const settings = (await call({ url: '/api/admin/settings', cookie: admin.cookie })).json() as { demo: Record<string, unknown> };
    expect(settings.demo).toEqual({ enabled: false, resetEvery: 'daily', lastResetAt: null, nextResetAt: null, items: 0 });
  });

  it('only site admins may change it or reset it, and changes are audited', async () => {
    expect((await setDemo({ demoEnabled: true }, alice)).statusCode).toBe(403);
    expect((await resetNow(alice)).statusCode).toBe(403);
    expect((await call({ method: 'POST', url: '/api/admin/demo/reset', payload: {} })).statusCode).toBe(401);
    expect((await getPlatformSettings()).demoEnabled).toBe(false);

    expect((await setDemo({ demoEnabled: true, demoResetEvery: '6h' })).statusCode).toBe(200);
    const patches = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_settings_patch')).all();
    expect(patches.map((e) => JSON.parse(String(e.payload)) as unknown)).toContainEqual(expect.objectContaining({ patch: expect.objectContaining({ demoEnabled: true, demoResetEvery: '6h' }) }));
    expect((await resetNow()).statusCode).toBe(200);
    const resets = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_demo_reset')).all();
    expect(resets).toHaveLength(1);
    expect(resets[0]!.userId).toBe(admin.id);
  });

  it('takes only 1 hour, 6 hours or daily', async () => {
    for (const bad of ['weekly', '2h', '', 7, null]) expect((await setDemo({ demoResetEvery: bad })).statusCode).toBe(400);
    for (const ok of ['1h', '6h', 'daily']) {
      expect((await setDemo({ demoResetEvery: ok })).statusCode).toBe(200);
      expect((await getPlatformSettings()).demoResetEvery).toBe(ok);
    }
  });
});

describe('turning it on', () => {
  it('makes the demo account with fresh samples, and Try the demo signs in to it', async () => {
    expect((await setDemo({ demoEnabled: true })).statusCode).toBe(200);
    const user = db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get()!;
    expect(user).toMatchObject({ displayName: DEMO_DISPLAY_NAME, passwordHash: null, isDemoAccount: true, isGlobalAdmin: false });
    expect(titles(DEMO_USER_ID)).toEqual([DEMO_SAMPLES.layout.title]);
    expect((owned(schema.modules, DEMO_USER_ID) as { title: string }[]).map((m) => m.title)).toEqual([DEMO_SAMPLES.module.title]);
    const venues = owned(schema.venueLibrary, DEMO_USER_ID) as { name: string; data: string }[];
    expect(venues.map((v) => v.name)).toEqual(['Grand Lobby, Hot Springs Convention Center']);
    expect(JSON.parse(venues[0]!.data)).not.toHaveProperty('schema');
    // The sample layout is the real fixture, not an empty doc.
    const layout = owned(schema.layouts, DEMO_USER_ID)[0] as { docSnapshot: Uint8Array };
    expect(layout.docSnapshot.length).toBeGreaterThan(10_000);

    const settings = (await call({ url: '/api/admin/settings', cookie: admin.cookie })).json() as { demo: { enabled: boolean; lastResetAt: number; nextResetAt: number; items: number } };
    expect(settings.demo.enabled).toBe(true);
    expect(settings.demo.items).toBe(3);
    expect(settings.demo.nextResetAt - settings.demo.lastResetAt).toBe(24 * 3600_000);
    expect((await call({ url: '/api/auth/providers' })).json()).toMatchObject({ demoEnabled: true });

    const demo = await tryDemo();
    const me = (await call({ url: '/api/auth/me', cookie: demo })).json() as { user: { id: string; isDemoAccount: boolean; demo: { resetEvery: string; nextResetAt: number } } };
    expect(me.user).toMatchObject({ id: DEMO_USER_ID, isDemoAccount: true, demo: { resetEvery: 'daily', nextResetAt: settings.demo.nextResetAt } });
    // Everyone else's /me has no demo block.
    expect(((await call({ url: '/api/auth/me', cookie: alice.cookie })).json() as { user: object }).user).not.toHaveProperty('demo');
    const list = (await call({ url: '/api/layouts', cookie: demo })).json() as { layouts: { title: string }[] };
    expect(list.layouts.map((l) => l.title)).toEqual([DEMO_SAMPLES.layout.title]);
  });

  it('the first Try the demo puts the samples in if no reset has run yet', async () => {
    await getPlatformSettings();
    db.update(schema.platformSettings).set({ demoEnabled: true }).run();
    await tryDemo();
    expect(titles(DEMO_USER_ID)).toEqual([DEMO_SAMPLES.layout.title]);
    expect((await getPlatformSettings()).demoLastResetAt).not.toBeNull();
  });

  it('shows on the admin dashboard instead of a demo-user count', async () => {
    const people = async () => (await call({ url: '/api/admin/insights/people', cookie: admin.cookie })).json() as { totals: object; demo: object };
    expect((await people()).demo).toEqual({ enabled: false, lastResetAt: null, items: 0 });
    await setDemo({ demoEnabled: true });
    const on = await people();
    expect(on.demo).toMatchObject({ enabled: true, items: 3 });
    expect((on.demo as { lastResetAt: number }).lastResetAt).toBeGreaterThan(0);
    expect(on.totals).not.toHaveProperty('demo');
  });

  it('re-enables an account an admin changed, without giving it powers', async () => {
    await setDemo({ demoEnabled: true });
    db.update(schema.users).set({ displayName: 'Hacked', isModerator: true }).where(eq(schema.users.id, DEMO_USER_ID)).run();
    await setDemo({ demoEnabled: false });
    await setDemo({ demoEnabled: true });
    expect(db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get()).toMatchObject({ displayName: DEMO_DISPLAY_NAME, isModerator: false });
    // …and an admin can't make it an admin or a moderator.
    for (const payload of [{ isGlobalAdmin: true }, { isModerator: true }]) {
      expect((await call({ method: 'PATCH', url: `/api/admin/users/${DEMO_USER_ID}`, cookie: admin.cookie, payload })).statusCode).toBe(400);
    }
    expect(db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get()).toMatchObject({ isGlobalAdmin: false, isModerator: false });
  });

  it('turning it off signs the demo out everywhere and hides Try the demo', async () => {
    await setDemo({ demoEnabled: true });
    const one = await tryDemo();
    const two = await tryDemo();
    expect(((await call({ url: '/api/auth/me', cookie: one })).json() as { user: unknown }).user).not.toBeNull();
    await setDemo({ demoEnabled: false });
    for (const c of [one, two]) expect(((await call({ url: '/api/auth/me', cookie: c })).json() as { user: unknown }).user).toBeNull();
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.userId, DEMO_USER_ID)).all()).toHaveLength(0);
    expect((await call({ method: 'POST', url: '/api/auth/demo', payload: {} })).statusCode).toBe(404);
    expect((await call({ url: '/api/auth/providers' })).json()).toMatchObject({ demoEnabled: false });
    expect((await resetNow()).statusCode).toBe(409);
    // Other people stay signed in.
    expect(((await call({ url: '/api/auth/me', cookie: alice.cookie })).json() as { user: { id: string } }).user.id).toBe(alice.id);
  });
});

describe('a reset', () => {
  it('deletes only what the demo account owns and puts the samples back', async () => {
    // Alice's things, which must survive.
    const aliceLayout = (await call({ method: 'POST', url: '/api/layouts', cookie: alice.cookie, payload: { title: 'Alice layout' } })).json() as { id: string };
    await call({ method: 'POST', url: '/api/modules', cookie: alice.cookie, payload: { title: 'Alice module' } });
    await call({ method: 'POST', url: '/api/venues', cookie: alice.cookie, payload: { name: 'Alice room', data: { name: 'Alice room', edges: [] } } });

    await setDemo({ demoEnabled: true });
    const demo = await tryDemo();
    const sample = owned(schema.layouts, DEMO_USER_ID)[0] as { id: string };
    // The visitor builds things: renames the sample, makes a layout, a module and a room.
    expect((await call({ method: 'PATCH', url: `/api/layouts/${sample.id}`, cookie: demo, payload: { title: 'Visitor was here' } })).statusCode).toBe(200);
    expect((await call({ method: 'POST', url: '/api/layouts', cookie: demo, payload: { title: 'Visitor layout' } })).statusCode).toBe(201);
    expect((await call({ method: 'POST', url: '/api/modules', cookie: demo, payload: { title: 'Visitor module' } })).statusCode).toBe(201);
    expect((await call({ method: 'POST', url: '/api/venues', cookie: demo, payload: { name: 'Visitor room', data: { name: 'Visitor room', edges: [] } } })).statusCode).toBe(201);
    // …and anything else it could own: a custom part, a catalog entry, settings.
    const now = new Date();
    db.insert(schema.customParts).values({ id: randomUUID(), partNumber: 'DEMO.1', displayName: 'Demo part', ownerUserId: DEMO_USER_ID, createdBy: DEMO_USER_ID, xmlBlob: Buffer.from('<part/>'), spriteBlob: Buffer.from('GIF89a'), spriteMime: 'image/gif', createdAt: now, updatedAt: now }).run();
    db.insert(schema.userPreferences).values({ userId: DEMO_USER_ID, prefs: '{}', updatedAt: now }).run();
    expect(titles(DEMO_USER_ID)).toEqual(['Visitor layout', 'Visitor was here']);

    const res = await resetNow();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ ok: true, items: 3 });

    expect(titles(DEMO_USER_ID)).toEqual([DEMO_SAMPLES.layout.title]);
    expect((owned(schema.layouts, DEMO_USER_ID)[0] as { id: string }).id).not.toBe(sample.id);
    expect((owned(schema.modules, DEMO_USER_ID) as { title: string }[]).map((m) => m.title)).toEqual([DEMO_SAMPLES.module.title]);
    expect(owned(schema.venueLibrary, DEMO_USER_ID)).toHaveLength(1);
    expect(owned(schema.customParts, DEMO_USER_ID)).toHaveLength(0);
    expect(db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, DEMO_USER_ID)).all()).toHaveLength(0);
    // Alice's things are untouched.
    expect(titles(alice.id)).toEqual(['Alice layout']);
    expect(db.select().from(schema.layouts).where(eq(schema.layouts.id, aliceLayout.id)).get()).toBeDefined();
    expect(owned(schema.modules, alice.id)).toHaveLength(1);
    expect(owned(schema.venueLibrary, alice.id)).toHaveLength(1);
    // The visitor was signed out by the reset; trying again shows the fresh sample.
    expect(((await call({ url: '/api/auth/me', cookie: demo })).json() as { user: unknown }).user).toBeNull();
    const list = (await call({ url: '/api/layouts', cookie: await tryDemo() })).json() as { layouts: { title: string }[] };
    expect(list.layouts.map((l) => l.title)).toEqual([DEMO_SAMPLES.layout.title]);
    expect((await getPlatformSettings()).demoLastResetAt).not.toBeNull();
  });

  it('tells the demo visitors and admins at once, and nobody else', async () => {
    await setDemo({ demoEnabled: true });
    const demo = await tryDemo();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const streams = await Promise.all([demo, admin.cookie, alice.cookie].map((c) => openStream(port, c)));
    await resetNow();
    const [d, a, other] = streams;
    await until(() => d!.hints().length >= 5 && a!.hints().length >= 1);
    const demoKinds = d!.hints().filter((h) => h.action === 'demo-reset').map((h) => h.kind);
    expect(demoKinds).toEqual(expect.arrayContaining(['layout', 'module', 'venue', 'me']));
    expect(d!.hints().find((h) => h.kind === 'layout')).toMatchObject({ owner: { kind: 'user', id: DEMO_USER_ID } });
    expect(a!.hints().some((h) => h.kind === 'admin' && h.action === 'demo-reset')).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(other!.hints().filter((h) => h.action === 'demo-reset')).toEqual([]);
    for (const s of streams) s.close();
  });

  it('runs on the timer only when the demo is on and a reset is due', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    expect(await demoTick(t0)).toBe(false); // off
    await setDemo({ demoEnabled: true, demoResetEvery: '1h' });
    const last = (await getPlatformSettings()).demoLastResetAt!;
    expect(await demoTick(new Date(last.getTime() + 59 * 60_000))).toBe(false);
    const due = new Date(last.getTime() + 60 * 60_000);
    expect(await demoTick(due)).toBe(true);
    expect((await getPlatformSettings()).demoLastResetAt!.getTime()).toBe(due.getTime());
  });
});

describe('when a reset is due', () => {
  const base = { demoEnabled: true, demoResetEvery: '6h' as const, demoLastResetAt: new Date('2026-10-01T00:00:00Z') };
  it('is the last reset plus the period, never while off, and at once if never reset', () => {
    expect(nextDemoReset(base)!.toISOString()).toBe('2026-10-01T06:00:00.000Z');
    expect(nextDemoReset({ ...base, demoResetEvery: '1h' })!.toISOString()).toBe('2026-10-01T01:00:00.000Z');
    expect(nextDemoReset({ ...base, demoResetEvery: 'daily' })!.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(nextDemoReset({ ...base, demoEnabled: false })).toBeNull();
    expect(demoResetDue({ ...base, demoLastResetAt: null }, base.demoLastResetAt)).toBe(true);
    expect(demoResetDue(base, new Date('2026-10-01T05:59:59Z'))).toBe(false);
    expect(demoResetDue(base, new Date('2026-10-01T06:00:00Z'))).toBe(true);
    expect(demoResetDue({ ...base, demoEnabled: false }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('is shown only while the demo is on', async () => {
    const s = await getPlatformSettings();
    expect(demoStatus({ ...s, ...base })).toEqual({ enabled: true, resetEvery: '6h', lastResetAt: base.demoLastResetAt.getTime(), nextResetAt: base.demoLastResetAt.getTime() + 6 * 3600_000 });
    expect(demoStatus({ ...s, ...base, demoEnabled: false }).nextResetAt).toBeNull();
  });
});

describe('what the demo account can and cannot do', () => {
  let demo: string;
  let sampleId: string;
  let moduleId: string;
  beforeEach(async () => {
    await setDemo({ demoEnabled: true });
    demo = await tryDemo();
    sampleId = (owned(schema.layouts, DEMO_USER_ID)[0] as { id: string }).id;
    moduleId = (owned(schema.modules, DEMO_USER_ID)[0] as { id: string }).id;
  });

  it('never acts as an admin or moderator, even if the database says it is', async () => {
    db.update(schema.users).set({ isGlobalAdmin: true, isModerator: true }).where(eq(schema.users.id, DEMO_USER_ID)).run();
    const me = (await call({ url: '/api/auth/me', cookie: demo })).json() as { user: { isGlobalAdmin: boolean; isModerator: boolean } };
    expect(me.user).toMatchObject({ isGlobalAdmin: false, isModerator: false });
    expect((await call({ url: '/api/admin/users', cookie: demo })).statusCode).toBe(403);
    expect((await call({ method: 'PATCH', url: `/api/admin/users/${alice.id}`, cookie: demo, payload: { isGlobalAdmin: true } })).statusCode).toBe(403);
    expect(db.select().from(schema.users).where(eq(schema.users.id, alice.id)).get()!.isGlobalAdmin).toBe(false);
  });

  it('is the only account the helper calls a demo', () => {
    expect(isDemoUser({ isDemoAccount: true })).toBe(true);
    expect(isDemoUser({ isDemoAccount: false })).toBe(false);
    expect(isDemoUser(null)).toBe(false);
  });

  it('can build, edit, save and export layouts, rooms and modules', async () => {
    expect((await call({ method: 'POST', url: '/api/layouts', cookie: demo, payload: { title: 'Mine' } })).statusCode).toBe(201);
    expect((await call({ method: 'PATCH', url: `/api/layouts/${sampleId}`, cookie: demo, payload: { title: 'Renamed' } })).statusCode).toBe(200);
    const bbm = await call({ url: `/api/layouts/${sampleId}/export.bbm`, cookie: demo });
    expect(bbm.statusCode).toBe(200);
    expect(bbm.body).toContain('<Map');
    expect((await call({ method: 'POST', url: '/api/venues', cookie: demo, payload: { name: 'Hall', data: { name: 'Hall', edges: [] } } })).statusCode).toBe(201);
    expect((await call({ method: 'POST', url: '/api/modules', cookie: demo, payload: { title: 'Mod' } })).statusCode).toBe(201);
    expect((await call({ method: 'PATCH', url: `/api/modules/${moduleId}`, cookie: demo, payload: { title: 'Mod 2' } })).statusCode).toBe(200);
  });

  it.each([
    ['invite to a layout', 'POST', (): string => `/api/layouts/${sampleId}/invites`, { email: 'x@example.com', role: 'editor' }, 'demo_account_cannot_invite'],
    ['invite to a module', 'POST', (): string => `/api/modules/${moduleId}/invites`, { email: 'x@example.com', role: 'editor' }, 'demo_account_cannot_invite'],
    ['share a layout publicly', 'POST', (): string => `/api/layouts/${sampleId}/public-share`, {}, 'demo_account_cannot_share'],
    ['hand a layout over', 'POST', (): string => `/api/layouts/${sampleId}/transfer`, { recipientEmail: 'x@example.com' }, 'demo_account_cannot_share'],
    ['hand a module over', 'POST', (): string => `/api/modules/${moduleId}/transfer`, { recipientEmail: 'x@example.com' }, 'demo_account_cannot_share'],
    ['create a club', 'POST', (): string => '/api/orgs', { name: 'Demo club' }, 'demo_account_cannot_create_org'],
    ['join a club', 'POST', (): string => '/api/orgs/some-club/join', {}, 'demo_account_cannot_join_clubs'],
    ['accept a club invite', 'POST', (): string => '/api/org-invites/some-token', {}, 'demo_account_cannot_join_clubs'],
    ['upload a custom part', 'POST', (): string => '/api/custom-parts', { partNumber: 'X.1', xml: '<part/>' }, 'demo_account_cannot_upload_parts'],
    ['replace a custom part', 'PUT', (): string => '/api/custom-parts/any', { partNumber: 'X.1', xml: '<part/>' }, 'demo_account_cannot_upload_parts'],
    ['submit to the catalog', 'POST', (): string => '/api/catalog/submissions', { kind: 'module', sourceId: 'any-module' }, 'demo_account_cannot_submit'],
    ['change its profile', 'PATCH', (): string => '/api/auth/me', { displayName: 'Me now' }, 'demo_account_cannot_change_profile'],
    ['approve a desktop sign-in', 'POST', (): string => '/api/auth/device/approve', { user_code: 'ABCD-EFGH' }, 'demo_account_cannot_use_desktop'],
    ['link a sign-in provider', 'POST', (): string => '/api/auth/link', {}, 'demo_account_cannot_link'],
  ] as const)('cannot %s', async (_what, method, url, payload, error): Promise<void> => {
    const res = await call({ method, url: url(), cookie: demo, payload });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe(error);
  });

  it('nothing it was refused to do happened', async () => {
    await call({ method: 'POST', url: '/api/orgs', cookie: demo, payload: { name: 'Demo club' } });
    await call({ method: 'POST', url: `/api/layouts/${sampleId}/public-share`, cookie: demo });
    await call({ method: 'PATCH', url: '/api/auth/me', cookie: demo, payload: { displayName: 'Me now' } });
    expect(db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, DEMO_USER_ID)).all()).toHaveLength(0);
    expect(db.select().from(schema.layouts).where(and(eq(schema.layouts.id, sampleId))).get()!.publicShareToken).toBeNull();
    expect(db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get()!.displayName).toBe(DEMO_DISPLAY_NAME);
  });

  it('a normal account can still do these', async () => {
    const layout = (await call({ method: 'POST', url: '/api/layouts', cookie: alice.cookie, payload: { title: 'A' } })).json() as { id: string };
    expect((await call({ method: 'POST', url: `/api/layouts/${layout.id}/public-share`, cookie: alice.cookie })).statusCode).toBe(200);
    expect((await call({ method: 'PATCH', url: '/api/auth/me', cookie: alice.cookie, payload: { displayName: 'Alice A' } })).statusCode).toBe(200);
    expect((await call({ method: 'POST', url: '/api/orgs', cookie: alice.cookie, payload: { name: 'Alice club' } })).statusCode).toBe(201);
  });
});

describe('demo sign-ins', () => {
  const demoSessions = () => db.select().from(schema.sessions).where(eq(schema.sessions.userId, DEMO_USER_ID)).all();
  const signedIn = async (c: string) => ((await call({ url: '/api/auth/me', cookie: c })).json() as { user: unknown }).user !== null;
  const HOUR = 60 * 60 * 1000;

  it('end at the next reset and are never pushed back', async () => {
    await setDemo({ demoEnabled: true, demoResetEvery: '6h' });
    const demo = await tryDemo();
    const next = nextDemoReset(await getPlatformSettings())!.getTime();
    const [row] = demoSessions();
    expect(row!.expiresAt.getTime()).toBe(next);
    // Used a lot: its end stays where it was (a web session would slide).
    for (let i = 0; i < 3; i++) expect(await signedIn(demo)).toBe(true);
    expect(demoSessions()[0]!.expiresAt.getTime()).toBe(next);
    // At the reset time it has ended, even before the timer gets round to the reset.
    db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.sessions.userId, DEMO_USER_ID)).run();
    expect(await signedIn(demo)).toBe(false);
  });

  it('last 24 hours at most, whatever the stored end says', async () => {
    await setDemo({ demoEnabled: true });
    const demo = await tryDemo();
    expect(demoSessions()[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    // A day and a bit old with an end far away (as a database edit could leave it): ended.
    db.update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 25 * HOUR), expiresAt: new Date(Date.now() + 30 * 24 * HOUR) })
      .where(eq(schema.sessions.userId, DEMO_USER_ID))
      .run();
    expect(await signedIn(demo)).toBe(false);
    expect(demoSessions()).toHaveLength(0);
  });

  it('a reset signs every demo visitor out, web sessions and tokens, and nobody else', async () => {
    await setDemo({ demoEnabled: true });
    const one = await tryDemo();
    const two = await tryDemo();
    // The demo can't get a desktop token, but one made anyway (a database edit) goes too.
    const now = new Date();
    db.insert(schema.apiTokens)
      .values({ id: randomUUID(), userId: DEMO_USER_ID, name: 'x', tokenHash: randomUUID(), prefix: 'bld_pat_x', last4: 'xxxx', scopes: 'layouts:read', createdAt: now, lastUsedAt: null, expiresAt: new Date(now.getTime() + HOUR), revokedAt: null })
      .run();
    expect(await signedIn(one)).toBe(true);
    expect((await resetNow()).statusCode).toBe(200);
    expect(await signedIn(one)).toBe(false);
    expect(await signedIn(two)).toBe(false);
    expect(demoSessions()).toHaveLength(0);
    expect(db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, DEMO_USER_ID)).all().every((t) => t.revokedAt !== null)).toBe(true);
    // Other people stay signed in.
    expect(await signedIn(alice.cookie)).toBe(true);
    expect(await signedIn(admin.cookie)).toBe(true);
    // …and the timer's reset does the same.
    const three = await tryDemo();
    expect(await demoTick(new Date(Date.now() + 25 * HOUR))).toBe(true);
    expect(await signedIn(three)).toBe(false);
  });

  it('a visitor with a live layout open is closed with the reason demo_reset', async () => {
    await setDemo({ demoEnabled: true });
    const demo = await tryDemo();
    const sample = owned(schema.layouts, DEMO_USER_ID)[0] as { id: string };
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${sample.id}`, { headers: { cookie: demo } });
    ws.on('error', () => {});
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await resetNow();
    const got = await Promise.race([closed, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))]);
    expect(got).not.toBe('timeout');
    expect((got as { reason: string }).reason).toBe('demo_reset');
  });

  it('Try the demo runs a reset that is due first, so the new sign-in isn’t ended by it', async () => {
    await setDemo({ demoEnabled: true, demoResetEvery: '1h' });
    // The last reset was two hours ago: one is due, and the timer hasn't run yet.
    const old = new Date(Date.now() - 2 * HOUR);
    db.update(schema.platformSettings).set({ demoLastResetAt: old }).run();
    const demo = await tryDemo();
    const after = (await getPlatformSettings()).demoLastResetAt!.getTime();
    expect(after).toBeGreaterThan(old.getTime());
    expect(await signedIn(demo)).toBe(true);
    expect(demoSessions()[0]!.expiresAt.getTime()).toBe(after + HOUR);
  });
});

// ---- live hint stream (as in events.test.ts) ----------------------------
interface Stream { hints: () => Array<Record<string, unknown>>; close: () => void }
function openStream(port: number, cookieStr: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie: cookieStr } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      const s: Stream = {
        hints: () => buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>),
        close: () => req.destroy(),
      };
      const ready = () => (buf.includes(': connected') || res.statusCode !== 200 ? resolve(s) : setTimeout(ready, 5));
      ready();
    });
    req.on('error', (e) => (buf ? undefined : reject(e)));
  });
}
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
}
