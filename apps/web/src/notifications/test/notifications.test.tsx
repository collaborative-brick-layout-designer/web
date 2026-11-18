// @vitest-environment jsdom
// The bell, its panel and the Notifications page, against a stubbed API:
// the unread badge (99+), All / Unread and the type filter, grouping,
// Accept and Decline (with the club page's confirm for a join request),
// "someone else answered", mark read / unread / all, search and more pages.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationItem } from '../../api';
import { NotificationBell } from '../NotificationBell';
import { NotificationsPage } from '../NotificationsPage';
import { badgeText, groupNotifications, outcomeText, timeAgo } from '../model';
import { ConfirmDialogHost } from '../../ui/ConfirmDialog';

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: 'n1',
  type: 'club.join_request',
  category: 'clubs',
  title: 'Ann asked to join ArkLUG',
  body: 'Their note: “Hi”',
  link: '/orgs/arklug/admin?tab=people',
  createdAt: Date.now() - 60_000,
  readAt: null,
  doneAt: null,
  outcome: null,
  outcomeBy: null,
  club: { id: 'o1', name: 'ArkLUG', slug: 'arklug' },
  actor: { id: 'u2', name: 'Ann' },
  subject: { kind: 'join_request', id: 'r1' },
  groupKey: 'join:o1',
  actions: ['accept', 'decline'],
  ...over,
});

let items: NotificationItem[];
let unread: number;
let calls: { method: string; path: string; body?: string | undefined }[];
let actReply: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  items = [];
  unread = 0;
  actReply = { ok: true, outcome: 'accepted', notification: null };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: input, body: init?.body as string | undefined });
    let body: unknown = { ok: true };
    if (input === '/api/auth/me') body = { user: { id: 'u1', email: 'me@x.com', displayName: 'Me' } };
    else if (input === '/api/notifications/count') body = { unread, waiting: 0, warnings: 0 };
    else if (input === '/api/notifications/types')
      body = {
        categories: ['moderation', 'clubs', 'sharing', 'shared_modules', 'account'],
        types: [
          { type: 'club.join_request', category: 'clubs', label: 'Requests to join a club you run', waits: true, action: 'accept-decline' },
          { type: 'account.export_ready', category: 'account', label: 'Your data download is ready', waits: true, action: null },
        ],
      };
    else if (input.startsWith('/api/notifications?') || input === '/api/notifications') {
      const url = new URL(input, 'http://x');
      let list = items;
      if (url.searchParams.get('unread')) list = list.filter((n) => !n.readAt);
      if (url.searchParams.get('type')) list = list.filter((n) => n.type === url.searchParams.get('type'));
      const q = url.searchParams.get('q');
      if (q) list = list.filter((n) => n.title.includes(q));
      const limit = Number(url.searchParams.get('limit') ?? 30);
      const from = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      body = { notifications: list.slice(from, from + limit), nextCursor: from + limit < list.length ? String(from + limit) : null, unread, waiting: 0, warnings: 0 };
    } else if (input.endsWith('/act')) body = actReply;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(ui: React.ReactNode, at = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        {ui}
        <ConfirmDialogHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('model', () => {
  it('caps the badge at 99+', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
  it('groups by key, newest first, others alone', () => {
    const g = groupNotifications([item({ id: 'a' }), item({ id: 'b', groupKey: null }), item({ id: 'c' })]);
    expect(g.map((x) => [x.head.id, x.rest.map((r) => r.id)])).toEqual([['a', ['c']], ['b', []]]);
  });
  it('says how a request was answered, and by whom', () => {
    expect(outcomeText({ type: 'club.join_request', outcome: 'accepted', outcomeBy: { id: 'u1', name: 'Me', you: true } })).toBe('You let them in');
    expect(outcomeText({ type: 'club.partner_request', outcome: 'declined', outcomeBy: { id: 'u2', name: 'Ann', you: false } })).toBe('Ann declined');
    expect(outcomeText({ type: 'sharing.layout_invite', outcome: 'withdrawn', outcomeBy: null })).toBe('Taken back, so nothing to answer');
    expect(outcomeText({ type: 'x', outcome: null, outcomeBy: null })).toBeNull();
  });
  it('says when, in plain words', () => {
    const now = 1_800_000_000_000;
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
});

describe('NotificationBell', () => {
  it('shows the unread count, 99+ past 99, and none at zero', async () => {
    unread = 120;
    show(<NotificationBell />);
    expect((await screen.findByTestId('notification-badge')).textContent).toBe('99+');
    expect(screen.getByRole('button', { name: 'Notifications, 120 unread' })).toBeTruthy();
    cleanup();
    unread = 0;
    show(<NotificationBell />);
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/notifications/count').length).toBeGreaterThan(1));
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  it('opens the panel with grouped items, filters, and a link to the full page', async () => {
    unread = 2;
    items = [item({ id: 'a' }), item({ id: 'b', title: 'Bob asked to join ArkLUG' }), item({ id: 'c', type: 'account.export_ready', title: 'Your data download is ready', groupKey: null, actions: [], readAt: 5, club: null })];
    show(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    const panel = await screen.findByTestId('notification-panel');
    await within(panel).findByText('Ann asked to join ArkLUG');
    // Bob's request is in Ann's group, one tap away.
    expect(within(panel).queryByText('Bob asked to join ArkLUG')).toBeNull();
    fireEvent.click(within(panel).getByTestId('notification-group-toggle'));
    expect(within(panel).getByText('Bob asked to join ArkLUG')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'See all notifications' }).getAttribute('href')).toBe('/notifications');
    // Unread only.
    fireEvent.click(within(panel).getByRole('radio', { name: /Unread/ }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('unread=1'))).toBe(true));
    await waitFor(() => expect(within(within(panel).getByTestId('notification-list')).queryByText('Your data download is ready')).toBeNull());
    // A type.
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Type of notification' }), { target: { value: 'account.export_ready' } });
    await waitFor(() => expect(calls.some((c) => c.path.includes('type=account.export_ready'))).toBe(true));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Type of notification' }), { target: { value: 'cat:clubs' } });
    await waitFor(() => expect(calls.some((c) => c.path.includes('category=clubs'))).toBe(true));
  });

  it('Mark all as read, and one at a time read or unread', async () => {
    unread = 1;
    items = [item({ id: 'a', actions: [], type: 'club.join_approved', groupKey: null })];
    show(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    const panel = await screen.findByTestId('notification-panel');
    await within(panel).findByText('Ann asked to join ArkLUG');
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(posted('/api/notifications/read-all')).toHaveLength(1));
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark “Ann asked to join ArkLUG” as read' }));
    await waitFor(() => expect(posted('/api/notifications/a/read')).toHaveLength(1));
  });

  it('Accept answers in place; Decline of a join request asks first, as the club page does', async () => {
    unread = 1;
    items = [item({ id: 'a' })];
    show(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    const panel = await screen.findByTestId('notification-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Let them in' }));
    await waitFor(() => expect(posted('/api/notifications/a/act')).toHaveLength(1));
    expect(JSON.parse(posted('/api/notifications/a/act')[0]!.body!)).toEqual({ action: 'accept' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Decline' }));
    const dialog = (await screen.findAllByRole('alertdialog')).find((d) => d.textContent?.includes('Decline this request?'))!;
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Decline' }).at(-1)!);
    await waitFor(() => expect(posted('/api/notifications/a/act')).toHaveLength(2));
    expect(JSON.parse(posted('/api/notifications/a/act')[1]!.body!)).toEqual({ action: 'decline' });
  });

  it('an answered request shows who answered, with no buttons', async () => {
    items = [item({ id: 'a', actions: [], doneAt: 5, outcome: 'accepted', outcomeBy: { id: 'u3', name: 'Cat', you: false } })];
    show(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect((await screen.findByTestId('notification-outcome')).textContent).toBe('Cat let them in');
    expect(screen.queryByRole('button', { name: 'Let them in' })).toBeNull();
  });

  it('says so when there is nothing', async () => {
    show(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect((await screen.findByTestId('notification-empty')).textContent).toMatch(/Nothing yet/);
  });
});

describe('NotificationsPage', () => {
  it('searches, shows more pages, and marks the selected ones read', async () => {
    unread = 40;
    items = Array.from({ length: 40 }, (_, i) => item({ id: `n${i}`, title: `Thing ${i}`, groupKey: null, actions: [], type: 'account.export_ready' }));
    show(<NotificationsPage />, '/notifications');
    await screen.findByText('Thing 0');
    expect(screen.queryByText('Thing 35')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('Thing 35');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Thing 1”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Thing 2”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark selected as read (2)' }));
    await waitFor(() => expect(posted('/api/notifications/read-all')).toHaveLength(1));
    expect(JSON.parse(posted('/api/notifications/read-all')[0]!.body!)).toEqual({ ids: ['n1', 'n2'] });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notifications' }), { target: { value: 'Thing 7' } });
    await waitFor(() => expect(calls.some((c) => c.path.includes('q=Thing+7'))).toBe(true));
  });
});
