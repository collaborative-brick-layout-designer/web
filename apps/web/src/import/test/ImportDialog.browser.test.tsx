// The import dialog with the browser's own importer (browserImport.ts): no
// upload, real progress, the part made here and saved through
// POST /api/imports/client, Cancel that ends the worker, and the server
// taking over (with a line saying so) when the browser can't.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ImportAnalysis, ImportJob } from '../importApi';

const m = vi.hoisted(() => ({ upload: vi.fn(), job: vi.fn(), status: vi.fn(), client: vi.fn(), cancel: vi.fn() }));
vi.mock('../importApi', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../importApi')>();
  return { ...orig, uploadModel: m.upload, importApi: { ...orig.importApi, job: m.job, status: m.status, client: m.client, cancel: m.cancel } };
});

const apiMock = vi.hoisted(() => ({ catalog: vi.fn(), me: vi.fn(), orgs: vi.fn() }));
vi.mock('../../api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../api')>();
  return { ...orig, api: { ...orig.api, me: apiMock.me, orgs: { ...orig.api.orgs, list: apiMock.orgs }, parts: { ...orig.api.parts, catalog: apiMock.catalog } } };
});

// The worker stand-in: each test says how analysing and making go.
const w = vi.hoisted(() => ({
  analyse: vi.fn(),
  makePart: vi.fn(),
  makeLayout: vi.fn(),
  cancel: vi.fn(),
  progress: null as null | ((p: { phase: string; done?: number; total?: number }) => void),
}));
vi.mock('../browserImport', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../browserImport')>();
  class BrowserImport {
    constructor(onProgress: (p: { phase: string; done?: number; total?: number }) => void) {
      w.progress = onProgress;
    }
    analyse = w.analyse;
    makePart = w.makePart;
    makeLayout = w.makeLayout;
    cancel = w.cancel;
  }
  // jsdom has neither workers nor off-screen canvases: only the status counts here.
  const canImportInBrowser = (name: string, s: { browser?: { available: boolean; extensions: string[] } } | null | undefined) =>
    !!s?.browser?.available && s.browser.extensions.includes(name.split('.').pop()!.toLowerCase());
  return { ...orig, BrowserImport, canImportInBrowser };
});

import { FallBack } from '../browserImport';
import { ImportDialog } from '../ImportDialog';

const analysis: ImportAnalysis = {
  format: 'ldraw',
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
    stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 0 },
    warnings: [],
    preview: 'blob:preview',
  },
  layout: { sheets: 1, bricks: 2, warnings: [], partlyRead: false },
  layoutError: null,
};

const status = (over: object = {}) => ({
  available: true,
  reason: null,
  message: null,
  extensions: ['ldr', 'mpd', 'dat', 'io', 'lxf', 'lxfml'],
  maxUploadBytes: 64 * 1024 * 1024,
  perHour: 30,
  libraries: { ldraw: true, ldd: false, lddMapping: false, studio: false },
  browser: { available: true, extensions: ['ldr', 'mpd', 'dat'], ldraw: '0123456789abcdef', studio: null },
  ...over,
});

const serverJob = (over: Partial<ImportJob>): ImportJob => ({ id: 's1', fileName: 'loop.ldr', state: 'queued', step: 'analyse', position: 0, error: null, analysis: null, result: null, ...over });

function setup(name = 'loop.ldr') {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ImportDialog, { file: new File(['0 x'], name), onClose, onDone }))));
  return { onClose, onDone };
}

beforeEach(() => {
  for (const f of [m.upload, m.job, m.status, m.client, m.cancel, w.analyse, w.makePart, w.makeLayout, w.cancel]) f.mockReset();
  m.status.mockResolvedValue(status());
  m.upload.mockResolvedValue(serverJob({}));
  m.job.mockResolvedValue(serverJob({ state: 'ready', analysis }));
  apiMock.catalog.mockReset().mockResolvedValue({
    parts: [
      { key: 'a', source: 'bundled' },
      { key: 'b', source: 'custom' },
    ],
  });
  apiMock.me.mockReset().mockResolvedValue({ user: { id: 'u1', displayName: 'Sam' } });
  apiMock.orgs.mockReset().mockResolvedValue({ orgs: [] });
});
afterEach(cleanup);

describe('ImportDialog in the browser', () => {
  it('reads and draws an LDraw file here, with real progress, and never uploads it', async () => {
    let finish: (a: ImportAnalysis) => void = () => {};
    w.analyse.mockImplementation(() => new Promise((r) => (finish = r)));
    setup();
    await waitFor(() => expect(w.analyse).toHaveBeenCalled());
    // The site's own parts only, as the converter has them.
    expect(w.analyse.mock.calls[0]![1]).toEqual({ ldraw: '0123456789abcdef', studio: null, ldd: null, lddMapping: null });
    expect(w.analyse.mock.calls[0]![2]).toEqual([{ key: 'a', source: 'bundled' }]);
    act(() => w.progress!({ phase: 'fetching', done: 120, total: 213 }));
    expect(screen.getByTestId('import-reading-here').textContent).toContain('Fetching 213 parts… 120/213');
    act(() => w.progress!({ phase: 'drawing' }));
    expect(screen.getByTestId('import-reading-here').textContent).toContain('Drawing…');
    await act(async () => finish(analysis));
    expect(await screen.findByTestId('import-preview')).toBeTruthy();
    expect(screen.getByTestId('import-size').textContent).toBe('8 × 2 studs, 2 connection points');
    expect(m.upload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('import-fell-back')).toBeNull();
  });

  it('makes the part here and saves it through the site, as a job’s result', async () => {
    w.analyse.mockResolvedValue(analysis);
    w.makePart.mockResolvedValue({ type: 'made-part', partKey: 'Loop', displayName: 'Loop', xml: '<part/>', png: new Blob([new Uint8Array([1, 2, 3])]), widthStuds: 2, heightStuds: 8, connections: 1 });
    m.client.mockResolvedValue({ mode: 'part', layoutId: 'L1', newLayout: true, part: { id: 'p1', partNumber: 'Loop', displayName: 'Loop' }, placed: 1, sheetId: 's', brickIds: ['b1'], stats: analysis.part!.stats, warnings: [], widthStuds: 2, heightStuds: 8, connections: 1, sheets: null });
    setup();
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Turn ⟳' }));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.change(screen.getByLabelText('Save as'), { target: { value: 'Loop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Part' }));
    await screen.findByTestId('import-summary');
    expect(w.makePart).toHaveBeenCalledWith({ quarterTurns: 1, align: '', nudge: [0, 0], drop: [0], name: 'Loop', designer: 'Robin', designerUrl: '', author: 'Sam' });
    const body = m.client.mock.calls[0]![0];
    expect(body).toMatchObject({ mode: 'part', partKey: 'Loop', displayName: 'Loop', xmlBase64: btoa('<part/>'), spriteBase64: btoa('\u0001\u0002\u0003'), widthStuds: 2, heightStuds: 8, connections: 1, category: 'Imported', target: { kind: 'new', title: 'Two straights' } });
    expect(screen.getByTestId('import-summary').textContent).toContain('Made the custom part “Loop”');
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it('places an LDraw layout’s parts made here', async () => {
    w.analyse.mockResolvedValue(analysis);
    w.makeLayout.mockResolvedValue({ type: 'made-layout', bbm: '<Map/>', sheets: 1, bricks: 2 });
    m.client.mockResolvedValue({ mode: 'parts', layoutId: 'L2', newLayout: true, part: null, placed: 2, sheetId: null, brickIds: [], stats: null, warnings: [], widthStuds: null, heightStuds: null, connections: null, sheets: 1 });
    setup();
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByLabelText(/Its parts, one by one/));
    fireEvent.click(screen.getByRole('button', { name: 'Place the parts' }));
    await screen.findByTestId('import-summary');
    expect(m.client.mock.calls[0]![0]).toMatchObject({ mode: 'parts', bbm: '<Map/>', title: 'Two straights', sheets: 1 });
  });

  it('Cancel ends the worker at once', async () => {
    w.analyse.mockImplementation(() => new Promise(() => {}));
    const { onClose } = setup();
    await waitFor(() => expect(w.analyse).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('import-cancel'));
    expect(w.cancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('hands it to the server, and says so, when the browser can’t', async () => {
    w.analyse.mockRejectedValue(new FallBack('out of memory'));
    setup();
    expect(await screen.findByTestId('import-fell-back')).toBeTruthy();
    expect(screen.getByTestId('import-fell-back').textContent).toContain('Your browser couldn’t read this one, so the server is reading it instead.');
    await waitFor(() => expect(m.upload).toHaveBeenCalled());
    expect(await screen.findByTestId('import-preview')).toBeTruthy();
  });

  it('with the site’s own importer off, says plainly that the browser couldn’t, and sends nothing', async () => {
    m.status.mockResolvedValue(status({ available: false, reason: 'backup_off', message: 'This site reads models only in your browser: its own importer is off.' }));
    w.analyse.mockRejectedValue(new FallBack('out of memory'));
    setup();
    expect((await screen.findByTestId('import-error')).textContent).toContain('Your browser couldn’t read this one, and this site reads models only in your browser');
    expect(m.upload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('import-fell-back')).toBeNull();
  });

  it('shows a model’s own problem, without the server (which would say the same)', async () => {
    w.analyse.mockRejectedValue(new Error('This site’s LDraw library has no geometry for any part in this model.'));
    setup();
    expect((await screen.findByTestId('import-error')).textContent).toContain('no geometry');
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('a Studio file is read here too, from Studio’s own library when the site has one', async () => {
    m.status.mockResolvedValue(status({ browser: { available: true, extensions: ['ldr', 'mpd', 'dat', 'io'], ldraw: '0123456789abcdef', studio: 'fedcba9876543210' } }));
    w.analyse.mockResolvedValue({ ...analysis, format: 'studio', kindLabel: 'Studio import', layout: null });
    setup('set.io');
    expect(await screen.findByTestId('import-preview')).toBeTruthy();
    expect(w.analyse.mock.calls[0]![1]).toEqual({ ldraw: '0123456789abcdef', studio: 'fedcba9876543210', ldd: null, lddMapping: null });
    expect(screen.getByRole('dialog', { name: 'Import a model' }).textContent).toContain('Preview: Studio import');
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('a file the browser doesn’t read here (LDD, or Studio where it isn’t offered) goes to the server', async () => {
    setup('set.io');
    await waitFor(() => expect(m.upload).toHaveBeenCalled());
    expect(w.analyse).not.toHaveBeenCalled();
    expect(screen.queryByTestId('import-fell-back')).toBeNull();
  });

  it('without the server’s converter, the browser still imports LDraw; other files are refused with the reason', async () => {
    m.status.mockResolvedValue(status({ available: false, reason: 'missing', message: 'This server doesn’t have the import converter installed.' }));
    w.analyse.mockResolvedValue(analysis);
    setup();
    expect(await screen.findByTestId('import-preview')).toBeTruthy();
    cleanup();
    setup('set.io');
    expect((await screen.findByTestId('import-error')).textContent).toContain('import converter');
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('as an engine or car: turned front to the right, the trucks where the model’s wheels are, fixed by hand, and handed back', async () => {
    // A model built along y: the importer turns it a quarter and found its bogies and magnets.
    const tall = {
      ...analysis,
      suggestedName: 'Santa Fe engine',
      part: {
        ...analysis.part!,
        widthStuds: 6,
        heightStuds: 32,
        contentStuds: { x: 0, y: 0, width: 6, height: 32 },
        connections: [],
        stock: { quarterTurns: 1 as const, length: 30, width: 6, bodyLength: 28, trucks: [9, -9] as [number, number], trucksFrom: 'bogies' as const, couplersFrom: 'found' as const },
      },
    };
    w.analyse.mockResolvedValue(tall);
    w.makePart.mockResolvedValue({ type: 'made-part', partKey: 'Santa_Fe', displayName: 'Santa Fe', xml: '<part/>', png: new Blob([new Uint8Array([1])]), widthStuds: 32, heightStuds: 6, connections: 0 });
    m.client.mockResolvedValue({ mode: 'part', layoutId: null, newLayout: false, part: { id: 'p9', partNumber: 'Santa_Fe', displayName: 'Santa Fe' }, placed: 0, sheetId: null, brickIds: [], stats: analysis.part!.stats, warnings: [], widthStuds: 32, heightStuds: 6, connections: 0, sheets: null });
    const onStock = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ImportDialog, { file: new File(['0 x'], 'engine.ldr'), purpose: 'stock', onClose: vi.fn(), onStock }))));
    await screen.findByTestId('stock-setup');
    expect(screen.getByTestId('stock-guess-note').textContent).toContain('We found the trucks from the model’s bogies. The couplers are its magnets.');
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('engine');
    // No grid lining-up or snap points here: a car isn't track.
    expect(screen.queryByTestId('import-connections')).toBeNull();
    // A truck moved by keyboard on the picture, the other end made the front.
    fireEvent.keyDown(screen.getByTestId('stock-truck-front'), { key: 'ArrowRight', shiftKey: true });
    expect((screen.getByTestId('stock-front-at') as HTMLInputElement).value).toBe('10');
    fireEvent.click(screen.getByTestId('stock-turn-around'));
    expect((screen.getByTestId('stock-front-at') as HTMLInputElement).value).toBe('9');
    expect((screen.getByTestId('stock-rear-at') as HTMLInputElement).value).toBe('-10');
    fireEvent.change(screen.getByLabelText('Road number'), { target: { value: 'SF 16' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /roster/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to rolling stock' }));
    await waitFor(() => expect(onStock).toHaveBeenCalled());
    // Turned a quarter, then round: three quarter turns, lined up automatically, no snap points dropped.
    expect(w.makePart).toHaveBeenCalledWith(expect.objectContaining({ quarterTurns: 3, align: '', nudge: [0, 0], drop: [] }));
    expect(m.client.mock.calls[0]![0]).toMatchObject({ category: 'Rolling stock', target: { kind: 'library' } });
    expect(onStock).toHaveBeenCalledWith({ partId: 'p9', number: 'SF 16', kind: 'engine', setup: { length: 30, width: 6, bodyLength: 28, trucks: [9, -10] }, file: 'engine.ldr', format: 'ldraw', saveTo: '', toRoster: true });
  });
});
