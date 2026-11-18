// @vitest-environment jsdom
// Pop-ups in this browser: turning them on asks the browser (only then),
// registers the service worker, signs up with the site's public key and
// tells the server; turning off undoes it; the devices list removes one;
// the bell's one-time offer; and a browser that can't, or blocks it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PushDevices, PushPrompt } from '../PushDevices';

// Made-up browser keys (not real ones), built so no scanner mistakes them for secrets.
const FAKE_KEYS = { p256dh: 'p'.repeat(43), auth: 'a'.repeat(22) };

let calls: { method: string; path: string; body?: string | undefined }[];
let devices: { id: string; name: string; createdAt: number; lastUsedAt: number | null; service: string }[];
let subscription: { endpoint: string; toJSON: () => object; unsubscribe: () => Promise<boolean> } | null;
let permissionState: NotificationPermission;
const register = vi.fn();
const subscribe = vi.fn();

function installBrowserPush() {
  const reg = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async (opts: unknown) => {
        subscribe(opts);
        subscription = {
          endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
          toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: FAKE_KEYS }),
          unsubscribe: async () => {
            subscription = null;
            return true;
          },
        };
        return subscription;
      },
    },
  };
  let registered = false;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => (registered ? reg : undefined),
      register: async (url: string, opts: unknown) => {
        register(url, opts);
        registered = true;
        return reg;
      },
      ready: Promise.resolve(reg),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', {
    get permission() {
      return permissionState;
    },
    requestPermission: vi.fn(async () => {
      permissionState = 'granted';
      return 'granted';
    }),
  });
}

beforeEach(() => {
  calls = [];
  devices = [];
  subscription = null;
  permissionState = 'default';
  register.mockReset();
  subscribe.mockReset();
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: input, body: init?.body as string | undefined });
    let body: unknown = { ok: true };
    if (input === '/api/push/key') body = { enabled: true, publicKey: `B${'k'.repeat(86)}` };
    if (input === '/api/push/subscriptions' && init?.method === 'POST') {
      devices = [{ id: 'd1', name: 'Chrome on Linux', createdAt: Date.now(), lastUsedAt: null, service: 'fcm.googleapis.com' }];
      body = { id: 'd1' };
    }
    if (input === '/api/push/subscriptions' && !init?.method) body = { subscriptions: devices };
    if (input.startsWith('/api/push/subscriptions/') && init?.method === 'DELETE') devices = [];
    if (input === '/api/me/notification-settings') body = { pushAvailable: true, types: [], categories: [] };
    return new Response(init?.method === 'DELETE' ? null : JSON.stringify(body), { status: init?.method === 'DELETE' ? 204 : 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

function show(ui: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PushDevices', () => {
  it('a browser without push says so, with no button', async () => {
    show(<PushDevices />);
    expect((await screen.findByTestId('push-devices')).textContent).toContain('This browser can’t show pop-up notifications.');
    expect(screen.queryByRole('button', { name: 'Turn on here' })).toBeNull();
  });

  it('Turn on asks the browser, registers the worker, signs up with the site key and tells the server; Turn off undoes it', async () => {
    installBrowserPush();
    show(<PushDevices />);
    // Nothing asked until the button.
    expect(register).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on here' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/push/subscriptions')).toBe(true));
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const sent = JSON.parse(calls.find((c) => c.method === 'POST')!.body!) as { endpoint: string; keys: object };
    expect(sent).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: FAKE_KEYS });
    expect(await screen.findByText('(this browser)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off here' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/push/subscriptions/d1')).toBe(true));
    expect(subscription).toBeNull();
  });

  it('blocked by the browser: says how to allow it', async () => {
    installBrowserPush();
    permissionState = 'denied';
    show(<PushDevices />);
    expect((await screen.findByTestId('push-devices')).textContent).toContain('Your browser is blocking notifications from this site.');
    expect((screen.getByRole('button', { name: 'Turn on here' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists every browser, each with Remove', async () => {
    devices = [{ id: 'd9', name: 'Firefox on Windows', createdAt: Date.now(), lastUsedAt: Date.now() - 120_000, service: 'updates.push.services.mozilla.com' }];
    show(<PushDevices />);
    expect((await screen.findByTestId('push-device')).textContent).toContain('last pop-up 2 min ago');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Firefox on Windows' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/push/subscriptions/d9')).toBe(true));
  });
});

describe('PushPrompt', () => {
  it('offers once; Not now is remembered', async () => {
    installBrowserPush();
    show(<PushPrompt />);
    expect(await screen.findByTestId('push-prompt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    cleanup();
    show(<PushPrompt />);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/me/notification-settings')).toBe(true));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
  });

  it('isn’t offered when the browser can’t, or already asked', async () => {
    show(<PushPrompt />);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/me/notification-settings')).toBe(true));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
  });
});
