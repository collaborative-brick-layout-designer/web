// The preferences client: GET/PUT shapes, and the debounced writer that
// folds a burst of changes into one PUT of just the changed keys.

import { describe, expect, it, vi } from 'vitest';
import { createPrefsWriter, fetchPreferences, savePreferences } from '../prefsClient';
import { DEFAULT_PREFERENCES } from '../theme';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe('fetchPreferences / savePreferences', () => {
  it('reads {prefs, updatedAt} and cleans unknown values', async () => {
    const f = fakeFetch({ prefs: { theme: 'dark', accent: 'chartreuse' }, updatedAt: '2026-09-30T10:00:00.000Z' });
    const res = await fetchPreferences(f);
    expect(f).toHaveBeenCalledWith('/api/me/preferences', { credentials: 'include' });
    expect(res).toEqual({ prefs: { ...DEFAULT_PREFERENCES, theme: 'dark' }, updatedAt: '2026-09-30T10:00:00.000Z' });
  });

  it('PUTs only the changed keys, wrapped in prefs', async () => {
    const f = fakeFetch({ prefs: { ...DEFAULT_PREFERENCES, accent: 'ocean' }, updatedAt: '2026-09-30T10:00:00.000Z' });
    await savePreferences({ accent: 'ocean' }, f);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/me/preferences');
    expect(init?.method).toBe('PUT');
    // So a change made just before leaving the page still arrives.
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ prefs: { accent: 'ocean' } });
  });

  it('throws on a failed response', async () => {
    await expect(fetchPreferences(fakeFetch({ error: 'unauthorized' }, 401))).rejects.toThrow('401');
  });
});

describe('createPrefsWriter', () => {
  it('debounces a burst into one save with the merged changes', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const w = createPrefsWriter({ save, delayMs: 500 });
      w.queue({ accent: 'ocean' });
      vi.advanceTimersByTime(300);
      w.queue({ accent: 'forest' });
      w.queue({ theme: 'dark' });
      vi.advanceTimersByTime(499);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith({ accent: 'forest', theme: 'dark' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush sends at once; cancel drops what is queued; errors are reported', async () => {
    const save = vi.fn(async () => {
      throw new Error('offline');
    });
    const onError = vi.fn();
    const w = createPrefsWriter({ save, delayMs: 10_000, onError });
    w.queue({ largeText: true });
    await w.flush();
    expect(save).toHaveBeenCalledWith({ largeText: true });
    expect(onError).toHaveBeenCalledTimes(1);
    w.queue({ expertMode: true });
    w.cancel();
    await w.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
