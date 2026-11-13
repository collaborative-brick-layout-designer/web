// The selection overlay (SelectionOverlay.ts): one shape draws every picked
// part's halo and free connection dots, from each part's own node, and
// only for the parts on its own layer (a drag moves parts to the drag
// layer, which gets a copy). It counts the parts it draws.

import { describe, expect, it } from 'vitest';
import type Konva from 'konva';
import type { Brick } from '@cld/model';
import type { PartWire } from '../../api';
import { connectionDots, drawSelection, haloOutline, type GlyphInfo } from './SelectionOverlay';
import { SELECTION } from './selectionStyle';

const brick = (over: Partial<Brick> = {}): Brick =>
  ({ id: 'b', partNumber: '3001.1', connexions: [], activeConnectionPointIndex: 0, ...over }) as unknown as Brick;
const part = (connections: { type: string; x: number; y: number }[], extra: Partial<PartWire> = {}): PartWire =>
  ({ connections, ...extra }) as unknown as PartWire;

/** A canvas context that records the calls the overlay makes; `at` is its transform (the layer's own canvas: its pixel ratio, 2). */
function recorder(at = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }) {
  const calls: string[] = [];
  const c = new Proxy(
    {},
    {
      get: (_t, k) => (k === 'canvas' ? {} : k === 'getTransform' ? () => at : (...args: unknown[]) => calls.push(`${String(k)}(${args.filter((a) => typeof a === 'number').map((n) => Math.round(n as number)).join(',')})`)),
      set: (_t, k, v) => {
        calls.push(`${String(k)}=${String(v)}`);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  const ctx = { _context: c, getCanvas: () => ({ getPixelRatio: () => 2 }) } as unknown as Konva.Context;
  return { calls, ctx };
}

describe('selection overlay', () => {
  it('outlines a part 1 px outside its picture, or along an imported part’s own outline', () => {
    const pad = SELECTION.partPadPx;
    expect(haloOutline({ meta: undefined, spriteW: 32, spriteH: 16 })).toEqual([
      [{ x: -16 - pad, y: -8 - pad }, { x: 16 + pad, y: -8 - pad }, { x: 16 + pad, y: 8 + pad }, { x: -16 - pad, y: 8 + pad }],
    ]);
    const ring = haloOutline({ meta: part([], { pickShape: [[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]] } as Partial<PartWire>), spriteW: 0, spriteH: 0 });
    expect(ring).toHaveLength(1);
    expect(ring[0]).toHaveLength(3);
  });

  it('dots only the free numbered connections, the active one gold, and none on a hinged part with the select tool', () => {
    const meta = part([
      { type: '1', x: 1, y: 0 },
      { type: '1', x: -1, y: 0 },
      { type: 'custom', x: 0, y: 1 },
    ]);
    const b = brick({ connexions: [{ linkedTo: 'other' }, { linkedTo: '' }, { linkedTo: '' }], activeConnectionPointIndex: 1 } as Partial<Brick>);
    expect(connectionDots(b, meta, true)).toEqual([{ x: -8, y: 0, active: true }]);
    expect(connectionDots(b, undefined, true)).toEqual([]);
  });

  // Stand-ins for Konva nodes (jsdom has no canvas): a layer, and a part's group at (x, y).
  const parts = { name: 'parts' };
  const drag = { name: 'drag' };
  const shapeOn = (layer: object) =>
    ({ getLayer: () => layer, getAbsoluteTransform: () => ({ getMatrix: () => [1, 0, 0, 1, 0, 0] }), attrs: {} as Record<string, unknown> }) as unknown as Konva.Shape;
  const groupAt = (layer: object, x: number, y: number) =>
    ({ getLayer: () => layer, getAbsoluteTransform: () => ({ getMatrix: () => [1, 0, 0, 1, x, y] }) }) as unknown as Konva.Group;

  it('draws the picked parts on its own layer only, from where their nodes are now', () => {
    const overlay = shapeOn(parts);
    const glyphs = new Map<string, GlyphInfo>();
    for (const [id, layer, x] of [['a', parts, 10], ['b', parts, 50], ['c', drag, 90]] as const) {
      glyphs.set(id, { group: { current: groupAt(layer, x, 20) }, brick: brick({ id }), meta: undefined, spriteW: 8, spriteH: 8 });
    }
    const { calls, ctx } = recorder();
    const drawn = drawSelection(ctx, overlay, {
      glyphs,
      haloIds: ['a', 'b', 'c', 'gone'],
      dotIds: [],
      colors: () => ({ stroke: '#FFD700', fill: '#FFD7004D' }),
      bendHandles: true,
    });
    // a and b (c is on the drag layer; 'gone' has no part).
    expect(drawn).toBe(2);
    expect(overlay.attrs.drawn).toEqual({ halos: 2, dots: 0, stroke: '#FFD700', ids: ['a', 'b', 'c', 'gone'] });
    // Device px (pixel ratio 2): a's halo starts at (10 - 4 - 1) * 2, (20 - 4 - 1) * 2.
    expect(calls).toContain('moveTo(10,30)');
    // The desktop's order for each part: dark outline, the tint's fill, the tint's outline.
    const order = calls.filter((c) => c.startsWith('stroke(') || c.startsWith('fill(') || c.startsWith('strokeStyle') || c.startsWith('fillStyle'));
    expect(order.slice(0, 5)).toEqual([`strokeStyle=${SELECTION.partOuter}`, 'stroke()', 'fillStyle=#FFD7004D', 'fill()', 'strokeStyle=#FFD700']);
    // A copy of the overlay on the drag layer draws c only.
    const copy = shapeOn(drag);
    expect(drawSelection(recorder().ctx, copy, { glyphs, haloIds: ['a', 'b', 'c'], dotIds: [], colors: () => ({ stroke: 'x', fill: 'y' }), bendHandles: true })).toBe(1);
  });

  // The picture kept for a pan has a margin around the view: the layer is
  // drawn into it moved by that margin. The halos were drawn at the view's
  // device px, a margin away from their parts.
  it('on another canvas, draws the halos where that canvas has the parts', () => {
    const overlay = shapeOn(parts);
    const glyphs = new Map<string, GlyphInfo>([['a', { group: { current: groupAt(parts, 10, 20) }, brick: brick({ id: 'a' }), meta: undefined, spriteW: 8, spriteH: 8 }]]);
    const draw = (at: { a: number; b: number; c: number; d: number; e: number; f: number }) => {
      const { calls, ctx } = recorder(at);
      drawSelection(ctx, overlay, { glyphs, haloIds: ['a'], dotIds: [], colors: () => ({ stroke: 's', fill: 'f' }), bendHandles: true });
      return calls;
    };
    // Its own canvas: drawn at identity, as before.
    expect(draw({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })).toContain('setTransform(1,0,0,1,0,0)');
    // The picture: moved 300 by 200 px (the margin), at the same pixel ratio.
    const moved = draw({ a: 2, b: 0, c: 0, d: 2, e: 300, f: 200 });
    expect(moved).toContain('setTransform(1,0,0,1,300,200)');
    expect(moved).toContain('moveTo(10,30)');
  });

  it('draws nothing, cheaply, when nothing is picked', () => {
    const { calls, ctx } = recorder();
    expect(drawSelection(ctx, shapeOn(parts), { glyphs: new Map(), haloIds: [], dotIds: [], colors: () => ({ stroke: '', fill: '' }), bendHandles: true })).toBe(0);
    expect(calls).toEqual([]);
  });
});
