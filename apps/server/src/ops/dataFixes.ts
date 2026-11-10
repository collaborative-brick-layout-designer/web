// One-time data fixes, run at server start only when an operator asks for
// one: CBLD_DATA_FIX=<fix name> (several: comma separated) for one restart.
// Each fix that ran is recorded in data_fixes and never runs again, even
// with the variable still set. Without the variable, a fix that hasn't run
// is looked at (a dry run): with nothing to fix it's recorded as done and
// says nothing; otherwise one log line notes it and nothing else happens.
//
// The fixes (one so far):
//   clamp-drawing-values  drawing settings saved out of range before the
//                         live route checked them (ops/clampDrawingValues.ts).
//                         Dry run: pnpm --filter @cld/server data-fix:clamp-drawing-values --db <file>,
//                         or in the Docker image (/app/apps/server): node dist/ops/clampDrawingValuesCli.js --db <file>

import type Database from 'better-sqlite3';
import type * as Y from 'yjs';
import { CLAMP_FIX_ID, clampDrawingValues, summaryLines, type FixSummary } from './clampDrawingValues.js';

export const DATA_FIX_ENV = 'CBLD_DATA_FIX';

/** The fixes this server knows, by name. */
export const DATA_FIXES = [CLAMP_FIX_ID] as const;

/** The names asked for in CBLD_DATA_FIX. */
export function askedFixes(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export interface DataFixRun {
  /** The fixes run now, with what they changed. */
  ran: { id: string; summary: FixSummary }[];
  /** Fixes not run yet and not asked for. */
  pending: string[];
}

/** When a fix ran, or null. */
export function fixRecorded(sqlite: Database.Database, id: string): Date | null {
  const row = sqlite.prepare('select applied_at from data_fixes where id = ?').get(id) as { applied_at: number } | undefined;
  return row ? new Date(row.applied_at) : null;
}

/** Whether a dry run found anything to change. */
export function fixNeeded(s: FixSummary): boolean {
  return s.layouts.changed + s.modules.changed + s.moduleVersions.changed + s.catalogVersions.changed > 0;
}

/** Record that a fix ran (kept as it is when it already was). */
export function recordFix(sqlite: Database.Database, id: string, summary: FixSummary, at = Date.now()): void {
  sqlite.prepare('insert or ignore into data_fixes (id, applied_at, summary) values (?, ?, ?)').run(id, at, JSON.stringify(summary));
}

/**
 * At server start, after the migrations and before it takes connections:
 * run each fix CBLD_DATA_FIX asks for that hasn't run, and record it. One
 * log line for fixes that wait; nothing at all once every fix has run.
 */
export function runDataFixes(
  sqlite: Database.Database,
  asked: Set<string>,
  log: (line: string) => void,
  liveDoc?: (layoutId: string) => Y.Doc | undefined,
): DataFixRun {
  const out: DataFixRun = { ran: [], pending: [] };
  for (const name of asked) {
    if (!(DATA_FIXES as readonly string[]).includes(name)) log(`[dataFix] ${DATA_FIX_ENV} names "${name}", which isn't a fix this server has (${DATA_FIXES.join(', ')})`);
  }
  for (const id of DATA_FIXES) {
    const done = fixRecorded(sqlite, id);
    if (!asked.has(id)) {
      if (done) continue;
      // Not asked for: a look (nothing written). With nothing to fix (a new
      // server, or one whose data never needed it) it's recorded as done, so
      // the start log stays quiet; otherwise it waits for the operator.
      const look = clampDrawingValues(sqlite, { apply: false, liveDoc });
      if (fixNeeded(look)) out.pending.push(id);
      else recordFix(sqlite, id, look);
      continue;
    }
    if (done) {
      log(`[dataFix] ${id} already ran on ${done.toISOString()}; nothing to do (unset ${DATA_FIX_ENV})`);
      continue;
    }
    log(`[dataFix] ${id}: running`);
    const summary = clampDrawingValues(sqlite, { apply: true, liveDoc });
    recordFix(sqlite, id, summary);
    for (const line of summaryLines(summary)) log(`[dataFix] ${line}`);
    out.ran.push({ id, summary });
  }
  if (out.pending.length > 0) {
    log(
      `[dataFix] not run yet: ${out.pending.join(', ')}. Dry run on a copy of the database: node dist/ops/clampDrawingValuesCli.js --db <file> (in the Docker image), or pnpm --filter @cld/server data-fix:<name> --db <file>; run it with ${DATA_FIX_ENV}=<name> for one restart.`,
    );
  }
  return out;
}
