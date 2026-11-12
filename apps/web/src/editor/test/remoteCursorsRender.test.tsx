// Others' cursors and picks on a big layout (render/RemoteCursors.tsx).
// With anyone else here, the layer rendered again on every frame of a drag
// (it follows the dragged parts) and indexed every part by id after each
// change, about 18 ms on 7,520 parts at 4x slowed CPU. It follows a drag
// only when someone else has picked one of the dragged parts, and indexes
// only the parts others have picked.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BbmMap, Brick } from '@cld/model';
import type { Awareness } from 'y-protocols/awareness';

let prims = 0;
vi.mock('react-konva', () => {
  const mk = () => (p: { children?: ReactNode }) => {
    prims++;
    return h(Fragment, null, p.children);
  };
  return { Group: mk(), Rect: mk(), Line: mk(), Text: mk(), Label: mk(), Tag: mk() };
});

import { RemoteCursors } from '../render/RemoteCursors';
import { useLiveDragPose } from '../liveDragPose';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const N = 2000;
function bigMap(): { map: BbmMap; reads: () => number } {
  let reads = 0;
  const bricks: Brick[] = [];
  for (let i = 0; i < N; i++) {
    const b: Brick = { id: `b${i}`, displayArea: { x: i * 16, y: 0, width: 16, height: 8 }, myGroup: '', partNumber: 'p', orientation: 0, activeConnectionPointIndex: 0, altitude: 0, connexions: [] };
    // Counts how many parts are looked at (their id read).
    bricks.push(new Proxy(b, { get: (t, k) => ((k === 'id' && reads++), t[k as keyof Brick]) }));
  }
  const map = { layers: [{ type: 'brick', id: 'L', visible: true, bricks, groups: [] }] } as unknown as BbmMap;
  return { map, reads: () => reads };
}

/** An awareness with one other person in it, whose pick can be changed. */
function awarenessWith(pick: string[]) {
  const listeners = new Set<(c: { added: number[]; updated: number[]; removed: number[] }) => void>();
  const states = new Map<number, unknown>([
    [1, { user: { id: 'me', displayName: 'Me' }, selection: { brickIds: [] }, lastActivityMs: Date.now(), cursor: null }],
    [2, { user: { id: 'bob', displayName: 'Bob' }, selection: { brickIds: pick }, lastActivityMs: Date.now(), cursor: { x: 1, y: 1 } }],
  ]);
  const a = {
    clientID: 1,
    getStates: () => states,
    getLocalState: () => states.get(1),
    on: (_: string, f: (c: { added: number[]; updated: number[]; removed: number[] }) => void) => listeners.add(f),
    off: (_: string, f: (c: { added: number[]; updated: number[]; removed: number[] }) => void) => listeners.delete(f),
    pick(ids: string[]) {
      states.set(2, { ...(states.get(2) as object), selection: { brickIds: ids } });
      for (const f of listeners) f({ added: [], updated: [2], removed: [] });
    },
  };
  return a;
}

describe('RemoteCursors on a big layout', () => {
  it("follows a drag only when someone else has one of the dragged parts picked, and looks only for others' picks", async () => {
    const { map, reads } = bigMap();
    const aw = awarenessWith([]);
    const root = createRoot(document.createElement('div'));
    const render = (m: BbmMap) => h(RemoteCursors, { awareness: aw as unknown as Awareness, map: m, zoom: 1 });
    await act(async () => root.render(render(map)));
    // Nobody else has a pick: no part is looked at.
    expect(reads()).toBe(0);

    // A drag of b5 here: nothing of Bob's moves with it, so no render per frame.
    const pose = (to: number) => ({ ids: new Set(['b5']), startAreas: new Map([['b5', { x: 80, y: 0, width: 16, height: 8 }]]), about: { x: 88, y: 4 }, to: { x: 88 + to, y: 4 }, degrees: 0 });
    prims = 0;
    for (let f = 1; f <= 10; f++) await act(async () => useLiveDragPose.getState().setPose(pose(f)));
    expect(prims).toBe(0);
    await act(async () => useLiveDragPose.getState().setPose(null));

    // Bob picks b5 and b7: they're found (one look through the parts) and drawn.
    await act(async () => aw.pick(['b5', 'b7']));
    expect(reads()).toBeLessThanOrEqual(N + 10);
    // Now a drag of b5 moves his outline with it, frame by frame.
    prims = 0;
    for (let f = 1; f <= 3; f++) await act(async () => useLiveDragPose.getState().setPose(pose(f)));
    expect(prims).toBeGreaterThanOrEqual(3);
    await act(async () => useLiveDragPose.getState().setPose(null));
    await act(async () => root.unmount());
  });
});
