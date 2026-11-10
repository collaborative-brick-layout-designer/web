// @vitest-environment jsdom
// The club's Parts tab on the Manage page: managers look after the club's
// custom parts (the server lets them), while the part-library switches
// stay with the admins. The API is a stubbed fetch.

import { autoConfirm } from '../../test/confirmHost';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CustomPartSummary, OrgDetail } from '../../api';
import { OrgAdminPage } from '../OrgAdminPage';

const PART: CustomPartSummary = {
  id: 'p1',
  partNumber: 'club-1',
  displayName: 'Club baseplate',
  ownerUserId: null,
  ownerOrgId: 'o1',
  spriteMime: 'image/png',
  createdAt: 0,
  updatedAt: 0,
};

let role: OrgDetail['myRole'];
let calls: { method: string; path: string }[];

function reply(path: string): unknown {
  if (path === '/api/auth/me') {
    return { user: { id: 'u1', email: 'me@x.com', displayName: 'Me', avatarUrl: null, isDemoAccount: false, isGlobalAdmin: false, linkedProviders: [] } };
  }
  if (path === '/api/orgs/arklug') {
    return { id: 'o1', name: 'ArkLUG', slug: 'arklug', createdAt: 0, myRole: role, description: '', membersCanCreate: true, memberCount: 2, adminCount: 1 };
  }
  if (path === '/api/orgs/arklug/members') return { members: [], invites: [] };
  if (path === '/api/orgs/arklug/join-requests') return { requests: [] };
  if (path === '/api/orgs/arklug/part-libraries') return { libraries: [{ id: 'l1', name: 'BlueBrick parts', slug: 'bluebrick', partCount: 3, defaultEnabled: true, locked: false, enabled: true, explicitOverride: false }] };
  if (path === '/api/custom-parts') return { parts: [PART] };
  if (path.startsWith('/api/layouts')) return { layouts: [] };
  if (path.startsWith('/api/venues')) return { venues: [] };
  if (path.startsWith('/api/modules')) return { modules: [] };
  return { ok: true };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: input });
    return new Response(JSON.stringify(reply(input)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  autoConfirm(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/orgs/arklug/admin']}>
        <Routes>
          <Route path="/orgs/:slug/admin" element={<OrgAdminPage />} />
          <Route path="/orgs/:slug" element={<p>club page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the club Parts tab', () => {
  it('lets a manager manage the club parts, without the library switches', async () => {
    role = 'manager';
    show();
    const tab = await screen.findByRole('tab', { name: 'Parts' });
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    fireEvent.click(tab);
    expect(await screen.findByText('club-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload part' })).toBeTruthy();
    expect(screen.queryByText('Part packs')).toBeNull();
    expect(calls.some((c) => c.path.includes('/part-libraries'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: '/api/custom-parts/p1' }));
  });

  it('shows an admin the library switches as well', async () => {
    role = 'admin';
    show();
    fireEvent.click(await screen.findByRole('tab', { name: 'Parts' }));
    expect(await screen.findByText('Part packs')).toBeTruthy();
    expect(await screen.findByText('club-1')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();
  });
});
