// The start-up lines (data fixes, the copy before migrating) reach the
// server's logger at info level (startLog.ts, dataFixes.ts).

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { askedFixes, DATA_FIXES, recordFix, runDataFixes } from './dataFixes.js';
import { startLog } from './startLog.js';

/** A database with only the table that says which fixes ran. */
function emptyDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec('create table data_fixes (id text primary key not null, applied_at integer not null, summary text not null)');
  return sqlite;
}

describe('startLog', () => {
  it('keeps lines until the logger is there, then logs them in order, and later ones at once', () => {
    const log = startLog();
    log.line('one');
    log.line('two');
    const info = vi.fn();
    log.attach(info);
    expect(info.mock.calls).toEqual([['one'], ['two']]);
    log.line('three');
    expect(info.mock.calls).toEqual([['one'], ['two'], ['three']]);
    // Nothing is left for a failed start to write.
    const write = vi.fn();
    log.flushTo(write);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes what it kept somewhere else when the server never got a logger', () => {
    const log = startLog();
    log.line('copied the database');
    const write = vi.fn();
    log.flushTo(write);
    expect(write.mock.calls).toEqual([['copied the database']]);
  });

  it('hands the lines to a real server logger at info level', async () => {
    const lines: { level: number; msg: string }[] = [];
    const app = Fastify({ logger: { level: 'info', stream: { write: (s: string) => lines.push(JSON.parse(s) as { level: number; msg: string }) } } });
    const log = startLog();
    log.line('[dataFix] strip-catalog-budgets: already ran on 2026-11-10T00:00:00.000Z; nothing to do');
    log.attach((text) => app.log.info(text));
    await app.close();
    // (pino: 30 is info.)
    expect(lines).toContainEqual(expect.objectContaining({ level: 30, msg: '[dataFix] strip-catalog-budgets: already ran on 2026-11-10T00:00:00.000Z; nothing to do' }));
  });
});

describe('each data fix says where it stands at every start', () => {
  it('a fix that already ran says so, with the date, through the logger', () => {
    const sqlite = emptyDb();
    for (const id of DATA_FIXES) recordFix(sqlite, id, { apply: false } as never, Date.UTC(2026, 10, 10));
    const info = vi.fn();
    const log = startLog();
    runDataFixes(sqlite, askedFixes(undefined), log.line);
    log.attach(info);
    expect(info).toHaveBeenCalledTimes(DATA_FIXES.length);
    for (const id of DATA_FIXES) expect(info).toHaveBeenCalledWith(`[dataFix] ${id}: already ran on 2026-11-10T00:00:00.000Z; nothing to do`);
  });
});
