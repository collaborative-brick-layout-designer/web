// Getting a layout's first copy over HTTP before the live connection opens.
//
// Over the live connection the whole layout comes as one message (2.25 MB
// for 7,520 parts), and y-websocket closes a socket that has received
// nothing for 30 s: below about 600 kbit/s a big layout never finished and
// started over every 30-45 s, forever. Over HTTP it streams, so a slow link
// only makes it slower, the opening card can show how far along it is
// ("1.2 of 2.2 MB"), and the live connection then only has to send what
// changed since.

import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';

export interface DownloadProgress {
  loaded: number;
  /** Bytes in all, when the server said. */
  total: number | null;
}

let progress: DownloadProgress | null = null;
const listeners = new Set<() => void>();

function setProgress(p: DownloadProgress | null): void {
  progress = p;
  for (const l of listeners) l();
}

/** The download now under way (null: none). For useSyncExternalStore. */
export function getDownloadProgress(): DownloadProgress | null {
  return progress;
}

export function subscribeDownloadProgress(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** "0.4 MB" / "2.2 MB" / "640 KB". */
export function formatBytes(n: number): string {
  if (n >= 100 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Nothing arrives for this long: give up and let the live connection bring it. */
export const DOWNLOAD_STALL_MS = 30_000;

/** The origin of the downloaded copy's transaction (it is the server's, not an edit). */
export const DOWNLOAD_ORIGIN = Symbol('cld-layout-download');

/**
 * Download the layout and put it in `doc`. True when it was put in; false
 * when it couldn't be had (signed out, not shared, offline, stalled): then
 * the live connection brings it, and says why it can't.
 */
export async function downloadLayout(
  layoutId: string,
  doc: Y.Doc,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  // Aborted when the page leaves the layout, or nothing arrives for a while.
  const stall = new AbortController();
  const both = stall.signal;
  const leave = (): void => stall.abort();
  signal.addEventListener('abort', leave, { once: true });
  let stallTimer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_MS);
  const alive = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_MS);
  };
  try {
    const res = await fetcher(`/api/layouts/${encodeURIComponent(layoutId)}/snapshot`, { credentials: 'include', signal: both });
    if (!res.ok || !res.body) return false;
    alive();
    const said = Number.parseInt(res.headers.get('x-doc-bytes') ?? '', 10);
    const total = Number.isFinite(said) && said > 0 ? said : null;
    setProgress({ loaded: 0, total });
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      alive();
      setProgress({ loaded, total });
    }
    if (signal.aborted) return false;
    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    if (bytes.length === 0) return false;
    Y.applyUpdate(doc, bytes, DOWNLOAD_ORIGIN);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(stallTimer);
    signal.removeEventListener('abort', leave);
    setProgress(null);
  }
}

/** How long a live connection may go without a message while its first copy of the layout still arrives. */
export const FIRST_SYNC_GRACE_MS = 5 * 60_000;

/**
 * Keep y-websocket from closing the socket while the layout's first copy is
 * still arriving over it (it closes one that received nothing for 30 s,
 * and one big message can take longer): until the layout's first sync, up
 * to FIRST_SYNC_GRACE_MS after the socket opened. After the first sync its
 * 30 s timer works as before, so a dead connection is still noticed.
 */
export function keepOpenWhileFirstSync(provider: WebsocketProvider): void {
  let last = provider.wsLastMessageReceived;
  let openedAt: number | null = null;
  let synced = false;
  provider.on('status', ({ status }: { status: string }) => {
    openedAt = status === 'connected' ? Date.now() : null;
  });
  provider.on('sync', (isSynced: boolean) => {
    if (isSynced) synced = true;
  });
  Object.defineProperty(provider, 'wsLastMessageReceived', {
    configurable: true,
    get: () => (!synced && openedAt !== null && Date.now() - openedAt < FIRST_SYNC_GRACE_MS ? Date.now() : last),
    set: (v: number) => {
      last = v;
    },
  });
}
