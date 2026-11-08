// Fit to View — desktop MainWindow::onFitToView: fitInView of every item's
// bounding rect grown by 50 scene px, aspect kept (QGraphicsView leaves a
// 2 px margin inside the viewport).
//
// On a phone the view also keeps clear of the scale card and the screen
// edges (`insets`), and the grid's cell labels (A, B, C… / 1, 2, 3…) are
// part of what must fit, so column A and row 1 are never cut off.

import type { LayerGrid } from '@cld/model';
import type { StudRect } from './exportRender';
import { parseCellIndexCorner } from './render/gridIndex';

const PX_PER_STUD = 8;
const MARGIN_SCENE_PX = 50;
const VIEW_MARGIN_PX = 2;

/** Screen pixels to keep clear on each side of the view. */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DESKTOP_INSETS: ViewInsets = { top: VIEW_MARGIN_PX, right: VIEW_MARGIN_PX, bottom: VIEW_MARGIN_PX, left: VIEW_MARGIN_PX };

/** Zoom and pan that fit `bounds` (studs) into a `width` x `height` view, or null when nothing fits. */
export function fitView(
  bounds: StudRect | null,
  width: number,
  height: number,
  zoomRange: { min: number; max: number },
  insets: ViewInsets = DESKTOP_INSETS,
  /** Scene px added round the bounds; a phone passes 0 and keeps its air in `insets`. */
  marginScenePx: number = MARGIN_SCENE_PX,
): { zoom: number; panX: number; panY: number } | null {
  if (!bounds) return null;
  const w = bounds.width * PX_PER_STUD + 2 * marginScenePx;
  const h = bounds.height * PX_PER_STUD + 2 * marginScenePx;
  const vw = width - insets.left - insets.right;
  const vh = height - insets.top - insets.bottom;
  if (!(w > 0 && h > 0 && vw > 0 && vh > 0)) return null;
  const zoom = Math.max(zoomRange.min, Math.min(zoomRange.max, Math.min(vw / w, vh / h)));
  const cx = (bounds.x + bounds.width / 2) * PX_PER_STUD;
  const cy = (bounds.y + bounds.height / 2) * PX_PER_STUD;
  // Centre in the part of the view left once the insets are taken off.
  return { zoom, panX: insets.left + vw / 2 - cx * zoom, panY: insets.top + vh / 2 - cy * zoom };
}

/** How close (in cells) the label row / column must be to the content to be worth fitting. */
const LABEL_REACH_CELLS = 2;

/**
 * Grow `bounds` to take in the grid's cell-index labels next to the
 * content: the row of column letters and the column of row numbers
 * (see gridIndex.ts). A label row far away from the content is left out,
 * so a stray origin never shrinks the layout to a speck.
 */
export function withGridLabels(bounds: StudRect | null, grid: LayerGrid | null | undefined): StudRect | null {
  if (!bounds || !grid || !grid.visible || !grid.displayCellIndex) return bounds;
  const cell = grid.gridSizeInStud;
  if (!(cell > 0)) return bounds;
  const corner = parseCellIndexCorner(grid.cellIndexCorner);
  let minX = bounds.x;
  let minY = bounds.y;
  let maxX = bounds.x + bounds.width;
  let maxY = bounds.y + bounds.height;
  const reach = LABEL_REACH_CELLS * cell;
  // Column letters sit in the row `corner.y`.
  const rowTop = corner.y * cell;
  const rowBottom = rowTop + cell;
  if (rowBottom >= bounds.y - reach && rowTop <= maxY + reach) {
    minY = Math.min(minY, rowTop);
    maxY = Math.max(maxY, rowBottom);
  }
  // Row numbers sit in the column `corner.x`.
  const colLeft = corner.x * cell;
  const colRight = colLeft + cell;
  if (colRight >= bounds.x - reach && colLeft <= maxX + reach) {
    minX = Math.min(minX, colLeft);
    maxX = Math.max(maxX, colRight);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Whether the view still shows the last automatic fit, i.e. the user
 * hasn't panned or zoomed since. Only then is it right to fit again when
 * the canvas changes size (phone rotated, browser bars shown or hidden).
 */
export function isUntouchedFit(
  view: { zoom: number; panX: number; panY: number },
  lastFit: { zoom: number; panX: number; panY: number } | null,
): boolean {
  if (!lastFit) return false;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  return close(view.zoom, lastFit.zoom) && close(view.panX, lastFit.panX) && close(view.panY, lastFit.panY);
}
