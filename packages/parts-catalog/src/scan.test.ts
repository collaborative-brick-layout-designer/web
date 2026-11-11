import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanCatalog } from './scan.js';

// These tests require the BlueBrickParts library on disk. In CI and local dev
// without the library downloaded the suite is skipped automatically.
const PARTS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../parts-library/parts',
);
const HAVE_PARTS = existsSync(PARTS_ROOT);
const maybeIt = HAVE_PARTS ? it : it.skip;

describe('scanCatalog (against vendored BlueBrickParts)', () => {
  maybeIt('finds a substantial number of leaf parts', async () => {
    const result = await scanCatalog(PARTS_ROOT);

    expect(result.catalog.size).toBeGreaterThan(500);
    // The library should contain TS_CURVE_R56.8 — used as the headline
    // example in the survey + parser test.
    expect(result.catalog.has('ts_curve_r56.8')).toBe(true);

    const curve = result.catalog.get('ts_curve_r56.8');
    expect(curve?.partNumber).toBe('TS_CURVE_R56');
    expect(curve?.colorCode).toBe('8');
    expect(curve?.connections).toHaveLength(2);
  });

  maybeIt('pairs XML files with their matching sprites', async () => {
    const { catalog } = await scanCatalog(PARTS_ROOT);
    const curve = catalog.get('ts_curve_r56.8');
    // The sibling .gif lives at parts/4DBrix/TS_CURVE_R56.8.gif.
    expect(curve?.spritePath).toMatch(/TS_CURVE_R56\.8\.gif$/);
  });

  maybeIt('emits a useful diagnostic instead of crashing on malformed XML', async () => {
    const result = await scanCatalog(PARTS_ROOT);
    // The vendored library may have some legitimately-broken files; we
    // never want a single bad file to abort the whole scan.
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

describe('scanCatalog: a library’s config/ folder', () => {
  it('is not read as parts, and a broken part is still named', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(resolve(tmpdir(), 'cbld-scan-'));
    try {
      mkdirSync(resolve(root, 'config'));
      writeFileSync(resolve(root, 'config', 'ConnectionTypeList.xml'), '<ConnectionTypeList><ConnectionType/></ConnectionTypeList>');
      mkdirSync(resolve(root, 'trains', 'config'), { recursive: true });
      writeFileSync(resolve(root, 'trains', 'config', 'ConnectionTypeList.xml'), '<ConnectionTypeList><ConnectionType/></ConnectionTypeList>');
      writeFileSync(resolve(root, 'trains', 'broken.8.xml'), '<not closed');
      const { errors } = await scanCatalog(root);
      expect(errors.map((e) => e.path)).not.toContain('config/ConnectionTypeList.xml');
      // Inside a library folder too (parts/Road/config), quietly: no error at all for it.
      expect(errors.map((e) => e.path.replace(/\\/g, '/')).filter((p) => p.includes('config'))).toEqual([]);
      expect(errors.map((e) => e.path.replace(/\\/g, '/'))).toContain('trains/broken.8.xml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
