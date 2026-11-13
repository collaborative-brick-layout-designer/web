// A sheet of parts stops Konva's walk through every node when the view
// moves (lazyTransforms.ts): each node's place on screen still comes out as
// Konva works it out afresh, while the walk visits only the nodes outside
// sheets.

import Konva from 'konva';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installLazyTransforms, lazyTransforms } from './lazyTransforms';

installLazyTransforms();

// jsdom has no canvas: a 2D context that takes every call.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    const t: Record<string, unknown> = { getImageData: () => ({ data: new Uint8ClampedArray(400).map((_, i) => (i % 4 === 3 ? 255 : 40)) }) };
    return new Proxy(t, { get: (o, k: string) => (k in o ? o[k] : () => undefined), set: (o, k: string, v) => ((o[k] = v), true) });
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

let stage: Konva.Stage;
afterEach(() => {
  stage?.destroy();
  lazyTransforms.enabled = true;
});

function build(): { layer: Konva.Layer; sheet: Konva.Group; nodes: Konva.Node[] } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  stage = new Konva.Stage({ container, width: 400, height: 300 });
  const layer = new Konva.Layer();
  stage.add(layer);
  const sheet = new Konva.Group({ x: 5, y: -3, partsIndexed: true } as Konva.GroupConfig);
  layer.add(sheet);
  const nodes: Konva.Node[] = [layer, sheet];
  for (let i = 0; i < 300; i++) {
    const g = new Konva.Group({ x: (i % 20) * 30, y: Math.floor(i / 20) * 30, rotation: i * 7, cullR: 10 } as Konva.GroupConfig);
    const r = new Konva.Rect({ x: -5, y: -5, width: 10, height: 10, scaleX: 1 + (i % 3) });
    g.add(r);
    sheet.add(g);
    nodes.push(g, r);
  }
  // Outside the sheet: a label on the layer.
  const t = new Konva.Rect({ x: 3, y: 4, width: 2, height: 2 });
  layer.add(t);
  nodes.push(t);
  return { layer, sheet, nodes };
}

/** Each node's place, kept or worked out afresh from the stage down. */
const places = (nodes: Konva.Node[]) => nodes.map((n) => n.getAbsoluteTransform().getMatrix().map((v) => Math.round(v * 1e9) / 1e9));
/** Worked out afresh: each transform from the stage down, multiplied. */
const fresh = (nodes: Konva.Node[]) =>
  nodes.map((n) => {
    const chain: Konva.Node[] = [];
    for (let p: Konva.Node | null = n; p; p = p.parent) chain.unshift(p);
    const m = new Konva.Transform();
    for (const p of chain) m.multiply(p.getTransform());
    return m.getMatrix().map((v) => Math.round(v * 1e9) / 1e9);
  });

describe('a sheet of parts when the view moves', () => {
  it("keeps each node's place right, read in any order", () => {
    const { nodes } = build();
    places(nodes);
    for (const [x, y, s] of [[10, 0, 1], [-37.5, 12, 1], [-37.5, 12, 0.4], [100, -3, 0.4], [0, 0, 2]] as const) {
      stage.setAttrs({ x, y, scaleX: s, scaleY: s });
      // Children before parents, and the other way round.
      const backwards = [...nodes].reverse();
      expect(places(backwards).reverse()).toEqual(fresh(nodes));
      expect(places(nodes)).toEqual(fresh(nodes));
    }
  });

  it('a part that moves meanwhile, or moves to another sheet, is right too', () => {
    const { layer, sheet, nodes } = build();
    places(nodes);
    stage.position({ x: 40, y: 7 });
    (nodes[10] as Konva.Group).x(999);
    const other = new Konva.Group({ x: 1, y: 2 });
    layer.add(other);
    (nodes[20] as Konva.Group).moveTo(other);
    stage.position({ x: 41, y: 8 });
    expect(places(nodes)).toEqual(fresh(nodes));
    sheet.x(sheet.x() + 3);
    expect(places(nodes)).toEqual(fresh(nodes));
  });

  it("tells only the nodes outside sheets (Konva told each part)", () => {
    const { nodes } = build();
    places(nodes);
    let told = 0;
    const fire = Konva.Node.prototype.fire;
    Konva.Node.prototype.fire = function (this: Konva.Node, type: string, ...a: unknown[]) {
      if (type === 'absoluteTransformChange') told++;
      return (fire as (...x: unknown[]) => Konva.Node).call(this, type, ...a);
    } as typeof fire;
    try {
      stage.position({ x: 12, y: 3 });
      // The stage, the layer, the sheet and the label.
      expect(told).toBeLessThan(10);
      lazyTransforms.enabled = false;
      told = 0;
      stage.position({ x: 13, y: 3 });
      expect(told).toBeGreaterThan(600);
    } finally {
      Konva.Node.prototype.fire = fire;
    }
  });
});
