// The parts layer draws only the changed places again when only parts
// changed (cullOffscreen.ts). jsdom has no canvas, so the 2D context here
// is a stand-in that takes every call and remembers the clips: what's
// checked is which draws are whole, which places a partial one clips to,
// and which parts it draws there. That the pixels match a whole draw is
// the browser test's job (e2e/test/liveRedraw.spec.ts).

import Konva from 'konva';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARPEN_AFTER_MS, apart, cullOffscreen, cullStats, sliced, followForPicture, lastDrawBoxes, partIndex, pictureChanges, pictureTaken, redrawWhole, type RedrawStats } from './cullOffscreen';

/** The rectangles clipped to, per canvas, since the last `reset`. */
const clips = new Map<HTMLCanvasElement, number[][]>();
/** Every drawing call, with its canvas. */
const ops: [HTMLCanvasElement, string][] = [];

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return standIn(this);
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function standIn(el: HTMLCanvasElement): CanvasRenderingContext2D {
  let path: number[][] = [];
  const real: Record<string, unknown> = {
    canvas: el,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: () => ({ width: 10 }),
    // (Konva checks once that the browser gives back the colors it drew.)
    getImageData: () => ({ data: new Uint8ClampedArray(400).map((_, i) => (i % 4 === 3 ? 255 : 40)) }),
    beginPath: () => {
      path = [];
    },
    rect: (x: number, y: number, w: number, h: number) => {
      path.push([x, y, w, h]);
    },
    clip: () => {
      clips.set(el, [...(clips.get(el) ?? []), ...path]);
    },
  };
  return new Proxy(real, {
    get: (t, k: string) => {
      if (k in t) {
        const v = t[k];
        if (typeof v === 'function' && k !== 'getTransform' && k !== 'measureText' && k !== 'getImageData') return (...a: unknown[]) => (ops.push([el, `${k}(${a.join(',')})`]), (v as (...a: unknown[]) => unknown)(...a));
        return v;
      }
      return (...a: unknown[]) => void ops.push([el, `${k}(${a.map((x) => (typeof x === 'object' ? 'obj' : String(x))).join(',')})`]);
    },
    set: (t, k: string, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let stage: Konva.Stage;
let layer: Konva.Layer;
let sheet: Konva.Group;
let undo: () => void;
const parts: Konva.Group[] = [];

/** A part as BrickLayer makes one: a Group with `cullR`, a shape inside. */
function part(x: number, y: number): Konva.Group {
  const g = new Konva.Group({ x, y, cullR: 20 } as Konva.GroupConfig);
  g.add(new Konva.Rect({ x: -10, y: -10, width: 20, height: 20, fill: 'red' }));
  return g;
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  stage = new Konva.Stage({ container, width: 1000, height: 800 });
  layer = new Konva.Layer();
  stage.add(layer);
  sheet = new Konva.Group();
  layer.add(sheet);
  parts.length = 0;
  // A 10 by 8 grid of parts, 100 apart.
  for (let j = 0; j < 8; j++) for (let i = 0; i < 10; i++) parts.push(part(50 + i * 100, 50 + j * 100));
  for (const p of parts) sheet.add(p);
  undo = cullOffscreen(layer);
  // The first draw of a canvas is always a whole one.
  layer.draw();
  reset();
});

afterEach(() => {
  undo();
  stage.destroy();
});

function reset(): void {
  clips.clear();
  cullStats.drawn = 0;
  cullStats.skipped = 0;
}

const stats = (): RedrawStats => (layer as unknown as { redrawStats: () => RedrawStats }).redrawStats();
/** Draws the layer and says how: whole or partial draws of its two canvases, and the parts drawn on both. */
function draw(): { whole: number; partial: number; drawn: number; scene: number[][]; hit: number[][] } {
  const was = stats();
  reset();
  layer.draw();
  const is = stats();
  return {
    whole: is.whole - was.whole,
    partial: is.partial - was.partial,
    drawn: cullStats.drawn,
    scene: clips.get(layer.getCanvas()._canvas) ?? [],
    hit: clips.get(layer.hitCanvas._canvas) ?? [],
  };
}

describe('a watched layer', () => {
  it('draws everything the first time, and when nothing says what changed', () => {
    expect(stats()).toMatchObject({ whole: 2, partial: 0 });
    const d = draw();
    expect(d).toMatchObject({ whole: 2, partial: 0, drawn: 160, scene: [] });
    expect(stats().why).toContain('nothing asked for');
  });

  it('draws only where a moved part was and is, on both canvases', () => {
    parts[34]!.x(parts[34]!.x() + 8);
    const d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2 });
    // Its reach (20) and the fixed margin (32) around where it was (450, 350) and is (458, 350).
    expect(d.scene).toEqual([[398, 298, 112, 104]]);
    expect(d.hit).toEqual(d.scene);
    // Just that part, once per canvas: its neighbors are 100 away.
    expect(d.drawn).toBe(2);
    expect(lastDrawBoxes(layer)).toEqual([
      { x0: 398, y0: 298, x1: 502, y1: 402 },
      { x0: 406, y0: 298, x1: 510, y1: 402 },
    ]);
    // And the draw after it has nothing to go on again.
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
  });

  it('draws the neighbors that reach into the place too', () => {
    parts[34]!.x(parts[34]!.x() + 60);
    const d = draw();
    expect(d.scene).toEqual([[398, 298, 164, 104]]);
    // The moved part and the one to its right (550, 350), whose reach starts at 530.
    expect(d.drawn).toBe(4);
  });

  it('follows a change to anything inside a part', () => {
    (parts[3]!.getChildren()[0] as Konva.Rect).fill('blue');
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 2, scene: [[298, 0, 104, 102]] });
  });

  it('draws a part that moved far in two places, one after the other', () => {
    parts[0]!.position({ x: 950, y: 750 });
    const d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2 });
    expect(d.scene).toEqual([
      [0, 0, 102, 102],
      [898, 698, 102, 102],
    ]);
  });

  it('draws where a part was when it is taken away, and where it is when it comes back', () => {
    const p = parts[12]!;
    p.remove();
    let d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2, drawn: 0, scene: [[198, 98, 104, 104]] });
    sheet.add(p);
    d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2, drawn: 2, scene: [[198, 98, 104, 104]] });
    p.destroy();
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 0 });
  });

  // A dragged part is lifted to another layer and put back at its place in
  // the order (BrickLayer's liftForDrag): that drew the whole view.
  it('draws only around a part put back at its place in the order, or brought to front', () => {
    const p = parts[12]!;
    const z = p.zIndex();
    const other = new Konva.Layer();
    stage.add(other);
    p.moveTo(other);
    draw();
    p.moveTo(sheet);
    p.zIndex(z);
    expect(sheet.getChildren()[12]).toBe(p);
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 2, scene: [[198, 98, 104, 104]] });
    p.moveToTop();
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 2, scene: [[198, 98, 104, 104]] });
    p.moveToBottom();
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 2, scene: [[198, 98, 104, 104]] });
    other.destroy();
  });

  it('draws everything when something other than a part changes', () => {
    const text = new Konva.Rect({ x: 5, y: 5, width: 30, height: 10, fill: 'black' });
    layer.add(text);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    text.x(40);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    expect(stats().why).toContain('Rect');
    // The sheet's fade.
    sheet.opacity(0.5);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
  });

  it('when the view moves by whole px, shifts what the screen canvas has and draws only what came in; the hit canvas is drawn whole', () => {
    const shifted = cullStats.shifted;
    stage.position({ x: -300, y: 0 });
    const d = draw();
    // The screen canvas: the column the move brought in (300 px on the right), not the view.
    // The hit canvas is never shifted (a click goes by a fresh draw): whole.
    expect(d).toMatchObject({ whole: 1, partial: 1, scene: [[700, 0, 300, 800]], hit: [] });
    expect(cullStats.shifted - shifted).toBe(1);
    // A part moved while the view moved too: where it was and is, as well.
    stage.position({ x: -300, y: -100 });
    parts[34]!.x(parts[34]!.x() + 8);
    const e = draw();
    expect(e).toMatchObject({ whole: 1, partial: 1 });
    expect(e.scene).toContainEqual([0, 700, 1000, 100]);
    expect(e.scene).toContainEqual([98, 198, 112, 104]);
    // A move at this view is partial again, in this view's px.
    parts[34]!.x(parts[34]!.x() + 8);
    expect(draw()).toMatchObject({ whole: 0, partial: 2, scene: [[106, 198, 112, 104]] });
    // Both ways at once: a column and a row, not one box around them.
    stage.position({ x: -320, y: -110 });
    const both = draw();
    expect(both).toMatchObject({ whole: 1, partial: 1 });
    expect(both.scene).toEqual([[980, 0, 20, 800], [0, 790, 980, 10]]);
    // From a view at a part-px place, by whole px (a hair off in floating point): shifted too.
    stage.position({ x: -0.1 - 0.2, y: -100 });
    draw();
    stage.position({ x: -0.1 - 0.2 - 37, y: -100 });
    expect(draw()).toMatchObject({ whole: 1, partial: 1 });
  });

  it('draws the shifted screen canvas again in full once the view is still, without telling the view picture every part changed', () => {
    vi.useFakeTimers();
    try {
      stage.position({ x: -300, y: 0 });
      draw();
      expect(stats().soft).toBe(true);
      // Still moving: each move puts the sharp draw off.
      vi.advanceTimersByTime(SHARPEN_AFTER_MS - 50);
      stage.position({ x: -320, y: 0 });
      draw();
      vi.advanceTimersByTime(SHARPEN_AFTER_MS - 50);
      expect(stats().soft).toBe(true);
      // Still: drawn in full (jsdom has no requestIdleCallback, so at once); the hit canvas was never shifted.
      const was = stats();
      reset();
      vi.advanceTimersByTime(100);
      const is = stats();
      expect(is.soft).toBe(false);
      expect(is.partial - was.partial).toBe(1);
      expect(is.whole - was.whole).toBe(0);
      expect(clips.get(layer.getCanvas()._canvas)).toEqual([[0, 0, 1000, 800]]);
      expect(clips.has(layer.hitCanvas._canvas)).toBe(false);
      // Every part on screen drawn, and nothing changed for the view picture.
      expect(cullStats.drawn).toBeGreaterThanOrEqual(7 * 8);
      expect(lastDrawBoxes(layer)).toEqual([]);
      // And then back to drawing only what changes.
      parts[34]!.x(parts[34]!.x() + 8);
      expect(draw()).toMatchObject({ whole: 0, partial: 2 });
      expect(clips.get(layer.getCanvas()._canvas)).not.toEqual([[0, 0, 1000, 800]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws everything when the view zooms, moves by part of a px, or past most of the canvas', () => {
    stage.scale({ x: 0.5, y: 0.5 });
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    stage.position({ x: -10.5, y: 0 });
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    stage.position({ x: -10.5 - 600, y: 0 });
    const d = draw();
    expect(d).toMatchObject({ whole: 2, partial: 0 });
    // Only the view: the parts the moves took off screen aren't drawn.
    expect(d.drawn).toBeLessThan(2 * 80);
  });

  it('leaves a change off screen alone, and says so to whoever follows its draws', () => {
    stage.position({ x: -600, y: 0 });
    layer.draw();
    let heard = 0;
    layer.on('draw', () => heard++);
    parts[0]!.x(parts[0]!.x() + 8);
    const d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2, drawn: 0, scene: [], hit: [] });
    expect(heard).toBe(1);
    // The view picture's margin may hold it: the place is still reported.
    expect(lastDrawBoxes(layer)).toHaveLength(2);
  });

  it('takes the same numbers in a new array for no change at all', () => {
    const line = new Konva.Line({ points: [0, 0, 100, 100], stroke: 'black' });
    layer.add(line);
    layer.draw();
    line.points([0, 0, 100, 100]);
    expect(draw()).toMatchObject({ whole: 0, partial: 2, drawn: 0, scene: [] });
    line.points([0, 0, 100, 120]);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
  });

  it('draws everything past too many parts or too much of the canvas', () => {
    for (const p of parts) p.y(p.y() + 1);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
  });

  it('draws everything after its canvas was drawn on by someone else', () => {
    parts[34]!.x(parts[34]!.x() + 8);
    redrawWhole(layer);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    expect(lastDrawBoxes(layer)).toBeNull();
  });

  it('draws every part on another canvas, as before', () => {
    stage.position({ x: -600, y: 0 });
    layer.draw();
    reset();
    const other = new Konva.Layer().getCanvas();
    layer.drawScene(other);
    expect(cullStats.drawn + cullStats.skipped).toBe(0);
  });

  it('stops watching when undone', () => {
    undo();
    expect((layer as unknown as { redrawStats?: unknown }).redrawStats).toBeUndefined();
    expect(lastDrawBoxes(layer)).toBeNull();
    undo = cullOffscreen(layer);
  });
});

describe('the sharp draw after a pan, a slice at a time', () => {
  /** Idle callbacks waiting to run. */
  let idle: ((d: { timeRemaining: () => number }) => void)[] = [];
  beforeEach(() => {
    idle = [];
    (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: (d: { timeRemaining: () => number }) => void) => idle.push(cb);
    (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback = () => {};
    // Shapes outside parts: one between two parts of the sheet, one after the sheet.
    sheet.add(new Konva.Rect({ x: 3, y: 3, width: 5, height: 7, fill: 'blue' }));
    new Konva.Rect({ x: 3, y: 3, width: 5, height: 7, fill: 'blue' }).moveTo(sheet).setZIndex(31);
    layer.add(new Konva.Rect({ x: 1, y: 1, width: 9, height: 9, fill: 'green' }));
    layer.draw();
    sliced.fixed = 7;
  });
  afterEach(() => {
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    delete sliced.fixed;
    sliced.enabled = true;
    vi.useRealTimers();
  });
  /** The drawing calls of the sharp draw, on whichever canvas it drew, less those around each place drawn. */
  const drawing = (calls: string[]) => calls.filter((c) => !/^(save|restore|clip|beginPath|clearRect|setTransform|drawImage|scale)\(/.test(c) && c !== 'rect(0,0,1000,800)');
  function panThenStill(): void {
    stage.position({ x: -300, y: 0 });
    layer.draw();
    vi.advanceTimersByTime(SHARPEN_AFTER_MS + 10);
  }

  it('draws what one draw would, in the same order, then puts it on the screen canvas', () => {
    vi.useFakeTimers();
    // One draw, for comparing.
    sliced.enabled = false;
    panThenStill();
    ops.length = 0;
    idle.shift()!({ timeRemaining: () => 0 });
    const own = layer.getCanvas()._canvas;
    const once = drawing(ops.filter(([el]) => el === own).map(([, c]) => c));
    expect(stats().soft).toBe(false);
    expect(once.length).toBeGreaterThan(50);

    sliced.enabled = true;
    stage.position({ x: 0, y: 0 });
    layer.draw();
    panThenStill();
    expect(stats().soft).toBe(true);
    ops.length = 0;
    let n = 0;
    while (idle.length > 0) {
      idle.shift()!({ timeRemaining: () => 0 });
      n++;
      if (idle.length > 0) expect(stats().soft).toBe(true);
    }
    // Some 60 parts on screen, 7 a slice.
    expect(n).toBeGreaterThanOrEqual(8);
    const off = ops.filter(([el]) => el !== own && el !== layer.hitCanvas._canvas);
    expect(drawing(off.map(([, c]) => c))).toEqual(once);
    // On the screen canvas: one copy, nothing else drawn.
    const onScreen = ops.filter(([el]) => el === own).map(([, c]) => c);
    expect(onScreen.filter((c) => c.startsWith('drawImage('))).toHaveLength(1);
    expect(drawing(onScreen)).toEqual([]);
    expect(stats().soft).toBe(false);
    expect(lastDrawBoxes(layer)).toEqual([]);
  });

  it('a change between slices drops it; the sharp draw comes later', () => {
    vi.useFakeTimers();
    panThenStill();
    idle.shift()!({ timeRemaining: () => 0 });
    idle.shift()!({ timeRemaining: () => 0 });
    parts[34]!.x(parts[34]!.x() + 8);
    layer.draw();
    ops.length = 0;
    idle.shift()?.({ timeRemaining: () => 0 });
    expect(ops.some(([, c]) => c.startsWith('drawImage('))).toBe(false);
    expect(stats().soft).toBe(true);
    // Waited for again, then drawn.
    vi.advanceTimersByTime(SHARPEN_AFTER_MS + 10);
    while (idle.length > 0) idle.shift()!({ timeRemaining: () => 50 });
    expect(stats().soft).toBe(false);
  });
});

describe('a sheet that keeps a grid of its parts', () => {
  /** Parts 1,500 px apart (cells are 1,024), each telling `order` when drawn. */
  let far: Konva.Group;
  const farParts: Konva.Group[] = [];
  const order: string[] = [];
  function farPart(id: string, x: number, y: number): Konva.Group {
    const g = new Konva.Group({ x, y, cullR: 20, name: id } as Konva.GroupConfig);
    g.add(new Konva.Shape({ sceneFunc: () => void order.push(id), hitFunc: () => undefined }));
    return g;
  }
  beforeEach(() => {
    sheet.visible(false);
    far = new Konva.Group({ partsIndexed: true } as Konva.GroupConfig);
    layer.add(far);
    farParts.length = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 10; i++) farParts.push(farPart(`p${j * 10 + i}`, 750 + i * 1500, 750 + j * 1500));
    for (const p of farParts) far.add(p);
    stage.scale({ x: 0.05, y: 0.05 });
    layer.draw();
    reset();
    order.length = 0;
  });
  /** Parts asked whether they reach into the places drawn (both canvases). */
  const asked = (): number => cullStats.drawn + cullStats.skipped;

  it('asks only the parts near a moved one', () => {
    farParts[34]!.x(farParts[34]!.x() + 200);
    expect(draw()).toMatchObject({ whole: 0, partial: 2 });
    // The moved part and the one to its left (a cell the place reaches
    // into), on each canvas; the other 78 aren't asked.
    expect(asked()).toBe(4);
    expect(order).toEqual(['p34']);
  });

  it('asks every part without it, and draws the same', () => {
    partIndex.enabled = false;
    try {
      farParts[34]!.x(farParts[34]!.x() + 200);
      draw();
      expect(asked()).toBe(160);
      expect(order).toEqual(['p34']);
    } finally {
      partIndex.enabled = true;
    }
  });

  it('finds a part where it went, and keeps the sheet\'s order', () => {
    // p0 goes onto p77, which is above it on the sheet.
    farParts[0]!.position({ x: farParts[77]!.x() + 10, y: farParts[77]!.y() });
    draw();
    expect(order).toEqual(['p0', 'p77']);
    order.length = 0;
    // Moved to the top, p0 is drawn after p77 (a whole draw: the order changed).
    farParts[0]!.moveToTop();
    farParts[0]!.x(farParts[0]!.x() + 1);
    farParts[77]!.x(farParts[77]!.x() + 1);
    draw();
    expect(order.indexOf('p77')).toBeLessThan(order.lastIndexOf('p0'));
  });

  it('drops a part that left, and finds it when it comes back', () => {
    const p = farParts[12]!;
    p.remove();
    draw();
    expect(order).toEqual([]);
    far.add(p);
    p.x(p.x() + 5);
    draw();
    expect(order).toEqual(['p12']);
  });

  it('asks every part for a draw of most of the map', () => {
    stage.scale({ x: 0.06, y: 0.06 });
    draw();
    expect(asked()).toBe(160);
  });
});

describe('a shape drawn over some parts', () => {
  it('draws again only around the parts it names', () => {
    let over: Konva.Node[] = [parts[11]!];
    const shape = new Konva.Shape({ sceneFunc: () => undefined, listening: false, overDraws: () => over } as Konva.ShapeConfig);
    layer.add(shape);
    layer.draw();
    // It was over 11 and is now over 11 and 33.
    over = [parts[11]!, parts[33]!];
    shape.sceneFunc(() => undefined);
    const d = draw();
    expect(d).toMatchObject({ whole: 0, partial: 2 });
    expect(d.scene).toEqual([
      [98, 98, 104, 104],
      [298, 298, 104, 104],
    ]);
  });
});

describe('what the view picture is told', () => {
  it('of a watched layer: the places of changed parts, or that anything may have changed', () => {
    pictureTaken(layer);
    expect(pictureChanges(layer)).toEqual([]);
    parts[34]!.x(parts[34]!.x() + 8);
    expect(pictureChanges(layer)).toEqual([
      { x0: 398, y0: 298, x1: 502, y1: 402 },
      { x0: 406, y0: 298, x1: 510, y1: 402 },
    ]);
    // Drawing the screen canvas doesn't change what the picture still needs.
    layer.draw();
    redrawWhole(layer);
    expect(pictureChanges(layer)).toHaveLength(2);
    layer.add(new Konva.Rect({ width: 5, height: 5 }));
    expect(pictureChanges(layer)).toBeNull();
    pictureTaken(layer);
    expect(pictureChanges(layer)).toEqual([]);
  });

  it('of another layer: whether anything on it changed', () => {
    const other = new Konva.Layer();
    stage.add(other);
    const rect = new Konva.Rect({ width: 5, height: 5 });
    other.add(rect);
    const off = followForPicture(other);
    expect(pictureChanges(other)).toBeNull();
    pictureTaken(other);
    expect(pictureChanges(other)).toEqual([]);
    rect.x(3);
    expect(pictureChanges(other)).toBeNull();
    off();
  });

  // The drag layer: a part lifted onto it, dragged and put back. Its draws
  // whole made the picture be taken afresh after each drag in the mover's
  // own tab (about 740 part pictures on 7,520 parts zoomed in).
  it('of another layer: the places its draws changed, child by child', () => {
    const drag = new Konva.Layer();
    stage.add(drag);
    const outline = new Konva.Rect({ x: 600, y: 600, width: 100, height: 50, stroke: 'blue', strokeWidth: 2 });
    drag.add(outline);
    const off = followForPicture(drag);
    // Its first draw: nothing known of before.
    drag.draw();
    expect(lastDrawBoxes(drag)).toBeNull();
    drag.draw();
    expect(lastDrawBoxes(drag)).toEqual([]);
    const pad = 32;
    const near = (b: { x0: number; y0: number; x1: number; y1: number }, x0: number, y0: number, x1: number, y1: number) =>
      [b.x0, b.y0, b.x1, b.y1].every((v, i) => Math.abs(v - [x0 - pad, y0 - pad, x1 + pad, y1 + pad][i]!) <= 2);
    // Lifted: where it is now.
    const p = parts[34]!;
    p.moveTo(drag);
    drag.draw();
    let boxes = lastDrawBoxes(drag)!;
    expect(boxes).toHaveLength(1);
    expect(near(boxes[0]!, 440, 340, 460, 360)).toBe(true);
    // Dragged: where it was and is; the outline, unchanged, isn't drawn again.
    p.x(p.x() + 30);
    drag.draw();
    boxes = lastDrawBoxes(drag)!;
    expect(boxes).toHaveLength(2);
    expect(near(boxes[0]!, 440, 340, 460, 360)).toBe(true);
    expect(near(boxes[1]!, 470, 340, 490, 360)).toBe(true);
    // Something inside it changed (its picture): its place again.
    (p.getChildren()[0] as Konva.Rect).fill('green');
    drag.draw();
    expect(lastDrawBoxes(drag)).toHaveLength(2);
    // Put back on its sheet: where it was on the drag layer.
    p.moveTo(sheet);
    drag.draw();
    boxes = lastDrawBoxes(drag)!;
    expect(boxes).toHaveLength(1);
    expect(near(boxes[0]!, 470, 340, 490, 360)).toBe(true);
    // A shape drawn over parts covers them, whatever its own size.
    const q = parts[12]!;
    q.moveTo(drag);
    const halo = new Konva.Shape({ sceneFunc: () => undefined, overDraws: () => [q] } as unknown as Konva.ShapeConfig);
    drag.add(halo);
    drag.draw();
    boxes = lastDrawBoxes(drag)!;
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => near(b, 240, 140, 260, 160))).toBe(true);
    halo.destroy();
    drag.draw();
    expect(lastDrawBoxes(drag)).toHaveLength(1);
    // A change to the layer itself may have changed anything.
    drag.opacity(0.5);
    drag.draw();
    expect(lastDrawBoxes(drag)).toBeNull();
    drag.draw();
    expect(lastDrawBoxes(drag)).toEqual([]);
    off();
  });

  // A pan starts by moving the stage, or by turning its listening off:
  // the picture kept for it was taken afresh, from every part.
  it('nothing of the view moving: the picture is of the map', () => {
    const other = new Konva.Layer();
    stage.add(other);
    const off = followForPicture(other);
    pictureTaken(layer);
    pictureTaken(other);
    stage.listening(false);
    stage.position({ x: -40, y: -20 });
    stage.scale({ x: 1.5, y: 1.5 });
    expect(pictureChanges(layer)).toEqual([]);
    expect(pictureChanges(other)).toEqual([]);
    // The canvases themselves are drawn whole for the new view.
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    // And a part changed after it is still told.
    parts[34]!.x(parts[34]!.x() + 8);
    expect(pictureChanges(layer)).toHaveLength(2);
    off();
  });
});

describe('apart', () => {
  it('makes one box of boxes that overlap or touch', () => {
    expect(apart([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }, { x: 15, y: 0, w: 5, h: 5 }], 6)).toEqual([{ x: 0, y: 0, w: 20, h: 15 }]);
  });
  it('keeps boxes that are apart', () => {
    const boxes = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 }];
    expect(apart(boxes, 6)).toEqual(boxes);
  });
  it('makes one box of more than it may keep', () => {
    expect(apart([{ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 }, { x: 0, y: 100, w: 10, h: 10 }], 2)).toEqual([{ x: 0, y: 0, w: 110, h: 110 }]);
  });
});
