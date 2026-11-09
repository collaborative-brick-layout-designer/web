// Per-person and per-club daily counters for the admin abuse view
// (usage_daily in schema.ts): requests, refused requests, uploads,
// upload bytes, share-link views, invite emails sent. Kept in memory and written with the
// dashboard rollup once a minute. Counts only; swept after 90 days.

import { lt } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/index.js';
import { dayKey } from './rollup.js';

export const USAGE_RETENTION_DAYS = 90;

export type UsageMetric = 'requests' | 'refused' | 'uploads' | 'upload_bytes' | 'share_views' | 'invite_emails';

class UsageCounter {
  private adds = new Map<string, number>();

  count(kind: 'user' | 'org', id: string, metric: UsageMetric, n = 1, now: number = Date.now()): void {
    const k = `${dayKey(now)}\u0000${kind}\u0000${id}\u0000${metric}`;
    this.adds.set(k, (this.adds.get(k) ?? 0) + n);
  }

  flush(): void {
    if (this.adds.size === 0) return;
    const add = sqlite.prepare(
      `INSERT INTO usage_daily (day, subject_kind, subject_id, metric, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day, subject_kind, subject_id, metric) DO UPDATE SET value = value + excluded.value`,
    );
    const rows = [...this.adds];
    this.adds.clear();
    sqlite.transaction(() => {
      for (const [k, v] of rows) add.run(...(k.split('\u0000') as [string, string, string, string]), v);
    })();
  }

  /** Today's count so far: what's written plus what's waiting to be. */
  today(kind: 'user' | 'org', id: string, metric: UsageMetric, now: number = Date.now()): number {
    const day = dayKey(now);
    const pending = this.adds.get(`${day}\u0000${kind}\u0000${id}\u0000${metric}`) ?? 0;
    const row = sqlite
      .prepare('SELECT value FROM usage_daily WHERE day = ? AND subject_kind = ? AND subject_id = ? AND metric = ?')
      .get(day, kind, id, metric) as { value: number } | undefined;
    return (row?.value ?? 0) + pending;
  }

  reset(): void {
    this.adds.clear();
  }
}

export const usage = new UsageCounter();

export function sweepUsage(now: number = Date.now()): number {
  const cutoff = dayKey(now - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return db.delete(schema.usageDaily).where(lt(schema.usageDaily.day, cutoff)).run().changes;
}

/** Count an upload for the person sending it and, when it goes to a club, for the club. */
export function recordUpload(actorId: string, owner: { kind: 'user' | 'org'; id: string }, bytes: number): void {
  usage.count('user', actorId, 'uploads');
  usage.count('user', actorId, 'upload_bytes', bytes);
  if (owner.kind === 'org') {
    usage.count('org', owner.id, 'uploads');
    usage.count('org', owner.id, 'upload_bytes', bytes);
  }
}
