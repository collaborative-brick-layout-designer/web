// The service worker (public/sw.js), run in a fake worker scope: a push
// shows the notification with its link kept to this site; a click marks it
// read, then moves an open tab there (or opens one).

import { describe, expect, it, vi } from 'vitest';
import code from '../../../public/sw.js?raw';

type Handler = (e: Record<string, unknown>) => void;

function load(tabs: { url: string; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[]) {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: 'https://layouts.example' },
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts }) },
    clients: { claim: vi.fn(), matchAll: async () => tabs, openWindow },
  };
  const fakeFetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return new Response('{}');
  };
  // The worker's own code, with its globals (self, fetch) handed in.
  new Function('self', 'fetch', code)(self, fakeFetch);
  return { handlers, shown, fetchCalls, openWindow };
}

async function fire(h: Handler, e: Record<string, unknown>): Promise<void> {
  let waited: Promise<unknown> = Promise.resolve();
  h({ ...e, waitUntil: (p: Promise<unknown>) => (waited = p) });
  await waited;
}

describe('sw.js', () => {
  it('shows a push with its title, body and a link on this site only', async () => {
    const sw = load([]);
    await fire(sw.handlers.push!, { data: { json: () => ({ id: 'n1', title: 'Ann asked to join', body: 'Hi', link: '/orgs/x' }) } });
    await fire(sw.handlers.push!, { data: { json: () => ({ id: 'n2', title: 'Evil', link: 'https://evil.example/' }) } });
    await fire(sw.handlers.push!, { data: { json: () => ({ id: 'n3', link: '//evil.example' }) } });
    expect(sw.shown[0]).toMatchObject({ title: 'Ann asked to join', opts: { body: 'Hi', tag: 'n1', data: { id: 'n1', link: '/orgs/x' } } });
    expect(sw.shown[1]!.opts.data).toEqual({ id: 'n2', link: '/notifications' });
    expect(sw.shown[2]).toMatchObject({ title: 'New notification', opts: { data: { id: 'n3', link: '/notifications' } } });
  });

  it('a click marks it read and moves an open tab to its link', async () => {
    const tab = { url: 'https://layouts.example/', postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
    const sw = load([tab]);
    const close = vi.fn();
    await fire(sw.handlers.notificationclick!, { notification: { close, data: { id: 'n1', link: '/orgs/x' } } });
    expect(close).toHaveBeenCalled();
    expect(sw.fetchCalls[0]).toMatchObject({ url: '/api/notifications/n1/read', init: { method: 'POST', credentials: 'same-origin' } });
    expect(tab.postMessage).toHaveBeenCalledWith({ type: 'cbld-open', path: '/orgs/x' });
    expect(tab.focus).toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('with no tab open, opens one at the link', async () => {
    const sw = load([]);
    await fire(sw.handlers.notificationclick!, { notification: { close: vi.fn(), data: { id: 'n1', link: '/editor/abc' } } });
    expect(sw.openWindow).toHaveBeenCalledWith('https://layouts.example/editor/abc');
  });
});
