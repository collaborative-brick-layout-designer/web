// @vitest-environment jsdom
// Settings › Notifications against a stubbed API: categories open to their
// types, each change saves at once, warnings can't leave the app, invite
// emails are always sent, quiet hours, summaries, clubs, pause all, the
// time zone following the browser, and the page behind "Stop these emails".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationSettingsView } from '../../api';
import { NotificationSettings } from '../NotificationSettings';
import { UnsubscribePage } from '../UnsubscribePage';

const base = (): NotificationSettingsView => ({
  categories: ['moderation', 'clubs', 'sharing', 'shared_modules', 'account'],
  types: [
    { type: 'moderation.warning', category: 'moderation', label: 'Warnings', waits: true, appLocked: true, emailApart: null, app: true, email: 'now', push: true },
    { type: 'club.join_request', category: 'clubs', label: 'Requests to join a club you run', waits: true, appLocked: false, emailApart: null, app: true, email: 'now', push: true },
    { type: 'club.invite', category: 'clubs', label: 'Invites to join a club', waits: true, appLocked: false, emailApart: 'invite', app: true, email: 'off', push: true },
  ],
  quiet: { on: false, start: '22:00', end: '07:00' },
  timeZone: 'Europe/London',
  dailyAt: '08:00',
  weeklyDay: 1,
  pauseEmail: false,
  pausePush: false,
  clubs: [{ id: 'o1', name: 'ArkLUG', slug: 'arklug', mute: false, email: true, push: true }],
  emailAvailable: true,
  pushAvailable: false,
});

let view: NotificationSettingsView;
let puts: Record<string, unknown>[];

beforeEach(() => {
  view = base();
  puts = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    let body: unknown = { ok: true };
    if (input === '/api/me/notification-settings') {
      if (init?.method === 'PUT') puts.push((JSON.parse(init.body as string) as { settings: Record<string, unknown> }).settings);
      body = view;
    } else if (input.startsWith('/api/notifications/unsubscribe')) {
      body = input.includes('t=bad') ? null : { ok: true, scope: 'club.join_request', what: 'emails about “Requests to join a club you run”' };
      if (!body) return new Response(JSON.stringify({ error: 'invalid_link' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(ui: React.ReactNode, at = '/settings') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationSettings', () => {
  it('opens a category to its types and saves each choice at once', async () => {
    show(<NotificationSettings />);
    const clubs = await screen.findByTestId('notification-category-clubs');
    expect(clubs.textContent).toContain('2 kinds · 1 by email');
    const row = within(clubs).getAllByTestId('notification-type-row').find((r) => r.dataset.type === 'club.join_request')!;
    fireEvent.change(within(row).getByRole('combobox', { name: 'Requests to join a club you run: email' }), { target: { value: 'daily' } });
    await waitFor(() => expect(puts).toContainEqual({ types: { 'club.join_request': { email: 'daily' } } }));
    fireEvent.click(within(row).getByRole('switch', { name: 'Requests to join a club you run: in the app' }));
    await waitFor(() => expect(puts).toContainEqual({ types: { 'club.join_request': { app: false } } }));
    // Invites come with their link, always.
    const invite = within(clubs).getAllByTestId('notification-type-row').find((r) => r.dataset.type === 'club.invite')!;
    expect(invite.textContent).toContain('Emailed with the invite’s link, always.');
    expect(within(invite).queryByRole('combobox')).toBeNull();
  });

  it('warnings stay in the app, and say why', async () => {
    show(<NotificationSettings />);
    const mod = await screen.findByTestId('notification-category-moderation');
    const sw = within(mod).getByRole('switch', { name: 'Warnings: in the app' });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(mod.textContent).toContain('Warnings always show, so you never miss one.');
  });

  it('quiet hours, summaries, clubs and pause all', async () => {
    show(<NotificationSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Quiet hours' }));
    await waitFor(() => expect(puts).toContainEqual({ quiet: { on: true } }));
    fireEvent.change(screen.getByLabelText('Daily summary time'), { target: { value: '18:30' } });
    await waitFor(() => expect(puts).toContainEqual({ dailyAt: '18:30' }));
    fireEvent.change(screen.getByLabelText('Weekly summary day'), { target: { value: '5' } });
    await waitFor(() => expect(puts).toContainEqual({ weeklyDay: 5 }));
    fireEvent.click(screen.getByRole('switch', { name: 'Mute ArkLUG' }));
    await waitFor(() => expect(puts).toContainEqual({ clubs: { o1: { mute: true } } }));
    fireEvent.click(screen.getByRole('switch', { name: 'Email from ArkLUG' }));
    await waitFor(() => expect(puts).toContainEqual({ clubs: { o1: { email: false } } }));
    fireEvent.click(screen.getByRole('switch', { name: 'Pause all email' }));
    await waitFor(() => expect(puts).toContainEqual({ pauseEmail: true }));
    // No pop-ups until push is here.
    expect(screen.queryByRole('switch', { name: 'Pause all pop-ups' })).toBeNull();
  });

  it('follows the browser’s time zone until one is picked', async () => {
    view.timeZone = null;
    show(<NotificationSettings />);
    await waitFor(() => expect(puts.some((p) => typeof p.timeZone === 'string')).toBe(true));
  });

  it('says when the site can’t send email', async () => {
    view.emailAvailable = false;
    show(<NotificationSettings />);
    expect((await screen.findByTestId('email-unavailable')).textContent).toMatch(/can’t send email/);
  });
});

describe('UnsubscribePage', () => {
  it('asks first, then stops them', async () => {
    show(<UnsubscribePage />, '/unsubscribe?t=good');
    expect(await screen.findByText(/Stop emails about “Requests to join a club you run”\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop these emails' }));
    expect((await screen.findByTestId('unsubscribe-done')).textContent).toMatch(/You won’t get emails about/);
  });
  it('says so when the link is bad', async () => {
    show(<UnsubscribePage />, '/unsubscribe?t=bad');
    expect(await screen.findByText(/This link doesn’t work/)).toBeTruthy();
  });
});
