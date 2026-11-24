// Admin › Backups: only site admins list, make, download, upload, check and
// restore database backups; names can't reach outside the backups folder;
// an upload that isn't a database of this site, a cut-off or newer one, is
// refused; a restore makes a backup of the site as it is first, stops
// writes, leaves a note and restarts; the next start puts the copy in place.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { adminBackupRoutes, resetBackupState } from '../adminBackups.js';
import { env } from '../../env.js';
import { inMaintenance, leaveMaintenance, registerMaintenanceGate, setRestartHandler } from '../../ops/maintenance.js';
import { LAST_RESTORE, RESTORE_NOTE, STAGED_NAME, applyPendingRestore, snapshotNow, unpackPictures, unpackTo } from '../../ops/dbBackups.js';

let app: FastifyInstance;
let admin: { cookie: string; id: string };
let member: { cookie: string; id: string };
let backups: string;
const savedDir = env.backupsDir;
const dataDir = dirname(resolve(env.dbPath));
let restarts = 0;

beforeAll(() => {
  setRestartHandler(() => {
    restarts += 1;
  });
});

beforeEach(async () => {
  resetDb();
  resetBackupState();
  backups = mkdtempSync(join(tmpdir(), 'cbld-admin-backups-'));
  env.backupsDir = backups;
  app = Fastify();
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  registerMaintenanceGate(app);
  for (const r of [passwordRoutes, sessionRoutes, adminBackupRoutes]) await app.register(r);
  admin = await loginAs(app, 'backup-admin@example.com');
  member = await loginAs(app, 'backup-member@example.com');
  db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
  restarts = 0;
});

afterEach(async () => {
  leaveMaintenance();
  resetBackupState();
  for (const n of [RESTORE_NOTE, STAGED_NAME, LAST_RESTORE]) {
    try {
      unlinkSync(join(dataDir, n));
    } catch {
      /* none */
    }
  }
  env.backupsDir = savedDir;
  rmSync(backups, { recursive: true, force: true });
  await app.close();
});

afterAll(() => {
  setRestartHandler(() => {});
});

const as = (who: { cookie: string }) => ({ cookie: who.cookie });
const list = async (who = admin) =>
  (await app.inject({ url: '/api/admin/backups', headers: as(who) })).json() as {
    files: { name: string; kind: string; bytes: number; images: { name: string } | null }[];
    running: unknown;
    lastError: unknown;
    upload: { chunkBytes: number; maxBytes: number };
  };

async function backUpNow(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: as(admin) });
  expect(res.statusCode).toBe(202);
  for (let i = 0; i < 100; i++) {
    const l = await list();
    if (!l.running) {
      const f = l.files.find((x) => x.kind === 'manual');
      if (f) return f.name;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the backup never finished');
}

async function upload(bytes: Buffer, who = admin, chunk = 1024): Promise<{ status: number; body: Record<string, unknown> }> {
  const start = await app.inject({ method: 'POST', url: '/api/admin/backups/uploads', headers: as(who), payload: { kind: 'database', name: 'x.sqlite.gz', bytes: bytes.length } });
  if (start.statusCode !== 201) return { status: start.statusCode, body: start.json() };
  const { id } = start.json() as { id: string };
  for (let off = 0; off < bytes.length; off += chunk) {
    const piece = bytes.subarray(off, off + chunk);
    const r = await app.inject({ method: 'PUT', url: `/api/admin/backups/uploads/${id}?offset=${off}`, headers: { ...as(who), 'content-type': 'application/octet-stream' }, payload: piece });
    expect(r.statusCode).toBe(200);
  }
  const fin = await app.inject({ method: 'POST', url: `/api/admin/backups/uploads/${id}/finish`, headers: as(who) });
  return { status: fin.statusCode, body: fin.json() };
}

describe('who may', () => {
  it('only site admins reach any backup route; signed-out people are asked to sign in', async () => {
    writeFileSync(join(backups, 'cbld-2026-11-01.sqlite.gz'), gzipSync(Buffer.from('x')));
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups'],
      ['GET', '/api/admin/backups/cbld-2026-11-01.sqlite.gz/download'],
      ['POST', '/api/admin/backups/cbld-2026-11-01.sqlite.gz/check'],
      ['POST', '/api/admin/backups/cbld-2026-11-01.sqlite.gz/restore', { confirm: 'RESTORE' }],
      ['POST', '/api/admin/backups/uploads', { kind: 'database', bytes: 10 }],
      ['POST', '/api/admin/backups/uploads/x/finish'],
      ['DELETE', '/api/admin/backups/uploads/x'],
    ];
    for (const [method, url, payload] of routes) {
      const opts = { method: method as 'GET', url, ...(payload ? { payload: payload as object } : {}) };
      expect((await app.inject({ ...opts, headers: as(member) })).statusCode, `${method} ${url}`).toBe(403);
      expect((await app.inject(opts)).statusCode, `${method} ${url} signed out`).toBe(401);
    }
    expect(restarts).toBe(0);
    expect(inMaintenance()).toBeNull();
  });

  it('another admin can’t add to, finish or cancel your upload', async () => {
    const other = await loginAs(app, 'backup-admin2@example.com');
    db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, other.id)).run();
    const start = await app.inject({ method: 'POST', url: '/api/admin/backups/uploads', headers: as(admin), payload: { kind: 'database', bytes: 4 } });
    const { id } = start.json() as { id: string };
    expect((await app.inject({ method: 'PUT', url: `/api/admin/backups/uploads/${id}?offset=0`, headers: { ...as(other), 'content-type': 'application/octet-stream' }, payload: Buffer.from('abcd') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/admin/backups/uploads/${id}/finish`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/backups/uploads/${id}`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/backups/uploads/${id}`, headers: as(admin) })).statusCode).toBe(204);
  });
});

describe('back up now, list, download', () => {
  it('makes a whole copy with its pictures, lists it, and streams it to an admin', async () => {
    const name = await backUpNow();
    expect(name).toMatch(/^cbld-manual-\d{8}-\d{6}\.sqlite\.gz$/);
    const l = await list();
    const f = l.files.find((x) => x.name === name)!;
    expect(f.images?.name).toBe(name.replace('.sqlite.gz', '.bgimages.tar.gz'));
    const res = await app.inject({ url: `/api/admin/backups/${name}/download`, headers: as(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(name);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const audit = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'admin_backup_download')).all();
    expect(audit).toHaveLength(1);
  });

  it('serves nothing that isn’t a listed backup: no paths, no key, no other files', async () => {
    writeFileSync(join(backups, 'cbld-secret.key'), 'secret');
    writeFileSync(join(backups, 'notes.txt'), 'x');
    writeFileSync(join(dataDir, 'cbld-2026-01-01.sqlite.gz'), gzipSync(Buffer.from('outside')));
    try {
      for (const bad of ['cbld-secret.key', 'notes.txt', '..%2Fcbld-2026-01-01.sqlite.gz', '..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'cbld-2026-01-01.sqlite.gz', '.', '..']) {
        const res = await app.inject({ url: `/api/admin/backups/${bad}/download`, headers: as(admin) });
        expect(res.statusCode, bad).toBe(404);
        expect(res.body).not.toContain('secret');
        expect(res.body).not.toContain('outside');
      }
    } finally {
      unlinkSync(join(dataDir, 'cbld-2026-01-01.sqlite.gz'));
    }
  });

  it('one at a time: a second "back up now" while one runs is told to wait', async () => {
    const first = app.inject({ method: 'POST', url: '/api/admin/backups', headers: as(admin) });
    const second = app.inject({ method: 'POST', url: '/api/admin/backups', headers: as(admin) });
    const codes = [(await first).statusCode, (await second).statusCode].sort();
    expect(codes).toEqual([202, 409]);
    await backUpNow().catch(() => undefined);
  });
});

describe('uploads and checks', () => {
  it('takes a database in pieces, checks it, and lists it with what is in it', async () => {
    const name = await backUpNow();
    const bytes = readFileSync(join(backups, name));
    const res = await upload(bytes, admin, 4096);
    expect(res.status).toBe(201);
    const file = res.body.file as { name: string; kind: string };
    expect(file.kind).toBe('upload');
    expect((res.body.check as { counts: { people: number } }).counts.people).toBe(2);
    expect(readdirSync(backups).some((n) => n.endsWith('.part'))).toBe(false);
  });

  it('refuses and drops a file that isn’t a database, a cut-off gzip, and a database from a newer server', async () => {
    expect((await upload(gzipSync(Buffer.from('hello, not sqlite')))).body.error).toBe('not_sqlite');
    const whole = gzipSync(Buffer.alloc(200_000, 7));
    expect((await upload(whole.subarray(0, whole.length - 100))).body.error).toBe('cut_off');
    // A database with a migration this server doesn't have yet.
    const name = await backUpNow();
    const tmp = mkdtempSync(join(tmpdir(), 'cbld-newer-'));
    try {
      await unpackTo(join(backups, name), join(tmp, 'n.sqlite'));
      const d = new Database(join(tmp, 'n.sqlite'));
      d.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('future', 9_999_999_999_999);
      d.close();
      const res = await upload(readFileSync(join(tmp, 'n.sqlite')), admin, 64 * 1024);
      expect(res.body.error).toBe('newer');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect((await list()).files.filter((f) => f.kind === 'upload')).toHaveLength(0);
    expect(readdirSync(backups).some((n) => n.startsWith('cbld-upload'))).toBe(false);
  });

  it('a listing while an upload is being checked doesn’t lose it', async () => {
    const name = await backUpNow();
    const bytes = readFileSync(join(backups, name));
    const start = await app.inject({ method: 'POST', url: '/api/admin/backups/uploads', headers: as(admin), payload: { kind: 'database', bytes: bytes.length } });
    const { id } = start.json() as { id: string };
    await app.inject({ method: 'PUT', url: `/api/admin/backups/uploads/${id}?offset=0`, headers: { ...as(admin), 'content-type': 'application/octet-stream' }, payload: bytes });
    const finishing = app.inject({ method: 'POST', url: `/api/admin/backups/uploads/${id}/finish`, headers: as(admin) });
    const lists = await Promise.all([list(), list(), list()]);
    expect(lists).toHaveLength(3);
    expect((await finishing).statusCode).toBe(201);
  });

  it('pieces must come in order, and no bigger than the upload said', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/admin/backups/uploads', headers: as(admin), payload: { kind: 'database', bytes: 4 } });
    const { id } = start.json() as { id: string };
    const put = (off: number, b: string) => app.inject({ method: 'PUT', url: `/api/admin/backups/uploads/${id}?offset=${off}`, headers: { ...as(admin), 'content-type': 'application/octet-stream' }, payload: Buffer.from(b) });
    expect((await put(2, 'ab')).statusCode).toBe(409);
    expect((await put(0, 'abcdef')).statusCode).toBe(413);
    expect((await put(0, 'ab')).statusCode).toBe(200);
    expect((await put(0, 'ab')).json()).toEqual({ received: 2 });
    expect((await app.inject({ method: 'POST', url: `/api/admin/backups/uploads/${id}/finish`, headers: as(admin) })).statusCode).toBe(409);
  });

  it('refuses an upload bigger than the server takes before anything is sent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/backups/uploads', headers: as(admin), payload: { kind: 'database', bytes: 17 * 1024 ** 3 } });
    expect(res.statusCode).toBe(413);
  });

  it('check says what is in a listed backup', async () => {
    const name = await backUpNow();
    const res = await app.inject({ method: 'POST', url: `/api/admin/backups/${name}/check`, headers: as(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ counts: { people: 2, layouts: 0 }, older: false });
  });
});

describe('restore', () => {
  it('needs RESTORE typed, then backs up the site as it is, stops writes, leaves a note and restarts', async () => {
    const name = await backUpNow();
    expect((await app.inject({ method: 'POST', url: `/api/admin/backups/${name}/restore`, headers: as(admin), payload: {} })).statusCode).toBe(400);
    expect(restarts).toBe(0);
    const res = await app.inject({ method: 'POST', url: `/api/admin/backups/${name}/restore`, headers: as(admin), payload: { confirm: 'RESTORE', images: true } });
    expect(res.statusCode).toBe(202);
    const { safety } = res.json() as { safety: string };
    expect(safety).toMatch(/^cbld-before-restore-/);
    expect(existsSync(join(backups, safety))).toBe(true);
    expect(existsSync(join(dataDir, STAGED_NAME))).toBe(true);
    const note = JSON.parse(readFileSync(join(dataDir, RESTORE_NOTE), 'utf8')) as { from: string; images: string; by: { id: string } };
    expect(note).toMatchObject({ from: name, images: name.replace('.sqlite.gz', '.bgimages.tar.gz'), by: { id: admin.id } });
    expect(inMaintenance()?.reason).toBe('restore');
    // Everything but the health check waits now.
    const during = await app.inject({ url: '/api/admin/backups', headers: as(admin) });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toMatchObject({ error: 'maintenance' });
    await new Promise((r) => setTimeout(r, 400));
    expect(restarts).toBe(1);
  });

  it('a restore waiting for the restart blocks another', async () => {
    const name = await backUpNow();
    await app.inject({ method: 'POST', url: `/api/admin/backups/${name}/restore`, headers: as(admin), payload: { confirm: 'RESTORE' } });
    leaveMaintenance();
    resetBackupState(); // as after a restart that didn't happen: the note still waits
    const again = await app.inject({ method: 'POST', url: `/api/admin/backups/${name}/restore`, headers: as(admin), payload: { confirm: 'RESTORE' } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'restore_pending' });
  });
});

describe('the next start puts the copy in place', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cbld-swap-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('swaps the database whole, folds away the old write-ahead log, unpacks the pictures and says so', async () => {
    const live = join(tmp, 'cbld.sqlite');
    const old = new Database(live);
    old.pragma('journal_mode = WAL');
    old.exec("create table t (v text); insert into t values ('old')");
    // The copy to put back, with its pictures.
    const bdir = join(tmp, 'backups');
    mkdirSync(join(tmp, 'pics'));
    writeFileSync(join(tmp, 'pics', 'a.png'), 'restored picture');
    const src = new Database(join(tmp, 'src.sqlite'));
    src.exec("create table t (v text); insert into t values ('restored')");
    const name = await snapshotNow({ dir: bdir, sqlite: src, imagesDir: join(tmp, 'pics'), kind: 'manual' });
    src.close();
    await unpackTo(join(bdir, name), join(tmp, STAGED_NAME));
    mkdirSync(join(tmp, 'bgimages'));
    writeFileSync(join(tmp, 'bgimages', 'a.png'), 'newer picture');
    writeFileSync(join(tmp, 'bgimages', 'b.png'), 'kept');
    writeFileSync(join(tmp, 'cbld-secret.key'), 'KEY');
    writeFileSync(join(tmp, RESTORE_NOTE), JSON.stringify({ from: name, images: name.replace('.sqlite.gz', '.bgimages.tar.gz'), by: { id: 'u', name: 'Admin' }, at: 1, safety: 's' }));
    old.close();
    const done = await applyPendingRestore(live, bdir);
    expect(done).toMatchObject({ ok: true, imagesRestored: 1 });
    const now = new Database(live);
    expect(now.prepare('select v from t').get()).toEqual({ v: 'restored' });
    now.close();
    expect(readFileSync(join(tmp, 'bgimages', 'a.png'), 'utf8')).toBe('restored picture');
    expect(readFileSync(join(tmp, 'bgimages', 'b.png'), 'utf8')).toBe('kept');
    expect(readFileSync(join(tmp, 'cbld-secret.key'), 'utf8')).toBe('KEY');
    expect(existsSync(join(tmp, RESTORE_NOTE))).toBe(false);
    expect(JSON.parse(readFileSync(join(tmp, LAST_RESTORE), 'utf8'))).toMatchObject({ ok: true, from: name });
    // Nothing waits now.
    expect(await applyPendingRestore(live, bdir)).toBeNull();
  });

  it('leaves the database alone when the staged copy is missing', async () => {
    const live = join(tmp, 'cbld.sqlite');
    const d = new Database(live);
    d.exec("create table t (v text); insert into t values ('as it was')");
    d.close();
    writeFileSync(join(tmp, RESTORE_NOTE), JSON.stringify({ from: 'x', images: null, by: { id: 'u', name: 'A' }, at: 1, safety: 's' }));
    expect(await applyPendingRestore(live, tmp)).toMatchObject({ ok: false });
    const again = new Database(live);
    expect(again.prepare('select v from t').get()).toEqual({ v: 'as it was' });
    again.close();
  });
});

describe('unpacking is bounded', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cbld-bounds-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('a gzip that unpacks past the limit stops there and leaves nothing', async () => {
    writeFileSync(join(tmp, 'bomb.gz'), gzipSync(Buffer.alloc(5 * 1024 * 1024)));
    await expect(unpackTo(join(tmp, 'bomb.gz'), join(tmp, 'out'), 1024 * 1024)).rejects.toMatchObject({ code: 'too_big' });
    expect(readdirSync(tmp)).toEqual(['bomb.gz']);
  });

  it('a pictures archive writes only plain picture files into the folder: no paths, links or the key', async () => {
    const entry = (name: string, body: string, type = '0') => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 'utf8');
      h.write('0000644\0', 100, 'ascii');
      h.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
      h.write(type, 156, 'ascii');
      const data = Buffer.from(body);
      const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
      return Buffer.concat([h, data, pad]);
    };
    const tar = Buffer.concat([
      entry('../evil.png', 'escape'),
      entry('/abs.png', 'abs'),
      entry('sub/dir.png', 'nested'),
      entry('cbld-secret.key', 'KEY'),
      entry('link.png', '', '2'),
      entry('ok.png', 'fine'),
      Buffer.alloc(1024),
    ]);
    writeFileSync(join(tmp, 'p.tar.gz'), gzipSync(tar));
    const dest = join(tmp, 'out', 'bgimages');
    expect(await unpackPictures(join(tmp, 'p.tar.gz'), dest)).toBe(1);
    expect(readdirSync(dest)).toEqual(['ok.png']);
    expect(existsSync(join(tmp, 'out', 'evil.png'))).toBe(false);
    expect(existsSync(join(tmp, 'evil.png'))).toBe(false);
  });
});
