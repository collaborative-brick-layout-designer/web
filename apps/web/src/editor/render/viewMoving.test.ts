// While the view moves, the hit canvases aren't drawn and nothing is hit
// (viewMoving.ts), without Konva's `listening` switch: on 7,520 parts it
// visited every node twice per pan and made each hit canvas again.

import Konva from 'konva';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HitCanvas } from 'konva/lib/Canvas';
import { cullOffscreen } from './cullOffscreen';
import { hitsHeld, holdHits, releaseHits } from './viewMoving';

beforeAll(() => {
  // jsdom has no canvas: a 2D context that takes every call.
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const real: Record<string, unknown> = {
      canvas: this,
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      measureText: () => ({ width: 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(400).map((_, i) => (i % 4 === 3 ? 255 : 40)) }),
    };
    return new Proxy(real, { get: (t, k: string) => (k in t ? t[k] : () => undefined), set: (t, k: string, v) => ((t[k] = v), true) });
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

let stage: Konva.Stage;
let parts: Konva.Layer;
let other: Konva.Layer;
let hits = 0;
let undoCull: () => void;
const proto = Konva.Shape.prototype as unknown as { drawHit: (...a: unknown[]) => unknown; __hit?: (...a: unknown[]) => unknown };

beforeEach(() => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  stage = new Konva.Stage({ container, width: 400, height: 300 });
  parts = new Konva.Layer();
  other = new Konva.Layer();
  stage.add(parts, other);
  const sheet = new Konva.Group();
  parts.add(sheet);
  for (let i = 0; i < 500; i++) {
    const g = new Konva.Group({ x: (i % 25) * 16, y: Math.floor(i / 25) * 16, cullR: 10 } as Konva.GroupConfig);
    g.add(new Konva.Rect({ x: -6, y: -6, width: 12, height: 12, fill: 'red' }));
    sheet.add(g);
  }
  other.add(new Konva.Rect({ width: 20, height: 20, fill: 'blue' }));
  undoCull = cullOffscreen(parts);
  proto.__hit ??= proto.drawHit;
  const base = proto.__hit;
  proto.drawHit = function (this: unknown, ...a: unknown[]) {
    hits++;
    return base.apply(this, a);
  };
  stage.draw();
  hits = 0;
});

afterEach(() => {
  undoCull();
  stage.destroy();
});

describe('holding the hits while the view moves', () => {
  it('draws no hit canvas and hits nothing, and gives both back after', () => {
    const cullDrawHit = parts.drawHit;
    const at = { x: 8, y: 8 };
    // (The stand-in canvas has no pixels to hit: what's checked is whether the layers are asked.)
    let asked = 0;
    for (const l of [parts, other]) {
      const own = l.getIntersection.bind(l);
      l.getIntersection = (p) => {
        asked++;
        return own(p);
      };
    }
    stage.getIntersection(at);
    expect(asked).toBe(2);
    asked = 0;
    holdHits(stage);
    expect(hitsHeld(stage)).toBe(true);
    expect('viewMoving' in stage.container().dataset).toBe(true);
    stage.position({ x: -30, y: -10 });
    stage.draw();
    expect(hits).toBe(0);
    expect(stage.getIntersection(at)).toBeNull();
    expect(asked).toBe(0);
    // Konva still says the stage and every part listen.
    expect(stage.listening()).toBe(true);
    // A draw into another canvas (an export) still draws every shape.
    const canvas = new HitCanvas({ width: 400, height: 300 });
    parts.drawHit(canvas);
    expect(hits).toBeGreaterThan(0);

    hits = 0;
    releaseHits(stage);
    expect(hitsHeld(stage)).toBe(false);
    expect('viewMoving' in stage.container().dataset).toBe(false);
    // The parts layer's own hit drawing (cullOffscreen's) is back.
    expect(parts.drawHit).toBe(cullDrawHit);
    expect(Object.prototype.hasOwnProperty.call(other, 'drawHit')).toBe(false);
    stage.draw();
    expect(hits).toBeGreaterThan(0);
    stage.getIntersection(at);
    expect(asked).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(stage, 'getIntersection')).toBe(false);
  });

  it("doesn't visit the map's nodes", () => {
    const node = Konva.Node.prototype as unknown as { _clearSelfAndDescendantCache: (...a: unknown[]) => unknown };
    const clear = node._clearSelfAndDescendantCache;
    let visits = 0;
    node._clearSelfAndDescendantCache = function (this: unknown, ...a: unknown[]) {
      visits++;
      return clear.apply(this, a);
    };
    try {
      holdHits(stage);
      releaseHits(stage);
      expect(visits).toBe(0);
      // (Konva's own switch visits every one of them, both ways.)
      stage.listening(false);
      stage.listening(true);
      expect(visits).toBeGreaterThan(2 * 1000);
    } finally {
      node._clearSelfAndDescendantCache = clear;
    }
  });
});
