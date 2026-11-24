// Admin › Backups. Site admins only (requireGlobalAdmin on every route; no
// API tokens), every change audited.
//
//   GET    /api/admin/backups                         the list, what's running, the last restore
//   POST   /api/admin/backups                         back up now (starts it; a live hint says when it's done)
//   GET    /api/admin/backups/:name/download          one listed file, streamed
//   POST   /api/admin/backups/:name/check             unpack and check a copy; says what's in it
//   POST   /api/admin/backups/:name/restore           {confirm: "RESTORE", images: boolean}: restore, then restart
//   POST   /api/admin/backups/uploads                 {kind: "database"|"pictures", name, bytes, pairWith?}: start an upload
//   PUT    /api/admin/backups/uploads/:id?offset=N    one piece (application/octet-stream, at most 8 MiB)
//   POST   /api/admin/backups/uploads/:id/finish      check it and list it
//   DELETE /api/admin/backups/uploads/:id             cancel it
//
// An upload comes in 8 MiB pieces, each well under the 10 MiB every
// request may carry, so a proxy or firewall in front needs no exception
// however large the database is.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/index.js';
import { env } from '../env.js';
import { requireGlobalAdmin } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { backgroundJobs } from '../workers/jobs.js';
import { gzipIsWhole, imagesDirFor } from '../workers/backup.js';
import { publish } from '../events/audience.js';
import { docHub } from '../ws/docHub.js';
import { perPerson } from '../utils/rateLimits.js';
import { attachment } from '../utils/contentDisposition.js';
import { enterMaintenance, leaveMaintenance, requestRestart } from '../ops/maintenance.js';
import {
  type DatabaseCheck,
  RestoreRefused,
  STAGED_NAME,
  backupKind,
  checkDatabaseFile,
  freeBytes,
  isGzip,
  listDbBackups,
  readLastRestore,
  restorePending,
  servableBackup,
  snapshotNow,
  stamp,
  trimKinds,
  unpackTo,
  writeRestoreNote,
} from '../ops/dbBackups.js';
import { backupKeeps } from '../history/settings.js';

/** One upload piece. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** The largest file an admin can upload. */
export const UPLOAD_MAX_BYTES = 16 * 1024 ** 3;
const UPLOAD_IDLE_MS = 60 * 60 * 1000;

const migrationsFolder = () => resolve('./migrations');
const dataDir = () => dirname(resolve(env.dbPath));

type Busy = { kind: 'backup' | 'check' | 'restore'; startedAt: number; by: string };
let busy: Busy | null = null;
let lastError: { kind: Busy['kind']; message: string; at: number } | null = null;
/** The copy staged by the last check, so a restore right after needn't unpack it again. */
let staged: { name: string; mtimeMs: number; check: DatabaseCheck } | null = null;

interface Upload {
  id: string;
  adminId: string;
  kind: 'database' | 'pictures';
  bytes: number;
  received: number;
  path: string;
  pairWith: string | null;
  touched: number;
  /** Being checked and listed: no more pieces, no second finish. */
  finishing?: boolean;
}
const uploads = new Map<string, Upload>();

function dropUpload(u: Upload): void {
  uploads.delete(u.id);
  try {
    unlinkSync(u.path);
  } catch {
    /* gone */
  }
}

/**
 * Uploads left idle for an hour, and pieces a restart left behind, go; so
 * does a copy a check unpacked an hour ago that no restore is waiting on
 * (it is as big as the database).
 */
function sweepUploads(now = Date.now()): void {
  for (const u of uploads.values()) if (!u.finishing && now - u.touched > UPLOAD_IDLE_MS) dropUpload(u);
  const stagedPath = join(dataDir(), STAGED_NAME);
  if (!busy && !restorePending(dataDir()) && existsSync(stagedPath)) {
    try {
      if (!staged || now - statSync(stagedPath).mtimeMs > UPLOAD_IDLE_MS) {
        unlinkSync(stagedPath);
        staged = null;
      }
    } catch {
      /* gone */
    }
  }
  if (!existsSync(env.backupsDir)) return;
  const live = new Set([...uploads.values()].map((u) => u.path));
  for (const name of readdirSync(env.backupsDir)) {
    if (!/^cbld-upload-[0-9a-f-]{36}\.part$/.test(name)) continue;
    const p = join(env.backupsDir, name);
    if (!live.has(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* in use or gone */
      }
    }
  }
}

/** Test hook: forget what's running and staged. */
export function resetBackupState(): void {
  busy = null;
  lastError = null;
  staged = null;
  for (const u of [...uploads.values()]) dropUpload(u);
}

const hint = () => publish({ kind: 'admin', action: 'update:backups' }, { ownerless: true });

function refused(reply: FastifyReply, err: unknown) {
  if (err instanceof RestoreRefused) return reply.code(422).send({ error: err.code, message: err.message });
  throw err;
}

async function adminName(id: string): Promise<string> {
  const row = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, id)).get();
  return row?.name ?? 'a site admin';
}

/** Unpack and check a listed copy into the data folder, ready to be put in place. */
async function stage(name: string): Promise<DatabaseCheck> {
  const src = servableBackup(env.backupsDir, name);
  if (!src || backupKind(name) === null) throw new RestoreRefused('not_sqlite', 'There is no such database backup.');
  const mtimeMs = statSync(src).mtimeMs;
  const dest = join(dataDir(), STAGED_NAME);
  if (staged && staged.name === name && staged.mtimeMs === mtimeMs && existsSync(dest)) return staged.check;
  staged = null;
  try {
    unlinkSync(dest);
  } catch {
    /* none */
  }
  if (isGzip(src) && !(await gzipIsWhole(src))) throw new RestoreRefused('cut_off', 'This backup is cut off or damaged: it doesn’t unpack to the end.');
  await unpackTo(src, dest);
  try {
    const check = checkDatabaseFile(dest, migrationsFolder());
    staged = { name, mtimeMs, check };
    return check;
  } catch (err) {
    try {
      unlinkSync(dest);
    } catch {
      /* gone */
    }
    throw err;
  }
}

function claim(kind: Busy['kind'], by: string, reply: FastifyReply): boolean {
  if (busy) {
    void reply.code(409).send({ error: 'busy', running: busy.kind, message: busy.kind === 'backup' ? 'A backup is being made. Try again when it’s done.' : busy.kind === 'restore' ? 'The site is being restored.' : 'A backup is being checked. Try again in a moment.' });
    return false;
  }
  if (restorePending(dataDir())) {
    void reply.code(409).send({ error: 'restore_pending', message: 'A restore is waiting for the server to restart.' });
    return false;
  }
  busy = { kind, startedAt: Date.now(), by };
  return true;
}

export async function adminBackupRoutes(app: FastifyInstance): Promise<void> {
  // Upload pieces are raw bytes (as the layout and module snapshots are).
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_BYTES }, (_req, body, done) => done(null, body));
  }
  sweepUploads();

  app.get('/api/admin/backups', { config: { rateLimit: perPerson(120, '1 minute') } }, async (req) => {
    requireGlobalAdmin(req);
    sweepUploads();
    const jobs = await backgroundJobs();
    return {
      nightly: jobs.backups,
      files: listDbBackups(env.backupsDir),
      running: busy,
      lastError,
      lastRestore: readLastRestore(dataDir()),
      restorePending: restorePending(dataDir()),
      freeBytes: { backups: freeBytes(existsSync(env.backupsDir) ? env.backupsDir : dirname(resolve(env.backupsDir))), data: freeBytes(dataDir()) },
      upload: { chunkBytes: CHUNK_BYTES, maxBytes: UPLOAD_MAX_BYTES },
    };
  });

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post('/api/admin/backups', { config: { rateLimit: perPerson(10, '1 minute') } }, async (req, reply) => {
    const me = requireGlobalAdmin(req);
    if (!claim('backup', me.id, reply)) return reply;
    lastError = null;
    void (async () => {
      try {
        const name = await snapshotNow({ dir: env.backupsDir, sqlite, imagesDir: imagesDirFor(env.dbPath), kind: 'manual', keeps: await backupKeeps() });
        await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'backups', userId: me.id, eventType: 'admin_backup_now', payload: { name } });
      } catch (err) {
        lastError = { kind: 'backup', message: (err as Error).message, at: Date.now() };
        req.log.error({ err }, 'backup now failed');
      } finally {
        busy = null;
        await hint();
      }
    })();
    return reply.code(202).send({ started: true });
  });

  app.get<{ Params: { name: string } }>(
    '/api/admin/backups/:name/download',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const path = servableBackup(env.backupsDir, req.params.name);
      if (!path) return reply.code(404).send({ error: 'not_found' });
      const size = statSync(path).size;
      await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'backups', userId: me.id, eventType: 'admin_backup_download', payload: { name: req.params.name, bytes: size } });
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(size));
      reply.header('content-disposition', attachment(req.params.name));
      reply.header('cache-control', 'no-store');
      return reply.send(createReadStream(path));
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { name: string } }>(
    '/api/admin/backups/:name/check',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      if (!servableBackup(env.backupsDir, req.params.name) || backupKind(req.params.name) === null) return reply.code(404).send({ error: 'not_found' });
      if (!claim('check', me.id, reply)) return reply;
      try {
        return await stage(req.params.name);
      } catch (err) {
        return refused(reply, err);
      } finally {
        busy = null;
      }
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { name: string }; Body: { confirm?: unknown; images?: unknown } }>(
    '/api/admin/backups/:name/restore',
    { config: { rateLimit: perPerson(5, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const name = req.params.name;
      const listed = listDbBackups(env.backupsDir).find((f) => f.name === name);
      if (!listed || !servableBackup(env.backupsDir, name)) return reply.code(404).send({ error: 'not_found' });
      if (req.body?.confirm !== 'RESTORE') return reply.code(400).send({ error: 'confirm', message: 'Type RESTORE to confirm.' });
      const images = req.body?.images === true && !!listed.images;
      if (!claim('restore', me.id, reply)) return reply;
      let safety: string;
      try {
        await stage(name);
        // From here nothing is written: open layouts are saved, then a
        // backup of the site as it is now, then the note for the next start.
        enterMaintenance('restore');
        await docHub.flushAll();
        safety = await snapshotNow({ dir: env.backupsDir, sqlite, imagesDir: imagesDirFor(env.dbPath), kind: 'before-restore', protect: name, keeps: await backupKeeps() });
        await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'backups', userId: me.id, eventType: 'admin_backup_restore', payload: { name, images, safety } });
        writeRestoreNote(dataDir(), { from: name, images: images ? listed.images!.name : null, by: { id: me.id, name: await adminName(me.id) }, at: Date.now(), safety });
      } catch (err) {
        leaveMaintenance();
        busy = null;
        if (!(err instanceof RestoreRefused)) {
          lastError = { kind: 'restore', message: (err as Error).message, at: Date.now() };
          req.log.error({ err }, 'restore failed before restarting');
        }
        await hint();
        return refused(reply, err);
      }
      req.log.warn(`[restore] ${me.id} is restoring ${name}; a backup of the site as it was is ${safety}. Restarting.`);
      reply.raw.once('finish', () => setTimeout(requestRestart, 250));
      return reply.code(202).send({ restarting: true, safety });
    },
  );

  // ---- uploads ----------------------------------------------------------

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Body: { kind?: unknown; name?: unknown; bytes?: unknown; pairWith?: unknown } }>(
    '/api/admin/backups/uploads',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      sweepUploads();
      const kind = req.body?.kind === 'pictures' ? 'pictures' : req.body?.kind === 'database' ? 'database' : null;
      const bytes = req.body?.bytes;
      if (!kind || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) return reply.code(400).send({ error: 'invalid_body' });
      if (bytes > UPLOAD_MAX_BYTES) return reply.code(413).send({ error: 'too_big', message: `A backup can be at most ${UPLOAD_MAX_BYTES / 1024 ** 3} GB.` });
      let pairWith: string | null = null;
      if (kind === 'pictures') {
        const p = typeof req.body?.pairWith === 'string' ? req.body.pairWith : '';
        const f = listDbBackups(env.backupsDir).find((x) => x.name === p);
        if (!f || f.kind !== 'upload' || f.images) return reply.code(400).send({ error: 'pair', message: 'Upload the database first; its pictures go with it.' });
        pairWith = f.name;
      }
      mkdirSync(env.backupsDir, { recursive: true });
      const free = freeBytes(env.backupsDir);
      if (free !== null && free < bytes + 512 * 1024 ** 2) return reply.code(507).send({ error: 'no_space', message: 'There isn’t room in the backups folder for this file.' });
      if ([...uploads.values()].filter((u) => u.adminId === me.id).length >= 3) return reply.code(429).send({ error: 'too_many_uploads' });
      const id = randomUUID();
      const path = join(env.backupsDir, `cbld-upload-${id}.part`);
      closeSync(openSync(path, 'w'));
      uploads.set(id, { id, adminId: me.id, kind, bytes, received: 0, path, pairWith, touched: Date.now() });
      return reply.code(201).send({ id, chunkBytes: CHUNK_BYTES });
    },
  );

  const ownUpload = (req: FastifyRequest<{ Params: { id: string } }>, adminId: string) => {
    const u = uploads.get(req.params.id);
    return u && u.adminId === adminId ? u : null;
  };

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.put<{ Params: { id: string }; Querystring: { offset?: string } }>(
    '/api/admin/backups/uploads/:id',
    { bodyLimit: CHUNK_BYTES, config: { rateLimit: perPerson(600, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const u = ownUpload(req, me.id);
      if (!u || u.finishing) return reply.code(404).send({ error: 'not_found' });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'invalid_body' });
      const offset = Number(req.query.offset);
      // Pieces in order; a piece sent twice (a retry) is taken once.
      if (offset + body.length === u.received) return { received: u.received };
      if (offset !== u.received) return reply.code(409).send({ error: 'offset', received: u.received });
      if (u.received + body.length > u.bytes) return reply.code(413).send({ error: 'too_big' });
      const fd = openSync(u.path, 'r+');
      try {
        writeSync(fd, body as unknown as Uint8Array<ArrayBuffer>, 0, body.length, offset);
      } finally {
        closeSync(fd);
      }
      u.received += body.length;
      u.touched = Date.now();
      return { received: u.received };
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { id: string } }>(
    '/api/admin/backups/uploads/:id/finish',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const u = ownUpload(req, me.id);
      if (!u) return reply.code(404).send({ error: 'not_found' });
      if (u.received !== u.bytes) return reply.code(409).send({ error: 'incomplete', received: u.received });
      if (u.finishing) return reply.code(409).send({ error: 'finishing' });
      u.finishing = true;
      const fd = openSync(u.path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Off the list of uploads only once it is renamed (or refused): the
      // sweep deletes pieces no upload owns.
      const fail = (code: RestoreRefused['code'], message: string) => {
        uploads.delete(u.id);
        try {
          unlinkSync(u.path);
        } catch {
          /* gone */
        }
        return reply.code(422).send({ error: code, message });
      };
      let name: string;
      if (u.kind === 'pictures') {
        if (!isGzip(u.path) || !(await gzipIsWhole(u.path))) return fail('cut_off', 'This pictures archive is cut off or damaged.');
        name = u.pairWith!.replace(/\.sqlite(\.gz)?$/, '.bgimages.tar.gz');
        if (!listDbBackups(env.backupsDir).some((f) => f.name === u.pairWith)) return fail('not_sqlite', 'Its database upload is gone.');
      } else {
        const gz = isGzip(u.path);
        if (gz && !(await gzipIsWhole(u.path))) return fail('cut_off', 'This backup is cut off or damaged: it doesn’t unpack to the end.');
        let tag = stamp();
        while (existsSync(join(env.backupsDir, `cbld-upload-${tag}.sqlite.gz`)) || existsSync(join(env.backupsDir, `cbld-upload-${tag}.sqlite`))) {
          await new Promise((r) => setTimeout(r, 1000));
          tag = stamp();
        }
        name = `cbld-upload-${tag}.sqlite${gz ? '.gz' : ''}`;
      }
      renameSync(u.path, join(env.backupsDir, name));
      uploads.delete(u.id);
      if (u.kind === 'database') {
        // A file that isn't a database of this site isn't kept.
        try {
          if (!claimQuiet(me.id)) return reply.code(409).send({ error: 'busy' });
          try {
            await stage(name);
          } finally {
            busy = null;
          }
        } catch (err) {
          try {
            unlinkSync(join(env.backupsDir, name));
          } catch {
            /* gone */
          }
          return refused(reply, err);
        }
        trimKinds(env.backupsDir, null, await backupKeeps());
      }
      await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'backups', userId: me.id, eventType: 'admin_backup_upload', payload: { name, bytes: u.bytes } });
      return reply.code(201).send({ file: listDbBackups(env.backupsDir).find((f) => f.name === (u.pairWith ?? name)) ?? null, check: staged?.name === name ? staged.check : null });
    },
  );

  function claimQuiet(by: string): boolean {
    if (busy) return false;
    busy = { kind: 'check', startedAt: Date.now(), by };
    return true;
  }

  app.delete<{ Params: { id: string } }>(
    '/api/admin/backups/uploads/:id',
    { config: { rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const u = ownUpload(req, me.id);
      if (!u) return reply.code(404).send({ error: 'not_found' });
      dropUpload(u);
      return reply.code(204).send();
    },
  );
}
