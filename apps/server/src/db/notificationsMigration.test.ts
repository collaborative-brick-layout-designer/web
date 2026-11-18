// Migrations 0054 (the notifications table) and 0055 (the backfill): each
// warning or note nobody has acknowledged gets one notification per person
// who should see it, dated when it was sent, by the same rule as
// routes/warnings.ts recipientsOf. It only inserts, and running it again
// adds nothing.
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


describe('migrations 0054_notifications + 0055_notifications_backfill', () => {
  it('0055 only inserts', () => {
    const sql = readFileSync('migrations/0055_notifications_backfill.sql', 'utf8').replace(/^--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|ALTER)\b|\bUPDATE\s+`|\bDELETE\s+FROM\b/i);
    expect(sql.match(/INSERT INTO `notifications`/g)).toHaveLength(1);
    const create = readFileSync('migrations/0054_notifications.sql', 'utf8');
    expect(create).not.toMatch(/\b(DROP|ALTER|INSERT)\b|\bUPDATE\s+`|\bDELETE\s+FROM\b/i);
  });

  it('gives each waiting warning and note one row per recipient, and nothing for acknowledged ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-mig-db-'));
    dirs.push(dir);
    const sqlite = new Database(join(dir, 'db.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: migrationsUpTo('0054_notifications') });

    const t = 1_790_000_000_000;
    const user = sqlite.prepare('INSERT INTO users (id, email, display_name, password_hash, is_demo_account, is_global_admin, is_moderator, email_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?)');
    for (const u of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'mod']) user.run(u, `${u}@example.com`, u, 'hash', t);
    const org = sqlite.prepare('INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, ?)');
    org.run('old', 'Old Club', 'old', t);
    org.run('new', 'New Club', 'new', t);
    const member = sqlite.prepare('INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    // Old Club: no role rows at all (the starting permissions): ann admin, bob manager, cat member.
    member.run('old', 'ann', 'admin', t);
    member.run('old', 'bob', 'manager', t);
    member.run('old', 'cat', 'member', t);
    // New Club: its own roles. dan Admin; eve "Door crew" (invite only); fay "Keepers" (delete items only); gus Member.
    const role = sqlite.prepare('INSERT INTO club_roles (id, org_id, key, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    role.run('new:admin', 'new', 'admin', 'Admin', '[]', 0, t);
    role.run('new:member', 'new', 'member', 'Member', '["view_items","edit_layouts"]', 2, t);
    role.run('new:door', 'new', null, 'Door crew', '["view_items","invite"]', 4, t);
    role.run('new:keep', 'new', null, 'Keepers', '["view_items","delete_items"]', 5, t);
    role.run('new:bad', 'new', null, 'Broken', 'not json', 6, t);
    for (const [u, r] of [['dan', 'member'], ['eve', 'member'], ['fay', 'member'], ['gus', 'member']] as const) member.run('new', u, r, t);
    const holds = sqlite.prepare('INSERT INTO member_roles (org_id, user_id, role_id) VALUES (?, ?, ?)');
    holds.run('new', 'dan', 'new:admin');
    holds.run('new', 'eve', 'new:door');
    holds.run('new', 'fay', 'new:keep');
    holds.run('new', 'gus', 'new:bad');
    // gus has no member_roles row besides the broken one: neither door nor keeper.

    const warn = sqlite.prepare(
      'INSERT INTO warnings (id, scope, club_org_id, subject_user_id, subject_org_id, severity, reason, link, issued_by, created_at, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    warn.run('w-person', 'site', null, 'cat', null, 'warning', 'Be kind', '/editor/x', 'mod', t + 1, null);
    warn.run('w-person-read', 'site', null, 'cat', null, 'warning', 'Old news', null, 'mod', t + 2, t + 3);
    warn.run('w-site-old', 'site', null, null, 'old', 'final', 'Spam', null, 'mod', t + 4, null); // ann, bob
    warn.run('w-site-new', 'site', null, null, 'new', 'warning', 'Spam', null, 'mod', t + 5, null); // dan, eve
    warn.run('n-club-new', 'club', 'new', null, 'new', 'note', 'Module taken back', '/orgs/new', 'gus', t + 6, null); // dan, fay
    warn.run('n-club-old', 'club', 'old', null, 'old', 'note', 'Partner ended', null, null, t + 7, null); // ann, bob
    warn.run('w-member', 'club', 'old', 'cat', null, 'warning', 'Tidy up', null, 'ann', t + 8, null); // cat
    warn.run('n-personal', 'site', null, 'eve', null, 'note', 'Your download is ready', '/profile', null, t + 9, null); // eve

    migrate(db, { migrationsFolder: 'migrations' });

    const rows = sqlite.prepare('SELECT user_id, type, subject_id, club_org_id, needs_membership, title, body, link, created_at, read_at, done_at FROM notifications ORDER BY subject_id, user_id').all() as {
      user_id: string;
      type: string;
      subject_id: string;
      club_org_id: string | null;
      needs_membership: number;
      title: string;
      body: string;
      link: string | null;
      created_at: number;
      read_at: number | null;
      done_at: number | null;
    }[];
    const pairs = rows.map((r) => `${r.subject_id}:${r.user_id}`);
    expect(pairs).toEqual([
      'n-club-new:dan',
      'n-club-new:fay',
      'n-club-old:ann',
      'n-club-old:bob',
      'n-personal:eve',
      'w-member:cat',
      'w-person:cat',
      'w-site-new:dan',
      'w-site-new:eve',
      'w-site-old:ann',
      'w-site-old:bob',
    ]);
    // The count the deploy check compares: waiting warnings × their recipients.
    expect(rows).toHaveLength(11);
    const by = (s: string, u: string) => rows.find((r) => r.subject_id === s && r.user_id === u)!;
    expect(by('w-person', 'cat')).toMatchObject({ type: 'moderation.warning', title: 'Warning from the site team', body: 'Be kind', link: '/editor/x', created_at: t + 1, read_at: null, done_at: null, needs_membership: 0 });
    expect(by('w-site-old', 'bob')).toMatchObject({ type: 'moderation.final_warning', title: 'Final warning from the site team to your club Old Club', club_org_id: 'old', needs_membership: 1 });
    expect(by('n-club-new', 'fay')).toMatchObject({ type: 'moderation.note', title: 'Note from New Club', club_org_id: 'new', needs_membership: 1 });
    expect(by('w-member', 'cat')).toMatchObject({ title: 'Warning from Old Club', club_org_id: 'old', needs_membership: 0 });
    // Nothing else changed.
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM warnings WHERE acknowledged_at IS NULL').get() as { n: number }).n).toBe(7);

    // The deploy check in docs/notifications.md gives the same numbers.
    const doc = readFileSync('../../docs/notifications.md', 'utf8');
    const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks).toHaveLength(2);
    expect((sqlite.prepare(blocks[0]!).get() as { expected: number }).expected).toBe(11);
    expect((sqlite.prepare(blocks[1]!).get() as { inserted: number }).inserted).toBe(11);

    // Running the backfill again adds nothing.
    const again = readFileSync('migrations/0055_notifications_backfill.sql', 'utf8');
    sqlite.exec(again);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n).toBe(11);
    sqlite.close();
  });
});
