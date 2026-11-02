// What the one-time fix clamp-drawing-values (clampDrawingValues.ts) would
// change in a database, without writing to it:
//
//   pnpm --filter @cld/server data-fix:clamp-drawing-values --db /abs/path/to/copy.sqlite [--quiet]
//   node apps/server/dist/ops/clampDrawingValuesCli.js --db /abs/path/to/copy.sqlite   (the Docker image)
//
// It opens the database read-only and prints each document it would change
// (which values, from what to what), then the summary the server logs when
// it runs the fix. --quiet prints the summary only.
//
// The fix itself runs at server start with CBLD_DATA_FIX=clamp-drawing-values
// (ops/dataFixes.ts). --apply runs it here instead, on a database no server
// has open (tests, a copy), and records it like the server does.

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { CLAMP_FIX_ID, clampDrawingValues, summaryLines, type FixedItem } from './clampDrawingValues.js';
import { fixRecorded, recordFix } from './dataFixes.js';

/** A value for the report: short, and NaN / Infinity / removed shown as such. */
function show(v: unknown): string {
  if (v === undefined) return '(removed)';
  if (typeof v === 'number') return String(v);
  let s: string;
  try {
    s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function printItem(item: FixedItem): void {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  out(`${item.target} ${item.id} "${item.label}": ${item.changes.length} values (update ${item.updateBytes} bytes)`);
  for (const c of item.changes) {
    const where = c.ruler ? `sheet ${c.sheet} ruler ${c.ruler}` : `sheet ${c.sheet}`;
    out(`    ${c.setting} (${where}): ${show(c.from)} -> ${show(c.to)}`);
  }
  if (item.left.length) out(`    STILL OUT OF RANGE: ${item.left.join(', ')}`);
}

export function main(argv = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.db) {
    process.stderr.write('usage: --db <database file> [--quiet] [--apply (only on a database no server has open)]\n');
    return 2;
  }
  const sqlite = new Database(values.db, { readonly: !values.apply, fileMustExist: true });
  try {
    const recorded = (() => {
      try {
        return fixRecorded(sqlite, CLAMP_FIX_ID);
      } catch {
        return null; // a database from before data_fixes (0039)
      }
    })();
    if (recorded) process.stdout.write(`note: ${CLAMP_FIX_ID} already ran on this database (${recorded.toISOString()})\n`);
    const summary = clampDrawingValues(sqlite, { apply: values.apply, onItem: values.quiet ? undefined : printItem });
    if (values.apply) recordFix(sqlite, CLAMP_FIX_ID, summary);
    for (const line of summaryLines(summary)) process.stdout.write(`${line}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
