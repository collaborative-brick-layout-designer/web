// Render `.bbm.cld` sidecar venue (outline edges + obstacles + labels)
// — port of SceneBuilder::addVenue (rendering/SceneBuilderSidecar.cpp:46-193).
//
// Each edge is a polyline with a kind (Wall/Door/Open), drawn with the
// pen the desktop uses:
//   - Wall: solid 7px dark grey
//   - Door: dashed 5px green
//   - Open: dotted 4px blue
// Obstacles render as semi-transparent grey hashed polygons.
//
// Venue model v2 parts (references/VENUE-MODEL.md, "Drawing"; geometry in
// venueDraw.ts, mirrored by the desktop's rendering/VenueDraw.cpp):
// obstacles styled by kind (stairs with treads and a way-up arrow,
// elevators crossed), power points, notes and measurements; estimated
// edges, notes and measurements are drawn faded and marked "(est.)".
//
// This stays a passive overlay until the venue editing tools land
// (drawing, dimensions dialog). The data round-trips through the
// sidecar regardless.

import { Circle, Group, Line, Rect, Text } from 'react-konva';
import { venueLengthUnit, type Venue, type VenueDimension, type VenueNote, type VenueObstacle as VenueObstacleT, type VenuePower } from '@cld/bbm';
import { studToPx } from './coords';
import {
  DIMENSION_COLOR,
  dimensionGeometry,
  elevatorCross,
  ESTIMATE_COLOR,
  estimatedText,
  obstacleStyle,
  onDarkCanvas,
  POWER_COLOR,
  POWER_RADIUS_STUDS,
  powerText,
  stairMarks,
  type Seg,
} from './venueDraw';
import { VENUE_LABEL, VENUE_LABEL_THEME, venueEdgeLabels, type VenueLabel, type VenueLabelOptions } from './venueLabels';
import type { LengthUnit } from '../../venues/designer/units';
import { measureBold } from './ModuleOverlay';
import { MAP_FONT_STACK } from './mapText';
import { useDarkTheme } from './useDarkTheme';

/** How a venue color is drawn: as is, or for a dark canvas (onDarkCanvas). */
type Ink = (color: string) => string;
const asIs: Ink = (c) => c;

interface Props {
  venue: Venue | null | undefined;
  /** Font size for edge distance labels in px. Default 28 (matches desktop). */
  labelFontPx?: number;
  onDoubleClick?: () => void;
  /** The Venue Designer: the selected wall, its handles (studs, half size in px) and the pointer (px). */
  selectedEdge?: number | null;
  handles?: readonly Pt[];
  handleHalfPx?: number;
  pointer?: Pt | null;
  /** Drawn on a dark canvas (the Venue Designer in the dark theme): dark colors drawn light. */
  darkCanvas?: boolean;
  /** The unit the wall lengths are shown in; the venue's own (its Venue Designer Units pick) when not given. */
  unit?: LengthUnit;
}

type Pt = { x: number; y: number };

export function VenueOverlay({ venue, labelFontPx = 28, onDoubleClick, selectedEdge = null, handles = [], handleHalfPx = 0, pointer = null, darkCanvas = false, unit }: Props) {
  if (!venue || !venue.enabled) return null;
  const ink = darkCanvas ? onDarkCanvas : asIs;
  const groupProps = onDoubleClick ? { listening: true, onDblClick: onDoubleClick } : { listening: false };
  const labels = { selectedEdge, handles, handleHalfPx, pointer, unit: unit ?? venueLengthUnit(venue) };
  return (
    <Group {...groupProps}>
      {venue.edges.map((edge, i) => (
        <VenueEdge key={`edge-${i}`} edge={edge} minWalkwayStuds={venue.minWalkwayStuds} ink={ink} />
      ))}
      {venue.obstacles.map((ob, i) => (
        <VenueObstacle key={`ob-${i}`} obstacle={ob} ink={ink} />
      ))}
      {(venue.dimensions ?? []).map((d, i) => (
        <VenueDimensionMark key={`dim-${i}`} dimension={d} fontPx={labelFontPx * 0.8} ink={ink} />
      ))}
      {(venue.power ?? []).map((p, i) => (
        <VenuePowerMark key={`pow-${i}`} power={p} fontPx={labelFontPx * 0.6} ink={ink} />
      ))}
      {(venue.notes ?? []).map((n, i) => (
        <VenueNoteMark key={`note-${i}`} note={n} fontPx={labelFontPx * 0.8} ink={ink} />
      ))}
      <VenueEdgeLabels venue={venue} fontPx={labelFontPx} labels={labels} />
    </Group>
  );
}

/** The walls' labels: pills just outside the room (venueLabels.ts). */
function VenueEdgeLabels({ venue, fontPx, labels }: { venue: Venue; fontPx: number; labels: Omit<VenueLabelOptions, 'fontPx' | 'measure'> & { pointer?: Pt | null } }) {
  const dark = useDarkTheme();
  const theme = dark ? VENUE_LABEL_THEME.dark : VENUE_LABEL_THEME.light;
  const laid = venueEdgeLabels(venue.edges, { fontPx, measure: measureLabel, ...labels });
  return (
    <Group listening={false} name="venue-labels">
      {laid.map((l) => {
        // The pointer on a shortened label shows it whole.
        const p = labels.pointer;
        const hover = !!p && l.shortened && insidePill(l, p);
        const text = hover ? l.full : l.text;
        const width = hover ? measureLabel(l.full, fontPx) + 2 * VENUE_LABEL.padX * fontPx : l.width;
        return (
          <Group key={l.edge} x={l.x} y={l.y} rotation={l.angle} name="venue-label">
            <Rect
              x={-width / 2}
              y={-l.height / 2}
              width={width}
              height={l.height}
              cornerRadius={VENUE_LABEL.radius * fontPx}
              fill={theme.fill}
              stroke={theme.border}
              strokeWidth={1}
              strokeScaleEnabled={false}
              perfectDrawEnabled={false}
            />
            <Text
              x={-width / 2}
              y={-fontPx / 2}
              width={width}
              align="center"
              text={text}
              fontSize={fontPx}
              fontFamily={MAP_FONT_STACK}
              fontStyle="bold"
              fill={theme.text}
              perfectDrawEnabled={false}
            />
          </Group>
        );
      })}
    </Group>
  );
}

function insidePill(l: VenueLabel, p: Pt): boolean {
  const t = (-l.angle * Math.PI) / 180;
  const dx = p.x - l.x, dy = p.y - l.y;
  const u = dx * Math.cos(t) - dy * Math.sin(t);
  const v = dx * Math.sin(t) + dy * Math.cos(t);
  return Math.abs(u) <= l.width / 2 && Math.abs(v) <= l.height / 2;
}

function measureLabel(text: string, fontPx: number): number {
  try {
    return measureBold(text)(fontPx);
  } catch {
    // No canvas to measure on (tests): about 0.6 em a letter.
    return text.length * 0.6 * fontPx;
  }
}


function VenueEdge({
  edge,
  minWalkwayStuds,
  ink,
}: {
  edge: Venue['edges'][number];
  minWalkwayStuds: number;
  ink: Ink;
}) {
  if (!edge.poly || edge.poly.length < 2) return null;
  const px = studToPx();
  const flatPoints: number[] = [];
  for (const p of edge.poly) {
    flatPoints.push(p.x * px, p.y * px);
  }

  // Pen per kind — desktop uses cosmetic pens (zoom-invariant width);
  // we use Konva `strokeScaleEnabled={false}` for the same effect.
  let stroke = 'rgb(30,30,30)';
  let strokeWidth = 7;
  let dash: number[] | undefined;
  if (edge.kind === 1 /* Door */) {
    stroke = 'rgb(0,160,0)';
    strokeWidth = 5;
    dash = [12, 8];
  } else if (edge.kind === 2 /* Open */) {
    stroke = 'rgb(0,0,200)';
    strokeWidth = 4;
    dash = [3, 6];
  }

  // Walkway buffer for non-Wall edges — translucent orange band on the
  // INSIDE (left-hand normal) of every segment.
  const showWalk = edge.kind !== 0 && minWalkwayStuds > 0;

  return (
    <Group>
      {showWalk && <WalkwayBand poly={edge.poly} widthStuds={minWalkwayStuds} />}
      <Line
        points={flatPoints}
        stroke={ink(stroke)}
        strokeWidth={strokeWidth}
        strokeScaleEnabled={false}
        {...(dash ? { dash } : {})}
        {...(edge.estimated ? { opacity: 0.45 } : {})}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Group>
  );
}

function WalkwayBand({
  poly,
  widthStuds,
}: {
  poly: { x: number; y: number }[];
  widthStuds: number;
}) {
  const px = studToPx();
  // Each segment becomes a quad on the LEFT-hand normal side (matches
  // SceneBuilderSidecar.cpp:67-73 which uses the left-hand normal as
  // "inside" by polygon convention).
  const quads: number[][] = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const off = widthStuds;
    const aIn = { x: a.x + nx * off, y: a.y + ny * off };
    const bIn = { x: b.x + nx * off, y: b.y + ny * off };
    quads.push([
      a.x * px,
      a.y * px,
      b.x * px,
      b.y * px,
      bIn.x * px,
      bIn.y * px,
      aIn.x * px,
      aIn.y * px,
    ]);
  }
  return (
    <Group listening={false}>
      {quads.map((q, i) => (
        <Line
          key={i}
          points={q}
          closed
          fill="rgba(255, 170, 0, 0.25)"
          stroke="rgba(255, 170, 0, 0.4)"
          strokeWidth={1}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}

function Segs({ segs, stroke, width = 1, dash }: { segs: Seg[]; stroke: string; width?: number; dash?: number[] }) {
  const px = studToPx();
  return (
    <>
      {segs.map((s, i) => (
        <Line
          key={i}
          points={s.map((v) => v * px)}
          stroke={stroke}
          strokeWidth={width}
          strokeScaleEnabled={false}
          {...(dash ? { dash } : {})}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
    </>
  );
}

function VenueObstacle({ obstacle, ink }: { obstacle: VenueObstacleT; ink: Ink }) {
  if (!obstacle.poly || obstacle.poly.length < 3) return null;
  const px = studToPx();
  const flat: number[] = [];
  for (const p of obstacle.poly) flat.push(p.x * px, p.y * px);
  const base = obstacleStyle(obstacle.kind);
  const style = { ...base, stroke: ink(base.stroke), fill: base.fill && ink(base.fill) };
  const stairs = obstacle.kind === 'stairs' ? stairMarks(obstacle) : null;
  return (
    <Group listening={false}>
      <Line
        points={flat}
        closed
        {...(style.fill ? { fill: style.fill } : {})}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeScaleEnabled={false}
        listening={false}
        perfectDrawEnabled={false}
      />
      {stairs && <Segs segs={stairs.treads} stroke={style.stroke} />}
      {stairs && <Segs segs={stairs.arrow} stroke={ink('rgb(30,30,30)')} width={2} />}
      {obstacle.kind === 'elevator' && <Segs segs={elevatorCross(obstacle.poly)} stroke={style.stroke} />}
    </Group>
  );
}

function VenuePowerMark({ power, fontPx, ink }: { power: VenuePower; fontPx: number; ink: Ink }) {
  const px = studToPx();
  const r = POWER_RADIUS_STUDS * px;
  const text = powerText(power);
  return (
    <Group listening={false}>
      <Circle
        x={power.x * px}
        y={power.y * px}
        radius={r}
        fill={power.kind === 'floor' ? ink(POWER_COLOR) : 'white'}
        stroke={ink(POWER_COLOR)}
        strokeWidth={2}
        strokeScaleEnabled={false}
        listening={false}
        perfectDrawEnabled={false}
      />
      {text && (
        <Text
          x={power.x * px + r * 1.4}
          y={power.y * px - fontPx / 2}
          text={text}
          fontSize={fontPx}
          fontFamily="sans-serif"
          fill={ink(POWER_COLOR)}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  );
}

function VenueNoteMark({ note, fontPx, ink }: { note: VenueNote; fontPx: number; ink: Ink }) {
  const px = studToPx();
  return (
    <Text
      x={note.x * px}
      y={note.y * px}
      text={note.estimated ? estimatedText(note.text) : note.text}
      fontSize={fontPx}
      fontFamily="sans-serif"
      fontStyle={note.estimated ? 'italic' : 'normal'}
      fill={ink(note.estimated ? ESTIMATE_COLOR : 'rgb(30,30,30)')}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}

function VenueDimensionMark({ dimension, fontPx, ink }: { dimension: VenueDimension; fontPx: number; ink: Ink }) {
  const g = dimensionGeometry(dimension);
  if (!g) return null;
  const px = studToPx();
  const color = ink(dimension.estimated ? ESTIMATE_COLOR : DIMENSION_COLOR);
  const dash = dimension.estimated ? [8, 6] : undefined;
  const label = dimension.label ?? '';
  return (
    <Group listening={false}>
      <Segs segs={[g.line]} stroke={color} width={1.5} {...(dash ? { dash } : {})} />
      <Segs segs={g.ticks} stroke={color} width={1.5} />
      {label && (
        <Text
          x={g.label.x * px}
          y={g.label.y * px}
          text={dimension.estimated ? estimatedText(label) : label}
          fontSize={fontPx}
          fontFamily="sans-serif"
          fill={color}
          rotation={g.angleDeg}
          width={2000}
          align="center"
          offsetX={1000}
          offsetY={fontPx / 2}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  );
}
