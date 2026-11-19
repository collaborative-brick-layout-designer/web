// The import dialog: upload, wait, the preview's choices (the desktop's),
// the result with a way to fix what's missing, and Cancel at every step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ImportJob } from '../importApi';

const m = vi.hoisted(() => ({ upload: vi.fn(), job: vi.fn(), convert: vi.fn(), cancel: vi.fn() }));
vi.mock('../importApi', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../importApi')>();
  return { ...orig, uploadModel: m.upload, importApi: { ...orig.importApi, job: m.job, convert: m.convert, cancel: m.cancel } };
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
});
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
    const { onDone } = setup({ isAdmin: true, into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }], at: { x: 0, y: 0 } } });
    const link = await screen.findByRole('link', { name: 'Admin › Model import' });
    expect(link.getAttribute('href')).toBe('/admin?tab=imports');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ brickIds: ['a', 'b'] }));
  });

  it('an LDraw layout can have its parts placed one by one, into this layout on the sheet picked', async () => {
    setup({ into: { layoutId: 'L1', sheets: [{ id: 's1', name: 'Track' }, { id: 's2', name: 'Town' }], at: { x: 10, y: 20 } } });
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByLabelText(/Its parts, one by one/));
    expect(screen.getByTestId('import-layout-summary').textContent).toContain('2 parts on 1 sheet');
    fireEvent.change(screen.getByLabelText('Sheet'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place the parts' }));
    await waitFor(() => expect(m.convert).toHaveBeenCalled());
    expect(m.convert.mock.calls[0]![1]).toMatchObject({ mode: 'parts', target: { kind: 'layout', layoutId: 'L1', sheetId: 's2', at: { x: 10, y: 20 } } });
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
