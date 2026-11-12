// While the view moves (a pan, a turn of the wheel, a pinch) the hit
// canvases (what a click lands on) aren't drawn, and nothing on the map is
// hit: the stage alone hears the pointer. They're drawn once when the view
// stops (EditorPage's setViewMoving).
//
// That used to be done by switching the stage's `listening` off and on.
// Konva then visits every node on the map to forget whether it listens,
// twice per move, and lets go of each layer's hit canvas and makes it
// again: on 7,520 parts about 230 ms of each pan at 4x slowed CPU. Here
// only the layers are touched: their hit drawing and hit tests are held.

import type Konva from 'konva';

type Draw = Konva.Layer['drawHit'];
type Hit = Konva.Stage['getIntersection'];

interface Held {
  layers: { layer: Konva.Layer; own: Draw | undefined }[];
  own: Hit | undefined;
}

const held = new WeakMap<Konva.Stage, Held>();

/** Whether the stage's hits are held (the view is moving). */
export function hitsHeld(stage: Konva.Stage): boolean {
  return held.has(stage);
}

/**
 * Hold the stage's hits: its layers' hit canvases aren't drawn, and a hit
 * test finds nothing, until `releaseHits`. The stage's container gets
 * `data-view-moving` meanwhile.
 */
export function holdHits(stage: Konva.Stage): void {
  if (held.has(stage)) return;
  const own = (o: object, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);
  const h: Held = { layers: [], own: own(stage, 'getIntersection') as Hit | undefined };
  for (const layer of stage.getLayers()) {
    h.layers.push({ layer, own: own(layer, 'drawHit') as Draw | undefined });
    // (A draw into another canvas, an export say, goes through as usual.)
    const base = layer.drawHit;
    layer.drawHit = function (this: Konva.Layer, can, top) {
      if (can || top) return base.call(this, can, top);
      return this;
    };
  }
  stage.getIntersection = () => null;
  held.set(stage, h);
  stage.container().dataset.viewMoving = '';
}

/** The stage's hits as before `holdHits`; its hit canvases need drawing again. */
export function releaseHits(stage: Konva.Stage): void {
  const h = held.get(stage);
  if (!h) return;
  held.delete(stage);
  for (const { layer, own } of h.layers) {
    if (own) layer.drawHit = own;
    else delete (layer as Partial<Konva.Layer>).drawHit;
  }
  if (h.own) stage.getIntersection = h.own;
  else delete (stage as Partial<Konva.Stage>).getIntersection;
  delete stage.container().dataset.viewMoving;
}
