import { memo } from 'react';
import type Konva from 'konva';
import { Group, Shape, Text } from 'react-konva';
import type { BbmMap, LayerGrid } from '@cld/model';
import { studToPx } from './coords';
import { useEditorStore } from '../editorStore';
import { colorSpecToCss } from '../layerOptions';
import { cellIndexLabels, drawnGridLayer, parseCellIndexCorner } from './gridIndex';
import { fontStack } from './fontStack';
import { legibleLabelPx } from '../textLegibility';
import { studGridFade } from '../gridSnap';

export interface ViewportRect {
  /** World-space (stud) bounds currently visible on the stage. */
  studXMin: number;
  studYMin: number;
  studXMax: number;
  studYMax: number;
}

/**
 * Background fill + grid lines, drawn for whatever the canvas they're drawn
 * into shows.
 *
 * Old behaviour drew a fixed 2000-stud square centred on the origin —
 * panning or zooming far enough left a blank stage. The fill and the lines
 * are one shape that works out, when it's drawn, what part of the map the
 * canvas covers: the screen, or the bigger picture of the map taken while
 * the view moves (viewBitmap.ts), its margin included. So a pan needn't
 * render anything again for the grid: Konva just draws it for the new view.
 * The cell-index labels, a few Text nodes, still follow `viewport`.
 */
interface GridLayerProps {
  map: BbmMap;
  /** World-space (stud) bounds the cell-index labels are laid out over. */
  viewport: ViewportRect;
  /** Live cell-index origin while it is being dragged (not yet in the doc). */
  cornerOverride?: { layerId: string; corner: { x: number; y: number } } | null;
  /** Override the editor-store value. Pass `true` from the public viewer to avoid a store subscription. */
  showGrid?: boolean;
}

/**
 * Whether the grid would draw the same. The viewport is a new object on
 * every render of the editor's canvas, so it's compared by its numbers, and
 * only when there are cell-index labels to lay out: the fill and the lines
 * don't depend on it. Without this every frame of a box-select drag made new
 * line arrays and Konva redrew the grid's whole layer each time.
 */
export function sameGrid(a: GridLayerProps, b: GridLayerProps): boolean {
  if (a.map !== b.map || a.showGrid !== b.showGrid || a.cornerOverride !== b.cornerOverride) return false;
  const grid = drawnGridLayer(a.map.layers) as LayerGrid | undefined;
  if (!grid?.displayCellIndex) return true;
  return (
    a.viewport.studXMin === b.viewport.studXMin &&
    a.viewport.studYMin === b.viewport.studYMin &&
    a.viewport.studXMax === b.viewport.studXMax &&
    a.viewport.studYMax === b.viewport.studYMax
  );
}

export const GridLayer = memo(function GridLayer({
  map,
  viewport,
  showGrid: showGridProp,
  cornerOverride,
}: GridLayerProps) {
  const showGridStore = useEditorStore((s) => s.showGrid);
  const showGrid = showGridProp ?? showGridStore;
  const studGrid = useEditorStore((s) => s.showStudGrid);
  const grid = drawnGridLayer(map.layers) as LayerGrid | undefined;
  const gridVisible = !!grid && grid.visible && showGrid;
  const background = colorSpecToCss(map.backgroundColor, '#404040');
  const pad = grid ? grid.gridSizeInStud * 2 : 64;

  return (
    <Group>
      <GridShape grid={gridVisible ? grid : undefined} background={background} studGrid={studGrid} />
      {gridVisible && grid.displayCellIndex && (
        <CellIndexLabels
          grid={cornerOverride && cornerOverride.layerId === grid.id ? { ...grid, cellIndexCorner: cornerOverride.corner } : grid}
          bounds={{
            xMin: viewport.studXMin - pad,
            yMin: viewport.studYMin - pad,
            xMax: viewport.studXMax + pad,
            yMax: viewport.studYMax + pad,
          }}
        />
      )}
    </Group>
  );
}, sameGrid);

/** Past this many lines across the screen, a grid (or sub-grid) is left out: it would be a smear. */
const MAX_LINES = 600;

/** The part of the map (scene px) a canvas shows, from the transform it's drawn with. */
function drawnBounds(ctx: CanvasRenderingContext2D): Bounds | null {
  const m = ctx.getTransform();
  if (!m.is2D || m.a * m.d - m.b * m.c === 0) return null;
  const inv = m.inverse();
  const { width, height } = ctx.canvas;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]] as const) {
    const p = inv.transformPoint({ x, y });
    xs.push(p.x);
    ys.push(p.y);
  }
  return { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) };
}

/** How many lines `step` (studs) apart would cross the screen, on the stage's own view (not a bigger picture's). */
function linesAcrossScreen(shape: Konva.Shape, step: number, drawn: Bounds): number {
  const st = shape.getStage();
  const px = studToPx();
  const scale = st?.scaleX() ?? 0;
  if (!st || !(scale > 0)) return Math.max(drawn.xMax - drawn.xMin, drawn.yMax - drawn.yMin) / (step * px);
  return (Math.max(st.width(), st.height()) / scale) / (step * px) + 4;
}

const GridShape = memo(function GridShape({ grid, background, studGrid }: { grid: LayerGrid | undefined; background: string; studGrid: boolean }) {
  return (
    <Shape
      name="grid-lines"
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(kctx, shape) => {
        const ctx = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
        const b = drawnBounds(ctx);
        if (!b) return;
        // A little past the edges, so nothing shows at a canvas's border.
        const edge = (b.xMax - b.xMin + b.yMax - b.yMin) * 0.01;
        const bounds = { xMin: b.xMin - edge, yMin: b.yMin - edge, xMax: b.xMax + edge, yMax: b.yMax + edge };
        ctx.fillStyle = background;
        ctx.fillRect(bounds.xMin, bounds.yMin, bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin);
        if (!grid) return;
        // The stud grid everything snaps to: faint lines a stud apart in the
        // sub-grid's color, fading in as the studs grow apart on screen.
        const st = shape.getStage();
        const fade = studGrid && (grid.displayGrid || grid.displaySubGrid) ? studGridFade((st?.scaleX() ?? 0) * studToPx()) : 0;
        if (fade > 0) {
          const m = ctx.getTransform();
          const devicePx = Math.hypot(m.a, m.b) || 1;
          ctx.save();
          ctx.globalAlpha *= 0.5 * fade;
          strokeLines(ctx, shape, 1, bounds, colorSpecToCss(grid.subGridColor), 1 / devicePx);
          ctx.restore();
          shape.setAttr('studGridDrawn', true);
        } else {
          shape.setAttr('studGridDrawn', false);
        }
        if (grid.displaySubGrid) {
          const step = grid.gridSizeInStud / Math.max(2, grid.subDivisionNumber);
          strokeLines(ctx, shape, step, bounds, colorSpecToCss(grid.subGridColor), grid.subGridThickness);
        }
        if (grid.displayGrid) {
          strokeLines(ctx, shape, grid.gridSizeInStud, bounds, colorSpecToCss(grid.gridColor), grid.gridThickness);
        }
      }}
    />
  );
});

/** The lines `stepStuds` apart over `bounds` (scene px): the verticals, then the horizontals, as one stroke each. */
function strokeLines(
  ctx: CanvasRenderingContext2D,
  shape: Konva.Shape,
  stepStuds: number,
  bounds: Bounds,
  stroke: string,
  thickness: number,
): void {
  if (!(stepStuds > 0) || !(thickness > 0)) return;
  if (linesAcrossScreen(shape, stepStuds, bounds) > MAX_LINES) return;
  const step = stepStuds * studToPx();
  // Anchored to multiples of the step, so the lines stay put on the map.
  const x0 = Math.floor(bounds.xMin / step) * step;
  const y0 = Math.floor(bounds.yMin / step) * step;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = thickness;
  ctx.beginPath();
  for (let x = x0; x <= bounds.xMax; x += step) {
    ctx.moveTo(x, bounds.yMin);
    ctx.lineTo(x, bounds.yMax);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let y = y0; y <= bounds.yMax; y += step) {
    ctx.moveTo(bounds.xMin, y);
    ctx.lineTo(bounds.xMax, y);
  }
  ctx.stroke();
}

interface Bounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

// Desktop draws grid lines at full pen color (no transparency multiplier
// applied, even when the layer has a non-100 `transparency`) — see
// MapViewPaint.cpp:84-104. The sub-step is `gridSizeInStud /
// max(subDivisionNumber, 2)` (line 77) so a single-division grid still
// yields a meaningful sub-step.

/**
 * Cell indices along the origin row and column (see gridIndex.ts), centred
 * in their cells. The font is in map units, pt * 4/3 scene px per stud
 * scale, so it grows and shrinks with the zoom like desktop's
 * (MapViewPaint.cpp:115-140).
 */
function CellIndexLabels({ grid, bounds }: { grid: LayerGrid; bounds: Bounds }) {
  const px = studToPx();
  const fontPx = Math.max(1, Math.round((grid.cellIndexFont.size || 10) * (4 / 3) * px));
  const cellPx = grid.gridSizeInStud * px;
  // Too small to read on screen (phone viewer only): grow them to a
  // readable size while they fit their cell, else leave them out.
  const shownPx = useEditorStore((s) => legibleLabelPx(fontPx, s.stageView.zoom, s.minTextPx, cellPx * 0.6));
  const labels = cellIndexLabels(
    bounds,
    grid.gridSizeInStud,
    parseCellIndexCorner(grid.cellIndexCorner),
    grid.cellIndexColumnType,
    grid.cellIndexRowType,
  );
  const style = (grid.cellIndexFont.style ?? '').toLowerCase();
  const fontStyle = `${style.includes('italic') ? 'italic ' : ''}${style.includes('bold') ? 'bold' : 'normal'}`;
  if (shownPx === null) return null;
  return (
    <Group name="cell-index">
      {labels.map((l) => (
        <Text
          key={`${l.x},${l.y}`}
          x={l.x * px}
          y={l.y * px}
          width={cellPx}
          height={cellPx}
          align="center"
          verticalAlign="middle"
          text={l.text}
          fontFamily={fontStack(grid.cellIndexFont.family)}
          fontStyle={fontStyle}
          fontSize={shownPx}
          fill={colorSpecToCss(grid.cellIndexColor)}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}
