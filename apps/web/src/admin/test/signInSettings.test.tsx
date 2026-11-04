// Admin › Settings › Sign-in: the four settings in days or hours (and
// "never" for a longest), Save only for a valid change, the pair kept in
// order, a forced value shown read only, and the demo line.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SignInSettingState } from '../../api';
import { checkDraft, durationText, SignInSettingsSection } from '../SignInSettings';

const BASE: SignInSettingState[] = [
  { key: 'webIdleHours', app: 'web', kind: 'idle', label: 'Sign out when not used for', help: 'Every visit starts this over.', builtIn: 720, min: 1, max: 8760, allowNever: false, envVar: 'SIGN_IN_WEB_IDLE', value: 720, setting: null, forcedBy: null },
  { key: 'webMaxHours', app: 'web', kind: 'max', label: 'Sign in again after at most', help: 'Even someone who visits every day.', builtIn: 2160, min: 1, max: 87600, allowNever: true, envVar: 'SIGN_IN_WEB_MAX', value: 2160, setting: null, forcedBy: null },
  { key: 'desktopIdleHours', app: 'desktop', kind: 'idle', label: 'Sign out when not used for', help: 'Every time the desktop app talks to this site.', builtIn: 2160, min: 1, max: 8760, allowNever: false, envVar: 'SIGN_IN_DESKTOP_IDLE', value: 2160, setting: null, forcedBy: null },
  { key: 'desktopMaxHours', app: 'desktop', kind: 'max', label: 'Sign in again after at most', help: 'Even a desktop app in daily use.', builtIn: 4320, min: 1, max: 87600, allowNever: true, envVar: 'SIGN_IN_DESKTOP_MAX', value: 4320, setting: null, forcedBy: null },
];

let rows: SignInSettingState[];
let patches: unknown[];

beforeEach(() => {
  rows = BASE.map((r) => ({ ...r }));
  patches = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && input === '/api/admin/settings') {
      return new Response(JSON.stringify({ signIn: { settings: rows } }), { headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PATCH' && input === '/api/admin/settings') {
      patches.push(JSON.parse(init!.body as string));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SignInSettingsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (key: string) => screen.getByTestId(`sign-in-setting-${key}`);

describe('Admin › Settings › Sign-in', () => {
  it('shows the website and desktop settings in days, the help button and the demo line', async () => {
    renderSection();
    expect(await screen.findByRole('heading', { name: /Sign-in/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'On the website' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'In the desktop app' })).toBeTruthy();
    expect((within(row('webIdleHours')).getByRole('spinbutton') as HTMLInputElement).value).toBe('30');
    expect((within(row('desktopMaxHours')).getByRole('spinbutton') as HTMLInputElement).value).toBe('180');
    expect(row('webMaxHours').textContent).toContain('Default: 90 days.');
    expect(screen.getByRole('button', { name: 'Help: How long sign-ins last' })).toBeTruthy();
    expect(screen.getByTestId('sign-in-demo').textContent).toBe('Demo visitors are signed out at each demo reset, and after 24 hours at most.');
    // Nothing changed: no Save buttons.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves a change in hours', async () => {
    renderSection();
    const r = await screen.findByTestId('sign-in-setting-webIdleHours');
    fireEvent.change(within(r).getByRole('spinbutton'), { target: { value: '12' } });
    fireEvent.change(within(r).getByRole('combobox'), { target: { value: 'hours' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toEqual([{ signIn: { webIdleHours: 12 } }]));
  });

  it('offers "never" only for the longest, and saves it', async () => {
    renderSection();
    const idle = await screen.findByTestId('sign-in-setting-webIdleHours');
    expect(within(idle).queryByRole('option', { name: /never/ })).toBeNull();
    const max = row('webMaxHours');
    fireEvent.change(within(max).getByRole('combobox'), { target: { value: 'never' } });
    expect(within(max).queryByRole('spinbutton')).toBeNull();
    fireEvent.click(within(max).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toEqual([{ signIn: { webMaxHours: 'never' } }]));
  });

  it('says what is wrong instead of saving: too short, or a longest under the time unused', async () => {
    renderSection();
    const idle = await screen.findByTestId('sign-in-setting-webIdleHours');
    fireEvent.change(within(idle).getByRole('spinbutton'), { target: { value: '0' } });
    expect(within(idle).getByRole('alert').textContent).toBe('At least 1 hour.');
    expect(within(idle).queryByRole('button', { name: 'Save' })).toBeNull();
    const max = row('webMaxHours');
    fireEvent.change(within(max).getByRole('spinbutton'), { target: { value: '7' } });
    expect(within(max).getByRole('alert').textContent).toBe('Can’t be shorter than “sign out when not used for” (30 days).');
    expect(within(max).queryByRole('button', { name: 'Save' })).toBeNull();
    const dIdle = row('desktopIdleHours');
    fireEvent.change(within(dIdle).getByRole('spinbutton'), { target: { value: '200' } });
    expect(within(dIdle).getByRole('alert').textContent).toBe('Can’t be longer than “sign in again after at most” (180 days).');
    expect(patches).toEqual([]);
  });

  it('shows a value an env var forces, read only, and says which one', async () => {
    rows[1] = { ...rows[1]!, value: 'never', forcedBy: 'SIGN_IN_WEB_MAX' };
    renderSection();
    const max = await screen.findByTestId('sign-in-setting-webMaxHours');
    expect((within(max).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('sign-in-forced-webMaxHours').textContent).toContain('Forced by the server setting SIGN_IN_WEB_MAX (never)');
  });

  it('puts a saved value back to the default', async () => {
    rows[0] = { ...rows[0]!, value: 48, setting: 48 };
    renderSection();
    const idle = await screen.findByTestId('sign-in-setting-webIdleHours');
    expect((within(idle).getByRole('spinbutton') as HTMLInputElement).value).toBe('2');
    fireEvent.click(within(idle).getByRole('button', { name: 'Back to the default (30 days)' }));
    await waitFor(() => expect(patches).toEqual([{ signIn: { webIdleHours: null } }]));
  });
});

describe('the words and checks', () => {
  it('says durations plainly', () => {
    expect(durationText(1)).toBe('1 hour');
    expect(durationText(12)).toBe('12 hours');
    expect(durationText(24)).toBe('1 day');
    expect(durationText(720)).toBe('30 days');
    expect(durationText('never')).toBe('never');
  });

  it('turns a draft into hours, or a reason', () => {
    const s = { min: 1, max: 8760, allowNever: false };
    expect(checkDraft(s, '2', 'days')).toEqual({ value: 48 });
    expect(checkDraft(s, '5', 'hours')).toEqual({ value: 5 });
    expect(checkDraft(s, '', 'days')).toEqual({ error: 'Use a whole number.' });
    expect(checkDraft(s, '1.5', 'days')).toEqual({ error: 'Use a whole number.' });
    expect(checkDraft(s, '366', 'days')).toEqual({ error: 'At most 365 days.' });
    expect(checkDraft(s, '1', 'never')).toEqual({ error: 'Pick a length of time.' });
    expect(checkDraft({ ...s, allowNever: true }, '', 'never')).toEqual({ value: 'never' });
  });
});
