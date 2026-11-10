// Layouts and venues in the public catalog: each kind has its own switch;
// sharing publishes a cleaned copy (the live one stays private and keeps
// changing); review, permissions, the viewer's snapshot, downloads,
// copying, and what's left out for privacy.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDefaultLayoutDoc, decodeDoc, docToBbm, encodeDoc, exportBbmFromDoc, exportSidecarFromDoc, importSidecarIntoDoc, readBudgetLimitsFromDoc, seedFromBbm } from '@cld/ydoc';
import type { LayerBrick } from '@cld/model';
import { db, resetDb, schema, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { orgRoutes } from '../orgs.js';
import { moduleRoutes } from '../modules.js';
import { catalogRoutes } from '../catalog.js';
import { collectionRoutes } from '../collections.js';
import { clubReviewRoutes } from '../clubReview.js';
import { catalogDocRoutes } from '../catalogDocs.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../../auth/platformSettings.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(orgRoutes);
  await app.register(moduleRoutes);
  await app.register(catalogRoutes);
  await app.register(collectionRoutes);
  await app.register(clubReviewRoutes);
  await app.register(catalogDocRoutes);
  return app;
}

async function login(app: FastifyInstance, email: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/password/register', payload: { email, password: 'correct horse battery', displayName: email.split('@')[0] } });
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const v = await db.select().from(schema.emailVerifications).where(eq(schema.emailVerifications.userId, user!.id)).get();
  const res = await app.inject({ method: 'POST', url: `/api/auth/password/verify-email/${await testVerificationToken(v!)}` });
  const c = res.headers['set-cookie'];
  return Array.isArray(c) ? c.join('; ') : (c ?? '');
}

async function settings(patch: Partial<typeof schema.platformSettings.$inferInsert>) {
  await getPlatformSettings();
  await db.update(schema.platformSettings).set(patch).where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
}

const userId = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)).get())!.id;

/** A venue with walls, a door, a column and a private note. */
const venue = () => ({
  name: 'Town hall',
  enabled: true,
  minWalkwayStuds: 30,
  bounds: { x: 0, y: 0, w: 400, h: 300 },
  edges: [
    { kind: 0, doorWidthStuds: 0, label: 'North', poly: [{ x: 0, y: 0 }, { x: 400, y: 0 }], secretEdgeField: 'x' },
    { kind: 1, doorWidthStuds: 40, label: 'Door', poly: [{ x: 0, y: 300 }, { x: 0, y: 0 }] },
  ],
  obstacles: [{ label: 'Pillar', kind: 'column', poly: [{ x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 120 }] }],
  notes: [{ x: 10, y: 10, text: 'Key from Bob, 555-0101' }],
  contact: 'bob@example.com',
  lengthUnit: 'm',
});

/** A layout: two straights (one part twice) and a curve, with a sidecar full of things that stay private. */
function layoutDoc(extraBricks = 0): Buffer {
  const map = docToBbm(createDefaultLayoutDoc());
  map.exportInfo.exportPath = 'C:\\Users\\ada\\Desktop';
  const bricks = map.layers.find((l) => l.type === 'brick') as LayerBrick;
  const brick = (id: string, part: string, x: number) => ({
    id,
    displayArea: { x, y: 0, width: 32, height: 8 },
    myGroup: '',
    partNumber: part,
    orientation: 0,
    activeConnectionPointIndex: 0,
    altitude: 0,
    connexions: [],
  });
  bricks.bricks.push(brick('b1', '3001.8', 0), brick('b2', '3001.8', 32), brick('b3', '2865.8', 64));
  for (let i = 0; i < extraBricks; i++) bricks.bricks.push(brick(`x${i}`, '3001.8', 96 + i * 32));
  const doc = seedFromBbm(map);
  // As the editor keeps it: everything in meta.cache, the budget in meta.budgetLimits.
  importSidecarIntoDoc(doc, {
    schemaVersion: 1,
    bbmHashSha256: 'abc',
    modules: [{ id: 'm1', name: 'Station', members: ['b1'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], sourceFile: '/home/ada/station.bbm', importedAt: '2026-01-01' }],
    backgroundImage: { url: '/api/layouts/x/background-image', path: 'C:\\secret.png', opacity: 0.5 },
    venue: venue(),
    views: [{ id: 'v1', name: 'Overview', fit: true, rect: null, sheets: null, grid: true, labels: true }],
    privateExtra: 'secret',
    budgetLimits: { '3001.8': 12, '2865.8': 0 },
  } as unknown as Parameters<typeof importSidecarIntoDoc>[1]);
  return Buffer.from(encodeDoc(doc));
}

describe('layouts and venues in the catalog', () => {
  let app: FastifyInstance;
  let ada: string; // owner, and the ArkLUG admin
  let max: string; // ArkLUG manager
  let mel: string; // ArkLUG member
  let out: string; // someone else
  let mod: string; // moderator
  let orgId: string;

  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const makeLayout = async (email: string, org: string | null = null, bricks = 0) => {
    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.layouts).values({
      id,
      title: 'Harbour town',
      ownerUserId: org ? null : await userId(email),
      ownerOrgId: org,
      createdBy: await userId(email),
      createdAt: now,
      updatedAt: now,
      docSnapshot: layoutDoc(bricks),
      docVersion: 0,
    });
    return id;
  };
  const makeVenue = async (email: string) => {
    const id = randomUUID();
    await db.insert(schema.venueLibrary).values({ id, ownerUserId: await userId(email), ownerOrgId: null, name: 'Town hall', data: JSON.stringify(venue()), createdBy: await userId(email), createdAt: new Date() });
    return id;
  };
  const share = (cookie: string, kind: 'layout' | 'venue', sourceId: string, extra: Record<string, unknown> = {}) =>
    req('POST', '/api/catalog/submissions', cookie, { kind, sourceId, title: kind === 'layout' ? 'Harbour town' : 'Town hall', ...extra });
  const approveAll = async () => {
    const q = ((await req('GET', '/api/moderation/items', mod)).json() as { queue: { versionId: string }[] }).queue;
    for (const e of q) expect((await req('POST', `/api/moderation/versions/${e.versionId}/approve`, mod, {})).statusCode).toBe(200);
  };

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    ada = await login(app, 'ada@example.com');
    max = await login(app, 'max@example.com');
    mel = await login(app, 'mel@example.com');
    out = await login(app, 'out@example.com');
    mod = await login(app, 'mod@example.com');
    await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, await userId('mod@example.com')));
    await settings({ layoutCatalogEnabled: true, venueCatalogEnabled: true, catalogReview: 'moderators', catalogAnonymousBrowse: true });
    orgId = ((await req('POST', '/api/orgs', ada, { name: 'ArkLUG', slug: 'arklug' })).json() as { id: string }).id;
    const now = new Date();
    await db.insert(schema.orgMembers).values({ orgId, userId: await userId('max@example.com'), role: 'manager', joinedAt: now });
    await db.insert(schema.orgMembers).values({ orgId, userId: await userId('mel@example.com'), role: 'member', joinedAt: now });
  });
  afterEach(async () => {
    await app.close();
  });

  it('each kind has its own switch, off by default', async () => {
    await settings({ layoutCatalogEnabled: false, venueCatalogEnabled: false });
    const s = (await req('GET', '/api/catalog/settings')).json() as { layouts: boolean; venues: boolean };
    expect(s).toMatchObject({ layouts: false, venues: false });
    const l = await makeLayout('ada@example.com');
    expect((await share(ada, 'layout', l)).json()).toEqual({ error: 'catalog_off' });
    expect((await req('GET', '/api/catalog/items?kind=layout', ada)).statusCode).toBe(404);
    await settings({ layoutCatalogEnabled: true });
    expect((await share(ada, 'layout', l)).statusCode).toBe(201);
    const v = await makeVenue('ada@example.com');
    expect((await share(ada, 'venue', v)).json()).toEqual({ error: 'catalog_off' });
  });

  it('a shared layout is reviewed, then anyone can view it; the copy leaves private things out', async () => {
    const l = await makeLayout('ada@example.com');
    const r = (await share(ada, 'layout', l)).json() as { id: string; status: string };
    expect(r.status).toBe('in_review');
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot`)).statusCode).toBe(404);
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot?v=1`, out)).statusCode).toBe(404);
    // Its owner and the moderator can look at the waiting version.
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot?v=1`, ada)).statusCode).toBe(200);
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot?v=1`, mod)).statusCode).toBe(200);
    await approveAll();

    const list = (await req('GET', '/api/catalog/items?kind=layout')).json() as { items: { id: string; summary: { widthStuds: number; partCount: number; parts: unknown[]; venue: string } }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.summary).toEqual({
      widthStuds: 96,
      heightStuds: 8,
      partCount: 3,
      parts: [
        { partNumber: '3001.8', count: 2 },
        { partNumber: '2865.8', count: 1 },
      ],
      venue: 'Town hall',
    });
    const snap = await req('GET', `/api/catalog/items/${r.id}/snapshot`);
    expect(snap.statusCode).toBe(200);
    const doc = decodeDoc(new Uint8Array(snap.rawPayload));
    const map = exportBbmFromDoc(doc)!;
    expect(map.exportInfo.exportPath).toBe('');
    const side = exportSidecarFromDoc(doc)!;
    expect(side.modules![0]).toEqual({ id: 'm1', name: 'Station', members: ['b1'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(side.backgroundImage).toBeUndefined();
    expect(side.views).toHaveLength(1);
    expect(side.venue!.notes).toBeUndefined();
    expect(side.venue!.obstacles).toHaveLength(1);
    // How many of each part its owner may use is their own business.
    expect(side.budgetLimits).toBeUndefined();
    expect(readBudgetLimitsFromDoc(doc)).toBeUndefined();
    expect(snap.rawPayload.includes('budgetLimits')).toBe(false);
    expect(side.venue!.lengthUnit).toBe('m');
    const text = JSON.stringify(side);
    for (const secret of ['secret', 'station.bbm', '555-0101', 'bob@example.com', 'abc']) expect(text).not.toContain(secret);

    // Downloads: a .bld-layout (a zip) and a .bbm.
    const bld = await req('GET', `/api/catalog/items/${r.id}/download`);
    expect(bld.headers['content-disposition']).toContain('Harbour town.bld-layout');
    expect(bld.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    // (smallZip stores its entries as they are, so sidecar.json reads as text.)
    expect(bld.rawPayload.includes('"views"')).toBe(true);
    expect(bld.rawPayload.includes('budgetLimits')).toBe(false);
    const bbm = await req('GET', `/api/catalog/items/${r.id}/download?format=bbm`);
    expect(bbm.headers['content-disposition']).toContain('Harbour town.bbm');
    expect(bbm.body).toContain('3001.8');
    expect(bbm.body).not.toContain('Desktop');

    // Not for anyone when signed-out browsing is off.
    await settings({ catalogAnonymousBrowse: false });
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot`)).statusCode).toBe(401);
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot`, out)).statusCode).toBe(200);
  });

  it('a copy published before the budget was left out is handed out without it', async () => {
    await settings({ catalogReview: 'none' });
    const l = await makeLayout('ada@example.com');
    const r = (await share(ada, 'layout', l)).json() as { id: string };
    // What an older server stored: the live document as it was, budget and all.
    const old = decodeDoc(layoutDoc());
    old.getMap('meta').delete('cache');
    await db.update(schema.catalogItemVersions).set({ docSnapshot: Buffer.from(encodeDoc(old)) }).where(eq(schema.catalogItemVersions.itemId, r.id));
    expect(readBudgetLimitsFromDoc(old)).toEqual({ '3001.8': 12, '2865.8': 0 });

    const snap = await req('GET', `/api/catalog/items/${r.id}/snapshot`);
    expect(snap.rawPayload.includes('budgetLimits')).toBe(false);
    expect(exportBbmFromDoc(decodeDoc(new Uint8Array(snap.rawPayload)))!.layers.some((x) => x.type === 'brick' && x.bricks.length === 3)).toBe(true);
    expect((await req('GET', `/api/catalog/items/${r.id}/download`)).rawPayload.includes('budgetLimits')).toBe(false);
    // Someone's copy of it has no budget either; the owner's own layout keeps its budget.
    const add = await req('POST', `/api/catalog/items/${r.id}/add`, out, {});
    const copy = await db.select().from(schema.layouts).where(eq(schema.layouts.id, (add.json() as { id: string }).id)).get();
    expect(readBudgetLimitsFromDoc(decodeDoc(copy!.docSnapshot as Uint8Array))).toBeUndefined();
    const mine = await db.select().from(schema.layouts).where(eq(schema.layouts.id, l)).get();
    expect(readBudgetLimitsFromDoc(decodeDoc(mine!.docSnapshot as Uint8Array))).toEqual({ '3001.8': 12, '2865.8': 0 });
  });

  it('the live layout stays private and keeps changing; a new version updates the public copy', async () => {
    const l = await makeLayout('ada@example.com');
    await settings({ catalogReview: 'none' });
    const r = (await share(ada, 'layout', l)).json() as { id: string; status: string };
    expect(r.status).toBe('public');
    await db.update(schema.layouts).set({ docSnapshot: layoutDoc(5) }).where(eq(schema.layouts.id, l));
    const sum = async () => ((await req('GET', `/api/catalog/items/${r.id}`, out)).json() as { item: { summary: { partCount: number }; version: number } }).item;
    expect(await sum()).toMatchObject({ version: 1, summary: { partCount: 3 } });
    expect(((await share(ada, 'layout', l)).json() as { id: string }).id).toBe(r.id);
    expect(await sum()).toMatchObject({ version: 2, summary: { partCount: 8 } });
  });

  it('only the owner, or a club’s admins and managers, share; a trusted club publishes its own', async () => {
    const mine = await makeLayout('ada@example.com');
    expect((await share(out, 'layout', mine)).statusCode).toBe(403);
    const club = await makeLayout('ada@example.com', orgId);
    expect((await share(mel, 'layout', club)).statusCode).toBe(403);
    expect(((await share(max, 'layout', club)).json() as { status: string }).status).toBe('in_review');
    await req('POST', '/api/moderation/clubs/arklug/trust', mod, { trusted: true });
    expect(((await share(max, 'layout', club)).json() as { status: string }).status).toBe('public');
    const detail = (await req('GET', `/api/catalog/items?kind=layout`)).json() as { items: { by: string }[] };
    expect(detail.items[0]!.by).toContain('ArkLUG');
    const item = (await req('GET', '/api/catalog/items?kind=layout')).json() as { items: { id: string }[] };
    expect(((await req('GET', `/api/catalog/items/${item.items[0]!.id}`)).json() as { item: { club: unknown } }).item.club).toEqual({ slug: 'arklug', name: 'ArkLUG' });
  });

  it('a layout’s picture comes with the share and is checked', async () => {
    const l = await makeLayout('ada@example.com');
    expect((await share(ada, 'layout', l, { thumbnail: { mime: 'image/png', data: Buffer.from('nope').toString('base64') } })).json()).toEqual({ error: 'invalid_thumbnail' });
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#336699' } }).png().toBuffer();
    const r = (await share(ada, 'layout', l, { thumbnail: { mime: 'image/png', data: png.toString('base64') } })).json() as { id: string };
    await approveAll();
    const pic = await req('GET', `/api/catalog/items/${r.id}/preview`);
    expect(pic.headers['content-type']).toBe('image/webp');
  });

  it('copies to my layouts or a club, credited, and counts a use', async () => {
    await settings({ catalogReview: 'none' });
    const l = await makeLayout('ada@example.com');
    const r = (await share(ada, 'layout', l)).json() as { id: string };
    const add = await req('POST', `/api/catalog/items/${r.id}/add`, out, {});
    expect(add.statusCode).toBe(201);
    const copy = await db.select().from(schema.layouts).where(eq(schema.layouts.id, (add.json() as { id: string }).id)).get();
    expect(copy).toMatchObject({ ownerUserId: await userId('out@example.com'), copiedFromId: l, title: 'Harbour town' });
    expect(exportBbmFromDoc(decodeDoc(copy!.docSnapshot as Uint8Array))!.layers.find((x) => x.type === 'brick')).toBeTruthy();
    // To a club they can add to; not to one they're not in.
    expect((await req('POST', `/api/catalog/items/${r.id}/add`, max, { orgSlug: 'arklug' })).statusCode).toBe(201);
    expect((await req('POST', `/api/catalog/items/${r.id}/add`, out, { orgSlug: 'arklug' })).statusCode).not.toBe(201);
    expect(((await req('GET', `/api/catalog/items/${r.id}`)).json() as { item: { uses: number } }).item.uses).toBe(2);
    // A copy is theirs: no "update available" for layouts.
    await share(ada, 'layout', l);
    const copies = (await req('GET', '/api/catalog/copies', out)).json() as { copies: { updateAvailable: boolean }[] };
    expect(copies.copies[0]!.updateAvailable).toBe(false);
  });

  it('a venue: its plan without notes, a drawn picture, copied to my venues', async () => {
    const v = await makeVenue('ada@example.com');
    expect((await share(out, 'venue', v)).statusCode).toBe(403);
    const r = (await share(ada, 'venue', v)).json() as { id: string };
    expect((await req('GET', `/api/catalog/items/${r.id}/venue`, out)).statusCode).toBe(404);
    await approveAll();
    const got = (await req('GET', `/api/catalog/items/${r.id}/venue`)).json() as { name: string; venue: Record<string, unknown> };
    expect(got.name).toBe('Town hall');
    expect(got.venue.notes).toBeUndefined();
    expect(got.venue.contact).toBeUndefined();
    expect(JSON.stringify(got.venue)).not.toContain('secretEdgeField');
    expect((got.venue.edges as unknown[]).length).toBe(2);
    // Its lengths show in the unit its owner drew it in.
    expect(got.venue.lengthUnit).toBe('m');
    const card = ((await req('GET', '/api/catalog/items?kind=venue')).json() as { items: { summary: unknown; previewUrl: string }[] }).items[0]!;
    expect(card.summary).toEqual({ widthStuds: 400, heightStuds: 300 });
    const pic = await req('GET', card.previewUrl);
    expect(pic.headers['content-type']).toBe('image/webp');
    expect((await sharp(pic.rawPayload).metadata()).width).toBe(1024);
    const add = await req('POST', `/api/catalog/items/${r.id}/add`, out, {});
    expect(add.statusCode).toBe(201);
    const copy = await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, (add.json() as { id: string }).id)).get();
    expect(copy).toMatchObject({ ownerUserId: await userId('out@example.com'), copiedFromId: v, name: 'Town hall' });
    expect(copy!.data).not.toContain('555-0101');
    // The venue's own routes aren't the layout's.
    expect((await req('GET', `/api/catalog/items/${r.id}/snapshot`)).statusCode).toBe(404);
  });
});
