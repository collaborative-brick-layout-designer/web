// Admin › Model import: the switch and the limits for importing LDraw,
// Studio and LDD files (docs/model-import.md). Stored as one JSON object in
// platform_settings.imports; each value, first match wins:
//   1. its env var (IMPORTS_ENABLED forces the switch): the page says
//      "Forced by …"
//   2. what an admin saved
//   3. the built-in default below
// Read live with a short cache, cleared on save.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import { env } from '../env.js';

export type ImportSettingKey = 'maxUploadMb' | 'perHour' | 'perUserAtOnce' | 'atOnce' | 'timeoutSeconds' | 'memoryMb';

export interface ImportSettingInfo {
  key: ImportSettingKey;
  label: string;
  help: string;
  builtIn: number;
  min: number;
  max: number;
  unit: string;
}

export const IMPORT_SETTINGS: readonly ImportSettingInfo[] = [
  { key: 'maxUploadMb', label: 'Biggest file', help: 'The largest model file someone can upload to import, in megabytes.', builtIn: 64, min: 1, max: 256, unit: 'MB' },
  { key: 'perHour', label: 'Imports per person per hour', help: 'How many files one person can bring in within an hour. Each preview and each import counts.', builtIn: 30, min: 1, max: 600, unit: 'per hour' },
  { key: 'perUserAtOnce', label: 'At once per person', help: 'How many of one person’s files are worked on at the same time. More wait their turn.', builtIn: 1, min: 1, max: 4, unit: 'at once' },
  { key: 'atOnce', label: 'At once on this server', help: 'How many files the whole server works on at the same time. Each one can use a CPU core and up to the memory below.', builtIn: 2, min: 1, max: 16, unit: 'at once' },
  { key: 'timeoutSeconds', label: 'Longest an import may take', help: 'An import still running after this many seconds is stopped, and the person is told.', builtIn: 180, min: 10, max: 1800, unit: 'seconds' },
  { key: 'memoryMb', label: 'Memory per import', help: 'The most memory one import may use. LDD’s brick database alone needs about 600 MB.', builtIn: 4096, min: 1024, max: 16384, unit: 'MB' },
];

export interface ImportSettingsValue {
  enabled: boolean;
  limits: Record<ImportSettingKey, number>;
}

export interface ImportSettingsState extends ImportSettingsValue {
  /** The switch as saved, and the env var that forces it, if any. */
  enabledSetting: boolean;
  enabledForcedBy: string | null;
}

interface Stored {
  enabled?: unknown;
  limits?: Record<string, unknown>;
}

let cache: { at: number; value: ImportSettingsState } | null = null;
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

function clamp(info: ImportSettingInfo, v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : info.builtIn;
  return Math.min(info.max, Math.max(info.min, n));
}

export async function importSettings(): Promise<ImportSettingsState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const stored = parseStored((await getPlatformSettings()).imports);
  const limits = {} as Record<ImportSettingKey, number>;
  for (const info of IMPORT_SETTINGS) limits[info.key] = clamp(info, stored.limits?.[info.key]);
  const enabledSetting = typeof stored.enabled === 'boolean' ? stored.enabled : true;
  const value: ImportSettingsState = {
    enabled: env.importsEnabledForced ?? enabledSetting,
    enabledSetting,
    enabledForcedBy: env.importsEnabledForced === null ? null : 'IMPORTS_ENABLED',
    limits,
  };
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateImportSettings(): void {
  cache = null;
}

/** Save an admin's change: `enabled` and any limits given (clamped). Returns the error for a bad value. */
export async function saveImportSettings(patch: { enabled?: unknown; limits?: unknown }, by: string): Promise<string | null> {
  const stored = parseStored((await getPlatformSettings()).imports);
  const next: { enabled?: boolean; limits: Record<string, number> } = {
    ...(typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : {}),
    limits: {},
  };
  for (const info of IMPORT_SETTINGS) {
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
      const info = IMPORT_SETTINGS.find((s) => s.key === k);
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
    .set({ imports: JSON.stringify(next), updatedAt: new Date(), updatedBy: by })
    .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
  invalidateImportSettings();
  return null;
}
