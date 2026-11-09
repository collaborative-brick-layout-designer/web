// Text cells written by the web editor must stay projectable: the doc
// projection reads cells as Y.Maps, and a plain object used to make
// docToBbm throw (the editor then rendered an empty canvas).

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToBbm } from '@cld/ydoc';
import { addTextCell, deleteTextCell, editTextCell, editTextCellFull, ensureBrickLayer, ensureTextLayer } from '../mutations';

const spec = {
  centreX: 10, centreY: 10, widthStuds: 8, heightStuds: 4, text: 'Hello',
  font: { family: 'Arial', size: 12, style: 'Regular' },
  fontColor: { kind: 'known' as const, name: 'Black' },
};

function cells(doc: Y.Doc) {
  const layer = docToBbm(doc).layers.find((l) => l.type === 'text');
  return layer && layer.type === 'text' ? layer.textCells : [];
}

describe('text cells round-trip through the projection', () => {
  it('add / edit / delete keep the doc projectable', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc); // seeds the map meta
    const l = ensureTextLayer(doc);
    addTextCell(doc, l, spec);
    expect(cells(doc).map((c) => c.text)).toEqual(['Hello']);
    editTextCell(doc, l, 0, 'Hi');
    editTextCellFull(doc, l, 0, { orientation: 90 });
    // New words re-fit the box about the same middle; turning alone keeps it.
    const area = cells(doc)[0]!.displayArea;
    expect(cells(doc)[0]).toMatchObject({ text: 'Hi', orientation: 90 });
    expect(area.x + area.width / 2).toBeCloseTo(10);
    expect(area.y + area.height / 2).toBeCloseTo(10);
    deleteTextCell(doc, l, 0);
    expect(cells(doc)).toEqual([]);
  });

  it('reads and upgrades legacy plain-object cells', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc); // seeds the map meta
    const l = ensureTextLayer(doc);
    const yCells = (doc.getMap('layerData').get(l) as Y.Map<unknown>).get('textCells') as Y.Array<unknown>;
    yCells.push([{
      displayArea: { x: 0, y: 0, width: 4, height: 2 }, myGroup: '', text: 'old', orientation: 0,
      fontColor: { kind: 'known', name: 'Black' }, font: spec.font, textAlignment: 'Center',
    }]);
    expect(cells(doc)[0]!.text).toBe('old');
    editTextCell(doc, l, 0, 'new');
    expect(yCells.get(0)).toBeInstanceOf(Y.Map);
    expect(cells(doc)[0]!.text).toBe('new');
    expect((yCells.get(0) as Y.Map<unknown>).get('id')).toMatch(/^\d+$/);
  });
});

describe('text cell ids', () => {
  function yCell(doc: Y.Doc, l: string, i: number): Y.Map<unknown> {
    const yCells = (doc.getMap('layerData').get(l) as Y.Map<unknown>).get('textCells') as Y.Array<unknown>;
    return yCells.get(i) as Y.Map<unknown>;
  }

  it('new cells get a distinct stable id that survives edits', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    const l = ensureTextLayer(doc);
    addTextCell(doc, l, spec);
    addTextCell(doc, l, spec);
    const a = yCell(doc, l, 0).get('id');
    expect(a).toMatch(/^\d+$/);
    expect(yCell(doc, l, 1).get('id')).not.toBe(a);
    editTextCellFull(doc, l, 0, { text: 'x', orientation: 45 });
    expect(yCell(doc, l, 0).get('id')).toBe(a);
    // Minted ids are sync-only: they never leak into the .bbm export.
    expect(cells(doc)[0]).not.toHaveProperty('id');
  });

  it('an id-less Y.Map cell from an old doc gets an id on first edit', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    const l = ensureTextLayer(doc);
    addTextCell(doc, l, spec);
    yCell(doc, l, 0).delete('id');
    expect(cells(doc)[0]!.text).toBe('Hello');
    editTextCell(doc, l, 0, 'edited');
    expect(yCell(doc, l, 0).get('id')).toMatch(/^\d+$/);
  });
});

describe('new text: the box follows the Size', () => {
  it('is measured at the size in points (a point is 4/3 of a stud), plus a sixth of the size each side', async () => {
    const { newTextBox } = await import('../mutations');
    const w = (line: string, px: number) => line.length * 0.5 * px;
    // 18 pt = 24 studs a line: "Nikki" 5 × 12 + 8 = 68 wide, 27.6 high.
    expect(newTextBox('Nikki', 18, w)).toEqual({ width: 68, height: 27.598 });
    // Twice the size: twice the box.
    const a = newTextBox('Station yard', 12, w);
    const b = newTextBox('Station yard', 24, w);
    expect(b.width).toBeCloseTo(a.width * 2, 2);
    expect(b.height).toBeCloseTo(a.height * 2, 2);
    // Two lines: twice as high, as wide as the widest.
    const two = newTextBox('City\nGardens', 12, w);
    expect(two.height).toBeCloseTo(newTextBox('Gardens', 12, w).height * 2, 2);
    expect(two.width).toBe(newTextBox('Gardens', 12, w).width);
  });

  it('big text draws bigger than small text (Size is no longer ignored)', async () => {
    const { newTextBox } = await import('../mutations');
    const { textCellLayout } = await import('../render/mapText');
    const w = (line: string, px: number) => line.length * 0.6 * px;
    const at = (text: string, pt: number) => {
      const box = newTextBox(text, pt, w);
      return textCellLayout({ text, displayArea: { x: 0, y: 0, ...box }, orientation: 0, textAlignment: 'Center' }, w).fontPx;
    };
    expect(at('Two\nlines', 60)).toBeGreaterThan(at('Two\nlines', 12) * 4);
    expect(at('Two\nlines', 60)).toBeGreaterThan(at('one line', 12));
  });

  it('a new size re-fits an existing box about its middle; a quarter turn keeps it swapped', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    const l = ensureTextLayer(doc);
    addTextCell(doc, l, { ...spec, orientation: 90 });
    const before = cells(doc)[0]!.displayArea;
    editTextCellFull(doc, l, 0, { font: { family: 'Arial', size: 36, style: 'Regular' } }, (line, px) => line.length * 0.5 * px);
    const after = cells(doc)[0]!.displayArea;
    expect(after.height).toBeGreaterThan(after.width);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2);
  });

  it('goes on the first text layer, or a new one named Labels', async () => {
    const { addLayer } = await import('../mutations');
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    const created = ensureTextLayer(doc);
    expect(docToBbm(doc).layers.find((x) => x.id === created)?.name).toBe('Labels');
    addLayer(doc, 'text');
    expect(ensureTextLayer(doc)).toBe(created);
  });

  it('the text dialog starts at Arial 12 pt', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { TextDialog } = await import('../TextDialog');
    render(<TextDialog onClose={() => {}} onCommit={() => {}} />);
    expect(screen.getAllByRole('spinbutton').map((i) => (i as HTMLInputElement).value)).toContain('12');
    cleanup();
  });
});
