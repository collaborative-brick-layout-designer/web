// How much the repair of shared modules' extra copies would change in a
// COPY of the server's database (ops/sharedRepairDryRun.ts):
//
//   node dist/ops/sharedRepairDryRunCli.js --db /abs/path/to/copy.sqlite   (the Docker image, in /app/apps/server)
//   pnpm --filter @cld/server shared-repair:dry-run --db /abs/path/to/copy.sqlite
//
// It reads the copy into memory (so SQLite makes no file beside it either),
// writes nothing, and prints numbers only. The parts' geometry comes from
// PARTS_DIR, as the server's does.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { env } from '../env.js';

const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** The copy, read into memory, where nothing can be written. */
function readCopy(file: string): Database.Database {
  const bytes = readFileSync(file);
  // In WAL mode (bytes 18 and 19 of its header are 2), SQLite would want its
  // -wal file: there is none to read (checked), so it reads the same without.
  if (bytes[18] === 2) bytes[18] = 1;
  if (bytes[19] === 2) bytes[19] = 1;
  const db = new Database(bytes);
  db.pragma('query_only = ON');
  return db;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { db: { type: 'string' } } });
  const file = values.db;
  if (!file || !isAbsolute(file) || !existsSync(file)) {
    say('Give the absolute path of a copy of the database: --db /abs/path/to/copy.sqlite');
    return 2;
  }
  if (existsSync(env.dbPath) && realpathSync(env.dbPath) === realpathSync(file)) {
    say("That is the server's own database. Copy it (Admin, Backups) and give the copy.");
    return 2;
  }
  if (existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0) {
    say(`${file}-wal holds changes this would miss. Make the copy with a backup (Admin, Backups), which has them in.`);
    return 2;
  }
  const copy = readCopy(file);
  (globalThis as { cldSqlite?: unknown }).cldSqlite = copy;
  // What the code says about single files or layouts isn't for this report.
  console.log = console.warn = console.error = () => {};
  // (Read only now: they work on the database given above.)
  const { sharedRepairDryRun, dryRunLines } = await import('./sharedRepairDryRun.js');
  for (const line of dryRunLines(await sharedRepairDryRun())) say(line);
  copy.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    say(`The dry run stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
