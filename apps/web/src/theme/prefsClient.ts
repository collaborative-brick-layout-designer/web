// Talks to GET/PUT /api/me/preferences. Writes are debounced: flicking
// through the colors in Settings sends one PUT with the last choice,
// not one per click. Only the keys that changed are sent; the server
// merges them onto what it has.

import { sanitizePreferences, type Preferences } from './theme';
import { sendThroughRestart } from '../serverRestart';

export interface PreferencesResponse {
  prefs: Preferences;
  updatedAt: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const URL = '/api/me/preferences';

export async function fetchPreferences(fetchImpl: FetchLike = fetch): Promise<PreferencesResponse> {
  const res = await fetchImpl(URL, { credentials: 'include' });
  if (!res.ok) throw new Error(`preferences: ${res.status}`);
  const body = (await res.json()) as { prefs?: unknown; updatedAt?: unknown };
  return { prefs: sanitizePreferences(body.prefs), updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null };
}

export async function savePreferences(changes: Partial<Preferences>, fetchImpl: FetchLike = fetch): Promise<PreferencesResponse> {
  // A server restart is waited out (serverRestart.ts), not shown as an error.
  const res = await sendThroughRestart(() =>
    fetchImpl(URL, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: changes }),
    }),
  );
  if (!res.ok) throw new Error(`preferences: ${res.status}`);
  const body = (await res.json()) as { prefs?: unknown; updatedAt?: unknown };
  return { prefs: sanitizePreferences(body.prefs), updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null };
}

export interface PrefsWriter {
  /** Queue changes; they go out together once nothing new arrives for `delayMs`. */
  queue(changes: Partial<Preferences>): void;
  /** Send whatever is queued now (page hide, sign-out). */
  flush(): Promise<void>;
  cancel(): void;
  /** True while changes are queued or being sent (a refetch would be older). */
  hasPending(): boolean;
}

export function createPrefsWriter(opts: {
  save: (changes: Partial<Preferences>) => Promise<unknown>;
  delayMs?: number;
  onError?: (err: unknown) => void;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}): PrefsWriter {
  const delay = opts.delayMs ?? 600;
  const timers = opts.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let pending: Partial<Preferences> | null = null;
  let handle: unknown = null;
  let sending = 0;

  async function flush(): Promise<void> {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
    if (!pending) return;
    const changes = pending;
    pending = null;
    sending++;
    try {
      await opts.save(changes);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      sending--;
    }
  }

  return {
    queue(changes) {
      pending = { ...(pending ?? {}), ...changes };
      if (handle !== null) timers.clear(handle);
      handle = timers.set(() => {
        handle = null;
        void flush();
      }, delay);
    },
    flush,
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      pending = null;
    },
    hasPending: () => pending !== null || sending > 0,
  };
}
