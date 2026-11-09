// @vitest-environment jsdom
// The hand-over page: the server (not the page) says whether the hand-over
// is for the account signed in, since the address is masked for anyone else.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../api';
import { TransferPage } from '../TransferPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function page() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/transfer/abc']}>
        <Routes>
          <Route path="/transfer/:token" element={<TransferPage />} />
          <Route path="/editor/:id" element={<p>editor page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ME = (email: string) => ({ user: { id: 'u1', email, displayName: 'Me', isDemoAccount: false } }) as unknown as Awaited<ReturnType<typeof api.me>>;
const preview = { recipientEmail: 'bob@example.com', forYou: true as boolean | null, layoutId: 'l1', layoutTitle: 'Harbor', expiresAt: 0 };

describe('layout hand-over page', () => {
  it('signed in as the recipient: accepts and opens the layout', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(ME('Bob@example.com'));
    vi.spyOn(api.transfers, 'preview').mockResolvedValue(preview);
    const accept = vi.spyOn(api.transfers, 'accept').mockResolvedValue({ layoutId: 'l1' });
    page();
    await waitFor(() => expect(accept).toHaveBeenCalledWith('abc'));
    expect(await screen.findByText('editor page', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('signed in as someone else: shows only the masked address and doesn’t accept', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(ME('eve@example.com'));
    vi.spyOn(api.transfers, 'preview').mockResolvedValue({ ...preview, recipientEmail: 'b…@example.com', forYou: false });
    const accept = vi.spyOn(api.transfers, 'accept');
    page();
    expect(await screen.findByText(/but you're signed/)).toBeTruthy();
    expect(screen.getByText('b…@example.com')).toBeTruthy();
    expect(document.body.textContent).not.toContain('bob@example.com');
    expect(accept).not.toHaveBeenCalled();
  });

  it('signed out: asks to sign in, naming only the masked address', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({ user: null } as never);
    vi.spyOn(api.transfers, 'preview').mockResolvedValue({ ...preview, recipientEmail: 'b…@example.com', forYou: null });
    const accept = vi.spyOn(api.transfers, 'accept');
    page();
    const link = await screen.findByRole('link', { name: 'Sign in as b…@example.com' });
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/transfer/abc')}`);
    expect(accept).not.toHaveBeenCalled();
  });
});
