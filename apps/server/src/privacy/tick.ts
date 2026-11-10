// The privacy clean-up: runs every hour (workers/index.ts) and always,
// since keeping personal data longer than promised isn't a choice the
// site can switch off. Each step is safe to run again; tests call it with
// a fake "now".
//
//   - data downloads past their keep-by date: file and row deleted
//   - accounts whose waiting time is over: erased (accountDeletion.ts)
//   - clubs whose waiting time is over: deleted (clubDeletion.ts)
//   - old sign-ins, invites, audit addresses, records (retention.ts)
//   - Recently deleted layouts, modules and venues past their 30 days (trash/trash.ts)

import { purgeExpiredExports } from './exports.js';
import { eraseDueAccounts } from './accountDeletion.js';
import { eraseDueClubs } from './clubDeletion.js';
import { purgeRetention, type RetentionResult } from './retention.js';
import { purgeTrash } from '../trash/trash.js';

export interface PrivacyTickResult {
  exportsPurged: number;
  accountsErased: number;
  clubsErased: number;
  /** Recently deleted things past their 30 days. */
  trashErased: number;
  retention: RetentionResult;
}

export async function privacyTick(now: Date = new Date()): Promise<PrivacyTickResult> {
  const accountsErased = await eraseDueAccounts(now);
  const clubsErased = await eraseDueClubs(now);
  const exportsPurged = await purgeExpiredExports(now);
  const retention = await purgeRetention(now);
  const trashErased = await purgeTrash(now);
  return { exportsPurged, accountsErased, clubsErased, trashErased, retention };
}

/** Plural nouns for the retention counts, as the log line names them. */
const RETENTION_WORDS: Record<keyof RetentionResult, [string, string]> = {
  sessions: ['session', 'sessions'],
  apiTokens: ['app token', 'app tokens'],
  deviceCodes: ['device code', 'device codes'],
  emailVerifications: ['email check', 'email checks'],
  invites: ['invite', 'invites'],
  transfers: ['transfer', 'transfers'],
  auditScrubbed: ['audit entry scrubbed', 'audit entries scrubbed'],
  erasures: ['erasure record', 'erasure records'],
  requests: ['privacy request', 'privacy requests'],
  pictures: ['picture', 'pictures'],
};

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/**
 * The line the server logs after a clean-up that removed something, e.g.
 * "[privacy] clean-up: 2 sessions, 1 invite, 0 exports, 0 accounts, 0 clubs":
 * the record kinds it removed, then always downloads, accounts and clubs.
 * Null when it removed nothing, so a quiet hour logs nothing.
 */
export function privacyTickSummary(r: PrivacyTickResult): string | null {
  const retention = (Object.keys(RETENTION_WORDS) as (keyof RetentionResult)[]).filter((k) => r.retention[k] > 0);
  const total = r.exportsPurged + r.accountsErased + r.clubsErased + r.trashErased + retention.reduce((n, k) => n + r.retention[k], 0);
  if (total === 0) return null;
  const parts = [
    ...retention.map((k) => count(r.retention[k], RETENTION_WORDS[k])),
    ...(r.trashErased > 0 ? [count(r.trashErased, ['deleted item erased', 'deleted items erased'])] : []),
    count(r.exportsPurged, ['export', 'exports']),
    count(r.accountsErased, ['account', 'accounts']),
    count(r.clubsErased, ['club', 'clubs']),
  ];
  return `[privacy] clean-up: ${parts.join(', ')}`;
}
