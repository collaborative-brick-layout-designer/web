// The window-wide file opener: the drop overlay, opening a dropped or
// picked layout into a new one, and the desktop app's steps for LDraw,
// Studio and LDD files.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { FileOpener, openFilePicker } from '../FileOpener';
import { DESKTOP_URL } from '../../projectLinks';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import { NEWER_SIDECAR_WARNING, writeBbm } from '@cld/bbm/browser';

const apiMock = vi.hoisted(() => ({ create: vi.fn(), catalog: vi.fn() }));
vi.mock('../../api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../api')>();
  return {
    ...orig,
    api: {
      ...orig.api,
      layouts: { ...orig.api.layouts, create: apiMock.create },
      parts: { ...orig.api.parts, catalog: apiMock.catalog },
    },
  };
});

// A whole, valid .bbm: a cut-off or damaged one is refused before it opens.
const BBM = writeBbm(docToBbm(createDefaultLayoutDoc()));

function Editor() {
  const { pathname, state } = useLocation();
  return h('p', { 'data-testid': 'editor' }, `${pathname} ${JSON.stringify(state)}`);
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: ['/'] }, h(FileOpener), h(Routes, null, h(Route, { path: '/', element: h('p', null, 'Home') }), h(Route, { path: '/editor/:id', element: h(Editor) })))),
  );
}

function dataTransfer(files: File[]): DataTransfer {
  return { files, types: ['Files'], items: files.map(() => ({ kind: 'file' })), dropEffect: 'none' } as unknown as DataTransfer;
}

function dragEvent(type: string, files: File[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer(files) });
  return e;
}

beforeEach(() => {
  apiMock.create.mockReset().mockResolvedValue({ id: 'new-1' });
  apiMock.catalog.mockReset().mockResolvedValue({ parts: [] });
});
afterEach(cleanup);

describe('FileOpener', () => {
  it('shows the drop overlay while a file is dragged over the page', () => {
    setup();
    const f = [new File(['x'], 'a.bbm')];
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    act(() => void window.dispatchEvent(dragEvent('dragenter', f)));
    expect(screen.getByTestId('drop-overlay').textContent).toContain('Drop a layout file to open it');
    expect(screen.getByTestId('drop-overlay').textContent).toContain('BlueBrick (.bbm)');
    act(() => void window.dispatchEvent(dragEvent('dragleave', f)));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
  });

  it('opens a dropped .bbm as a new layout and tells the editor its name', async () => {
    setup();
    const drop = dragEvent('drop', [new File([BBM], 'Yard.bbm')]);
    act(() => void window.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId('editor').textContent).toContain('/editor/new-1'));
    expect(apiMock.create).toHaveBeenCalledWith({ bbm: BBM });
    expect(screen.getByTestId('editor').textContent).toContain('"openedFile":"Yard.bbm"');
  });

  // As the desktop does: a sidecar saved by a newer version opens, and the
  // editor is told some of it isn't shown.
  it('opens a sidecar from a newer version and says some of it is not shown', async () => {
    setup();
    const sidecar = JSON.stringify({ schemaVersion: 2, bbmHashSha256: '', futureField: { x: 1 } });
    act(() => void window.dispatchEvent(dragEvent('drop', [new File([BBM], 'Yard.bbm'), new File([sidecar], 'Yard.bbm.bld')])));
    await waitFor(() => expect(screen.getByTestId('editor').textContent).toContain('/editor/new-1'));
    expect(apiMock.create).toHaveBeenCalledWith({ bbm: BBM, sidecar });
    expect(screen.getByTestId('editor').textContent).toContain(JSON.stringify(NEWER_SIDECAR_WARNING).slice(1, -1));
  });

  it('opens a picked file the same way', async () => {
    setup();
    const input = screen.getByTestId('open-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    openFilePicker();
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [new File([BBM], 'Picked.bbm')] } });
    await waitFor(() => expect(screen.getByTestId('editor').textContent).toContain('"openedFile":"Picked.bbm"'));
  });

  for (const [name, what, step] of [
    ['city.io', 'a BrickLink Studio file', 'Upload to server…'],
    ['house.lxf', 'a LEGO Digital Designer (LDD) file', 'Upload to server…'],
    ['train.ldr', 'an LDraw file', 'File › Save to Server…'],
  ] as const) {
    it(`explains that ${name} is imported in the desktop app, and opens nothing`, async () => {
      setup();
      act(() => void window.dispatchEvent(dragEvent('drop', [new File(['x'], name)])));
      const dialog = await screen.findByRole('dialog', { name: 'Open this in the desktop app' });
      expect(dialog.textContent).toContain(`${name} is ${what}`);
      expect(dialog.textContent).toContain(step);
      expect(screen.getByRole('link', { name: 'Get the desktop app' }).getAttribute('href')).toBe(DESKTOP_URL);
      expect(apiMock.create).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  }

  it('says what it opens when a file is something else', async () => {
    setup();
    act(() => void window.dispatchEvent(dragEvent('drop', [new File(['x'], 'photo.jpg')])));
    const dialog = await screen.findByRole('dialog', { name: 'This isn’t a layout file' });
    expect(dialog.textContent).toContain('TrackDesigner (.tdl)');
    expect(apiMock.create).not.toHaveBeenCalled();
  });

  it('says why a layout file could not be opened', async () => {
    setup();
    act(() => void window.dispatchEvent(dragEvent('drop', [new File(['not a zip'], 'broken.bld-layout')])));
    const dialog = await screen.findByRole('dialog', { name: 'The file couldn’t be opened' });
    expect(dialog.textContent).toContain('broken.bld-layout');
    expect(apiMock.create).not.toHaveBeenCalled();
  });

  it('leaves drags that carry no files alone', () => {
    setup();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [], types: ['application/x-part'], items: [] } });
    act(() => void window.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
