// Part list export laid out like BlueBrick's PartUsageView export — the
// desktop's PartListTest.cpp, ported.

import { describe, expect, it } from 'vitest';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../../api';
import { colorName } from '../colorNames';
import { buildPartList, partListCsv, partListHtml, partListText, percentageBar } from '../partList';
import { defuseFormula } from '../../csvSafety';

function sampleMap(comment = ''): BbmMap {
  const bricks = (part: string, n: number) => Array.from({ length: n }, () => ({ partNumber: part }));
  return {
    author: 'Ada', lug: '', event: '', comment,
    date: { day: 26, month: 9, year: 2026 },
    layers: [
      { type: 'brick', name: 'Tracks', visible: true, bricks: [...bricks('2865.8', 3), ...bricks('3811.1', 1)] },
      { type: 'brick', name: 'Hidden', visible: false, bricks: bricks('2865.8', 2) },
    ],
  } as unknown as BbmMap;
}

const parts = new Map<string, PartWire>([
  ['2865.8', { description: '9V Straight Track' } as PartWire],
  ['3811.1', { description: 'Baseplate 32 x 32' } as PartWire],
]);

describe('colorName (BlueBrick ColorTable.xml)', () => {
  it('names LDraw colors, empty for anything else', () => {
    expect(colorName('0')).toBe('Black');
    expect(colorName('1')).toBe('Blue');
    expect(colorName('set')).toBe('');
    expect(colorName('')).toBe('');
  });
});

describe('percentageBar', () => {
  it('draws tenths, a partial block and dashes, then the rounded percentage', () => {
    expect(percentageBar(0)).toBe('▏' + '╌'.repeat(9) + ' 0%');
    expect(percentageBar(45)).toBe('█'.repeat(4) + '▋' + '╌'.repeat(5) + ' 45%');
    expect(percentageBar(100)).toBe('█'.repeat(10) + ' 100%');
    expect(percentageBar(1250)).toBe('█'.repeat(10) + ' 1,250%');
  });
});

describe('buildPartList', () => {
  it('counts, colors, hidden layers, budget and per-layer groups', () => {
    const map = sampleMap();
    let groups = buildPartList(map, parts);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => [r.part, r.count, r.colorName])).toEqual([['2865', 5, 'Dark Gray'], ['3811', 1, 'Blue']]);
    expect(groups[0]!.total.count).toBe(6);
    expect(buildPartList(map, parts, { includeHiddenLayers: false })[0]!.rows[0]!.count).toBe(3);

    groups = buildPartList(map, parts, { limits: new Map([['2865.8', 4]]) });
    const straight = groups[0]!.rows[0]!;
    expect([straight.budget, straight.missing, straight.usage]).toEqual([4, 1, 125]);
    expect(groups[0]!.rows[1]!.usage).toBeLessThan(0); // unbudgeted
    expect(groups[0]!.rows[1]!.missing).toBe(1); // unbudgeted parts are all missing
    expect([groups[0]!.total.budget, groups[0]!.total.missing]).toEqual([4, 2]);

    groups = buildPartList(map, parts, { splitPerLayer: true });
    expect(groups.map((g) => [g.name, g.total.count])).toEqual([['Tracks', 4], ['Hidden', 2]]);
  });
});

describe('text and CSV', () => {
  const map = sampleMap();
  const groups = buildPartList(map, parts, { limits: new Map([['2865.8', 10]]) });

  it('text: framed title, map info, aligned table', () => {
    const text = partListText(map, groups, 'Part List', true).split('\n');
    expect(text[0]).toBe(' '.repeat(20) + '+===========+');
    expect(text[1]).toBe(' '.repeat(20) + '| Part List |');
    expect(text[4]).toBe('Author: Ada');
    expect(text[7]).toBe('Date: Saturday, September 26, 2026');
    const table = text.filter((l) => (l.startsWith('+') && !l.startsWith('+=')) || l.startsWith('| '));
    expect(new Set(table.map((l) => l.length)).size).toBe(1);
    expect(text).toContain('| Part  | In Use | Color     | Description       | Budgeted   | Missing | Part Usage %   |');
    expect(text).toContain('| 3811  | 1      | Blue      | Baseplate 32 x 32 | Unbudgeted | 1       | Unbudgeted     |');
  });

  it('CSV: titles, plain numbers for usage', () => {
    const csv = partListCsv(groups, true).split('\n');
    expect(csv[0]).toBe('Part,In Use,Color,Description,Budgeted,Missing,Part Usage %');
    expect(csv[1]!.startsWith('2865,5,')).toBe(true);
    expect(csv[1]!.endsWith(',10,0,50')).toBe(true);
    expect(csv[2]!.endsWith(',Unbudgeted,1,Unbudgeted')).toBe(true);
    expect(csv[3]!.startsWith('Total,6,,,10,1,50')).toBe(true);
  });
});

describe('CSV formula defusing', () => {
  it('a part name, description or layer name a spreadsheet would run gets a leading quote', () => {
    const map = {
      author: '', lug: '', event: '', comment: '',
      date: { day: 1, month: 1, year: 2026 },
      layers: [
        { type: 'brick', name: '=cmd|calc', visible: true, bricks: ['=HYPERLINK(x).1', '+1.1', '@SUM.1', '-cmd.1', '2865.8'].map((partNumber) => ({ partNumber })) },
      ],
    } as unknown as BbmMap;
    const hostile = new Map<string, PartWire>([
      ['=hyperlink(x).1', { description: '=HYPERLINK("http://evil")' } as PartWire],
      ['+1.1', { description: '+1' } as PartWire],
      ['@sum.1', { description: '@SUM(A1)' } as PartWire],
      ['-cmd.1', { description: '-cmd' } as PartWire],
      ['2865.8', { description: '\tTabbed' } as PartWire],
    ]);
    const csv = partListCsv(buildPartList(map, hostile, { splitPerLayer: true }), false).split('\n');
    expect(csv[0]).toBe("'=cmd|calc");
    expect(csv.slice(2, 7)).toEqual([
      "'+1,1,Blue,'+1,N/A,N/A,N/A",
      "'-CMD,1,Blue,'-cmd,N/A,N/A,N/A",
      "2865,1,Dark Gray,'\tTabbed,N/A,N/A,N/A",
      "'=HYPERLINK(X),1,Blue,'=HYPERLINK(\"http://evil\"),N/A,N/A,N/A",
      "'@SUM,1,Blue,'@SUM(A1),N/A,N/A,N/A",
    ]);
  });

  it('real numbers, negative ones included, stay as they are', () => {
    for (const n of ['5', '-5', '-0.5', '0.5', '-12.', '-.5', '1250']) expect(defuseFormula(n)).toBe(n);
    for (const t of ['=1+1', '+1', '-1+1', '-cmd', '@SUM', '\tx', '\rx', '-', '+']) expect(defuseFormula(t)).toBe(`'${t}`);
    expect(defuseFormula('Baseplate 32 x 32')).toBe('Baseplate 32 x 32');
    expect(defuseFormula('')).toBe('');
    // An over-budget layout's usage and missing counts are plain numbers.
    const map = { author: '', lug: '', event: '', comment: '', date: { day: 1, month: 1, year: 2026 },
      layers: [{ type: 'brick', name: '', visible: true, bricks: [{ partNumber: '3811.1' }] }] } as unknown as BbmMap;
    const csv = partListCsv(buildPartList(map, parts, { limits: new Map([['3811.1', 0]]) }), true).split('\n');
    expect(csv[1]).toBe('3811,1,Blue,Baseplate 32 x 32,0,1,200');
  });

  it('usage of 1,000 % and more has no thousands comma, so the row keeps its seven columns', () => {
    const map = { author: '', lug: '', event: '', comment: '', date: { day: 1, month: 1, year: 2026 },
      layers: [{ type: 'brick', name: '', visible: true, bricks: Array.from({ length: 26 }, () => ({ partNumber: '3811.1' })) }] } as unknown as BbmMap;
    const csv = partListCsv(buildPartList(map, parts, { limits: new Map([['3811.1', 1]]) }), true).split('\n');
    expect(csv[1]).toBe('3811,26,Blue,Baseplate 32 x 32,1,25,2600');
    expect(csv[1]!.split(',')).toHaveLength(7);
  });
});

describe('HTML', () => {
  it('embeds pictures and escapes text', () => {
    const map = sampleMap('a < b\nnext');
    const html = partListHtml(map, buildPartList(map, parts), 'T', false, () => 'data:image/png;base64,AAAA');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('a &lt; b<br/>next');
    expect(html).toContain('<td class="budget">N/A</td>');
    expect(html).toContain('<tr class="total">');
  });
});
