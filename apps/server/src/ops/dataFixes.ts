// One-time data fixes, run at server start only when an operator asks for
// one: CBLD_DATA_FIX=<fix name> (several: comma separated) for one restart.
// Each fix that ran is recorded in data_fixes and never runs again, even
// with the variable still set. Without the variable, a fix that hasn't run
// is looked at (a dry run): with nothing to fix it's recorded as done and
// says nothing; otherwise one log line notes it and nothing else happens.
// Before a fix writes, the database as it was is copied to the backups
// folder (workers/backup.ts backupBeforeFix); with no copy, the fix waits.
//
// The fixes:
//   clamp-drawing-values   drawing settings saved out of range before the
//                          live route checked them (ops/clampDrawingValues.ts).
//                          Dry run: pnpm --filter @cld/server data-fix:clamp-drawing-values --db <file>,
//                          or in the Docker image (/app/apps/server): node dist/ops/clampDrawingValuesCli.js --db <file>
//   strip-catalog-budgets  the budget stored in published layout copies of
//                          the catalog from before it was left out
//                          (ops/stripCatalogBudgets.ts). Dry run: every
//                          start without the variable (the log line says
//                          how many copies hold one).

import type Database from 'better-sqlite3';
import type * as Y from 'yjs';
import { CLAMP_FIX_ID, clampDrawingValues, summaryLines, type FixSummary } from './clampDrawingValues.js';
import { STRIP_BUDGETS_FIX_ID, stripCatalogBudgets, stripSummaryLines, writeFixAudit, type StripSummary } from './stripCatalogBudgets.js';

export const DATA_FIX_ENV = 'CBLD_DATA_FIX';

/** The fixes this server knows, by name. */
export const DATA_FIXES = [CLAMP_FIX_ID, STRIP_BUDGETS_FIX_ID] as const;

type LiveDoc = (layoutId: string) => Y.Doc | undefined;
type Summary = FixSummary | StripSummary;

interface DataFix {
  /** A dry run: what it would change, and whether that is anything. */
  look(sqlite: Database.Database, liveDoc: LiveDoc | undefined): { summary: Summary; needed: boolean; waiting?: string };
  /** Run it and record it (`record` is recordFix for this fix). */
  run(sqlite: Database.Database, liveDoc: LiveDoc | undefined, record: (summary: Summary) => void): { summary: Summary; lines: string[] };
}

const FIXES: Record<(typeof DATA_FIXES)[number], DataFix> = {
  [CLAMP_FIX_ID]: {
    look(sqlite, liveDoc) {
      const summary = clampDrawingValues(sqlite, { apply: false, liveDoc });
      return { summary, needed: fixNeeded(summary) };
    },
    run(sqlite, liveDoc, record) {
      const summary = clampDrawingValues(sqlite, { apply: true, liveDoc });
      record(summary);
      return { summary, lines: summaryLines(summary) };
    },
  },
  [STRIP_BUDGETS_FIX_ID]: {
    look(sqlite) {
      const summary = stripCatalogBudgets(sqlite, { apply: false });
      return { summary, needed: summary.changed > 0, waiting: `${summary.changed} published layout ${summary.changed === 1 ? 'copy holds' : 'copies hold'} a budget` };
    },
    run(sqlite, _liveDoc, record) {
      // The copies, the audit event and the data_fixes row: one transaction.
      const summary = stripCatalogBudgets(sqlite, {
        apply: true,
        inTransaction: (s) => {
          writeFixAudit(sqlite, s);
          record(s);
        },
      });
      return { summary, lines: stripSummaryLines(summary) };
    },
  },
};

/** The names asked for in CBLD_DATA_FIX. */
export function askedFixes(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export interface DataFixRun {
  /** The fixes run now, with what they changed. */
  ran: { id: string; summary: Summary }[];
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
export function recordFix(sqlite: Database.Database, id: string, summary: Summary, at = Date.now()): void {
  sqlite.prepare('insert or ignore into data_fixes (id, applied_at, summary) values (?, ?, ?)').run(id, at, JSON.stringify(summary));
}

/**
 * At server start, after the migrations and before it takes connections:
 * run each fix CBLD_DATA_FIX asks for that hasn't run, and record it. One
 * log line for fixes that wait; nothing at all once every fix has run.
 * `backup` copies the database before a fix writes: when it throws, that
 * fix doesn't run (it waits for the next start).
 */
export function runDataFixes(
  sqlite: Database.Database,
  asked: Set<string>,
  log: (line: string) => void,
  liveDoc?: LiveDoc,
  backup?: (fixId: string) => void,
): DataFixRun {
  const out: DataFixRun = { ran: [], pending: [] };
  /** What a waiting fix found, for the log line. */
  const waiting = new Map<string, string>();
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
      const look = FIXES[id].look(sqlite, liveDoc);
      if (look.needed) {
        out.pending.push(id);
        if (look.waiting) waiting.set(id, look.waiting);
      } else recordFix(sqlite, id, look.summary);
      continue;
    }
    if (done) {
      log(`[dataFix] ${id} already ran on ${done.toISOString()}; nothing to do (unset ${DATA_FIX_ENV})`);
      continue;
    }
    if (backup) {
      try {
        backup(id);
      } catch (err) {
        log(`[dataFix] ${id}: not run, the database couldn't be copied first (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
    }
    log(`[dataFix] ${id}: running`);
    const { summary, lines } = FIXES[id].run(sqlite, liveDoc, (s) => recordFix(sqlite, id, s));
    for (const line of lines) log(`[dataFix] ${line}`);
    out.ran.push({ id, summary });
  }
  if (out.pending.length > 0) {
    const names = out.pending.map((id) => (waiting.has(id) ? `${id} (${waiting.get(id)})` : id)).join(', ');
    const clampDryRun = out.pending.includes(CLAMP_FIX_ID)
      ? ` Dry run of ${CLAMP_FIX_ID} on a copy of the database: node dist/ops/clampDrawingValuesCli.js --db <file> (in the Docker image), or pnpm --filter @cld/server data-fix:${CLAMP_FIX_ID} --db <file>.`
      : '';
    log(`[dataFix] not run yet: ${names}.${clampDryRun} Run one with ${DATA_FIX_ENV}=<name> for one restart; the database is copied to the backups folder first.`);
  }
  return out;
}
