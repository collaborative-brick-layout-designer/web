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

  it('an account whose address is not confirmed is offered a confirmation email instead, and can put it off', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const body =
        url === '/api/auth/me'
          ? { user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat', avatarUrl: null, isDemoAccount: false, isGlobalAdmin: false, linkedProviders: [], emailProven: false } }
          : url === '/api/auth/providers'
            ? { providers: [], passwordEnabled: true }
            : url === '/api/auth/password/confirm-email'
              ? { ok: true, alreadyConfirmed: false, sent: true }
              : { invites: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    localStorage.removeItem('cld.confirmEmail.dismissed.u1');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () => (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <MyInvites />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { unmount } = render(view());
    expect(await screen.findByText('Confirm your email to see club invites sent to it')).toBeTruthy();
    expect(screen.getByTestId('confirm-email').textContent).toContain('pat@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send me a confirmation email' }));
    expect(await screen.findByText(/We sent a link to/)).toBeTruthy();
    expect(calls).toContain('POST /api/auth/password/confirm-email');
    fireEvent.click(screen.getByRole('button', { name: /Not now/ }));
    expect(screen.queryByTestId('confirm-email')).toBeNull();
    // Remembered in this browser.
    unmount();
    render(view());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('confirm-email')).toBeNull();
    localStorage.removeItem('cld.confirmEmail.dismissed.u1');
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
