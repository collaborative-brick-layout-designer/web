// The nightly backup (workers/index.ts backupWorker) and the one before a
// migration. A backup is never half a file:
//   - the database is copied with SQLite's online backup, a few pages at a
//     time between other work (better-sqlite3 `db.backup`), so the server
//     keeps answering while it runs (VACUUM INTO froze it for seconds);
//   - the copy is gzipped to `<name>.gz.tmp`, synced to disk, then renamed:
//     a restart part-way leaves only a .tmp, which the next run deletes,
//     never a cut-off `.gz` that looks like that day's backup;
//   - the layouts' background pictures (`<data>/bgimages/`) go beside it as
//     `cbld-<date>.bgimages.tar.gz`, kept and dropped with the database copy.

import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import type Database from 'better-sqlite3';
import { classifyBackups } from './retention.js';

// @types/node's pipeline overloads don't take these streams under
// exactOptionalPropertyTypes; they are valid at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipe = pipeline as (...streams: any[]) => Promise<void>;

/** A nightly database copy's name. */
export const dbBackupName = (tag: string) => `cbld-${tag}.sqlite.gz`;
/** The background pictures' archive beside it. */
export const imagesBackupName = (tag: string) => `cbld-${tag}.bgimages.tar.gz`;
const IMAGES_RE = /^cbld-(\d{4}-\d{2}-\d{2})\.bgimages\.tar\.gz$/;
const PRE_MIGRATION_RE = /^cbld-pre-.+\.sqlite$/;

/** Whether a .gz file reads to its end (a cut-off one doesn't). */
export async function gzipIsWhole(path: string): Promise<boolean> {
  try {
    const sink = new Writable({ write: (_c, _e, done) => done() });
    await pipe(createReadStream(path), createGunzip(), sink);
    return true;
  } catch {
    return false;
  }
}

/** Gzip `src` to `dest` through `dest.tmp`: synced, then renamed, so `dest` is whole or not there. */
export async function gzipAtomic(src: string | Readable, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  try {
    await pipe(typeof src === 'string' ? createReadStream(src) : src, createGzip(), createWriteStream(tmp));
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* not made */
    }
    throw err;
  }
}

/** Every regular file in `dir` (not below it), as a plain tar stream (ustar). */
export function tarOfFolder(dir: string): Readable {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort() : [];
  function* blocks(): Generator<Buffer> {
    for (const name of names) {
      const data = readFileSync(join(dir, name));
      const st = statSync(join(dir, name));
      const h = Buffer.alloc(512);
      h.write(name.slice(0, 99), 0, 'utf8');
      h.write('0000644\0', 100, 'ascii');
      h.write('0000000\0', 108, 'ascii');
      h.write('0000000\0', 116, 'ascii');
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
      h.write(Math.floor(st.mtimeMs / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
      h.write('        ', 148, 'ascii');
      h.write('0', 156, 'ascii');
      h.write('ustar\0', 257, 'ascii');
      h.write('00', 263, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
      yield h;
      yield data;
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024);
  }
  return Readable.from(blocks());
}

/** Leftovers of a backup cut off part-way (a restart): never kept. */
export function removeStrayTemps(dir: string): string[] {
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^cbld-.*\.tmp$/.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
      gone.push(name);
    } catch {
      /* in use or gone */
    }
  }
  return gone;
}

export interface BackupOptions {
  dir: string;
  /** The live database. */
  sqlite: Database.Database;
  /** Where the background pictures are. */
  imagesDir: string;
  now?: Date;
  log?: (line: string) => void;
}

/** One nightly backup: the database and the background pictures, then the retention policy. */
export async function runBackup({ dir, sqlite, imagesDir, now = new Date(), log = () => {} }: BackupOptions): Promise<'made' | 'already'> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const name of removeStrayTemps(dir)) log(`[backup] removed ${name}, left by a backup that was cut off`);
  const tag = now.toISOString().slice(0, 10);
  const dbFile = resolve(dir, dbBackupName(tag));
  const imagesFile = resolve(dir, imagesBackupName(tag));
  let made = false;
  if (existsSync(dbFile) && !(await gzipIsWhole(dbFile))) {
    log(`[backup] ${dbBackupName(tag)} is cut off; making it again`);
    unlinkSync(dbFile);
  }
  if (!existsSync(dbFile)) {
    const copy = resolve(dir, `cbld-${tag}.sqlite.tmp`);
    try {
      // Online backup, page by page between requests: the server keeps answering.
      await sqlite.backup(copy);
      await gzipAtomic(copy, dbFile);
    } finally {
      try {
        unlinkSync(copy);
      } catch {
        /* not made */
      }
    }
    made = true;
  }
  if (!existsSync(imagesFile)) {
    await gzipAtomic(tarOfFolder(imagesDir), imagesFile);
    made = true;
  }
  applyRetention(dir, now.getTime());
  return made ? 'made' : 'already';
}

/** Keep 7 daily, 3 weekly and 12 monthly database copies (retention.ts); a pictures archive goes with its day's copy. */
export function applyRetention(dir: string, now: number): void {
  const files = readdirSync(dir);
  const { keep, delete: drop } = classifyBackups(files, now);
  const keptDays = new Set(keep.map((f) => f.slice(5, 15)));
  const doomed = [...drop, ...files.filter((f) => IMAGES_RE.test(f) && !keptDays.has(IMAGES_RE.exec(f)![1]!))];
  for (const file of doomed) {
    try {
      unlinkSync(resolve(dir, file));
    } catch {
      /* best effort */
    }
  }
}

/** Migrations the database hasn't had yet (drizzle's journal against its table). */
export function pendingMigrations(sqlite: Database.Database, migrationsFolder: string): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  let applied: number[];
  try {
    applied = (sqlite.prepare('SELECT created_at AS at FROM __drizzle_migrations').all() as { at: number }[]).map((r) => Number(r.at));
  } catch {
    return []; // a new database: nothing to keep
  }
  if (applied.length === 0) return [];
  const last = Math.max(...applied);
  return journal.entries.filter((e) => e.when > last).map((e) => e.tag);
}

/**
 * Before migrations change the database: a plain copy of it as it was,
 * `cbld-pre-<first new migration>.sqlite`, the last two kept. Null when
 * nothing is waiting (or the database is new).
 */
export function backupBeforeMigrating(sqlite: Database.Database, migrationsFolder: string, dir: string, log: (line: string) => void = () => {}): string | null {
  const pending = pendingMigrations(sqlite, migrationsFolder);
  if (pending.length === 0) return null;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = `cbld-pre-${pending[0]}.sqlite`;
  const path = resolve(dir, name);
  if (!existsSync(path)) {
    const tmp = `${path}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    sqlite.prepare('VACUUM INTO ?').run(tmp);
    renameSync(tmp, path);
    log(`[backup] copied the database to ${name} before ${pending.length} migration${pending.length === 1 ? '' : 's'}`);
  }
  // The newest two, by when they were made.
  const pre = readdirSync(dir)
    .filter((f) => PRE_MIGRATION_RE.test(f))
    .map((f) => ({ f, at: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of pre.slice(2)) {
    try {
      unlinkSync(resolve(dir, f));
    } catch {
      /* best effort */
    }
  }
  return path;
}

/** The copy of the database made before a one-time data fix writes. */
export const preFixBackupName = (fixId: string) => `cbld-before-fix-${fixId}.sqlite`;

/**
 * Before a one-time data fix (ops/dataFixes.ts) changes the database: a
 * plain copy of it as it is, `cbld-before-fix-<fix>.sqlite`, whole or not
 * there (written beside it, then renamed). It replaces one left by an
 * earlier try, which changed nothing. Nothing deletes it: the operator
 * does, once the fix is known to be good. Throws when the copy can't be made.
 */
export function backupBeforeFix(sqlite: Database.Database, fixId: string, dir: string, log: (line: string) => void = () => {}): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = preFixBackupName(fixId);
  const path = resolve(dir, name);
  const tmp = `${path}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  sqlite.prepare('VACUUM INTO ?').run(tmp);
  renameSync(tmp, path);
  log(`[backup] copied the database to ${name} before the data fix ${fixId}`);
  return path;
}

/** The background pictures' folder for a database at `dbPath`. */
export const imagesDirFor = (dbPath: string) => join(dirname(dbPath), 'bgimages');
