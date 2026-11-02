// A layout made from a .bbm (seedFromBbm) holds only drawing settings both
// apps draw: one out of range is put back in range (drawnLimits.ts), as
// the desktop's core::keepDrawnSettingsInRange does, and every real
// BlueBrick file comes through unchanged.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readBbm } from '@cld/bbm';
import type { BbmMap, LayerArea, LayerGrid, LayerRuler, LinearRulerItem, CircularRulerItem } from '@cld/model';
import { bbmToDoc, docToBbm } from './projection.js';
import { keepDrawnSettingsInRange } from './drawnLimits.js';
import { seedFromBbm } from './index.js';

const BBM_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../bbm/tests/fixtures');
const realFiles = [
  ...readdirSync(BBM_FIXTURES).filter((f) => f.endsWith('.bbm')),
  ...readdirSync(join(BBM_FIXTURES, 'oracle'))
    .filter((f) => f.endsWith('.bbm'))
    .map((f) => join('oracle', f)),
];

const fordyce = () => readBbm(readFileSync(join(BBM_FIXTURES, 'fordyce-2026.bbm'), 'utf8')).map;
const grid = (m: BbmMap) => m.layers.find((l) => l.type === 'grid') as LayerGrid;
const ruler = (m: BbmMap) => m.layers.find((l) => l.type === 'ruler') as LayerRuler;
const linear = (m: BbmMap) => ruler(m).rulerItems.find((r) => r.kind === 'linear') as LinearRulerItem;

describe('drawing settings of a layout made from a .bbm', () => {
  it.each(realFiles)('are left as they are in %s', (file) => {
    const map = readBbm(readFileSync(join(BBM_FIXTURES, file), 'utf8')).map;
    expect(keepDrawnSettingsInRange(map)).toEqual(map);
  });

  it('are put back in range on a grid, at the nearest end', () => {
    const map = fordyce();
    Object.assign(grid(map), {
      transparency: 500,
      gridSizeInStud: -4,
      subDivisionNumber: 1_000_000,
      gridThickness: 1e9,
      subGridThickness: -3,
      cellIndexFont: { ...grid(map).cellIndexFont, size: 1e12 },
      cellIndexCorner: { x: -5e9, y: 2.6 },
    });
    grid(map).hullProperties.hullThickness = 0;
    const g = grid(keepDrawnSettingsInRange(map));
    expect(g).toMatchObject({ transparency: 100, gridSizeInStud: 1, subDivisionNumber: 100, gridThickness: 100, subGridThickness: 0 });
    expect(g.cellIndexFont.size).toBe(500);
    expect(g.cellIndexCorner).toEqual({ x: -1_000_000, y: 3 });
    expect(g.hullProperties.hullThickness).toBe(1);
    // The map passed in is left as it was.
    expect(grid(map).subDivisionNumber).toBe(1_000_000);
  });

  it('get the default when they aren’t a number', () => {
    const map = fordyce();
    Object.assign(grid(map), { gridSizeInStud: NaN, subDivisionNumber: Infinity, transparency: -Infinity, gridThickness: 'wide' });
    const g = grid(keepDrawnSettingsInRange(map));
    expect(g).toMatchObject({ gridSizeInStud: 32, subDivisionNumber: 4, transparency: 100, gridThickness: 2 });
  });

  it('are put back in range on a ruler', () => {
    const map = fordyce();
    Object.assign(linear(map), {
      lineThickness: 1e6,
      guidelineThickness: -1,
      unit: 99,
      measureFont: { ...linear(map).measureFont, size: 0 },
      point1: { x: 1e12, y: -1e12 },
      point2: { x: NaN, y: 5 },
      offsetDistance: -1e30,
    });
    const r = linear(keepDrawnSettingsInRange(map));
    expect(r).toMatchObject({ lineThickness: 100, guidelineThickness: 0, unit: 0, offsetDistance: -1e7 });
    expect(r.measureFont.size).toBe(1);
    expect(r.point1).toEqual({ x: 1e7, y: -1e7 });
    expect(r.point2).toEqual({ x: 0, y: 5 });
  });

  it.each([
    ['too many dashes', Array.from({ length: 65 }, () => 2)],
    ['a dash too long', [2, 5000]],
    ['a negative dash', [4, -1]],
    ['dashes adding up to nothing', [0, 0.001]],
  ])('drop a dash pattern with %s (a solid guideline)', (_what, dashes) => {
    const map = fordyce();
    linear(map).guidelineDashPattern = dashes;
    expect(linear(keepDrawnSettingsInRange(map)).guidelineDashPattern).toEqual([]);
  });

  it('keep a circular ruler’s centre and radius in range, and an area sheet’s cell size', () => {
    const map = fordyce();
    const base = linear(map);
    const circle: CircularRulerItem = {
      ...base,
      kind: 'circular',
      center: { x: 3, y: 2e8 },
      radius: -10,
      attachedBrickId: '0',
    } as unknown as CircularRulerItem;
    ruler(map).rulerItems.push(circle);
    const area: LayerArea = { ...grid(map), type: 'area', id: 'area-1', areaCellSize: 100_000, areas: [] } as unknown as LayerArea;
    map.layers.push(area);
    const out = keepDrawnSettingsInRange(map);
    const c = ruler(out).rulerItems.at(-1) as CircularRulerItem;
    expect(c.center).toEqual({ x: 3, y: 1e7 });
    expect(c.radius).toBe(0);
    expect((out.layers.at(-1) as LayerArea).areaCellSize).toBe(1024);
  });

  it('are in range in the layout seedFromBbm makes, and only those change', () => {
    const map = fordyce();
    grid(map).subDivisionNumber = 1_000_000;
    linear(map).unit = 42;
    const made = docToBbm(seedFromBbm(map));
    expect(grid(made).subDivisionNumber).toBe(100);
    expect(linear(made).unit).toBe(0);
    // Everything else as the file had it.
    const asIs = new Y.Doc();
    bbmToDoc(map, asIs);
    const expected = docToBbm(asIs);
    grid(expected).subDivisionNumber = 100;
    linear(expected).unit = 0;
    expect(made).toEqual(expected);
  });
});

// Values of the wrong shape: a string, an array or a number where an object
// belongs is never spread into an object of its characters, and a ruler's
// unit (the one enum) that isn't a whole number in range is studs.
// Layouts imported before 2026-09-27 hold the grid's cell-index corner as
// the <CellIndexCorner> element's whitespace text, this exact string.
const FORDYCE_OLD_CORNER = '\n        \n        \n      ';
const WRONG_SHAPES: [string, unknown][] = [
  ['the old whitespace text', FORDYCE_OLD_CORNER],
  ['whitespace', '   '],
  ['an empty string', ''],
  ['a number', 7],
  ['an array', [1, 2]],
  ['a string of digits', '12'],
];

describe('drawing settings of the wrong shape', () => {
  it.each(WRONG_SHAPES)('a cell-index corner that is %s is the default corner', (_what, v) => {
    const map = fordyce();
    (grid(map) as unknown as Record<string, unknown>).cellIndexCorner = v;
    expect(grid(keepDrawnSettingsInRange(map)).cellIndexCorner).toEqual({ x: 0, y: 0 });
  });

  it('a cell-index corner that is an object keeps its shape, its x and y in range', () => {
    const map = fordyce();
    (grid(map) as unknown as Record<string, unknown>).cellIndexCorner = { x: '  ', y: { a: 1 } };
    expect(grid(keepDrawnSettingsInRange(map)).cellIndexCorner).toEqual({ x: 0, y: 0 });
  });

  it.each([...WRONG_SHAPES, ['an object', { unit: 1 }] as [string, unknown], ['a fraction', 2.5] as [string, unknown], ['past the last unit', 6] as [string, unknown]])(
    'a ruler unit that is %s is studs',
    (_what, v) => {
      const map = fordyce();
      (linear(map) as unknown as Record<string, unknown>).unit = v;
      expect(linear(keepDrawnSettingsInRange(map)).unit).toBe(0);
    },
  );

  it.each([...WRONG_SHAPES, ['null', null] as [string, unknown]])('a font, hull or point that is %s is left as it is, never spread', (_what, v) => {
    const map = fordyce();
    const g = grid(map) as unknown as Record<string, unknown>;
    const r = linear(map) as unknown as Record<string, unknown>;
    g.cellIndexFont = v;
    g.hullProperties = v;
    r.measureFont = v;
    r.point1 = v;
    r.point2 = v;
    const out = keepDrawnSettingsInRange(map);
    const og = grid(out) as unknown as Record<string, unknown>;
    const or = linear(out) as unknown as Record<string, unknown>;
    for (const got of [og.cellIndexFont, og.hullProperties, or.measureFont, or.point1, or.point2]) expect(got).toBe(v);
  });

  it.each(WRONG_SHAPES.filter(([, v]) => !Array.isArray(v)))('a dash pattern that is %s is none', (_what, v) => {
    const map = fordyce();
    (linear(map) as unknown as Record<string, unknown>).guidelineDashPattern = v;
    expect(linear(keepDrawnSettingsInRange(map)).guidelineDashPattern).toEqual([]);
  });

  it('a ruler entry that is not an object is left as it is', () => {
    const map = fordyce();
    (ruler(map).rulerItems as unknown[]).push(FORDYCE_OLD_CORNER, 3);
    expect(ruler(keepDrawnSettingsInRange(map)).rulerItems.slice(-2)).toEqual([FORDYCE_OLD_CORNER, 3]);
  });
});
