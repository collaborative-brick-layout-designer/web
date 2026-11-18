// How each person wants their notifications (Settings › Notifications;
// GET/PUT /api/me/notification-settings, docs/notifications.md):
//
//   - per type: in the app on or off (warnings always on), email right
//     away / daily summary / weekly summary / off, push on or off;
//   - quiet hours for email and push, in the person's time zone: what is
//     due then waits until they end (summaries aren't held);
//   - when the daily summary goes (a time of day) and the weekly one (a day);
//   - per club: mute it, or turn its email or push off;
//   - pause all email, pause all push.
//
// Defaults: everything in the app; email right away and push for what waits
// for you (requests, invites, warnings, a download ready), nothing else.
// Only what differs from the defaults is stored.

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { NOTIFICATION_TYPES, isNotificationType, type NotificationType, type NotificationTypeInfo } from './types.js';

export const EMAIL_MODES = ['now', 'daily', 'weekly', 'off'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export interface TypeChoice {
  app?: boolean;
  email?: EmailMode;
  push?: boolean;
}
export interface ClubChoice {
  mute?: boolean;
  email?: boolean;
  push?: boolean;
}
export interface StoredSettings {
  v: 1;
  types?: Partial<Record<NotificationType, TypeChoice>>;
  quiet?: { on: boolean; start: string; end: string };
  /** IANA time zone; null: the browser's (the web sends it). */
  timeZone?: string | null;
  dailyAt?: string;
  /** 0 = Sunday … 6 = Saturday. */
  weeklyDay?: number;
  pauseEmail?: boolean;
  pausePush?: boolean;
  clubs?: Record<string, ClubChoice>;
}

export interface Resolved {
  types: Record<NotificationType, Required<TypeChoice>>;
  quiet: { on: boolean; start: string; end: string };
  timeZone: string;
  timeZoneSet: boolean;
  dailyAt: string;
  weeklyDay: number;
  pauseEmail: boolean;
  pausePush: boolean;
  clubs: Record<string, Required<ClubChoice>>;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_CLUBS = 500;

export function defaultChoice(info: NotificationTypeInfo): Required<TypeChoice> {
  return { app: true, email: info.emailApart ? 'off' : info.waits ? 'now' : 'off', push: info.waits };
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Check a PUT body (or what's stored). Returns the cleaned settings, or the first problem. */
export function parseSettings(input: unknown, base: StoredSettings = { v: 1 }): { ok: StoredSettings } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: 'settings must be an object' };
  const out: StoredSettings = structuredClone(base);
  out.v = 1;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    switch (key) {
      case 'v':
        break;
      case 'types': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'types must be an object' };
        const types = { ...(out.types ?? {}) };
        for (const [t, c] of Object.entries(value as Record<string, unknown>)) {
          if (!isNotificationType(t)) return { error: `unknown type: ${t}` };
          if (typeof c !== 'object' || c === null || Array.isArray(c)) return { error: `types.${t} must be an object` };
          const info: NotificationTypeInfo = NOTIFICATION_TYPES[t];
          const next: TypeChoice = { ...(types[t] ?? {}) };
          for (const [ck, cv] of Object.entries(c as Record<string, unknown>)) {
            if (ck === 'app') {
              if (typeof cv !== 'boolean') return { error: `types.${t}.app must be true or false` };
              if (info.appLocked && !cv) return { error: `${t} can't be turned off in the app` };
              next.app = cv;
            } else if (ck === 'email') {
              if (!(EMAIL_MODES as readonly unknown[]).includes(cv)) return { error: `types.${t}.email must be one of ${EMAIL_MODES.join(', ')}` };
              if (info.emailApart && cv !== 'off') return { error: `${t} is always emailed on its own` };
              next.email = cv as EmailMode;
            } else if (ck === 'push') {
              if (typeof cv !== 'boolean') return { error: `types.${t}.push must be true or false` };
              next.push = cv;
            } else return { error: `unknown setting types.${t}.${ck}` };
          }
          types[t] = next;
        }
        out.types = types;
        break;
      }
      case 'quiet': {
        const q = value as { on?: unknown; start?: unknown; end?: unknown } | null;
        if (typeof q !== 'object' || q === null) return { error: 'quiet must be an object' };
        const cur = out.quiet ?? { on: false, start: '22:00', end: '07:00' };
        if (q.on !== undefined && typeof q.on !== 'boolean') return { error: 'quiet.on must be true or false' };
        if (q.start !== undefined && (typeof q.start !== 'string' || !HHMM.test(q.start))) return { error: 'quiet.start must be HH:MM' };
        if (q.end !== undefined && (typeof q.end !== 'string' || !HHMM.test(q.end))) return { error: 'quiet.end must be HH:MM' };
        out.quiet = { on: (q.on as boolean | undefined) ?? cur.on, start: (q.start as string | undefined) ?? cur.start, end: (q.end as string | undefined) ?? cur.end };
        break;
      }
      case 'timeZone':
        if (value !== null && !validTimeZone(value)) return { error: 'timeZone must be a time zone name such as Europe/London, or null' };
        out.timeZone = value as string | null;
        break;
      case 'dailyAt':
        if (typeof value !== 'string' || !HHMM.test(value)) return { error: 'dailyAt must be HH:MM' };
        out.dailyAt = value;
        break;
      case 'weeklyDay':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) return { error: 'weeklyDay must be 0 (Sunday) to 6 (Saturday)' };
        out.weeklyDay = value;
        break;
      case 'pauseEmail':
      case 'pausePush':
        if (typeof value !== 'boolean') return { error: `${key} must be true or false` };
        out[key] = value;
        break;
      case 'clubs': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'clubs must be an object' };
        const clubs = { ...(out.clubs ?? {}) };
        for (const [orgId, c] of Object.entries(value as Record<string, unknown>)) {
          if (orgId.length > 64) return { error: 'clubs has a bad club id' };
          if (c === null) {
            delete clubs[orgId];
            continue;
          }
          if (typeof c !== 'object' || Array.isArray(c)) return { error: `clubs.${orgId} must be an object or null` };
          const next: ClubChoice = { ...(clubs[orgId] ?? {}) };
          for (const [ck, cv] of Object.entries(c as Record<string, unknown>)) {
            if (ck !== 'mute' && ck !== 'email' && ck !== 'push') return { error: `unknown setting clubs.${orgId}.${ck}` };
            if (typeof cv !== 'boolean') return { error: `clubs.${orgId}.${ck} must be true or false` };
            next[ck] = cv;
          }
          clubs[orgId] = next;
        }
        if (Object.keys(clubs).length > MAX_CLUBS) return { error: 'too many clubs' };
        out.clubs = clubs;
        break;
      }
      default:
        return { error: `unknown setting: ${key}` };
    }
  }
  return { ok: out };
}

export function resolve(stored: StoredSettings | null): Resolved {
  const s = stored ?? { v: 1 };
  const types = {} as Record<NotificationType, Required<TypeChoice>>;
  for (const [t, info] of Object.entries(NOTIFICATION_TYPES) as [NotificationType, NotificationTypeInfo][]) {
    const d = defaultChoice(info);
    const c = s.types?.[t] ?? {};
    types[t] = {
      app: info.appLocked ? true : (c.app ?? d.app),
      email: info.emailApart ? 'off' : (c.email ?? d.email),
      push: c.push ?? d.push,
    };
  }
  const clubs: Record<string, Required<ClubChoice>> = {};
  for (const [k, c] of Object.entries(s.clubs ?? {})) clubs[k] = { mute: !!c.mute, email: c.email ?? true, push: c.push ?? true };
  return {
    types,
    quiet: s.quiet ?? { on: false, start: '22:00', end: '07:00' },
    timeZone: s.timeZone && validTimeZone(s.timeZone) ? s.timeZone : 'UTC',
    timeZoneSet: !!s.timeZone,
    dailyAt: s.dailyAt ?? '08:00',
    weeklyDay: s.weeklyDay ?? 1,
    pauseEmail: !!s.pauseEmail,
    pausePush: !!s.pausePush,
    clubs,
  };
}

function fromJson(raw: string): StoredSettings | null {
  try {
    const p = parseSettings(JSON.parse(raw));
    return 'ok' in p ? p.ok : null;
  } catch {
    return null;
  }
}

export async function loadStored(userId: string): Promise<StoredSettings | null> {
  const row = await db.select().from(schema.notificationSettings).where(eq(schema.notificationSettings.userId, userId)).get();
  return row ? fromJson(row.settings) : null;
}

export async function settingsFor(userIds: readonly string[]): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  if (userIds.length === 0) return out;
  const rows = await db.select().from(schema.notificationSettings).where(inArray(schema.notificationSettings.userId, [...userIds])).all();
  const byUser = new Map(rows.map((r) => [r.userId, fromJson(r.settings)]));
  for (const u of userIds) out.set(u, resolve(byUser.get(u) ?? null));
  return out;
}

export async function saveStored(userId: string, s: StoredSettings, at = new Date()): Promise<void> {
  const json = JSON.stringify(s);
  await db
    .insert(schema.notificationSettings)
    .values({ userId, settings: json, updatedAt: at })
    .onConflictDoUpdate({ target: schema.notificationSettings.userId, set: { settings: json, updatedAt: at } });
}

/** What one notification gets: in the app, email (and how), push. */
export function channelsFor(r: Resolved, type: string, clubOrgId: string | null): { app: boolean; email: EmailMode; push: boolean } {
  if (!isNotificationType(type)) return { app: true, email: 'off', push: false };
  const t = r.types[type];
  const club = clubOrgId ? r.clubs[clubOrgId] : undefined;
  const locked = !!(NOTIFICATION_TYPES[type] as NotificationTypeInfo).appLocked;
  const muted = !!club?.mute && !locked;
  return {
    app: locked || (t.app && !muted),
    email: r.pauseEmail || muted || club?.email === false ? 'off' : t.email,
    push: !r.pausePush && !muted && club?.push !== false && t.push,
  };
}

// ---- time in the person's zone --------------------------------------------

/** The wall-clock parts of `at` in `tz`. */
export function localParts(at: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute), dow };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `at` falls in the quiet hours (start → end, across midnight when end < start). */
export function inQuietHours(r: Pick<Resolved, 'quiet' | 'timeZone'>, at: Date): boolean {
  if (!r.quiet.on || r.quiet.start === r.quiet.end) return false;
  const p = localParts(at, r.timeZone);
  const now = p.hh * 60 + p.mm;
  const s = minutes(r.quiet.start);
  const e = minutes(r.quiet.end);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** When the quiet hours that hold `at` end (the first minute after them), or `at` itself outside them. */
export function quietEnds(r: Pick<Resolved, 'quiet' | 'timeZone'>, at: Date): Date {
  if (!inQuietHours(r, at)) return at;
  // Step a minute at a time from the next whole minute (at most a day): exact across zone changes.
  let t = new Date(Math.ceil((at.getTime() + 1) / 60_000) * 60_000);
  for (let i = 0; i < 24 * 60 + 1 && inQuietHours(r, t); i++) t = new Date(t.getTime() + 60_000);
  return t;
}

/** "2026-11-18" for the daily summary, "2026-W47"-style for the weekly one (the local date of that week's day). */
export function periodKey(kind: 'daily' | 'weekly', r: Pick<Resolved, 'timeZone'>, at: Date): string {
  const p = localParts(at, r.timeZone);
  const iso = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return kind === 'daily' ? iso : `week-of-${iso}`;
}

/** Whether a summary of `kind` is due at `at` for these settings (its time of day has come, on its day). */
export function summaryDue(kind: 'daily' | 'weekly', r: Pick<Resolved, 'timeZone' | 'dailyAt' | 'weeklyDay'>, at: Date): boolean {
  const p = localParts(at, r.timeZone);
  if (p.hh * 60 + p.mm < minutes(r.dailyAt)) return false;
  return kind === 'daily' || p.dow === r.weeklyDay;
}
