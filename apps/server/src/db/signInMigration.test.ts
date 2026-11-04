// Migration 0040 (sign-in lifetimes): on a database at 0039 with people
// signed in, it keeps every session as it was, gives each the migration's
// time as when it was made (so its longest counts from the deploy, and
// nobody is signed out by it), and leaves the sign-in settings at their
// defaults.
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

describe('migration 0040_sign_in_lifetimes', () => {
  it('is additive: two new columns, nothing dropped or deleted', () => {
    const sql = readFileSync('migrations/0040_sign_in_lifetimes.sql', 'utf8').replace(/^--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE)\b/i);
    expect(sql.match(/ALTER TABLE `\w+` ADD/g)).toHaveLength(2);
  });

  it('keeps every session and dates it from the migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: migrationsUpTo('0039_data_fixes') });

    const now = Date.now();
    sqlite
      .prepare('INSERT INTO users (id, email, display_name, is_demo_account, is_global_admin, is_moderator, email_verified, created_at) VALUES (?, ?, ?, 0, 0, 0, 1, ?)')
      .run('u1', 'one@example.com', 'One', now);
    const session = sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)');
    // One made long ago (its stored end slid forward many times), one just now.
    session.run('s-old', 'u1', now + 20 * 86_400_000);
    session.run('s-new', 'u1', now + 30 * 86_400_000);
    sqlite.prepare("INSERT INTO platform_settings (id, updated_at) VALUES ('singleton', ?)").run(now);

    const before = Date.now();
    migrate(db, { migrationsFolder: 'migrations' });
    const after = Date.now();

    const rows = sqlite.prepare('SELECT id, expires_at AS exp, created_at AS created FROM sessions ORDER BY id').all() as { id: string; exp: number; created: number }[];
    expect(rows.map((r) => [r.id, r.exp])).toEqual([
      ['s-new', now + 30 * 86_400_000],
      ['s-old', now + 20 * 86_400_000],
    ]);
    for (const r of rows) {
      expect(r.created).toBeGreaterThanOrEqual(before - 1000);
      expect(r.created).toBeLessThanOrEqual(after + 1000);
    }
    expect(sqlite.prepare('SELECT sign_in AS s FROM platform_settings').get()).toEqual({ s: null });
    sqlite.close();
  });
});
