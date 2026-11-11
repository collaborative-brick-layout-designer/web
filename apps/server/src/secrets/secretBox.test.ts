// The mail password is stored encrypted: the key file is made once and only
// its owner reads it, CBLD_SECRET_KEY wins over the file, a password saved
// before encryption is encrypted once at start, a missing or wrong key
// never stops the server, and no backup ever holds the key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { encryptSecret, encryptStoredMailPassword, isEncrypted, loadSecretKey, readSecret, SECRET_KEY_FILE, secretKeyPath } from './secretBox.js';
import { backupBeforeFix, backupBeforeMigrating, neverBackedUp, runBackup, tarOfFolder } from '../workers/backup.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cbld-secret-'));
  dbPath = join(dir, 'data', 'cbld.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const keyOf = (lines: string[] = []) => loadSecretKey({ dbPath, log: (l) => lines.push(l) });

function settingsDb(pass: string | null): Database.Database {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec('create table platform_settings (id text primary key, smtp_host text, smtp_pass text, other text)');
  sqlite.prepare(`insert into platform_settings (id, smtp_host, smtp_pass, other) values ('singleton', 'smtp.example.com', ?, 'kept')`).run(pass);
  return sqlite;
}
const stored = (sqlite: Database.Database) => (sqlite.prepare(`select smtp_pass as p from platform_settings`).get() as { p: string | null }).p;

describe('the key file', () => {
  it('is made on first use, beside the database, readable only by its owner, and used again after', () => {
    const lines: string[] = [];
    const first = keyOf(lines);
    expect(first).toHaveLength(32);
    const path = secretKeyPath(dbPath);
    expect(path).toBe(join(dir, 'data', SECRET_KEY_FILE));
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(process.getuid!());
    expect(lines.join('\n')).toMatch(/made the key file/);
    expect(readdirSync(join(dir, 'data'))).toEqual([SECRET_KEY_FILE]); // no leftovers
    const text = readFileSync(path, 'utf8');
    const again: string[] = [];
    expect(keyOf(again)!.equals(first!)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(again).toEqual([]);
  });

  it('is put back to 0600 when it was left readable by others', () => {
    keyOf();
    chmodSync(secretKeyPath(dbPath), 0o644);
    const lines: string[] = [];
    expect(keyOf(lines)).not.toBeNull();
    expect(statSync(secretKeyPath(dbPath)).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).toMatch(/now 0600/);
  });

  it('CBLD_SECRET_KEY is used instead of the file, and no file is made', () => {
    const a = loadSecretKey({ dbPath, envValue: 'a-long-random-value-0123456789' });
    expect(a).toHaveLength(32);
    expect(existsSync(secretKeyPath(dbPath))).toBe(false);
    expect(loadSecretKey({ dbPath, envValue: 'a-long-random-value-0123456789' })!.equals(a!)).toBe(true);
    expect(loadSecretKey({ dbPath, envValue: 'another-long-random-value-9876' })!.equals(a!)).toBe(false);
    // The file's own text works as the env value: an operator can move one to the other.
    const fromFile = keyOf();
    expect(loadSecretKey({ dbPath, envValue: readFileSync(secretKeyPath(dbPath), 'utf8') })!.equals(fromFile!)).toBe(true);
  });

  it('a key that is too short, or a file that can’t be read, gives no key and one line, and never throws', () => {
    const lines: string[] = [];
    expect(loadSecretKey({ dbPath, envValue: 'short', log: (l) => lines.push(l) })).toBeNull();
    expect(lines.join('\n')).toMatch(/CBLD_SECRET_KEY is too short/);
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(secretKeyPath(dbPath), '', { mode: 0o600 });
    const more: string[] = [];
    expect(keyOf(more)).toBeNull();
    expect(more.join('\n')).toMatch(/empty or cut short/);
    // The empty file is left for the operator: it's never silently replaced.
    expect(readFileSync(secretKeyPath(dbPath), 'utf8')).toBe('');
    unlinkSync(secretKeyPath(dbPath));
    mkdirSync(secretKeyPath(dbPath)); // a folder where the file should be
    const last: string[] = [];
    expect(keyOf(last)).toBeNull();
    expect(last).toHaveLength(1);
  });
});

describe('encrypting and reading', () => {
  it('a value comes back as it went in, and is stored differently every time', () => {
    const key = keyOf();
    const secret = 'S3cret pässwörd: with:colons 🔑';
    const a = encryptSecret(secret, key)!;
    const b = encryptSecret(secret, key)!;
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toContain('S3cret');
    expect(a).not.toBe(b); // a new nonce each time
    expect(readSecret(a, key)).toEqual({ state: 'ok', value: secret });
    expect(readSecret(b, key)).toEqual({ state: 'ok', value: secret });
  });

  it('nothing stored is "unset"; a value from before encryption reads as it is', () => {
    const key = keyOf();
    expect(readSecret(null, key).state).toBe('unset');
    expect(readSecret('', key).state).toBe('unset');
    expect(readSecret('old-plain-password', key)).toEqual({ state: 'ok', value: 'old-plain-password' });
    expect(readSecret('old-plain-password', null)).toEqual({ state: 'ok', value: 'old-plain-password' });
  });

  it('a missing key, another key or a changed value is "unreadable", never a throw or a wrong password', () => {
    const key = keyOf();
    const sealed = encryptSecret('the-password', key)!;
    expect(readSecret(sealed, null)).toEqual({ state: 'unreadable', value: null });
    const other = loadSecretKey({ dbPath, envValue: 'some-other-key-entirely-123456' });
    expect(readSecret(sealed, other)).toEqual({ state: 'unreadable', value: null });
    // The key file was deleted: a new one is made, and it doesn't open the old value.
    unlinkSync(secretKeyPath(dbPath));
    expect(readSecret(sealed, keyOf())).toEqual({ state: 'unreadable', value: null });
    // One changed character (authenticated encryption).
    const parts = sealed.split(':');
    const body = Buffer.from(parts[3]!, 'base64');
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString('base64');
    expect(readSecret(parts.join(':'), key).state).toBe('unreadable');
    expect(readSecret('enc:v1:not-three-parts', key).state).toBe('unreadable');
    expect(readSecret('enc:v1:AA==:AA==:AA==', key).state).toBe('unreadable');
    // With no key there is nothing to store with.
    expect(encryptSecret('x', null)).toBeNull();
  });
});

describe('a password saved before encryption', () => {
  it('is encrypted once at start, only that column, with one line; the next start does nothing', () => {
    const sqlite = settingsDb('plain-old-password');
    const key = keyOf();
    const lines: string[] = [];
    expect(encryptStoredMailPassword(sqlite, (l) => lines.push(l), key)).toBe('encrypted');
    const now = stored(sqlite)!;
    expect(isEncrypted(now)).toBe(true);
    expect(readSecret(now, key)).toEqual({ state: 'ok', value: 'plain-old-password' });
    expect(sqlite.prepare('select smtp_host as h, other as o from platform_settings').get()).toEqual({ h: 'smtp.example.com', o: 'kept' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/now stored encrypted/);
    // Again: nothing changes, nothing is said.
    const again: string[] = [];
    expect(encryptStoredMailPassword(sqlite, (l) => again.push(l), key)).toBe('nothing');
    expect(stored(sqlite)).toBe(now);
    expect(again).toEqual([]);
    // The old bytes are gone from the database's files, not only from the row.
    sqlite.close();
    for (const f of readdirSync(join(dir, 'data'))) {
      expect(readFileSync(join(dir, 'data', f)).includes('plain-old-password'), f).toBe(false);
    }
  });

  it('nothing set: nothing to do; no key: left as it was, and said so; no table: no throw', () => {
    const sqlite = settingsDb(null);
    expect(encryptStoredMailPassword(sqlite, () => {}, keyOf())).toBe('nothing');
    sqlite.prepare('update platform_settings set smtp_pass = ?').run('still-plain');
    const lines: string[] = [];
    expect(encryptStoredMailPassword(sqlite, (l) => lines.push(l), null)).toBe('no-key');
    expect(stored(sqlite)).toBe('still-plain');
    expect(lines).toHaveLength(1);
    sqlite.exec('drop table platform_settings');
    expect(encryptStoredMailPassword(sqlite, () => {}, keyOf())).toBe('failed');
    sqlite.close();
  });
});

describe('backups never hold the key', () => {
  it('not the nightly database copy, not the pictures archive, not the copies before a migration or a data fix', async () => {
    const sqlite = settingsDb('plain-old-password');
    const key = keyOf();
    encryptStoredMailPassword(sqlite, () => {}, key);
    const keyText = readFileSync(secretKeyPath(dbPath), 'utf8').trim();
    const data = join(dir, 'data');
    const images = join(data, 'bgimages');
    mkdirSync(images);
    writeFileSync(join(images, 'abc.png'), 'a picture');
    const backups = join(dir, 'backups');

    await runBackup({ dir: backups, sqlite, imagesDir: images, now: new Date('2026-11-11T03:00:00Z') });
    // A copy before a migration: a journal with one migration the database hasn't had.
    const migrations = join(dir, 'migrations');
    mkdirSync(join(migrations, 'meta'), { recursive: true });
    writeFileSync(join(migrations, 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '0000_first', when: 1 }, { tag: '0001_next', when: 2 }] }));
    sqlite.exec('create table __drizzle_migrations (created_at integer)');
    sqlite.exec('insert into __drizzle_migrations values (1)');
    expect(backupBeforeMigrating(sqlite, migrations, backups)).toBe(resolve(backups, 'cbld-pre-0001_next.sqlite'));
    backupBeforeFix(sqlite, 'some-fix', backups);

    const made = readdirSync(backups);
    expect(made).toHaveLength(4);
    for (const name of made) {
      expect(neverBackedUp(name), name).toBe(false);
      const raw = readFileSync(join(backups, name));
      const bytes = name.endsWith('.gz') ? gunzipSync(raw) : raw;
      expect(bytes.includes(keyText), `${name} holds the key`).toBe(false);
      // And the password is in them only encrypted.
      expect(bytes.includes('plain-old-password'), `${name} holds the password`).toBe(false);
    }
    // The database copies do carry the encrypted value: a restore with the key file works.
    const copy = new Database(join(backups, 'cbld-pre-0001_next.sqlite'), { readonly: true });
    expect(readSecret(stored(copy), key)).toEqual({ state: 'ok', value: 'plain-old-password' });
    copy.close();
    sqlite.close();
  });

  it('even an archive of the database’s own folder leaves the key file (and its leftovers) out', async () => {
    keyOf();
    const data = join(dir, 'data');
    writeFileSync(join(data, 'picture.png'), 'a picture');
    writeFileSync(join(data, `${SECRET_KEY_FILE}.123.tmp`), 'half a key');
    const keyText = readFileSync(secretKeyPath(dbPath), 'utf8').trim();
    const parts: Buffer[] = [];
    for await (const c of tarOfFolder(data)) parts.push(c as Buffer);
    const tar = Buffer.concat(parts);
    expect(tar.includes(keyText)).toBe(false);
    expect(tar.includes('half a key')).toBe(false);
    expect(tar.includes(SECRET_KEY_FILE)).toBe(false);
    const tarFile = join(dir, 'data.tar');
    writeFileSync(tarFile, tar);
    expect(execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' }).trim().split('\n')).toEqual(['picture.png']);
  });
});
