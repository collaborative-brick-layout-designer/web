// The demo account in the web app: "Try the demo" on the sign-in page
// (only while it's on), the banner demo visitors see, Admin › Settings ›
// Demo account, and the dashboard's demo line. The API is a stubbed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('tells a visitor how long their space has left, and ticks down by itself', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, spaceMinutes: 60, expiresAt: NOW + 45 * 60_000 }) });
    renderAt(<DemoBanner />);
    const text = await screen.findByTestId('demo-banner-text');
    expect(text.textContent).toBe('Your demo space is yours for about 45 more minutes.');
    expect(screen.getByTestId('demo-banner').getAttribute('data-state')).toBe('running');
    expect(screen.queryByTestId('demo-banner-download')).toBeNull();
    // Ten minutes go by with no refresh.
    await act(async () => {
      vi.setSystemTime(NOW + 10 * 60_000);
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId('demo-banner-text').textContent).toBe('Your demo space is yours for about 35 more minutes.');
  });

  it('says it is ending soon in the last 5 minutes and offers to download the layout', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, spaceMinutes: 60, expiresAt: NOW + 6 * 60_000 }) });
    renderAt(<DemoBanner />);
    expect((await screen.findByTestId('demo-banner-text')).textContent).toContain('yours for about 6 more minutes');
    await act(async () => {
      vi.setSystemTime(NOW + 2 * 60_000);
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId('demo-banner').getAttribute('data-state')).toBe('ending');
    expect(screen.getByTestId('demo-banner-text').textContent).toBe('Your demo space is ending soon: 3 min left.');
    // Not in an editor: it points to the layouts instead of a dead link.
    expect(screen.getByTestId('demo-banner-download').getAttribute('href')).toBe('/');
  });

  it('downloads the open layout from an editor', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, spaceMinutes: 60, expiresAt: Date.now() + 2 * 60_000 }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/editor/abc-123']}>
          <DemoBanner placement="inline" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = await screen.findByTestId('demo-banner-download');
    expect(link.textContent).toBe('Download this layout');
    expect(link.getAttribute('href')).toBe('/api/layouts/abc-123/export.bld-layout');
  });

  it('in an editor, sits in the page flow (the editor shows it), never floating over the tabs', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, spaceMinutes: 60, expiresAt: Date.now() + 30 * 60_000 }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/editor/abc-123']}>
          <DemoBanner />
          <DemoBanner placement="inline" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const shown = await screen.findAllByTestId('demo-banner');
    expect(shown.map((b) => b.getAttribute('data-placement'))).toEqual(['inline']);
    expect(shown[0]!.closest('.fixed')).toBeNull();
  });

  it('asks who is signed in again when the time is up', async () => {
    routes['GET /api/auth/me'] = () => ({ body: demoUser({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, spaceMinutes: 60, expiresAt: Date.now() - 1000 }) });
    renderAt(<DemoBanner />);
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/me').length).toBeGreaterThan(1));
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

  it('picks how long each demo space lasts (1 hour by default), with help', async () => {
    routes['GET /api/admin/settings'] = settings({ enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, items: 1, spaceMinutes: 60 });
    routes['PATCH /api/admin/settings'] = () => ({ body: { ok: true } });
    renderAt(<DemoAccountSection />);
    const group = await screen.findByTestId('demo-lifetime');
    const radios = Array.from(group.querySelectorAll('input[type=radio]')) as HTMLInputElement[];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(['30 minutes', '1 hour', '2 hours', '6 hours', '24 hours']);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false, false, false]);
    expect(group.querySelector('[data-help-key="admin.demoLifetime"]')).not.toBeNull();
    fireEvent.click(radios[2]!);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ demoSpaceMinutes: 120 }));
  });

  it('picks how often it resets, resets now, and shows the last reset', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    routes['GET /api/admin/settings'] = settings({ enabled: true, resetEvery: 'daily', lastResetAt: NOW - 3600_000, nextResetAt: NOW + 23 * 3600_000, items: 1 });
    routes['PATCH /api/admin/settings'] = () => ({ body: { ok: true } });
    routes['POST /api/admin/demo/reset'] = () => ({ body: { ok: true, lastResetAt: NOW, items: 3 } });
    renderAt(<DemoAccountSection />);
    expect(((await screen.findByLabelText('Daily')) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('demo-last-reset').textContent).toContain('· next in 23 h · 1 thing in it now');
    fireEvent.click(screen.getAllByLabelText('1 hour')[1]!);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ demoResetEvery: '1h' }));
    // Turning it off sends demoEnabled: false.
    fireEvent.click(screen.getByLabelText('Enable the demo account'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toContainEqual({ demoEnabled: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/admin/demo/reset')).toMatchObject({ method: 'POST', body: {}, type: 'application/json' }));
  });
});

describe('Admin › Settings › Demo account: what one visitor may take', () => {
  const limit = (key: string, label: string, unit: string, value: number, def: number, extra: Record<string, unknown> = {}) => ({
    key, label, help: `${label} help.`, unit, applies: 'demo', value, default: def, builtIn: def, envVar: `LIMIT_${key}`, fromEnv: false, changedHere: value !== def, ...extra,
  });
  let limits: ReturnType<typeof limit>[];
  beforeEach(() => {
    limits = [
      { ...limit('layoutsPerUser', 'Layouts per person', 'count', 500, 500), applies: 'user' },
      limit('storagePerDemoSpace', 'Space for each demo space', 'bytes', 50 * 1024 * 1024, 50 * 1024 * 1024),
      limit('demoSpacesPerAddress', 'Demo spaces from one network address', 'count', 10, 10),
    ];
    routes['GET /api/admin/settings'] = () => ({ body: { demo: { enabled: true, resetEvery: 'daily', lastResetAt: NOW, nextResetAt: NOW + 86400_000, items: 1, maxSpaces: 100, liveSpaces: 0, spaceMinutes: 60 } } });
    routes['GET /api/admin/limits'] = () => ({ body: { enforced: true, enforcedSetting: true, enforcementSource: 'setting', limits } });
    routes['PATCH /api/admin/limits'] = () => {
      const body = calls.at(-1)!.body as Record<string, number | null>;
      limits = limits.map((l) => (l.key in body ? { ...l, value: body[l.key] ?? l.default, changedHere: body[l.key] !== null } : l));
      return { body: { ok: true } };
    };
  });

  it('shows the space for each demo space in MB and the spaces per address, each with help, and saves a change', async () => {
    renderAt(<DemoAccountSection />);
    const room = await screen.findByTestId('demo-limit-storagePerDemoSpace');
    const roomBox = within(room).getByLabelText('Space for each demo space (MB)') as HTMLInputElement;
    expect(roomBox.value).toBe('50');
    expect(room.querySelector('[data-help-key="admin.demoStorage"]')).not.toBeNull();
    expect(room.textContent).toContain('Default: 50 MB.');
    // Nothing changed: no Save.
    expect(within(room).queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(roomBox, { target: { value: '20' } });
    fireEvent.click(within(room).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/admin/limits', body: { storagePerDemoSpace: 20 * 1024 * 1024 } }));
    // The saved value shows by itself, and Save goes.
    await waitFor(() => expect((within(screen.getByTestId('demo-limit-storagePerDemoSpace')).getByLabelText('Space for each demo space (MB)') as HTMLInputElement).value).toBe('20'));
    expect(within(screen.getByTestId('demo-limit-storagePerDemoSpace')).queryByRole('button', { name: 'Save' })).toBeNull();

    const per = screen.getByTestId('demo-limit-demoSpacesPerAddress');
    const perBox = within(per).getByLabelText('Demo spaces from one network address') as HTMLInputElement;
    expect(perBox.value).toBe('10');
    expect(per.querySelector('[data-help-key="admin.demoPerAddress"]')).not.toBeNull();
    fireEvent.change(perBox, { target: { value: '3' } });
    fireEvent.click(within(per).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ demoSpacesPerAddress: 3 }));
  });

  it('going back to the default clears the setting, and a bad value can’t be saved', async () => {
    limits[2] = limit('demoSpacesPerAddress', 'Demo spaces from one network address', 'count', 3, 10);
    renderAt(<DemoAccountSection />);
    const per = await screen.findByTestId('demo-limit-demoSpacesPerAddress');
    const perBox = within(per).getByLabelText('Demo spaces from one network address') as HTMLInputElement;
    fireEvent.change(perBox, { target: { value: 'lots' } });
    expect(within(per).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(per.textContent).toContain('Choose a whole number, 0 or more.');
    fireEvent.change(perBox, { target: { value: '10' } });
    fireEvent.click(within(per).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ demoSpacesPerAddress: null }));
    // Under 1 MB a visitor couldn't save anything.
    const room = screen.getByTestId('demo-limit-storagePerDemoSpace');
    fireEvent.change(within(room).getByLabelText('Space for each demo space (MB)'), { target: { value: '0.5' } });
    expect(within(room).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(room.textContent).toContain('Choose 1 MB or more.');
  });

  it('a value forced by the server’s settings says so', async () => {
    limits[1] = limit('storagePerDemoSpace', 'Space for each demo space', 'bytes', 20 * 1024 * 1024, 20 * 1024 * 1024, { fromEnv: true, envVar: 'LIMIT_STORAGE_PER_DEMO_SPACE' });
    renderAt(<DemoAccountSection />);
    const room = await screen.findByTestId('demo-limit-storagePerDemoSpace');
    expect(room.textContent).toContain('Set by LIMIT_STORAGE_PER_DEMO_SPACE.');
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
