// @vitest-environment jsdom
// Words on the sign-in and link pages: a sign-in the person canceled at the
// provider says so, and the link page has a way forward for someone who
// doesn't know the matching account's password.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage, SIGN_IN_ERRORS } from '../LoginPage';
import { LinkPage } from '../LinkPage';

function stub(opts: { passwordEnabled: boolean; pending?: { provider: string; signedInAsTarget: boolean } | null }) {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ user: null });
    if (url === '/api/auth/providers') {
      return Response.json({ providers: [{ id: 'github', label: 'GitHub', enabled: true }], passwordEnabled: opts.passwordEnabled, demoEnabled: false });
    }
    if (url === '/api/auth/link') return opts.pending ? Response.json(opts.pending) : Response.json({ error: 'not_found' }, { status: 404 });
    if (url === '/api/catalog/settings') return Response.json({ anonymousBrowse: false });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function show(at: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Where />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/link" element={<LinkPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a sign-in canceled at the provider', () => {
  it('says it was canceled, not that it took too long', async () => {
    stub({ passwordEnabled: true });
    show('/login?error=canceled');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('You canceled the sign-in, so nothing changed. Choose a way to sign in below when you’re ready.');
    expect(alert.textContent).not.toContain('took too long');
    // The ways to sign in are right there to try again.
    expect(await screen.findByRole('link', { name: 'Continue with GitHub' })).toBeTruthy();
  });

  it('keeps its own words for a sign-in that really took too long', () => {
    expect(SIGN_IN_ERRORS.invalid_state).toContain('took too long');
    expect(SIGN_IN_ERRORS.canceled).not.toBe(SIGN_IN_ERRORS.invalid_state);
  });
});

describe('the link page, not signed in to the matching account', () => {
  it('offers "Forgot password?", which opens the sign-in page’s reset form and comes back here', async () => {
    stub({ passwordEnabled: true, pending: { provider: 'github', signedInAsTarget: false } });
    show('/link');
    expect(await screen.findByRole('heading', { name: 'Link this account?' })).toBeTruthy();
    const forgot = await screen.findByRole('link', { name: 'Forgot password?' });
    expect(forgot.getAttribute('href')).toBe('/login?forgot=1&next=%2Flink');
    forgot.click();
    expect(await screen.findByRole('heading', { name: 'Forgot your password?' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/login?forgot=1&next=%2Flink');
  });

  it('doesn’t offer it where signing in with a password is off', async () => {
    stub({ passwordEnabled: false, pending: { provider: 'github', signedInAsTarget: false } });
    show('/link');
    expect(await screen.findByRole('link', { name: 'Sign in to that account' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull();
  });
});
