// Whether this browser was in the demo: so a page that finds itself signed
// out (a demo reset signs every visitor out) can say "The demo was reset.
// Start again?" instead of a plain sign-in screen, even after the tab was
// closed and opened again. Signing out on purpose forgets it.

const KEY = 'cld-demo-visitor';

/** Fired when a live layout ended because its sign-in did (useLayoutDoc). */
export const SIGN_IN_ENDED_EVENT = 'cld-sign-in-ended';

export function markDemoVisitor(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* storage off: the notice then only shows while the page stays open */
  }
}

export function forgetDemoVisitor(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage off */
  }
}

export function wasDemoVisitor(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** A live connection was closed because its sign-in ended: whoever shows the demo notice checks. */
export function announceSignInEnded(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGN_IN_ENDED_EVENT));
}
