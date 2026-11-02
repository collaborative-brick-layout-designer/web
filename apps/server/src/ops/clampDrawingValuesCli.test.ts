// The dry run of clamp-drawing-values (clampDrawingValuesCli.ts) on a
// database the way a backup is mounted: in WAL mode, in a folder it can't
// write to, where a plain read-only open fails (SQLite would make the -shm
// file there). It reads the database immutable and writes nothing; with
// changes still in a -wal file, which that open would miss, it stops and
// says so. Run as its own process, as the operator runs it.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc } from '@cld/ydoc';

const SERVER = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TSX = join(SERVER, 'node_modules/.bin/tsx');
const OLD_CORNER = '\n        \n        \n      ';
/** chmod doesn't keep root out of a folder. */
const asRoot = process.getuid?.() === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

/** A database in WAL mode with one layout whose grid holds the old corner text and a million sub-divisions. */
function walDatabase(): { dir: string; file: string; db: Database.Database; layoutId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cld-ro-'));
  dirs.push(dir);
  const file = join(dir, 'backup.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(drizzle(db), { migrationsFolder: join(SERVER, 'migrations') });
  const doc = createDefaultLayoutDoc();
  const grid = doc.getMap<Y.Map<unknown>>('layerData').get('grid-1')!;
  grid.set('cellIndexCorner', OLD_CORNER);
  grid.set('subDivisionNumber', 1_000_000);
  const layoutId = 'old-fordyce';
  db.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)').run('u1', 'u1@example.com', 'U', Date.now());
  db.prepare('INSERT INTO layouts (id, title, created_by, owner_user_id, created_at, updated_at, doc_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    layoutId,
    'Fordyce 2026',
    'u1',
    'u1',
    Date.now(),
    Date.now(),
    Buffer.from(Y.encodeStateAsUpdate(doc)),
  );
  return { dir, file, db, layoutId };
}

function dryRun(file: string) {
  return spawnSync(TSX, ['src/ops/clampDrawingValuesCli.ts', '--db', file], { cwd: SERVER, encoding: 'utf8', timeout: 60_000 });
}

describe('the clamp-drawing-values dry run', () => {
  it.skipIf(asRoot)('reads a WAL database in a folder it can’t write to, and writes nothing', () => {
    const { dir, file, db, layoutId } = walDatabase();
    db.close(); // checkpointed: the -wal file is gone, the database stays in WAL mode
    expect(readdirSync(dir)).toEqual(['backup.sqlite']);
    const bytes = readFileSync(file);
    chmodSync(dir, 0o555);
    // A plain read-only open fails there.
    expect(() => {
      const plain = new Database(file, { readonly: true, fileMustExist: true });
      try {
        plain.prepare('SELECT count(*) FROM sqlite_master').get();
      } finally {
        plain.close();
      }
    }).toThrow();

    const res = dryRun(file);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`layout ${layoutId} "Fordyce 2026": 2 values`);
    expect(res.stdout).toContain('grid.cellIndexCorner (sheet grid-1): "\\n        \\n        \\n      " -> {"x":0,"y":0}');
    expect(res.stdout).toContain('grid.subDivisionNumber (sheet grid-1): 1000000 -> 100');
    expect(res.stdout).toContain('layouts: 1 checked, 1 would change (2 values)');
    expect(res.stdout).toContain('dry run, nothing written');
    // Nothing written, nothing made beside it.
    expect(readdirSync(dir)).toEqual(['backup.sqlite']);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it.skipIf(asRoot)('stops, rather than miss them, when changes wait in a -wal file there', () => {
    const { file, db } = walDatabase();
    // A copy taken while the database was open: its -wal holds the layout.
    db.pragma('wal_autocheckpoint = 0');
    db.prepare("UPDATE layouts SET title = 'Fordyce 2026 (copy)'").run();
    const copyDir = mkdtempSync(join(tmpdir(), 'cld-ro-'));
    dirs.push(copyDir);
    copyFileSync(file, join(copyDir, 'backup.sqlite'));
    copyFileSync(`${file}-wal`, join(copyDir, 'backup.sqlite-wal'));
    db.close();
    chmodSync(copyDir, 0o555);
    const res = dryRun(join(copyDir, 'backup.sqlite'));
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('-wal file to a folder you can write to');
    expect(readdirSync(copyDir).sort()).toEqual(['backup.sqlite', 'backup.sqlite-wal']);
  });

  it('reads a database it may open as usual, and says how to run it when --db is missing', () => {
    const { file, db, layoutId } = walDatabase();
    db.close();
    const res = dryRun(file);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`layout ${layoutId}`);
    const usage = spawnSync(TSX, ['src/ops/clampDrawingValuesCli.ts'], { cwd: SERVER, encoding: 'utf8', timeout: 60_000 });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('node dist/ops/clampDrawingValuesCli.js --db <database file>');
  });
});
