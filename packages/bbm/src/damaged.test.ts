// A damaged or cut-off .bbm is refused, naming the line, never opened in
// part: the parser used to read what it could, so a file cut off at a tenth
// opened with a tenth of its parts, and saving wrote that over the whole
// file. BlueBrick and the desktop refuse the same files.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBbm } from './Reader.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
const fordyce = readFileSync(resolve(FIXTURES, 'fordyce-2026.bbm'), 'utf8');

describe('damaged .bbm files', () => {
  it('reads the whole file', () => {
    expect(() => readBbm(fordyce)).not.toThrow();
  });

  it.each([0.1, 0.5, 0.9, 0.999])('refuses a file cut off at %s', (at) => {
    expect(() => readBbm(fordyce.slice(0, Math.floor(fordyce.length * at)))).toThrow(/cut off at line \d+/);
  });

  it('refuses a file damaged part way, naming where', () => {
    expect(() => readBbm(fordyce.replace('<Brick ', '<Bri<k '))).toThrow(/damaged at line \d+, column \d+/);
  });
});
