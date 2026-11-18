// @vitest-environment jsdom
// What someone who got a warning sees (a banner until "I understand", per
// person, from their notifications), the form senders use, and who a club
// member may warn. The API is a stubbed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationItem } from '../../api';
import { WarningBanner, WarnForm } from '../Notices';
import { mayWarn, MembersSection } from '../../orgs/ClubManage';

const base: NotificationItem = {
  id: 'w1',
  type: 'moderation.warning',
  category: 'moderation',
  title: 'Warning from the site team',
  body: 'Please stop posting spam',
  link: '/catalog',
  createdAt: 1000,
  readAt: null,
  doneAt: null,
  outcome: null,
  outcomeBy: null,
  club: null,
  actor: null,
  subject: { kind: 'warning', id: 'x1' },
  groupKey: null,
  actions: ['acknowledge'],
};

let items: NotificationItem[];
let calls: { method: string; path: string; body?: string | undefined }[];

beforeEach(() => {
  calls = [];
  items = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: input, body: init?.body as string | undefined });
    let body: unknown = { ok: true };
    if (input === '/api/auth/me') body = { user: { id: 'u1', email: 'me@x.com', displayName: 'Me' } };
    if (input.startsWith('/api/notifications?')) body = { notifications: items, nextCursor: null, unread: 0, waiting: 0, warnings: items.length };
    if (input.endsWith('/acknowledge')) {
      items = items.map((n) => (input.includes(n.id) ? { ...n, doneAt: 2000, actions: [] } : n));
      body = { ok: true, acknowledgedAt: 2000 };
    }
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
      <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

describe('WarningBanner', () => {
  it('shows the newest warning waiting for "I understand", then the next', async () => {
    items = [{ ...base, id: 'w2', type: 'moderation.final_warning', title: 'Final warning from Train Club', body: 'Last chance' }, base];
    const qc = show(<WarningBanner />);
    const banner = await screen.findByTestId('notice-banner');
    expect(banner.textContent).toContain('Final warning from Train Club');
    expect(banner.textContent).toContain('(1 of 2)');
    expect(banner.textContent).toContain('Last chance');
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/notifications/w2/acknowledge')).toBe(true));
    // The write refetches the notifications (live/invalidate.ts); then the next one shows.
    await qc.invalidateQueries({ queryKey: ['notifications'] });
    await waitFor(() => expect(screen.getByTestId('notice-banner').textContent).toContain('Please stop posting spam'));
    expect(screen.getByRole('link', { name: "See what it's about" }).getAttribute('href')).toBe('/catalog');
    expect(screen.getByRole('link', { name: 'All notifications' }).getAttribute('href')).toBe('/notifications');
  });

  it('asks only for warnings, and shows nothing once each is understood', async () => {
    items = [{ ...base, doneAt: 5, actions: [] }];
    show(<WarningBanner />);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/api/notifications?'))).toBe(true));
    expect(calls.find((c) => c.path.startsWith('/api/notifications?'))!.path).toContain('type=moderation.warning%2Cmoderation.final_warning');
    expect(screen.queryByTestId('notice-banner')).toBeNull();
  });

  it('stays off the Notifications page, which lists them with their own I understand', async () => {
    items = [base];
    show(<WarningBanner />, '/notifications');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/me')).toBe(true));
    expect(screen.queryByTestId('notice-banner')).toBeNull();
  });
});

describe('WarnForm', () => {
  it('sends the severity, the reason and the link', async () => {
    const onSend = vi.fn(async () => ({ id: 'x' }));
    show(<WarnForm label="Warn Ann" onSend={onSend} />);
    fireEvent.click(screen.getByLabelText('Final warning'));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Rude comments  ' } });
    fireEvent.change(screen.getByLabelText(/Link to what/), { target: { value: '/editor/abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send final warning' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ severity: 'final', reason: 'Rude comments', link: '/editor/abc' }));
    expect(await screen.findByText('Sent.')).toBeTruthy();
  });

  it("won't send without a reason", () => {
    show(<WarnForm label="Warn Ann" onSend={vi.fn()} />);
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('who a club member may warn', () => {
  it('managers warn members; admins warn managers too; nobody warns an admin', () => {
    expect(mayWarn('manager', 'member')).toBe(true);
    expect(mayWarn('manager', 'manager')).toBe(false);
    expect(mayWarn('admin', 'manager')).toBe(true);
    expect(mayWarn('admin', 'admin')).toBe(false);
    expect(mayWarn('member', 'member')).toBe(false);
  });

  it('the Members list offers Warn only where allowed', () => {
    const m = (userId: string, role: 'admin' | 'manager' | 'member') => ({ userId, role, displayName: userId, email: `${userId}@x.com`, avatarUrl: null, joinedAt: 0 });
    show(<MembersSection slug="train" myUserId="bob" myRole="manager" members={[m('ann', 'admin'), m('bob', 'manager'), m('cat', 'member'), m('dee', 'manager')]} />);
    expect(screen.getAllByRole('button', { name: 'Warn' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Warn' }));
    expect(screen.getByRole('form', { name: 'Warn cat' })).toBeTruthy();
  });
});
