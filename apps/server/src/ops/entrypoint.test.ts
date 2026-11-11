// The container's entrypoint (docker/entrypoint.sh) stops with a clear
// message, before the server starts, when it can't write where it keeps
// things: the folders, and the database's own files.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRYPOINT = resolve(import.meta.dirname, '../../../../docker/entrypoint.sh');
// Root writes to read-only files, so the refusals can't be shown as root.
const asRoot = process.getuid?.() === 0;

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cbld-entry-'));
  mkdirSync(join(dir, 'data'));
  db = join(dir, 'data', 'cbld.sqlite');
});
afterEach(() => {
  for (const f of ['', '-wal', '-shm']) {
    try {
      chmodSync(`${db}${f}`, 0o644);
    } catch {
      /* not made */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function run() {
  const r = spawnSync('sh', [ENTRYPOINT, 'sh', '-c', 'echo started'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', DB_PATH: db, PARTS_DIR: join(dir, 'parts'), BACKUPS_DIR: join(dir, 'backups') },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('docker/entrypoint.sh', () => {
  it('starts the server when everything is writable, with or without a database yet, and leaves the files as they were', () => {
    expect(run()).toMatchObject({ code: 0, out: 'started\n' });
    writeFileSync(db, 'database bytes');
    writeFileSync(`${db}-wal`, 'wal bytes');
    writeFileSync(`${db}-shm`, 'shm bytes');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(db, old, old);
    expect(run()).toMatchObject({ code: 0, out: 'started\n' });
    expect(readFileSync(db, 'utf8')).toBe('database bytes');
    expect(readFileSync(`${db}-wal`, 'utf8')).toBe('wal bytes');
    expect(statSync(db).mtimeMs).toBe(old.getTime());
  });

  it.skipIf(asRoot)('stops when the database file itself can’t be written, though its folder can', () => {
    writeFileSync(db, 'database bytes');
    chmodSync(db, 0o444);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain(`cbld: ERROR: the database file ${db} is not writable by uid ${process.getuid!()}`);
    expect(r.err).toContain('(mode 444)');
    expect(r.err).toContain('chown -R');
    // The folder itself was fine: only the file is named.
    expect(r.err).not.toContain('the database folder');
  });

  it.skipIf(asRoot)('stops for the -wal or the -shm file too, naming each', () => {
    writeFileSync(db, 'database bytes');
    writeFileSync(`${db}-wal`, 'wal bytes');
    writeFileSync(`${db}-shm`, 'shm bytes');
    chmodSync(`${db}-wal`, 0o444);
    chmodSync(`${db}-shm`, 0o444);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the database file ${db}-wal is not writable`);
    expect(r.err).toContain(`the database file ${db}-shm is not writable`);
    expect(r.err).not.toContain(`the database file ${db} is not writable`);
  });

  it.skipIf(asRoot)('still stops for a folder it can’t write', () => {
    chmodSync(join(dir, 'data'), 0o555);
    try {
      const r = run();
      expect(r.code).toBe(1);
      expect(r.err).toContain(`the database folder ${join(dir, 'data')} is not writable`);
    } finally {
      chmodSync(join(dir, 'data'), 0o755);
    }
  });
});
