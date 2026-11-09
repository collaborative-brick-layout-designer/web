// Background workers (Phase 7).
//
// Two daily jobs share a single `setInterval` driver:
//
//   1. dailyCompaction — full Yjs snapshot rewrite per active doc.
//                       Runs daily; complements the per-active-doc
//                       30s snapshot worker in docHub.ts (which only
//                       runs while clients are connected).
//   2. backupWorker    — `VACUUM INTO` snapshot of the SQLite file
//                       to /backups, gzipped, with retention buckets:
//                       last 7 days + 1/week × 3 weeks + 1/month × 12
//                       months. Runs daily.
//
// Operators can disable either one via env vars (BACKUPS_ENABLED,
// DAILY_COMPACTION_ENABLED).
//
// The demo account (Admin › Settings › Demo account) has its own timer,
// checked every few minutes: it resets the account when a reset is due.
//
// Tests skip the whole worker stack (NODE_ENV=test).

import { eq, and } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, schema, sqlite } from '../db/index.js';
import { env } from '../env.js';
import { imagesDirFor, runBackup } from './backup.js';
import { setCompactionSkipped } from './compactionReport.js';
import { backgroundJobs } from './jobs.js';
import { docHub } from '../ws/docHub.js';
import { applyStoredUpdate } from '../ws/yjsWork.js';
import { sweepRollup } from '../metrics/rollup.js';
import { sweepUsage } from '../metrics/usage.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { demoResetDue } from '../demo/demoAccount.js';
import { runDemoReset } from '../demo/reset.js';
import { privacyTick, privacyTickSummary } from '../privacy/tick.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let demoTimer: ReturnType<typeof setInterval> | null = null;
let privacyTimer: ReturnType<typeof setInterval> | null = null;
/** How often the privacy clean-up runs (expired downloads, and the rest of privacy/tick.ts). */
const PRIVACY_CHECK_MS = 60 * 60 * 1000;
/** How often the demo timer looks whether a reset is due. */
const DEMO_CHECK_MS = 5 * 60 * 1000;

export function startWorkers(): void {
  if (env.nodeEnv === 'test') return;
  if (timer) return;
  demoTimer = setInterval(() => void safeRun('demoReset', async () => void (await demoTick())), DEMO_CHECK_MS);
  privacyTimer = setInterval(() => void safeRun('privacy', runPrivacyTick), PRIVACY_CHECK_MS);
  setTimeout(() => void safeRun('privacy', runPrivacyTick), 90_000);
  console.log('[privacy] clean-up scheduled hourly');
  // Run on first tick after 60s (so a server crash-restart loop doesn't
  // hammer the DB) and every 24h thereafter.
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), DAY_MS);
  }, 60_000);
}

export function stopWorkers(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  if (privacyTimer) {
    clearInterval(privacyTimer);
    privacyTimer = null;
  }
}

/** One privacy clean-up, with a log line when it removed anything (so the operator can see it runs). */
export async function runPrivacyTick(now = new Date()): Promise<void> {
  const line = privacyTickSummary(await privacyTick(now));
  if (line) console.log(line);
}

/** Reset the demo account when it's on and its reset is due. */
export async function demoTick(now = new Date()): Promise<boolean> {
  if (!demoResetDue(await getPlatformSettings(), now)) return false;
  await runDemoReset(now);
  return true;
}

async function tick(): Promise<void> {
  // Admin › Settings › Background jobs, read now so a change needs no restart.
  const jobs = await backgroundJobs();
  if (jobs.dailyCompaction.value) await safeRun('dailyCompaction', dailyCompaction);
  if (jobs.backups.value) await safeRun('backupWorker', backupWorker);
  // Admin dashboard rollup: keep ROLLUP_RETENTION_DAYS (about 13 months).
  await safeRun('rollupRetention', async () => {
    sweepRollup();
    sweepUsage();
  });
}

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Workers must never crash the process. Log and move on; the next
    // tick will retry.
    console.error(`[workers] ${name} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// 1. Daily compaction
// ---------------------------------------------------------------------------

export async function dailyCompaction(): Promise<void> {
  // For every layout that has unflushed updates in `layout_updates`,
  // materialise a fresh snapshot from snapshot+updates and truncate.
  // Same logic as docHub's flushSnapshot but doc-hub-independent (so
  // it works on layouts no one is currently editing).
  //
  // Only layouts that actually have pending updates are visited, and
  // each snapshot is loaded one at a time (this used to load every
  // layout's snapshot blob into memory at once). Layouts with a live
  // editor session are skipped: the session flushes itself, and
  // truncating the log underneath it could drop updates it persisted
  // after we read the log.
  const pending = await db
    .selectDistinct({ id: schema.layoutUpdates.layoutId })
    .from(schema.layoutUpdates)
    .where(eq(schema.layoutUpdates.doc, 'main'));
  let compacted = 0;
  const skipped: string[] = [];
  for (const { id } of pending) {
    if (docHub.has(id)) continue;
    // One layout that can't be read never stops the rest (each is tried on its own).
    try {
      if (await compactOne(id)) compacted += 1;
    } catch (err) {
      skipped.push(id);
      console.error(`[dailyCompaction] layout ${id} skipped: its saved copy can't be read`, err);
    }
  }
  setCompactionSkipped(skipped);
  if (compacted > 0) {
    console.log(`[dailyCompaction] compacted ${compacted} layouts`);
  }
}

async function compactOne(id: string): Promise<boolean> {
  {
    const layout = await db
      .select({ id: schema.layouts.id, snapshot: schema.layouts.docSnapshot })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, id))
      .get();
    if (!layout) return false;
    const updates = await db
      .select({ updateBytes: schema.layoutUpdates.updateBytes })
      .from(schema.layoutUpdates)
      .where(
        and(
          eq(schema.layoutUpdates.layoutId, layout.id),
          eq(schema.layoutUpdates.doc, 'main'),
        ),
      );
    if (updates.length === 0) return false;

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, layout.snapshot as Uint8Array);
    } catch (err) {
      doc.destroy();
      throw err;
    }
    // Corrupt or too costly to apply (ws/yjsWork.ts): skipped.
    for (const u of updates) applyStoredUpdate(doc, u.updateBytes as Uint8Array, `layout ${layout.id}`);
    const fresh = Y.encodeStateAsUpdate(doc);
    await db
      .update(schema.layouts)
      .set({ docSnapshot: Buffer.from(fresh), updatedAt: new Date() })
      .where(eq(schema.layouts.id, layout.id));
    await db
      .delete(schema.layoutUpdates)
      .where(
        and(
          eq(schema.layoutUpdates.layoutId, layout.id),
          eq(schema.layoutUpdates.doc, 'main'),
        ),
      );
    doc.destroy();
    return true;
  }
}

// ---------------------------------------------------------------------------
// 2. Backup worker
// ---------------------------------------------------------------------------

async function backupWorker(): Promise<void> {
  // workers/backup.ts: an online copy (the server keeps answering), written
  // whole or not at all, with the background pictures beside it.
  await runBackup({ dir: env.backupsDir, sqlite, imagesDir: imagesDirFor(env.dbPath), log: (l) => console.log(l) });
}


