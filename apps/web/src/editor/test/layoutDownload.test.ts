// A layout's first copy comes over HTTP, with progress, before the live
// connection opens (full review area 4, Bug 3 and Idea 2): one big live
// message on a slow link outlasted y-websocket's 30 s timer and started over
// forever.

import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_ORIGIN,
  DOWNLOAD_STALL_MS,
  FIRST_SYNC_GRACE_MS,
  downloadLayout,
  formatBytes,
  getDownloadProgress,
  keepOpenWhileFirstSync,
  subscribeDownloadProgress,
} from '../layoutDownload';
import type { WebsocketProvider } from 'y-websocket';

function layoutBytes(): Uint8Array {
  const doc = new Y.Doc();
  const bricks = doc.getArray<string>('bricks');
  for (let i = 0; i < 2000; i++) bricks.push([`part-${i}`]);
  return Y.encodeStateAsUpdate(doc);
}

/** A response streaming `bytes` in `pieces` chunks. */
function streamed(bytes: Uint8Array, pieces: number, headers: Record<string, string> = {}): Response {
  const size = Math.ceil(bytes.length / pieces);
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
  return new Response(body, { status: 200, headers });
}

afterEach(() => vi.useRealTimers());

describe('downloadLayout', () => {
  it('streams the layout in, telling how far along it is, and marks it as the server’s', async () => {
    const bytes = layoutBytes();
    const seen: (number | null)[] = [];
    const off = subscribeDownloadProgress(() => seen.push(getDownloadProgress()?.loaded ?? null));
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));
    const fetcher = vi.fn(async () => streamed(bytes, 4, { 'x-doc-bytes': String(bytes.length) }));
    expect(await downloadLayout('L1', doc, new AbortController().signal, fetcher as unknown as typeof fetch)).toBe(true);
    off();
    expect(fetcher).toHaveBeenCalledWith('/api/layouts/L1/snapshot', expect.objectContaining({ credentials: 'include' }));
    expect(doc.getArray('bricks').length).toBe(2000);
    expect(origins).toEqual([DOWNLOAD_ORIGIN]);
    // 0, four steps up to everything, then done (null).
    expect(seen[0]).toBe(0);
    expect(seen.filter((n) => n !== null && n > 0).length).toBe(4);
    expect(seen.at(-2)).toBe(bytes.length);
    expect(seen.at(-1)).toBeNull();
    expect(getDownloadProgress()).toBeNull();
  });

  it("leaves it to the live connection when the server won't give it (signed out, not shared)", async () => {
    const doc = new Y.Doc();
    const fetcher = async () => new Response('{"error":"not_found"}', { status: 404 });
    expect(await downloadLayout('L1', doc, new AbortController().signal, fetcher as typeof fetch)).toBe(false);
    expect(doc.store.clients.size).toBe(0);
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await downloadLayout('L1', doc, new AbortController().signal, offline as typeof fetch)).toBe(false);
  });

  it('gives up on a download that stops arriving', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const fetcher = (_u: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([0, 0]));
              init.signal!.addEventListener('abort', () => c.error(new DOMException('stalled', 'AbortError')));
            },
          }),
        ),
      );
    const done = downloadLayout('L1', doc, new AbortController().signal, fetcher as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS + 10);
    expect(await done).toBe(false);
    expect(getDownloadProgress()).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads as KB or MB', () => {
    expect(formatBytes(640 * 1024)).toBe('0.6 MB');
    expect(formatBytes(2.25 * 1024 * 1024)).toBe('2.3 MB');
    expect(formatBytes(30 * 1024)).toBe('30 KB');
    expect(formatBytes(10)).toBe('1 KB');
  });
});

describe('keepOpenWhileFirstSync', () => {
  function fakeProvider() {
    const handlers = new Map<string, ((e: never) => void)[]>();
    const emit = (name: string, e: unknown) => (handlers.get(name) ?? []).forEach((f) => f(e as never));
    return {
      wsLastMessageReceived: 0,
      on: (name: string, f: (e: never) => void) => handlers.set(name, [...(handlers.get(name) ?? []), f]),
      status: (status: string) => emit('status', { status }),
      sync: (isSynced: boolean) => emit('sync', isSynced),
    };
  }

  it("doesn't let the 30 s timer close the socket while the first copy arrives, and does after", () => {
    vi.useFakeTimers();
    const p = fakeProvider();
    keepOpenWhileFirstSync(p as unknown as WebsocketProvider);
    p.wsLastMessageReceived = Date.now();
    p.status('connected');
    vi.advanceTimersByTime(45_000);
    // y-websocket closes when now - wsLastMessageReceived > 30 s.
    expect(Date.now() - p.wsLastMessageReceived).toBeLessThan(30_000);
    // Synced: the timer works as before, on later connections too.
    p.sync(true);
    expect(Date.now() - p.wsLastMessageReceived).toBeGreaterThan(30_000);
    p.sync(false);
    p.status('connected');
    vi.advanceTimersByTime(31_000);
    expect(Date.now() - p.wsLastMessageReceived).toBeGreaterThan(30_000);
  });

  it('gives up waiting after a few minutes without the first copy', () => {
    vi.useFakeTimers();
    const p = fakeProvider();
    keepOpenWhileFirstSync(p as unknown as WebsocketProvider);
    p.wsLastMessageReceived = Date.now();
    p.status('connected');
    vi.advanceTimersByTime(FIRST_SYNC_GRACE_MS + 1);
    expect(Date.now() - p.wsLastMessageReceived).toBeGreaterThan(30_000);
  });
});
