// "The demo was reset. Start again?": a page that was in the demo and finds
// itself signed out (a reset signs every visitor out) says so, with one
// click back in, instead of a sign-in screen or "this layout isn't here".
// Never for people who signed out on purpose or use a real account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../api';
import { DemoResetNotice } from '../DemoResetNotice';
import { announceSignInEnded, markDemoVisitor, wasDemoVisitor } from '../demoVisitor';

type Handler = () => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let calls: { method: string; path: string }[];
let assign: ReturnType<typeof vi.fn>;

const demoMe = { user: { id: 'demo-account', email: 'demo-builder@demo.invalid', displayName: 'Demo builder', avatarUrl: null, isDemoAccount: true, isGlobalAdmin: false, linkedProviders: [] } };
const aliceMe = { user: { id: 'u1', email: 'alice@x.com', displayName: 'Alice', avatarUrl: null, isDemoAccount: false, isGlobalAdmin: false, linkedProviders: [] } };

beforeEach(() => {
  localStorage.clear();
  calls = [];
  routes = {
    'GET /api/auth/me': () => ({ body: { user: null } }),
    'GET /api/auth/providers': () => ({ body: { providers: [], passwordEnabled: true, demoEnabled: true } }),
    'POST /api/auth/demo': () => ({ body: { ok: true } }),
    'POST /api/auth/logout': () => ({ body: { ok: true } }),
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: input });
    const h = routes[`${method} ${input}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const { status = 200, body } = h();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderNotice(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/editor/l1']}>
        <DemoResetNotice />
        <Routes>
          <Route path="/editor/:id" element={<p>Editor page</p>} />
          <Route path="/login" element={<p>Sign-in page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

describe('the demo reset notice', () => {
  it('shows when a demo page finds itself signed out, and Start again signs back in to a fresh Home', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoMe });
    const qc = renderNotice();
    await waitFor(() => expect(wasDemoVisitor()).toBe(true));
    expect(screen.queryByTestId('demo-reset-notice')).toBeNull();

    // The reset: /me (refetched by its live hint) now says nobody.
    routes['GET /api/auth/me'] = () => ({ body: { user: null } });
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    const dialog = await screen.findByRole('alertdialog', { name: 'The demo was reset. Start again?' });
    expect(dialog.textContent).toContain('Everything in the demo went back to the start');

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/demo')).toBe(true);
  });

  it('Not now goes to the sign-in page and doesn’t ask again', async () => {
    markDemoVisitor();
    renderNotice();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Sign-in page')).toBeTruthy();
    expect(screen.queryByTestId('demo-reset-notice')).toBeNull();
    expect(wasDemoVisitor()).toBe(false);
  });

  it('shows on the next visit when the tab was closed meanwhile', async () => {
    markDemoVisitor();
    renderNotice();
    expect(await screen.findByRole('alertdialog', { name: 'The demo was reset. Start again?' })).toBeTruthy();
  });

  it('a live layout that closes because its sign-in ended checks /me at once', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoMe });
    renderNotice();
    await waitFor(() => expect(wasDemoVisitor()).toBe(true));
    routes['GET /api/auth/me'] = () => ({ body: { user: null } });
    act(() => announceSignInEnded());
    expect(await screen.findByTestId('demo-reset-notice')).toBeTruthy();
  });

  it('says the demo has ended, with Sign in, when an admin turned it off', async () => {
    routes['GET /api/auth/providers'] = () => ({ body: { providers: [], passwordEnabled: true, demoEnabled: false } });
    markDemoVisitor();
    renderNotice();
    expect(await screen.findByRole('alertdialog', { name: 'The demo has ended' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Sign-in page')).toBeTruthy();
  });

  it('never shows after signing out on purpose', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoMe });
    const qc = renderNotice();
    await waitFor(() => expect(wasDemoVisitor()).toBe(true));
    await api.logout();
    routes['GET /api/auth/me'] = () => ({ body: { user: null } });
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/me').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId('demo-reset-notice')).toBeNull();
  });

  it('never shows to a real account, and forgets an old demo visit', async () => {
    markDemoVisitor();
    routes['GET /api/auth/me'] = () => ({ body: aliceMe });
    renderNotice();
    await waitFor(() => expect(wasDemoVisitor()).toBe(false));
    expect(screen.queryByTestId('demo-reset-notice')).toBeNull();
  });
});
