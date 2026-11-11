// Drawing a big layout's parts layer for one change (full review area 4,
// Bug 4: on 7,520 parts every move, anyone's, froze every open tab for
// about a second). Konva redraws the whole layer, every part, on its
// screen canvas and again on its hit canvas (what clicks are matched
// against), for any change, and the view picture was taken again from
// every part. Three things make that cheaper:
//
//   - Parts outside the view aren't drawn on the layer's own canvases
//     (`cullR` on a part's Group: its reach from its pivot, in layer
//     pixels). Exports, prints and the view picture (viewBitmap) draw on
//     other canvases, so they still get every part.
//   - The view picture (viewBitmap, taken after each change for the next
//     pan) copies the view from the canvases just drawn and draws only the
//     margin around it, instead of every part again.
//   - When only parts changed (a move, someone else's edit, a part's
//     picture arriving), only the places they were and are get drawn
//     again, on the screen canvas and on the hit canvas: the layer
//     remembers which parts changed since each canvas was last drawn
//     (below, "Which parts changed"). Anything else (a text, a ruler, the
//     selection, the view moving) draws the whole view as before.

import Konva from 'konva';

/** A box in the layer's own coordinates. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The layer being drawn on a canvas, the view in its coordinates, and (a partial draw) the only places being drawn. */
let culling: (Box & { canvas: unknown; only?: readonly Box[] }) | null = null;

/**
 * Counts for tests and measurements: parts the last culls left out and
 * drew, and how many draws of a layer's own canvases were whole or partial.
 */
export const cullStats = { skipped: 0, drawn: 0, whole: 0, partial: 0 };

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
    let out = x + r < c.x0 || x - r > c.x1 || y + r < c.y0 || y - r > c.y1;
    if (!out && c.only) {
      out = true;
      for (const o of c.only) {
        if (x + r >= o.x0 && x - r <= o.x1 && y + r >= o.y0 && y - r <= o.y1) {
          out = false;
          break;
        }
      }
    }
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
function viewOf(layer: Konva.Layer, canvas: unknown, margin = 64): (Box & { canvas: unknown }) | null {
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
 * and a margin around it, not the whole map. With `only`, just the parts
 * that reach into one of those boxes.
 */
export function drawCulled(canvas: unknown, rect: Box, draw: () => void, only?: readonly Box[]): void {
  patchGroups();
  const before = culling;
  culling = only ? { canvas, ...rect, only } : { canvas, ...rect };
  try {
    draw();
  } finally {
    culling = before;
  }
}

// ── Which parts changed ──
//
// Every change to a Konva node that can show asks its layer for a draw
// through `_requestDraw` (a new attribute through `_setAttr` first; a
// picture that finished loading; a node added or taken away). Those are
// watched for the layers given to `cullOffscreen`:
//
//   - a change inside a part (its Group, the one with `cullR`, or anything
//     in it) marks that part: where it was when first marked, and where it
//     is when the canvas is drawn, are drawn again;
//   - a part added or taken away marks where it is, or was;
//   - a change to anything else on the layer (a text, a ruler, the
//     selection overlay, the order of the parts, the layer itself), or to
//     the stage (the view), marks the whole canvas.
//
// A draw that nothing marked (code calling `layer.draw()` itself) is a
// whole one too, and so is one for a view or canvas size other than what
// the canvas was last drawn for. So a partial draw only ever happens when
// the canvas holds this very view and every change since is known.

/** What changed on a layer since one of its canvases was drawn. */
interface Pending {
  /** Something other than a part changed, or too much to follow: draw it all. */
  whole: boolean;
  /** Whether anything was marked at all. */
  marked: boolean;
  /** Changed parts still on the layer, with where each was when first marked. */
  parts: Map<Konva.Node, Box>;
  /** Places to draw again whose part is gone. */
  boxes: Box[];
  /** The view and canvas size it was last drawn whole or partial for; null when it must be drawn whole. */
  at: string | null;
}

interface Track {
  layer: Konva.Layer;
  scene: Pending;
  hit: Pending;
  /** The places the last draw of the screen canvas drew again; null when it drew everything. */
  last: Box[] | null;
  /** Draws of its own canvases so far, and what last made one a whole draw (tests, measurements). */
  whole: number;
  partial: number;
  cause: { node: Konva.Node | null; what: string };
  why: string;
}

/** What `redrawStats` on a layer given to `cullOffscreen` answers. */
export interface RedrawStats {
  /** Draws of the screen or hit canvas that drew the whole view. */
  whole: number;
  /** Draws that drew only the changed places. */
  partial: number;
  /** What made the last whole draw one: the canvas, the node's class and name, and the attribute or cause. */
  why: string;
}

const tracks = new Map<Konva.Node, Track>();
/** While a part is added or taken away: the draw it asks for is already accounted for. */
let quiet = 0;

/** Past this many places, or this share of the canvas, a whole draw is as cheap. */
const MAX_BOXES = 200;
const MAX_SHARE = 0.5;
/** The most places drawn one by one; more become one box around them all. */
const MAX_PASSES = 6;
/**
 * Screen px drawn again around a changed part, beyond its reach: what is
 * drawn at a fixed size on screen around a part (the selection's outline,
 * a bend handle).
 */
const PAD_PX = 32;

/** A node asked for a draw without a new attribute (a picture loaded, its children changed). */
const ASKED = 'asked for a draw';

const newPending = (): Pending => ({ whole: true, marked: false, parts: new Map(), boxes: [], at: null });

function boxOf(part: Konva.Node): Box {
  const r = (part.attrs.cullR as number | undefined) ?? 0;
  const x = (part.attrs.x as number | undefined) ?? 0;
  const y = (part.attrs.y as number | undefined) ?? 0;
  return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
}

function markWhole(t: Track, node: Konva.Node | null, what: string): void {
  t.cause.node = node;
  t.cause.what = what;
  for (const p of [t.scene, t.hit]) {
    p.whole = true;
    p.marked = true;
    p.parts.clear();
    p.boxes.length = 0;
  }
}

function markPart(t: Track, part: Konva.Node): void {
  for (const p of [t.scene, t.hit]) {
    p.marked = true;
    if (p.whole || p.parts.has(part)) continue;
    if (p.parts.size >= MAX_BOXES) {
      p.whole = true;
      p.parts.clear();
      p.boxes.length = 0;
    } else p.parts.set(part, boxOf(part));
  }
}

function markGone(t: Track, part: Konva.Node): void {
  for (const p of [t.scene, t.hit]) {
    p.marked = true;
    if (p.whole) continue;
    const was = p.parts.get(part);
    if (was) {
      p.parts.delete(part);
      p.boxes.push(was);
    }
    p.boxes.push(boxOf(part));
    if (p.boxes.length > MAX_BOXES) {
      p.whole = true;
      p.parts.clear();
      p.boxes.length = 0;
    }
  }
}

/** The watched layer `node` is on, and the part it belongs to (null: it isn't inside a part). */
function trackOf(node: Konva.Node): { track: Track; part: Konva.Node | null } | null {
  let part: Konva.Node | null = null;
  for (let n: Konva.Node | null = node; n; n = n.parent) {
    const track = tracks.get(n);
    if (track) return { track, part };
    if (!part && n.attrs.cullR !== undefined) part = n;
  }
  return null;
}

/** `node` changed in a way that shows (`what`: the attribute, or how). */
function changed(node: Konva.Node, what: string): void {
  if (tracks.size === 0) return;
  const on = trackOf(node);
  if (on) {
    if (on.part) markPart(on.track, on.part);
    else if (what !== ASKED || on.track.cause.node !== node) markWhole(on.track, node, what);
    else markWhole(on.track, node, on.track.cause.what);
  } else if (node.nodeType === 'Stage') {
    for (const t of tracks.values()) if (t.layer.parent === node) markWhole(t, node, what);
  }
}

/** Two arrays of the same plain values, in the same order. */
function sameList(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] || (typeof a[i] === 'object' && a[i] !== null)) return false;
  return true;
}

let watching = false;

function watchChanges(): void {
  if (watching) return;
  watching = true;
  type N = {
    _setAttr: (key: string, val: unknown) => void;
    _requestDraw: () => void;
    _remove: () => void;
  };
  const node = Konva.Node.prototype as unknown as N;
  const setAttr = node._setAttr;
  node._setAttr = function (this: Konva.Node, key: string, val: unknown) {
    if (tracks.size === 0) {
      setAttr.call(this, key, val);
      return;
    }
    const was = this.attrs[key] as unknown;
    if (sameList(was, val)) {
      // The same numbers in a new array (a line's points, a dash, given
      // anew on every render): Konva asks for a draw, but nothing shows.
      const on = trackOf(this);
      if (on) for (const p of [on.track.scene, on.track.hit]) p.marked = true;
      quiet++;
      try {
        setAttr.call(this, key, val);
      } finally {
        quiet--;
      }
      return;
    }
    // Before it changes: a part is marked with where it still is. (Konva
    // leaves an equal plain value alone, and asks for no draw.)
    if (was !== val || (val !== null && typeof val === 'object')) changed(this, key);
    setAttr.call(this, key, val);
  };
  const requestDraw = node._requestDraw;
  node._requestDraw = function (this: Konva.Node) {
    if (quiet === 0) changed(this, ASKED);
    requestDraw.call(this);
  };
  const remove = node._remove;
  node._remove = function (this: Konva.Node) {
    const parent = this.parent;
    const on = tracks.size > 0 && parent && this.attrs.cullR !== undefined ? trackOf(parent) : null;
    if (!on || on.part) {
      remove.call(this);
      return;
    }
    // A part leaves the layer (deleted, or lifted for a drag): where it was is drawn again.
    markGone(on.track, this);
    quiet++;
    try {
      remove.call(this);
    } finally {
      quiet--;
    }
  };
  const container = Konva.Container.prototype as unknown as { add: (...children: Konva.Node[]) => unknown };
  const add = container.add;
  container.add = function (this: Konva.Container, ...children: Konva.Node[]) {
    const child = children.length === 1 ? children[0] : undefined;
    const on = tracks.size > 0 && child && !child.parent && child.attrs.cullR !== undefined ? trackOf(this) : null;
    if (!on || on.part) return add.apply(this, children);
    // A part joins the layer (placed, pasted, or back from a drag): where it is gets drawn.
    quiet++;
    try {
      add.apply(this, children);
    } finally {
      quiet--;
    }
    markPart(on.track, child!);
    return this;
  };
}

/** A box on a canvas, in whole device px. */
export interface PxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The same places as boxes that don't touch each other, `max` at most
 * (past that they become one box around them all). Each is then drawn
 * clipped to one plain rectangle: a clip made of several, or of ones that
 * overlap, makes the browser draw soft edges another way inside it, and
 * the hit canvas then differs from what a whole draw gives along every
 * edge between two parts.
 */
export function apart(boxes: readonly PxBox[], max: number): PxBox[] {
  const out = boxes.map((b) => ({ ...b }));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h) continue;
        out[i] = around(a, b);
        out.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return out.length > max ? [out.reduce(around)] : out;
}

function around(a: PxBox, b: PxBox): PxBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** The view and canvas a draw is for: a canvas drawn for another one must be drawn whole. */
function drawnFor(layer: Konva.Layer, canvas: { width: number; height: number; pixelRatio: number }): string {
  const s = layer.getStage();
  return [s?.x(), s?.y(), s?.scaleX(), s?.scaleY(), canvas.width, canvas.height, canvas.pixelRatio].join('|');
}

/**
 * The places to draw again for what changed: in the layer's coordinates,
 * each with the fixed-size margin around it. Null when it must all be drawn.
 */
function changedBoxes(layer: Konva.Layer, p: Pending): Box[] | null {
  if (!p.marked || p.whole) return null;
  const scale = layer.getStage()?.scaleX() || 1;
  const pad = PAD_PX / scale;
  const out: Box[] = [];
  const push = (b: Box): void => {
    out.push({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
  };
  for (const b of p.boxes) push(b);
  for (const [part, was] of p.parts) {
    push(was);
    // Where it is now, if it's still on this layer.
    if (trackOf(part)?.track.layer === layer) push(boxOf(part));
  }
  return out;
}

type Draw = (canvas?: unknown, top?: unknown) => Konva.Layer;
type Own = { drawScene: Draw; drawHit: Draw };
type CanvasLike = { width: number; height: number; pixelRatio: number; getContext: () => { _context: CanvasRenderingContext2D } };

/** One draw of a watched layer's own canvas: only the changed places when it can, the whole view when not. */
function drawOwn(layer: Konva.Layer, which: 'scene' | 'hit', canvas: CanvasLike, base: () => Konva.Layer): Konva.Layer {
  const t = tracks.get(layer);
  const view = viewOf(layer, canvas);
  if (!t || !view) return base();
  const p = t[which];
  if (which === 'hit') (layer as unknown as { _syncHitCanvasSize?: () => void })._syncHitCanvasSize?.();
  // A hit canvas Konva won't draw now (the layer hidden, a drag on it) is cleared and left empty.
  const drawable = which === 'scene' ? layer.isVisible() : layer.shouldDrawHit();
  const at = drawnFor(layer, canvas);
  const boxes = drawable && p.at === at && layer.clearBeforeDraw() ? changedBoxes(layer, p) : null;
  p.whole = false;
  p.marked = false;
  p.parts.clear();
  p.boxes.length = 0;
  p.at = null;

  // The changed places on the canvas, in whole device px (so nothing blends along their edges).
  const pr = canvas.pixelRatio;
  const scale = layer.getStage()?.scaleX() || 1;
  const sx = layer.getStage()?.x() ?? 0;
  const sy = layer.getStage()?.y() ?? 0;
  let px: PxBox[] | null = null;
  if (boxes) {
    px = [];
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor((b.x0 * scale + sx) * pr));
      const y0 = Math.max(0, Math.floor((b.y0 * scale + sy) * pr));
      const x1 = Math.min(canvas.width, Math.ceil((b.x1 * scale + sx) * pr));
      const y1 = Math.min(canvas.height, Math.ceil((b.y1 * scale + sy) * pr));
      if (x1 > x0 && y1 > y0) px.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    px = apart(px, MAX_PASSES);
    if (px.reduce((sum, r) => sum + r.w * r.h, 0) > MAX_SHARE * canvas.width * canvas.height) px = null;
  }
  if (which === 'scene') t.last = px ? boxes : null;

  const before = culling;
  if (!px) {
    cullStats.whole++;
    t.whole++;
    const n = t.cause.node;
    t.why = `${which}: ${n ? `${n.getClassName()} ${n.name()}: ` : ''}${t.cause.what || 'a draw nothing asked for, or another view'}`;
    // (kept for the other canvas's draw of the same change)
    if (which === 'hit') t.cause = { node: null, what: '' };
    culling = view;
    try {
      const out = base();
      if (drawable) p.at = at;
      return out;
    } finally {
      culling = before;
    }
  }

  cullStats.partial++;
  t.partial++;
  if (which === 'hit') t.cause = { node: null, what: '' };
  if (px.length === 0) {
    // Everything that changed is off screen: nothing to draw, but whoever
    // follows this layer's draws (the view picture, the bend handles) hears of it.
    p.at = at;
    if (which === 'scene') layer.fire('draw', { node: layer });
    return layer;
  }
  const c = canvas.getContext()._context;
  const attrs = layer.attrs as { clearBeforeDraw?: boolean };
  const hadClear = Object.prototype.hasOwnProperty.call(attrs, 'clearBeforeDraw');
  const clear = attrs.clearBeforeDraw;
  // Konva clears the whole canvas before a layer draws: not this time.
  attrs.clearBeforeDraw = false;
  const container = Konva.Container.prototype as unknown as Own;
  try {
    // One place at a time, each clipped to its own box (see `apart`).
    px.forEach((r, i) => {
      c.save();
      try {
        const m = c.getTransform();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(r.x, r.y, r.w, r.h);
        c.beginPath();
        c.rect(r.x, r.y, r.w, r.h);
        c.clip();
        c.setTransform(m);
        culling = {
          ...view,
          only: [{ x0: (r.x / pr - sx) / scale, y0: (r.y / pr - sy) / scale, x1: ((r.x + r.w) / pr - sx) / scale, y1: ((r.y + r.h) / pr - sy) / scale }],
        };
        // The last one through the layer's own drawing, which tells whoever listens that it drew.
        if (i === px.length - 1) base();
        else if (which === 'scene') container.drawScene.call(layer, canvas);
        else container.drawHit.call(layer, canvas);
      } finally {
        c.restore();
      }
    });
    p.at = at;
    return layer;
  } finally {
    culling = before;
    if (hadClear && clear !== undefined) attrs.clearBeforeDraw = clear;
    else delete attrs.clearBeforeDraw;
  }
}

/**
 * The layer's canvases no longer hold what it last drew (something else
 * drew on them or cleared them): its next draws are whole ones.
 */
export function redrawWhole(layer: Konva.Layer): void {
  const t = tracks.get(layer);
  if (!t) return;
  markWhole(t, null, 'its canvas was drawn on');
  t.scene.at = null;
  t.hit.at = null;
}

/**
 * The places the layer's last draw of its screen canvas drew again, in its
 * own coordinates (also those off screen); null when it drew everything,
 * or isn't a layer given to `cullOffscreen`.
 */
export function lastDrawBoxes(layer: Konva.Layer): readonly Box[] | null {
  return tracks.get(layer)?.last ?? null;
}

/**
 * Leave the parts outside the view out of this layer's own canvases (the
 * screen and the hit canvas), and draw only the changed places when only
 * parts changed. Returns how to undo it (the layer unmounting).
 */
export function cullOffscreen(layer: Konva.Layer): () => void {
  patchGroups();
  watchChanges();
  const own = layer as unknown as Own;
  const track: Track = { layer, scene: newPending(), hit: newPending(), last: null, whole: 0, partial: 0, cause: { node: null, what: '' }, why: '' };
  tracks.set(layer, track);
  (layer as unknown as { redrawStats?: () => RedrawStats }).redrawStats = () => ({ whole: track.whole, partial: track.partial, why: track.why });
  // The layer's class's own drawing, looked up at each draw (so a wrapper
  // put on the class later, a test's counter say, still runs).
  const proto = Object.getPrototypeOf(layer) as Own;
  const culled = (which: keyof Own, kind: 'scene' | 'hit', ownCanvas: () => unknown): Draw =>
    function (this: Konva.Layer, canvas?: unknown, top?: unknown) {
      const base = proto[which];
      const target = canvas ?? ownCanvas.call(this);
      // Only on the layer's own canvases: exports and prints get every part.
      if (target !== ownCanvas.call(this) || top) return base.call(this, canvas, top);
      return drawOwn(this, kind, target as CanvasLike, () => base.call(this, canvas, top));
    };
  own.drawScene = culled('drawScene', 'scene', function (this: Konva.Layer) {
    return this.getCanvas();
  });
  own.drawHit = culled('drawHit', 'hit', function (this: Konva.Layer) {
    return this.hitCanvas;
  });
  // A canvas the browser dropped and gave back is empty.
  const el = layer.getNativeCanvasElement();
  const lost = (): void => {
    redrawWhole(layer);
    layer.batchDraw();
  };
  el.addEventListener('contextrestored', lost);
  return () => {
    el.removeEventListener('contextrestored', lost);
    if (tracks.get(layer) === track) tracks.delete(layer);
    delete (layer as unknown as { redrawStats?: unknown }).redrawStats;
    delete (own as Partial<Own>).drawScene;
    delete (own as Partial<Own>).drawHit;
  };
}
