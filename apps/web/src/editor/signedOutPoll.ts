// How the "You were signed out" card finds out that the sign-in is back
// (area 7 part B, 2026-11-10): it asks the server for "me" with a growing
// wait (5 s, 10, 20, 40, then every 60 s), never while the tab is hidden,
// and at once when the tab is looked at again or the browser comes back
// online. Before, it asked every 5 s for as long as the card showed, even
// from a tab nobody was looking at.

/** The waits between checks, in milliseconds: doubling to a 60 s cap. */
export const SIGNED_OUT_POLL_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

/** The wait before check number `n` (0 for the first). */
export function signedOutPollDelay(n: number): number {
  return SIGNED_OUT_POLL_MS[Math.min(Math.max(0, n), SIGNED_OUT_POLL_MS.length - 1)] ?? 60_000;
}

export type SignedOutPollOptions = {
  /** Asks the server; resolves true once signed in again. */
  check: () => Promise<boolean>;
  /** Called once, when `check` first says signed in. */
  onSignedIn: () => void;
  /** For tests; the browser's by default. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>;
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
};

/**
 * Starts the checks; returns the stop. A hidden tab schedules nothing,
 * and picks up (with a check right away) when it's shown again.
 */
export function startSignedOutPoll({ check, onSignedIn, win = window, doc = document }: SignedOutPollOptions): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;

  const clear = (): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    clear();
    if (stopped || doc.hidden) return;
    timer = win.setTimeout(() => void run(false), signedOutPollDelay(attempt));
  };
  /** One check; `fresh` is a check made right away, after which the waits start over at 5 s. */
  const run = async (fresh: boolean): Promise<void> => {
    clear();
    if (stopped || busy) return;
    busy = true;
    const ok = await check().catch(() => false);
    busy = false;
    if (stopped) return;
    if (ok) {
      stopped = true;
      onSignedIn();
      return;
    }
    attempt = fresh ? 0 : attempt + 1;
    schedule();
  };
  // Looked at again (a sign-in in another tab is the usual way back), or
  // back online: check now, and start the waits over.
  const now = (): void => {
    if (doc.hidden) return;
    void run(true);
  };
  const onVisibility = (): void => {
    if (doc.hidden) clear();
    else now();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('focus', now);
  win.addEventListener('online', now);
  schedule();
  return () => {
    stopped = true;
    clear();
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('focus', now);
    win.removeEventListener('online', now);
  };
}
