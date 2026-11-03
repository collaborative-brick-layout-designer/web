// Fuzz the live path (src/fuzz): bundle a target with the code it reaches
// (Yjs included, so the fuzzer sees its branches too), write the seeds, and
// run Jazzer.js on it.
//
//   pnpm --filter @cld/server fuzz <guard|room> [seconds] [-- more libFuzzer flags]
//   pnpm --filter @cld/server fuzz <guard|room> replay [files or folders]
//
// New inputs go to fuzz/corpus/<target> (not committed); a finding is
// written to fuzz/findings/<target>/ and the run stops with an error. Copy
// a finding into fuzz/regressions/<target>/ once it is fixed: the replay
// test (src/fuzz/replay.test.ts) runs every file there on each pull request.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = resolve(server, '../../packages');
const [target = 'room', seconds = '60', ...rest] = process.argv.slice(2);
if (!['guard', 'room'].includes(target)) throw new Error(`no fuzz target ${target} (guard, room)`);
const extra = rest[0] === '--' ? rest.slice(1) : rest;

// The workspace packages from their sources, as the tests read them (vitest.sources.ts).
const alias = {};
for (const dir of readdirSync(packages)) {
  const pkg = JSON.parse(readFileSync(join(packages, dir, 'package.json'), 'utf8'));
  for (const [path, t] of Object.entries(pkg.exports ?? {})) {
    alias[path === '.' ? pkg.name : `${pkg.name}/${path.slice(2)}`] = join(packages, dir, t.types);
  }
}

const out = join(server, 'fuzz/build');
await build({
  entryPoints: { [target]: join(server, `src/fuzz/entry/${target}.ts`), seeds: join(server, 'src/fuzz/entry/seeds.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'inline',
  alias,
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

const env = { ...process.env, FUZZ_SERVER_DIR: server };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: server, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const seeds = join(out, 'seeds');
run(process.execPath, [join(out, 'seeds.mjs'), seeds]);
const corpus = join(server, 'fuzz/corpus', target);
const findings = join(server, 'fuzz/findings', target);
const regressions = join(server, 'fuzz/regressions', target);
for (const d of [corpus, findings, regressions]) mkdirSync(d, { recursive: true });

if (seconds === 'replay') {
  // Every input of the given files or folders (default: seeds and
  // regressions) once, without the fuzzer: a finding's message, or a check.
  const { statSync } = await import('node:fs');
  const { fuzz } = await import(join(out, `${target}.mjs`));
  const files = (extra.length ? extra : [join(seeds, target), regressions]).flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => !f.startsWith('.')).map((f) => join(p, f)) : [p],
  );
  let failed = 0;
  for (const f of files) {
    const t0 = performance.now();
    try {
      fuzz(readFileSync(f));
    } catch (err) {
      failed += 1;
      process.stdout.write(`${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    const ms = performance.now() - t0;
    if (ms > 200) process.stdout.write(`${f}: ${ms.toFixed(0)} ms\n`);
  }
  process.stdout.write(`${files.length - failed} of ${files.length} inputs pass\n`);
  process.exit(failed ? 1 : 0);
}

run(join(server, 'node_modules/.bin/jazzer'), [
  join(out, `${target}.mjs`),
  corpus,
  join(seeds, target),
  regressions,
  '--timeout=30000',
  '--',
  `-max_total_time=${seconds}`,
  '-max_len=300000',
  '-rss_limit_mb=4096',
  `-artifact_prefix=${findings}/`,
  '-print_final_stats=1',
  ...extra,
]);
