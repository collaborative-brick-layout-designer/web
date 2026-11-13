// While the view moves (a middle-button pan, a turn of the wheel, fingers on
// a touch screen) the map isn't drawn again on every frame. On a layout of
// 5,000 parts each of those frames used to draw all 5,000.
//
// Instead, the canvases move. When the view starts moving, a picture is
// taken of the sheets that are costly to draw (the background sheet with the
// grid, venue and areas, the parts sheet, the module outlines), a margin of
// half a screen around it included. It goes in under the canvases, and on
// each frame the canvases and the picture are moved and scaled with a CSS
// transform to where the view now is (`follow`): no Konva work and no React
// render (the editor's `stageView` stays put, editorStore.ts). The picture's
// margin shows parts coming in from the edge.
//
// When the view leaves the picture, or has zoomed in so far it would look
// soft, the stage itself catches up: it's moved to the view once, its
// costly sheets are drawn from a new picture, and the CSS starts again from
// there. A change to the map during the move (someone else's edit, a part's
// picture arriving) draws again only the places of the picture where parts
// changed, when only parts did (cullOffscreen.ts follows each sheet's
// changes for the picture); any other change takes the picture again, at
// most every 150 ms. When the
// view stops, the stage is moved to it and the sheets are drawn sharp again,
// as before.
//
// While the view is still, the picture is kept ready for the next move.
// After a change that drew only some places of the parts sheet again
// (cullOffscreen.ts: a part moved, by anyone), only those places of the
// picture are drawn again; after any other change it's taken afresh.
//
// Konva draws a layer through its `drawScene`; while frozen, each frozen
// layer's own `drawScene` is swapped for one that draws the picture. A draw
// into another canvas (an export) goes through as usual.

import { apart, drawCulled, followForPicture, lastDrawBoxes, pictureChanges, pictureTaken, redrawWhole, shiftsItsDrawing, type Box, type PxBox } from './cullOffscreen';
import Konva from 'konva';
import { SceneCanvas } from 'konva/lib/Canvas';

/**
 * Name for nodes drawn for the view on screen (the grid and its labels,
 * the background color). They are cheap; they draw for whatever canvas
 * they're drawn into, the picture's margin included.
 */
export const VIEW_LIVE = 'view-live';

/** Where the view is: the zoom, and the pan in screen px. */
export interface ViewAt {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ViewBitmapOptions {
  /** The margin around the screen taken into the picture, as a share of its width and height on each side. */
  margin: number;
  /** The most device pixels the picture may have; past that it's taken at a lower resolution. */
  maxPixels: number;
  /** How far the view may zoom in on a picture before it's taken again (it would look soft). */
  maxZoomIn: number;
  /** The least time between two pictures taken because the map changed. */
  minChangeGapMs: number;
}

const DEFAULTS: ViewBitmapOptions = { margin: 0.5, maxPixels: 6_000_000, maxZoomIn: 1.75, minChangeGapMs: 150 };

interface Picture {
  /** Where it covers, in the stage's own (map) units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The view's scale when it was taken. */
  scale: number;
  /** The view and map it was taken of, to reuse it for the next move while nothing changed. */
  stageX: number;
  stageY: number;
  stageW: number;
  stageH: number;
  version: number;
}

type DrawScene = Konva.Layer['drawScene'];

/** Taking a picture afresh: its steps, in order, then `done`. */
interface TakeJob {
  steps: (() => void)[];
  done: () => Picture;
}

/** After a move stops, when to take the next move's picture (after the sharp draw). */
const AFTER_MOVE_MS = 250;
/** After the map changes, how long it must stay still before the next move's picture is taken. */
const SETTLE_MS = 1000;

export class ViewBitmap {
  private readonly opts: ViewBitmapOptions;
  private canvas: SceneCanvas | null = null;
  private picture: Picture | null = null;
  /**
   * The places where the sheets, as drawn on screen, differ from the
   * picture (the stage's own units); null when that isn't known, and the
   * picture must be taken afresh.
   */
  private patch: Box[] | null = null;
  private frozen = false;
  /** Whether the canvases are moved by CSS (`follow`). */
  private following = false;
  /** Bumped whenever the map's drawing may have changed. */
  private version = 0;
  private lastTakenAt = 0;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleHandle: number | null = null;
  /** The sheets whose next draw is the sharp one after a move. */
  private sharpDrawPending = new Set<Konva.Layer>();
  private swapped: { layer: Konva.Layer; own: DrawScene | undefined }[] = [];
  /** A picture being taken afresh while idle, a strip at a time (`prepareWhenIdle`). */
  private job: TakeJob | null = null;
  private jobHandle: number | null = null;
  private readonly offDraw: (() => void)[] = [];
  /** How many pictures were taken (for tests and profiling). */
  taken = 0;
  /** How many times the kept picture was brought up to date in places instead. */
  patched = 0;

  constructor(
    private readonly stage: Konva.Stage,
    /** The sheets taken into the picture, bottom first. */
    private readonly layers: () => Konva.Layer[],
    opts: Partial<ViewBitmapOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** The view starts moving: show the picture from the next frame. */
  freeze(): void {
    if (this.frozen) return;
    const layers = this.layers();
    if (layers.length === 0) return;
    this.frozen = true;
    this.cancelIdle();
    // (A picture half taken while idle is of nothing yet: it's taken now if needed.)
    this.abortJob();
    // A picture of this very map is used as long as it covers the view.
    // The canvases stay as they are drawn while the view moves, so the
    // picture is needed from the first frame.
    if (!this.picture || this.picture.version !== this.version || !this.covers(this.picture)) this.take();
    // From here the sheets draw the picture, not themselves.
    this.patch = null;
    layers.forEach((layer, i) => {
      const own = Object.prototype.hasOwnProperty.call(layer, 'drawScene') ? layer.drawScene : undefined;
      const base = layer.drawScene;
      const frozen: DrawScene = (can, top) => {
        if ((can && can !== layer.getCanvas()) || top) return base.call(layer, can, top);
        this.drawFrozen(layer, i === 0);
        return layer;
      };
      layer.drawScene = frozen;
      this.swapped.push({ layer, own });
    });
  }

  /**
   * Moves and scales the canvases (and the picture under them) to show the
   * view `at`, without drawing anything. False when the picture doesn't
   * cover it, sharp enough: then the stage must be moved to it and drawn
   * (from a new picture), and `follow` called again.
   */
  follow(at: ViewAt): boolean {
    if (!this.frozen) return false;
    const s = this.stage;
    const scale = s.scaleX();
    if (!(scale > 0) || !(at.zoom > 0)) return false;
    const p = this.picture;
    if (!p || !this.coversView(p, at)) return false;
    // The canvases hold the map drawn at the stage's own view.
    const k = at.zoom / scale;
    const tx = at.panX - k * s.x();
    const ty = at.panY - k * s.y();
    const t = `translate(${tx}px, ${ty}px) scale(${k})`;
    for (const layer of s.getLayers()) setTransform(layer.getNativeCanvasElement(), t);
    // The picture: its corner is map point (p.x, p.y), drawn p.scale px per unit.
    const el = this.canvas?._canvas;
    if (el) {
      const kp = at.zoom / p.scale;
      setTransform(el, `translate(${at.panX + at.zoom * p.x}px, ${at.panY + at.zoom * p.y}px) scale(${kp})`);
      if (el.parentElement !== s.content) {
        el.style.pointerEvents = 'none';
        s.content.insertBefore(el, s.content.firstChild);
      }
      el.style.display = '';
    }
    this.following = true;
    return true;
  }

  /** The canvases back where they belong, the picture hidden. */
  private unfollow(): void {
    if (!this.following) return;
    this.following = false;
    for (const layer of this.stage.getLayers()) setTransform(layer.getNativeCanvasElement(), '');
    const el = this.canvas?._canvas;
    if (el) el.style.display = 'none';
  }

  /** Sheets hidden while the view moves (`drawFrozen`), each shown again once it has drawn. */
  private hidden = new Set<Konva.Layer>();
  private hide(layer: Konva.Layer): void {
    if (this.hidden.has(layer)) return;
    this.hidden.add(layer);
    layer.getNativeCanvasElement().style.visibility = 'hidden';
  }
  private show(layer: Konva.Layer): void {
    if (!this.hidden.delete(layer)) return;
    layer.off('draw.view-bitmap-show');
    layer.getNativeCanvasElement().style.visibility = '';
  }

  /** The view has stopped: the sheets draw themselves again (the caller asks for the draw, then calls `settled`). */
  thaw(): void {
    if (!this.frozen) return;
    this.frozen = false;
    for (const { layer, own } of this.swapped) {
      if (own) layer.drawScene = own;
      else delete (layer as Partial<Konva.Layer>).drawScene;
    }
    // A hidden sheet shows again with its next draw (the one asked for now).
    for (const layer of this.hidden) layer.on('draw.view-bitmap-show', () => this.show(layer));
    this.swapped = [];
    // The sharp draw that follows isn't a change to the map.
    this.sharpDrawPending = new Set(this.layers());
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.prepareWhenIdle(AFTER_MOVE_MS);
  }

  /** The sheets have been drawn sharp at the stage's view: the CSS transform goes. */
  settled(): void {
    this.unfollow();
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** The map's drawing may have changed (an edit, a selection, a picture arriving). */
  invalidate(): void {
    this.version++;
    if (this.frozen) {
      this.layers()[0]?.batchDraw();
      return;
    }
    // Not moving: the picture is out of date. It's brought up to date once
    // the map has been still for a moment, so the next move starts smoothly.
    this.prepareWhenIdle(SETTLE_MS);
  }

  /**
   * Watches the sheets: a draw of one of them while the view is still means
   * its drawing changed (a hover, a drag, anything not reported through
   * `invalidate`), so a picture kept from before is out of date.
   */
  watchLayers(): void {
    for (const layer of this.layers()) {
      this.offDraw.push(followForPicture(layer));
      const onDraw = () => {
        if (this.frozen) return;
        // Which places it drew again, when it drew only some (the parts
        // sheet, for a change to parts); a whole draw may have changed anything.
        const boxes = lastDrawBoxes(layer);
        if (boxes && this.patch) this.patch.push(...boxes);
        else this.patch = null;
        if (this.sharpDrawPending.delete(layer)) return;
        this.invalidate();
      };
      layer.on('draw.view-bitmap', onDraw);
      this.offDraw.push(() => layer.off('draw.view-bitmap', onDraw));
    }
  }

  /**
   * Whether the next move starts on the kept picture: one is of this view
   * and this map, and none is being taken. (Tests that count a pan's draws
   * wait for it: until then the move's start takes the picture, every part
   * drawn, as when the map is still busy after opening.)
   */
  ready(): boolean {
    return !this.frozen && !this.job && this.fits();
  }

  dispose(): void {
    this.thaw();
    for (const layer of [...this.hidden]) this.show(layer);
    this.unfollow();
    this.canvas?._canvas.remove();
    this.cancelIdle();
    this.abortJob();
    for (const off of this.offDraw.splice(0)) off();
    this.picture = null;
    this.canvas = null;
  }

  // ── internals ──

  /** Whether the kept picture is of this view and this map. */
  private fits(): boolean {
    const p = this.picture;
    const s = this.stage;
    return (
      !!p &&
      p.version === this.version &&
      p.stageX === s.x() &&
      p.stageY === s.y() &&
      p.scale === s.scaleX() &&
      p.stageW === s.width() &&
      p.stageH === s.height()
    );
  }

  /** Whether the picture still covers the stage's view, sharp enough. */
  private covers(p: Picture): boolean {
    const s = this.stage;
    return this.coversView(p, { zoom: s.scaleX(), panX: s.x(), panY: s.y() });
  }

  /** Whether the picture covers the view `at` on this stage's screen, sharp enough. */
  private coversView(p: Picture, at: ViewAt): boolean {
    const s = this.stage;
    const scale = at.zoom;
    if (scale / p.scale > this.opts.maxZoomIn) return false;
    const x0 = -at.panX / scale;
    const y0 = -at.panY / scale;
    const x1 = x0 + s.width() / scale;
    const y1 = y0 + s.height() / scale;
    const eps = 0.5 / scale;
    return p.x <= x0 + eps && p.y <= y0 + eps && p.x + p.w >= x1 - eps && p.y + p.h >= y1 - eps;
  }

  private drawFrozen(layer: Konva.Layer, bottom: boolean): void {
    const canvas = layer.getCanvas();
    const ctx = canvas.getContext();
    if (!bottom && shiftsItsDrawing(layer)) {
      // Hidden, not cleared: when the view stops, its draw shifts what its
      // canvases have and draws only what the move brought in and what
      // changed meanwhile (cullOffscreen.ts). Drawn whole, the parts sheet
      // was one long task at the end of each pan (about 50 ms zoomed in on
      // 7,520 parts at 4x slowed CPU).
      this.hide(layer);
    } else {
      ctx.clear();
      // Its own drawing is gone from its canvas: its next draw is a whole one.
      redrawWhole(layer);
    }
    if (!bottom) {
      // Something on it changed: the picture (drawn by the bottom sheet) is brought up to date.
      const c = pictureChanges(layer);
      if (!c || c.length > 0) this.layers()[0]?.batchDraw();
      return;
    }
    let p = this.picture;
    const changed = !!p && (p.version !== this.version || this.layers().some((l) => pictureChanges(l)?.length !== 0));
    const now = performance.now();
    if (!p || !this.covers(p)) {
      p = this.take();
    } else if (changed && this.patchFrozen(p)) {
      // Only parts changed: just their places were drawn again in the picture.
    } else if (changed) {
      const wait = this.lastTakenAt + this.opts.minChangeGapMs - now;
      if (wait <= 0) p = this.take();
      else if (this.changeTimer === null) {
        this.changeTimer = setTimeout(() => {
          this.changeTimer = null;
          if (this.frozen) layer.batchDraw();
        }, wait);
      }
    }
    if (!p || !this.canvas) return;
    const s = this.stage;
    const scale = s.scaleX();
    ctx.save();
    ctx.translate(s.x(), s.y());
    ctx.scale(scale, scale);
    ctx.drawImage(this.canvas._canvas, p.x, p.y, p.w, p.h);
    ctx.restore();
  }

  /**
   * While the view moves: when only parts changed since the picture was
   * brought up to date, draws their places in it again (from the parts
   * themselves: the canvases aren't drawn while frozen). False when
   * anything else changed, or the picture isn't at the view's scale.
   */
  private patchFrozen(p: Picture): boolean {
    const canvas = this.canvas;
    const s = this.stage;
    const scale = s.scaleX();
    if (!canvas || scale !== p.scale) return false;
    const layers = this.layers();
    const boxes: Box[] = [];
    for (const layer of layers) {
      const b = pictureChanges(layer);
      if (!b) return false;
      boxes.push(...b);
    }
    for (const layer of layers) pictureTaken(layer);
    p.version = this.version;
    this.patched++;
    this.lastTakenAt = performance.now();
    const ratio = canvas.pixelRatio;
    const all: PxBox[] = [];
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor((b.x0 - p.x) * scale * ratio));
      const y0 = Math.max(0, Math.floor((b.y0 - p.y) * scale * ratio));
      const x1 = Math.min(canvas.width, Math.ceil((b.x1 - p.x) * scale * ratio));
      const y1 = Math.min(canvas.height, Math.ceil((b.y1 - p.y) * scale * ratio));
      if (x1 > x0 && y1 > y0) all.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    if (all.length === 0) return true;
    const ctx = canvas.getContext();
    const c = ctx._context;
    // The stage's view is drawn into the picture where the picture puts it.
    const tx = -p.x * scale - s.x();
    const ty = -p.y * scale - s.y();
    const drawAll = (): void => {
      for (const layer of layers) {
        if (!layer.isVisible()) continue;
        for (const child of layer.getChildren()) child.drawScene(canvas);
      }
    };
    const view: Box = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    for (const r of apart(all, 6)) {
      c.save();
      const base = c.getTransform();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(r.x, r.y, r.w, r.h);
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      c.setTransform(base);
      ctx.translate(tx, ty);
      const only: Box = {
        x0: p.x + r.x / ratio / scale,
        y0: p.y + r.y / ratio / scale,
        x1: p.x + (r.x + r.w) / ratio / scale,
        y1: p.y + (r.y + r.h) / ratio / scale,
      };
      drawCulled(canvas, view, drawAll, [only]);
      c.restore();
    }
    (canvas as unknown as { _trimIsolationCanvas?: () => void })._trimIsolationCanvas?.();
    return true;
  }

  /** Draws the sheets for the view on screen, with the margin, into the picture. */
  private take(): Picture | null {
    this.abortJob();
    const t = this.startTake();
    if (!t || !('steps' in t)) return t;
    for (const step of t.steps) step();
    return t.done();
  }

  /**
   * Starts taking the picture: the kept one brought up to date in places
   * (done at once), or the steps that take it afresh, then `done`.
   */
  private startTake(): Picture | TakeJob | null {
    const s = this.stage;
    const layers = this.layers();
    const w = s.width();
    const h = s.height();
    const scale = s.scaleX();
    if (!(w > 0 && h > 0 && scale > 0) || layers.length === 0) return null;
    const m = this.opts.margin;
    const cw = Math.ceil(w * (1 + 2 * m));
    const ch = Math.ceil(h * (1 + 2 * m));
    const ratio = Math.min(layers[0]!.getCanvas().getPixelRatio(), Math.sqrt(this.opts.maxPixels / (cw * ch)));
    // The sheets were drawn for this very view a moment ago (not frozen,
    // nothing waiting to be drawn).
    const current = !this.frozen && layers.every((l) => !l.isVisible() || !(l as unknown as { _waitingForDraw?: boolean })._waitingForDraw);
    const kept = this.picture;
    const patch = this.patch;
    this.patch = current ? [] : null;
    // What changes from here is drawn into the picture by a later patch.
    for (const layer of layers) pictureTaken(layer);
    if (
      current && kept && patch && this.canvas &&
      kept.stageX === s.x() && kept.stageY === s.y() && kept.scale === scale && kept.stageW === w && kept.stageH === h &&
      this.canvas.pixelRatio === ratio && this.canvas.width === Math.floor(cw * ratio) && this.canvas.height === Math.floor(ch * ratio)
    ) {
      // The kept picture is of this view: only the places that were drawn
      // again since are drawn again in it.
      this.drawPatch(layers, patch, w, h, ratio);
      kept.version = this.version;
      this.patched++;
      this.lastTakenAt = performance.now();
      return kept;
    }
    if (!this.canvas) {
      this.canvas = new SceneCanvas({ width: cw, height: ch, pixelRatio: ratio });
      const el = this.canvas._canvas;
      el.style.display = 'none';
      el.style.transformOrigin = '0 0';
      el.setAttribute('aria-hidden', 'true');
      el.dataset.viewBitmap = '';
    }
    const canvas = this.canvas;
    // What the canvas holds from here isn't the kept picture.
    this.picture = null;
    const ctx = canvas.getContext();
    const drawAll = (): void => {
      for (const layer of layers) {
        if (!layer.isVisible()) continue;
        for (const child of layer.getChildren()) child.drawScene(canvas);
      }
    };
    const sx = s.x();
    const sy = s.y();
    /** Draws only the parts in this part of the picture (px from the view's corner), clipped to it (cullOffscreen.ts). */
    const drawIn = (x: number, y: number, rw: number, rh: number): void => {
      ctx.save();
      ctx.translate(m * w, m * h);
      ctx.beginPath();
      ctx.rect(x, y, rw, rh);
      ctx.clip();
      drawCulled(canvas, { x0: (x - sx) / scale, y0: (y - sy) / scale, x1: (x + rw - sx) / scale, y1: (y + rh - sy) / scale }, drawAll);
      ctx.restore();
    };
    const steps: (() => void)[] = [
      () => {
        if (canvas.pixelRatio !== ratio || canvas.width !== Math.floor(cw * ratio) || canvas.height !== Math.floor(ch * ratio)) {
          canvas.pixelRatio = ratio;
          canvas.setSize(cw, ch);
        } else {
          canvas.getContext().clear();
        }
        if (!current) return;
        ctx.save();
        ctx.translate(m * w, m * h);
        for (const layer of layers) if (layer.isVisible()) ctx.drawImage(layer.getCanvas()._canvas, 0, 0, w, h);
        ctx.restore();
      },
    ];
    // The sheets are current: the view is copied from them, and only
    // the margin around it is drawn. On a big layout that is most of the
    // work saved after each change (anyone's): it used to draw every part again.
    if (current) {
      const mw = m * w;
      const mh = m * h;
      // Taken while idle, each strip is a step of its own. (Not split any
      // further: a part drawn in two clips doesn't come out quite the same,
      // even on whole device px.)
      steps.push(
        () => drawIn(-mw, -mh, w + 2 * mw, mh),
        () => drawIn(-mw, h, w + 2 * mw, mh),
        () => drawIn(-mw, 0, mw, h),
        () => drawIn(w, 0, mw, h),
      );
    } else {
      // Only the parts in the picture (the view and its margin).
      steps.push(() => drawIn(-m * w, -m * h, cw, ch));
    }
    const version = this.version;
    return {
      steps,
      done: () => {
        (canvas as unknown as { _trimIsolationCanvas?: () => void })._trimIsolationCanvas?.();
        this.taken++;
        this.lastTakenAt = performance.now();
        this.picture = {
          x: (-m * w - sx) / scale,
          y: (-m * h - sy) / scale,
          w: cw / scale,
          h: ch / scale,
          scale,
          stageX: sx,
          stageY: sy,
          stageW: w,
          stageH: h,
          version,
        };
        return this.picture;
      },
    };
  }

  /** A picture being taken while idle stops: what's on its canvas isn't a picture of anything. */
  private abortJob(): void {
    if (!this.job) return;
    if (this.jobHandle !== null) (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(this.jobHandle);
    this.jobHandle = null;
    this.job = null;
    this.picture = null;
    this.patch = null;
  }

  /**
   * Draws the places `boxes` (the stage's own units) of the kept picture
   * again: the view copied from the sheets' canvases, the margin drawn from
   * the parts that reach into those places.
   */
  private drawPatch(layers: Konva.Layer[], boxes: readonly Box[], w: number, h: number, ratio: number): void {
    const canvas = this.canvas;
    if (!canvas || boxes.length === 0) return;
    const s = this.stage;
    const scale = s.scaleX();
    const mw = this.opts.margin * w;
    const mh = this.opts.margin * h;
    // The places in the picture's device px, whole ones so nothing blends
    // along their edges, and apart from each other (cullOffscreen's `apart`).
    const all: PxBox[] = [];
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor((b.x0 * scale + s.x() + mw) * ratio));
      const y0 = Math.max(0, Math.floor((b.y0 * scale + s.y() + mh) * ratio));
      const x1 = Math.min(canvas.width, Math.ceil((b.x1 * scale + s.x() + mw) * ratio));
      const y1 = Math.min(canvas.height, Math.ceil((b.y1 * scale + s.y() + mh) * ratio));
      if (x1 > x0 && y1 > y0) all.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    const ctx = canvas.getContext();
    const c = ctx._context;
    const drawAll = (): void => {
      for (const layer of layers) {
        if (!layer.isVisible()) continue;
        for (const child of layer.getChildren()) child.drawScene(canvas);
      }
    };
    for (const r of apart(all, 6)) {
      c.save();
      const base = c.getTransform();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(r.x, r.y, r.w, r.h);
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      c.setTransform(base);
      ctx.translate(mw, mh);
      for (const layer of layers) if (layer.isVisible()) ctx.drawImage(layer.getCanvas()._canvas, 0, 0, w, h);
      // The place in the stage's own units.
      const only: Box = {
        x0: (r.x / ratio - mw - s.x()) / scale,
        y0: (r.y / ratio - mh - s.y()) / scale,
        x1: ((r.x + r.w) / ratio - mw - s.x()) / scale,
        y1: ((r.y + r.h) / ratio - mh - s.y()) / scale,
      };
      // The margin: each strip around the view that the place reaches into.
      const strip = (x: number, y: number, rw: number, rh: number): void => {
        const x0 = (x - s.x()) / scale;
        const y0 = (y - s.y()) / scale;
        const x1 = (x + rw - s.x()) / scale;
        const y1 = (y + rh - s.y()) / scale;
        if (!(only.x1 > x0 && only.x0 < x1 && only.y1 > y0 && only.y0 < y1)) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, rw, rh);
        ctx.clip();
        drawCulled(canvas, { x0, y0, x1, y1 }, drawAll, [only]);
        ctx.restore();
      };
      strip(-mw, -mh, w + 2 * mw, mh);
      strip(-mw, h, w + 2 * mw, mh);
      strip(-mw, 0, mw, h);
      strip(w, 0, mw, h);
      c.restore();
    }
    (canvas as unknown as { _trimIsolationCanvas?: () => void })._trimIsolationCanvas?.();
  }

  /**
   * The picture for the view on screen is taken while the page is idle, so
   * the next move starts on it without a slow first frame: shortly after a
   * move (once its sharp draw has run), and once the map has been still for
   * a moment after a change. While changes keep coming (an edit, someone
   * else's, pictures arriving) it waits, so it isn't taken for each one.
   */
  private prepareWhenIdle(delayMs: number): void {
    this.cancelIdle();
    const w = window as Window & { requestIdleCallback?: (cb: (d?: { timeRemaining: () => number }) => void, o?: { timeout: number }) => number };
    const run = (deadline?: { timeRemaining: () => number }) => {
      this.idleHandle = null;
      // (One being taken goes on: it's brought up to date when done.)
      if (this.frozen || this.job || this.fits()) return;
      const t = this.startTake();
      if (!t || !('steps' in t)) return;
      this.job = t;
      this.stepJob(deadline);
    };
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (w.requestIdleCallback) this.idleHandle = w.requestIdleCallback(run, { timeout: 500 });
      else run();
    }, delayMs);
  }

  /**
   * A picture taken afresh is drawn a strip at a time, one or more per idle
   * moment: in one go it was a long task after each pan (about 150 ms on
   * 7,520 parts zoomed in at 4x slowed CPU). What changes meanwhile is
   * drawn into it when it's done, as after any change (`patch`).
   */
  private stepJob(deadline?: { timeRemaining: () => number }): void {
    this.jobHandle = null;
    const job = this.job;
    if (!job || this.frozen) return;
    const w = window as Window & { requestIdleCallback?: (cb: (d?: { timeRemaining: () => number }) => void, o?: { timeout: number }) => number };
    // Another step only while the idle time left fits one more like the last.
    let took: number;
    do {
      const t0 = performance.now();
      job.steps.shift()!();
      took = performance.now() - t0;
    } while (job.steps.length > 0 && (!w.requestIdleCallback || (deadline?.timeRemaining() ?? 0) > Math.max(10, 1.5 * took)));
    if (job.steps.length > 0) {
      // (Soon even when the page isn't idle: the picture is wanted for the next move.)
      this.jobHandle = w.requestIdleCallback!((d) => this.stepJob(d), { timeout: 50 });
      return;
    }
    this.job = null;
    job.done();
    if (!this.fits()) this.prepareWhenIdle(AFTER_MOVE_MS);
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.idleHandle !== null) (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(this.idleHandle);
    this.idleHandle = null;
  }
}

function setTransform(el: HTMLElement, t: string): void {
  if (t && el.style.transformOrigin !== '0px 0px') el.style.transformOrigin = '0 0';
  if (el.style.transform !== t) el.style.transform = t;
}
