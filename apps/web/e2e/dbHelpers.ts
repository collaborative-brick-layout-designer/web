// Direct SQLite access for e2e tests that need server-side state the
// browser can't reach — currently just the email-verification token,
// which in real use only ever reaches the user via an email Playwright
// can't receive. Opens the same DB_PATH the running server was started
// with (see playwright.config.ts's header comment for the expected env).
//
// Mostly read-only. The exceptions: a verification link's token is set
// to a known value (the server keeps only its hash), and tests that
// simulate token expiry UPDATE a row's expires_at directly — there's no
// API surface for that and it's the standard way to test expiry without
// sleeping the test for real.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { test, type TestInfo } from '@playwright/test';
import * as Y from 'yjs';

function dbPath(): string {
  const configured = process.env.DB_PATH;
  if (configured) return configured;
  // Matches apps/server/src/env.ts's own default, resolved relative to
  // apps/server (where the dev server process actually runs from).
  return resolve(import.meta.dirname, '../../server/data/cbld.sqlite');
}

/**
 * A working email-verification link token for a user, by email. The
 * server keeps only the token's sha256 (the raw token is only ever
 * emailed), so this gives the user's live verification row a fresh token
 * and returns it, the way the emailed link would carry it. The row stays
 * the same otherwise (still tied to the browser that signed up, if it
 * was). Polls briefly since the register request may return to the test
 * before the write is visible to a fresh connection in rare cases.
 */
export async function getVerificationToken(email: string): Promise<string> {
  const db = new Database(dbPath());
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = db
        .prepare(
          `SELECT ev.id AS id
           FROM email_verifications ev
           JOIN users u ON u.id = ev.user_id
           WHERE u.email = ?
           ORDER BY ev.created_at DESC
           LIMIT 1`,
        )
        .get(email) as { id: string } | undefined;
      if (row) {
        const token = randomBytes(24).toString('hex');
        db.prepare(`UPDATE email_verifications SET token = ? WHERE id = ?`).run(
          createHash('sha256').update(token).digest('hex'),
          row.id,
        );
        return token;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no verification token found for ${email} after polling`);
  } finally {
    db.close();
  }
}

/** Whether an account exists for `email`, and whether its email is confirmed. */
export function accountState(email: string): 'none' | 'unverified' | 'verified' {
  const db = new Database(dbPath(), { readonly: true });
  try {
    const row = db.prepare(`SELECT email_verified AS v FROM users WHERE email = ?`).get(email) as { v: number } | undefined;
    return !row ? 'none' : row.v ? 'verified' : 'unverified';
  } finally {
    db.close();
  }
}

/** Force a user's live verification token to already be expired, for testing the expired-link path. */
export async function expireVerificationToken(email: string): Promise<void> {
  const db = new Database(dbPath());
  try {
    db.prepare(
      `UPDATE email_verifications
       SET expires_at = ?
       WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
    ).run(Date.now() - 1000, email);
  } finally {
    db.close();
  }
}

/** Make `email` a platform admin (there is no API for the first admin; real servers use BOOTSTRAP_ADMIN_EMAIL). */
export function makeGlobalAdmin(email: string): void {
  const db = new Database(dbPath());
  try {
    db.prepare(`UPDATE users SET is_global_admin = 1 WHERE email = ?`).run(email);
  } finally {
    db.close();
  }
}

/**
 * Give a demo space a short time to live: its `demo_expires_at` and its
 * sign-in end `ms` from now (the way the clock would after the space's
 * lifetime, without waiting an hour).
 */
export function setDemoSpaceTimeLeft(userId: string, ms: number): void {
  const db = new Database(dbPath());
  try {
    const end = Date.now() + ms;
    db.prepare(`UPDATE users SET demo_expires_at = ? WHERE id = ?`).run(end, userId);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`).run(end, userId);
  } finally {
    db.close();
  }
}

/**
 * The site's catalog settings back at the defaults a fresh server starts
 * with (auth/platformSettings.ts): every catalog off, review by moderators,
 * anyone may browse. These are read from the database on every request, so
 * a direct write takes effect at once. Specs run one after another on one
 * server, and a spec that turned review off used to leave it off for the
 * next one (clubDeletion before modules, 2026-11-09).
 */
export function resetCatalogSettings(): void {
  const db = new Database(dbPath());
  try {
    db.prepare(
      `UPDATE platform_settings
       SET module_catalog_enabled = 0, parts_catalog_enabled = 0,
           layout_catalog_enabled = 0, venue_catalog_enabled = 0,
           catalog_review = 'moderators', catalog_anonymous_browse = 1`,
    ).run();
  } finally {
    db.close();
  }
}

/**
 * For a spec that changes site settings: start from the defaults and put
 * them back afterwards, whatever the spec did or however it ended. Call it
 * once at the top of the file. Only when one spec runs at a time
 * (--workers=1, as the journeys and the nightly run): with more workers
 * another file's spec could be mid-way through on the same server.
 */
export function siteSettingsAtDefaults(): void {
  // Playwright reads the fixtures a hook asks for from its first argument.
  // eslint-disable-next-line no-empty-pattern
  const reset = ({}, testInfo: TestInfo) => {
    if (testInfo.config.workers === 1) resetCatalogSettings();
  };
  test.beforeAll(reset);
  test.afterAll(reset);
}

/** Give an account a stored name directly, as older accounts got their email as their name. */
export function setStoredName(email: string, name: string): void {
  const db = new Database(dbPath());
  try {
    db.prepare(`UPDATE users SET display_name = ? WHERE email = ?`).run(name, email);
  } finally {
    db.close();
  }
}

/** Drop a module's picture, as if it was saved before modules had pictures. */
/** Give a module an old-style picture (a 256 px PNG), as made before pictures were 1024 px. */
export function setOldModuleThumbnail(moduleId: string, png: Buffer): void {
  const db = new Database(dbPath());
  try {
    db.prepare(`UPDATE modules SET thumbnail = ?, thumbnail_mime = 'image/png', thumbnail_at = ? WHERE id = ?`).run(png, Date.now(), moduleId);
  } finally {
    db.close();
  }
}

export function clearModuleThumbnail(moduleId: string): void {
  const db = new Database(dbPath());
  try {
    db.prepare(`UPDATE modules SET thumbnail = NULL, thumbnail_mime = NULL, thumbnail_at = NULL WHERE id = ?`).run(moduleId);
  } finally {
    db.close();
  }
}

type SmtpRow = { smtp_host: string | null; smtp_port: number | null; smtp_user: string | null; smtp_pass: string | null; smtp_from: string | null };

/**
 * Point the site's email at `to` (a local mail sink, e2e/mailSink.ts),
 * as Admin › Settings › Email would, and return a function that puts the
 * previous setting back. The server reads this row on every send.
 */
export function useSmtp(to: { host: string; port: number; from: string }): () => void {
  const db = new Database(dbPath());
  try {
    db.prepare(`INSERT OR IGNORE INTO platform_settings (id, require_email_verification) VALUES ('singleton', 1)`).run();
    const before = db.prepare(`SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from FROM platform_settings WHERE id = 'singleton'`).get() as SmtpRow;
    db.prepare(`UPDATE platform_settings SET smtp_host = ?, smtp_port = ?, smtp_user = NULL, smtp_pass = NULL, smtp_from = ? WHERE id = 'singleton'`).run(to.host, to.port, to.from);
    return () => {
      const again = new Database(dbPath());
      try {
        again
          .prepare(`UPDATE platform_settings SET smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ?, smtp_from = ? WHERE id = 'singleton'`)
          .run(before.smtp_host, before.smtp_port, before.smtp_user, before.smtp_pass, before.smtp_from);
      } finally {
        again.close();
      }
    };
  } finally {
    db.close();
  }
}

/**
 * Give a layout's sheet of `type` drawing settings out of range, the way a
 * layout saved before the server checked them holds them: one more stored
 * update, as an older app's edit would be. The layout mustn't be open.
 */
export function spoilSheetSettings(layoutId: string, type: string, values: Record<string, unknown>): void {
  const db = new Database(dbPath());
  try {
    const doc = new Y.Doc();
    const row = db.prepare('SELECT doc_snapshot FROM layouts WHERE id = ?').get(layoutId) as { doc_snapshot: Buffer };
    Y.applyUpdate(doc, row.doc_snapshot);
    for (const u of db.prepare("SELECT update_bytes FROM layout_updates WHERE layout_id = ? AND doc = 'main' ORDER BY id").all(layoutId) as { update_bytes: Buffer }[]) {
      Y.applyUpdate(doc, u.update_bytes);
    }
    const sheet = [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l.get('type') === type);
    if (!sheet) throw new Error(`layout ${layoutId} has no ${type} sheet`);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      for (const [k, v] of Object.entries(values)) sheet.set(k, v);
    });
    db.prepare("INSERT INTO layout_updates (layout_id, doc, update_bytes, created_at) VALUES (?, 'main', ?, ?)").run(
      layoutId,
      Buffer.from(Y.encodeStateAsUpdate(doc, before)),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

/**
 * The one-time fix clamp-drawing-values on the test database, through its
 * command (apps/server src/ops/clampDrawingValuesCli.ts): a dry run, or
 * with `apply` the fix the server runs at a start with CBLD_DATA_FIX.
 * Returns what it printed.
 */
export function clampDrawingValuesFix(apply: boolean): string {
  const args = ['--filter', '@cld/server', 'data-fix:clamp-drawing-values', '--db', dbPath(), ...(apply ? ['--apply', '--server-running'] : [])];
  return execFileSync('pnpm', args, { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 120_000 });
}
