// A server restart is over in a second or two: a save that meets a 502,
// 503 or 504 (the proxy has nothing to talk to yet) or a network failure
// is tried again after 1, 2, 4, 8 and 15 seconds (about 30 in all), with a
// calm note ("Saving… the server is restarting, trying again") instead of
// an error. Only when it still fails after that does the caller show a real
// error. A 4xx (409 module_changed, 403, 422…) is an answer and is never
// retried. Used for saves that are safe to send twice: PUT and PATCH.

/** How long to wait before each new try, in ms. */
export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

/** The statuses a proxy answers while the app behind it is down or starting. */
export function isRestartStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

let waiting = 0;
const listeners = new Set<() => void>();

/** For useSyncExternalStore: is any save waiting for the server to come back? */
export function serverRestarting(): boolean {
  return waiting > 0;
}
export function onServerRestarting(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setWaiting(delta: number): void {
  waiting = Math.max(0, waiting + delta);
  for (const fn of listeners) fn();
}

/**
 * Send a request, trying again while the server is restarting. Returns the
 * last response (the caller turns a still-failing one into its error), or
 * throws the last network error. An abort is never retried.
 */
export async function sendThroughRestart(send: () => Promise<Response>): Promise<Response> {
  let waited = false;
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await send();
        if (!isRestartStatus(res.status)) return res;
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        if (attempt >= RESTART_BACKOFF_MS.length) throw e;
      }
      const delay = RESTART_BACKOFF_MS[attempt];
      if (delay === undefined) return res as Response;
      if (!waited) {
        waited = true;
        setWaiting(1);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    if (waited) setWaiting(-1);
  }
}
