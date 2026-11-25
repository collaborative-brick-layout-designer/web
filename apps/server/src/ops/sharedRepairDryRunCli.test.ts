// The dry run of the shared modules' repair on a copy of the database, as
// its own process, as it is run: the numbers, no names, nothing written
// (the copy and its folder stay as they were), and never the server's own.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { SHEET, contents, place } from '../test/sharedWorld.js';

const SERVER = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const V1 = contents([{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }]);
const CRANE = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const GONE = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d11';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two people's database: what each layout places, and whether one of its parts is there twice. */
function copyOf(layouts: { module: string; twice: boolean | 'whole' }[], version = 1): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cld-dry-'));
  dirs.push(dir);
  const file = join(dir, 'copy.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(drizzle(db), { migrationsFolder: join(SERVER, 'migrations') });
  const now = Date.now();
  db.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)').run('u1', 'secret@example.com', 'Secret Name', now);
  db.prepare('INSERT INTO modules (id, title, created_by, owner_user_id, created_at, updated_at, doc_snapshot, latest_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(CRANE, 'Secret Crane', 'u1', 'u1', now, now, V1);
  db.prepare('INSERT INTO module_versions (id, module_id, version, doc_snapshot, created_at) VALUES (?, ?, 1, ?, ?)').run('v1', CRANE, V1, now);
  layouts.forEach(({ module, twice }, i) => {
    const doc = createDefaultLayoutDoc();
    const ids = place(doc, { placedId: 'p', moduleId: module, version, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
    if (twice) {
      const list = doc.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks') as Y.Array<Y.Map<unknown>>;
      for (let k = 0; k < (twice === 'whole' ? ids.length : 1); k++) {
        const n = new Y.Map<unknown>();
        for (const [f, v] of Object.entries({ ...list.get(k).toJSON(), ...(twice === 'whole' ? {} : { partNumber: 'other.1' }) })) n.set(f, v);
        list.push([n]);
      }
    }
    db.prepare('INSERT INTO layouts (id, title, created_by, owner_user_id, created_at, updated_at, doc_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`l${i}`, 'Secret Layout', 'u1', 'u1', now, now, Buffer.from(encodeDoc(doc)));
  });
  db.close();
  return { dir, file };
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(join(SERVER, 'node_modules/.bin/tsx'), ['src/ops/sharedRepairDryRunCli.ts', ...args], { cwd: SERVER, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DB_PATH: '/nonexistent/cld.sqlite', PARTS_DIR: '/nonexistent', ...env } });

describe('the dry run of the shared modules’ repair', () => {
  it('counts what would change and what not and why, writes nothing and names nobody', { timeout: 60_000 }, () => {
    const { dir, file } = copyOf([{ module: CRANE, twice: true }, { module: CRANE, twice: false }, { module: GONE, twice: true }]);
    const before = readFileSync(file);
    const files = readdirSync(dir);
    const r = run(['--db', file]);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim().split('\n')).toEqual([
      'Shared modules, extra copies of parts (dry run, nothing written): 3 layouts looked at',
      "  would change: 1 layouts, 1 modules, 1 extra copies taken out, 0 parts made as the owner's version has them",
      '  would skip: 1 modules (1 layouts where nothing changes)',
      '    1: the library module is gone or has no owner',
    ]);
    expect(r.status).toBe(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(files);
  });

  it('counts whole sets as left alone', { timeout: 60_000 }, () => {
    const { file } = copyOf([{ module: CRANE, twice: 'whole' }]);
    const r = run(['--db', file]);
    expect(r.stdout).toContain('would change: 0 layouts');
    expect(r.stdout).toContain('1: the whole module is there more than once, every set as its owner has it');
  });

  it('says when the version a layout has isn’t kept', { timeout: 60_000 }, () => {
    const { file } = copyOf([{ module: CRANE, twice: true }], 9);
    const r = run(['--db', file]);
    expect(r.stdout).toContain('would change: 0 layouts');
    expect(r.stdout).toContain("1: the version the layout has isn't kept or can't be read");
  });

  it('wants an absolute path of a copy, and never takes the server’s own database', { timeout: 60_000 }, () => {
    const { file } = copyOf([]);
    for (const args of [[], ['--db', 'copy.sqlite'], ['--db', '/nonexistent/x.sqlite']]) expect(run(args).status).toBe(2);
    const own = run(['--db', file], { DB_PATH: file });
    expect(own.status).toBe(2);
    expect(own.stdout).toContain("the server's own database");
  });
});
