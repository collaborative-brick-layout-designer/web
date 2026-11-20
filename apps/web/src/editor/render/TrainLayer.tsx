// Trains on the map (trains design 3.3, 6.4): each car's body lies on the
// chord between its trucks, so on a curve it cuts the inside of the track
// as a real car does. A simple car is a rounded box in its color with a
// tick at each truck; a car shown as a part draws that part's picture.
// The head car's front gets a pointed nose, and each car its road number
// when zoomed in. The desktop draws the same (src/rendering/SceneBuilderTrains.cpp).

import { useEffect, useState } from 'react';
import { Group, Image as KonvaImage, Line, Rect, Text } from 'react-konva';
import type { PlacedTrain, RollingStock, Train } from '@cld/parts-catalog/browser';
import { spriteUrlFor, type PartWire } from '../../api';
import { ensureSprite, getSpriteSync } from './spriteCache';

const PX = 8;
/** A train partly off the end of the track is outlined in this color. */
export const TRAIN_PROBLEM_COLOR = '#DC2626';

interface Props {
  trains: readonly Train[];
  placed: ReadonlyMap<string, PlacedTrain | null>;
  stock: ReadonlyMap<string, RollingStock>;
  partsByKey: ReadonlyMap<string, PartWire>;
  zoom: number;
  /** The train picked in the Trains panel, outlined. */
  picked?: string | null;
}

/** A darker shade of a #RRGGBB color, for outlines. */
function darker(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#333333';
  const n = parseInt(m[1]!, 16);
  const f = (v: number) => Math.round(v * 0.55).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

function PartSprite({ part, x, y, angle }: { part: PartWire; x: number; y: number; angle: number }) {
  const [, force] = useState(0);
  const url = spriteUrlFor(part);
  useEffect(() => {
    let cancelled = false;
    ensureSprite(url)
      .then(() => !cancelled && force((n) => n + 1))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);
  const img = getSpriteSync(url);
  if (!img) return null;
  const w = (img.naturalWidth / part.pxPerStud) * PX;
  const h = (img.naturalHeight / part.pxPerStud) * PX;
  return <KonvaImage image={img} x={x} y={y} width={w} height={h} offsetX={w / 2} offsetY={h / 2} rotation={angle} listening={false} />;
}

export function TrainLayer({ trains, placed, stock, partsByKey, zoom, picked }: Props) {
  const showNumbers = zoom >= 0.35;
  return (
    <Group name="trains" listening={false}>
      {trains.map((t) => {
        const p = placed.get(t.id);
        if (!p || p.units.length === 0) return null;
        return (
          <Group key={t.id} name={`train-${t.id}`}>
            {p.units.map((u, i) => {
              const s = stock.get(u.stock);
              if (!s) return null;
              const reversed = t.units[i]?.reversed ?? false;
              const len = (s.bodyLength || s.length - 2) * PX;
              const wid = s.width * PX;
              const cx = u.centre.x * PX;
              const cy = u.centre.y * PX;
              const color = s.look.color || t.color;
              const part = s.look.mode !== 'simple' && s.look.partKey ? partsByKey.get(s.look.partKey) : undefined;
              const outline = p.offTrack ? TRAIN_PROBLEM_COLOR : picked === t.id ? '#1D4ED8' : darker(color);
              const outlineW = p.offTrack || picked === t.id ? Math.max(0.5 * PX, 3 / zoom) : Math.max(0.25 * PX, 1 / zoom);
              const head = i === 0;
              return (
                <Group key={i} name="train-unit" x={cx} y={cy} rotation={u.angle}>
                  {part ? (
                    <PartSprite part={part} x={0} y={0} angle={reversed ? 180 : 0} />
                  ) : (
                    <Rect x={-len / 2} y={-wid / 2} width={len} height={wid} cornerRadius={Math.min(wid / 3, PX)} fill={color} perfectDrawEnabled={false} />
                  )}
                  <Rect
                    name="train-outline"
                    x={-len / 2}
                    y={-wid / 2}
                    width={len}
                    height={wid}
                    cornerRadius={Math.min(wid / 3, PX)}
                    stroke={outline}
                    strokeWidth={outlineW}
                    perfectDrawEnabled={false}
                  />
                  {!part &&
                    s.trucks.map((tr, k) => {
                      const at = (reversed ? -tr.at : tr.at) * PX;
                      return <Line key={k} name="train-truck" points={[at, -wid / 2 - PX * 0.4, at, wid / 2 + PX * 0.4]} stroke="#1F2937" strokeWidth={PX * 0.6} lineCap="round" perfectDrawEnabled={false} />;
                    })}
                  {head && (
                    <Line
                      name="train-nose"
                      points={[len / 2 - wid * 0.35, -wid / 2, len / 2 + wid * 0.25, 0, len / 2 - wid * 0.35, wid / 2]}
                      closed
                      fill={outline}
                      opacity={0.9}
                      perfectDrawEnabled={false}
                    />
                  )}
                  {showNumbers && s.number && (
                    // Upright whichever way the car runs.
                    <Group rotation={Math.cos((u.angle * Math.PI) / 180) < -0.01 ? 180 : 0}>
                    <Text
                      text={s.number}
                      x={-len / 2}
                      y={-wid / 2}
                      width={len}
                      height={wid}
                      align="center"
                      verticalAlign="middle"
                      fontSize={Math.min(wid * 0.6, 4 * PX)}
                      fontStyle="bold"
                      fill="#FFFFFF"
                      stroke="#000000"
                      strokeWidth={0.6}
                      perfectDrawEnabled={false}
                    />
                    </Group>
                  )}
                </Group>
              );
            })}
          </Group>
        );
      })}
    </Group>
  );
}
