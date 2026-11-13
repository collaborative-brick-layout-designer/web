// Account preferences: the appearance and help settings (and the editor
// lists' picture size and the connection Snap strength) that follow a person between browsers and, through an API token, the desktop app.
//
//   GET /api/me/preferences  -> { prefs, updatedAt }
//   PUT /api/me/preferences  { prefs: {...some keys} } -> { prefs, updatedAt }
//
// PUT merges the keys it is given onto what is stored, so two clients
// that each change one setting don't undo each other. Unknown keys and
// wrong types are refused (400) rather than stored. `updatedAt` is null
// until the account saves anything; the desktop compares it with its
// own copy and keeps the newer one.

import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isLegoColorId } from '@cld/model';

export const THEMES = ['light', 'dark', 'system'] as const;
export const ACCENTS = ['brick', 'ocean', 'forest', 'plum', 'sunny', 'teal', 'orange', 'rose', 'indigo', 'slate'] as const;
export const MAX_TOURS = 200;
/** Picture size in the editor's parts and module lists, in CSS px. */
export const PARTS_ICON_MIN = 32;
export const PARTS_ICON_MAX = 160;
/** How strongly parts snap to each other's connections while dragging. */
export const CONNECTION_SNAP = ['off', 'gentle', 'strong'] as const;
/** How far the color reaches: just the highlights (the original look) or the whole app (the default). */
export const COLOR_STYLES = ['original', 'full'] as const;
const TOUR_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface Preferences {
  theme: (typeof THEMES)[number];
  accent: (typeof ACCENTS)[number];
  /**
   * A LEGO color (LEGO's own color number, @cld/model's LEGO_COLORS) used
   * instead of `accent`, or null for the `accent` preset. Always returned,
   * so the desktop knows it can save it.
   */
  legoColor: number | null;
  /**
   * Always returned, like legoColor. The whole app ("full") is the default;
   * "original" ("Just the highlights") holds only with colorStyleChosen.
   */
  colorStyle: (typeof COLOR_STYLES)[number];
  /**
   * True once the person picks a style in Settings (clients send it with
   * colorStyle). Before the whole app was the default, every save stored
   * colorStyle "original" whether anyone chose it or not (and older
   * desktops send it with every save), so without this "original" is read
   * as the new default. Always returned.
   */
  colorStyleChosen: boolean;
  largeText: boolean;
  expertMode: boolean;
  helpIcons: boolean;
  toursSeen: string[];
  /** Absent until the person sets it (clients migrate an older local value then). */
  partsIconSize?: number;
  /**
   * Snap strength. Always returned (default "gentle"), so a client that
   * sends only the keys a server returns (the desktop) knows it can save it.
   */
  connectionSnap: (typeof CONNECTION_SNAP)[number];
  /**
   * Whether the people who run your clubs see roughly when you were last
   * active (today, this week, this month) in the club's members list.
   */
  shareLastActive: boolean;
  /**
   * Whether to email you when someone asks to join a club where your roles
   * answer requests to join (Settings › Email).
   */
  emailJoinRequests: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  accent: 'brick',
  legoColor: null,
  colorStyle: 'full',
  colorStyleChosen: false,
  largeText: false,
  expertMode: false,
  helpIcons: true,
  toursSeen: [],
  connectionSnap: 'gentle',
  shareLastActive: true,
  emailJoinRequests: true,
};

/**
 * Check a partial preferences object. Returns the cleaned partial, or an
 * error message naming the first bad key.
 */
export function validatePreferences(input: unknown): { ok: Partial<Preferences> } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'prefs must be an object' };
  }
  const out: Partial<Preferences> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    switch (key) {
      case 'theme':
        if (!(THEMES as readonly unknown[]).includes(value)) return { error: `theme must be one of ${THEMES.join(', ')}` };
        out.theme = value as Preferences['theme'];
        break;
      case 'accent':
        if (!(ACCENTS as readonly unknown[]).includes(value)) return { error: `accent must be one of ${ACCENTS.join(', ')}` };
        out.accent = value as Preferences['accent'];
        break;
      case 'legoColor':
        if (value !== null && !isLegoColorId(value)) return { error: 'legoColor must be a LEGO color number from the list, or null' };
        out.legoColor = value;
        break;
      case 'colorStyle':
        if (!(COLOR_STYLES as readonly unknown[]).includes(value)) return { error: `colorStyle must be one of ${COLOR_STYLES.join(', ')}` };
        out.colorStyle = value as Preferences['colorStyle'];
        break;
      case 'colorStyleChosen':
      case 'largeText':
      case 'expertMode':
      case 'helpIcons':
      case 'shareLastActive':
      case 'emailJoinRequests':
        if (typeof value !== 'boolean') return { error: `${key} must be true or false` };
        out[key] = value;
        break;
      case 'toursSeen': {
        if (!Array.isArray(value) || value.length > MAX_TOURS) return { error: `toursSeen must be a list of at most ${MAX_TOURS} ids` };
        if (!value.every((v) => typeof v === 'string' && TOUR_ID.test(v))) return { error: 'toursSeen has an invalid tour id' };
        out.toursSeen = [...new Set(value as string[])];
        break;
      }
      case 'partsIconSize':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < PARTS_ICON_MIN || value > PARTS_ICON_MAX) {
          return { error: `partsIconSize must be a whole number from ${PARTS_ICON_MIN} to ${PARTS_ICON_MAX}` };
        }
        out.partsIconSize = value;
        break;
      case 'connectionSnap':
        if (!(CONNECTION_SNAP as readonly unknown[]).includes(value)) {
          return { error: `connectionSnap must be one of ${CONNECTION_SNAP.join(', ')}` };
        }
        out.connectionSnap = value as (typeof CONNECTION_SNAP)[number];
        break;
      default:
        return { error: `unknown preference: ${key}` };
    }
  }
  return { ok: out };
}

/** "Just the highlights" only when chosen (colorStyleChosen); otherwise the default, the whole app. */
function withChosenStyle(p: Preferences): Preferences {
  return p.colorStyle === 'original' && !p.colorStyleChosen ? { ...p, colorStyle: 'full' } : p;
}

/** Stored JSON back to a full object; anything unreadable falls back to the default. */
function fromStored(raw: string): Preferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
  const checked = validatePreferences(parsed);
  return withChosenStyle({ ...DEFAULT_PREFERENCES, ...('ok' in checked ? checked.ok : {}) });
}

async function load(userId: string): Promise<{ prefs: Preferences; updatedAt: string | null }> {
  const row = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).get();
  if (!row) return { prefs: { ...DEFAULT_PREFERENCES }, updatedAt: null };
  return { prefs: fromStored(row.prefs), updatedAt: row.updatedAt.toISOString() };
}

/** Which of `userIds` hide when they were last active from their clubs (shareLastActive off). */
export async function hidingLastActive(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const rows = await db.select().from(schema.userPreferences).where(inArray(schema.userPreferences.userId, userIds));
  for (const r of rows) if (!fromStored(r.prefs).shareLastActive) out.add(r.userId);
  return out;
}

/** Which of `userIds` turned off the join-request emails (emailJoinRequests off). */
export async function noJoinRequestEmails(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const rows = await db.select().from(schema.userPreferences).where(inArray(schema.userPreferences.userId, userIds));
  for (const r of rows) if (!fromStored(r.prefs).emailJoinRequests) out.add(r.userId);
  return out;
}

/** Roughly when someone was last active: what a club's members list shows. */
export type LastActive = 'today' | 'week' | 'month' | 'older';

const DAY_MS = 24 * 60 * 60 * 1000;
export function lastActiveBucket(seenAt: Date | null, now = Date.now()): LastActive {
  if (!seenAt) return 'older';
  const ago = now - seenAt.getTime();
  if (ago < DAY_MS) return 'today';
  if (ago < 7 * DAY_MS) return 'week';
  if (ago < 30 * DAY_MS) return 'month';
  return 'older';
}

export async function preferencesRoutes(app: FastifyInstance): Promise<void> {
  // Reading is harmless: any token that can read layouts may, as may one
  // granted account:prefs.
  app.get('/api/me/preferences', { config: { apiToken: ['layouts:read', 'account:prefs'] } }, async (req) => {
    const user = requireUser(req);
    return load(user.id);
  });

  app.put<{ Body: { prefs?: unknown } | undefined }>(
    '/api/me/preferences',
    { config: { apiToken: 'account:prefs' } },
    async (req, reply) => {
      const user = requireUser(req);
      const body = req.body;
      if (typeof body !== 'object' || body === null || !('prefs' in body)) {
        return reply.code(400).send({ error: 'prefs is required' });
      }
      const checked = validatePreferences(body.prefs);
      if ('error' in checked) return reply.code(400).send({ error: checked.error });

      const current = await load(user.id);
      const changes = checked.ok;
      // "Just the highlights" without the marker is an older desktop (2.1.3
      // and before) sending its old default with every save, not a choice:
      // it leaves whatever is stored alone.
      if (changes.colorStyle === 'original' && changes.colorStyleChosen !== true) delete changes.colorStyle;
      const prefs: Preferences = withChosenStyle({ ...current.prefs, ...changes });
      const updatedAt = new Date();
      const json = JSON.stringify(prefs);
      await db
        .insert(schema.userPreferences)
        .values({ userId: user.id, prefs: json, updatedAt })
        .onConflictDoUpdate({ target: schema.userPreferences.userId, set: { prefs: json, updatedAt } });
      return { prefs, updatedAt: updatedAt.toISOString() };
    },
  );
}
