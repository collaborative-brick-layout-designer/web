// The demo account in the web app: "Try the demo" on the sign-in page
// (only while it's on), the banner demo visitors see, Admin › Settings ›
// Demo account, and the dashboard's demo line. The API is a stubbed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../../auth/LoginPage';
import { ProfilePage } from '../../auth/ProfilePage';
import { DemoBanner } from '../DemoBanner';
import { DemoAccountSection } from '../../admin/DemoAccount';
import { RESET_EVERY_TEXT, timeUntil } from '../demoText';
import { demoText } from '../../admin/insights/format';
import { keysFor } from '../../live/invalidate';

type Handler = () => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; type: string | null }[];

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/auth/me': () => ({ body: { user: null } }),
    'GET /api/auth/providers': () => ({ body: { providers: [], passwordEnabled: true, demoEnabled: false } }),
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: input, body: init?.body ? JSON.parse(init.body as string) : undefined, type: headers['content-type'] ?? null });
    const h = routes[`${method} ${input}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const { status = 200, body } = h();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderAt(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const NOW = Date.parse('2026-10-02T12:00:00Z');
const demoUser = (demo: Record<string, unknown>) => ({
  user: { id: 'demo-account', email: 'demo-builder@demo.invalid', displayName: 'Demo builder', avatarUrl: null, isDemoAccount: true, isGlobalAdmin: false, linkedProviders: [], demo },
});

describe('Try the demo on the sign-in page', () => {
  it('is hidden while the demo is off', async () => {
    renderAt(<LoginPage />);
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
  });

  it('shows while it is on, and signs in with a JSON POST of {}', async () => {
    routes['GET /api/auth/providers'] = () => ({ body: { providers: [], passwordEnabled: false, demoEnabled: true } });
    routes['POST /api/auth/demo'] = () => ({ body: { ok: true } });
    renderAt(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try the demo' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/demo')).toBe(true));
    const call = calls.find((c) => c.path === '/api/auth/demo')!;
    expect(call).toMatchObject({ method: 'POST', body: {}, type: 'application/json' });
    // With only the demo on, the page doesn't say signing in isn't set up.
    expect(screen.queryByText(/isn’t set up on this site/)).toBeNull();
  });

  it('says so when the demo was switched off meanwhile', async () => {
    routes['GET /api/auth/providers'] = () => ({ body: { providers: [], passwordEnabled: false, demoEnabled: true } });
    routes['POST /api/auth/demo'] = () => ({ status: 404, body: { error: 'demo_off' } });
    renderAt(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try the demo' }));
    expect(await screen.findByText('The demo isn’t available right now.')).toBeTruthy();
  });
});

describe('the demo banner', () => {
  it('tells demo visitors how often it resets and when next', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: '6h', lastResetAt: NOW - 3600_000, nextResetAt: NOW + 5 * 3600_000 + 12 * 60_000 }) });
    renderAt(<DemoBanner />);
    const banner = await screen.findByTestId('demo-banner');
    expect(banner.textContent).toContain('This is a demo. Everything resets every 6 hours (next reset in 5 h 12 min).');
    // A phone gets one short line.
    expect(screen.getByTestId('demo-banner-short').textContent).toBe('Demo · resets in 5 h 12 min');
  });

  it('is not shown to anyone else', async () => {
    routes['GET /api/auth/me'] = () => ({ body: { user: { id: 'u1', email: 'me@x.com', displayName: 'Me', isDemoAccount: false, isGlobalAdmin: false, linkedProviders: [] } } });
    renderAt(<DemoBanner />);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/me')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});

describe('the demo profile', () => {
  it('has no name editing, sign-in linking or desktop devices', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000 }) });
    routes['GET /api/auth/providers'] = () => ({ body: { providers: [{ id: 'google', label: 'Google', enabled: true }], passwordEnabled: false } });
    renderAt(<ProfilePage />);
    expect(await screen.findByText(/Your private demo space/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Linked sign-in methods')).toBeNull();
    expect(screen.queryByText('demo-builder@demo.invalid')).toBeNull();
  });
});

describe('Admin › Settings › Demo account', () => {
  const settings = (demo: Record<string, unknown>) => () => ({ body: { demo } });

  it('is off by default; turning it on saves demoEnabled, and Reset now waits for it', async () => {
    routes['GET /api/admin/settings'] = settings({ enabled: false, resetEvery: 'daily', lastResetAt: null, nextResetAt: null, items: 0 });
    routes['PATCH /api/admin/settings'] = () => ({ body: { ok: true } });
    renderAt(<DemoAccountSection />);
    const box = (await screen.findByLabelText('Enable the demo account')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Reset now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('demo-last-reset').textContent).toBe('Not reset yet · 0 things in it now');
    fireEvent.click(box);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ demoEnabled: true }));
  });

  it('picks how often it resets, resets now, and shows the last reset', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    routes['GET /api/admin/settings'] = settings({ enabled: true, resetEvery: 'daily', lastResetAt: NOW - 3600_000, nextResetAt: NOW + 23 * 3600_000, items: 1 });
    routes['PATCH /api/admin/settings'] = () => ({ body: { ok: true } });
    routes['POST /api/admin/demo/reset'] = () => ({ body: { ok: true, lastResetAt: NOW, items: 3 } });
    renderAt(<DemoAccountSection />);
    expect(((await screen.findByLabelText('Daily')) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('demo-last-reset').textContent).toContain('· next in 23 h · 1 thing in it now');
    fireEvent.click(screen.getByLabelText('1 hour'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ demoResetEvery: '1h' }));
    // Turning it off sends demoEnabled: false.
    fireEvent.click(screen.getByLabelText('Enable the demo account'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toContainEqual({ demoEnabled: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/admin/demo/reset')).toMatchObject({ method: 'POST', body: {}, type: 'application/json' }));
  });
});

describe('demo words', () => {
  it('say how long until the next reset', () => {
    expect(timeUntil(NOW - 1, NOW)).toBe('soon');
    expect(timeUntil(NOW, NOW)).toBe('soon');
    expect(timeUntil(NOW + 59_000, NOW)).toBe('less than a minute');
    expect(timeUntil(NOW + 60_000, NOW)).toBe('1 min');
    expect(timeUntil(NOW + 59 * 60_000, NOW)).toBe('59 min');
    expect(timeUntil(NOW + 60 * 60_000, NOW)).toBe('1 h');
    expect(timeUntil(NOW + 125 * 60_000, NOW)).toBe('2 h 5 min');
    expect(Object.values(RESET_EVERY_TEXT)).toEqual(['every hour', 'every 6 hours', 'every day']);
  });

  it('sum up the demo on the dashboard', () => {
    expect(demoText({ enabled: false, lastResetAt: NOW, items: 3 })).toBe('Off');
    expect(demoText({ enabled: true, lastResetAt: null, items: 1 })).toBe('On · not reset yet · 1 thing');
    expect(demoText({ enabled: true, lastResetAt: NOW, items: 3 })).toMatch(/^On · reset .+ · 3 things$/);
  });

  it('a reset refetches the admin settings and dashboard', () => {
    expect(keysFor({ kind: 'admin' })).toEqual(expect.arrayContaining([['admin-settings'], ['admin-people']]));
  });
});
