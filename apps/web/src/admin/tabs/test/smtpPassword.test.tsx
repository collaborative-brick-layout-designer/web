// Admin › Settings › SMTP server: the saved password is never shown, only
// that one is set; when the server can't read it any more (its key file is
// gone or another one) the page says so and asks for it again, and saving
// a new one clears the message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../limits/LimitsUi', () => ({ GlobalLimitsForm: () => null }));
vi.mock('../../Moderation', () => ({ CatalogSettingsSection: () => null }));
vi.mock('../../ServerSetup', () => ({ BackgroundJobsSection: () => null, ServerSetupSection: () => null }));
vi.mock('../../DemoAccount', () => ({ DemoAccountSection: () => null }));
vi.mock('../../../privacy/PrivacySettings', () => ({ PrivacySettingsSection: () => null }));
vi.mock('../../SignInSettings', () => ({ SignInSettingsSection: () => null }));

import { SettingsTab } from '../SettingsTab';

let smtp: { host: string | null; port: number | null; user: string | null; from: string | null; passSet: boolean; passUnreadable: boolean; source: 'database' | 'env' | null; active: boolean };
let patches: Record<string, unknown>[];
let refuseWith: string | null;

beforeEach(() => {
  smtp = { host: 'smtp.example.com', port: 587, user: 'mailer', from: 'noreply@example.com', passSet: true, passUnreadable: false, source: 'database', active: true };
  patches = [];
  refuseWith = null;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && input === '/api/admin/settings') {
      return json({ requireEmailVerification: true, smtp, desktop: { minimumSet: null, minimum: '2.0.0', recommended: '2.0.0', codeMinimum: '2.0.0' } });
    }
    if (method === 'PATCH' && input === '/api/admin/settings') {
      if (refuseWith) return json({ error: refuseWith }, 500);
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      patches.push(body);
      if (typeof body.smtpPass === 'string' && body.smtpPass !== '') smtp = { ...smtp, passSet: true, passUnreadable: false, active: true };
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsTab />
    </QueryClientProvider>,
  );
}

const passwordBox = () => screen.getByLabelText('Password') as HTMLInputElement;

describe('Admin › Settings › SMTP password', () => {
  it('shows only that a password is set, never the password', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'SMTP server' });
    expect(passwordBox().value).toBe('');
    expect(passwordBox().placeholder).toContain('set');
    expect(screen.queryByTestId('smtp-pass-unreadable')).toBeNull();
    expect(screen.getByText('Using the configuration below.')).toBeTruthy();
  });

  it('says when the saved password can’t be read, and entering it again clears that', async () => {
    smtp = { ...smtp, passUnreadable: true, active: false };
    renderTab();
    const alert = await screen.findByTestId('smtp-pass-unreadable');
    expect(alert.textContent).toContain("The SMTP password can't be read. Please enter it again.");
    expect(alert.getAttribute('role')).toBe('alert');
    expect(passwordBox().placeholder).toBe('Enter the password again');
    // It doesn't claim the saved configuration is in use.
    expect(screen.queryByText('Using the configuration below.')).toBeNull();

    fireEvent.change(passwordBox(), { target: { value: 'the-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.smtpPass).toBe('the-new-password');
    // The page asks again by itself: no refresh needed.
    await waitFor(() => expect(screen.queryByTestId('smtp-pass-unreadable')).toBeNull());
    expect(passwordBox().value).toBe('');
    expect(screen.getByText('Using the configuration below.')).toBeTruthy();
  });

  it('a save that leaves the password box alone doesn’t send one', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'SMTP server' });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect('smtpPass' in patches[0]!).toBe(false);
  });

  it('says in plain words when the server can’t keep the password', async () => {
    refuseWith = 'secret_key_unavailable';
    renderTab();
    await screen.findByRole('heading', { name: 'SMTP server' });
    fireEvent.change(passwordBox(), { target: { value: 'x-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/The password wasn’t saved: the server can’t read or make its key file/)).toBeTruthy();
  });
});
