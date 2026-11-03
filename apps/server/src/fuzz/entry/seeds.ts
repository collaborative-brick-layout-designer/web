// Writes the seed inputs of both targets into <dir>/guard and <dir>/room
// (scripts/fuzz.mjs runs it before fuzzing).
import '../env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { guardSeeds, roomSeeds } from '../seeds.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: seeds <dir>');
for (const [target, seeds] of [['guard', guardSeeds()], ['room', roomSeeds()]] as const) {
  mkdirSync(join(dir, target), { recursive: true });
  for (const s of seeds) writeFileSync(join(dir, target, `seed-${createHash('sha1').update(s).digest('hex').slice(0, 16)}`), s);
  process.stdout.write(`${seeds.length} ${target} seeds\n`);
}
