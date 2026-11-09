// Component tests for the desktop-parity dialog changes: anchored-label
// placement defaults and color round-trip, Find & Replace buttons, the
// Budget dialog writing to the doc, and the Export Image options.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as Y from 'yjs';
import type { AnchoredLabel } from '@cld/bbm';
import { createDefaultLayoutDoc, docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import { AddAnchoredLabelDialog } from '../AddAnchoredLabelDialog';
import { FindDialog } from '../FindDialog';
import { BudgetDialog } from '../BudgetDialog';
import { ExportImageDialog, type ExportHandle } from '../ExportImageDialog';
import { addAnchoredLabel, addTextCell, ensureTextLayer, placeBrick, readBudgetLimits, setBudgetLimits } from '../mutations';
import { useEditorStore } from '../editorStore';
import { hitsSelection } from '../findReplace';
import { textKey } from '../mixedSelection';
import { createUndoManager } from '../useUndoManager';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PartWire } from '../../api';
import { autoConfirm } from '../../test/confirmHost';

/** The library Find checks replacements against: 3001 in two colors, 3710, and a straight track. */
const FIND_PARTS = [
  { key: '3001.1', partNumber: '3001', colorCode: '1', description: 'Brick 2 x 4' },
  { key: '3001.5', partNumber: '3001', colorCode: '5', description: 'Brick 2 x 4' },
  { key: '3001.7', partNumber: '3001', colorCode: '7', description: 'Brick 2 x 4' },
  { key: '3710.1', partNumber: '3710', colorCode: '1', description: 'Plate 1 x 4' },
  { key: '2865.8', partNumber: '2865', colorCode: '8', description: '9V Straight Track' },
].map((p) => ({ ...p, spritePath: '', source: 'bundled' }) as unknown as PartWire);

function findDialog(doc: Y.Doc) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['parts-catalog'], { parts: FIND_PARTS });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <FindDialog map={docToBbm(doc)} doc={doc} onClose={() => {}} />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { ...r, rerender: () => r.rerender(ui()) };
}

afterEach(cleanup);

function brickLayerId(doc: Y.Doc): string {
  return docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
}

function labels(doc: Y.Doc): AnchoredLabel[] {
  return readSidecarFromDoc(doc)?.anchoredLabels ?? [];
}

function numberInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
}

const KNOWN_RED: AnchoredLabel = {
  id: '77',
  text: 'Depot',
  font: { family: 'Arial', size: 12, style: 'Regular' },
  color: { known: true, argb: 0xffff0000, name: 'Red' },
  kind: 0,
  targetId: '',
  offset: { x: 5, y: 6 },
  rot: 0,
  minZoom: 0,
};

describe('AddAnchoredLabelDialog', () => {
  it('places a new World label at the view centre', () => {
    const doc = createDefaultLayoutDoc();
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} viewCentre={{ x: 12.345, y: -7.891 }} onClose={() => {}} />);
    // Number inputs: size, offset X, offset Y, rotation, min zoom.
    expect(numberInputs()[1]!.value).toBe('12.35');
    expect(numberInputs()[2]!.value).toBe('-7.89');
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Centre' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Label' }));
    const [l] = labels(doc);
    expect(l).toMatchObject({ text: 'Centre', kind: 0, offset: { x: 12.35, y: -7.89 } });
    // Crypto makeId: a decimal ulong, not a Date.now() string.
    expect(l!.id).toMatch(/^[1-9]\d*$/);
    expect(BigInt(l!.id)).toBeLessThan(2n ** 63n);
  });

  it('defaults a brick-anchored label to offset (2, -2) and switches with the anchor', () => {
    const doc = createDefaultLayoutDoc();
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId="123" viewCentre={{ x: 40, y: 30 }} onClose={() => {}} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect([numberInputs()[1]!.value, numberInputs()[2]!.value]).toEqual(['2', '-2']);
    fireEvent.change(select, { target: { value: '0' } });
    expect([numberInputs()[1]!.value, numberInputs()[2]!.value]).toEqual(['40', '30']);
    fireEvent.change(select, { target: { value: '1' } });
    expect([numberInputs()[1]!.value, numberInputs()[2]!.value]).toEqual(['2', '-2']);
  });

  it('edit mode shows a known color and keeps it on save (no FF000000 rewrite)', () => {
    const doc = createDefaultLayoutDoc();
    addAnchoredLabel(doc, KNOWN_RED);
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} initialLabel={KNOWN_RED} onClose={() => {}} />);
    const color = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(color.value).toBe('#ff0000');
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Depot 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const [l] = labels(doc);
    expect(l!.id).toBe('77');
    expect(l!.text).toBe('Depot 2');
    expect(l!.color).toEqual({ known: true, argb: 0xffff0000, name: 'Red' });
  });

  it('edit mode writes a newly picked color as ARGB', () => {
    const doc = createDefaultLayoutDoc();
    addAnchoredLabel(doc, KNOWN_RED);
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} initialLabel={KNOWN_RED} onClose={() => {}} />);
    fireEvent.change(document.querySelector('input[type="color"]')!, { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(labels(doc)[0]!.color).toEqual({ known: false, argb: 0xff00ff00, name: '' });
  });
});

describe('AddAnchoredLabelDialog — desktop font and kinds', () => {
  it('saves 8.25 pt Microsoft Sans Serif, Regular, by default (no font box to fill in), and accepts fractional points', () => {
    const doc = createDefaultLayoutDoc();
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} viewCentre={{ x: 0, y: 0 }} onClose={() => {}} />);
    expect(screen.queryByText(/Microsoft Sans Serif|Font family/)).toBeNull();
    expect(numberInputs()[0]!.value).toBe('8.25');
    fireEvent.change(numberInputs()[0]!, { target: { value: '10.5' } });
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Pt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Label' }));
    expect(labels(doc)[0]!.font).toEqual({ family: 'Microsoft Sans Serif', size: 10.5, style: 'Regular' });
  });

  it('asks in plain words: where it sits, and the zoom it shows from as a percentage', () => {
    const doc = createDefaultLayoutDoc();
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} viewCentre={{ x: 0, y: 0 }} onClose={() => {}} />);
    expect(screen.getByLabelText('Where it sits')).toBeTruthy();
    expect(screen.queryByText(/World|Min zoom|Offset/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Far' } });
    fireEvent.change(screen.getByLabelText('Show from zoom (%)'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Label' }));
    expect(labels(doc)[0]!.minZoom).toBe(0.5);
  });

  it('editing a Group label keeps its kind and target', () => {
    const doc = createDefaultLayoutDoc();
    const group: AnchoredLabel = { ...KNOWN_RED, id: '88', kind: 2, targetId: 'grp' };
    addAnchoredLabel(doc, group);
    render(<AddAnchoredLabelDialog doc={doc} defaultTargetId={null} initialLabel={group} onClose={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bold' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Italic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(labels(doc)[0]).toMatchObject({ kind: 2, targetId: 'grp', font: { style: 'Bold, Italic' } });
  });
});

describe('FindDialog', () => {
  function seeded(): Y.Doc {
    const doc = createDefaultLayoutDoc();
    const lid = brickLayerId(doc);
    placeBrick(doc, lid, { partNumber: '3001.1', x: 0, y: 0, width: 4, height: 2 });
    placeBrick(doc, lid, { partNumber: '3001.1', x: 10, y: 0, width: 4, height: 2 });
    placeBrick(doc, lid, { partNumber: '3001.1', x: 20, y: 0, width: 4, height: 2 });
    return doc;
  }
  const parts = (doc: Y.Doc) =>
    docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks.map((b) => b.partNumber) : []));

  it('Replace changes only the current match; clicking a result makes it current', async () => {
    const doc = seeded();
    const { rerender } = findDialog(doc);
    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'part' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '3001.1' } });
    fireEvent.change(screen.getByPlaceholderText('The new part’s number…'), { target: { value: '3001.5' } });
    const results = screen.getAllByRole('listitem');
    expect(results).toHaveLength(3);
    fireEvent.click(results[2]!.querySelector('button')!);
    expect(results[2]!.querySelector('button')!.getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await vi.waitFor(() => expect(parts(doc)).toEqual(['3001.1', '3001.1', '3001.5']));
    rerender();
    expect(screen.getByText('2 matches')).toBeTruthy();
  });

  it('Replace all rewrites every match in one undo step', async () => {
    const doc = seeded();
    const um = createUndoManager(doc);
    findDialog(doc);
    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'part' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '.1' } });
    fireEvent.change(screen.getByPlaceholderText('The new part’s number…'), { target: { value: '.7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    await vi.waitFor(() => expect(parts(doc)).toEqual(['3001.7', '3001.7', '3001.7']));
    um.undo();
    expect(parts(doc)).toEqual(['3001.1', '3001.1', '3001.1']);
  });
});

describe('FindDialog — modeless, live selection', () => {
  function withText(): Y.Doc {
    const doc = createDefaultLayoutDoc();
    const lid = brickLayerId(doc);
    placeBrick(doc, lid, { partNumber: '3001.1', x: 0, y: 0, width: 4, height: 2 });
    placeBrick(doc, lid, { partNumber: '3001.1', x: 10, y: 0, width: 4, height: 2 });
    placeBrick(doc, lid, { partNumber: '3710.1', x: 20, y: 0, width: 4, height: 2 });
    const t = ensureTextLayer(doc);
    for (const text of ['Station', 'Depot', 'Station 2']) {
      addTextCell(doc, t, {
        centreX: 0, centreY: 0, widthStuds: 4, heightStuds: 2, text,
        font: { family: 'Arial', size: 10, style: 'Regular' }, fontColor: { kind: 'known', name: 'Black' },
      });
    }
    return doc;
  }
  const bricksOf = (doc: Y.Doc, part: string) =>
    docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks.filter((b) => b.partNumber === part).map((b) => b.id) : []));

  afterEach(() => {
    vi.useRealTimers();
    useEditorStore.setState({ selection: [], annoSelection: { rulers: [], labels: [], texts: [] } });
  });

  it('opens on parts, listed first, and finds a part by its name with its picture', () => {
    const doc = withText();
    findDialog(doc);
    const scope = screen.getByLabelText('Find in') as HTMLSelectElement;
    expect(scope.value).toBe('part');
    expect([...scope.options].map((o) => o.value)).toEqual(['part', 'text']);
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'plate' } });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Plate 1 x 4 (3710.1)')]);
  });

  it('asks before replacing with a part the library doesn’t have, and says "texts" for text', async () => {
    const doc = withText();
    findDialog(doc);
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '3001.1' } });
    fireEvent.change(screen.getByPlaceholderText('The new part’s number…'), { target: { value: '3001.99' } });
    const asked = autoConfirm(false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    await vi.waitFor(() => expect(asked.titles).toEqual(['“3001.99” isn’t a part in the library']));
    expect(bricksOf(doc, '3001.1')).toHaveLength(2);
    expect(bricksOf(doc, '3001.99')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'text' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Station' } });
    fireEvent.change(screen.getByPlaceholderText('New text…'), { target: { value: 'Halt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    await vi.waitFor(() => expect(useEditorStore.getState().notice?.text).toBe('Replaced 2 texts.'));
  });

  it('is not modal: no backdrop covers the canvas', () => {
    const doc = withText();
    findDialog(doc);
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('false');
    expect(dlg.className).not.toMatch(/inset-0/);
  });

  it('selects every match as you type, and clears the selection for an empty query', () => {
    vi.useFakeTimers();
    const doc = withText();
    findDialog(doc);
    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'part' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '3001' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(useEditorStore.getState().selection).toEqual(bricksOf(doc, '3001.1'));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(useEditorStore.getState().selection).toEqual([]);
  });

  it('a result clicked before the live selection fires keeps just that match selected (regression)', () => {
    vi.useFakeTimers();
    const doc = withText();
    findDialog(doc);
    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'part' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '3001' } });
    act(() => { vi.advanceTimersByTime(50); });
    fireEvent.click(screen.getAllByRole('listitem')[0]!.querySelector('button')!);
    act(() => { vi.advanceTimersByTime(250); });
    expect(useEditorStore.getState().selection).toEqual([bricksOf(doc, '3001.1')[0]]);
  });

  it('selects matching text cells live, and a clicked text result selects just it (regression)', () => {
    vi.useFakeTimers();
    const doc = withText();
    const textLayer = docToBbm(doc).layers.find((l) => l.type === 'text')!.id;
    findDialog(doc);
    fireEvent.change(screen.getByLabelText('Find in'), { target: { value: 'text' } });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'station' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(useEditorStore.getState().annoSelection.texts).toEqual([textKey(textLayer, 0), textKey(textLayer, 2)]);
    fireEvent.click(screen.getAllByRole('listitem')[1]!.querySelector('button')!);
    expect(useEditorStore.getState().annoSelection.texts).toEqual([textKey(textLayer, 2)]);
    expect(useEditorStore.getState().selection).toEqual([]);
  });

  it('hitsSelection splits bricks and text cells', () => {
    expect(hitsSelection([
      { layerId: 'L', brickId: 'b1', value: '', preview: '' },
      { layerId: 'T', textIndex: 3, value: '', preview: '' },
    ])).toEqual({ bricks: ['b1'], anno: { rulers: [], labels: [], texts: [textKey('T', 3)] } });
  });
});

describe('BudgetDialog', () => {
  it('writes an edited limit into the doc', async () => {
    const doc = createDefaultLayoutDoc();
    const lid = brickLayerId(doc);
    placeBrick(doc, lid, { partNumber: '3001.1', x: 0, y: 0, width: 4, height: 2 });
    render(
      <BudgetDialog
        map={docToBbm(doc)}
        limits={readBudgetLimits(doc)}
        onLimitsChange={(next) => setBudgetLimits(doc, next)}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('—'), { target: { value: '5' } });
    expect([...readBudgetLimits(doc)]).toEqual([['3001.1', 5]]);
  });
  it('opening a .bbb maps old part numbers to the part that replaced them (first entry wins)', async () => {
    const file = new File(
      ['<Budget><PartList><Part id="4186P01">3</Part><Part id="3001.1">2</Part><Part id="4186p01.2">9</Part></PartList></Budget>'],
      'old.bbb',
    );
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [file] });
      this.onchange?.(new Event('change'));
    });
    const onChange = vi.fn();
    render(
      <BudgetDialog
        map={null}
        limits={new Map()}
        onLimitsChange={onChange}
        resolvePart={(id) => (id.toLowerCase() === '4186p01' ? '4186P01.2' : id)}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Open/ }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect([...(onChange.mock.calls[0]![0] as Map<string, number>)]).toEqual([['4186P01.2', 3], ['3001.1', 2]]);
    click.mockRestore();
  });

  it('Import and Merge adds the file\'s limits to the current ones', async () => {
    const file = new File(['<Budget><PartList><Part id="3001.1">2</Part><Part id="3710.1">1</Part></PartList></Budget>'], 'more.bbb');
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [file] });
      this.onchange?.(new Event('change'));
    });
    const onChange = vi.fn();
    render(<BudgetDialog map={null} limits={new Map([['3001.1', 5]])} onLimitsChange={onChange} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import and Merge…' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect([...(onChange.mock.calls[0]![0] as Map<string, number>)]).toEqual([['3001.1', 7], ['3710.1', 1]]);
    click.mockRestore();
  });
});

describe('ExportImageDialog', () => {
  // The dialog remembers its settings (like desktop QSettings export/*);
  // start each test from a first-time export.
  afterEach(() => localStorage.removeItem('cld:exportImage'));

  function handle() {
    const canvas = document.createElement('canvas');
    // Encoded with toBlob (off the main thread), not toDataURL.
    canvas.toDataURL = vi.fn(() => 'data:,');
    canvas.toBlob = vi.fn((done: BlobCallback) => done(new Blob(['png']))) as unknown as HTMLCanvasElement['toBlob'];
    URL.createObjectURL ??= () => 'blob:x';
    URL.revokeObjectURL ??= () => undefined;
    const render = vi.fn(() => ({ canvas, pixelRatio: 1 }));
    const h: ExportHandle = { render, sceneSize: () => ({ width: 400, height: 100 }) };
    return { ref: { current: h }, render, canvas };
  }

  it('defaults to 2x the scene with the height tracking the width', () => {
    const { ref } = handle();
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    const w = screen.getByLabelText('Width (px)') as HTMLInputElement;
    const h = screen.getByLabelText('Height (px)') as HTMLInputElement;
    expect([w.value, h.value]).toEqual(['800', '200']);
    expect(h.disabled).toBe(true);
    fireEvent.change(w, { target: { value: '1000' } });
    expect(h.value).toBe('250');
    fireEvent.click(screen.getByRole('button', { name: '4×' }));
    expect(w.value).toBe('1600');
  });

  it('remembers the last export\'s settings for the next one (desktop QSettings export/*)', () => {
    const { ref } = handle();
    const first = render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Keep aspect ratio (height auto)'));
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '640' } });
    fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '480' } });
    fireEvent.change(screen.getByDisplayValue('PNG'), { target: { value: 'jpeg' } });
    fireEvent.change(screen.getByLabelText('JPEG quality'), { target: { value: '70' } });
    fireEvent.click(screen.getByLabelText('Antialias'));
    fireEvent.click(screen.getByRole('button', { name: 'Export JPEG' }));
    first.unmount();

    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    expect((screen.getByLabelText('Width (px)') as HTMLInputElement).value).toBe('640');
    expect((screen.getByLabelText('Height (px)') as HTMLInputElement).value).toBe('480');
    expect((screen.getByLabelText('Keep aspect ratio (height auto)') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('JPEG quality') as HTMLInputElement).value).toBe('70');
    expect((screen.getByLabelText('Antialias') as HTMLInputElement).checked).toBe(false);
  });

  it('ignores unreadable saved settings', async () => {
    const { loadExportSettings } = await import('../exportSettings');
    localStorage.setItem('cld:exportImage', '{nope');
    expect(loadExportSettings()).toBeNull();
    localStorage.setItem('cld:exportImage', JSON.stringify({ width: 'x', height: 10 }));
    expect(loadExportSettings()).toBeNull();
    localStorage.setItem('cld:exportImage', JSON.stringify({ width: 10, height: 10, quality: 500, format: 'gif' }));
    expect(loadExportSettings()).toMatchObject({ quality: 100, format: 'png', keepAspect: true, antialias: true });
  });

  it('exports JPEG at the chosen size and quality, without transparency or antialias', () => {
    const { ref, render: renderFn, canvas } = handle();
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Transparent background'));
    fireEvent.click(screen.getByLabelText('Keep aspect ratio (height auto)'));
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '640' } });
    fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '480' } });
    fireEvent.change(screen.getByDisplayValue('PNG'), { target: { value: 'jpeg' } });
    fireEvent.change(screen.getByLabelText('JPEG quality'), { target: { value: '70' } });
    fireEvent.click(screen.getByLabelText('Antialias'));
    fireEvent.click(screen.getByRole('button', { name: 'Export JPEG' }));
    expect(renderFn).toHaveBeenCalledWith({
      pixelRatio: 1,
      size: { width: 640, height: 480 },
      transparent: false,
      antialias: false,
      watermark: false,
    });
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.7);
    expect(canvas.toDataURL).not.toHaveBeenCalled();
  });

  it('exports a transparent PNG', () => {
    const { ref, render: renderFn, canvas } = handle();
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Transparent background'));
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(renderFn).toHaveBeenCalledWith({ pixelRatio: 1, size: { width: 800, height: 200 }, transparent: true, antialias: true, watermark: false });
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('the watermark is a per-export checkbox, remembered for next time', () => {
    useEditorStore.setState({ showExportWatermark: false });
    const { ref, render: renderFn } = handle();
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    const chk = screen.getByLabelText('Add the author, club and event in the corner') as HTMLInputElement;
    expect(chk.checked).toBe(false);
    fireEvent.click(chk);
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(renderFn).toHaveBeenCalledWith(expect.objectContaining({ watermark: true }));
    expect(useEditorStore.getState().showExportWatermark).toBe(true);
    useEditorStore.setState({ showExportWatermark: false });
  });

  it('prints at actual size: one render per A4 tile at dpi/25.4 px per scene px', () => {
    const { ref, render: renderFn } = handle();
    // 60 × 40 studs = 480 × 320 mm: 3 × 2 A4-portrait tiles of 190 × 277 mm.
    ref.current.region = () => ({ x: -10, y: -5, width: 60, height: 40 });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Print (1:1)' }));
    fireEvent.change(screen.getByDisplayValue('A3 (297 × 420 mm)'), { target: { value: 'a4' } });
    expect(screen.getByTestId('print-pages').textContent).toBe('3 × 2 = 6 page(s) at actual size (1 stud = 8 mm)');
    fireEvent.click(screen.getByRole('button', { name: 'Open Print Preview' }));
    expect(renderFn).toHaveBeenCalledTimes(6);
    expect(renderFn).toHaveBeenNthCalledWith(1, {
      pixelRatio: 150 / 25.4,
      transparent: false,
      regionStuds: { x: -10, y: -5, width: 190 / 8, height: 277 / 8 },
    });
    open.mockRestore();
  });

  it('prints from the opener, with no inline script the CSP would block', () => {
    const { ref } = handle();
    ref.current.region = () => ({ x: 0, y: 0, width: 10, height: 10 });
    let html = '';
    const print = vi.fn();
    const win = {
      document: { write: (s: string) => { html += s; }, close: vi.fn(), readyState: 'complete' },
      setTimeout: (fn: () => void) => { fn(); return 0; },
      print,
      addEventListener: vi.fn(),
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Print (1:1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Print Preview' }));
    expect(html).toContain('<img src=');
    expect(html).not.toMatch(/<script/i);
    expect(print).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('exports a single fitted A3 PDF page', () => {
    const { ref, render: renderFn, canvas } = handle();
    ref.current.region = () => ({ x: 0, y: 0, width: 100, height: 50 });
    canvas.width = 10;
    canvas.height = 5;
    canvas.toDataURL = vi.fn(() => 'data:image/jpeg;base64,/9j/2Q==');
    const created: Blob[] = [];
    const createUrl = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; });
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'PDF (A3)' }));
    expect(screen.getByText(/One A3 page \(landscape/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    // Landscape A3 paint area 396 × 273 mm; a 2:1 map fills the width.
    const call = (renderFn.mock.calls as unknown as [{ size: { width: number; height: number } }][])[0]![0];
    expect(call.size).toEqual({ width: Math.round((396 / 25.4) * 200), height: Math.round((198 / 25.4) * 200) });
    expect(created[0]!.type).toBe('application/pdf');
  });

  it('refuses a size beyond the canvas limit', () => {
    const { ref } = handle();
    render(<ExportImageDialog layoutTitle="t" exportImageRef={ref} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '99999' } });
    expect((screen.getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
