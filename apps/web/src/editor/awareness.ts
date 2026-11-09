// Awareness state schema and helpers.
//
// Awareness is Yjs's *ephemeral* per-client metadata channel. It lives
// outside the doc state — never persisted, broadcast as updates over WS.
// We use it for:
//
//   - cursor position (renders the other user's cursor on the canvas)
//   - selection (renders dashed outlines on the bricks they've selected)
//   - tool (informational; could change cursor icon)
//   - identity (id, displayName, avatarUrl, color)
//   - idle flag (5min no movement → grey dot)
//
// (Colors: presenceColors.ts.)
//
// The shape must round-trip through structuredClone (Yjs requires it),
// so plain JSON-able objects only.

import { PRESENCE_PALETTE, firstChoice } from './presenceColors';

export interface AwarenessUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** Deterministic per (user_id, layout_id) so a user has the same color everywhere. */
  color: string;
}

export interface AwarenessCursor {
  /** World position in studs, or null if cursor is outside the canvas. */
  x: number;
  y: number;
  layerId: string | null;
}

export interface AwarenessState {
  user: AwarenessUser;
  cursor: AwarenessCursor | null;
  selection: { brickIds: string[] };
  tool: string;
  /** The placed module this person is editing ("Edit module"), if any. */
  editingModule?: string | null;
  /** Unix-millis of the last activity. Compared client-side for idle dot. */
  lastActivityMs: number;
}

/**
 * A person's own color on a layout, what they send as `user.color` (their
 * first choice, presenceColors.ts). What everyone is drawn in is worked out
 * from the people here (presenceColors), so two people don't share one.
 */
export function deterministicColor(userId: string, layoutId: string): string {
  return PRESENCE_PALETTE[firstChoice(userId, layoutId)] ?? '#888888';
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Someone else's presence as the editor draws it, or null when it isn't a
 * person's (no name, selection or last-activity time: a tab still opening
 * the layout, an older app, or a made-up entry). Every field is checked and
 * copied, so drawing it can't throw: one bad entry used to blank the editor
 * for everyone in the layout.
 */
export function readPeerPresence(raw: unknown): AwarenessState | null {
  if (!isObject(raw) || !isObject(raw.user) || !isObject(raw.selection)) return null;
  const { user, selection } = raw;
  if (typeof user.displayName !== 'string' || !Array.isArray(selection.brickIds)) return null;
  if (typeof raw.lastActivityMs !== 'number' || !Number.isFinite(raw.lastActivityMs)) return null;
  const c = raw.cursor;
  const cursor: AwarenessCursor | null =
    isObject(c) && typeof c.x === 'number' && Number.isFinite(c.x) && typeof c.y === 'number' && Number.isFinite(c.y)
      ? { x: c.x, y: c.y, layerId: typeof c.layerId === 'string' ? c.layerId : null }
      : null;
  return {
    user: {
      id: typeof user.id === 'string' ? user.id : '',
      displayName: user.displayName,
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
      color: typeof user.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(user.color) ? user.color : '#888888',
    },
    cursor,
    selection: { brickIds: selection.brickIds.filter((id): id is string => typeof id === 'string') },
    tool: typeof raw.tool === 'string' ? raw.tool : 'select',
    editingModule: typeof raw.editingModule === 'string' ? raw.editingModule : null,
    lastActivityMs: raw.lastActivityMs,
  };
}

/** Idle threshold (ms). After this much inactivity a peer's dot turns grey. */
export const IDLE_MS = 5 * 60 * 1000;
