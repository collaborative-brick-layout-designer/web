// Export the WHOLE map, not just the visible viewport — desktop renders
// `scene->itemsBoundingRect()` plus a 20 px margin (MainWindowMenus.cpp:102,
// 178), onto the map background color, without the view-only chrome
// (grid, selection, snap ring, cursors), which desktop paints in
// drawBackground / drawForeground rather than as scene items.

import type Konva from 'konva';
import type { BbmMap, LayerGrid } from '@cld/model';
import type { Sidecar } from '@cld/bbm';
import { colorSpecToCss } from './layerOptions';
import { cellIndexLabels, parseCellIndexCorner } from './render/gridIndex';
import { MAP_FONT_STACK } from './render/mapText';
import { SHEET_FADE, SHEET_FULL_OPACITY } from './render/sheetFade';

/** Konva node name for view-only chrome hidden while exporting. */
export const EXPORT_HIDE = 'export-hide';

/** Desktop's 20 scene-px margin at 8 px/stud. */
export const EXPORT_MARGIN_STUDS = 2.5;

/** Browser canvas limits (Chrome/Firefox: 32767 per side, ~268M px area; Safari lower). */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 16384 * 16384;

export interface StudRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounding box, in studs, of everything drawn as map content: bricks,
 * text cells and ruler items of visible layers, painted area cells,
 * World-anchored labels and the venue outline/obstacles. Null for an
 * empty map. Mirrors what desktop's scene contains.
 */
/** The smallest rect holding `base` and every one of `more`; null when there's nothing. */
export function unionStudRects(base: StudRect | null, more: readonly StudRect[]): StudRect | null {
  let r = base;
  for (const m of more) {
    if (!r) {
      r = { ...m };
      continue;
    }
    const x = Math.min(r.x, m.x);
    const y = Math.min(r.y, m.y);
    r = { x, y, width: Math.max(r.x + r.width, m.x + m.width) - x, height: Math.max(r.y + r.height, m.y + m.height) - y };
  }
  return r;
}

export function contentBoundsStuds(map: BbmMap, sidecar?: Sidecar | null): StudRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number, w = 0, h = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    switch (layer.type) {
      case 'brick':
        for (const b of layer.bricks) add(b.displayArea.x, b.displayArea.y, b.displayArea.width, b.displayArea.height);
        break;
      case 'text':
        for (const c of layer.textCells) add(c.displayArea.x, c.displayArea.y, c.displayArea.width, c.displayArea.height);
        break;
      case 'ruler':
        for (const r of layer.rulerItems) add(r.displayArea.x, r.displayArea.y, r.displayArea.width, r.displayArea.height);
        break;
      case 'area': {
        const s = layer.areaCellSize;
        for (const c of layer.areas) add(c.x * s, c.y * s, s, s);
        break;
      }
      default:
        break;
    }
  }
  for (const l of sidecar?.anchoredLabels ?? []) {
    // World, Group and Module labels sit at their offset as a world
    // position (SceneBuilderSidecar.cpp:222-223); Brick labels ride on
    // bricks already inside the box.
    if (l.kind !== 1) add(l.offset.x, l.offset.y);
  }
  const venue = sidecar?.venue;
  if (venue) {
    for (const e of venue.edges) for (const p of e.poly) add(p.x, p.y);
    for (const o of venue.obstacles) for (const p of o.poly) add(p.x, p.y);
    for (const p of venue.power ?? []) add(p.x, p.y);
    for (const n of venue.notes ?? []) add(n.x, n.y);
    for (const d of venue.dimensions ?? []) {
      add(d.from.x, d.from.y);
      add(d.to.x, d.to.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Largest pixel ratio ≤ `requested` that keeps a `widthPx × heightPx`
 * render inside the browser's canvas limits.
 */
export function clampPixelRatio(widthPx: number, heightPx: number, requested: number): number {
  if (widthPx <= 0 || heightPx <= 0) return requested;
  const bySide = MAX_CANVAS_SIDE / Math.max(widthPx, heightPx);
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (widthPx * heightPx));
  return Math.max(0.01, Math.min(requested, bySide, byArea));
}

/** Stud region of the full-map export: content bounds plus the desktop margin. Null for an empty map. */
export function exportRegionStuds(map: BbmMap, sidecar?: Sidecar | null, extra: readonly StudRect[] = []): StudRect | null {
  const b = unionStudRects(contentBoundsStuds(map, sidecar), extra);
  if (!b) return null;
  return {
    x: b.x - EXPORT_MARGIN_STUDS,
    y: b.y - EXPORT_MARGIN_STUDS,
    width: b.width + 2 * EXPORT_MARGIN_STUDS,
    height: b.height + 2 * EXPORT_MARGIN_STUDS,
  };
}

/** Desktop's export watermark: always "author / LUG / event" (MainWindowMenus.cpp:184-186). */
export function watermarkText(map: Pick<BbmMap, 'author' | 'lug' | 'event'>): string {
  return `${map.author} / ${map.lug} / ${map.event}`;
}

/** Watermark font size in px: QFont point size max(8, height / 60) at 96 dpi. */
export function watermarkFontPx(imageHeight: number): number {
  return (Math.max(8, Math.floor(imageHeight / 60)) * 96) / 72;
}

/** Scene-pixel size (1 stud = 8 px) of the full-map export, margin included. Null for an empty map. */
export function exportSceneSize(
  map: BbmMap,
  sidecar?: Sidecar | null,
  extra: readonly StudRect[] = [],
): { width: number; height: number } | null {
  const b = unionStudRects(contentBoundsStuds(map, sidecar), extra);
  if (!b) return null;
  return {
    width: Math.ceil((b.width + 2 * EXPORT_MARGIN_STUDS) * 8),
    height: Math.ceil((b.height + 2 * EXPORT_MARGIN_STUDS) * 8),
  };
}

/**
 * Output height for `width` that keeps the scene's aspect ratio — desktop
 * "Keep aspect ratio (height auto)": max(64, width * h / w).
 */
export function aspectHeight(width: number, scene: { width: number; height: number }): number {
  if (scene.width <= 0) return width;
  return Math.max(64, Math.round(width * (scene.height / scene.width)));
}

/** A new picture's longest side (px): big enough to print or zoom, small enough to send. */
export const DEFAULT_EXPORT_LONG_SIDE = 4000;

/**
 * The picture size a first export starts at: twice the map's own size
 * (1 stud = 16 px), but no more than DEFAULT_EXPORT_LONG_SIDE on its
 * longest side (a big layout at 2x was 16,384 px wide, a 118 MB PNG).
 */
export function defaultExportSize(scene: { width: number; height: number }): { width: number; height: number } {
  const long = Math.max(scene.width, scene.height, 1);
  const k = Math.min(2, DEFAULT_EXPORT_LONG_SIDE / long);
  return {
    width: Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(scene.width * k))),
    height: Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(scene.height * k))),
  };
}

/**
 * Roughly how big the file will be, in bytes. A layout picture is mostly
 * flat color: PNG comes to about 0.8 bytes a pixel (the 16,384 x 9,196
 * Fordyce export was 118 MB), JPEG to a fraction of that, more at a
 * higher quality.
 */
export function estimateImageBytes(width: number, height: number, format: 'png' | 'jpeg', quality = 90): number {
  const px = Math.max(0, width) * Math.max(0, height);
  const perPx = format === 'png' ? 0.8 : 0.05 + 0.35 * (Math.max(10, Math.min(100, quality)) / 100) ** 2;
  return Math.round(px * perPx);
}

/** "about 12 MB", "about 800 KB". */
export function aboutSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `about ${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `about ${mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString('en-US')} MB`;
}

/** Round an explicit export size to whole pixels inside the browser's canvas limits. */
export function clampExportSize(width: number, height: number): { width: number; height: number } {
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));
  const k = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  if (k < 1) {
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  return { width: w, height: h };
}

/**
 * CSS color the export paints under the map: the layout's background,
 * alpha included. A known name the table can't resolve paints black, like
 * desktop QColor(name) (XmlPrimitives.cpp:72-77).
 */
export function exportBackground(map: Pick<BbmMap, 'backgroundColor'>): string {
  return colorSpecToCss(map.backgroundColor, '#000000');
}

export interface ExportOptions {
  /** Output pixels per scene pixel (1 stud = 8 scene px). Clamped to canvas limits. */
  pixelRatio: number;
  /**
   * Explicit output size in px (desktop Width / Height, MainWindowMenus.cpp:
   * 132-163). Overrides `pixelRatio`; the map is scaled to fill it, so a
   * size off the map's aspect ratio stretches it (Qt::IgnoreAspectRatio).
   */
  size?: { width: number; height: number };
  /**
   * Smooth sprite scaling (desktop "Antialias" = SmoothPixmapTransform).
   * Canvas 2D always antialiases vector shapes. Default true.
   */
  antialias?: boolean;
  transparent: boolean;
  /** Bottom-right "author / LUG / event" stamp, like desktop's watermark option. */
  watermark?: string;
  /**
   * Render exactly this map region (studs) instead of the whole map — one
   * print tile. It may extend past the content; that part shows the
   * background color.
   */
  regionStuds?: StudRect;
  /**
   * Draw this grid layer's lines under the map (a saved view with the
   * grid on). The on-screen grid only covers the screen, so the export
   * paints its own over the whole region.
   */
  grid?: LayerGrid | null;
}

/**
 * Paint a grid's cell indices (the origin row's letters and column's
 * numbers, as BlueBrick's exported pictures show them) over `region`,
 * centred in their cells in the bundled map font, sized like the map's
 * (pt × 4/3 scene px per stud, scaled with the picture); the desktop's
 * pictures draw the same (SavedViews.cpp paintGrid).
 */
export function paintCellIndices(
  ctx: CanvasRenderingContext2D,
  grid: LayerGrid,
  region: StudRect,
  pxPerStudX: number,
  pxPerStudY: number = pxPerStudX,
): number {
  if (!grid.displayCellIndex) return 0;
  const labels = cellIndexLabels(
    { xMin: region.x, yMin: region.y, xMax: region.x + region.width, yMax: region.y + region.height },
    grid.gridSizeInStud,
    parseCellIndexCorner(grid.cellIndexCorner),
    grid.cellIndexColumnType,
    grid.cellIndexRowType,
  );
  if (labels.length === 0) return 0;
  const scale = Math.min(pxPerStudX, pxPerStudY) / 8;
  const fontPx = Math.max(1, Math.round((grid.cellIndexFont.size || 10) * (4 / 3) * 8)) * scale;
  const style = (grid.cellIndexFont.style ?? '').toLowerCase();
  ctx.save();
  ctx.font = `${style.includes('italic') ? 'italic ' : ''}${style.includes('bold') ? 'bold ' : ''}${fontPx}px ${MAP_FONT_STACK}`;
  ctx.fillStyle = colorSpecToCss(grid.cellIndexColor);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('M');
  const lift = ((m.fontBoundingBoxAscent ?? fontPx * 0.905) - (m.fontBoundingBoxDescent ?? fontPx * 0.212)) / 2;
  for (const l of labels) {
    const cx = (l.x + grid.gridSizeInStud / 2 - region.x) * pxPerStudX;
    const cy = (l.y + grid.gridSizeInStud / 2 - region.y) * pxPerStudY;
    ctx.fillText(l.text, cx, cy + lift);
  }
  ctx.restore();
  return labels.length;
}

/**
 * Paint a grid's lines (sub-grid first, then the main grid) over `region`
 * onto `ctx`, where one stud is `pxPerStud` output pixels. Lines sit on
 * whole multiples of the grid size, like the on-screen grid.
 */
export function paintGridLines(
  ctx: Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'stroke'> & { strokeStyle: unknown; lineWidth: number },
  grid: LayerGrid,
  region: StudRect,
  pxPerStudX: number,
  pxPerStudY: number = pxPerStudX,
): number {
  let drawn = 0;
  const pass = (step: number, color: string, thickness: number) => {
    if (!(step > 0)) return;
    const nx = Math.floor(region.width / step) + 2;
    const ny = Math.floor(region.height / step) + 2;
    if (nx > 4000 || ny > 4000) return; // too fine to see anyway
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, thickness * Math.min(pxPerStudX, pxPerStudY) / 8);
    ctx.beginPath();
    const w = region.width * pxPerStudX;
    const h = region.height * pxPerStudY;
    for (let x = Math.ceil(region.x / step) * step; x <= region.x + region.width; x += step) {
      const px = (x - region.x) * pxPerStudX;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      drawn++;
    }
    for (let y = Math.ceil(region.y / step) * step; y <= region.y + region.height; y += step) {
      const py = (y - region.y) * pxPerStudY;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      drawn++;
    }
    ctx.stroke();
  };
  if (grid.displaySubGrid) {
    pass(grid.gridSizeInStud / Math.max(2, grid.subDivisionNumber), colorSpecToCss(grid.subGridColor), grid.subGridThickness);
  }
  if (grid.displayGrid !== false) pass(grid.gridSizeInStud, colorSpecToCss(grid.gridColor), grid.gridThickness);
  return drawn;
}

/**
 * Draw every sheet at its own strength, as with "Fade other sheets while
 * editing" off (render/sheetFade.ts): a picture never shows the fade. Returns
 * the function that puts the fade back.
 */
export function unfadeSheets(stage: Konva.Stage): () => void {
  const saved: [Konva.Node, number][] = [];
  for (const n of stage.find(`.${SHEET_FADE}`)) {
    const full = (n.getAttr(SHEET_FULL_OPACITY) as number | undefined) ?? 1;
    if (n.opacity() !== full) {
      saved.push([n, n.opacity()]);
      n.opacity(full);
    }
  }
  return () => {
    for (const [n, o] of saved) n.opacity(o);
  };
}

/**
 * Render the full map to a canvas: the stage is temporarily reset to
 * 1:1 at the content origin, view-only chrome (nodes named
 * `EXPORT_HIDE` plus the HUD layer) is hidden, every sheet draws at full
 * strength whatever "Fade other sheets while editing" says (unfadeSheets),
 * and the result is composited over the map background color. Everything is
 * restored before returning. Null for an empty map.
 */
export function renderMapToCanvas(
  stage: Konva.Stage,
  map: BbmMap,
  sidecar: Sidecar | null,
  opts: ExportOptions & { hudLayer?: Konva.Layer | null },
): { canvas: HTMLCanvasElement; pixelRatio: number } | null {
  const region = opts.regionStuds ?? exportRegionStuds(map, sidecar);
  if (!region) return null;
  const PX = 8;
  const x0 = region.x * PX;
  const y0 = region.y * PX;
  const w = Math.ceil(region.width * PX);
  const h = Math.ceil(region.height * PX);
  const size = opts.size ? clampExportSize(opts.size.width, opts.size.height) : null;
  // With an explicit size, render at the larger of the two axis scales
  // and resample into the requested box.
  const pixelRatio = clampPixelRatio(w, h, size ? Math.max(size.width / w, size.height / h) : opts.pixelRatio);
  const smooth = opts.antialias !== false;

  const saved = { x: stage.x(), y: stage.y(), sx: stage.scaleX(), sy: stage.scaleY() };
  const hidden: Konva.Node[] = [];
  for (const n of stage.find(`.${EXPORT_HIDE}`)) {
    if (n.visible()) {
      n.visible(false);
      hidden.push(n);
    }
  }
  if (opts.hudLayer && opts.hudLayer.visible()) {
    opts.hudLayer.visible(false);
    hidden.push(opts.hudLayer);
  }
  // Konva renders each layer into a canvas of its own the size of the
  // picture before putting them together: leave out the layers with nothing
  // to draw (the drag layer, an empty module or bend layer). On a big
  // export each one was a 16,384 px canvas made and copied for nothing.
  for (const layer of stage.getLayers?.() ?? []) {
    if (!layer.visible()) continue;
    if (layer.findOne((n: Konva.Node) => n.nodeType === 'Shape' && n.isVisible())) continue;
    layer.visible(false);
    hidden.push(layer);
  }
  const refade = unfadeSheets(stage);
  let content: HTMLCanvasElement;
  try {
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: -x0, y: -y0 });
    content = stage.toCanvas({ x: 0, y: 0, width: w, height: h, pixelRatio, imageSmoothingEnabled: smooth });
  } finally {
    stage.scale({ x: saved.sx, y: saved.sy });
    stage.position({ x: saved.x, y: saved.y });
    for (const n of hidden) n.visible(true);
    refade();
    stage.batchDraw();
  }

  const outWidth = size?.width ?? content.width;
  const outHeight = size?.height ?? content.height;
  // Already the size asked for, and no grid to go under it: the background
  // goes under the picture in place, with no second canvas to copy it into.
  if (!opts.grid && content.width === outWidth && content.height === outHeight) {
    const ctx = content.getContext('2d');
    if (ctx) {
      if (!opts.transparent) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = exportBackground(map);
        ctx.fillRect(0, 0, outWidth, outHeight);
        ctx.restore();
      }
      stampWatermark(ctx, opts.watermark, outWidth, outHeight);
      return { canvas: content, pixelRatio };
    }
  }
  const out = document.createElement('canvas');
  out.width = outWidth;
  out.height = outHeight;
  const ctx = out.getContext('2d');
  if (!ctx) return { canvas: content, pixelRatio };
  if (!opts.transparent) {
    ctx.fillStyle = exportBackground(map);
    ctx.fillRect(0, 0, out.width, out.height);
  }
  if (opts.grid) {
    paintGridLines(ctx, opts.grid, region, out.width / region.width, out.height / region.height);
    paintCellIndices(ctx, opts.grid, region, out.width / region.width, out.height / region.height);
  }
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(content, 0, 0, out.width, out.height);
  stampWatermark(ctx, opts.watermark, out.width, out.height);
  return { canvas: out, pixelRatio };
}

/** The general-info watermark, bottom right, in QColor(0, 0, 0, 140). */
function stampWatermark(ctx: CanvasRenderingContext2D, text: string | undefined, width: number, height: number): void {
  if (!text) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = `${watermarkFontPx(height)}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.549)'; // QColor(0, 0, 0, 140)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, width - 10, height - 10);
  ctx.restore();
}
