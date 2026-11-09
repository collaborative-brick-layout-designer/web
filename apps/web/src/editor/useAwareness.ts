// Publish + subscribe to awareness state.
//
// The publisher hook batches local state into a single Awareness update,
// debounced lightly (cursor position can fire on every mousemove). The
// subscriber hook returns a stable list of remote peers, sorted for UI.
//
// Awareness is bound to the WS provider's `Awareness` instance — the
// y-websocket layer broadcasts our state to peers and surfaces their
// state in `awareness.getStates()`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { useEditorStore } from './editorStore';
import {
  deterministicColor,
  readPeerPresence,
  IDLE_MS,
  type AwarenessCursor,
  type AwarenessState,
  type AwarenessUser,
} from './awareness';
import type { Me } from '../api';
import { presenceColors } from './presenceColors';

interface UsePublishOpts {
  awareness: Awareness | null;
  me: Me | null;
  layoutId: string;
}

/** How often remote peers' idle flags are re-evaluated. */
const IDLE_TICK_MS = 5_000;

/** Minimum interval between cursor-only awareness broadcasts (~20 Hz). */
export const CURSOR_PUBLISH_INTERVAL_MS = 50;

/**
 * Build and publish the local user's awareness state. Reads from the
 * editor store (selection, tool, active layer) and combines with the
 * user's identity. Identity / selection / tool changes publish at once.
 *
 * The cursor is deliberately kept OUT of React state: it used to be a
 * `useState` in the Editor, so every mouse move (rAF-coalesced, 60 Hz)
 * re-rendered the whole editor tree. It now lives in a ref and is
 * broadcast straight to the awareness instance, throttled to
 * CURSOR_PUBLISH_INTERVAL_MS (leading + trailing edge).
 */
export function usePublishAwareness({ awareness, me, layoutId }: UsePublishOpts): void {
  const tool = useEditorStore((s) => s.tool);
  const selection = useEditorStore((s) => s.selection);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const editingModule = useEditorStore((s) => s.editingModuleId);
  const cursorRef = useRef<AwarenessCursor | null>(null);
  // Latest everything-but-the-cursor, so the throttled cursor publisher
  // (a long-lived listener) always sends a complete, current state.
  const baseRef = useRef<{
    user: AwarenessUser;
    selection: string[];
    tool: AwarenessState['tool'];
    activeLayerId: string | null;
    editingModule: string | null;
  } | null>(null);
  const publishRef = useRef<() => void>(() => undefined);

  publishRef.current = () => {
    const base = baseRef.current;
    if (!awareness || !base) return;
    const cursor = cursorRef.current;
    const cursorWithLayer: AwarenessCursor | null =
      cursor && base.activeLayerId
        ? { x: cursor.x, y: cursor.y, layerId: base.activeLayerId }
        : cursor;
    const state: AwarenessState = {
      user: base.user,
      cursor: cursorWithLayer,
      selection: { brickIds: base.selection },
      tool: base.tool,
      editingModule: base.editingModule,
      lastActivityMs: Date.now(),
    };
    awareness.setLocalState(state);
  };

  // Cursor: window-level custom events from the canvas, throttled.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = 0;
    let dirty = false;
    function flush() {
      timer = null;
      if (!dirty) return;
      dirty = false;
      lastSent = performance.now();
      publishRef.current();
    }
    function schedule() {
      dirty = true;
      if (timer !== null) return;
      const wait = Math.max(0, CURSOR_PUBLISH_INTERVAL_MS - (performance.now() - lastSent));
      timer = setTimeout(flush, wait);
    }
    function onMove(e: Event) {
      cursorRef.current = (e as CustomEvent<AwarenessCursor>).detail;
      schedule();
    }
    function onLeave() {
      cursorRef.current = null;
      schedule();
    }
    window.addEventListener('cld-cursor-move', onMove);
    window.addEventListener('cld-cursor-leave', onLeave);
    return () => {
      window.removeEventListener('cld-cursor-move', onMove);
      window.removeEventListener('cld-cursor-leave', onLeave);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // Identity / selection / tool / layer: publish immediately.
  useEffect(() => {
    if (!awareness || !me) {
      baseRef.current = null;
      return;
    }
    baseRef.current = {
      user: {
        id: me.id,
        // Others see this next to your cursor: never an email address.
        displayName: me.publicName ?? me.displayName,
        avatarUrl: me.avatarUrl,
        color: deterministicColor(me.id, layoutId),
      },
      selection,
      tool,
      activeLayerId,
      editingModule,
    };
    publishRef.current();
  }, [awareness, me, layoutId, tool, selection, activeLayerId, editingModule]);
}

/**
 * Subscribe to remote peers' awareness and return a tick-stable list:
 * everyone else here, not this tab and not this person in another tab or
 * app. Sorted by displayName for UI consistency. Each is drawn in the color
 * every app works out from the people here (presenceColors), so two people
 * don't share one. A person in two tabs is two entries (two cursors):
 * onePerPerson() makes them one.
 */
export function useRemotePeers(awareness: Awareness | null): {
  clientId: number;
  state: AwarenessState;
  isIdle: boolean;
}[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!awareness) return;
    // Our own state changes on every (throttled) cursor move; those must
    // not re-render the remote-cursor layer / presence list.
    const self = awareness.clientID;
    const onChange = (changes: { added: number[]; updated: number[]; removed: number[] }) => {
      const touchesPeer =
        // (Our own first presence: who "us" is, to leave out.)
        changes.added.length > 0 ||
        changes.updated.some((c) => c !== self) ||
        changes.removed.some((c) => c !== self);
      if (touchesPeer) setTick((t) => t + 1);
    };
    awareness.on('change', onChange);
    // Peers going idle produce no awareness change, so re-evaluate the
    // idle flags periodically (they used to piggy-back on our own
    // per-mousemove state changes).
    const idleTimer = setInterval(() => setTick((t) => t + 1), IDLE_TICK_MS);
    return () => {
      awareness.off('change', onChange);
      clearInterval(idleTimer);
    };
  }, [awareness]);

  return useMemo(() => {
    if (!awareness) return [];
    const now = Date.now();
    const selfId = readSelfId(awareness.getLocalState());
    const peers: { clientId: number; state: AwarenessState; isIdle: boolean }[] = [];
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      // Not a person's presence (a tab still opening the layout sends {}): skipped.
      const state = readPeerPresence(raw);
      if (!state) continue;
      // This person in another tab or app: not someone else.
      if (selfId && state.user.id === selfId) continue;
      peers.push({
        clientId,
        state,
        isIdle: now - state.lastActivityMs > IDLE_MS,
      });
    }
    const colors = presenceColors([...(selfId ? [selfId] : []), ...peers.map((p) => p.state.user.id)], layoutKey(awareness));
    for (const p of peers) {
      const c = colors.get(p.state.user.id);
      if (c && p.state.user.id) p.state = { ...p.state, user: { ...p.state.user, color: c } };
    }
    peers.sort((a, b) => a.state.user.displayName.localeCompare(b.state.user.displayName));
    void tick;
    return peers;
  }, [awareness, tick]);
}

function readSelfId(local: unknown): string | null {
  const user = (local as { user?: { id?: unknown } } | null)?.user;
  return typeof user?.id === 'string' && user.id ? user.id : null;
}

/** The layout a presence is for (newLivePresence notes it), for the colors. */
const presenceLayouts = new WeakMap<Awareness, string>();

export function notePresenceLayout(awareness: Awareness, layoutId: string): void {
  presenceLayouts.set(awareness, layoutId);
}

function layoutKey(awareness: Awareness): string {
  return presenceLayouts.get(awareness) ?? '';
}

/** One entry per person (someone in two tabs is one), the most recently active. */
export function onePerPerson<T extends { state: AwarenessState }>(peers: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const p of peers) {
    const key = p.state.user.id || `#${p.state.user.displayName}`;
    const had = best.get(key);
    if (!had || p.state.lastActivityMs > had.state.lastActivityMs) best.set(key, p);
  }
  return peers.filter((p) => best.get(p.state.user.id || `#${p.state.user.displayName}`) === p);
}

/**
 * Helper for the canvas to dispatch cursor events. Defined here so the
 * event name stays in one place; both the publisher and the canvas
 * import from this file.
 */
export function dispatchCursorMove(studX: number, studY: number): void {
  window.dispatchEvent(
    new CustomEvent<AwarenessCursor>('cld-cursor-move', {
      detail: { x: studX, y: studY, layerId: null },
    }),
  );
}

export function dispatchCursorLeave(): void {
  window.dispatchEvent(new Event('cld-cursor-leave'));
}
