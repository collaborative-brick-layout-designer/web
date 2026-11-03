import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { exportBbmFromDoc } from '@cld/ydoc';
import { db, resetDb, schema, testVerificationToken } from '../test/helpers.js';
import { attachUser } from '../auth/cookie.js';
import { passwordRoutes } from './auth/password.js';
import { sessionRoutes } from './auth/session.js';
import { orgRoutes } from './orgs.js';
import { moduleRoutes } from './modules.js';
import { moduleInviteRoutes } from './moduleInvites.js';
import { MAX_THUMBNAIL_BYTES, smallCacheSize } from '../images/thumbnails.js';

/** A real PNG, `w` × `h`, with some detail so it doesn't compress to nothing. */
async function picture(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + (i % w) * 13) & 0xff;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(orgRoutes);
  await app.register(moduleRoutes);
  await app.register(moduleInviteRoutes);
  return app;
}

async function registerAndLogin(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/password/register',
    payload: { email, password: 'correct horse battery', displayName: email.split('@')[0] },
  });
  expect(res.statusCode).toBe(200);
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const verification = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.userId, user!.id))
    .get();
  const verifyRes = await app.inject({
    method: 'POST',
    url: `/api/auth/password/verify-email/${await testVerificationToken(verification!)}`,
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
}

describe('modules', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('creates a module with a fresh Y.Doc snapshot', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'Crossover' },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { id: string }).id;

    const snap = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: aliceCookie },
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.headers['content-type']).toBe('application/octet-stream');
    expect(snap.rawPayload.length).toBeGreaterThan(0);
    // Bytes should be a valid Y.Doc snapshot (decodes without error).
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(snap.rawPayload));
  });

  it('PUT /snapshot bumps doc-version and persists bytes', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'M' },
    });
    const id = (create.json() as { id: string }).id;

    const initial = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: aliceCookie },
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(initial.rawPayload));
    doc.getMap('meta').set('event', 'edited');
    const updated = Y.encodeStateAsUpdate(doc);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: aliceCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(updated),
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: aliceCookie },
    });
    expect(after.headers['x-doc-version']).toBe('1');
    const reread = new Y.Doc();
    Y.applyUpdate(reread, new Uint8Array(after.rawPayload));
    expect(reread.getMap('meta').get('event')).toBe('edited');
  });

  it('viewers cannot PUT snapshot but can GET', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'M' },
    });
    const id = (create.json() as { id: string }).id;
    const bob = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'bob@example.com'))
      .get();
    await db.insert(schema.moduleCollaborators).values({
      moduleId: id,
      userId: bob!.id,
      role: 'viewer',
      addedAt: new Date(),
    });

    const get = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: bobCookie },
    });
    expect(get.statusCode).toBe(200);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/modules/${id}/snapshot`,
      headers: { cookie: bobCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1]),
    });
    expect(put.statusCode).toBe(403);
  });

  it('demo accounts cannot invite to modules', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'M' },
    });
    const id = (create.json() as { id: string }).id;
    await db
      .update(schema.users)
      .set({ isDemoAccount: true })
      .where(eq(schema.users.email, 'alice@example.com'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/modules/${id}/invites`,
      headers: { cookie: aliceCookie },
      payload: { email: 'bob@example.com', role: 'editor' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('non-owner cannot delete', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'M' },
    });
    const id = (create.json() as { id: string }).id;
    const bob = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'bob@example.com'))
      .get();
    await db.insert(schema.moduleCollaborators).values({
      moduleId: id,
      userId: bob!.id,
      role: 'editor',
      addedAt: new Date(),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/modules/${id}`,
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('org-owned modules: org admins are owners, members are editors', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { cookie: aliceCookie },
      payload: { name: 'Acme', slug: 'acme' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/modules',
      headers: { cookie: aliceCookie },
      payload: { title: 'OrgMod', orgSlug: 'acme' },
    });
    const id = (create.json() as { id: string }).id;

    const aliceGet = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}`,
      headers: { cookie: aliceCookie },
    });
    expect((aliceGet.json() as { role: string }).role).toBe('owner');

    // Add Bob as member.
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const bob = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'bob@example.com'))
      .get();
    const acme = await db.select().from(schema.orgs).where(eq(schema.orgs.slug, 'acme')).get();
    await db.insert(schema.orgMembers).values({
      orgId: acme!.id,
      userId: bob!.id,
      role: 'member',
      joinedAt: new Date(),
    });
    const bobGet = await app.inject({
      method: 'GET',
      url: `/api/modules/${id}`,
      headers: { cookie: bobCookie },
    });
    expect((bobGet.json() as { role: string }).role).toBe('editor');
  });

  it('a new module opens ready for parts: it has a brick layer', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    const create = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: aliceCookie }, payload: { title: 'Fresh' } });
    const id = (create.json() as { id: string }).id;
    const snap = await app.inject({ method: 'GET', url: `/api/modules/${id}/snapshot`, headers: { cookie: aliceCookie } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(snap.rawPayload));
    expect(exportBbmFromDoc(doc)?.layers.map((l) => l.type)).toContain('brick');
  });

  describe('thumbnails', () => {
    let PNG: Buffer;
    beforeAll(async () => {
      PNG = await picture(64, 48);
    });
    async function setup() {
      const aliceCookie = await registerAndLogin(app, 'alice@example.com');
      const create = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: aliceCookie }, payload: { title: 'Pic' } });
      return { aliceCookie, id: (create.json() as { id: string }).id };
    }

    it('lists no picture until one is uploaded, then serves it with caching', async () => {
      const { aliceCookie, id } = await setup();
      let list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: aliceCookie } })).json() as { modules: { id: string; thumbnailAt: number | null }[] };
      expect(list.modules[0]!.thumbnailAt).toBeNull();
      expect((await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie } })).statusCode).toBe(404);

      const put = await app.inject({
        method: 'PUT',
        url: `/api/modules/${id}/thumbnail`,
        headers: { cookie: aliceCookie },
        payload: { mime: 'image/png', data: PNG.toString('base64') },
      });
      expect(put.statusCode).toBe(200);
      list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: aliceCookie } })).json() as typeof list;
      expect(list.modules[0]!.thumbnailAt).toBe((put.json() as { thumbnailAt: number }).thumbnailAt);

      const got = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie } });
      expect(got.statusCode).toBe(200);
      // Stored and served as WebP, whatever came in.
      expect(got.headers['content-type']).toBe('image/webp');
      expect(got.headers['cache-control']).toContain('max-age');
      expect(await sharp(got.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 64, height: 48 });
      const again = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie, 'if-none-match': got.headers.etag as string } });
      expect(again.statusCode).toBe(304);
    });

    it('refuses a file that is not the picture it claims to be, and octet-stream', async () => {
      const { aliceCookie, id } = await setup();
      const bad = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: Buffer.from('<svg/>').toString('base64') } });
      expect(bad.statusCode).toBe(400);
      const wrongType = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/svg+xml', data: PNG.toString('base64') } });
      expect(wrongType.statusCode).toBe(400);
      const big = await app.inject({
        method: 'PUT',
        url: `/api/modules/${id}/thumbnail`,
        headers: { cookie: aliceCookie },
        payload: { mime: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(MAX_THUMBNAIL_BYTES)]).toString('base64') },
      });
      expect(big.statusCode).toBe(413);
      // The right header on bytes that aren't a picture.
      const broken = await app.inject({
        method: 'PUT',
        url: `/api/modules/${id}/thumbnail`,
        headers: { cookie: aliceCookie },
        payload: { mime: 'image/png', data: Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(40, 7)]).toString('base64') },
      });
      expect(broken.statusCode).toBe(400);
      const raw = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie, 'content-type': 'application/octet-stream' }, payload: PNG });
      expect(raw.statusCode).toBe(400);
    });

    it('only editors can set the picture; strangers cannot see it', async () => {
      const { aliceCookie, id } = await setup();
      const bobCookie = await registerAndLogin(app, 'bob@example.com');
      const stranger = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: bobCookie }, payload: { mime: 'image/png', data: PNG.toString('base64') } });
      expect(stranger.statusCode).toBe(404);
      const invited = await app.inject({ method: 'POST', url: `/api/modules/${id}/invites`, headers: { cookie: aliceCookie }, payload: { email: 'bob@example.com', role: 'viewer' } });
      expect((await app.inject({ method: 'POST', url: `/api/module-invites/${(invited.json() as { token: string }).token}`, headers: { cookie: bobCookie } })).statusCode).toBe(200);
      const viewer = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: bobCookie }, payload: { mime: 'image/png', data: PNG.toString('base64') } });
      expect(viewer.statusCode).toBe(403);
    });

    it('counts the picture in storage', async () => {
      const { aliceCookie, id } = await setup();
      const { usageOf } = await import('../limits/limits.js');
      const alice = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get();
      const before = usageOf({ kind: "user", id: alice!.id }).storageBytes;
      await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: PNG.toString('base64') } });
      const after = usageOf({ kind: "user", id: alice!.id }).storageBytes;
      const stored = (await db.select().from(schema.modules).where(eq(schema.modules.id, id)).get())!.thumbnail as Buffer;
      expect(after - before).toBe(stored.length);
    });

    it('counts what is stored (the re-encoded picture), not what was sent, against the space left', async () => {
      const { aliceCookie, id } = await setup();
      const { usageOf, invalidateLimitCaches } = await import('../limits/limits.js');
      const alice = (await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get())!;
      // A smooth picture with a little grain: big as PNG, small as WebP.
      const w = 900;
      const h = 700;
      const raw = Buffer.alloc(w * h * 3);
      let seed = 1;
      for (let i = 0; i < raw.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        raw[i] = (((i / 3) % w) / w) * 200 + (seed % 5);
      }
      const sent = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
      const put = () => app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: sent.toString('base64') } });
      expect((await put()).statusCode).toBe(200);
      const stored = ((await db.select().from(schema.modules).where(eq(schema.modules.id, id)).get())!.thumbnail as Buffer).length;
      expect(stored).toBeLessThan(sent.length / 2);
      await db.update(schema.modules).set({ thumbnail: null, thumbnailMime: null, thumbnailAt: null }).where(eq(schema.modules.id, id));
      // Room for the stored picture, not for the PNG that was sent.
      const room = usageOf({ kind: 'user', id: alice.id }).storageBytes + stored + 16;
      await db.insert(schema.limitOverrides).values({ subjectKind: 'user', subjectId: alice.id, limits: JSON.stringify({ storagePerUser: room }), updatedAt: new Date() });
      invalidateLimitCaches();
      expect((await put()).statusCode).toBe(200);
    });

    it('takes a 1024 px picture, shrinks a bigger one, strips its metadata, and says how big it is', async () => {
      const { aliceCookie, id } = await setup();
      const huge = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#3a7' } })
        .withMetadata({ exif: { IFD0: { Copyright: 'secret-camera' } } })
        .jpeg()
        .toBuffer();
      const asPng = await sharp(huge).withMetadata().png().toBuffer();
      expect(asPng.toString('latin1')).toContain('secret-camera');
      const put = await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: asPng.toString('base64') } });
      expect(put.statusCode).toBe(200);
      const got = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie } });
      const meta = await sharp(got.rawPayload).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 1024, height: 512 });
      expect(meta.exif).toBeUndefined();
      expect(got.rawPayload.toString('latin1')).not.toContain('secret-camera');
      const list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: aliceCookie } })).json() as { modules: { thumbnailSide: number | null }[] };
      expect(list.modules[0]!.thumbnailSide).toBe(1024);
      // A 1024 px WebP from the editor is kept at 1024.
      const webp = await sharp({ create: { width: 1024, height: 700, channels: 4, background: '#fff' } }).webp().toBuffer();
      await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/webp', data: webp.toString('base64') } });
      const again = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie } });
      expect(await sharp(again.rawPayload).metadata()).toMatchObject({ width: 1024, height: 700 });
    });

    it('lists get a small copy, made once; an old small picture is its own small copy', async () => {
      const { aliceCookie, id } = await setup();
      const big = await picture(1024, 768);
      await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: big.toString('base64') } });
      const before = smallCacheSize();
      const small = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail?size=small`, headers: { cookie: aliceCookie } });
      expect(small.statusCode).toBe(200);
      expect(small.headers['content-type']).toBe('image/webp');
      expect(await sharp(small.rawPayload).metadata()).toMatchObject({ width: 256, height: 192 });
      expect(small.headers.etag).toMatch(/-s"$/);
      expect(smallCacheSize()).toBe(before + 1);
      const second = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail?size=small`, headers: { cookie: aliceCookie } });
      expect(Buffer.compare(second.rawPayload, small.rawPayload)).toBe(0);
      expect(smallCacheSize()).toBe(before + 1);
      const full = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie } });
      expect(full.headers.etag).not.toBe(small.headers.etag);
      expect((await sharp(full.rawPayload).metadata()).width).toBe(1024);
      // A picture from before (256 px) is served as it is.
      await db.update(schema.modules).set({ thumbnail: PNG, thumbnailMime: 'image/png' }).where(eq(schema.modules.id, id));
      const old = await app.inject({ method: 'GET', url: `/api/modules/${id}/thumbnail?size=small`, headers: { cookie: aliceCookie } });
      expect(Buffer.compare(old.rawPayload, PNG)).toBe(0);
      const list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: aliceCookie } })).json() as { modules: { thumbnailSide: number | null }[] };
      expect(list.modules[0]!.thumbnailSide).toBe(64);
    });
  });

  it('club members only view club modules when the club keeps adding to admins', async () => {
    const aliceCookie = await registerAndLogin(app, 'alice@example.com');
    await app.inject({ method: 'POST', url: '/api/orgs', headers: { cookie: aliceCookie }, payload: { name: 'Acme', slug: 'acme' } });
    const id = ((await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: aliceCookie }, payload: { title: 'OrgMod', orgSlug: 'acme' } })).json() as { id: string }).id;
    const bobCookie = await registerAndLogin(app, 'bob@example.com');
    const bob = await db.select().from(schema.users).where(eq(schema.users.email, 'bob@example.com')).get();
    const acme = await db.select().from(schema.orgs).where(eq(schema.orgs.slug, 'acme')).get();
    await db.insert(schema.orgMembers).values({ orgId: acme!.id, userId: bob!.id, role: 'member', joinedAt: new Date() });
    // Through the club's settings, which also take the adding permissions off its Member role.
    expect((await app.inject({ method: 'PATCH', url: '/api/orgs/acme', headers: { cookie: aliceCookie }, payload: { membersCanCreate: false } })).statusCode).toBe(200);
    // "Save to" offers only the clubs that will take it: Bob can't add here, Alice (its admin) can.
    const canAdd = async (cookie: string) =>
      ((await app.inject({ method: 'GET', url: '/api/orgs', headers: { cookie } })).json() as { orgs: { slug: string; canAdd: boolean }[] }).orgs.find((o) => o.slug === 'acme')?.canAdd;
    expect(await canAdd(bobCookie)).toBe(false);
    expect(await canAdd(aliceCookie)).toBe(true);
    const get = (await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } })).json() as { role: string };
    expect(get.role).toBe('viewer');
    const list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: bobCookie } })).json() as { modules: { id: string; role: string }[] };
    expect(list.modules.find((m) => m.id === id)?.role).toBe('viewer');
    const put = await app.inject({ method: 'PUT', url: `/api/modules/${id}/snapshot`, headers: { cookie: bobCookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from([0, 0]) });
    expect(put.statusCode).toBe(403);
    // A manager still owns them.
    await db.update(schema.orgMembers).set({ role: 'manager' }).where(eq(schema.orgMembers.userId, bob!.id));
    expect(((await app.inject({ method: 'GET', url: `/api/modules/${id}`, headers: { cookie: bobCookie } })).json() as { role: string }).role).toBe('owner');
  });

  describe('versions', () => {
    async function setup() {
      const aliceCookie = await registerAndLogin(app, 'alice@example.com');
      const create = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: aliceCookie }, payload: { title: 'Yard' } });
      return { aliceCookie, id: (create.json() as { id: string }).id };
    }
    /** A small module document, different for each n (the routes take only readable ones). */
    const contents = (n: number): Buffer => {
      const d = new Y.Doc();
      d.clientID = n;
      d.getMap('meta').set('n', n);
      return Buffer.from(Y.encodeStateAsUpdate(d));
    };
    const save = (cookie: string, id: string, bytes: Buffer, note?: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/modules/${id}/snapshot${note === undefined ? '' : `?note=${encodeURIComponent(note)}`}`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
    const versions = async (cookie: string, id: string) =>
      ((await app.inject({ method: 'GET', url: `/api/modules/${id}/versions`, headers: { cookie } })).json() as {
        versions: { version: number; note: string | null; author: string | null }[];
      }).versions;

    it('each save is a numbered version with its note and author; the list shows the newest', async () => {
      const { aliceCookie, id } = await setup();
      expect(await versions(aliceCookie, id)).toEqual([]);
      expect((await save(aliceCookie, id, contents(1), 'First go')).json()).toMatchObject({ version: 1 });
      expect((await save(aliceCookie, id, contents(2))).json()).toMatchObject({ version: 2 });
      const v = await versions(aliceCookie, id);
      expect(v.map((x) => x.version)).toEqual([2, 1]);
      expect(v[1]).toMatchObject({ note: 'First go', author: 'alice' });
      expect(v[0]!.note).toBeNull();
      const list = (await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie: aliceCookie } })).json() as { modules: { latestVersion: number }[] };
      expect(list.modules[0]!.latestVersion).toBe(2);
      const one = await app.inject({ method: 'GET', url: `/api/modules/${id}/versions/1/snapshot`, headers: { cookie: aliceCookie } });
      expect(one.statusCode).toBe(200);
      expect([...one.rawPayload]).toEqual([...contents(1)]);
      expect((await save(aliceCookie, id, contents(3), 'x'.repeat(301))).statusCode).toBe(400);
    });

    it('restoring makes the old contents current as a new version', async () => {
      const { aliceCookie, id } = await setup();
      await save(aliceCookie, id, contents(1));
      await save(aliceCookie, id, contents(2));
      const r = await app.inject({ method: 'POST', url: `/api/modules/${id}/versions/1/restore`, headers: { cookie: aliceCookie }, payload: {} });
      expect(r.json()).toMatchObject({ ok: true, version: 3 });
      const snap = await app.inject({ method: 'GET', url: `/api/modules/${id}/snapshot`, headers: { cookie: aliceCookie } });
      expect([...snap.rawPayload]).toEqual([...contents(1)]);
      expect((await versions(aliceCookie, id))[0]).toMatchObject({ version: 3, note: 'Restored version 1' });
    });

    it('keeps only the newest versions', async () => {
      const { aliceCookie, id } = await setup();
      const { MODULE_VERSIONS_KEPT } = await import('./modules.js');
      for (let i = 0; i < MODULE_VERSIONS_KEPT + 3; i++) await save(aliceCookie, id, contents(i + 1));
      const v = await versions(aliceCookie, id);
      expect(v).toHaveLength(MODULE_VERSIONS_KEPT);
      expect(v.at(-1)!.version).toBe(4);
    });

    it('viewers see the history but cannot restore; strangers see nothing', async () => {
      const { aliceCookie, id } = await setup();
      await save(aliceCookie, id, contents(1));
      const bobCookie = await registerAndLogin(app, 'bob@example.com');
      expect((await app.inject({ method: 'GET', url: `/api/modules/${id}/versions`, headers: { cookie: bobCookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/modules/${id}/versions/1/snapshot`, headers: { cookie: bobCookie } })).statusCode).toBe(404);
      const invited = await app.inject({ method: 'POST', url: `/api/modules/${id}/invites`, headers: { cookie: aliceCookie }, payload: { email: 'bob@example.com', role: 'viewer' } });
      expect((await app.inject({ method: 'POST', url: `/api/module-invites/${(invited.json() as { token: string }).token}`, headers: { cookie: bobCookie } })).statusCode).toBe(200);
      expect(await versions(bobCookie, id)).toHaveLength(1);
      const r = await app.inject({ method: 'POST', url: `/api/modules/${id}/versions/1/restore`, headers: { cookie: bobCookie }, payload: {} });
      expect(r.statusCode).toBe(403);
    });

    it('versions count in storage', async () => {
      const { aliceCookie, id } = await setup();
      const { usageOf } = await import('../limits/limits.js');
      const alice = await db.select().from(schema.users).where(eq(schema.users.email, 'alice@example.com')).get();
      // Two layouts of the same size (a module's contents are a layout the apps read).
      const sized = (fill: string) => {
        const d = new Y.Doc();
        d.clientID = 1;
        d.getMap('meta').set('note', fill.repeat(1000));
        return Buffer.from(Y.encodeStateAsUpdate(d));
      };
      const [first, second] = [sized('a'), sized('b')];
      expect(second.length).toBe(first.length);
      expect((await save(aliceCookie, id, first)).statusCode).toBe(200);
      const before = usageOf({ kind: 'user', id: alice!.id }).storageBytes;
      // Same-size contents again: the module's size stays, the new version adds its copy.
      expect((await save(aliceCookie, id, second)).statusCode).toBe(200);
      expect(usageOf({ kind: 'user', id: alice!.id }).storageBytes - before).toBe(second.length);
    });

    it('the newest version gets the picture that is uploaded after the save', async () => {
      const { aliceCookie, id } = await setup();
      await save(aliceCookie, id, contents(1));
      const PNG = await picture(600, 300);
      await app.inject({ method: 'PUT', url: `/api/modules/${id}/thumbnail`, headers: { cookie: aliceCookie }, payload: { mime: 'image/png', data: PNG.toString('base64') } });
      const pic = await app.inject({ method: 'GET', url: `/api/modules/${id}/versions/1/thumbnail`, headers: { cookie: aliceCookie } });
      expect(pic.statusCode).toBe(200);
      expect(pic.headers['content-type']).toBe('image/webp');
      const small = await app.inject({ method: 'GET', url: `/api/modules/${id}/versions/1/thumbnail?size=small`, headers: { cookie: aliceCookie } });
      expect(await sharp(small.rawPayload).metadata()).toMatchObject({ width: 256, height: 128 });
    });
  });
});
