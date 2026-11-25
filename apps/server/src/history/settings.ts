// Admin › Backups › Version history: the switch and the numbers behind the
// layout version history (history/layoutVersions.ts) and how many of the
// hand-made, before-restore and uploaded database backups are kept
// (ops/dbBackups.ts). One JSON object in platform_settings.history; each
// value, first match wins:
//   1. VERSION_HISTORY_ENABLED forces the switch: the page says "Forced by …"
//   2. what an admin saved
//   3. the built-in default below
// Read live with a short cache, cleared on save.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import { env } from '../env.js';

export type HistorySettingKey =
  | 'autoMinutes'
  | 'bulkDeleteParts'
  | 'keepAllDays'
  | 'keepDailyDays'
  | 'keepWeeklyWeeks'
  | 'keepBeforeDays'
  | 'keepNamed'
  | 'backupManualKeep'
  | 'backupBeforeRestoreKeep'
  | 'backupUploadKeep';

export interface HistorySettingInfo {
  key: HistorySettingKey;
  label: string;
  help: string;
  builtIn: number;
  min: number;
  max: number;
  unit: string;
  /** Which part of the page it sits in. */
  group: 'versions' | 'keep' | 'backups';
}

export const HISTORY_SETTINGS: readonly HistorySettingInfo[] = [
  { key: 'autoMinutes', group: 'versions', label: 'Minutes between automatic versions', help: 'While people edit a layout, a new version is kept at most this often, and only if something changed.', builtIn: 30, min: 5, max: 1440, unit: 'minutes' },
  { key: 'bulkDeleteParts', group: 'versions', label: 'Big delete', help: 'When one change deletes this many parts or more, the layout as it was is kept first, so it can be put back.', builtIn: 50, min: 5, max: 100000, unit: 'parts' },
  { key: 'keepAllDays', group: 'keep', label: 'Keep every version for', help: 'Every version from the last this-many days is kept, however many there are.', builtIn: 1, min: 1, max: 30, unit: 'days' },
  { key: 'keepDailyDays', group: 'keep', label: 'Then one a day for', help: 'After that, the newest version of each day is kept for this many days. 0 skips this step.', builtIn: 30, min: 0, max: 730, unit: 'days' },
  { key: 'keepWeeklyWeeks', group: 'keep', label: 'Then one a week for', help: 'After that, the newest version of each week is kept for this many weeks. 0 skips this step.', builtIn: 26, min: 0, max: 520, unit: 'weeks' },
  { key: 'keepBeforeDays', group: 'keep', label: 'Versions kept before a change, for', help: 'The versions kept just before an import, an added layout, a restore, a big delete or a tidy-up of a shared module’s parts are kept this many days. (The one before a tidy-up is made even with version history off.)', builtIn: 30, min: 1, max: 730, unit: 'days' },
  { key: 'keepNamed', group: 'keep', label: 'Named versions kept', help: 'Versions someone gave a name are kept for good, up to this many per layout (the newest).', builtIn: 50, min: 1, max: 1000, unit: 'versions' },
  { key: 'backupManualKeep', group: 'backups', label: 'Backups made by hand', help: 'How many of the backups made with “Back up now” are kept. Older ones are removed.', builtIn: 5, min: 1, max: 100, unit: 'backups' },
  { key: 'backupBeforeRestoreKeep', group: 'backups', label: 'Backups made before a restore', help: 'How many of the backups made just before a restore are kept.', builtIn: 3, min: 1, max: 100, unit: 'backups' },
  { key: 'backupUploadKeep', group: 'backups', label: 'Backups uploaded', help: 'How many backups an admin uploaded are kept.', builtIn: 3, min: 1, max: 100, unit: 'backups' },
];

export type HistoryLimits = Record<HistorySettingKey, number>;

export interface HistorySettingsState {
  /** Whether new versions are kept. */
  enabled: boolean;
  /** The switch as saved, and the env var that forces it, if any. */
  enabledSetting: boolean;
  enabledForcedBy: string | null;
  limits: HistoryLimits;
}

interface Stored {
  enabled?: unknown;
  limits?: Record<string, unknown>;
}

export const DEFAULT_HISTORY_LIMITS = Object.fromEntries(HISTORY_SETTINGS.map((i) => [i.key, i.builtIn])) as HistoryLimits;

let cache: { at: number; value: HistorySettingsState } | null = null;
const CACHE_MS = 5_000;

function parseStored(text: string | null | undefined): Stored {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function clamp(info: HistorySettingInfo, v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : info.builtIn;
  return Math.min(info.max, Math.max(info.min, n));
}

/**
 * The settings without waiting: the last ones read (the built-in defaults
 * before any), refreshed in the background. For the one place that must
 * decide in the same tick (history/bulkDelete.ts); takeVersion still checks the switch.
 */
export function peekHistorySettings(): HistorySettingsState {
  if (!cache || Date.now() - cache.at >= CACHE_MS) void historySettings().catch(() => undefined);
  return (
    cache?.value ?? {
      enabled: env.versionHistoryEnabledForced ?? true,
      enabledSetting: true,
      enabledForcedBy: env.versionHistoryEnabledForced === null ? null : 'VERSION_HISTORY_ENABLED',
      limits: DEFAULT_HISTORY_LIMITS,
    }
  );
}

export async function historySettings(): Promise<HistorySettingsState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const stored = parseStored((await getPlatformSettings()).history);
  const limits = {} as HistoryLimits;
  for (const info of HISTORY_SETTINGS) limits[info.key] = clamp(info, stored.limits?.[info.key]);
  const enabledSetting = typeof stored.enabled === 'boolean' ? stored.enabled : true;
  const value: HistorySettingsState = {
    enabled: env.versionHistoryEnabledForced ?? enabledSetting,
    enabledSetting,
    enabledForcedBy: env.versionHistoryEnabledForced === null ? null : 'VERSION_HISTORY_ENABLED',
    limits,
  };
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateHistorySettings(): void {
  cache = null;
}

/** Save an admin's change: `enabled` and any limits given (null puts one back to its default). Returns the error for a bad value. */
export async function saveHistorySettings(patch: { enabled?: unknown; limits?: unknown }, by: string): Promise<string | null> {
  const stored = parseStored((await getPlatformSettings()).history);
  const next: { enabled?: boolean; limits: Record<string, number> } = {
    ...(typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : {}),
    limits: {},
  };
  for (const info of HISTORY_SETTINGS) {
    const v = stored.limits?.[info.key];
    if (typeof v === 'number') next.limits[info.key] = clamp(info, v);
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return 'enabled must be true or false';
    next.enabled = patch.enabled;
  }
  if (patch.limits !== undefined) {
    if (!patch.limits || typeof patch.limits !== 'object' || Array.isArray(patch.limits)) return 'limits must be an object';
    for (const [k, v] of Object.entries(patch.limits as Record<string, unknown>)) {
      const info = HISTORY_SETTINGS.find((s) => s.key === k);
      if (!info) return `unknown limit ${k}`;
      if (v === null) {
        delete next.limits[k];
        continue;
      }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < info.min || v > info.max) return `${k} must be a whole number from ${info.min} to ${info.max}`;
      next.limits[k] = v;
    }
  }
  await getPlatformSettings();
  await db
    .update(schema.platformSettings)
    .set({ history: JSON.stringify(next), updatedAt: new Date(), updatedBy: by })
    .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
  invalidateHistorySettings();
  return null;
}

/** How many hand-made, before-restore and uploaded database backups to keep (ops/dbBackups.ts). */
export async function backupKeeps(): Promise<{ manual: number; 'before-restore': number; upload: number }> {
  const { limits } = await historySettings();
  return { manual: limits.backupManualKeep, 'before-restore': limits.backupBeforeRestoreKeep, upload: limits.backupUploadKeep };
}
