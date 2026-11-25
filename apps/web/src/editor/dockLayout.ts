// Moveable / persisted dock layout — port of desktop's QSettings
// `ui/state` + `ui/geometry` keys (MainWindow.cpp:1015-1028).
//
// The desktop persists Qt's full QMainWindow dock layout so the user's
// arrangement survives restart. The web port:
//   - identifies each panel by a stable string id
//   - tracks which "zone" each panel is in (left | right | hidden | float)
//   - tracks each dock's width AND each panel's height-share within a column
//   - for floating panels: tracks (x, y) position and (width, height) size
//   - persists everything in localStorage, keyed on the user id
//
// Realtime collab + per-tab independence mean we DO NOT sync this
// across tabs. Two tabs of the same layout can have different panel
// layouts; that matches the desktop where each instance keeps its
// own QSettings copy.

import { useEffect, useState, useCallback } from 'react';

export type DockZone = 'left' | 'right' | 'hidden' | 'float';

export interface FloatPos {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockState {
  left: string[];
  right: string[];
  hidden: string[];
  float: string[];
  /** Width of the left dock in pixels. */
  leftWidth: number;
  /** Width of the right dock in pixels. */
  rightWidth: number;
  /**
   * Per-panel height in pixels. Panels in a column share their
   * column's height; entries here are interpreted as preferred sizes
   * for non-`flex-1` panels (Layers etc.). Missing entries fall back
   * to the panel's CSS-only size.
   */
  panelHeights: Record<string, number>;
  /** Position + size for floating panels. */
  floatPos: Record<string, FloatPos>;
}

const DEFAULT_WIDTH = 280;
const DEFAULT_FLOAT_W = 280;
const DEFAULT_FLOAT_H = 360;

const DEFAULT_LAYOUT: DockState = {
  // Parts on top, Layers stacked underneath, both pinned to the right
  // so the canvas occupies the left side of the screen by default.
  // Used Parts starts hidden — user can show it via the Panels menu.
  left: [],
  right: ['parts', 'layers'],
  hidden: ['usedparts', 'modules', 'modlibrary', 'venuelibrary', 'views', 'routes', 'trains', 'places', 'liveops'],
  float: [],
  leftWidth: DEFAULT_WIDTH,
  rightWidth: DEFAULT_WIDTH,
  panelHeights: { layers: 240 },
  floatPos: {},
};

// Bump when the default layout changes in a way that should override
// existing per-user state (e.g. moving a panel to a new side). The
// reader checks the stored `version` and falls back to the new default
// when it's missing or older than this constant.
const LAYOUT_VERSION = 8;

function storageKey(userId: string | null): string {
  return userId ? `cld:dock:${userId}` : 'cld:dock:anon';
}

function loadDockState(userId: string | null): DockState {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<DockState> & { version?: number };
    if ((parsed.version ?? 0) < LAYOUT_VERSION) return DEFAULT_LAYOUT;
    return {
      left: Array.isArray(parsed.left) ? parsed.left : DEFAULT_LAYOUT.left,
      right: Array.isArray(parsed.right) ? parsed.right : DEFAULT_LAYOUT.right,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : DEFAULT_LAYOUT.hidden,
      float: Array.isArray(parsed.float) ? parsed.float : [],
      leftWidth: typeof parsed.leftWidth === 'number' ? parsed.leftWidth : DEFAULT_WIDTH,
      rightWidth: typeof parsed.rightWidth === 'number' ? parsed.rightWidth : DEFAULT_WIDTH,
      panelHeights:
        parsed.panelHeights && typeof parsed.panelHeights === 'object'
          ? (parsed.panelHeights as Record<string, number>)
          : DEFAULT_LAYOUT.panelHeights,
      floatPos:
        parsed.floatPos && typeof parsed.floatPos === 'object'
          ? (parsed.floatPos as Record<string, FloatPos>)
          : {},
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveDockState(userId: string | null, state: DockState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify({ version: LAYOUT_VERSION, ...state }),
    );
  } catch {
    /* quota / disabled — skip */
  }
}

const MIN_DOCK_WIDTH = 180;
const MAX_DOCK_WIDTH = 600;
export const MIN_PANEL_HEIGHT = 80;

function clampWidth(v: number): number {
  return Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, Math.round(v)));
}

export function useDockLayout(userId: string | null): {
  state: DockState;
  zoneOf: (panelId: string) => DockZone;
  setZone: (panelId: string, zone: DockZone) => void;
  setDockWidth: (zone: 'left' | 'right', widthPx: number) => void;
  setPanelHeight: (panelId: string, heightPx: number) => void;
  reorderPanel: (zone: 'left' | 'right', fromId: string, toId: string) => void;
  setFloatPos: (panelId: string, pos: Partial<FloatPos>) => void;
} {
  const [state, setState] = useState<DockState>(() => loadDockState(userId));

  useEffect(() => {
    setState(loadDockState(userId));
  }, [userId]);

  useEffect(() => {
    saveDockState(userId, state);
  }, [userId, state]);

  const zoneOf = useCallback(
    (panelId: string): DockZone => {
      if (state.left.includes(panelId)) return 'left';
      if (state.right.includes(panelId)) return 'right';
      if (state.float.includes(panelId)) return 'float';
      return 'hidden';
    },
    [state],
  );

  const setZone = useCallback((panelId: string, zone: DockZone) => {
    setState((s) => {
      const left = s.left.filter((id) => id !== panelId);
      const right = s.right.filter((id) => id !== panelId);
      const hidden = s.hidden.filter((id) => id !== panelId);
      const float = s.float.filter((id) => id !== panelId);
      let floatPos = s.floatPos;
      if (zone === 'left') left.push(panelId);
      else if (zone === 'right') right.push(panelId);
      else if (zone === 'float') {
        float.push(panelId);
        // Assign a default position if none stored yet, staggered by index.
        if (!floatPos[panelId]) {
          const offset = float.length * 24;
          floatPos = {
            ...floatPos,
            [panelId]: {
              x: 80 + offset,
              y: 80 + offset,
              width: DEFAULT_FLOAT_W,
              height: DEFAULT_FLOAT_H,
            },
          };
        }
      } else hidden.push(panelId);
      return { ...s, left, right, hidden, float, floatPos };
    });
  }, []);

  const setDockWidth = useCallback((zone: 'left' | 'right', widthPx: number) => {
    setState((s) => ({
      ...s,
      [zone === 'left' ? 'leftWidth' : 'rightWidth']: clampWidth(widthPx),
    }));
  }, []);

  const setPanelHeight = useCallback((panelId: string, heightPx: number) => {
    setState((s) => ({
      ...s,
      panelHeights: {
        ...s.panelHeights,
        [panelId]: Math.max(MIN_PANEL_HEIGHT, Math.round(heightPx)),
      },
    }));
  }, []);

  const reorderPanel = useCallback((zone: 'left' | 'right', fromId: string, toId: string) => {
    setState((s) => {
      const arr = [...s[zone]];
      const fromIdx = arr.indexOf(fromId);
      const toIdx = arr.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return s;
      arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, fromId);
      return { ...s, [zone]: arr };
    });
  }, []);

  const setFloatPos = useCallback((panelId: string, pos: Partial<FloatPos>) => {
    setState((s) => ({
      ...s,
      floatPos: {
        ...s.floatPos,
        [panelId]: { ...s.floatPos[panelId]!, ...pos },
      },
    }));
  }, []);

  return { state, zoneOf, setZone, setDockWidth, setPanelHeight, reorderPanel, setFloatPos };
}

/**
 * Dragging the divider below panel `index` in a column of stacked panels,
 * the way a splitter works: only that panel and the one below it change
 * size, by the same amount, and every other panel stays put. `heights`
 * are the panels' current heights (the last one fills what's left), and
 * `newHeight` the height the dragged panel should get. Returns the heights
 * to keep for every panel but the last, each at least `min`.
 */
export function splitterHeights(
  heights: readonly number[],
  index: number,
  newHeight: number,
  min: number = MIN_PANEL_HEIGHT,
): number[] {
  const pair = heights[index]! + heights[index + 1]!;
  const dragged = Math.round(Math.max(min, Math.min(pair - min, newHeight)));
  const out = heights.slice(0, -1).map((h) => Math.round(h));
  out[index] = dragged;
  if (index + 1 < heights.length - 1) out[index + 1] = Math.round(pair - dragged);
  return out;
}

