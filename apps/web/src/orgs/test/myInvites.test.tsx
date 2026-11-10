// Home's "You're invited to a club": the invites waiting for the signed-in
// person, with Join, which goes to the club page.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MyInvites } from '../MyInvites';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MyInvites', () => {
  it('lists the invites and joins one', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const body = url === '/api/me/org-invites'
        ? { invites: calls.some((c) => c.startsWith('POST')) ? [] : [{ token: 't1', orgName: 'ArkLUG', orgSlug: 'arklug', roleName: 'Member', invitedBy: 'Ada', expiresAt: Date.now() + 1e6 }] }
        : { orgId: 'o1', role: 'member' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<MyInvites />} />
            <Route path="/orgs/:slug" element={<p>club page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('You’re invited to a club')).toBeTruthy();
    expect(screen.getByTestId('my-invites').textContent).toContain('ArkLUG as Member, from Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Join ArkLUG' }));
    await waitFor(() => expect(screen.getByText('club page')).toBeTruthy());
    expect(calls).toContain('POST /api/org-invites/t1');
  });

  it('shows nothing when there are none', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ invites: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MyInvites />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});
