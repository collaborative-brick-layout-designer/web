import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import type { AnchoredLabel } from '@cld/bbm';
import type { BbmMap } from '@cld/model';
import {
  addAnchoredLabel,
  addLinearRuler,
  addTextCell,
  ensureBrickLayer,
  ensureRulerLayer,
  ensureTextLayer,
  placeBrick,
  setActiveConnectionPoint,
} from '../mutations';
import {
  annotationsInMarquee,
  buildLabelIndex,
  clickAnno,
  deleteMixedSelection,
  DEFAULT_LABEL_FONT,
  labelAnchorStuds,
  labelFontFamily,
  labelFontPx,
  labelFontStyle,
  labelOffsetDelta,
  labelPlacement,
  labelShapeStuds,
  labelsToOffset,
  mergeAnno,
  parseTextKey,
  textKey,
  toggleId,
  translateMixedSelection,
} from '../mixedSelection';
import { createUndoManager } from '../useUndoManager';
import type { AnnoSelection } from '../editorStore';

const NONE: AnnoSelection = { rulers: [], labels: [], texts: [] };

function label(overrides: Partial<AnchoredLabel>): AnchoredLabel {
  return {
    id: 'l',
    text: 'Hello',
    font: { family: 'Arial', size: 16, style: '' },
    color: { known: true, argb: 0, name: 'Black' },
    kind: 0,
    targetId: '',
    offset: { x: 0, y: 0 },
    rot: 0,
    minZoom: 0,
    ...overrides,
  };
}

/** Doc with one brick at (0,0) 8×8, a ruler (20,0)-(30,0), a text cell centred (50,4) and two labels. */
function seed() {
  const doc = new Y.Doc();
  const brickLayer = ensureBrickLayer(doc);
  const brick = placeBrick(doc, brickLayer, { partNumber: 'p.1', x: 0, y: 0, width: 8, height: 8 });
  const rulerLayer = ensureRulerLayer(doc);
  const ruler = addLinearRuler(doc, rulerLayer, { x: 20, y: 0 }, { x: 30, y: 0 });
  const textLayer = ensureTextLayer(doc);
  addTextCell(doc, textLayer, {
    centreX: 50, centreY: 4, widthStuds: 4, heightStuds: 2, text: 'T',
    font: { family: 'Arial', size: 10, style: 'Regular' }, fontColor: { kind: 'known', name: 'Black' },
  });
  addTextCell(doc, textLayer, {
    centreX: 60, centreY: 4, widthStuds: 4, heightStuds: 2, text: 'U',
    font: { family: 'Arial', size: 10, style: 'Regular' }, fontColor: { kind: 'known', name: 'Black' },
  });
  addAnchoredLabel(doc, label({ id: 'world', offset: { x: 70, y: 0 } }));
  addAnchoredLabel(doc, label({ id: 'onBrick', kind: 1, targetId: brick, offset: { x: 1, y: 1 } }));
  return { doc, brick, brickLayer, ruler, rulerLayer, textLayer };
}

function labels(doc: Y.Doc): AnchoredLabel[] {
  return readSidecarFromDoc(doc)?.anchoredLabels ?? [];
}

describe('selection helpers', () => {
  it('round-trips text keys', () => {
    expect(parseTextKey(textKey('12', 3))).toEqual({ layerId: '12', cellIndex: 3 });
    expect(parseTextKey('nohash')).toBeNull();
    expect(parseTextKey('L#x')).toBeNull();
  });

  it('toggles and merges ids', () => {
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(mergeAnno({ ...NONE, rulers: ['r1'] }, { ...NONE, rulers: ['r1', 'r2'], labels: ['l'] }))
      .toEqual({ rulers: ['r1', 'r2'], labels: ['l'], texts: [] });
  });

  it('plain click selects only the annotation; Shift/Ctrl toggles and keeps bricks', () => {
    expect(clickAnno(['b1'], { ...NONE, labels: ['l1'] }, 'rulers', 'r1', false))
      .toEqual({ bricks: [], anno: { rulers: ['r1'], labels: [], texts: [] } });
    expect(clickAnno(['b1'], { ...NONE, labels: ['l1'] }, 'rulers', 'r1', true))
      .toEqual({ bricks: ['b1'], anno: { rulers: ['r1'], labels: ['l1'], texts: [] } });
    expect(clickAnno(['b1'], { ...NONE, rulers: ['r1'] }, 'rulers', 'r1', true).anno.rulers).toEqual([]);
  });
});

/** Map with one brick 'b' centred at (10, 20), 8×4 footprint, at `orientation`. */
function rotatedMap(orientation: number): BbmMap {
  const vertical = Math.abs(orientation % 180) === 90;
  const w = vertical ? 4 : 8;
  const h = vertical ? 8 : 4;
  return {
    layers: [{
      type: 'brick', id: 'L', visible: true,
      bricks: [{ id: 'b', orientation, myGroup: 'g', displayArea: { x: 10 - w / 2, y: 20 - h / 2, width: w, height: h } }],
    }],
  } as unknown as BbmMap;
}

describe('label geometry', () => {
  it('anchors attached Brick labels at the brick centre, everything else at the origin', () => {
    const { doc, brick } = seed();
    const map = docToBbm(doc);
    const index = buildLabelIndex(map, []);
    const [world, onBrick] = labels(doc);
    expect(labelAnchorStuds(world!, index)).toEqual({ x: 0, y: 0 });
    expect(labelAnchorStuds(onBrick!, index)).toEqual({ x: 4, y: 4 });
    // Desktop falls through to a world position when the brick is gone.
    expect(labelAnchorStuds(label({ kind: 1, targetId: 'gone' }), index)).toEqual({ x: 0, y: 0 });
    expect(labelPlacement(label({ kind: 1, targetId: 'gone', offset: { x: 3, y: 4 } }), index))
      .toEqual({ x: 3, y: 4, rotation: 0 });
    void brick;
  });

  it('places Group and Module labels at their offset as a world position (no bbox anchor)', () => {
    const index = buildLabelIndex(rotatedMap(0), [{ id: 'm', name: 'M', members: ['b'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] }]);
    const group = label({ kind: 2, targetId: 'g', offset: { x: 5, y: 6 }, rot: 15 });
    const mod = label({ kind: 3, targetId: 'm', offset: { x: -1, y: 2 } });
    expect(labelPlacement(group, index)).toEqual({ x: 5, y: 6, rotation: 15 });
    expect(labelPlacement(mod, index)).toEqual({ x: -1, y: 2, rotation: 0 });
    // They don't ride along with their members either.
    expect(labelsToOffset(['l'], [group], index, new Set(['b']))).toEqual(['l']);
  });

  it('rotates a Brick label offset and text with the brick (SceneBuilderSidecar.cpp:216-221)', () => {
    const l = label({ kind: 1, targetId: 'b', offset: { x: 2, y: -2 }, rot: 10 });
    const p0 = labelPlacement(l, buildLabelIndex(rotatedMap(0), []));
    expect(p0).toEqual({ x: 12, y: 18, rotation: 10 });
    const p90 = labelPlacement(l, buildLabelIndex(rotatedMap(90), []));
    // (2, -2) turned 90° clockwise (y down) is (2, 2).
    expect(p90.x).toBeCloseTo(12, 9);
    expect(p90.y).toBeCloseTo(22, 9);
    expect(p90.rotation).toBe(100);
  });

  it('maps a world drag back into the brick frame so the label lands where dropped', () => {
    const l = label({ kind: 1, targetId: 'b', offset: { x: 2, y: -2 } });
    const index = buildLabelIndex(rotatedMap(90), []);
    const d = labelOffsetDelta(l, index, 3, 0);
    expect(d.dx).toBeCloseTo(0, 9);
    expect(d.dy).toBeCloseTo(-3, 9);
    const moved = labelPlacement({ ...l, offset: { x: l.offset.x + d.dx, y: l.offset.y + d.dy } }, index);
    const before = labelPlacement(l, index);
    expect(moved.x - before.x).toBeCloseTo(3, 9);
    expect(moved.y - before.y).toBeCloseTo(0, 9);
    expect(labelOffsetDelta(label({ offset: { x: 0, y: 0 } }), index, 3, 1)).toEqual({ dx: 3, dy: 1 });
  });

  it('hit-tests the rotated label text, not its unrotated box', () => {
    const index = buildLabelIndex(rotatedMap(90), []);
    // 'Hello' 16 pt → 21.33 px tall, ~8 studs wide; on a 90° brick it runs downward from (12, 22).
    const l = label({ id: 'x', kind: 1, targetId: 'b', offset: { x: 2, y: -2 } });
    const shape = labelShapeStuds(l, index);
    expect(shape[0]!.x).toBeCloseTo(12, 9);
    const map = rotatedMap(90);
    expect(annotationsInMarquee({ x0: 10, y0: 27, x1: 11.5, y1: 29 }, map, [l], [], 1).labels).toEqual(['x']);
    expect(annotationsInMarquee({ x0: 15, y0: 21, x1: 19, y1: 23 }, map, [l], [], 1).labels).toEqual([]);
  });

  it('skips labels whose anchor brick moves with the selection', () => {
    const { doc, brick } = seed();
    const index = buildLabelIndex(docToBbm(doc), []);
    expect(labelsToOffset(['world', 'onBrick'], labels(doc), index, new Set([brick]))).toEqual(['world']);
    expect(labelsToOffset(['world', 'onBrick'], labels(doc), index, new Set())).toEqual(['world', 'onBrick']);
  });
});

describe('label fonts (points, desktop default)', () => {
  it('converts points to scene px the way QFont(family, int(pt)) lays out at 96 dpi', () => {
    expect(labelFontPx(8.25)).toBeCloseTo((8 * 96) / 72, 9);
    expect(labelFontPx(12)).toBe(16);
  });

  it('draws a size out of range at the nearest end, as the desktop reads it (1 to 500 pt)', () => {
    expect(labelFontPx(1e9)).toBe((500 * 96) / 72);
    expect(labelFontPx(501.5)).toBe((500 * 96) / 72);
    expect(labelFontPx(0.5)).toBe(96 / 72);
    expect(labelFontPx(-40)).toBe(96 / 72);
    // Not a number: the default, 8.25 pt.
    expect(labelFontPx(Number.NaN)).toBeCloseTo((8 * 96) / 72, 9);
    expect(labelFontPx(Number.POSITIVE_INFINITY)).toBeCloseTo((8 * 96) / 72, 9);
    expect(labelFontPx('big' as unknown as number)).toBeCloseTo((8 * 96) / 72, 9);
  });

  it('defaults to 8.25 pt Microsoft Sans Serif, drawn in the bundled map font', () => {
    expect(DEFAULT_LABEL_FONT).toEqual({ family: 'Microsoft Sans Serif', size: 8.25, style: 'Regular' });
    for (const f of ['Microsoft Sans Serif', '', 'Comic "Sans'])
      expect(labelFontFamily(f)).toBe('"BLD Map Sans", "Liberation Sans", Arial, sans-serif');
  });

  it('writes C# FontStyle strings', () => {
    expect(labelFontStyle(false, false)).toBe('Regular');
    expect(labelFontStyle(true, false)).toBe('Bold');
    expect(labelFontStyle(true, true)).toBe('Bold, Italic');
  });
});

describe('annotationsInMarquee', () => {
  it('collects rulers, labels and text cells touched by the band', () => {
    const { doc, ruler, textLayer } = seed();
    const map = docToBbm(doc);
    const all = annotationsInMarquee({ x0: -10, y0: -10, x1: 100, y1: 20 }, map, labels(doc), [], 1);
    expect(all.rulers).toEqual([ruler]);
    expect(all.texts).toEqual([textKey(textLayer, 0), textKey(textLayer, 1)]);
    expect(all.labels.sort()).toEqual(['onBrick', 'world']);
    // Only the first text cell.
    const some = annotationsInMarquee({ x0: 45, y0: 0, x1: 53, y1: 8 }, map, labels(doc), [], 1);
    expect(some).toEqual({ rulers: [], labels: [], texts: [textKey(textLayer, 0)] });
  });

  it('ignores labels hidden by minZoom', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    addAnchoredLabel(doc, label({ id: 'far', minZoom: 2, offset: { x: 5, y: 5 } }));
    const hit = annotationsInMarquee({ x0: 0, y0: 0, x1: 10, y1: 10 }, docToBbm(doc), labels(doc), [], 1);
    expect(hit.labels).toEqual([]);
  });
});

describe('translateMixedSelection', () => {
  it('moves bricks, rulers, labels and text (like BlueBrick) in one undo step', () => {
    const { doc, brick, ruler, textLayer } = seed();
    const um = createUndoManager(doc);
    const map = docToBbm(doc);
    translateMixedSelection(doc, map, labels(doc), [], {
      bricks: [brick],
      anno: { rulers: [ruler], labels: ['world', 'onBrick'], texts: [textKey(textLayer, 0)] },
      dx: 2,
      dy: 3,
    });
    const after = docToBbm(doc);
    const b = after.layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []))[0]!;
    expect(b.displayArea.x).toBe(2);
    expect(b.displayArea.y).toBe(3);
    const r = after.layers.flatMap((l) => (l.type === 'ruler' ? l.rulerItems : []))[0]!;
    expect(r.kind === 'linear' && r.point1).toEqual({ x: 22, y: 3 });
    const ls = labels(doc);
    expect(ls.find((l) => l.id === 'world')!.offset).toEqual({ x: 72, y: 3 });
    // Anchored to a moving brick → follows it, offset unchanged.
    expect(ls.find((l) => l.id === 'onBrick')!.offset).toEqual({ x: 1, y: 1 });
    const t = after.layers.find((l) => l.type === 'text');
    expect(t?.type === 'text' && t.textCells[0]!.displayArea.x).toBe(50);
    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(labels(doc).find((l) => l.id === 'world')!.offset).toEqual({ x: 70, y: 0 });
  });

  it('applies a separate brick delta (grid snap) and honours movedBricks', () => {
    const { doc, brick } = seed();
    translateMixedSelection(doc, docToBbm(doc), labels(doc), [], {
      bricks: [brick],
      anno: { ...NONE, labels: ['world'] },
      dx: 1.3,
      dy: 0,
      brickDx: 1,
      brickDy: 0,
    });
    const b = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []))[0]!;
    expect(b.displayArea.x).toBe(1);
    expect(labels(doc).find((l) => l.id === 'world')!.offset.x).toBeCloseTo(71.3);

    translateMixedSelection(doc, docToBbm(doc), labels(doc), [], {
      bricks: [],
      anno: { ...NONE, labels: ['onBrick'] },
      dx: 5,
      dy: 5,
      movedBricks: [brick],
    });
    expect(labels(doc).find((l) => l.id === 'onBrick')!.offset).toEqual({ x: 1, y: 1 });
  });
});

describe('deleteMixedSelection', () => {
  it('deletes bricks, rulers, labels and text cells in one undo step', () => {
    const { doc, brick, ruler, textLayer } = seed();
    const um = createUndoManager(doc);
    deleteMixedSelection(doc, docToBbm(doc), [brick], {
      rulers: [ruler],
      labels: ['world'],
      texts: [textKey(textLayer, 0), textKey(textLayer, 1)],
    });
    const after = docToBbm(doc);
    expect(after.layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []))).toHaveLength(0);
    expect(after.layers.flatMap((l) => (l.type === 'ruler' ? l.rulerItems : []))).toHaveLength(0);
    expect(after.layers.flatMap((l) => (l.type === 'text' ? l.textCells : []))).toHaveLength(0);
    expect(labels(doc).map((l) => l.id)).toEqual(['onBrick']);
    expect(um.undoStack.length).toBe(1);
  });

  it('deletes the right text cells when several share a layer', () => {
    const { doc, textLayer } = seed();
    deleteMixedSelection(doc, docToBbm(doc), [], { ...NONE, texts: [textKey(textLayer, 0)] });
    const t = docToBbm(doc).layers.find((l) => l.type === 'text');
    expect(t?.type === 'text' && t.textCells.map((c) => c.text)).toEqual(['U']);
  });
});

describe('setActiveConnectionPoint (grab anchor)', () => {
  it('persists the index without adding an undo step', () => {
    const { doc, brick, brickLayer } = seed();
    const um = createUndoManager(doc);
    setActiveConnectionPoint(doc, brickLayer, brick, 2);
    const b = docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []))[0]!;
    expect(b.activeConnectionPointIndex).toBe(2);
    expect(um.undoStack.length).toBe(0);
  });
});
