// Migration 0049 (users.email_proven_at): additive, one nullable column. On a
// database at 0048 holding every kind of account, it fills the marker only
// where the proof is on record (a GitHub link: GitHub has only ever signed
// people in with an address it marks verified) and leaves everyone else
// null, including accounts stored as verified and the demo accounts.
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

describe('migration 0049_email_proven_at', () => {
  it('is additive: one new column, nothing dropped or deleted', () => {
    const sql = readFileSync('migrations/0049_email_proven_at.sql', 'utf8').replace(/^--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE)\b/i);
    expect(sql.match(/ALTER TABLE `\w+` ADD/g)).toHaveLength(1);
    // The one UPDATE writes only the new column.
    expect(sql.match(/UPDATE `users` SET `email_proven_at` =/g)).toHaveLength(1);
    expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
  });

  it('fills the marker only for accounts with a GitHub link, and changes nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: migrationsUpTo('0048_oauth_account_issuer') });

    const now = Date.now();
    const user = sqlite.prepare(
      'INSERT INTO users (id, email, display_name, password_hash, is_demo_account, is_global_admin, is_moderator, email_verified, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)',
    );
    const link = sqlite.prepare('INSERT INTO oauth_accounts (provider, provider_user_id, user_id, issuer) VALUES (?, ?, ?, ?)');
    // Password accounts: verified (by a link, or made while checks were off: no record says which), and not.
    user.run('pw-verified', 'pw@example.com', 'Pw', 'hash', 0, 1, now);
    user.run('pw-unverified', 'pu@example.com', 'Pu', 'hash', 0, 0, now);
    // Provider accounts.
    user.run('gh', 'gh@example.com', 'Gh', null, 0, 1, now);
    link.run('github', '1', 'gh', null);
    user.run('google', 'go@example.com', 'Go', null, 0, 1, now);
    link.run('google', '2', 'google', null);
    user.run('sso', 'sso@example.com', 'Sso', null, 0, 1, now);
    link.run('oidc', '3', 'sso', 'https://sso.test');
    // A password account that later linked GitHub too.
    user.run('pw-gh', 'pg@example.com', 'Pg', 'hash', 0, 1, now);
    link.run('github', '4', 'pw-gh', null);
    // A demo account, even one with a GitHub link: never.
    user.run('demo', 'demo@example.com', 'Demo', null, 1, 1, now);
    link.run('github', '5', 'demo', null);

    const cols = () => sqlite.prepare('SELECT id, email, display_name, password_hash, is_demo_account, email_verified, created_at FROM users ORDER BY id').all();
    const before = cols();
    const t0 = Date.now();
    migrate(db, { migrationsFolder: 'migrations' });
    const t1 = Date.now();

    const rows = sqlite.prepare('SELECT id, email_proven_at AS p FROM users ORDER BY id').all() as { id: string; p: number | null }[];
    const proven = rows.filter((r) => r.p !== null).map((r) => r.id);
    expect(proven).toEqual(['gh', 'pw-gh']);
    for (const r of rows.filter((x) => x.p !== null)) {
      expect(r.p).toBeGreaterThanOrEqual(t0 - 1000);
      expect(r.p).toBeLessThanOrEqual(t1 + 1000);
    }
    // 2 of the 7 accounts touched; every other column as it was.
    expect(rows).toHaveLength(7);
    expect(cols()).toEqual(before);
    sqlite.close();
  });

  it('touches no rows on a fresh database built from the migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: 'migrations' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM users WHERE email_proven_at IS NOT NULL').get()).toEqual({ n: 0 });
    sqlite.close();
  });
});
