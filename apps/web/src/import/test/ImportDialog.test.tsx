// The import dialog: upload, wait, the preview's choices (the desktop's),
// the result with a way to fix what's missing, and Cancel at every step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement as h, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ImportJob } from '../importApi';

const m = vi.hoisted(() => ({ upload: vi.fn(), job: vi.fn(), convert: vi.fn(), cancel: vi.fn() }));
vi.mock('../importApi', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../importApi')>();
  return { ...orig, uploadModel: m.upload, importApi: { ...orig.importApi, job: m.job, convert: m.convert, cancel: m.cancel } };
});

const apiMock = vi.hoisted(() => ({ catalog: vi.fn(), me: vi.fn(), orgs: vi.fn() }));
vi.mock('../../api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../api')>();
  return {
    ...orig,
    api: { ...orig.api, me: apiMock.me, orgs: { ...orig.api.orgs, list: apiMock.orgs }, parts: { ...orig.api.parts, catalog: apiMock.catalog } },
  };
});

import { ImportDialog, siteWords } from '../ImportDialog';

const analysis = {
  format: 'ldraw' as const,
  kindLabel: 'LDraw import',
  title: 'Two straights',
  designer: 'Robin',
  suggestedName: 'Two straights',
  partKey: 'Two_straights',
  partError: null,
  part: {
    widthStuds: 8,
    heightStuds: 2,
    pxPerStud: 32,
    contentStuds: { x: 0, y: 0, width: 8, height: 2 },
    baseOnGrid: true,
    snapMargin: { left: 0, top: 0, right: 0, bottom: 0 },
    connections: [
      { type: '1', x: -4, y: 0, angle: 180 },
      { type: '1', x: 4, y: 0, angle: 0 },
    ],
    stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 1 },
    warnings: ['1 part(s) aren’t in your LDraw library, so they’re left out of the picture: 3001.'],
    preview: '/api/imports/j1/preview.png',
  },
  layout: { sheets: 1, bricks: 2, warnings: [], partlyRead: false },
  layoutError: null,
};

const job = (over: Partial<ImportJob>): ImportJob => ({ id: 'j1', fileName: 'loop.ldr', state: 'queued', step: 'analyse', position: 0, error: null, analysis: null, result: null, ...over });

function setup(props: Partial<Parameters<typeof ImportDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ImportDialog, { file: new File(['0 x'], 'loop.ldr'), onClose, onDone, ...props }))),
  );
  return { onClose, onDone };
}

beforeEach(() => {
  m.upload.mockReset().mockImplementation(async (_f: File, progress: (n: number) => void) => {
    progress(1);
    return job({ state: 'queued', position: 2 });
  });
  m.job.mockReset().mockResolvedValue(job({ state: 'ready', analysis }));
  m.convert.mockReset().mockResolvedValue(job({ state: 'converting', step: 'convert', analysis }));
  m.cancel.mockReset();
  apiMock.catalog.mockReset().mockResolvedValue({ parts: [] });
  apiMock.me.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  apiMock.orgs.mockReset().mockResolvedValue({ orgs: [{ id: 'o1', slug: 'train', name: 'Train Club', permissions: ['view_items', 'add_parts'] }] });
});

const partResult = {
  mode: 'part' as const,
  layoutId: null,
  newLayout: false,
  part: { id: 'p1', partNumber: 'Loop', displayName: 'Loop' },
  placed: 0,
  sheetId: null,
  brickIds: [],
  toPlace: null,
  stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 0 },
  warnings: [],
  widthStuds: 8,
  heightStuds: 2,
  connections: 2,
  sheets: null,
};
afterEach(cleanup);

describe('ImportDialog', () => {
  it('waits its turn, then shows the preview with the desktop’s choices and counts', async () => {
    setup();
    expect(await screen.findByText('Waiting for a turn (2 ahead of you in line)…')).toBeTruthy();
    expect(await screen.findByTestId('import-preview')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Import a model' }).textContent).toContain('Preview: LDraw import');
    expect(screen.getByTestId('import-size').textContent).toBe('8 × 2 studs, 2 connection points');
    expect(screen.getByTestId('import-stats').textContent).toContain('Parts missing:1');
    expect(screen.getByTestId('import-warnings').textContent).toContain('3001');
    expect((screen.getByLabelText('Save as') as HTMLInputElement).value).toBe('Two straights');
    expect((screen.getByLabelText('Designed by') as HTMLInputElement).value).toBe('Robin');
    // Turning swaps the footprint; unchecking drops a point.
    fireEvent.click(screen.getByRole('button', { name: 'Turn ⟳' }));
    expect(screen.getByTestId('import-size').textContent).toBe('2 × 8 studs, 2 connection points');
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getByTestId('import-size').textContent).toBe('2 × 8 studs, 1 connection point');
    fireEvent.change(screen.getByLabelText('Align to'), { target: { value: 'box' } });
    fireEvent.change(screen.getByLabelText('Move by'), { target: { value: '0.125' } });
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    fireEvent.change(screen.getByLabelText('Save as'), { target: { value: 'Loop' } });
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'example.com/robin' } });

    m.job.mockResolvedValue(
      job({
        state: 'done',
        step: 'convert',
        analysis,
        result: { mode: 'part', layoutId: 'L1', newLayout: true, part: { id: 'p1', partNumber: 'Loop', displayName: 'Loop' }, placed: 1, sheetId: 'brick-1', brickIds: ['b1'], stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 1 }, warnings: [], widthStuds: 2, heightStuds: 9, connections: 1, sheets: null },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Part' }));
    await waitFor(() => expect(m.convert).toHaveBeenCalled());
    expect(m.convert.mock.calls[0]![1]).toEqual({
      mode: 'part',
      quarterTurns: 1,
      align: 'box',
      nudge: [0.125, 0],
      drop: [0],
      name: 'Loop',
      designer: 'Robin',
      designerUrl: 'example.com/robin',
      category: 'Imported',
      target: { kind: 'new', title: 'Two straights' },
    });
    const summary = await screen.findByTestId('import-summary');
    expect(summary.textContent).toContain('Made the custom part “Loop” (2 × 9 studs, 1 connection point) and put it in a new layout.');
    // The misses, with where to fix them.
    expect(screen.getByTestId('import-misses').textContent).toContain('ask your site’s admin');
    expect(screen.getByTestId('import-open-layout').getAttribute('href')).toBe('/editor/L1');
  });

  it('an admin is sent to the libraries for the missing parts', async () => {
    m.job.mockResolvedValue(
      job({ state: 'done', step: 'convert', analysis, result: { mode: 'parts', layoutId: 'L1', newLayout: false, part: null, placed: 2, sheetId: 's1', brickIds: ['a', 'b'], stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 3 }, warnings: [], widthStuds: null, heightStuds: null, connections: null, sheets: 1 } }),
    );
    const { onDone } = setup({ isAdmin: true, into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }], at: { x: 0, y: 0 }, place: vi.fn(() => []) } });
    const link = await screen.findByRole('link', { name: 'Admin › Model import' });
    expect(link.getAttribute('href')).toBe('/admin?tab=imports');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ brickIds: ['a', 'b'] }));
  });

  it('an LDraw layout can have its parts placed one by one, into this layout on the sheet picked, by the editor itself', async () => {
    const place = vi.fn(() => ['n1', 'n2']);
    const { onDone } = setup({ into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }, { id: 's2', name: 'Town' }], at: { x: 10, y: 20 }, place } });
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByLabelText(/Its parts, one by one/));
    expect(screen.getByTestId('import-layout-summary').textContent).toContain('2 parts on 1 sheet');
    fireEvent.change(screen.getByLabelText('Sheet'), { target: { value: 's2' } });
    const toPlace = { bricks: [{ partNumber: '3001.8', displayArea: { x: 0, y: 0, width: 2, height: 4 } }, { partNumber: '3001.8', displayArea: { x: 4, y: 0, width: 2, height: 4 } }], groups: [] };
    m.job.mockResolvedValue(
      job({ state: 'done', step: 'convert', analysis, result: { ...partResult, mode: 'parts', part: null, layoutId: 'L1', sheetId: 's2', toPlace, widthStuds: null, heightStuds: null, connections: null, sheets: 1 } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Place the parts' }));
    await waitFor(() => expect(m.convert).toHaveBeenCalled());
    // The server only reads the parts: the editor puts them down, in its own undo.
    expect(m.convert.mock.calls[0]![1]).toMatchObject({ mode: 'parts', target: { kind: 'layout', layoutId: 'L1', sheetId: 's2', at: { x: 10, y: 20 }, clientPlaces: true } });
    const summary = await screen.findByTestId('import-summary');
    expect(place).toHaveBeenCalledWith('s2', toPlace);
    expect(summary.textContent).toContain('Placed 2 parts in this layout.');
    expect(screen.getByTestId('import-undo-hint').textContent).toContain('Edit › Undo takes the whole import back');
    // Done with it on the server.
    expect(m.cancel).toHaveBeenCalledWith('j1');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ placed: 2, brickIds: ['n1', 'n2'] }));
  });

  it('one custom part into this layout: saved by the server, put down by the editor once the catalog has it', async () => {
    const place = vi.fn(() => ['n1']);
    setup({ into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }], at: { x: 0, y: 0 }, place } });
    await screen.findByTestId('import-preview');
    m.job.mockResolvedValue(
      job({ state: 'done', step: 'convert', analysis, result: { ...partResult, layoutId: 'L1', sheetId: 's1', toPlace: { bricks: [{ partNumber: 'custom:p1', displayArea: { x: -4, y: -1, width: 8, height: 2 }, orientation: 0 }], groups: [] } } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Part' }));
    const summary = await screen.findByTestId('import-summary');
    expect(apiMock.catalog).toHaveBeenCalled();
    expect(place).toHaveBeenCalledWith('s1', expect.objectContaining({ bricks: [expect.objectContaining({ partNumber: 'custom:p1' })] }));
    expect(summary.textContent).toContain('and put it in the middle of your view.');
  });

  it('a layout with no parts sheet left says so, and the part stays saved', async () => {
    setup({ into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }], at: { x: 0, y: 0 }, place: vi.fn(() => []) } });
    await screen.findByTestId('import-preview');
    m.job.mockResolvedValue(job({ state: 'done', step: 'convert', analysis, result: { ...partResult, layoutId: 'L1', toPlace: { bricks: [{ partNumber: 'custom:p1', displayArea: { x: -4, y: -1, width: 8, height: 2 } }], groups: [] } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Part' }));
    expect((await screen.findByTestId('import-place-error')).textContent).toContain('no parts sheet');
    expect(screen.getByTestId('import-summary').textContent).toContain('saved it to your custom parts');
  });

  describe('a custom part from a model (Custom parts, the Parts panel)', () => {
    it('only makes the part, saved to the club picked: no layout, nothing placed', async () => {
      const { onDone } = setup({ purpose: 'part' });
      await screen.findByTestId('import-preview');
      // No choice of placing its parts, and no layout.
      expect(screen.queryByLabelText(/Its parts, one by one/)).toBeNull();
      expect(screen.queryByLabelText('A new layout')).toBeNull();
      const saveTo = (await screen.findByRole('combobox', { name: 'Save to' })) as HTMLSelectElement;
      fireEvent.change(saveTo, { target: { value: 'train' } });
      m.job.mockResolvedValue(job({ state: 'done', step: 'convert', analysis, result: partResult }));
      fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Part' }));
      await waitFor(() => expect(m.convert).toHaveBeenCalled());
      expect(m.convert.mock.calls[0]![1]).toMatchObject({ mode: 'part', target: { kind: 'library', orgSlug: 'train' } });
      const summary = await screen.findByTestId('import-summary');
      expect(summary.textContent).toContain('and saved it to Train Club’s custom parts.');
      expect(summary.textContent).toContain('It’s in your Parts panel and under Custom parts');
      expect(screen.queryByTestId('import-open-layout')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).toHaveBeenCalled();
    });

    it('from the editor: Save to my parts, or Save and place it here (the editor puts it down)', async () => {
      const place = vi.fn(() => ['n1']);
      setup({ purpose: 'part', into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }, { id: 's2', name: 'Town' }], at: { x: 0, y: 0 }, place } });
      await screen.findByTestId('import-preview');
      expect((screen.getByLabelText('Save to my parts') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole('button', { name: 'Save as Custom Part' })).toBeTruthy();
      fireEvent.click(screen.getByLabelText(/Save and place it here/));
      fireEvent.change(screen.getByLabelText('Sheet'), { target: { value: 's2' } });
      m.job.mockResolvedValue(job({ state: 'done', step: 'convert', analysis, result: partResult }));
      fireEvent.click(screen.getByRole('button', { name: 'Save and place it' }));
      await waitFor(() => expect(m.convert).toHaveBeenCalled());
      expect(m.convert.mock.calls[0]![1]).toMatchObject({ mode: 'part', target: { kind: 'library' } });
      await screen.findByTestId('import-summary');
      expect(place).toHaveBeenCalledWith('s2', { bricks: [{ partNumber: 'custom:p1', displayArea: { x: -4, y: -1, width: 8, height: 2 }, orientation: 0 }], groups: [] });
      expect(screen.getByTestId('import-summary').textContent).toContain('put it in the middle of your view');
    });
  });

  it('sends the file once, even with React’s development double effects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(h(StrictMode, null, h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ImportDialog, { file: new File(['0 x'], 'loop.ldr'), onClose: vi.fn() })))));
    await screen.findByTestId('import-preview');
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it('Cancel stops it and deletes the file on the server', async () => {
    const { onClose } = setup();
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByTestId('import-cancel'));
    expect(m.cancel).toHaveBeenCalledWith('j1');
    expect(onClose).toHaveBeenCalled();
  });

  it('says plainly when the server stops an import, and points to the desktop app', async () => {
    m.job.mockResolvedValue(job({ state: 'failed', error: { code: 'timeout', message: 'took longer' } }));
    setup();
    const err = await screen.findByTestId('import-error');
    expect(err.textContent).toContain('took too long to read');
    expect(screen.getByRole('link', { name: 'desktop app' })).toBeTruthy();
  });

  it('says why an upload was refused', async () => {
    m.upload.mockRejectedValue(new Error('This file is bigger than this site takes.'));
    setup();
    expect((await screen.findByTestId('import-error')).textContent).toContain('bigger than this site takes');
  });
});

describe('the importer’s words', () => {
  it('point to this site’s libraries, not the desktop’s settings', () => {
    expect(siteWords('A newer LDraw library, set in Settings › Bringing in models, may have them.')).toBe(
      'A newer LDraw library, set in this site’s libraries (Admin › Model import), may have them.',
    );
  });
});
