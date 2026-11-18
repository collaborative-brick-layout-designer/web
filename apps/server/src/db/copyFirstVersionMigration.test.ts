// Migration 0053 (one-time fix, Aaron's OK 2026-11-18): module copies made
// before copies started at version 1, and never saved since, get the first
// version a copy gets today. On a database at 0052 it touches only those
// copies; saved copies, new-style copies and blank never-saved modules (not
// copies) stay as they were, and nothing is removed.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The migrations folder as it was up to and including `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cld-mig-'));
  dirs.push(dir);
  cpSync('migrations', dir, { recursive: true });
  const journalPath = join(dir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((e) => e.tag === lastTag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

type ModuleRow = { id: string; doc_version: number; latest_version: number; title: string; updated_at: number };
type VersionRow = { id: string; module_id: string; version: number; doc_snapshot: Buffer; note: string | null; author_id: string | null; created_at: number };

describe('migration 0053_copy_first_version', () => {
  it('only adds version rows and sets the two version fields; nothing dropped or deleted', () => {
    const sql = readFileSync('migrations/0053_copy_first_version.sql', 'utf8').replace(/^--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE|ALTER)\b/i);
    expect(sql.match(/INSERT INTO `module_versions`/g)).toHaveLength(1);
    expect(sql.match(/UPDATE `modules` SET `doc_version` = 1, `latest_version` = 1/g)).toHaveLength(1);
    expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
  });

  it('gives never-saved copies version 1 with their copied contents, and changes nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: migrationsUpTo('0052_club_partners') });

    const t = 1_790_000_000_000;
    sqlite.prepare('INSERT INTO users (id, email, display_name, password_hash, is_demo_account, is_global_admin, is_moderator, email_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?)').run('u1', 'u1@example.com', 'U1', 'hash', t);
    sqlite.prepare('INSERT INTO users (id, email, display_name, password_hash, is_demo_account, is_global_admin, is_moderator, email_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?)').run('u2', 'u2@example.com', 'U2', 'hash', t);
    sqlite.prepare('INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run('club', 'Club', 'club', t);
    const mod = sqlite.prepare(
      'INSERT INTO modules (id, title, owner_user_id, owner_org_id, created_by, doc_snapshot, doc_version, latest_version, copied_from_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const ver = sqlite.prepare('INSERT INTO module_versions (id, module_id, version, doc_snapshot, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    // The source module, saved twice.
    mod.run('src', 'Source', 'u1', null, 'u1', Buffer.from('src-v2'), 2, 2, null, t, t);
    ver.run('src-1', 'src', 1, Buffer.from('src-v1'), 'u1', t);
    ver.run('src-2', 'src', 2, Buffer.from('src-v2'), 'u1', t);
    // Stuck: copied into a club, and to a person, before the fix; never saved.
    mod.run('stuck-club', 'Club copy', null, 'club', 'u2', Buffer.from('club-copy'), 0, 0, 'src', t + 10, t + 10);
    mod.run('stuck-user', 'My copy', 'u2', null, 'u2', Buffer.from('user-copy'), 0, 0, 'src', t + 20, t + 20);
    // A copy saved since: left alone.
    mod.run('saved-copy', 'Saved copy', null, 'club', 'u2', Buffer.from('saved'), 3, 1, 'src', t + 30, t + 40);
    ver.run('saved-1', 'saved-copy', 1, Buffer.from('saved'), 'u2', t + 40);
    // A copy made after the fix: already version 1.
    mod.run('new-copy', 'New copy', null, 'club', 'u2', Buffer.from('new'), 1, 1, 'src', t + 50, t + 50);
    ver.run('new-1', 'new-copy', 1, Buffer.from('new'), 'u2', t + 50);
    // A blank module from New module, never saved: not a copy, so left alone.
    mod.run('blank', 'Blank', 'u1', null, 'u1', Buffer.from('blank'), 0, 0, null, t + 60, t + 60);

    const modules = () => sqlite.prepare('SELECT id, title, doc_version, latest_version, updated_at FROM modules ORDER BY id').all() as ModuleRow[];
    const versions = () => sqlite.prepare('SELECT * FROM module_versions ORDER BY module_id, version').all() as VersionRow[];
    const beforeModules = modules();
    const beforeVersions = versions();

    migrate(db, { migrationsFolder: 'migrations' });

    const after = modules();
    const changed = after.filter((m, i) => JSON.stringify(m) !== JSON.stringify(beforeModules[i])).map((m) => m.id);
    expect(changed).toEqual(['stuck-club', 'stuck-user']);
    for (const id of changed) {
      const m = after.find((x) => x.id === id)!;
      expect([m.doc_version, m.latest_version]).toEqual([1, 1]);
      expect(m.updated_at).toBe(beforeModules.find((x) => x.id === id)!.updated_at);
    }

    const afterVersions = versions();
    // Every old version row is still there, unchanged; two new ones.
    for (const v of beforeVersions) expect(afterVersions).toContainEqual(v);
    const added = afterVersions.filter((v) => !beforeVersions.some((b) => b.id === v.id));
    expect(added.map((v) => [v.module_id, v.version, v.doc_snapshot.toString(), v.author_id, v.created_at, v.note])).toEqual([
      ['stuck-club', 1, 'club-copy', 'u2', t + 10, null],
      ['stuck-user', 1, 'user-copy', 'u2', t + 20, null],
    ]);
    for (const v of added) expect(v.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(added.map((v) => v.id)).size).toBe(2);
    sqlite.close();
  });

  it('touches no rows on a fresh database built from the migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: 'migrations' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM module_versions').get()).toEqual({ n: 0 });
    sqlite.close();
  });
});
