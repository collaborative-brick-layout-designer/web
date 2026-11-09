// Fetchers and shapes for usage limits and the abuse view
// (server: routes/adminLimits.ts). Part of the lazily loaded admin chunk.

import { apiGet, apiSend } from '../../api';

export type LimitUnit = 'count' | 'bytes' | 'per_minute' | 'per_day';

export interface GlobalLimit {
  key: string;
  label: string;
  help: string;
  unit: LimitUnit;
  applies: 'user' | 'org' | 'both';
  value: number;
  default: number;
  builtIn: number;
  envVar: string;
  fromEnv: boolean;
  changedHere: boolean;
}

export interface AbuseRow {
  id: string;
  name: string;
  email?: string;
  members?: number;
  createdAt: number;
  suspended: boolean;
  storageBytes: number;
  layouts: number;
  customParts: number;
  modules: number;
  rooms: number;
  /** Public catalog submissions. */
  submissions?: number;
  shareLinks: number;
  uploads1d: number;
  uploads7d: number;
  uploadsPrev7d: number;
  requests1d: number;
  requestsPrev1d: number;
  refused7d: number;
  shareViews7d: number;
  live: number;
  flags: string[];
}

export interface AbuseList {
  sort: string;
  total: number;
  flagged: number;
  rows: AbuseRow[];
}

export interface SubjectLimit {
  key: string;
  label: string;
  help: string;
  unit: LimitUnit;
  value: number;
  source: 'default' | 'smart' | 'override';
  reason: string | null;
  used: number | null;
}

export interface SubjectUsage {
  subject: { kind: 'user' | 'org'; id: string; name: string; email?: string; slug?: string; createdAt: number; emailVerified?: boolean };
  usage: { layouts: number; customParts: number; modules: number; rooms: number; shareLinks: number; members: number; clubsCreated: number; storageBytes: number };
  limits: SubjectLimit[];
  override: { limits: Record<string, number>; suspended: boolean; reason: string | null; updatedAt: number | null };
  series: { days: number[]; requests: number[]; refused: number[]; uploads: number[]; upload_bytes: number[]; share_views: number[] };
  activity: { id: number; at: number; eventType: string; kind: string | null; actor: string | null; name: string | null }[];
}

export const limitsApi = {
  global: () =>
    apiGet<{
      enforced?: boolean;
      /** The admin's switch in Settings. */
      enforcedSetting?: boolean;
      /** 'setting', or the server's LIMITS_ENFORCE forcing it on or off. */
      enforcementSource?: 'setting' | 'forced-on' | 'forced-off';
      limits: GlobalLimit[];
    }>('/api/admin/limits'),
  patchGlobal: (patch: Record<string, number | null>) => apiSend<{ ok: true }>('PATCH', '/api/admin/limits', patch),
  abuse: (kind: 'users' | 'clubs', sort: string) => apiGet<AbuseList>(`/api/admin/abuse/${kind}?sort=${encodeURIComponent(sort)}`),
  usage: (kind: 'user' | 'org', id: string) => apiGet<SubjectUsage>(`/api/admin/${kind === 'user' ? 'users' : 'orgs'}/${id}/usage`),
  putLimits: (kind: 'user' | 'org', id: string, body: { limits?: Record<string, number | null>; suspended?: boolean; reason?: string | null }) =>
    apiSend<{ ok: true }>('PUT', `/api/admin/${kind === 'user' ? 'users' : 'orgs'}/${id}/limits`, body),
};

const MB = 1024 * 1024;

/** A limit value as people read it. */
export function formatLimit(value: number, unit: LimitUnit): string {
  if (unit === 'bytes') {
    if (value >= 1024 * MB) return `${Math.round((value / (1024 * MB)) * 10) / 10} GB`;
    if (value >= MB) return `${Math.round(value / MB)} MB`;
    return `${Math.round(value / 1024)} KB`;
  }
  if (unit === 'per_minute') return `${value.toLocaleString('en-US')} a minute`;
  if (unit === 'per_day') return `${value.toLocaleString('en-US')} a day`;
  return value.toLocaleString('en-US');
}

/** Form value -> stored value: sizes are typed in MB. */
export function toStored(input: string, unit: LimitUnit): number | null {
  const t = input.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return unit === 'bytes' ? Math.round(n * MB) : Math.round(n);
}

/** Stored value -> form value. */
export function toInput(value: number, unit: LimitUnit): string {
  return unit === 'bytes' ? String(Math.round((value / MB) * 100) / 100) : String(value);
}

const EVENT_TEXT: Record<string, string> = {
  create: 'created',
  delete: 'deleted',
  edit: 'changed',
  rename: 'renamed',
  share: 'shared',
  unshare: 'stopped sharing',
  transfer: 'moved',
  role_change: 'changed a role on',
  settings: 'changed the settings of',
  hand_over: 'handed over',
  admin_limits_override: 'changed the limits of',
  admin_suspend: 'turned on read-only for',
  admin_unsuspend: 'lifted read-only for',
  admin_user_patch: 'changed',
  admin_revoke_sessions: 'signed out',
  api_token_issue: 'signed in the desktop app for',
  api_token_revoke: 'signed out a desktop app for',
};

export function describeEvent(e: SubjectUsage['activity'][number]): string {
  const who = e.actor ?? 'Someone';
  const what = EVENT_TEXT[e.eventType] ?? e.eventType.replace(/_/g, ' ');
  const KIND: Record<string, string> = { org: 'a club', user: 'a person', layout: 'a layout', module: 'a module', custom_part: 'a custom part' };
  const thing = e.name ? ` “${e.name}”` : e.kind ? ` ${KIND[e.kind] ?? `a ${e.kind.replace('_', ' ')}`}` : '';
  return `${who} ${what}${thing}`;
}
