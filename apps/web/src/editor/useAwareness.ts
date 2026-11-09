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
 * Subscribe to remote peers' awareness and return a tick-stable list.
 * Excludes the local clientID. Sorted by displayName for UI consistency.
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
        changes.added.some((c) => c !== self) ||
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
    const peers: { clientId: number; state: AwarenessState; isIdle: boolean }[] = [];
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      // Not a person's presence (a tab still opening the layout sends {}): skipped.
      const state = readPeerPresence(raw);
      if (!state) continue;
      peers.push({
        clientId,
        state,
        isIdle: now - state.lastActivityMs > IDLE_MS,
      });
    }
    peers.sort((a, b) => a.state.user.displayName.localeCompare(b.state.user.displayName));
    void tick;
    return peers;
  }, [awareness, tick]);
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
