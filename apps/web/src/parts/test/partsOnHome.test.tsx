// @vitest-environment jsdom
// Custom parts moved from the Library page to the home page: the section
// lists mine, my clubs' and shared parts with owner chips under the same
// owner filter, Delete only for parts I own, Upload part opens the upload
// dialog (also from the editor's Parts panel), the top nav has no Library,
// /library lands on #parts, and "reopen last layout" now runs on the home page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LayoutsPage } from '../../layouts/LayoutsPage';
import { lastLayoutToReopen, LAST_LAYOUT_KEY } from '../../layouts/reopenLast';
import { canDeletePart, PARTS_SECTION } from '../CustomPartsSection';
import { PartsPanel } from '../../editor/PartsPanel';
import { AppHeader } from '../../AppHeader';
import { useEditorStore } from '../../editor/editorStore';
import type { CustomPartSummary } from '../../api';

const CLUB = { id: 'org1', name: 'ArkLUG', slug: 'arklug', createdAt: 0, myRole: 'member' as const };
const part = (p: Partial<CustomPartSummary> & { id: string; partNumber: string }): CustomPartSummary => ({
  displayName: p.partNumber,
  ownerUserId: null,
  ownerOrgId: null,
  spriteMime: 'image/png',
  createdAt: 0,
  updatedAt: 0,
  ...p,
});
const PARTS = [
  part({ id: 'p1', partNumber: 'MY.1', displayName: 'My Arch', ownerUserId: 'u1', role: 'owner' }),
  part({ id: 'p2', partNumber: 'CLUB.1', displayName: 'Club Sign', ownerOrgId: 'org1', role: 'editor', owner: { kind: 'org', id: 'org1', name: 'ArkLUG', slug: 'arklug' } }),
  part({ id: 'p3', partNumber: 'DANA.1', displayName: 'Dana Tree', ownerUserId: 'u2', role: 'viewer', owner: { kind: 'user', id: 'u2', name: 'Dana', slug: null } }),
];

let calls: string[];
let routes: Record<string, unknown>;
const IMPORT_ON = { available: true, reason: null, message: null, extensions: ['ldr', 'mpd', 'dat', 'io', 'lxf', 'lxfml'], maxUploadBytes: 1, perHour: 30, libraries: { ldraw: true, ldd: false, lddMapping: false, studio: false } };
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  routes = {
    'GET /api/auth/me': { user: { id: 'u1', email: 'me@x.com', displayName: 'Me', isDemoAccount: false } },
    'GET /api/orgs': { orgs: [CLUB] },
    'GET /api/layouts': { layouts: [] },
    'GET /api/modules': { modules: [] },
    'GET /api/venues': { venues: [] },
    'GET /api/custom-parts': { parts: PARTS },
    'GET /api/parts/catalog': { parts: [] },
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    calls.push(key);
    if (!(key in routes)) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useEditorStore.getState().setReopenLastFile(false);
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search + l.hash}</p>;
}

function renderAt(url: string, extra: ReactNode = null): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/" element={<LayoutsPage />} />
          <Route path="/library" element={<Navigate to={PARTS_SECTION} replace />} />
          <Route path="/editor/:id" element={<p>editor</p>} />
        </Routes>
        <Where />
        {extra}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = async (text: string) => (await screen.findByText(text)).closest('li')!;

describe('Custom parts on the home page', () => {
  it('lists mine, my club’s and shared parts with owner chips', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Custom parts' })).toBeTruthy();
    expect(within(await row('My Arch')).getByTestId('owner-chip').textContent).toBe('Me');
    expect(within(await row('Club Sign')).getByTestId('owner-chip').textContent).toBe('ArkLUG');
    expect(within(await row('Dana Tree')).getByTestId('owner-chip').textContent).toBe('Shared by Dana');
  });

  it('follows the home page’s owner filter', async () => {
    renderAt('/');
    await screen.findByText('My Arch');
    fireEvent.click(within(screen.getByRole('group', { name: 'Show whose things' })).getByRole('button', { name: 'ArkLUG' }));
    expect(screen.queryByText('My Arch')).toBeNull();
    expect(screen.getByText('Club Sign')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Show whose things' })).getByRole('button', { name: 'Mine' }));
    expect(screen.getByText('My Arch')).toBeTruthy();
    expect(screen.queryByText('Club Sign')).toBeNull();
    expect(screen.queryByText('Dana Tree')).toBeNull();
  });

  it('offers Delete in the ⋯ menu only for parts I own', async () => {
    renderAt('/');
    const mine = await row('My Arch');
    fireEvent.click(within(mine).getByRole('button', { name: 'More for MY.1' }));
    expect(within(mine).getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    expect(within(mine).getByRole('menuitem', { name: 'Download XML' }).getAttribute('href')).toBe('/api/custom-parts/p1/xml');
    const clubs = await row('Club Sign');
    fireEvent.click(within(clubs).getByRole('button', { name: 'More for CLUB.1' }));
    expect(within(clubs).queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('the ⋯ menu shares a part with people: Share for mine, People with access for others', async () => {
    renderAt('/');
    const mine = await row('My Arch');
    fireEvent.click(within(mine).getByRole('button', { name: 'More for MY.1' }));
    fireEvent.click(within(mine).getByRole('menuitem', { name: 'Share with people…' }));
    expect(await screen.findByRole('dialog', { name: 'Share My Arch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeTruthy();
    await waitFor(() => expect(calls).toContain('GET /api/custom-parts/p1/collaborators'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const dana = await row('Dana Tree');
    fireEvent.click(within(dana).getByRole('button', { name: 'More for DANA.1' }));
    fireEvent.click(within(dana).getByRole('menuitem', { name: 'People with access…' }));
    expect(await screen.findByRole('dialog', { name: 'Share Dana Tree' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
  });

  it('who may delete: the server’s role, else my own or a club I admin', () => {
    expect(canDeletePart(PARTS[0]!, 'u1', [CLUB])).toBe(true);
    expect(canDeletePart(PARTS[1]!, 'u1', [CLUB])).toBe(false);
    const noRole = ({ role: _r, ...p }: CustomPartSummary): CustomPartSummary => p;
    const old = noRole(PARTS[1]!);
    expect(canDeletePart(old, 'u1', [CLUB])).toBe(false);
    expect(canDeletePart(old, 'u1', [{ ...CLUB, myRole: 'admin' }])).toBe(true);
    expect(canDeletePart(noRole(PARTS[0]!), 'u1', [])).toBe(true);
    expect(canDeletePart(noRole(PARTS[0]!), 'u9', [])).toBe(false);
  });

  it('Upload part opens the upload dialog, saving to the club being shown', async () => {
    renderAt('/?owner=arklug');
    await screen.findByText('Club Sign');
    fireEvent.click(screen.getByRole('button', { name: 'Upload part' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload custom part' });
    await waitFor(() => expect((within(dialog).getByLabelText('Save to') as HTMLSelectElement).value).toBe('arklug'));
  });

  it('makes a part from a model file when this site can import: from the section and from Upload part', async () => {
    routes['GET /api/imports/status'] = IMPORT_ON;
    const picked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      renderAt('/');
      await screen.findByText('My Arch');
      fireEvent.click(await screen.findByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)' }));
      expect(picked).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('import-part-input').getAttribute('accept')).toBe('.ldr,.mpd,.dat,.io,.lxf,.lxfml');
      // Upload part points to it instead of the desktop app.
      fireEvent.click(screen.getByRole('button', { name: 'Upload part' }));
      const dialog = await screen.findByRole('dialog', { name: 'Upload custom part' });
      const hint = await within(dialog).findByTestId('upload-part-import');
      expect(within(dialog).queryByText('Making a part from an LDraw, Studio or LDD model?')).toBeNull();
      fireEvent.click(within(hint).getByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)' }));
      expect(picked).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload custom part' })).toBeNull());
    } finally {
      picked.mockRestore();
    }
  });

  it('keeps the desktop app’s steps where this site can’t import', async () => {
    routes['GET /api/imports/status'] = { ...IMPORT_ON, available: false, reason: 'missing', message: 'This server doesn’t have the import converter installed.' };
    renderAt('/');
    await screen.findByText('My Arch');
    fireEvent.click(screen.getByRole('button', { name: 'Upload part' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload custom part' });
    expect(within(dialog).getByText('Making a part from an LDraw, Studio or LDD model?')).toBeTruthy();
    expect(within(dialog).queryByTestId('upload-part-import')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)' })).toBeNull();
  });

  it('/library lands on the parts section', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderAt('/library');
    await screen.findByText('My Arch');
    expect(screen.getByTestId('where').textContent).toBe('/#parts');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('parts'));
  });
});

describe('reopen last layout, now on the home page', () => {
  it('opens the last layout once per visit when the preference is on', async () => {
    localStorage.setItem(LAST_LAYOUT_KEY, 'L42');
    useEditorStore.getState().setReopenLastFile(true);
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/editor/L42'));
    cleanup();
    renderAt('/');
    await screen.findByText('My Arch');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('stays home when the preference is off, or a link came for something else', () => {
    localStorage.setItem(LAST_LAYOUT_KEY, 'L42');
    expect(lastLayoutToReopen(false, '', '')).toBeNull();
    sessionStorage.clear();
    expect(lastLayoutToReopen(true, '?owner=arklug', '')).toBeNull();
    sessionStorage.clear();
    expect(lastLayoutToReopen(true, '', '#parts')).toBeNull();
    sessionStorage.clear();
    expect(lastLayoutToReopen(true, '', '')).toBe('L42');
    expect(lastLayoutToReopen(true, '', '')).toBeNull();
    sessionStorage.clear();
    localStorage.removeItem(LAST_LAYOUT_KEY);
    expect(lastLayoutToReopen(true, '', '')).toBeNull();
  });
});

describe('elsewhere', () => {
  it('the editor’s Parts panel has Upload part… when allowed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PartsPanel onPlacePart={() => undefined} canUploadPart={false} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Upload part…' })).toBeNull();
    rerender(
      <QueryClientProvider client={qc}>
        <PartsPanel onPlacePart={() => undefined} canUploadPart />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Upload part…' }));
    expect(await screen.findByRole('dialog', { name: 'Upload custom part' })).toBeTruthy();
  });

  it('the editor’s Parts panel imports a part from a model file, also from Upload part…', async () => {
    routes['GET /api/imports/status'] = IMPORT_ON;
    const onImportModel = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PartsPanel onPlacePart={() => undefined} canUploadPart onImportModel={onImportModel} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)…' }));
    expect(onImportModel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Upload part…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload custom part' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import from a model file (LDraw, Studio, LDD)' }));
    expect(onImportModel).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload custom part' })).toBeNull());
  });

  it('the top nav no longer has Library', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppHeader user={{ id: 'u1', email: 'me@x.com', displayName: 'Me' } as never} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Site' });
    expect(within(nav).getByRole('link', { name: 'Clubs' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Library' })).toBeNull();
  });

  it('has a Home tab first, marked as the page you are on', () => {
    const qc = new QueryClient();
    const at = (url: string) =>
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[url]}>
            <AppHeader user={{ id: 'u1', email: 'me@x.com', displayName: 'Me' } as never} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    const home = at('/');
    let nav = screen.getByRole('navigation', { name: 'Site' });
    const links = within(nav).getAllByRole('link');
    expect(links[0]!.textContent).toBe('Home');
    expect(links[0]!.getAttribute('href')).toBe('/');
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    home.unmount();
    at('/orgs');
    nav = screen.getByRole('navigation', { name: 'Site' });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: /^Clubs/ }).getAttribute('aria-current')).toBe('page');
  });
});
