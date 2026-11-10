// The nightly backup is whole or not there, never stops the server, carries
// the background pictures, and a copy is made before migrating.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { applyRetention, backupBeforeMigrating, dbBackupName, gzipIsWhole, imagesBackupName, pendingMigrations, removeStrayTemps, runBackup, tarOfFolder } from './backup.js';

let dir: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cbld-backup-'));
  sqlite = new Database(join(dir, 'live.sqlite'));
  sqlite.exec('create table t (id integer primary key, v text)');
  const put = sqlite.prepare('insert into t (v) values (?)');
  for (let i = 0; i < 500; i++) put.run(`row ${i}`);
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

describe('runBackup', () => {
  it('writes a whole, readable copy and the pictures beside it, and nothing half-made', async () => {
    const backups = join(dir, 'backups');
    const images = join(dir, 'bgimages');
    mkdirSync(images);
    writeFileSync(join(images, 'abc.png'), Buffer.from('not really a png'));
    const now = new Date('2026-11-09T03:00:00Z');
    expect(await runBackup({ dir: backups, sqlite, imagesDir: images, now })).toBe('made');
    const files = readdirSync(backups).sort();
    expect(files).toEqual([imagesBackupName('2026-11-09'), dbBackupName('2026-11-09')].sort());
    expect(await gzipIsWhole(join(backups, dbBackupName('2026-11-09')))).toBe(true);
    // The copy opens and holds every row.
    const copy = join(dir, 'restored.sqlite');
    writeFileSync(copy, gunzipSync(readFileSync(join(backups, dbBackupName('2026-11-09')))));
    const back = new Database(copy, { readonly: true });
    expect(back.prepare('select count(*) as n from t').get()).toEqual({ n: 500 });
    back.close();
    // The pictures unpack with tar.
    const out = join(dir, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-xzf', join(backups, imagesBackupName('2026-11-09')), '-C', out]);
    expect(readFileSync(join(out, 'abc.png'), 'utf8')).toBe('not really a png');
    // A second run the same day makes nothing new.
    expect(await runBackup({ dir: backups, sqlite, imagesDir: images, now })).toBe('already');
  });

  it('a backup cut off by a restart is made again, and its leftovers go', async () => {
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const name = dbBackupName('2026-11-09');
    // What a SIGTERM mid-gzip used to leave: a short .gz, and the copy.
    writeFileSync(join(backups, name), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]));
    writeFileSync(join(backups, 'cbld-2026-11-09.sqlite.tmp'), 'half');
    writeFileSync(join(backups, `${name}.tmp`), 'half');
    const lines: string[] = [];
    await runBackup({ dir: backups, sqlite, imagesDir: join(dir, 'none'), now: new Date('2026-11-09T03:00:00Z'), log: (l) => lines.push(l) });
    expect(await gzipIsWhole(join(backups, name))).toBe(true);
    expect(readdirSync(backups).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(lines.join('\n')).toMatch(/cut off/);
  });

  it('keeps the server answering while it copies (the backup is stepped, not one blocking call)', async () => {
    const backups = join(dir, 'backups');
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    try {
      // Enough data that a stepped backup takes more than one turn of the event loop.
      const put = sqlite.prepare('insert into t (v) values (?)');
      sqlite.transaction(() => {
        for (let i = 0; i < 20_000; i++) put.run('x'.repeat(200));
      })();
      await runBackup({ dir: backups, sqlite, imagesDir: join(dir, 'none'), now: new Date('2026-11-09T03:00:00Z') });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('the pieces', () => {
  it('a gzip that stops early is not whole', async () => {
    const f = join(dir, 'x.gz');
    writeFileSync(f, Buffer.from([0x1f, 0x8b, 8, 0]));
    expect(await gzipIsWhole(f)).toBe(false);
  });

  it('only backup leftovers are removed', () => {
    writeFileSync(join(dir, 'cbld-2026-01-01.sqlite.gz.tmp'), '');
    writeFileSync(join(dir, 'keep.tmp'), '');
    expect(removeStrayTemps(dir)).toEqual(['cbld-2026-01-01.sqlite.gz.tmp']);
    expect(existsSync(join(dir, 'keep.tmp'))).toBe(true);
  });

  it('an empty pictures folder is still a valid archive', async () => {
    const bytes = await streamToBuffer(tarOfFolder(join(dir, 'missing')));
    expect(bytes.length).toBe(1024);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('a pictures archive goes when its day’s database copy does', () => {
    const old = '2025-01-01';
    const recent = '2026-11-08';
    for (const d of [old, recent]) {
      writeFileSync(join(dir, dbBackupName(d)), '');
      writeFileSync(join(dir, imagesBackupName(d)), '');
    }
    applyRetention(dir, new Date('2026-11-09T00:00:00Z').getTime());
    const left = readdirSync(dir);
    expect(left).toContain(dbBackupName(recent));
    expect(left).toContain(imagesBackupName(recent));
    expect(left).not.toContain(dbBackupName(old));
    expect(left).not.toContain(imagesBackupName(old));
  });
});

describe('before migrating', () => {
  function migrationsFolder(tags: { tag: string; when: number }[]): string {
    const f = join(dir, 'migrations');
    mkdirSync(join(f, 'meta'), { recursive: true });
    writeFileSync(join(f, 'meta', '_journal.json'), JSON.stringify({ entries: tags }));
    return f;
  }
  const appliedUpTo = (when: number) => {
    sqlite.exec('create table if not exists __drizzle_migrations (id integer primary key, hash text, created_at numeric)');
    sqlite.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run('h', when);
  };

  it('a new database: nothing to keep', () => {
    const f = migrationsFolder([{ tag: '0000_init', when: 1 }]);
    expect(pendingMigrations(sqlite, f)).toEqual([]);
    expect(backupBeforeMigrating(sqlite, f, join(dir, 'b'))).toBeNull();
  });

  it('copies the database before the first migration it hasn’t had, and keeps the last two', () => {
    const backups = join(dir, 'b');
    appliedUpTo(1);
    const f = migrationsFolder([{ tag: '0000_init', when: 1 }, { tag: '0001_more', when: 2 }, { tag: '0002_again', when: 3 }]);
    expect(pendingMigrations(sqlite, f)).toEqual(['0001_more', '0002_again']);
    const path = backupBeforeMigrating(sqlite, f, backups)!;
    expect(path.endsWith('cbld-pre-0001_more.sqlite')).toBe(true);
    const copy = new Database(path, { readonly: true });
    expect(copy.prepare('select count(*) as n from t').get()).toEqual({ n: 500 });
    copy.close();
    // Two older ones already there: only the newest two stay.
    for (const [n, age] of [['cbld-pre-a.sqlite', 3], ['cbld-pre-b.sqlite', 2]] as const) {
      writeFileSync(join(backups, n), '');
      const t = Date.now() / 1000 - age * 3600;
      utimesSync(join(backups, n), t, t);
    }
    appliedUpTo(2);
    backupBeforeMigrating(sqlite, f, backups);
    expect(readdirSync(backups).sort()).toEqual(['cbld-pre-0001_more.sqlite', 'cbld-pre-0002_again.sqlite']);
  });
});
