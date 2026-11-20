// A module's table and power (setup.ts), against the vectors both apps
// test (fixtures/contracts/module-setup.json; the desktop's
// tests/core/ModuleSetupTest.cpp reads the same file).
//
// BLD_WRITE_CONTRACTS=1 writes the vectors' answers again from this code.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { outletsOf, parseStoredSetup, setupOf, setupSummary, validSetup, withLibrarySetup, withPower, withTable } from './setup.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts/module-setup.json');

interface Vectors {
  read: { module: Record<string, unknown>; setup: unknown }[];
  valid: { setup: unknown; valid: boolean }[];
  summary: { modules: Record<string, unknown>[]; expect: unknown }[];
}

const vectors = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors;

describe('module setup contract (fixtures/contracts/module-setup.json)', () => {
  if (process.env.BLD_WRITE_CONTRACTS === '1') {
    it('writes the answers', () => {
      for (const r of vectors.read) r.setup = setupOf(r.module);
      for (const v of vectors.valid) v.valid = validSetup(v.setup);
      for (const s of vectors.summary) s.expect = setupSummary(s.modules);
      writeFileSync(FILE, `${JSON.stringify(vectors, null, 2)}\n`);
    });
    return;
  }
  it.each(vectors.read.map((r, i) => [i, r] as const))('reads module %i', (_i, r) => {
    expect(setupOf(r.module)).toEqual(r.setup);
  });
  it.each(vectors.valid.map((v, i) => [i, v] as const))('checks setup %i', (_i, v) => {
    expect(validSetup(v.setup)).toBe(v.valid);
  });
  it.each(vectors.summary.map((s, i) => [i, s] as const))('sums layout %i', (_i, s) => {
    expect(setupSummary(s.modules)).toEqual(s.expect);
  });
});

describe('module setup', () => {
  it('sets and clears the table and power, keeping everything else', () => {
    const m = { id: 'm1', name: 'Yard', extra: 1 };
    const t = withTable(m, { type: 'mils', heightMm: 781.04 });
    expect(t).toEqual({ id: 'm1', name: 'Yard', extra: 1, table: { type: 'mils', heightMm: 781 } });
    const p = withPower(t, { needed: false, outlets: 4 });
    expect((p as { power?: unknown }).power).toEqual({ needed: false });
    expect(withPower(withTable(p, null), null)).toEqual(m);
  });

  it('a library setup replaces the placed one; none leaves it', () => {
    const placed = { id: 'm', table: { type: 'custom' as const }, power: { needed: true } };
    expect(withLibrarySetup(placed, null)).toBe(placed);
    expect(withLibrarySetup(placed, {})).toBe(placed);
    expect(withLibrarySetup(placed, { table: { type: 'mils' } })).toEqual({ id: 'm', table: { type: 'mils' } });
  });

  it('a module needing power uses one outlet unless it says', () => {
    expect(outletsOf({ needed: true })).toBe(1);
    expect(outletsOf({ needed: true, outlets: 0 })).toBe(0);
    expect(outletsOf({ needed: false, outlets: 3 })).toBe(0);
  });

  it('reads what the server stores, and nothing from junk', () => {
    expect(parseStoredSetup('{"power":{"needed":true,"outlets":2}}')).toEqual({ power: { needed: true, outlets: 2 } });
    for (const junk of [null, '', 'nope', '"x"', '{}', '[1]']) expect(parseStoredSetup(junk)).toBeNull();
  });
});
