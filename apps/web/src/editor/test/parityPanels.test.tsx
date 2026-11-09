// The module-drag ghost (MapView.cpp:1796-1900) and the panel changes
// behind it: the Module library publishing the dragged module, and the
// Venue Library (VenueLibraryPanel.cpp): details, Rename with its
// duplicate-name check, and Save this layout's venue.

import { autoConfirm } from '../../test/confirmHost';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, Fragment, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createDefaultLayoutDoc } from '@cld/ydoc';
import type { PartWire } from '../../api';

const konva: { type: string; props: Record<string, unknown> }[] = [];
vi.mock('react-konva', () => {
  const mk = (type: string) => (p: Record<string, unknown> & { children?: ReactNode }) => {
    konva.push({ type, props: p });
    return h(Fragment, null, p.children);
  };
  return { Group: mk('Group'), Image: mk('Image'), Rect: mk('Rect'), Circle: mk('Circle'), Line: mk('Line'), Text: mk('Text') };
});

const sprite = { naturalWidth: 32, naturalHeight: 16 } as HTMLImageElement;
vi.mock('../render/spriteCache', () => ({
  ensureSprite: () => Promise.resolve(sprite),
  getSpriteSync: (url: string) => (url ? sprite : null),
}));

const apiMock = vi.hoisted(() => ({
  modulesList: vi.fn(),
  venuesList: vi.fn(),
  venuesRename: vi.fn(),
  venuesGet: vi.fn(),
  venuesCreate: vi.fn(),
  venuesUpdate: vi.fn(),
  orgsList: vi.fn(),
}));
vi.mock('../../api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../api')>();
  return {
    ...orig,
    api: {
      ...orig.api,
      modules: { ...orig.api.modules, list: apiMock.modulesList },
      venues: {
        ...orig.api.venues,
        list: apiMock.venuesList,
        rename: apiMock.venuesRename,
        get: apiMock.venuesGet,
        create: apiMock.venuesCreate,
        update: apiMock.venuesUpdate,
      },
      orgs: { ...orig.api.orgs, list: apiMock.orgsList },
    },
  };
});

import { ModuleGhost } from '../render/ModuleGhost';
import { ModuleLibraryPanel } from '../ModuleLibraryPanel';
import { VenueLibraryPanel } from '../VenueLibraryPanel';
import { setVenue } from '../mutations';
import { MODULE_MIME, activeModuleDrag } from '../mime';

afterEach(() => {
  cleanup();
  konva.length = 0;
  vi.restoreAllMocks();
});

function withQuery(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return h(QueryClientProvider, { client: qc }, node);
}

describe('ModuleGhost', () => {
  const part = {
    key: '3001.1',
    partNumber: '3001',
    source: 'library',
    spritePath: 'x/3001.1.gif',
    pxPerStud: 8,
    connections: [],
  } as unknown as PartWire;
  const parts = new Map([['3001.1', part]]);

  it('draws every brick shifted by the drop translation, sprites rotated about their centre', () => {
    render(
      h(ModuleGhost, {
        batches: [
          {
            layerName: 'A',
            bricks: [
              { partNumber: '3001.1', displayArea: { x: 10, y: 20, width: 4, height: 2 }, orientation: 90 },
              { partNumber: 'unknown.0', displayArea: { x: 0, y: 0, width: 2, height: 2 } },
            ],
          },
        ],
        offset: { dx: 5, dy: -3 },
        partsByKey: parts,
      }),
    );
    const group = konva.find((k) => k.type === 'Group')!;
    expect(group.props).toMatchObject({ x: 40, y: -24, opacity: 0.55, listening: false });
    const img = konva.filter((k) => k.type === 'Image').at(-1)!;
    // Natural sprite size at 8 px/stud, centred on the displayArea centre.
    expect(img.props).toMatchObject({ x: 96, y: 168, width: 32, height: 16, offsetX: 16, offsetY: 8, rotation: 90 });
    // A part without a sprite shows its displayArea box.
    const rect = konva.filter((k) => k.type === 'Rect').at(-1)!;
    expect(rect.props).toMatchObject({ x: 0, y: 0, width: 16, height: 16 });
  });
});

describe('ModuleLibraryPanel drag', () => {
  it('publishes the dragged module id for the canvas ghost, with a new session per drag', async () => {
    apiMock.modulesList.mockResolvedValue({
      modules: [{ id: '11111111-2222-3333-4444-555555555555', title: 'Loop', ownerUserId: 'u', ownerOrgId: null, docVersion: 1, hasSidecar: false, createdAt: 0, updatedAt: 0 }],
    });
    render(withQuery(h(ModuleLibraryPanel, { doc: createDefaultLayoutDoc(), isViewer: false })));
    const row = (await screen.findByText('Loop')).closest('li')!;
    const data: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' };
    const session = activeModuleDrag.session;
    fireEvent.dragStart(row, { dataTransfer });
    expect(data[MODULE_MIME]).toBe('11111111-2222-3333-4444-555555555555');
    expect(activeModuleDrag).toEqual({ id: '11111111-2222-3333-4444-555555555555', session: session + 1 });
    fireEvent.dragEnd(row);
    expect(activeModuleDrag.id).toBeNull();
    fireEvent.dragStart(row, { dataTransfer });
    expect(activeModuleDrag.session).toBe(session + 2);
  });
});

const HALL = {
  name: 'Hall',
  enabled: true,
  minWalkwayStuds: 125,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  edges: [
    { kind: 0, doorWidthStuds: 0, label: '', poly: [] },
    { kind: 0, doorWidthStuds: 0, label: '', poly: [] },
    { kind: 1, doorWidthStuds: 20, label: '', poly: [] },
  ],
  obstacles: [{ label: 'Pillar', poly: [] }],
} as const;

function setupVenues(venues: { id: string; name: string; ownerOrgId: string | null }[]) {
  apiMock.venuesList.mockResolvedValue({ venues });
  apiMock.venuesGet.mockResolvedValue({ id: 'v1', name: 'Hall', data: HALL });
  apiMock.orgsList.mockResolvedValue({ orgs: [] });
}

describe('VenueLibraryPanel', () => {
  it('shows the selected venue\'s details (VenueLibraryPanel.cpp detailText)', async () => {
    setupVenues([{ id: 'v1', name: 'Hall', ownerOrgId: null }]);
    render(withQuery(h(VenueLibraryPanel, { doc: createDefaultLayoutDoc(), isViewer: false })));
    expect((screen.getByRole('button', { name: 'Rename…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole('option', { name: 'Hall' }));
    await waitFor(() => expect(screen.getByTestId('venue-detail').textContent).toBe('Hall\n2 wall seg · 1 door · 1 obstacle · walkway ≥ 100 mm'));
    expect(apiMock.venuesGet).toHaveBeenCalledWith('v1');
  });

  it('renames through the API in the Rename box, and refuses another venue\'s name', async () => {
    setupVenues([
      { id: 'v1', name: 'Hall', ownerOrgId: null },
      { id: 'v2', name: 'Annex', ownerOrgId: null },
    ]);
    apiMock.venuesRename.mockResolvedValue({ ok: true, id: 'v1', name: 'Main Hall' });
    render(withQuery(h(VenueLibraryPanel, { doc: createDefaultLayoutDoc(), isViewer: false })));
    fireEvent.click(await screen.findByRole('option', { name: 'Hall' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const box = screen.getByRole('dialog', { name: 'Rename venue' });
    const input = within(box).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Hall');
    fireEvent.change(input, { target: { value: ' annex ' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(within(box).getByText('There’s already a venue called “annex”.')).toBeTruthy());
    expect(apiMock.venuesRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '  Main Hall  ' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(apiMock.venuesRename).toHaveBeenCalledWith('v1', 'Main Hall'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename venue' })).toBeNull());
    // The list is refetched after a rename.
    await waitFor(() => expect(apiMock.venuesList.mock.calls.length).toBeGreaterThan(1));
  });

  it('a layout with no venue gets the Draw your venue card, which goes away once there is one', async () => {
    setupVenues([]);
    const doc = createDefaultLayoutDoc();
    const onDesigner = vi.fn();
    const onDimensions = vi.fn();
    const onDrawOutline = vi.fn();
    render(withQuery(h(VenueLibraryPanel, { doc, isViewer: false, onDesigner, onDimensions, onDrawOutline })));
    const card = screen.getByTestId('draw-venue-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Open the venue designer' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Draw on the map' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Type in the sizes…' }));
    expect([onDesigner.mock.calls.length, onDrawOutline.mock.calls.length, onDimensions.mock.calls.length]).toEqual([1, 1, 1]);
    expect((screen.getByRole('button', { name: 'Save this layout’s venue…' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => setVenue(doc, { ...HALL, edges: [...HALL.edges], obstacles: [...HALL.obstacles] } as never));
    await waitFor(() => expect(screen.queryByTestId('draw-venue-card')).toBeNull());
    expect((screen.getByRole('button', { name: 'Save this layout’s venue…' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Save this layout’s venue: saves a new name, asks before overwriting', async () => {
    setupVenues([{ id: 'v1', name: 'Hall', ownerOrgId: null }]);
    apiMock.venuesCreate.mockResolvedValue({ id: 'v9', name: 'Big Hall' });
    apiMock.venuesUpdate.mockResolvedValue({ ok: true, id: 'v1', name: 'Hall' });
    const doc = createDefaultLayoutDoc();
    setVenue(doc, { ...HALL, edges: [...HALL.edges], obstacles: [...HALL.obstacles] } as never);
    render(withQuery(h(VenueLibraryPanel, { doc, isViewer: false })));
    await screen.findByRole('option', { name: 'Hall' });

    fireEvent.click(screen.getByRole('button', { name: 'Save this layout’s venue…' }));
    const name = screen.getByLabelText('Name for this venue');
    expect((name as HTMLInputElement).value).toBe('Hall');
    fireEvent.change(name, { target: { value: 'Big Hall' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.venuesCreate).toHaveBeenCalledWith({ name: 'Big Hall', data: expect.objectContaining({ name: 'Hall' }) }));

    // Same name as a saved venue (any case): overwrite only after a yes.
    const asked = autoConfirm(false, true);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Save this layout’s venue…' }));
      fireEvent.change(screen.getByLabelText('Name for this venue'), { target: { value: 'HALL' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(asked.titles).toHaveLength(i + 1));
    }
    expect(asked.titles).toEqual(['Replace “Hall”?', 'Replace “Hall”?']);
    await waitFor(() => expect(apiMock.venuesUpdate).toHaveBeenCalledTimes(1));
    expect(apiMock.venuesUpdate).toHaveBeenCalledWith('v1', expect.objectContaining({ name: 'Hall' }));
    expect(apiMock.venuesCreate).toHaveBeenCalledTimes(1);
  });

  it('has no library actions for viewers', async () => {
    setupVenues([{ id: 'v1', name: 'Hall', ownerOrgId: null }]);
    render(withQuery(h(VenueLibraryPanel, { doc: createDefaultLayoutDoc(), isViewer: true })));
    expect(screen.queryByRole('button', { name: 'Rename…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save this layout’s venue…' })).toBeNull();
    expect(screen.queryByTestId('draw-venue-card')).toBeNull();
  });
});
