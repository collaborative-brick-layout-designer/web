// An unnamed color in a .bbm is .NET's Color.Name: lowercase hex without
// leading zeros. The editor keeps 8 digits, so a clear or nearly clear color
// keeps its alpha, and the file is written back as vanilla BlueBrick writes it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBbm } from './Reader.js';
import { writeBbm } from './Writer.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
// Saved by vanilla BlueBrick 1.9.2 (desktop fixtures/bluebrick-oracle/tight-corner.from-tdl.bbm):
// its clear colors are written <Name>0</Name>.
const vanilla = readFileSync(resolve(FIXTURES, 'vanilla-clear-color.bbm'), 'utf8');

describe('unnamed colors, as BlueBrick names them', () => {
  it('reads "0" as clear black, not opaque black', () => {
    expect(readBbm(vanilla).map.backgroundColor).toEqual({ kind: 'argb', argb: '00000000' });
  });

  it('writes a file vanilla saved back byte for byte', () => {
    expect(vanilla).toMatch(/<Name>0<\/Name>/);
    expect(writeBbm(readBbm(vanilla).map)).toBe(vanilla);
  });

  it('writes a nearly clear color without its leading zero', () => {
    const { map } = readBbm(vanilla);
    map.backgroundColor = { kind: 'argb', argb: '05ff0000' };
    const xml = writeBbm(map);
    expect(xml).toMatch(/<BackgroundColor>\s*<IsKnownColor>false<\/IsKnownColor>\s*<Name>5ff0000<\/Name>/);
    expect(readBbm(xml).map.backgroundColor).toEqual({ kind: 'argb', argb: '05ff0000' });
  });

  it('keeps an opaque color as it was', () => {
    const { map } = readBbm(vanilla);
    map.backgroundColor = { kind: 'argb', argb: 'ff102030' };
    expect(writeBbm(map)).toMatch(/<Name>ff102030<\/Name>/);
  });
});
