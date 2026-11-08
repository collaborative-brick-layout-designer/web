// Render LayerText cells (free text labels) — port of
// SceneBuilder::addTextLayer (rendering/SceneBuilder.cpp:377-435).
//
// Laid out by mapText.ts textCellLayout, as the desktop lays it out.
// Algorithm:
//   1. Render at a probe pixel-size, measure its bbox.
//   2. Scale the font so the bbox fits inside displayArea (accounting
//      for 90°/270° rotation that swaps W↔H).
//   3. Centre the text on displayArea.center and rotate around it.
//
// Per-layer transparency lands on the layer Group (matches desktop
// SceneBuilder.cpp:832-834).

import type { AnnoDragHandlers } from './groupDragNodes';
import { useEffect, useMemo, useState } from 'react';
import Konva from 'konva';
import { Group, Text as KonvaText } from 'react-konva';
import type { BbmMap, ColorSpec, LayerText, TextCell } from '@cld/model';
import { COLOR_DEFAULT } from './coords';
import { textKey } from '../mixedSelection';
import { fontStack } from './fontStack';
import { MAP_FONT_STACK, MAP_LINE_HEIGHT, mapFontsReady, textCellLayout, type LineWidthAt } from './mapText';
import { colorSpecToCss } from '../layerOptions';
import { useEditorStore } from '../editorStore';
import { textReadable } from '../textLegibility';
import { TEXT_GLOW } from './selectionStyle';
import { tapGuard } from '../touchGesture';
import { SHEET_FADE, SHEET_FULL_OPACITY } from './sheetFade';
import { useSheetFade } from './useSheetFade';

/** A line's width in the bundled font, as Konva measures it. */
let measureCtx: CanvasRenderingContext2D | null = null;
function measureLine(fontStyle: string): LineWidthAt {
  return (line, px) => {
    measureCtx ??= Konva.Util.createCanvasElement().getContext('2d');
    if (!measureCtx) return 0;
    measureCtx.font = `${fontStyle} normal ${px}px ${MAP_FONT_STACK}`;
    return measureCtx.measureText(line).width;
  };
}

let fontsLoaded = false;
/** True once the bundled map font has loaded (re-renders then). */
export function useMapFontsReady(): boolean {
  const [ready, setReady] = useState(fontsLoaded);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void mapFontsReady().then(() => {
      fontsLoaded = true;
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

export interface TextCellRef {
  layerId: string;
  cellIndex: number;
  cell: TextCell;
}

export function TextLayers({
  map,
  isViewer,
  onEditText,
  selectedKeys,
  onSelectText,
  drag,
}: {
  map: BbmMap;
  /** Dragging moves the text (and the rest of the selection), like BlueBrick's MoveText. */
  drag?: AnnoDragHandlers | undefined;
  isViewer?: boolean;
  onEditText?: (ref: TextCellRef) => void;
  /** Selected cells (`textKey(layerId, index)`), highlighted; part of the mixed selection. */
  selectedKeys?: ReadonlySet<string>;
  /** Click selects; `additive` = Shift/Ctrl held (toggle). */
  onSelectText?: (key: string, additive: boolean) => void;
}) {
  const fade = useSheetFade(isViewer);
  const layers = map.layers.filter((l): l is LayerText => l.type === 'text' && l.visible);
  if (layers.length === 0) return null;
  return (
    <Group>
      {layers.map((layer) => {
        const opacity = Math.max(0, Math.min(100, layer.transparency)) / 100;
        return (
          <Group key={layer.id} name={SHEET_FADE} opacity={opacity * fade(layer.id)} {...{ [SHEET_FULL_OPACITY]: opacity }}>
            {layer.textCells.map((cell, i) => (
              <FittedTextCell
                key={i}
                cellKey={textKey(layer.id, i)}
                cell={cell}
                interactive={!isViewer && !!onEditText}
                isSelected={!!selectedKeys && selectedKeys.has(textKey(layer.id, i))}
                onDblClick={() => onEditText?.({ layerId: layer.id, cellIndex: i, cell })}
                onClick={(additive) => onSelectText?.(textKey(layer.id, i), additive)}
                drag={!isViewer && onEditText ? drag : undefined}
              />
            ))}
          </Group>
        );
      })}
    </Group>
  );
}

function FittedTextCell({
  cellKey,
  cell,
  interactive,
  isSelected,
  onDblClick,
  onClick,
  drag,
}: {
  drag?: AnnoDragHandlers | undefined;
  /** Its key in the selection (textKey), also the node's id, for touch hit tests. */
  cellKey: string;
  cell: TextCell;
  interactive?: boolean;
  isSelected?: boolean;
  onDblClick?: () => void;
  onClick?: (additive: boolean) => void;
}) {
  const style = (cell.font.style ?? '').toLowerCase();
  const isBold = style.includes('bold');
  const isItalic = style.includes('italic');
  const fontStyle = isBold && isItalic ? 'bold italic' : isBold ? 'bold' : isItalic ? 'italic' : 'normal';
  // Laid out as the desktop lays it out (mapText.ts), again once the
  // bundled font has loaded.
  const fontsReady = useMapFontsReady();
  const layout = useMemo(
    () => textCellLayout(cell, measureLine(fontStyle)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cell.text, cell.displayArea.x, cell.displayArea.y, cell.displayArea.width, cell.displayArea.height, cell.orientation, cell.textAlignment, fontStyle, fontsReady],
  );

  // Centre the text on displayArea centre, rotated in place. Konva
  // rotates around (x, y); offsetX/Y shift the local bbox so its centre
  // lands on (x, y).
  // Too small to read on screen (phone viewer only): leave it out.
  const readable = useEditorStore((st) => textReadable(layout.fontPx, st.stageView.zoom, st.minTextPx));


  return (
    <KonvaText
      id={cellKey}
      name={`text-cell text-${cellKey}`}
      x={layout.centre.x}
      y={layout.centre.y}
      text={layout.lines.map((l) => l.text).join('\n')}
      width={layout.width}
      wrap="none"
      align={(cell.textAlignment ?? '').toLowerCase() === 'near' ? 'left' : (cell.textAlignment ?? '').toLowerCase() === 'far' ? 'right' : 'center'}
      lineHeight={MAP_LINE_HEIGHT}
      fontFamily={fontStack(cell.font.family)}
      fontStyle={fontStyle}
      fontSize={layout.fontPx}
      fill={cssColor(cell.fontColor)}
      offsetX={layout.width / 2}
      offsetY={layout.height / 2}
      rotation={layout.rotation}
      visible={readable}
      listening={interactive ?? false}
      perfectDrawEnabled={false}
      hitStrokeWidth={0}
      {...(interactive && onDblClick ? { onDblClick, cursor: 'pointer' } : {})}
      {...(interactive && onClick
        ? {
            onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
              if (e.evt.button !== 0) return;
              e.cancelBubble = true;
              onClick(e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
            },
            // A finger's tap picks it ("Select more" adds); not after a pan or long press.
            onTap: (e: Konva.KonvaEventObject<TouchEvent>) => {
              if (tapGuard.suppress) return;
              e.cancelBubble = true;
              onClick(useEditorStore.getState().touchSelectMore);
            },
          }
        : {})}
      {...(interactive && drag
        ? {
            draggable: true,
            onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => drag.start('texts', cellKey, e.target),
            onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => drag.move(e.target, e.evt),
            onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => drag.end(e.target),
          }
        : {})}
      {...(isSelected ? TEXT_GLOW : {})}
    />
  );
}

function cssColor(c: ColorSpec): string {
  return colorSpecToCss(c, COLOR_DEFAULT);
}
