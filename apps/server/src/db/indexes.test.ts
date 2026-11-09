// Regression test: the lookup-by-user / by-owner / audit-read indexes
// exist after migrating, and the hot queries actually use them.

import { describe, expect, it } from 'vitest';
import { sqlite } from './index.js';

const EXPECTED = [
  'sessions_user_id_idx',
  'org_members_user_id_idx',
  'layout_collaborators_user_id_idx',
  'custom_part_collaborators_user_id_idx',
  'module_collaborators_user_id_idx',
  'custom_parts_owner_user_id_idx',
  'custom_parts_owner_org_id_idx',
  'modules_owner_user_id_idx',
  'modules_owner_org_id_idx',
  'audit_events_layout_id_created_at_idx',
  'audit_events_resource_created_at_idx',
  'api_tokens_user_id_idx',
  'device_codes_expires_at_idx',
  // Admin insights: time-series graphs bounded by a date range.
  'users_created_at_idx',
  'users_last_seen_at_idx',
  'layouts_created_at_idx',
  'layouts_updated_at_idx',
  'custom_parts_created_at_idx',
  'modules_created_at_idx',
  'daily_stats_metric_day_idx',
  // Foreign keys' child columns (0044): deleting a user, layout, module or
  // club looks them up instead of scanning (2 M audit rows: 586 ms → 40 ms).
  'audit_events_user_id_idx',
  'layouts_created_by_idx',
  'modules_created_by_idx',
  'custom_parts_created_by_idx',
  'venue_library_owner_user_id_idx',
  'venue_library_owner_org_id_idx',
  'catalog_items_owner_user_id_idx',
  'catalog_items_owner_org_id_idx',
  'layout_invites_layout_id_idx',
  'oauth_accounts_user_id_idx',
  'email_verifications_user_id_idx',
  'device_codes_user_id_idx',
  'org_invites_org_id_idx',
  'layout_transfers_layout_id_idx',
  'module_transfers_module_id_idx',
  'module_versions_author_id_idx',
];

function plan(sql: string): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join('\n');
}

describe('schema indexes', () => {
  it('creates every lookup index', () => {
    const names = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const idx of EXPECTED) expect(names).toContain(idx);
  });

  it('uses them for the per-user and audit queries', () => {
    expect(plan(`SELECT * FROM layout_collaborators WHERE user_id = 'u'`)).toContain('layout_collaborators_user_id_idx');
    expect(plan(`SELECT * FROM org_members WHERE user_id = 'u'`)).toContain('org_members_user_id_idx');
    expect(plan(`SELECT id FROM sessions WHERE user_id = 'u'`)).toContain('sessions_user_id_idx');
    expect(
      plan(`SELECT * FROM audit_events WHERE resource_kind = 'module' AND resource_id = 'm' ORDER BY created_at DESC`),
    ).toContain('audit_events_resource_created_at_idx');
  });

  it('uses them when a user goes (their audit rows are set to nobody)', () => {
    expect(plan(`SELECT id FROM audit_events WHERE user_id = 'u'`)).toContain('audit_events_user_id_idx');
    expect(plan(`SELECT id FROM venue_library WHERE owner_user_id = 'u'`)).toContain('venue_library_owner_user_id_idx');
  });

  it('uses them for the admin graphs', () => {
    expect(plan(`SELECT created_at FROM users WHERE created_at >= 0`)).toContain('users_created_at_idx');
    expect(plan(`SELECT count(*) FROM users WHERE last_seen_at >= 0`)).toContain('users_last_seen_at_idx');
    expect(plan(`SELECT created_at FROM layouts WHERE created_at >= 0`)).toContain('layouts_created_at_idx');
    expect(plan(`SELECT day, value FROM daily_stats WHERE metric = 'dau' AND day >= '2026-01-01'`)).toMatch(
      /daily_stats_metric_day_idx|sqlite_autoindex_daily_stats/,
    );
  });
});
