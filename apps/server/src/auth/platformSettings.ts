// Admin-configurable platform settings — a singleton row, exposed via
// GET/PATCH /api/admin/settings (routes/admin.ts). Two concerns live
// here rather than being spread across callers:
//
//   1. Get-or-create the singleton row (never fails even before the
//      first admin visits the settings page).
//   2. Merge the DB row's SMTP fields with env.smtp, DB-wins-if-set —
//      so an operator's .env keeps working until an admin explicitly
//      overrides it from the UI, and the settings page can show which
//      source is actually active.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import type { PlatformSettings } from '../db/schema.js';

/** Fixed id — there is always exactly one row in platform_settings. */
export const PLATFORM_SETTINGS_ID = 'singleton';

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const existing = await db
    .select()
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID))
    .get();
  if (existing) return existing;

  // First read ever — create the row with defaults matching the
  // pre-existing (env-only) behaviour: verification required, no DB
  // SMTP override.
  const row: PlatformSettings = {
    id: PLATFORM_SETTINGS_ID,
    requireEmailVerification: true,
    smtpHost: null,
    smtpPort: null,
    smtpUser: null,
    smtpPass: null,
    smtpFrom: null,
    limits: null,
    minDesktopVersion: null,
    moduleCatalogEnabled: false,
    partsCatalogEnabled: false,
    layoutCatalogEnabled: false,
    venueCatalogEnabled: false,
    catalogReview: 'moderators',
    catalogAnonymousBrowse: true,
    limitsEnforced: true,
    backupsEnabled: true,
    dailyCompactionEnabled: true,
    demoTtlSweepEnabled: true,
    demoLayoutTtlDays: 30,
    demoEnabled: false,
    demoResetEvery: 'daily',
    demoLastResetAt: null,
    demoMaxSpaces: 100,
    collectionCoverMaxBytes: 5 * 1024 * 1024,
    privacy: null,
    privacyNotice: null,
    privacyContact: null,
    signIn: null,
    updatedAt: new Date(),
    updatedBy: null,
  };
  await db.insert(schema.platformSettings).values(row).onConflictDoNothing();
  // Re-read in case a concurrent request won the insert race — avoids
  // two callers each thinking they created the canonical row.
  return (
    (await db
      .select()
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID))
      .get()) ?? row
  );
}

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  from: string;
  /** Where this config came from — surfaced in the admin UI. */
  source: 'database' | 'env';
}

/**
 * Merge platform_settings' SMTP fields with env.smtp. smtpHost set in
 * the DB means "the DB config is authoritative" — every other DB field
 * (even if null) is used as-is rather than falling back field-by-field,
 * so an admin can't end up with a config that's part-env/part-DB by
 * accident (e.g. clearing smtpUser in the DB shouldn't resurrect an
 * env SMTP_USER meant for a different host).
 */
export function mergeSmtpConfig(settings: PlatformSettings): ResolvedSmtpConfig | null {
  if (settings.smtpHost) {
    return {
      host: settings.smtpHost,
      port: settings.smtpPort ?? 587,
      user: settings.smtpUser,
      pass: settings.smtpPass,
      from: settings.smtpFrom ?? settings.smtpUser ?? settings.smtpHost,
      source: 'database',
    };
  }
  if (env.smtp) return { ...env.smtp, source: 'env' };
  return null;
}
