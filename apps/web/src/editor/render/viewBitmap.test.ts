// The picture kept for the next pan (viewBitmap.ts) is taken afresh while
// the page is idle: a band of a strip at a time, so it isn't one long
// task after each pan (about 150 ms on 7,520 parts zoomed in at 4x slowed
// CPU in one go, about 50 ms a strip). A
// change while it's being taken is drawn into it when it's done; a pan
// that starts first takes it at once. That the pixels are right is the browser test's job
// (e2e/test/bigLayoutWork.spec.ts).

import Konva from 'konva';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cullOffscreen, cullStats } from './cullOffscreen';
import { ViewBitmap } from './viewBitmap';

beforeAll(() => {
  // The layer is drawn by the test, when it says (not on the next frame).
  Konva.autoDrawEnabled = false;
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

afterAll(() => {
  Konva.autoDrawEnabled = true;
});

let stage: Konva.Stage;
let layer: Konva.Layer;
let vb: ViewBitmap;
let undo: () => void;
const parts: Konva.Group[] = [];
/** Idle callbacks waiting to run, by handle. */
let idle = new Map<number, (d: { timeRemaining: () => number }) => void>();
let nextHandle = 1;

beforeEach(() => {
  vi.useFakeTimers();
  idle = new Map();
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: (d: { timeRemaining: () => number }) => void) => {
    idle.set(nextHandle, cb);
    return nextHandle++;
  };
  (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = (h: number) => {
    idle.delete(h);
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  stage = new Konva.Stage({ container, width: 400, height: 300 });
  layer = new Konva.Layer();
  stage.add(layer);
  const sheet = new Konva.Group();
  layer.add(sheet);
  parts.length = 0;
  // Parts over twice the view each way: the picture's margin has parts in it.
  for (let j = 0; j < 30; j++) {
    for (let i = 0; i < 40; i++) {
      const g = new Konva.Group({ x: -400 + i * 30, y: -300 + j * 30, cullR: 12 } as Konva.GroupConfig);
      g.add(new Konva.Rect({ x: -8, y: -8, width: 16, height: 16, fill: 'red' }));
      sheet.add(g);
      parts.push(g);
    }
  }
  undo = cullOffscreen(layer);
  vb = new ViewBitmap(stage, () => [layer]);
  vb.watchLayers();
  layer.draw();
});

afterEach(() => {
  vb.dispose();
  undo();
  stage.destroy();
  vi.useRealTimers();
});

/** Runs the next idle callback with no time to spare; how many parts it drew. */
function idleMoment(): number {
  const first = idle.keys().next();
  if (first.done) return -1;
  const cb = idle.get(first.value)!;
  idle.delete(first.value);
  cullStats.drawn = 0;
  cb({ timeRemaining: () => 0 });
  return cullStats.drawn;
}

describe('the picture for the next pan', () => {
  it('is taken a band at a time while idle', () => {
    vb.invalidate();
    vi.advanceTimersByTime(1100);
    const drawn: number[] = [];
    while (idle.size > 0) drawn.push(idleMoment());
    expect(vb.taken).toBe(1);
    // The view copied from the canvas (no part), then the margin's strips,
    // each in bands about 256 px across its long side: 4 each above and
    // below (800 px), 2 each at the sides (300 px). In whole strips it was 5.
    expect(drawn.length).toBe(13);
    const all = drawn.reduce((a, b) => a + b, 0);
    expect(all).toBeGreaterThan(400);
    expect(Math.max(...drawn)).toBeLessThan(all / 6);
    // And it's of this view: nothing is taken for a move that starts now.
    vb.freeze();
    expect(vb.taken).toBe(1);
    vb.thaw();
  });

  it('brings it up to date after a change while it is taken, and a move takes it at once', () => {
    vb.invalidate();
    vi.advanceTimersByTime(1100);
    idleMoment();
    idleMoment();
    // A part moves: the sheet draws again. The picture goes on being
    // taken (pictures arriving one by one kept starting it again), then
    // the part's places in it are drawn again.
    parts[600]!.x(parts[600]!.x() + 5);
    layer.draw();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1100);
      while (idle.size > 0) idleMoment();
    }
    expect(vb.taken).toBe(1);
    expect(vb.patched).toBe(1);

    // A change since that's only parts: the kept picture is brought up to
    // date in their places, at once.
    parts[601]!.x(parts[601]!.x() + 5);
    layer.draw();
    vi.advanceTimersByTime(1100);
    expect(idleMoment()).toBeLessThan(20);
    expect(idle.size).toBe(0);
    expect(vb.taken).toBe(1);
    expect(vb.patched).toBe(2);

    // Half taken afresh (after a draw of the whole view) when a move starts: it's taken at once.
    layer.draw();
    vi.advanceTimersByTime(1100);
    idleMoment();
    vb.freeze();
    expect(vb.taken).toBe(2);
    vb.thaw();
  });
});
