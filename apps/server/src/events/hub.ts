// Live change hints (GET /api/events, Server-Sent Events).
//
// A hint says only that something changed — `{kind, owner, id, action}` —
// never what it now holds: each client refetches through the normal,
// access-checked routes. Hints still go only to the people who can see
// the thing (see audience.ts), so a hint never tells anyone that a
// layout, module or club they can't see exists or changed.
//
// One process holds every connection (the server is a single Node
// process on SQLite), so this is an in-memory registry.

/** What a hint is about. Keep in step with apps/web/src/live/invalidate.ts. */
export const HINT_KINDS = [
  'layout',
  'module',
  'venue',
  'custom-part',
  'catalog',
  'club',
  'me',
  'transfer',
  'admin',
  'settings',
  'limits',
  'parts-library',
  'warning',
] as const;
export type HintKind = (typeof HINT_KINDS)[number];

export type HintOwner = { kind: 'user' | 'org'; id: string };

export interface Hint {
  kind: HintKind;
  owner?: HintOwner;
  id?: string;
  action: string;
  /**
   * The thing's version after the change, when the route says (a module's
   * save). Two saves close together are then two hints, not squashed into
   * one, so a tab showing the module always hears about the second.
   */
  v?: number;
}

/** One open event stream. `write` returns false once the socket is gone. */
export interface EventConnection {
  userId: string;
  write: (chunk: string) => boolean;
  close: () => void;
  openedAt: number;
  /** Last few hints sent, for squashing repeats that arrive together. */
  recent: Map<string, number>;
}

/** Open streams one person may hold (tabs, windows, desktop apps). The oldest goes first. */
export const MAX_CONNECTIONS_PER_USER = 8;
/** Comment line sent this often so proxies and browsers keep the stream open. */
export const HEARTBEAT_MS = 25_000;
/** The same hint to the same stream within this window is sent once. */
const SQUASH_MS = 500;

const byUser = new Map<string, Set<EventConnection>>();

export function addConnection(conn: EventConnection): void {
  let set = byUser.get(conn.userId);
  if (!set) {
    set = new Set();
    byUser.set(conn.userId, set);
  }
  set.add(conn);
  while (set.size > MAX_CONNECTIONS_PER_USER) {
    let oldest: EventConnection | null = null;
    for (const c of set) if (!oldest || c.openedAt < oldest.openedAt) oldest = c;
    if (!oldest) break;
    removeConnection(oldest);
    oldest.close();
  }
}

export function removeConnection(conn: EventConnection): void {
  const set = byUser.get(conn.userId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) byUser.delete(conn.userId);
}

export function connectionCount(userId?: string): number {
  if (userId !== undefined) return byUser.get(userId)?.size ?? 0;
  let n = 0;
  for (const set of byUser.values()) n += set.size;
  return n;
}

/** Who has a stream open right now (the audience is narrowed to these first). */
export function connectedUserIds(): string[] {
  return [...byUser.keys()];
}

export function formatHint(hint: Hint): string {
  const body: Hint = { kind: hint.kind, action: hint.action };
  if (hint.owner) body.owner = { kind: hint.owner.kind, id: hint.owner.id };
  if (hint.id) body.id = hint.id;
  if (typeof hint.v === 'number') body.v = hint.v;
  return `data: ${JSON.stringify(body)}\n\n`;
}

function send(conn: EventConnection, chunk: string, now: number): void {
  const last = conn.recent.get(chunk);
  if (last !== undefined && now - last < SQUASH_MS) return;
  conn.recent.set(chunk, now);
  if (conn.recent.size > 32) {
    for (const [k, t] of conn.recent) if (now - t >= SQUASH_MS) conn.recent.delete(k);
  }
  if (!conn.write(chunk)) {
    removeConnection(conn);
    conn.close();
  }
}

/** Send `hint` to every open stream of each of `userIds` (and nobody else). */
export function deliver(hint: Hint, userIds: Iterable<string>, now: number = Date.now()): number {
  const chunk = formatHint(hint);
  let sent = 0;
  for (const uid of new Set(userIds)) {
    const set = byUser.get(uid);
    if (!set) continue;
    for (const conn of [...set]) {
      send(conn, chunk, now);
      sent++;
    }
  }
  return sent;
}

/** Heartbeat every open stream once (the route calls this on a timer). */
export function heartbeatAll(): void {
  for (const set of [...byUser.values()]) {
    for (const conn of [...set]) {
      if (!conn.write(': ping\n\n')) {
        removeConnection(conn);
        conn.close();
      }
    }
  }
}

/** Close everything (server shutdown, tests). */
export function closeAll(): void {
  for (const set of [...byUser.values()]) for (const conn of [...set]) conn.close();
  byUser.clear();
}
