import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

// Each test run gets its own SQLite file in a temp dir so parallel CI jobs
// can't tread on each other and assertions start from a clean schema.
const dir = mkdtempSync(join(tmpdir(), 'cld-test-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';
process.env.PUBLIC_URL = 'http://localhost:3000';
process.env.ENABLE_PASSWORD_AUTH = 'true';
// Test accounts are always minutes old; without this, the "one club in
// an account's first week" rule would stop every suite that makes two
// clubs. limits.test.ts turns it back on where it tests that rule.
process.env.LIMIT_NEW_ACCOUNT_CLUBS = '1000';
process.env.LIMIT_CLUBS_PER_USER = '1000';

beforeAll(async () => {
  // Apply migrations once for the suite. Server module reads env.DB_PATH on
  // first import, so we import the migrator AFTER setting the env above.
  const { db } = await import('../db/index.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: 'migrations' });
  // No test starts a real download (the LDraw library, the LDD mapping): a route fuzz that
  // reaches "download" would wait on the network, and a slow one stalls the whole suite.
  // A test of the download itself sets its own fetcher.
  const { setLibraryFetcher } = await import('../imports/libraries.js');
  setLibraryFetcher(async (url) => {
    throw new Error(`a test tried a real download of ${url}; set a fetcher with setLibraryFetcher`);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
