import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import type { LayerArea, LayerBrick, LayerGrid } from '@cld/model';
import { addLayer, AREA_CELL_SIZE_DEFAULT, ensureAreaLayer, ensureBrickLayer } from '../mutations';
import {
  applyLayerOptions,
  colorSpecAlpha,
  colorSpecToCss,
  colorSpecToHex,
  formFromLayer,
  layerOptionsPatch,
  withRgb,
} from '../layerOptions';
import { cellIndexLabel, cellIndexLabels, drawnGridLayer, gridCellAt, parseCellIndexCorner } from '../render/gridIndex';
import { createUndoManager } from '../useUndoManager';

function layerById<T>(doc: Y.Doc, id: string): T {
  return docToBbm(doc).layers.find((l) => l.id === id) as T;
}

describe('color helpers', () => {
  it('converts known and ARGB colors', () => {
    expect(colorSpecToHex({ kind: 'known', name: 'CornflowerBlue' })).toBe('#6495ed');
    expect(colorSpecToHex({ kind: 'argb', argb: '80FF0000' })).toBe('#ff0000');
    expect(colorSpecAlpha({ kind: 'argb', argb: '80000000' })).toBe(128);
    expect(colorSpecToCss({ kind: 'argb', argb: '80000000' })).toBe('rgba(0, 0, 0, 0.502)');
    expect(colorSpecToCss({ kind: 'argb', argb: 'ff00ff00' })).toBe('#00ff00');
  });

  it('keeps the alpha when the RGB changes', () => {
    expect(withRgb({ kind: 'argb', argb: '40000000' }, '#ABCDEF')).toEqual({ kind: 'argb', argb: '40abcdef' });
    expect(withRgb({ kind: 'known', name: 'Black' }, '#112233')).toEqual({ kind: 'argb', argb: 'ff112233' });
  });
});

describe('addLayer', () => {
  it('adds a Grid layer with the desktop defaults (core/LayerGrid.h)', () => {
    const doc = new Y.Doc();
    const id = addLayer(doc, 'grid');
    const g = layerById<LayerGrid>(doc, id);
    expect(g.type).toBe('grid');
    expect(g.name).toBe('Grid');
    expect(g.gridSizeInStud).toBe(32);
    expect(g.subDivisionNumber).toBe(4);
    expect(g.gridColor).toEqual({ kind: 'argb', argb: '80000000' });
    expect(g.displayCellIndex).toBe(false);
  });

  it('gives a new Grid layer an {x, y} cell-index corner, the only shape the server takes', () => {
    // It was '' until 2026-11: the server refused the edit adding the sheet.
    const doc = new Y.Doc();
    const id = addLayer(doc, 'grid');
    const raw = doc.getMap<Y.Map<unknown>>('layerData').get(id)!;
    expect(raw.get('cellIndexCorner')).toEqual({ x: 0, y: 0 });
    expect(raw.get('cellIndexFont')).toMatchObject({ size: 8.25 });
    expect(raw.get('hullProperties')).toMatchObject({ hullThickness: 1 });
  });

  it('new Area layers paint 32-stud cells (core/LayerArea.h:25)', () => {
    const doc = new Y.Doc();
    expect(layerById<LayerArea>(doc, addLayer(doc, 'area')).areaCellSize).toBe(32);
    const doc2 = new Y.Doc();
    const yArea = doc2.getMap('layerData').get(ensureAreaLayer(doc2)) as Y.Map<unknown>;
    expect(yArea.get('areaCellSize')).toBe(AREA_CELL_SIZE_DEFAULT);
  });
});

describe('layerOptionsPatch', () => {
  it('is empty when nothing changed, so stored color specs stay untouched', () => {
    const doc = new Y.Doc();
    const id = ensureBrickLayer(doc);
    const layer = layerById<LayerBrick>(doc, id);
    expect(layerOptionsPatch(layer, formFromLayer(layer))).toEqual({});
  });

  it('diffs common, brick and hull fields and clamps to the desktop ranges', () => {
    const doc = new Y.Doc();
    const id = ensureBrickLayer(doc);
    const layer = layerById<LayerBrick>(doc, id);
    const form = { ...formFromLayer(layer), name: '  Trains ', transparency: 140, visible: false, displayBrickElevation: true, hullThickness: 30 };
    const patch = layerOptionsPatch(layer, form);
    expect(patch).toEqual({
      // transparency 140 clamps to 100, which is unchanged → not written
      name: 'Trains',
      visible: false,
      displayBrickElevation: true,
      hullProperties: { isVisible: false, hullColor: layer.hullProperties.hullColor, hullThickness: 20 },
    });
  });

  it('writes grid options as one undo step', () => {
    const doc = new Y.Doc();
    const id = addLayer(doc, 'grid');
    const um = createUndoManager(doc);
    const layer = layerById<LayerGrid>(doc, id);
    const f = formFromLayer(layer);
    const patch = layerOptionsPatch(layer, {
      ...f,
      transparency: 50,
      grid: { ...f.grid!, gridSizeInStud: 96, gridThickness: 3, subDivisionNumber: 1, displaySubGrid: false, displayCellIndex: true, gridArgb: '80ff0000' },
    });
    applyLayerOptions(doc, id, patch);
    const g = layerById<LayerGrid>(doc, id);
    expect(g.transparency).toBe(50);
    expect(g.gridSizeInStud).toBe(96);
    expect(g.gridThickness).toBe(3);
    expect(g.subDivisionNumber).toBe(2); // desktop spin box minimum
    expect(g.displaySubGrid).toBe(false);
    expect(g.displayCellIndex).toBe(true);
    expect(g.gridColor).toEqual({ kind: 'argb', argb: '80ff0000' });
    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(layerById<LayerGrid>(doc, id).gridSizeInStud).toBe(32);
  });

  it('keeps the grid size from 1 to 512 studs, and a size that is not a number as it was', () => {
    for (const [typed, kept] of [
      [0, 1],
      [-8, 1],
      [0.4, 1],
      [100000, 512],
      [Number.NaN, 32],
      [Number.POSITIVE_INFINITY, 32],
    ] as const) {
      const doc = new Y.Doc();
      const id = addLayer(doc, 'grid');
      const layer = layerById<LayerGrid>(doc, id);
      const f = formFromLayer(layer);
      applyLayerOptions(doc, id, layerOptionsPatch(layer, { ...f, grid: { ...f.grid!, gridSizeInStud: typed } }));
      expect(layerById<LayerGrid>(doc, id).gridSizeInStud).toBe(kept);
    }
  });

  it('sets the area paint cell size (1-256)', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc); // seeds the map header
    const id = ensureAreaLayer(doc, 8);
    const layer = layerById<LayerArea>(doc, id);
    applyLayerOptions(doc, id, layerOptionsPatch(layer, { ...formFromLayer(layer), areaCellSize: 999 }));
    expect(layerById<LayerArea>(doc, id).areaCellSize).toBe(256);
  });
});

describe('grid cell index labels', () => {
  it('labels like desktop cellIndexLabel: from 1 / A after the origin, blank at and before it', () => {
    expect(cellIndexLabel(1, true)).toBe('A');
    expect(cellIndexLabel(26, true)).toBe('Z');
    expect(cellIndexLabel(27, true)).toBe('AA');
    expect(cellIndexLabel(28, true)).toBe('AB');
    expect(cellIndexLabel(52, true)).toBe('AZ');
    expect(cellIndexLabel(53, true)).toBe('BA');
    expect(cellIndexLabel(10, false)).toBe('10');
    expect(cellIndexLabel(0, true)).toBe('');
    expect(cellIndexLabel(-3, false)).toBe('');
  });

  it('the first visible grid layer draws (MapViewPaint.cpp:71-73)', () => {
    const layers = [
      { id: 'hidden', type: 'grid', visible: false },
      { id: 'bricks', type: 'brick', visible: true },
      { id: 'shown', type: 'grid', visible: true },
    ];
    expect(drawnGridLayer(layers)?.id).toBe('shown');
    expect(drawnGridLayer([layers[0]!])).toBeUndefined();
  });

  it('parses the stored corner point, defaulting to the origin', () => {
    expect(parseCellIndexCorner('\n  \n')).toEqual({ x: 0, y: 0 });
    expect(parseCellIndexCorner('<X>2</X><Y>-3</Y>')).toEqual({ x: 2, y: -3 });
    expect(parseCellIndexCorner({ x: 1, y: 4 })).toEqual({ x: 1, y: 4 });
  });

  it('labels the origin row with columns and the origin column with rows only (MapViewPaint.cpp:115-140)', () => {
    // Origin cell (0, 0), 32-stud cells, a view of 3 x 3 cells; like
    // desktop the range runs to ceil(edge / cell), one partly-hidden cell on.
    const labels = cellIndexLabels({ xMin: 0, yMin: 0, xMax: 95, yMax: 95 }, 32, { x: 0, y: 0 }, '0', '1');
    expect(labels).toEqual([
      { x: 32, y: 0, text: 'A' },
      { x: 64, y: 0, text: 'B' },
      { x: 96, y: 0, text: 'C' },
      { x: 0, y: 32, text: '1' },
      { x: 0, y: 64, text: '2' },
      { x: 0, y: 96, text: '3' },
    ]);
  });

  it('cells before the origin stay blank; nothing when the origin row and column are out of view', () => {
    const shifted = cellIndexLabels({ xMin: -64, yMin: 0, xMax: 31, yMax: 31 }, 32, { x: -1, y: 0 }, '1', '0');
    // Origin cell (-1, 0) stays blank: columns count from x = 0 ("1", "2")
    // and rows (letters) from the row below it, down the origin column.
    expect(shifted.map((l) => [l.x, l.y, l.text])).toEqual([[0, 0, '1'], [32, 0, '2'], [-32, 32, 'A']]);
    expect(cellIndexLabels({ xMin: 100, yMin: 100, xMax: 200, yMax: 200 }, 32, { x: 0, y: 0 }, '0', '1')).toEqual([]);
  });
});


describe('grid origin drag (MapView.cpp:1648-1667, MoveGridOriginCommand)', () => {
  it('gridCellAt truncates, one less below zero, like BlueBrick', () => {
    expect(gridCellAt(40, 70, 32)).toEqual({ x: 1, y: 2 });
    expect(gridCellAt(-0.5, -40, 32)).toEqual({ x: -1, y: -2 });
    // BlueBrick's quirk: exactly -1 cell truncates to -1, then one less.
    expect(gridCellAt(-32, 0, 32)).toEqual({ x: -2, y: 0 });
  });

  it('moveGridOrigin shifts the corner by whole cells as one undo step', async () => {
    const { moveGridOrigin } = await import('../mutations');
    const doc = createDefaultLayoutDoc();
    const grid = docToBbm(doc).layers.find((l) => l.type === 'grid')!;
    const um = createUndoManager(doc);
    moveGridOrigin(doc, grid.id, 2, -1);
    expect(layerById<LayerGrid>(doc, grid.id).cellIndexCorner).toEqual({ x: 2, y: -1 });
    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(layerById<LayerGrid>(doc, grid.id).cellIndexCorner).toEqual({ x: 0, y: 0 });
    moveGridOrigin(doc, grid.id, 0, 0);
    expect(um.undoStack.length).toBe(0);
  });
});
