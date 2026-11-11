// Secrets the database keeps (the mail password in
// platform_settings.smtp_pass) are stored encrypted, so a copy of the
// database (the nightly backup, the copy before a migration) doesn't hold
// them in the clear.
//
//   - The key is in `cbld-secret.key`, beside the database (`/data` in
//     Docker): made on the first start, readable only by the user the server
//     runs as (0600). CBLD_SECRET_KEY, when set, is used instead of the file.
//   - A value is stored as `enc:v1:<nonce>:<ciphertext>:<tag>` (base64),
//     AES-256-GCM with a new random nonce each time.
//   - Nothing here throws at start: with no key, or the wrong one, a stored
//     value reads as "can't be read" and the admin enters it again.
//   - The key file is never part of a backup (workers/backup.ts).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { env } from '../env.js';

/** The key file's name, in the database's folder. */
export const SECRET_KEY_FILE = 'cbld-secret.key';
export const secretKeyPath = (dbPath: string) => join(dirname(dbPath), SECRET_KEY_FILE);

const PREFIX = 'enc:v1:';
/** Ties a stored value to what it is, so it can't be moved to another column. */
const CONTEXT = Buffer.from('cbld:platform_settings.smtp_pass');
/** The shortest key text that's accepted, from the file or the environment. */
const MIN_KEY_CHARS = 16;

const derive = (material: string) => scryptSync(material, 'cbld-secret-key-v1', 32);

export interface LoadKeyOptions {
  dbPath: string;
  /** CBLD_SECRET_KEY: used instead of the file when set. */
  envValue?: string | undefined;
  log?: (line: string) => void;
}

/**
 * The key: from CBLD_SECRET_KEY, or the key file, which is made when it's
 * missing. Null (with one logged line) when there's no usable key; never throws.
 */
export function loadSecretKey({ dbPath, envValue, log = () => {} }: LoadKeyOptions): Buffer | null {
  const fromEnv = envValue?.trim() ?? '';
  if (fromEnv !== '') {
    if (fromEnv.length < MIN_KEY_CHARS) {
      log(`[secrets] CBLD_SECRET_KEY is too short (under ${MIN_KEY_CHARS} characters), so saved secrets can't be read or kept. Use a long random value, for example from: openssl rand -base64 32`);
      return null;
    }
    return derive(fromEnv);
  }
  const path = secretKeyPath(dbPath);
  try {
    if (!existsSync(path)) createKeyFile(path, log);
    const st = statSync(path);
    if (!st.isFile()) throw new Error('it is not a file');
    if ((st.mode & 0o077) !== 0) {
      // Someone copied it with wider permissions: only this user reads it.
      chmodSync(path, 0o600);
      log(`[secrets] ${path} was readable by others; it is now 0600`);
    }
    const material = readFileSync(path, 'utf8').trim();
    if (material.length < MIN_KEY_CHARS) {
      log(`[secrets] ${path} is empty or cut short, so saved secrets can't be read or kept. Put the right file back, or delete it and enter the mail password again in Admin › Settings.`);
      return null;
    }
    return derive(material);
  } catch (err) {
    log(`[secrets] the key file ${path} can't be read or made (${(err as Error).message}), so saved secrets can't be read or kept`);
    return null;
  }
}

/** A new key file, whole or not there: written beside it, then linked into place (never over one that exists). */
function createKeyFile(path: string, log: (line: string) => void): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${randomBytes(32).toString('base64')}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600); // whatever the umask was
    linkSync(tmp, path);
    log(`[secrets] made the key file ${path} (0600). Back it up apart from the database: without it, the saved mail password has to be entered again.`);
  } catch (err) {
    // Another process made it first: use theirs.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    unlinkSync(tmp);
  }
}

let loaded: { key: Buffer | null } | null = null;

/** This server's key, loaded once. */
export function secretKey(): Buffer | null {
  loaded ??= { key: loadSecretKey({ dbPath: env.dbPath, envValue: env.secretKey, log: (line) => console.warn(line) }) };
  return loaded.key;
}

/** Tests: load the key again on the next use. */
export function forgetSecretKey(): void {
  loaded = null;
}

export const isEncrypted = (stored: string) => stored.startsWith(PREFIX);

/** `plain`, encrypted for storing. Null when there's no key. */
export function encryptSecret(plain: string, key: Buffer | null = secretKey()): string | null {
  if (!key) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(CONTEXT);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${nonce.toString('base64')}:${body.toString('base64')}:${cipher.getAuthTag().toString('base64')}`;
}

export type SecretRead =
  /** Nothing is stored. */
  | { state: 'unset'; value: null }
  | { state: 'ok'; value: string }
  /** Something is stored, and this server's key doesn't open it (no key, another key, or a damaged value). */
  | { state: 'unreadable'; value: null };

/**
 * What a stored value holds. A value from before encryption (no `enc:v1:`
 * in front) reads as it is; the next start encrypts it.
 */
export function readSecret(stored: string | null | undefined, key: Buffer | null = secretKey()): SecretRead {
  if (stored === null || stored === undefined || stored === '') return { state: 'unset', value: null };
  if (!isEncrypted(stored)) return { state: 'ok', value: stored };
  const parts = stored.slice(PREFIX.length).split(':');
  if (!key || parts.length !== 3) return { state: 'unreadable', value: null };
  try {
    const [nonce, body, tag] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
    if (nonce.length !== 12 || tag.length !== 16) return { state: 'unreadable', value: null };
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(CONTEXT);
    decipher.setAuthTag(tag);
    return { state: 'ok', value: Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8') };
  } catch {
    return { state: 'unreadable', value: null };
  }
}

/** What Admin › Settings and the log say when the stored mail password can't be opened. */
export const MAIL_PASSWORD_UNREADABLE = "The SMTP password can't be read. Please enter it again.";

/**
 * At start: a mail password saved before encryption is encrypted where it
 * is, once. Only platform_settings.smtp_pass changes; a value that is
 * already encrypted (or not set) is left alone, so running it again does
 * nothing. The old bytes are overwritten in the database file and the
 * write-ahead log is emptied, so the next backup doesn't carry them.
 * Never throws.
 */
export function encryptStoredMailPassword(sqlite: Database.Database, log: (line: string) => void = () => {}, key: Buffer | null = secretKey()): 'encrypted' | 'nothing' | 'no-key' | 'failed' {
  try {
    const row = sqlite.prepare(`SELECT smtp_pass AS pass FROM platform_settings WHERE id = 'singleton'`).get() as { pass: string | null } | undefined;
    const plain = row?.pass;
    if (!plain || isEncrypted(plain)) return 'nothing';
    const sealed = encryptSecret(plain, key);
    if (!sealed) {
      log('[secrets] the saved mail password is not encrypted yet: there is no usable key (see above)');
      return 'no-key';
    }
    const before = sqlite.pragma('secure_delete', { simple: true });
    sqlite.pragma('secure_delete = ON');
    try {
      sqlite.prepare(`UPDATE platform_settings SET smtp_pass = ? WHERE id = 'singleton' AND smtp_pass = ?`).run(sealed, plain);
    } finally {
      sqlite.pragma(`secure_delete = ${Number(before) === 0 ? 'OFF' : Number(before) === 2 ? 'FAST' : 'ON'}`);
    }
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* someone is reading: the next checkpoint does it */
    }
    log('[secrets] the saved mail password is now stored encrypted (a one-time change to platform_settings.smtp_pass; nothing else was touched)');
    return 'encrypted';
  } catch (err) {
    log(`[secrets] couldn't encrypt the saved mail password (${(err as Error).message}); it stays as it was`);
    return 'failed';
  }
}
