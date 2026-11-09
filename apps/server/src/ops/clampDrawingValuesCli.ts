// What the one-time fix clamp-drawing-values (clampDrawingValues.ts) would
// change in a database, without writing to it:
//
//   pnpm --filter @cld/server data-fix:clamp-drawing-values --db /abs/path/to/copy.sqlite [--quiet]
//   node dist/ops/clampDrawingValuesCli.js --db /abs/path/to/copy.sqlite   (the Docker image, in /app/apps/server)
//
// It opens the database read-only and prints each document it would change
// (which values, from what to what), then the summary the server logs when
// it runs the fix. --quiet prints the summary only.
//
// A database in WAL mode in a folder it can't write to (a mounted backup)
// can't be opened read-only the usual way: SQLite would make its -shm file
// there. Then it is opened immutable (SQLite reads the file and nothing
// else, and writes nothing anywhere), which is exact when no -wal file
// holds changes; when one does, it says so and stops rather than report
// from a database missing those changes.
//
// The fix itself runs at server start with CBLD_DATA_FIX=clamp-drawing-values
// (ops/dataFixes.ts). --apply runs it here instead, on a database no server
// has open (tests, a copy), and records it like the server does.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { refuseWhileRunning } from './serverLock.js';
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

const USAGE = `usage (in the Docker image, from /app/apps/server):
  node dist/ops/clampDrawingValuesCli.js --db <database file> [--quiet]
from a checkout (packages built):
  pnpm --filter @cld/server data-fix:clamp-drawing-values --db <absolute path> [--quiet]
--quiet   the summary only
--apply   write the fix, only on a database no server has open (the server runs it with CBLD_DATA_FIX=clamp-drawing-values)
--server-running  with --apply: write although a server has it open (only when none of the layouts it changes is open there)
`;

class CantOpen extends Error {}

/**
 * The database, read-only. A WAL database in a folder that can't be
 * written to is opened immutable instead (see the top of the file).
 * SQLITE_USE_URI must have been set before the first open in the process.
 */
export function openReadOnly(file: string): Database.Database {
  if (!existsSync(file)) throw new CantOpen(`no database at ${file}`);
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    // A WAL database opens its -shm file on the first read.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  } catch (err) {
    db?.close();
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^SQLITE_(CANTOPEN|READONLY)/.test(code)) throw err;
  }
  const wal = `${file}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new CantOpen(
      `${file} can't be opened read-only here (its folder can't be written to), and ${wal} holds changes an immutable open would miss. Copy the database and its -wal file to a folder you can write to and run this there.`,
    );
  }
  const immutable = new Database(`${pathToFileURL(resolve(file)).href}?immutable=1`, { readonly: true, fileMustExist: true });
  immutable.prepare('SELECT count(*) FROM sqlite_master').get();
  return immutable;
}

export function main(argv = process.argv.slice(2)): number {
  // File URIs (the immutable open): better-sqlite3 reads this when it loads,
  // at the first database of the process. (Not a server setting.)
  process.env['SQLITE_USE_URI'] ??= '1';
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      // Write even though a server holds the database: only when no layout it changes is open there.
      'server-running': { type: 'boolean', default: false },
    },
  });
  if (!values.db) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.apply) {
    const running = values['server-running'] ? null : refuseWhileRunning(values.db);
    if (running) {
      process.stderr.write(running);
      return 4;
    }
  }
  let sqlite: Database.Database;
  try {
    sqlite = values.apply ? new Database(values.db, { fileMustExist: true }) : openReadOnly(values.db);
  } catch (err) {
    if (!(err instanceof CantOpen)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
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
