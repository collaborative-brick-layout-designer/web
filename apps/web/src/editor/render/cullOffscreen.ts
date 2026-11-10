// Drawing a big layout's parts layer for one change (full review area 4,
// Bug 4: on 7,520 parts every move, anyone's, froze every open tab for
// about a second). Konva redraws the whole layer, every part, on its
// screen canvas and again on its hit canvas (what clicks are matched
// against), for any change, and the view picture was taken again from
// every part. Two things make that cheaper:
//
//   - Parts outside the view aren't drawn on the layer's own canvases
//     (`cullR` on a part's Group: its reach from its pivot, in layer
//     pixels). Exports, prints and the view picture (viewBitmap) draw on
//     other canvases, so they still get every part.
//   - The view picture (viewBitmap, taken after each change for the next
//     pan) copies the view from the canvases just drawn and draws only the
//     margin around it, instead of every part again.

import Konva from 'konva';

/** The layer being drawn on its own canvas, and the view in its coordinates. */
let culling: { canvas: unknown; x0: number; y0: number; x1: number; y1: number } | null = null;

/** How many parts the last cull left out (tests, measurements). */
export const cullStats = { skipped: 0, drawn: 0 };

let patched = false;

/** Parts (Groups with `cullR`) outside the view being drawn are skipped. */
function patchGroups(): void {
  if (patched) return;
  patched = true;
  const proto = Konva.Group.prototype as unknown as {
    drawScene: (canvas?: unknown, top?: unknown, bufferCanvas?: unknown) => unknown;
    drawHit: (canvas?: unknown, top?: unknown) => unknown;
  };
  const outside = (node: Konva.Group, canvas: unknown): boolean => {
    const c = culling;
    const r = node.attrs.cullR as number | undefined;
    if (!c || r === undefined || canvas !== c.canvas) return false;
    const x = node.attrs.x ?? 0;
    const y = node.attrs.y ?? 0;
    const out = x + r < c.x0 || x - r > c.x1 || y + r < c.y0 || y - r > c.y1;
    if (out) cullStats.skipped++;
    else cullStats.drawn++;
    return out;
  };
  const scene = proto.drawScene;
  proto.drawScene = function (this: Konva.Group, canvas?: unknown, top?: unknown, bufferCanvas?: unknown) {
    if (outside(this, canvas ?? this.getLayer()?.getCanvas())) return this;
    return scene.call(this, canvas, top, bufferCanvas);
  };
  const hit = proto.drawHit;
  proto.drawHit = function (this: Konva.Group, canvas?: unknown, top?: unknown) {
    if (outside(this, canvas ?? this.getLayer()?.hitCanvas)) return this;
    return hit.call(this, canvas, top);
  };
}

/** The part of the layer on screen, in its own coordinates, with `margin` px around it. */
function viewOf(layer: Konva.Layer, canvas: unknown, margin = 64): typeof culling {
  const stage = layer.getStage();
  if (!stage) return null;
  const scale = stage.scaleX() || 1;
  return {
    canvas,
    x0: (-stage.x() - margin) / scale,
    y0: (-stage.y() - margin) / scale,
    x1: (-stage.x() + stage.width() + margin) / scale,
    y1: (-stage.y() + stage.height() + margin) / scale,
  };
}

/**
 * Run `draw` with the parts outside `rect` (layer coordinates) left out of
 * what it draws on `canvas`: the view picture (viewBitmap) draws the view
 * and a margin around it, not the whole map.
 */
export function drawCulled(canvas: unknown, rect: { x0: number; y0: number; x1: number; y1: number }, draw: () => void): void {
  patchGroups();
  const before = culling;
  culling = { canvas, ...rect };
  try {
    draw();
  } finally {
    culling = before;
  }
}

/**
 * Leave the parts outside the view out of this layer's own canvases (the
 * screen and the hit canvas). Returns how to undo it (the layer unmounting).
 */
export function cullOffscreen(layer: Konva.Layer): () => void {
  patchGroups();
  type Draw = (canvas?: unknown, top?: unknown) => Konva.Layer;
  const own = layer as unknown as { drawScene: Draw; drawHit: Draw };
  const scene = own.drawScene;
  const hit = own.drawHit;
  const culled = (base: Draw, ownCanvas: () => unknown): Draw =>
    function (this: Konva.Layer, canvas?: unknown, top?: unknown) {
      const target = canvas ?? ownCanvas.call(this);
      // Only on the layer's own canvases: exports and prints get every part.
      if (target !== ownCanvas.call(this)) return base.call(this, canvas, top);
      const before = culling;
      culling = viewOf(this, target);
      try {
        return base.call(this, canvas, top);
      } finally {
        culling = before;
      }
    };
  own.drawScene = culled(scene, function (this: Konva.Layer) {
    return this.getCanvas();
  });
  own.drawHit = culled(hit, function (this: Konva.Layer) {
    return this.hitCanvas;
  });
  return () => {
    own.drawScene = scene;
    own.drawHit = hit;
  };
}
