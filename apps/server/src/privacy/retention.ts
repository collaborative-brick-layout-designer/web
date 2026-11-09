// Keeping personal data no longer than needed (Admin › Settings ›
// Privacy). Run by the hourly privacy clean-up (tick.ts); each step is
// safe to repeat and tests drive it with a fake "now".
//
//   expiredSignInDays   browser sessions that expired, desktop sign-ins
//                       revoked or expired, device codes, email
//                       confirmation links, and invites and offers nobody
//                       accepted: deleted this long after they ended
//   auditPersonalDays   email addresses (and any ip / userAgent field) in
//                       audit-log payloads older than this: removed; what
//                       happened stays
//   recordsKeepDays     erasure records, and privacy requests once closed
//   always              background pictures whose layout is gone

import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, asc, eq, gt, isNotNull, isNull, like, lt, lte, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { privacySettings } from './settings.js';
import { purgeClosedRequests } from '../routes/privacyAdmin.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Audit rows read at a time. */
const AUDIT_BATCH = 2000;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PERSONAL_KEYS = new Set(['ip', 'ipAddress', 'userAgent', 'user_agent', 'client']);

export interface RetentionResult {
  sessions: number;
  apiTokens: number;
  deviceCodes: number;
  emailVerifications: number;
  invites: number;
  transfers: number;
  auditScrubbed: number;
  erasures: number;
  requests: number;
  pictures: number;
}

/** A payload with addresses and ip / user-agent fields taken out; null when nothing changed. */
export function scrubPayload(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    const s = payload.replace(EMAIL_RE, '(removed)');
    return s === payload ? null : s;
  }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = v.replace(EMAIL_RE, '(removed)');
      if (s !== v) changed = true;
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (PERSONAL_KEYS.has(k)) {
          changed = true;
          continue;
        }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  const next = walk(parsed);
  return changed ? JSON.stringify(next) : null;
}

export async function purgeRetention(now = new Date()): Promise<RetentionResult> {
  const s = schema;
  const p = await privacySettings(now.getTime());
  const signInCutoff = new Date(now.getTime() - p.expiredSignInDays * DAY_MS);
  const res: RetentionResult = {
    sessions: 0,
    apiTokens: 0,
    deviceCodes: 0,
    emailVerifications: 0,
    invites: 0,
    transfers: 0,
    auditScrubbed: 0,
    erasures: 0,
    requests: 0,
    pictures: 0,
  };
  const run = (q: { run: () => { changes: number } }) => q.run().changes;

  res.sessions = run(db.delete(s.sessions).where(lt(s.sessions.expiresAt, signInCutoff)));
  res.apiTokens = run(
    db.delete(s.apiTokens).where(or(and(isNotNull(s.apiTokens.revokedAt), lt(s.apiTokens.revokedAt, signInCutoff)), lt(s.apiTokens.expiresAt, signInCutoff))),
  );
  res.deviceCodes = run(db.delete(s.deviceCodes).where(lt(s.deviceCodes.expiresAt, signInCutoff)));
  res.emailVerifications =
    run(db.delete(s.emailVerifications).where(lt(s.emailVerifications.expiresAt, signInCutoff))) +
    run(db.delete(s.passwordResets).where(lt(s.passwordResets.expiresAt, signInCutoff)));
  res.invites =
    run(db.delete(s.layoutInvites).where(and(isNull(s.layoutInvites.acceptedAt), lt(s.layoutInvites.expiresAt, signInCutoff)))) +
    run(db.delete(s.customPartInvites).where(and(isNull(s.customPartInvites.acceptedAt), lt(s.customPartInvites.expiresAt, signInCutoff)))) +
    run(db.delete(s.moduleInvites).where(and(isNull(s.moduleInvites.acceptedAt), lt(s.moduleInvites.expiresAt, signInCutoff)))) +
    run(db.delete(s.orgInvites).where(and(isNull(s.orgInvites.acceptedAt), lt(s.orgInvites.expiresAt, signInCutoff))));
  res.transfers =
    run(db.delete(s.layoutTransfers).where(and(isNull(s.layoutTransfers.acceptedAt), lt(s.layoutTransfers.expiresAt, signInCutoff)))) +
    run(db.delete(s.moduleTransfers).where(and(isNull(s.moduleTransfers.acceptedAt), lt(s.moduleTransfers.expiresAt, signInCutoff))));

  // Addresses in old audit rows: the "what" stays, the "who by email" goes.
  const auditCutoff = new Date(now.getTime() - p.auditPersonalDays * DAY_MS);
  // In batches by id, so rows with an '@' that isn't an address never stall it.
  for (let lastId = 0; ; ) {
    const rows = db
      .select({ id: s.auditEvents.id, payload: s.auditEvents.payload })
      .from(s.auditEvents)
      .where(
        and(
          gt(s.auditEvents.id, lastId),
          lt(s.auditEvents.createdAt, auditCutoff),
          or(like(s.auditEvents.payload, '%@%'), like(s.auditEvents.payload, '%"ip%'), like(s.auditEvents.payload, '%serAgent%'), like(s.auditEvents.payload, '%user_agent%'), like(s.auditEvents.payload, '%"client"%')),
        ),
      )
      .orderBy(asc(s.auditEvents.id))
      .limit(AUDIT_BATCH)
      .all();
    if (rows.length === 0) break;
    for (const r of rows) {
      const next = scrubPayload(r.payload);
      if (next !== null) {
        db.update(s.auditEvents).set({ payload: next }).where(eq(s.auditEvents.id, r.id)).run();
        res.auditScrubbed++;
      }
    }
    lastId = rows[rows.length - 1]!.id;
  }

  const recordsCutoff = new Date(now.getTime() - p.recordsKeepDays * DAY_MS);
  res.erasures = run(db.delete(s.erasures).where(lte(s.erasures.erasedAt, recordsCutoff)));
  res.requests = await purgeClosedRequests(now);

  // Background pictures whose layout is gone (deleted before erasure swept
  // its files, or by an older version that left them behind).
  const bgDir = join(dirname(env.dbPath), 'bgimages');
  let files: string[];
  try {
    files = readdirSync(bgDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    const id = /^([0-9a-f-]{36})\.(png|jpg|gif|webp)$/.exec(f)?.[1];
    if (!id) continue;
    if (db.select({ id: s.layouts.id }).from(s.layouts).where(eq(s.layouts.id, id)).get()) continue;
    try {
      unlinkSync(join(bgDir, f));
      res.pictures++;
    } catch {
      /* best effort */
    }
  }
  return res;
}
