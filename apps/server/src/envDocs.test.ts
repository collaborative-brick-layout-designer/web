// The README's configuration tables are the ones envDocs.ts makes, and
// list every environment variable the server reads.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_VARS, withEnvTables } from './envDocs.js';
import { LIMITS } from './limits/limits.js';
import { PRIVACY_SETTINGS } from './privacy/settings.js';
import { SIGN_IN_SETTINGS } from './auth/signInSettings.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));

/** The server's sources (not its tests, nor the fuzz harness, src/fuzz, whose FUZZ_* settings aren't the server's). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' || p === join(srcDir, 'fuzz') ? [] : sources(p);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('the README configuration tables', () => {
  it('are up to date (run pnpm --filter @cld/server docs:env)', () => {
    const readme = readFileSync(readmePath, 'utf8');
    expect(withEnvTables(readme)).toBe(readme);
  });

  it('list every environment variable the server reads', () => {
    const listed = new Set([...ENV_VARS.map((v) => v.name), ...LIMITS.map((l) => l.envVar), ...PRIVACY_SETTINGS.map((p) => p.envVar), ...SIGN_IN_SETTINGS.map((s) => s.envVar), 'PORT']);
    const read = new Set<string>();
    for (const file of sources(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!);
      for (const m of text.matchAll(/providerEnv\('([A-Z]+)'\)/g)) read.add(`${m[1]}_CLIENT_ID`).add(`${m[1]}_CLIENT_SECRET`);
    }
    expect(read.size).toBeGreaterThan(20);
    for (const name of read) expect(listed.has(name), name).toBe(true);
  });
});
