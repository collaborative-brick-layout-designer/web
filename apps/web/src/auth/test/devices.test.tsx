// Desktop sign-in UI: the /device approval page and the profile page's
// Devices list. The API is a stubbed fetch.

import { autoConfirm } from '../../test/confirmHost';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { DevicePage } from '../DevicePage';
import { DevicesSection } from '../DevicesSection';
import { safeNext } from '../LoginPage';

type Handler = (init: RequestInit | undefined) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/auth/me': () => ({ body: { user: { id: 'u1', email: 'me@x.com', displayName: 'Me' } } }),
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${input}`;
    calls.push({ method, path: input, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const { status = 200, body } = h(init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(ui: ReactNode, url = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const REQUEST = { clientName: 'Brick Layout Designer 2.0', scopes: ['layouts:read', 'layouts:write'], expiresAt: Date.now() + 600_000 };

describe('DevicePage', () => {
  it('looks up a typed code, shows the client and scopes, and approves', async () => {
    routes['POST /api/auth/device/lookup'] = () => ({ body: REQUEST });
    routes['POST /api/auth/device/approve'] = () => ({ body: { ok: true } });
    renderAt(<DevicePage />, '/device');

    fireEvent.change(await screen.findByLabelText('Device code'), { target: { value: 'bcdf-ghjk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Allow Brick Layout Designer 2.0?')).toBeTruthy();
    expect(screen.getByText('See your layouts and modules, the catalog and your notices')).toBeTruthy();
    expect(screen.getByText('Edit your layouts (live sync) and save modules')).toBeTruthy();
    expect(screen.getByText('BCDF-GHJK')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/auth/device/lookup')!.body).toEqual({ user_code: 'bcdf-ghjk' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Device connected')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/auth/device/approve')!.body).toEqual({ user_code: 'bcdf-ghjk' });
  });

  it('looks up a pre-filled code automatically, and can deny', async () => {
    routes['POST /api/auth/device/lookup'] = () => ({ body: { ...REQUEST, scopes: ['layouts:read'] } });
    routes['POST /api/auth/device/deny'] = () => ({ body: { ok: true } });
    renderAt(<DevicePage />, '/device?user_code=BCDF-GHJK');

    expect(await screen.findByText('Allow Brick Layout Designer 2.0?')).toBeTruthy();
    expect(screen.queryByText('Edit your layouts (live sync) and save modules')).toBeNull();
    // Nothing is approved without a click.
    expect(calls.some((c) => c.path === '/api/auth/device/approve')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Request denied')).toBeTruthy();
  });

  it('explains an invalid or expired code', async () => {
    routes['POST /api/auth/device/lookup'] = () => ({ status: 404, body: { error: 'invalid_code' } });
    renderAt(<DevicePage />, '/device');
    fireEvent.change(await screen.findByLabelText('Device code'), { target: { value: 'ZZZZ-ZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid or has expired/);
  });

  it('tells the demo account it can’t connect the desktop app, with a way out', async () => {
    routes['GET /api/auth/me'] = () => ({ body: { user: { id: 'd', email: 'demo@x', displayName: 'Demo', isDemoAccount: true } } });
    renderAt(<DevicePage />, '/device?user_code=BCDF-GHJK');
    expect(await screen.findByText(/The desktop app can’t sign in to the demo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out of the demo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('asks a signed-out user to sign in, returning to the same code', async () => {
    routes['GET /api/auth/me'] = () => ({ body: { user: null } });
    renderAt(<DevicePage />, '/device?user_code=BCDF-GHJK');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/device?user_code=BCDF-GHJK')}`);
    expect(calls.some((c) => c.path === '/api/auth/device/lookup')).toBe(false);
  });
});

describe('DevicesSection', () => {
  const TOKENS = [
    {
      id: 't1', name: 'Workshop laptop', prefix: 'bld_pat_Ab3x', last4: 'wxyz',
      scopes: ['layouts:read', 'layouts:write'],
      createdAt: Date.UTC(2026, 0, 5), lastUsedAt: null, expiresAt: Date.UTC(2026, 3, 5),
    },
    {
      id: 't2', name: 'Show PC', prefix: 'bld_pat_Qq9z', last4: 'abcd', scopes: ['layouts:read'],
      createdAt: Date.UTC(2026, 1, 1), lastUsedAt: Date.UTC(2026, 1, 2), expiresAt: Date.UTC(2026, 4, 2),
    },
  ];

  it('lists devices with scopes and dates, and revokes one', async () => {
    let tokens = [...TOKENS];
    routes['GET /api/tokens'] = () => ({ body: { tokens } });
    routes['DELETE /api/tokens/t1'] = () => {
      tokens = tokens.filter((t) => t.id !== 't1');
      return { body: { ok: true } };
    };
    autoConfirm(true);
    renderAt(<DevicesSection />);

    expect(await screen.findByText('Workshop laptop')).toBeTruthy();
    expect(screen.getByText('bld_pat_Ab3x…wxyz')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/Read & edit/);
    expect(rows[0]!.textContent).toMatch(/Last used never/);
    expect(rows[0]!.textContent).toMatch(/Created .*2026/);
    expect(rows[0]!.textContent).toMatch(/Expires .*2026/);
    expect(rows[1]!.textContent).toMatch(/Read only/);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Workshop laptop' }));
    await waitFor(() => expect(screen.queryByText('Workshop laptop')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/tokens/t1')).toBe(true);
    expect(screen.getByText('Show PC')).toBeTruthy();
  });

  it('does nothing when the revoke is not confirmed', async () => {
    routes['GET /api/tokens'] = () => ({ body: { tokens: TOKENS } });
    autoConfirm(false);
    renderAt(<DevicesSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Show PC' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('shows an empty state', async () => {
    routes['GET /api/tokens'] = () => ({ body: { tokens: [] } });
    renderAt(<DevicesSection />);
    expect(await screen.findByText('No desktop apps signed in.')).toBeTruthy();
  });
});

describe('safeNext', () => {
  it('only allows same-origin paths', () => {
    expect(safeNext('/device?user_code=X')).toBe('/device?user_code=X');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
  });

  it('refuses paths a browser would read as another site', () => {
    // Browsers drop tabs and line breaks from URLs and read "\\" as "/".
    for (const raw of ['/\t/evil.example', '/\n/evil.example', '/\r//evil.example', '/x\\..\\', '/\u0000/a']) {
      expect(safeNext(raw), JSON.stringify(raw)).toBe('/');
    }
    expect(safeNext('/layouts/abc?tab=share#x')).toBe('/layouts/abc?tab=share#x');
  });
});

describe('scopeSummary (P1b scopes)', () => {
  it('says what a device can do, in short', async () => {
    const { scopeSummary } = await import('../DevicesSection');
    expect(scopeSummary({ scopes: ['layouts:read'] })).toBe('Read only');
    expect(scopeSummary({ scopes: ['layouts:read', 'layouts:write'] })).toBe('Read & edit');
    expect(scopeSummary({ scopes: ['layouts:write', 'layouts:create', 'parts:read'] })).toBe('Read & edit, publish layouts, download parts');
    expect(scopeSummary({ scopes: ['layouts:read', 'parts:read', 'parts:write'] })).toBe('Read only, upload & delete parts');
    expect(scopeSummary({ scopes: ['layouts:read', 'venues:read'] })).toBe('Read only, download venues');
    expect(scopeSummary({ scopes: ['layouts:read', 'venues:read', 'venues:write'] })).toBe('Read only, save venues');
    expect(scopeSummary({ scopes: ['layouts:read', 'account:prefs'] })).toBe('Read only, sync settings');
  });

  it('labels every scope on the approval page', async () => {
    const { SCOPE_LABELS } = await import('../DevicePage');
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual([
      'account:prefs',
      'layouts:create',
      'layouts:read',
      'layouts:write',
      'parts:read',
      'parts:write',
      'venues:read',
      'venues:write',
    ]);
    // The desktop can delete your parts and sets on the server too (deletePartsFromDesktop).
    expect(SCOPE_LABELS['parts:write']).toBe('Upload, change and delete your custom parts and sets');
  });
});

