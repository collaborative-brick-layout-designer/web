import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env } from '../env.js';
import * as schema from './schema.js';

/** A database a script opened (read-only: ops/sharedRepairDryRunCli.ts) and works on instead of the server's. */
const given = (globalThis as { cldSqlite?: Database.Database }).cldSqlite;

function openServerDb(): Database.Database {
  const dir = dirname(env.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const it = new Database(env.dbPath);
  it.pragma('journal_mode = WAL');
  it.pragma('foreign_keys = ON');
  it.pragma('synchronous = NORMAL');
  return it;
}

export const sqlite = given ?? openServerDb();

export const db = drizzle(sqlite, { schema });
export { schema };
