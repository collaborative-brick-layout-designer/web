// Admin › Backups: the database copies in the backups folder, listed,
// made on request, downloaded, uploaded, and put back.
//
// What is in the backups folder (BACKUPS_DIR):
//   cbld-<date>.sqlite.gz                    nightly (workers/backup.ts)
//   cbld-manual-<stamp>.sqlite.gz            "Back up now" (last 5 kept)
//   cbld-before-restore-<stamp>.sqlite.gz    made just before a restore (last 3 kept)
//   cbld-upload-<stamp>.sqlite[.gz]          uploaded by an admin (last 3 kept)
//   cbld-pre-<migration>.sqlite              before migrating (last 2 kept)
//   cbld-before-fix-<fix>.sqlite             before a one-time data fix
// each gzipped one with its background pictures beside it as
// `<same name>.bgimages.tar.gz`.
//
// Putting one back is never done on the running database. It is checked
// (a whole gzip, a real SQLite file, `PRAGMA integrity_check`, made by this
// version of the server or an older one), copied whole into the data folder
// as `cbld-restore-staged.sqlite`, a fresh backup of the database as it is
// now is made, and a small note (`cbld-restore.json`) says what to do.
// Then the server stops; when it starts again, before anything opens the
// database (ops/pendingRestore.ts), the staged copy is renamed over the
// database in one step. The key file (`cbld-secret.key`) is never in a
// backup and never touched by a restore.

import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { gzipAtomic, gzipIsWhole, tarOfFolder, neverBackedUp } from '../workers/backup.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipe = pipeline as (...streams: any[]) => Promise<void>;

export type BackupKind = 'nightly' | 'manual' | 'before-restore' | 'upload' | 'pre-migration' | 'before-fix';

/** Every name a database copy may have, by kind. Nothing else in the folder is listed, served or restored. */
const KINDS: readonly { kind: BackupKind; re: RegExp; keep: number | null }[] = [
  { kind: 'nightly', re: /^cbld-\d{4}-\d{2}-\d{2}\.sqlite\.gz$/, keep: null },
  { kind: 'manual', re: /^cbld-manual-\d{8}-\d{6}\.sqlite\.gz$/, keep: 5 },
  { kind: 'before-restore', re: /^cbld-before-restore-\d{8}-\d{6}\.sqlite\.gz$/, keep: 3 },
  { kind: 'upload', re: /^cbld-upload-\d{8}-\d{6}\.sqlite(\.gz)?$/, keep: 3 },
  { kind: 'pre-migration', re: /^cbld-pre-[A-Za-z0-9_-]{1,100}\.sqlite$/, keep: null },
  { kind: 'before-fix', re: /^cbld-before-fix-[A-Za-z0-9_-]{1,100}\.sqlite$/, keep: null },
];

/** The kind of database copy a file name is, or null for anything else. */
export function backupKind(name: string): BackupKind | null {
  for (const k of KINDS) if (k.re.test(name)) return k.kind;
  return null;
}

/** The background pictures' archive that goes with a database copy. */
export const imagesNameFor = (dbName: string) => dbName.replace(/\.sqlite(\.gz)?$/, '.bgimages.tar.gz');

export interface DbBackupFile {
  name: string;
  kind: BackupKind;
  bytes: number;
  at: number;
  /** The pictures' archive beside it, when there is one. */
  images: { name: string; bytes: number } | null;
}

/** Every database copy in the folder, newest first. */
export function listDbBackups(dir: string): DbBackupFile[] {
  if (!existsSync(dir)) return [];
  const names = new Set(readdirSync(dir));
  const out: DbBackupFile[] = [];
  for (const name of names) {
    const kind = backupKind(name);
    if (!kind) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      const img = imagesNameFor(name);
      let images: DbBackupFile['images'] = null;
      if (img !== name && names.has(img)) {
        try {
          images = { name: img, bytes: statSync(join(dir, img)).size };
        } catch {
          /* gone */
        }
      }
      out.push({ name, kind, bytes: st.size, at: st.mtimeMs, images });
    } catch {
      /* gone */
    }
  }
  return out.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

/**
 * A file in the backups folder that may be downloaded: a listed database
 * copy or its pictures' archive, by exact name. Never a path: anything
 * with a slash, `..` or a name that isn't listed is refused, so this can't
 * reach outside the folder or at the key file.
 */
export function servableBackup(dir: string, name: string): string | null {
  if (typeof name !== 'string' || name.length > 200 || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return null;
  for (const f of listDbBackups(dir)) {
    if (f.name === name) return join(dir, f.name);
    if (f.images?.name === name) return join(dir, f.images.name);
  }
  return null;
}

/** `20261124-153012`, in UTC. */
export function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Keep the newest `keep` of each kind that has a count (manual, before-restore, upload); their pictures go with them. */
export function trimKinds(dir: string, protect: string | null = null): void {
  const all = listDbBackups(dir).filter((f) => f.name !== protect);
  for (const k of KINDS) {
    if (k.keep === null) continue;
    const mine = all.filter((f) => f.kind === k.kind).sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const f of mine.slice(k.keep)) {
      for (const n of [f.name, f.images?.name]) {
        if (!n) continue;
        try {
          unlinkSync(join(dir, n));
        } catch {
          /* best effort */
        }
      }
    }
  }
}

export interface SnapshotOptions {
  dir: string;
  sqlite: Database.Database;
  imagesDir: string;
  /** `manual` or `before-restore`. */
  kind: 'manual' | 'before-restore';
  now?: Date;
  /** A copy the trim must keep (the one about to be restored). */
  protect?: string | null;
}

/** A database copy and its pictures, now (an online copy: the server keeps answering). Returns the database copy's name. */
export async function snapshotNow({ dir, sqlite, imagesDir, kind, now = new Date(), protect = null }: SnapshotOptions): Promise<string> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = `cbld-${kind}-${stamp(now)}`;
  const name = `${base}.sqlite.gz`;
  const copy = resolve(dir, `${base}.sqlite.tmp`);
  try {
    await sqlite.backup(copy);
    await gzipAtomic(copy, resolve(dir, name));
  } finally {
    try {
      unlinkSync(copy);
    } catch {
      /* not made */
    }
  }
  await gzipAtomic(tarOfFolder(imagesDir), resolve(dir, imagesNameFor(name)));
  trimKinds(dir, protect);
  return name;
}

// ---------------------------------------------------------------------------
// Checking a copy before it is put back
// ---------------------------------------------------------------------------

export class RestoreRefused extends Error {
  constructor(
    readonly code: 'not_gzip' | 'cut_off' | 'too_big' | 'no_space' | 'not_sqlite' | 'damaged' | 'not_ours' | 'newer',
    message: string,
  ) {
    super(message);
  }
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

function headOf(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf as unknown as Uint8Array<ArrayBuffer>, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Whether a file starts like a gzip stream. */
export const isGzip = (path: string) => {
  const h = headOf(path, 2);
  return h.length === 2 && h[0] === 0x1f && h[1] === 0x8b;
};

/** Free bytes where `path` is, or null when that can't be read. */
export function freeBytes(path: string): number | null {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** The most a database copy may grow to when it is unpacked: a gzip that unpacks without end is cut off here. */
export const MAX_DATABASE_BYTES = 32 * 1024 ** 3;
/** Room left on the data volume after unpacking. */
const SPARE_BYTES = 512 * 1024 ** 2;

/**
 * Copy a backup (gzipped or plain) to `dest`, unpacked, through `dest.tmp`:
 * stops past `maxBytes` (a gzip bomb) or when the data volume would fill.
 */
export async function unpackTo(src: string, dest: string, maxBytes = MAX_DATABASE_BYTES): Promise<number> {
  const free = freeBytes(dirname(dest));
  const cap = Math.min(maxBytes, free === null ? maxBytes : Math.max(0, free - SPARE_BYTES));
  const tmp = `${dest}.tmp`;
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > cap) {
        done(total > maxBytes ? new RestoreRefused('too_big', 'This backup unpacks to more than the server takes.') : new RestoreRefused('no_space', 'There isn’t room on the server to unpack this backup.'));
        return;
      }
      done(null, chunk);
    },
  });
  try {
    const gz = isGzip(src);
    await pipe(createReadStream(src), ...(gz ? [createGunzip()] : []), counter, createWriteStream(tmp)).catch((err: unknown) => {
      if (err instanceof RestoreRefused) throw err;
      throw gz ? new RestoreRefused('cut_off', 'This backup is cut off or damaged: it doesn’t unpack to the end.') : err;
    });
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dest);
    return total;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* not made */
    }
    throw err;
  }
}

export interface DatabaseCheck {
  /** When the newest change in it was made, as best it says (its newest layout or audit row), or null. */
  newestAt: number | null;
  /** The last migration it had, by its journal time. */
  migratedAt: number | null;
  /** True when this server will migrate it up on start. */
  older: boolean;
  counts: { people: number; layouts: number; modules: number; clubs: number };
}

/** The newest migration this server knows (drizzle's journal). */
export function serverMigratedAt(migrationsFolder: string): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] };
  return Math.max(0, ...journal.entries.map((e) => e.when));
}

/**
 * An unpacked copy is a whole SQLite database of this site, made by this
 * version of the server or an older one. It is left in rollback-journal
 * mode, a single self-contained file ready to be renamed into place.
 */
export function checkDatabaseFile(path: string, migrationsFolder: string): DatabaseCheck {
  const head = headOf(path, 16);
  if (head.length < 16 || !head.equals(SQLITE_MAGIC as unknown as Uint8Array<ArrayBuffer>)) throw new RestoreRefused('not_sqlite', 'This file isn’t a database backup.');
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch {
    throw new RestoreRefused('not_sqlite', 'This file isn’t a database backup.');
  }
  try {
    let ok: string;
    try {
      ok = String((db.pragma('integrity_check(1)', { simple: true }) as string | undefined) ?? '');
    } catch {
      ok = '';
    }
    if (ok !== 'ok') throw new RestoreRefused('damaged', 'This backup is damaged: the database inside it doesn’t pass SQLite’s integrity check.');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const t of ['users', 'layouts', '__drizzle_migrations']) {
      if (!tables.has(t)) throw new RestoreRefused('not_ours', 'This database isn’t a backup of this site: it is missing its tables.');
    }
    const migratedAt = (db.prepare('SELECT max(created_at) AS at FROM __drizzle_migrations').get() as { at: number | null }).at;
    const ours = serverMigratedAt(migrationsFolder);
    if (migratedAt !== null && Number(migratedAt) > ours) {
      throw new RestoreRefused('newer', 'This backup was made by a newer version of the server. Update the server first, then restore it.');
    }
    const n = (t: string) => (tables.has(t) ? Number((db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n) : 0);
    let newestAt: number | null = null;
    try {
      const row = db.prepare('SELECT max(updated_at) AS at FROM layouts').get() as { at: number | null };
      newestAt = row.at === null ? null : Number(row.at);
    } catch {
      /* an old schema */
    }
    db.pragma('journal_mode = DELETE');
    return {
      newestAt,
      migratedAt: migratedAt === null ? null : Number(migratedAt),
      older: migratedAt !== null && Number(migratedAt) < ours,
      counts: { people: n('users'), layouts: n('layouts'), modules: n('modules'), clubs: n('orgs') },
    };
  } finally {
    db.close();
    for (const ext of ['-wal', '-shm', '-journal']) {
      try {
        unlinkSync(`${path}${ext}`);
      } catch {
        /* none */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The restore itself: staged now, swapped in when the server next starts
// ---------------------------------------------------------------------------

export const STAGED_NAME = 'cbld-restore-staged.sqlite';
export const RESTORE_NOTE = 'cbld-restore.json';
export const LAST_RESTORE = 'cbld-restore-last.json';

export interface RestoreNote {
  /** The backup it came from (its name in the backups folder). */
  from: string;
  /** Its pictures' archive, to unpack too, or null. */
  images: string | null;
  by: { id: string; name: string };
  at: number;
  /** The backup made just before. */
  safety: string;
}

export interface LastRestore extends RestoreNote {
  doneAt: number;
  ok: boolean;
  message: string;
  imagesRestored: number;
}

/** Write `data` to `path` whole or not at all. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Leave the note that makes the next start put the staged copy in place. */
export function writeRestoreNote(dataDir: string, note: RestoreNote): void {
  writeAtomic(join(dataDir, RESTORE_NOTE), JSON.stringify(note));
}

export function readLastRestore(dataDir: string): LastRestore | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, LAST_RESTORE), 'utf8')) as LastRestore;
  } catch {
    return null;
  }
}

/** Whether a restore is waiting for the next start. */
export const restorePending = (dataDir: string) => existsSync(join(dataDir, RESTORE_NOTE));

/** A plain picture file name as the layouts save them (`<layout id>.<ext>`): nothing else is unpacked. */
const PICTURE_RE = /^[A-Za-z0-9_-]{1,100}\.(png|jpg|jpeg|gif|webp)$/;
const MAX_PICTURES = 100_000;
const MAX_PICTURE_BYTES = 64 * 1024 * 1024;

/**
 * Unpack a pictures' archive (ustar, as tarOfFolder writes) into `destDir`,
 * replacing the files it has and leaving the others. Only plain files with
 * plain picture names: no folders, links or paths (`../`), never the key
 * file. Returns how many were written.
 */
export async function unpackPictures(archive: string, destDir: string): Promise<number> {
  mkdirSync(destDir, { recursive: true });
  let written = 0;
  let entries = 0;
  let pending: Buffer = Buffer.alloc(0);
  // Current entry being read.
  let want = 0; // bytes of file data left
  let pad = 0; // padding after it
  let out: { name: string; parts: Buffer[] } | null = null;
  let ended = false;
  const finishFile = () => {
    if (!out) return;
    const dest = join(destDir, out.name);
    const tmp = `${dest}.restore-tmp`;
    writeFileSync(tmp, Buffer.concat(out.parts as unknown as readonly Uint8Array<ArrayBuffer>[]) as unknown as Uint8Array<ArrayBuffer>);
    renameSync(tmp, dest);
    written += 1;
    out = null;
  };
  const sink = new Writable({
    write(chunk: Buffer, _e, done) {
      if (ended) return done();
      pending = pending.length ? Buffer.concat([pending, chunk] as unknown as readonly Uint8Array<ArrayBuffer>[]) : chunk;
      try {
        for (;;) {
          if (want > 0) {
            const take = Math.min(want, pending.length);
            if (take === 0) break;
            out?.parts.push(pending.subarray(0, take));
            pending = pending.subarray(take);
            want -= take;
            if (want === 0) finishFile();
            continue;
          }
          if (pad > 0) {
            const take = Math.min(pad, pending.length);
            if (take === 0) break;
            pending = pending.subarray(take);
            pad -= take;
            continue;
          }
          if (pending.length < 512) break;
          const h = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (h.every((b) => b === 0)) {
            ended = true;
            break;
          }
          entries += 1;
          if (entries > MAX_PICTURES) throw new Error('too many files in the pictures archive');
          const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
          const size = Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
          const type = String.fromCharCode(h[156] ?? 0);
          if (!Number.isFinite(size) || size < 0) throw new Error('a damaged pictures archive');
          want = size;
          pad = (512 - (size % 512)) % 512;
          const plainFile = type === '0' || type === '\0';
          out = plainFile && size <= MAX_PICTURE_BYTES && PICTURE_RE.test(name) && !neverBackedUp(name) ? { name, parts: [] } : null;
          if (want === 0) finishFile();
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
  await pipe(createReadStream(archive), createGunzip(), sink);
  return written;
}

/**
 * At start, before anything opens the database: when a restore waits,
 * put its staged copy in place of the database in one rename, and its
 * pictures beside it. The old database is checkpointed first, so its
 * write-ahead log can go without losing anything (the backup made just
 * before the restore holds it anyway). Says what happened in
 * `cbld-restore-last.json`, which Admin › Backups shows.
 */
export async function applyPendingRestore(dbPath: string, backupsDir: string, log: (line: string) => void = () => {}): Promise<LastRestore | null> {
  const dataDir = dirname(resolve(dbPath));
  const notePath = join(dataDir, RESTORE_NOTE);
  if (!existsSync(notePath)) return null;
  let note: RestoreNote;
  try {
    note = JSON.parse(readFileSync(notePath, 'utf8')) as RestoreNote;
  } catch {
    unlinkSync(notePath);
    log('[restore] the restore note was unreadable; nothing was restored');
    return null;
  }
  const staged = join(dataDir, STAGED_NAME);
  const done = (ok: boolean, message: string, imagesRestored = 0): LastRestore => {
    const last: LastRestore = { ...note, doneAt: Date.now(), ok, message, imagesRestored };
    try {
      writeAtomic(join(dataDir, LAST_RESTORE), JSON.stringify(last));
    } catch {
      /* the log line still says */
    }
    try {
      unlinkSync(notePath);
    } catch {
      /* gone */
    }
    log(`[restore] ${message}`);
    return last;
  };
  if (!existsSync(staged)) return done(false, `The restore from ${note.from} didn’t happen: its staged copy is missing. The database is as it was.`);
  // Fold the old database's write-ahead log into it, then the log can go.
  if (existsSync(dbPath)) {
    try {
      const old = new Database(dbPath);
      old.pragma('wal_checkpoint(TRUNCATE)');
      old.close();
    } catch (err) {
      return done(false, `The restore from ${note.from} didn’t happen: the database couldn’t be closed cleanly (${(err as Error).message}). The database is as it was.`);
    }
  }
  for (const ext of ['-wal', '-shm']) {
    try {
      unlinkSync(`${dbPath}${ext}`);
    } catch {
      /* none */
    }
  }
  renameSync(staged, dbPath);
  const dirFd = openSync(dataDir, 'r');
  try {
    fsyncSync(dirFd);
  } catch {
    /* not every file system syncs a folder */
  } finally {
    closeSync(dirFd);
  }
  let pictures = 0;
  if (note.images) {
    const archive = join(backupsDir, note.images);
    if (existsSync(archive) && (await gzipIsWhole(archive))) {
      try {
        pictures = await unpackPictures(archive, join(dataDir, 'bgimages'));
      } catch (err) {
        return done(true, `Restored the database from ${note.from}; its background pictures couldn’t all be unpacked (${(err as Error).message}).`, pictures);
      }
    }
  }
  return done(true, `Restored the database from ${note.from}${note.images ? ` and ${pictures} background picture${pictures === 1 ? '' : 's'}` : ''}.`, pictures);
}
