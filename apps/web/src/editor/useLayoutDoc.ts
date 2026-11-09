// Owns the Y.Doc lifecycle for the editor.
//
// In Phase 4 this is a thin shim over y-websocket's `WebsocketProvider`.
// The provider:
//   - opens `ws://.../ws/layout/:id` (or wss in prod)
//   - performs the y-websocket sync handshake on connect
//   - streams local edits to the server, applies remote edits to the doc
//   - exposes a `Awareness` instance for cursor/selection broadcasts
//
// Persistence is now the server's job — every accepted update is written
// to `layout_updates` and periodically compacted into a fresh snapshot
// (see apps/server/src/ws/docHub.ts). The client doesn't ship a
// "save" message anymore: the server appends every accepted update to
// `layout_updates` before relaying it, so an edit is durable as soon as
// the socket is connected and synced. Save / Cmd-S therefore reports
// whether that is the case (see `saveNow`), and the editor offers a local
// .bbm download when it isn't.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { canReadDoc, removeDuplicateItems, repairSidecarCache } from '@cld/ydoc';
import { keepRefusedCopy, type RefusedWhy } from './refusedCopies';
import { announceSignInEnded } from '../demo/demoVisitor';

export type SaveStatus =
  | { kind: 'connecting' }
  | { kind: 'synced' }
  | { kind: 'reconnecting'; lastSyncedAt: number | null }
  | { kind: 'offline'; lastSyncedAt: number | null }
  | { kind: 'error'; message: string }
  /** The module editor: changes not saved yet (Save sends them). */
  | { kind: 'unsaved' }
  | { kind: 'saving' };

export interface LayoutDocState {
  doc: Y.Doc | null;
  awareness: Awareness | null;
  /** Connection status — drives the synced/reconnecting indicator. */
  status: SaveStatus;
  /**
   * Explicit Save / Cmd-S. Resolves 'saved' when the socket is connected
   * and synced (every edit has then reached the server, which persists
   * each update), 'offline' otherwise.
   */
  saveNow: () => Promise<SaveResult>;
  /**
   * The module editor: work to finish before a save counts as done (its
   * picture), so "Saved" only shows once everything has arrived.
   */
  setAfterSave?: (fn: (() => Promise<unknown>) | null) => void;
  /** The module editor: the next save's "What changed" note. */
  setSaveNote?: (note: string) => void;
  /** Surfaced to the UI for "couldn't connect" cases (auth, 404, etc). */
  loadError: Error | null;
  loading: boolean;
}

/**
 * Origin tag used on every transaction the local user makes. UndoManager
 * is configured with `trackedOrigins: new Set([LOCAL_ORIGIN])` so undo
 * only walks back transactions matching this id. The origin is
 * deliberately a runtime symbol so a server-relayed update (origin =
 * the WebsocketProvider instance) doesn't get reverted by Cmd-Z.
 */
export const LOCAL_ORIGIN = Symbol('cld-local-origin');
/** Tidying after concurrent edits (meta.cache, duplicate parts): not an undo step. */
const SIDECAR_REPAIR_ORIGIN = Symbol('cld-sidecar-repair');

export type SaveResult = 'saved' | 'offline';

/** No answer from the server at all for this long: say so. */
const SYNC_TIMEOUT_MS = 10_000;
/**
 * Connected, and the layout on its way: a big layout on a slow phone or
 * show Wi-Fi can take a while to arrive and be read.
 */
const SYNCING_TIMEOUT_MS = 60_000;

/** Why a layout won't open when its doc is newer than this page reads. */
export const UNREADABLE_LAYOUT =
  'This layout was saved by a newer version of Collaborative Brick Layout Designer. Reload the page to get the newest version, then open it again.';

/** Load errors the editor's error screen words (and offers Sign in for the last). */
export const LAYOUT_NOT_FOUND = "This layout isn't here: it may have been deleted, or it isn't shared with you. Ask its owner for access.";
export const LOAD_TIMED_OUT = "The layout hasn't opened yet. Check your connection: it opens by itself as soon as it gets through.";
export const SIGN_IN_TO_OPEN = 'This layout is private. Sign in with an account it is shared with to open it.';
/** The demo was reset (or turned off) while this layout was open: the page also offers to start again (demo/DemoResetNotice). */
export const DEMO_WAS_RESET = 'The demo was reset, so this layout went back to the start.';
/** The server refused what this page sent because it held another layout's parts (ws/mergeGuard.ts). */
export const MERGE_REFUSED =
  "The server didn't take this page's changes: they looked like another layout's parts going into this one, so the layout on the server wasn't changed. Nothing you did is lost: your copy is kept on this page. Save it as a new layout or download it.";

const MERGE_REFUSED_REASON = 'layout_merge_refused';

/** The server refused what this page sent because the apps can't read it (ws/updateGuard.ts). */
export const UPDATE_REFUSED =
  "The server didn't take this page's latest changes: they hold something the apps can't read, so the layout on the server wasn't changed. Nothing you did is lost: your copy is kept on this page. Save it as a new layout or download it.";

const UPDATE_REFUSED_REASON = 'unreadable_update';

/**
 * Close codes after which a connection never comes back: retrying can't
 * succeed (and y-websocket would otherwise reconnect with backoff forever).
 * An account put on hold (privacy) reconnects read only by itself.
 */
function isFinalClose(event: CloseEvent): boolean {
  if (event.code === 1008 && event.reason === 'account_restricted') return false;
  return event.code === 4404 || event.code === 1008;
}

/** Why a final close ended the layout, for the kept copy's card. */
function whyEnded(event: CloseEvent): RefusedWhy {
  if (event.reason === MERGE_REFUSED_REASON) return 'merge';
  if (event.reason === UPDATE_REFUSED_REASON) return 'unreadable';
  return event.code === 4404 ? 'gone' : 'signed_out';
}

/**
 * Layouts left (another layout opened in the app, Back, the layouts list)
 * with edits the server hasn't got yet: made offline, they reach the
 * server once the connection is back. Each keeps its own doc and provider,
 * for its own layout id only, until then; nothing is shared with the
 * layout opened next.
 */
const leaving = new Set<{ layoutId: string; provider: WebsocketProvider; doc: Y.Doc }>();

/** Layout ids whose left-behind edits are still on their way (tests, the unload guard). */
export function layoutsStillSending(): string[] {
  return [...leaving].map((l) => l.layoutId);
}

function onUnloadWhileSending(e: BeforeUnloadEvent): void {
  if (leaving.size === 0) return;
  e.preventDefault();
  e.returnValue = '';
}

/** Keep a left layout's connection until its edits are sent, then close it. */
function finishSending(layoutId: string, provider: WebsocketProvider, doc: Y.Doc): void {
  const entry = { layoutId, provider, doc };
  leaving.add(entry);
  if (leaving.size === 1 && typeof window !== 'undefined') window.addEventListener('beforeunload', onUnloadWhileSending);
  let poll: ReturnType<typeof setInterval> | null = null;
  const done = (keepDoc = false): void => {
    if (!leaving.delete(entry)) return;
    if (poll) clearInterval(poll);
    provider.off('sync', onSync);
    provider.off('connection-close', onClose);
    provider.disconnect();
    provider.destroy();
    if (!keepDoc) doc.destroy();
    if (leaving.size === 0 && typeof window !== 'undefined') window.removeEventListener('beforeunload', onUnloadWhileSending);
  };
  // Synced again: our reply to the server's step 1 (all it lacks) went out
  // before its step 2 arrived. Close once the socket has sent it.
  const onSync = (isSynced: boolean): void => {
    if (!isSynced || poll) return;
    poll = setInterval(() => {
      const ws = provider.ws as WebSocket | null;
      if (!ws || ws.bufferedAmount === 0) done();
    }, 100);
  };
  const onClose = (event: CloseEvent | null): void => {
    if (!event || !isFinalClose(event)) return;
    // Ended for good (refused, signed out, the layout gone) with its edits
    // never sent: the copy is kept (refusedCopies).
    done(keepRefusedCopy(layoutId, doc, whyEnded(event)));
  };
  provider.on('sync', onSync);
  provider.on('connection-close', onClose);
}

/**
 * The presence this tab shares, empty (null) until the layout has opened
 * here: y-protocols starts it as `{}`, which others can't draw (a tab still
 * opening a big layout used to blank everyone's editor), and re-sends it
 * every 15 s. usePublishAwareness fills it once the layout is open.
 */
export function newLivePresence(doc: Y.Doc): Awareness {
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  return awareness;
}

/** Build the WS URL relative to the current page (so dev + prod both work). */
function wsUrlBase(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/**
 * Whether `mine` holds anything `server` lacks: what the layout reads as
 * changes when mine is put on top of the server's copy. Only the doc's
 * shared types that `mine` reads are compared.
 */
export function holdsEditsServerLacks(server: Y.Doc, mine: Y.Doc): boolean {
  const both = new Y.Doc();
  Y.applyUpdate(both, Y.encodeStateAsUpdate(server));
  const read = (): string => {
    const out: Record<string, unknown> = {};
    for (const [name, type] of mine.share) {
      // A shared type nothing here reads (the doc only holds it untyped): skip it.
      if (type.constructor === Y.AbstractType) continue;
      out[name] = both.get(name, type.constructor as typeof Y.AbstractType<unknown>).toJSON();
    }
    return JSON.stringify(out);
  };
  const before = read();
  Y.applyUpdate(both, Y.encodeStateAsUpdate(mine));
  const after = read();
  both.destroy();
  return before !== after;
}

/**
 * `canEdit`: whether the person may edit the layout now (their role on it;
 * undefined until known). When it goes from yes to no while the layout is
 * open, the server has been dropping their edits since, and drops any
 * made offline too: the layout starts again from the server's copy, and a
 * copy holding edits the server lacks is kept (refusedCopies, 'view_only').
 */
export function useLayoutDoc(layoutId: string, canEdit?: boolean): LayoutDocState {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'connecting' });
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const providerRef = useRef<WebsocketProvider | null>(null);
  // Bumped to start the layout again from the server's copy (down to view only).
  const [generation, setGeneration] = useState(0);
  const restarting = useRef(false);
  // The copy from before starting again, until the server's copy is in to compare.
  const toCheck = useRef<Y.Doc | null>(null);
  const couldEdit = useRef(canEdit);

  useEffect(() => {
    const before = couldEdit.current;
    couldEdit.current = canEdit;
    if (before === true && canEdit === false && providerRef.current) {
      restarting.current = true;
      setGeneration((g) => g + 1);
    }
  }, [canEdit]);

  useEffect(() => {
    setDoc(null);
    setAwareness(null);
    setLoading(true);
    setLoadError(null);
    setStatus({ kind: 'connecting' });

    const fresh = new Y.Doc();
    // y-websocket appends `/<roomname>` to the base URL; we want the
    // ROOM to be the literal layout id (no slashes), so we include the
    // `/ws/layout` prefix in `wsUrlBase` and use `layoutId` as room.
    const provider = new WebsocketProvider(`${wsUrlBase()}/ws/layout`, layoutId, fresh, {
      // params: we rely on the session cookie for auth; nothing else.
      connect: true,
      awareness: newLivePresence(fresh),
    });
    providerRef.current = provider;

    let lastSyncedAt: number | null = null;
    // Edits made while not connected and synced: sent on reconnect, so a
    // layout left before then finishes sending them (finishSending).
    let unsent = false;
    // Refused by the server: the doc is handed to refusedCopies, not destroyed.
    let refused = false;
    const onDocUpdate = (_u: Uint8Array, origin: unknown): void => {
      if (origin !== provider && !(provider.wsconnected && provider.synced)) unsent = true;
    };
    fresh.on('update', onDocUpdate);
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    // Said "hasn't opened yet"; the provider keeps trying, and the layout
    // opens by itself if it gets through after all.
    let timedOut = false;
    const waitFor = (ms: number) => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        // Surface a clear message rather than spinning forever.
        timedOut = true;
        setLoadError(new Error(LOAD_TIMED_OUT));
        setStatus({ kind: 'error', message: 'connection timed out' });
      }, ms);
    };
    waitFor(SYNC_TIMEOUT_MS);

    // A layout written by a newer (or much older) version than this page
    // reads: stop syncing rather than edit what we don't understand.
    const meta = fresh.getMap('meta');
    const unreadable = (): boolean => {
      if (canReadDoc(meta.get('schemaVersion'))) return false;
      provider.disconnect();
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      setDoc(null);
      setLoadError(new Error(UNREADABLE_LAYOUT));
      return true;
    };
    const onMeta = (): void => {
      unreadable();
    };
    meta.observe(onMeta);

    const onSync = (isSynced: boolean): void => {
      if (isSynced) {
        unsent = false;
        if (unreadable()) return;
        // Started again at view only: keep the copy from before if the server lacks some of it.
        const earlier = toCheck.current;
        if (earlier) {
          toCheck.current = null;
          if (!(holdsEditsServerLacks(fresh, earlier) && keepRefusedCopy(layoutId, earlier, 'view_only'))) earlier.destroy();
        }
        if (syncTimer) {
          clearTimeout(syncTimer);
          syncTimer = null;
        }
        if (timedOut) {
          timedOut = false;
          setLoadError(null);
        }
        lastSyncedAt = Date.now();
        setLoading(false);
        setDoc(fresh);
        setAwareness(provider.awareness);
        setStatus({ kind: 'synced' });
      }
    };

    const onStatus = (event: { status: 'disconnected' | 'connecting' | 'connected' }): void => {
      switch (event.status) {
        case 'connected':
          // 'sync' follows once the layout has arrived and been read:
          // give a big one on a slow phone time for that.
          if (syncTimer && !timedOut && lastSyncedAt === null) waitFor(SYNCING_TIMEOUT_MS);
          break;
        case 'connecting':
          setStatus({ kind: 'reconnecting', lastSyncedAt });
          break;
        case 'disconnected':
          setStatus({ kind: 'offline', lastSyncedAt });
          break;
      }
    };

    const onConnectionClose = (event: CloseEvent | null): void => {
      if (!event) return;
      if (isFinalClose(event)) {
        // Terminal: retrying can't succeed, and y-websocket would
        // otherwise keep reconnecting with backoff forever. Edits made
        // offline never reached the server (signed out meanwhile, or the
        // layout deleted), so their copy is kept like a refused one.
        const hadUnsent = unsent;
        unsent = false;
        provider.disconnect();
        const why = whyEnded(event);
        if (why === 'merge' || why === 'unreadable' || hadUnsent) refused = keepRefusedCopy(layoutId, fresh, why);
        if (syncTimer) {
          clearTimeout(syncTimer);
          syncTimer = null;
        }
        // Signed out (a demo reset, a sign-in that ran out): the demo notice checks /me.
        const demoEnded = event.reason === 'demo_reset' || event.reason === 'demo_off';
        if (event.code === 1008 || demoEnded) announceSignInEnded();
        setLoadError(
          new Error(
            demoEnded
              ? DEMO_WAS_RESET
              : event.code === 4404
              ? LAYOUT_NOT_FOUND
              : why === 'merge'
                ? MERGE_REFUSED
                : why === 'unreadable'
                  ? UPDATE_REFUSED
                  : event.reason === 'account_pending_deletion'
                    ? 'Your account is being deleted, so you were signed out. Sign in again to keep it.'
                    : SIGN_IN_TO_OPEN,
          ),
        );
      } else if (event.code === 4429) {
        setLoadError(
          new Error(
            event.reason === 'limit_reached'
              ? 'Too many people have this layout open right now. Try again in a little while.'
              : 'This browser has too many layouts open at once. Close a few tabs, then try again.',
          ),
        );
      }
    };

    provider.on('sync', onSync);
    provider.on('status', onStatus);
    provider.on('connection-close', onConnectionClose);

    // After someone else's edit: when two people changed modules or labels
    // at once, rewrite meta.cache from the merged items so apps that only
    // read meta.cache (the desktop) see both (@cld/ydoc repairSidecarCache).
    let repairTimer: ReturnType<typeof setTimeout> | null = null;
    const onTransaction = (tr: Y.Transaction) => {
      // (Also after an undo: it can take back items meta.cache still has.)
      if ((tr.origin !== provider && !(tr.origin instanceof Y.UndoManager)) || repairTimer) return;
      repairTimer = setTimeout(() => {
        repairTimer = null;
        repairSidecarCache(fresh, SIDECAR_REPAIR_ORIGIN);
        // Two people moving the same part or ruler, or painting the same
        // cell, at once leave it there twice.
        removeDuplicateItems(fresh, SIDECAR_REPAIR_ORIGIN);
      }, 50);
    };
    fresh.on('afterTransaction', onTransaction);

    return () => {
      if (syncTimer) clearTimeout(syncTimer);
      meta.unobserve(onMeta);
      provider.off('sync', onSync);
      provider.off('status', onStatus);
      provider.off('connection-close', onConnectionClose);
      fresh.off('afterTransaction', onTransaction);
      fresh.off('update', onDocUpdate);
      if (repairTimer) clearTimeout(repairTimer);
      if (providerRef.current === provider) providerRef.current = null;
      if (restarting.current) {
        // Down to view only: the server takes none of this copy's edits any
        // more. It waits to be compared with the server's copy (onSync).
        restarting.current = false;
        provider.disconnect();
        provider.destroy();
        toCheck.current?.destroy();
        toCheck.current = fresh;
        return;
      }
      if (unsent) {
        // Left with edits the server hasn't got: they still go to THIS
        // layout when the connection is back, never to the next one.
        finishSending(layoutId, provider, fresh);
        return;
      }
      provider.disconnect();
      provider.destroy();
      if (!refused) fresh.destroy();
    };
  }, [layoutId, generation]);

  // Leaving the layout before the server's copy came in: nothing to compare with.
  useEffect(
    () => () => {
      toCheck.current?.destroy();
      toCheck.current = null;
    },
    [layoutId],
  );

  // Edits stream over the socket and the server persists each update on
  // receipt, so "saved" means: connected and synced right now.
  const saveNow = useCallback(async (): Promise<SaveResult> => {
    const p = providerRef.current;
    return p && p.wsconnected && p.synced ? 'saved' : 'offline';
  }, []);

  return useMemo(
    () => ({ doc, awareness, status, saveNow, loadError, loading }),
    [doc, awareness, status, saveNow, loadError, loading],
  );
}
