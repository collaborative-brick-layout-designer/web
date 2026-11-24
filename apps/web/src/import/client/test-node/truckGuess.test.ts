// @vitest-environment node
//
// The truck guess on real train models (trains design 3.3, Phase 6): the
// shared contract fixtures/contracts/truck-guess.json, three LDraw OMR
// models (an engine on two bogies, a caboose on two axles, a tanker) read
// by this importer's own reader, and hand-made part lists. The desktop's
// tests/track/StockGuessTest.cpp runs the same vectors.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guessStock, MapLibrary, STOCK_PARTS, stockPartId, type GuessRect, type GuessRef, type StockGuess } from '@cld/parts-catalog/browser';
import { readLDraw } from '../ldrawReader';
import { prepareModel } from '../prepareModel';
import { makeIo } from './makeIo';
import { FolderLibrary } from './nodeHelpers';
import { topDownRefs } from '../stockGuess';

const DIR = resolve(__dirname, '../../../../../../fixtures/contracts');
const contract = JSON.parse(readFileSync(join(DIR, 'truck-guess.json'), 'utf8')) as {
  parts: unknown;
  vectors: { name: string; model?: string; refs?: GuessRef[]; bounds: GuessRect; centre: { x: number; y: number }; expect: StockGuess }[];
};

describe('the truck guess', () => {
  it('keeps the contract’s part table word for word', () => {
    expect(STOCK_PARTS).toEqual(contract.parts);
  });

  for (const v of contract.vectors) {
    it(v.name, () => {
      const refs = v.model ? topDownRefs(readLDraw(readFileSync(join(DIR, v.model), 'utf8'))) : v.refs!;
      expect(guessStock(refs, v.bounds, v.centre)).toEqual(v.expect);
    });
  }

  it('names parts as the table does, whatever the model’s spelling', () => {
    expect(stockPartId('S\\2878C01.DAT')).toBe('2878c01');
    expect(stockPartId('parts/4092a.dat')).toBe('4092a');
    expect(stockPartId('88002c01')).toBe('88002c01');
  });

  it('comes with a Studio engine the browser imports: its own bogies, wheels and magnets', async () => {
    const plate = (name: string, w: number, d: number) =>
      `0 ${name}\n4 16 ${-w * 10} -8 ${-d * 10} ${w * 10} -8 ${-d * 10} ${w * 10} -8 ${d * 10} ${-w * 10} -8 ${d * 10}\n`;
    const model = [
      '0 FILE Santa Fe engine.io',
      '0 Santa Fe engine',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 base.dat',
      '1 0 180 8 0 1 0 0 0 1 0 0 0 1 4092a.dat',
      '1 0 -180 8 0 1 0 0 0 1 0 0 0 1 4092a.dat',
      '1 0 130 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
      '1 0 230 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
      '1 0 -130 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
      '1 0 -230 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
      '1 7 300 0 0 1 0 0 0 1 0 0 0 1 2920.dat',
      '1 7 -300 0 0 1 0 0 0 1 0 0 0 1 2920.dat',
      '0 NOFILE',
      '',
    ].join('\n');
    const io = makeIo([
      { name: 'model.ldr', text: model },
      { name: 'CustomParts/base.dat', text: plate('Engine base', 28, 6) },
      { name: 'CustomParts/4092a.dat', text: plate('Bogie plate', 2, 4) },
      { name: 'CustomParts/2878c01.dat', text: plate('Wheel holder', 1, 6) },
      { name: 'CustomParts/2920.dat', text: plate('Magnet coupler', 2, 2) },
    ]);
    const part = await prepareModel('Santa Fe engine.io', io, { source: new FolderLibrary(resolve(__dirname, 'fixtures/minilib')), parts: new MapLibrary(new Map()) });
    expect(part.error).toBe('');
    expect([part.widthStuds, part.heightStuds]).toEqual([32, 6]);
    expect(part.stockGuess).toEqual({ quarterTurns: 0, length: 30, width: 6, bodyLength: 28, trucks: [9, -9], trucksFrom: 'bogies', couplersFrom: 'found' });
  });
});
