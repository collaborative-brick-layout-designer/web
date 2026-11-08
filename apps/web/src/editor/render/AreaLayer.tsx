// Render LayerArea cells (paint-area tool output) — port of
// SceneBuilder::addAreaLayer (rendering/SceneBuilder.cpp:437-457).
//
// Each cell is a square of side `areaCellSize` studs at world-coords
// (cell.x * areaCellSize, cell.y * areaCellSize). The cell color is
// stored as `aarrggbb` UPPERCASE hex (per AreaCell.color comment in
// @cld/model). A cell is drawn in its RGB at the sheet's alpha, as
// vanilla BlueBrick does (areaCellCss).

import { Group, Rect } from 'react-konva';
import type { BbmMap, LayerArea } from '@cld/model';
import { studToPx } from './coords';
import { SHEET_FADE } from './sheetFade';
import { useSheetFade } from './useSheetFade';

/** `isViewer`: a viewer isn't editing, so the other sheets never fade. */
export function AreaLayers({ map, isViewer = false }: { map: BbmMap; isViewer?: boolean }) {
  const fade = useSheetFade(isViewer);
  const layers = map.layers.filter((l): l is LayerArea => l.type === 'area' && l.visible);
  if (layers.length === 0) return null;
  return (
    <Group>
      {layers.map((layer) => (
        <SingleAreaLayer key={layer.id} layer={layer} fade={fade(layer.id)} />
      ))}
    </Group>
  );
}

function SingleAreaLayer({ layer, fade }: { layer: LayerArea; fade: number }) {
  const sizePx = studToPx(layer.areaCellSize);
  return (
    <Group name={SHEET_FADE} opacity={fade}>
      {layer.areas.map((cell, i) => {
        const fill = areaCellCss(cell.color, layer.transparency);
        if (!fill) return null;
        return (
          <Rect
            key={i}
            x={cell.x * sizePx}
            y={cell.y * sizePx}
            width={sizePx}
            height={sizePx}
            fill={fill}
            listening={false}
            perfectDrawEnabled={false}
            strokeEnabled={false}
          />
        );
      })}
    </Group>
  );
}

/**
 * A painted cell's color: its RGB with the sheet's alpha. Vanilla BlueBrick
 * replaces a cell's own alpha with the sheet's, (255 × transparency) / 100
 * in whole numbers (LayerArea.cs paintCell / AlphaValue); the desktop does
 * the same. render-parity/areas.json holds the cases both apps check.
 */
export function areaCellCss(hex: string, transparency: number): string | null {
  const h = hex.replace(/^#/, '');
  if (h.length !== 8 && h.length !== 6) return null;
  const rgb = h.slice(-6);
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  const alpha = Math.trunc((255 * Math.max(0, Math.min(100, transparency))) / 100);
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`;
}
