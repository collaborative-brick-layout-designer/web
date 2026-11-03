// The fuzz targets (src/fuzz, run by scripts/fuzz.mjs) on every input that
// once broke a property (fuzz/regressions/<target>/) and on their seeds:
// what real clients send, which must all pass. Runs with the other tests on
// each pull request; the fuzzing itself runs in the Fuzz workflow.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fuzzGuard } from './guard.js';
import { fuzzRoom, stats } from './room.js';
import { guardSeeds, taggedRoomSeeds } from './seeds.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.FUZZ_SERVER_DIR = SERVER;

const targets = { guard: fuzzGuard, room: fuzzRoom } as const;

// The handler logs each refusal and audits it (the fuzz room has no layout
// row, so the audit write fails and is logged too): none of it is a failure.
beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function regressions(target: string): [string, Uint8Array][] {
  const dir = join(SERVER, 'fuzz/regressions', target);
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]);
}

describe('fuzz regressions', () => {
  for (const [target, run] of Object.entries(targets)) {
    it(`${target}: every saved input passes`, () => {
      for (const [name, input] of regressions(target)) expect(() => run(input), name).not.toThrow();
    });
  }
});

describe('fuzz seeds (what real clients send)', () => {
  it('guard: every seed passes', () => {
    const seeds = guardSeeds();
    expect(seeds.length).toBeGreaterThan(100);
    for (const [i, s] of seeds.entries()) expect(() => fuzzGuard(s), `seed ${i}`).not.toThrow();
  });

  it('room: every seed passes, and no client edit among them is refused', { timeout: 120_000 }, () => {
    const seeds = taggedRoomSeeds();
    expect(seeds.length).toBeGreaterThan(100);
    expect(seeds.filter((s) => s.real).length).toBeGreaterThan(50);
    for (const [i, s] of seeds.entries()) expect(() => fuzzRoom(s.input, { allTaken: s.real }), `seed ${i}`).not.toThrow();
    expect(stats.messages).toBeGreaterThan(250);
  });
});
