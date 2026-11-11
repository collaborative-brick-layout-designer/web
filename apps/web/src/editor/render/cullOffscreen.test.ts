// The parts layer draws only the changed places again when only parts
// changed (cullOffscreen.ts). jsdom has no canvas, so the 2D context here
// is a stand-in that takes every call and remembers the clips: what's
// checked is which draws are whole, which places a partial one clips to,
// and which parts it draws there. That the pixels match a whole draw is
// the browser test's job (e2e/test/liveRedraw.spec.ts).

import Konva from 'konva';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apart, cullOffscreen, cullStats, followForPicture, lastDrawBoxes, partIndex, pictureChanges, pictureTaken, redrawWhole, type RedrawStats } from './cullOffscreen';

/** The rectangles clipped to, per canvas, since the last `reset`. */
const clips = new Map<HTMLCanvasElement, number[][]>();

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
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
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

  it('draws everything when something other than a part changes', () => {
    const text = new Konva.Rect({ x: 5, y: 5, width: 30, height: 10, fill: 'black' });
    layer.add(text);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    text.x(40);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    expect(stats().why).toContain('Rect');
    // The parts' order.
    parts[5]!.moveToTop();
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
    // The sheet's fade.
    sheet.opacity(0.5);
    expect(draw()).toMatchObject({ whole: 2, partial: 0 });
  });

  it('draws everything when the view moves, and only the view', () => {
    stage.position({ x: -300, y: 0 });
    const d = draw();
    expect(d).toMatchObject({ whole: 2, partial: 0 });
    // Three columns went off the left edge (their reach, with the cull margin of 64, ends before 300).
    expect(d.drawn).toBe(2 * 8 * 8);
    // A move at this view is partial again, in this view's px.
    parts[34]!.x(parts[34]!.x() + 8);
    expect(draw()).toMatchObject({ whole: 0, partial: 2, scene: [[98, 298, 112, 104]] });
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
