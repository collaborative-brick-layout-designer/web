// Each delete in the lists goes through the confirmation dialog: Cancel
// sends nothing, Delete calls the route and says "Deleted ‹name›", and a
// layout needs its name typed first. The API is a stubbed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { autoConfirm } from '../../test/confirmHost';
import { ToastHost } from '../ConfirmDialog';
import { LayoutsPage } from '../../layouts/LayoutsPage';
import { VenueList } from '../../venues/VenueList';
import { CustomPartsSection } from '../../parts/CustomPartsSection';
import { MyCollections } from '../../catalog/Collections';

let routes: Record<string, unknown>;
let writes: string[];

beforeEach(() => {
  writes = [];
  localStorage.clear();
  routes = {
    'GET /api/auth/me': { user: { id: 'u1', email: 'me@x.com', displayName: 'Me' } },
    'GET /api/orgs': { orgs: [] },
    'GET /api/layouts': { layouts: [{ id: 'l1', title: 'My Town', ownerUserId: 'u1', ownerOrgId: null, role: 'owner', updatedAt: 0, expiresAt: null, hasSidecar: false }] },
    'GET /api/modules': { modules: [{ id: 'm1', title: 'Station', ownerUserId: 'u1', ownerOrgId: null, updatedAt: 0 }] },
    'GET /api/venues': { venues: [{ id: 'v1', name: 'Garage', ownerOrgId: null, ownerUserId: 'u1', canManage: true }] },
    'GET /api/custom-parts': { parts: [{ id: 'p1', partNumber: 'MY.1', displayName: 'My Arch', ownerUserId: 'u1', ownerOrgId: null, role: 'owner', spriteMime: 'image/png', createdAt: 0, updatedAt: 0 }] },
    'GET /api/catalog/collections/mine': {
      collections: [{ id: 'c1', title: 'My picks', description: '', featured: false, official: false, by: 'Me', itemCount: 1, modules: 1, parts: 0, coverUrl: null, updatedAt: 1, status: 'public', audience: 'private', reason: null, pending: false, curatorNote: null }],
    },
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${input}`);
    const out = method === 'DELETE' ? { ok: true } : routes[`${method} ${input}`];
    if (out === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {ui}
        <ToastHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the row's ⋯ menu and pick Delete. */
async function deleteFromMenu(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: `More for ${label}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
}

/** Cancel the first time (nothing is sent), then Delete. */
async function cancelThenDelete(open: () => Promise<void>, route: string, title: string, name: string, says?: string) {
  const asked = autoConfirm(false, true);
  await open();
  await waitFor(() => expect(asked.titles).toEqual([title]));
  if (says) expect(asked.texts[0]).toContain(says);
  await new Promise((r) => setTimeout(r, 30));
  expect(writes).toEqual([]);
  await open();
  await waitFor(() => expect(writes).toEqual([route]));
  expect((await screen.findByTestId('toast')).textContent).toContain(`Deleted “${name}”`);
}

describe('deleting through the dialog', () => {
  it('a layout: asks, and says it waits in Recently deleted', async () => {
    show(<LayoutsPage />);
    await cancelThenDelete(() => deleteFromMenu('My Town'), 'DELETE /api/layouts/l1', 'Delete “My Town”?', 'My Town', 'It waits 30 days in Recently deleted');
  });

  it('a layout stays when Cancel is pressed (no name to type: it can be restored)', async () => {
    show(<LayoutsPage />);
    await deleteFromMenu('My Town');
    const d = await screen.findByTestId('confirm-dialog');
    expect(d.textContent).toContain('The modules, parts and venues it uses aren’t deleted.');
    expect(within(d).queryByLabelText('Type My Town to confirm')).toBeNull();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(writes).toEqual([]);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('a module', async () => {
    show(<LayoutsPage />);
    await cancelThenDelete(() => deleteFromMenu('Station'), 'DELETE /api/modules/m1', 'Delete “Station”?', 'Station', 'Layouts that already use it don’t change.');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('a venue', async () => {
    show(<VenueList filter="me" myUserId="u1" orgs={[]} />);
    await cancelThenDelete(() => deleteFromMenu('Garage'), 'DELETE /api/venues/v1', 'Delete “Garage”?', 'Garage', 'Layouts made from it keep their own copy');
  });

  it('a custom part', async () => {
    show(<CustomPartsSection filter="me" myUserId="u1" orgs={[]} canUpload />);
    await cancelThenDelete(() => deleteFromMenu('MY.1'), 'DELETE /api/custom-parts/p1', 'Delete “MY.1”?', 'MY.1', 'show a placeholder');
  });

  it('a collection', async () => {
    show(<MyCollections />);
    await cancelThenDelete(
      async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Delete My picks' }));
      },
      'DELETE /api/catalog/collections/c1',
      'Delete “My picks”?',
      'My picks',
    );
  });
});
