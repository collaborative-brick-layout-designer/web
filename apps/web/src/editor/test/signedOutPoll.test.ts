// The "You were signed out" card's checks back off, stop while the tab is
// hidden, and check at once when it's shown again or the browser comes
// back online (area 7 part B, 2026-11-10).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT_POLL_MS, signedOutPollDelay, startSignedOutPoll } from '../signedOutPoll';

type Handler = () => void;

function fakeDoc(hidden = false) {
  const handlers = new Map<string, Set<Handler>>();
  const doc = {
    hidden,
    addEventListener: (type: string, h: Handler) => (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(h),
    removeEventListener: (type: string, h: Handler) => void handlers.get(type)?.delete(h),
    fire: (type: string) => handlers.get(type)?.forEach((h) => h()),
  };
  return doc as typeof doc & Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}

function fakeWin() {
  const handlers = new Map<string, Set<Handler>>();
  const win = {
    addEventListener: (type: string, h: Handler) => (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(h),
    removeEventListener: (type: string, h: Handler) => void handlers.get(type)?.delete(h),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    fire: (type: string) => handlers.get(type)?.forEach((h) => h()),
    pending: (type: string) => handlers.get(type)?.size ?? 0,
  };
  return win as typeof win & Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>;
}

const flush = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('signed-out polling', () => {
  it('waits 5, 10, 20, 40 s and then every 60 s', async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(signedOutPollDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(SIGNED_OUT_POLL_MS[SIGNED_OUT_POLL_MS.length - 1]).toBe(60_000);
    const check = vi.fn(async () => false);
    const stop = startSignedOutPoll({ check, onSignedIn: vi.fn(), win: fakeWin(), doc: fakeDoc() });
    await flush(4_999);
    expect(check).toHaveBeenCalledTimes(0);
    await flush(1);
    expect(check).toHaveBeenCalledTimes(1);
    await flush(10_000);
    expect(check).toHaveBeenCalledTimes(2);
    await flush(20_000);
    expect(check).toHaveBeenCalledTimes(3);
    await flush(40_000);
    expect(check).toHaveBeenCalledTimes(4);
    await flush(60_000);
    expect(check).toHaveBeenCalledTimes(5);
    await flush(60_000);
    expect(check).toHaveBeenCalledTimes(6);
    // In the old every-5-s scheme that would have been 39 checks.
    stop();
    await flush(600_000);
    expect(check).toHaveBeenCalledTimes(6);
  });

  it('stops once signed in, and says so once', async () => {
    let signedIn = false;
    const check = vi.fn(async () => signedIn);
    const onSignedIn = vi.fn();
    startSignedOutPoll({ check, onSignedIn, win: fakeWin(), doc: fakeDoc() });
    await flush(5_000);
    expect(onSignedIn).not.toHaveBeenCalled();
    signedIn = true;
    await flush(10_000);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    await flush(600_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('does not ask while the tab is hidden, and asks at once when shown again', async () => {
    const doc = fakeDoc(true);
    const check = vi.fn(async () => false);
    startSignedOutPoll({ check, onSignedIn: vi.fn(), win: fakeWin(), doc });
    await flush(600_000);
    expect(check).toHaveBeenCalledTimes(0);
    doc.hidden = false;
    doc.fire('visibilitychange');
    await flush(0);
    expect(check).toHaveBeenCalledTimes(1);
    // The waits start over from 5 s.
    await flush(5_000);
    expect(check).toHaveBeenCalledTimes(2);
    // Hidden again mid-wait: the pending check is dropped.
    doc.hidden = true;
    doc.fire('visibilitychange');
    await flush(600_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('asks at once when the browser comes back online or the window is focused', async () => {
    const win = fakeWin();
    const check = vi.fn(async () => false);
    const stop = startSignedOutPoll({ check, onSignedIn: vi.fn(), win, doc: fakeDoc() });
    win.fire('online');
    await flush(0);
    expect(check).toHaveBeenCalledTimes(1);
    win.fire('focus');
    await flush(0);
    expect(check).toHaveBeenCalledTimes(2);
    expect(win.pending('online')).toBe(1);
    stop();
    expect(win.pending('online')).toBe(0);
    expect(win.pending('focus')).toBe(0);
  });

  it('treats a failed request as still signed out', async () => {
    const check = vi.fn(async () => {
      throw new Error('offline');
    });
    const onSignedIn = vi.fn();
    startSignedOutPoll({ check, onSignedIn, win: fakeWin(), doc: fakeDoc() });
    await flush(15_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
