// Bend handles (render/BendHandles.tsx): a selected flex track's run gets a
// handle on each free end, and dragging one bends the whole run — the
// desktop's MapViewTest.ABendHandleOnTheFreeEndBendsTheWholeRun.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Konva from 'konva';
import type { LayerBrick } from '@cld/model';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import type { PartWire } from '../../api';
import { insertBricks } from '../mutations';
import { catalogFromParts, recomputeConnectivity } from '../useConnectivity';
import { startFlexSession } from '../flexSession';
import { BEND_HANDLE_PX, flexRunEnds, handleCircle } from '../render/BendHandles';
import { areaForPivot, connectionWorld, rotated } from '../brickGeometry';
import { useEditorStore } from '../editorStore';
import { liveSnapReach } from '../liveSnapReach';

const half = (key: string, connections: unknown[]) =>
  ({ key, partNumber: key.split('.')[0], colorCode: '8', kind: 'leaf', pxPerStud: 8, hullPts: [], connections, subparts: [] }) as unknown as PartWire;
// 88492.8 / 88493.8 from BlueBrickParts (studs).
const FEMALE = half('88492.8', [
  { type: '1', x: -1.15, y: 0, angle: 180, electricPlug: 0 },
  { type: 'flexpivot', x: 0.85, y: 0, angle: 0, electricPlug: 0 },
]);
const MALE = half('88493.8', [
  { type: '1', x: 1.25, y: 0, angle: 0, electricPlug: 0 },
  { type: 'flexpivot', x: -0.75, y: 0, angle: 180, electricPlug: 0 },
]);
const PARTS = new Map([FEMALE, MALE].map((p) => [p.key, p]));

/** Two flex track sets end to end (set origins at x = 0 and 4). */
function twoSets() {
  const doc = createDefaultLayoutDoc();
  const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
  const area = (cx: number) => ({ x: cx - 1.15, y: -2, width: 2.3, height: 4 });
  const ids = insertBricks(doc, layerId, [
    { partNumber: '88492.8', displayArea: area(-0.8) },
    { partNumber: '88493.8', displayArea: area(0.8) },
    { partNumber: '88492.8', displayArea: area(3.2) },
    { partNumber: '88493.8', displayArea: area(4.8) },
  ]);
  recomputeConnectivity(doc, catalogFromParts([FEMALE, MALE]));
  return { doc, layerId, ids };
}
const layerOf = (doc: ReturnType<typeof twoSets>['doc']) => docToBbm(doc).layers.find((l): l is LayerBrick => l.type === 'brick')!;

// A stage whose pointer we move by hand.
let pointer: { x: number; y: number } | null = null;
const handlers = new Map<string, (e?: unknown) => void>();
const stage = {
  on: (name: string, fn: (e?: unknown) => void) => handlers.set(name, fn),
  off: () => undefined,
  getPointerPosition: () => pointer,
  getAbsoluteTransform: () => ({ copy: () => ({ invert: () => ({ point: (p: { x: number; y: number }) => p }) }) }),
  findOne: () => undefined,
  batchDraw: () => undefined,
} as unknown as Konva.Stage;

afterEach(() => {
  vi.restoreAllMocks();
  handlers.clear();
  pointer = null;
  useEditorStore.getState().setSelection([]);
});

describe('bend handles', () => {
  it('sit on the free ends of the whole run of the selected set', () => {
    const { doc, ids } = twoSets();
    const ends = flexRunEnds(docToBbm(doc), [ids[0]!], PARTS);
    expect(ends.map((e) => Math.round(e.world.x * 100) / 100).sort((a, b) => a - b)).toEqual([-1.95, 6.05]);
    expect([...ends[0]!.run].sort()).toEqual([...ids].sort());
  });

  it('give none to a run joined at both ends, or to rigid track', () => {
    const { doc, ids } = twoSets();
    expect(flexRunEnds(docToBbm(doc), [], PARTS)).toEqual([]);
    const straight = new Map([...PARTS, ['straight.8', half('straight.8', [{ type: '1', x: -8, y: 0, angle: 180 }, { type: '1', x: 8, y: 0, angle: 0 }])]]);
    insertBricks(doc, layerOf(doc).id, [
      { partNumber: 'straight.8', displayArea: { x: -9.95 - 8, y: -4, width: 16, height: 8 } },
      { partNumber: 'straight.8', displayArea: { x: 6.05, y: -4, width: 16, height: 8 } },
    ]);
    recomputeConnectivity(doc, catalogFromParts([...straight.values()]));
    expect(flexRunEnds(docToBbm(doc), [ids[0]!], straight)).toEqual([]);
  });

  it("with only rigid track picked, a big sheet isn't indexed for them", () => {
    const STRAIGHT = half('2865.8', [
      { type: '1', x: -8, y: 0, angle: 180, electricPlug: 0 },
      { type: '1', x: 8, y: 0, angle: 0, electricPlug: 0 },
    ]);
    const bricks = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, partNumber: '2865.8', displayArea: { x: i * 16, y: 0, width: 16, height: 8 }, orientation: 0, myGroup: '', activeConnectionPointIndex: 0, altitude: 0, connexions: [{ id: `s${i}a`, linkedTo: '' }, { id: `s${i}b`, linkedTo: '' }] }));
    // Counts the parts gone through (a part's connections read).
    let reads = 0;
    const counted = bricks.map((b) => new Proxy(b, { get: (t, k) => ((k === 'connexions' && reads++), t[k as keyof typeof t]) }));
    const map = { layers: [{ type: 'brick', id: 'L', visible: true, bricks: counted, groups: [] }] } as unknown as Parameters<typeof flexRunEnds>[0];
    expect(flexRunEnds(map, ['s10', 's11'], new Map([[STRAIGHT.key, STRAIGHT]]))).toEqual([]);
    // It read every part's connections to index them, after every change while anything was picked.
    expect(reads).toBe(0);
  });

  it('bend the run as the end is dragged, the far end staying put', () => {
    const { doc, layerId, ids } = twoSets();
    const end = flexRunEnds(docToBbm(doc), [ids[0]!], PARTS).find((e) => e.world.x > 5)!;
    const before = layerOf(doc).bricks;
    const started = startFlexSession({
      stage,
      doc,
      map: docToBbm(doc),
      layerId,
      grabbedId: end.brickId,
      chain: end.run,
      activeConnection: end.connection,
      mouseStuds: end.world,
      partsByKey: PARTS,
      label: 'Bend flex track',
      onEnd: () => undefined,
    });
    expect(started).toBe(true);
    for (const p of [{ x: 6, y: -0.5 }, { x: 5.8, y: -1.5 }]) {
      pointer = { x: p.x * 8, y: p.y * 8 };
      handlers.get('mousemove.flex touchmove.flex')!();
    }
    handlers.get('mouseup.flex touchend.flex')!();
    const after = layerOf(doc).bricks;
    expect(after[0]!.displayArea).toEqual(before[0]!.displayArea);
    expect(after[3]!.orientation).not.toBe(before[3]!.orientation);
    expect(useEditorStore.getState().statusMessage).toBe('Bend flex track');
  });
});

describe('the handle on screen', () => {
  it('is the same size at every zoom, frame after frame', () => {
    // As Konva draws it: the shape's absolute scale is the stage's zoom.
    for (const zoom of [0.25, 1, 6]) {
      for (const [touch, ring, hit] of [
        [false, BEND_HANDLE_PX.ring.mouse, BEND_HANDLE_PX.hit.mouse],
        [true, BEND_HANDLE_PX.ring.touch, BEND_HANDLE_PX.hit.touch],
      ] as const) {
        const radii: number[] = [];
        const ctx = {
          beginPath: () => undefined,
          closePath: () => undefined,
          moveTo: () => undefined,
          lineTo: () => undefined,
          arc: (_x: number, _y: number, r: number) => radii.push(r),
          fillStrokeShape: () => undefined,
        };
        const shape = { getAbsoluteScale: () => ({ x: zoom, y: zoom }) };
        handleCircle(ring)(ctx as never, shape as never);
        handleCircle(hit)(ctx as never, shape as never);
        expect(radii.map((r) => r * zoom), `zoom ${zoom} touch ${touch}`).toEqual([ring, hit]);
      }
    }
    expect(BEND_HANDLE_PX.hit.touch * 2).toBe(44);
  });
});

describe('bending the end onto track at a large angle', () => {
  const STRAIGHT = half('2865.8', [
    { type: '1', x: -8, y: 0, angle: 180, electricPlug: 0 },
    { type: '1', x: 8, y: 0, angle: 0, electricPlug: 0 },
  ]);
  const ALL = new Map([...PARTS, ['2865.8', STRAIGHT]]);

  it('snaps on the way, holds through a wobbly hand, and links on release', () => {
    // A straight, six flex sets, and a straight where the run ends when
    // each set bends 8 degrees: 48 degrees in all.
    const sets = 6;
    const bend = 8;
    const place = (part: PartWire, orientation: number, conn: number, at: { x: number; y: number }) => {
      const c = part.connections[conn]!;
      const r = rotated({ x: c.x, y: c.y }, orientation);
      return { partNumber: part.key, orientation, displayArea: areaForPivot(part, orientation, { x: at.x - r.x, y: at.y - r.y }) };
    };
    let at = { x: -1.95, y: 0 };
    let turn = 0;
    for (let k = 0; k < sets; k++) {
      const female = place(FEMALE, turn, 0, at);
      const male = place(MALE, turn + bend, 1, connectionWorld(female, FEMALE, 1));
      at = connectionWorld(male, MALE, 0);
      turn += bend;
    }
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const straight: Parameters<typeof insertBricks>[2] = [place(STRAIGHT, 0, 1, { x: -1.95, y: 0 })];
    for (let k = 0; k < sets; k++) {
      let p = { x: 4 * k - 1.95, y: 0 };
      const female = place(FEMALE, 0, 0, p);
      p = connectionWorld(female, FEMALE, 1);
      const male = place(MALE, 0, 1, p);
      straight.push(female, male);
    }
    straight.push(place(STRAIGHT, turn, 0, at));
    const ids = insertBricks(doc, layerId, straight);
    recomputeConnectivity(doc, catalogFromParts([...ALL.values()]));
    const ends = flexRunEnds(docToBbm(doc), [ids[1]!], ALL);
    expect(ends).toHaveLength(1);
    const end = ends[0]!;
    expect(end.world.x).toBeCloseTo(4 * sets - 1.95, 2);

    // A slow hand: one move every 100 ms.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 100));
    expect(
      startFlexSession({
        stage,
        doc,
        map: docToBbm(doc),
        layerId,
        grabbedId: end.brickId,
        chain: end.run,
        activeConnection: end.connection,
        mouseStuds: end.world,
        partsByKey: ALL,
        label: 'Bend flex track',
        onEnd: () => undefined,
      }),
    ).toBe(true);
    const near = { x: at.x - 0.6, y: at.y + 0.4 };
    const snaps: (string | null)[] = [];
    for (let i = 1; i <= 16; i++) {
      const f = Math.min(1, i / 12);
      const wobble = { x: 0.25 * Math.sin(i * 1.7), y: 0.25 * Math.cos(i * 2.3) };
      pointer = { x: (end.world.x + (near.x - end.world.x) * f + wobble.x) * 8, y: (end.world.y + (near.y - end.world.y) * f + wobble.y) * 8 };
      handlers.get('mousemove.flex touchmove.flex')!();
      const s = useEditorStore.getState().liveSnap;
      snaps.push(s ? `${s.studX.toFixed(2)},${s.studY.toFixed(2)}` : null);
    }
    // Once it snaps, it stays on the target, frame after frame.
    const first = snaps.findIndex((s) => s !== null);
    expect(first).toBeGreaterThan(0);
    expect(new Set(snaps.slice(first))).toEqual(new Set([`${at.x.toFixed(2)},${at.y.toFixed(2)}`]));
    // Pulled away past the reach, it holds on; past the hold, it lets go.
    const reach = liveSnapReach();
    const frame = (d: number) => {
      pointer = { x: (at.x - d * 0.6) * 8, y: (at.y + d * 0.8) * 8 };
      handlers.get('mousemove.flex touchmove.flex')!();
      return useEditorStore.getState().liveSnap !== null;
    };
    expect(frame(reach * 1.3)).toBe(true);
    expect(frame(reach * 1.5)).toBe(true);
    expect(frame(reach * 2.2)).toBe(false);
    expect(frame(reach * 1.3)).toBe(false); // a new snap needs the reach
    expect(frame(reach * 0.5)).toBe(true);
    handlers.get('mouseup.flex touchend.flex')!();
    recomputeConnectivity(doc, catalogFromParts([...ALL.values()]));
    const bricks = layerOf(doc).bricks;
    const last = bricks[2 * sets]!;
    expect(last.connexions[0]!.linkedTo).toBe(bricks[2 * sets + 1]!.connexions[0]!.id);
    expect(Math.abs(last.orientation - turn)).toBeLessThan(2);
    expect(bricks[1]!.connexions[0]!.linkedTo).toBe(bricks[0]!.connexions[1]!.id);
  });
});
