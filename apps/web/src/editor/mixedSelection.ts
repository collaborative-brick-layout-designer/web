import { MAP_FONT_STACK } from './render/mapText';
// Mixed selection — bricks together with rulers, anchored labels and
// text cells, like the desktop's Qt scene selection.
//
// Desktop reference:
//   - rubber band / Ctrl+click select any selectable scene item
//     (bricks, ruler pieces, text cells, labels — SceneBuilder.cpp:236,
//     441, 607-644, SceneBuilderSidecar.cpp:113-212)
//   - a drag moves every selected brick, ruler and label, committed as
//     one undo macro (MapViewDrag.cpp:124-153 captureDragStart,
//     412-450 commitDragIfMoved)
//   - arrow nudge moves bricks, rulers and labels (MapView.cpp:985-1041)
//   - Delete removes every selected item (MapView.cpp:2108-2179)
// Text cells are selectable but not movable on desktop (SceneBuilder.cpp:441
// sets ItemIsSelectable only), so drag and nudge leave them in place.
//
// Pure helpers are exported for tests; the two mutations wrap every change
// in ONE LOCAL_ORIGIN transaction so the whole operation is one undo step.

import * as Y from 'yjs';
import type { BbmMap, Brick, RectangleF } from '@cld/model';
import type { AnchoredLabel, SidecarModule } from '@cld/bbm';
import { DRAWN_LIMITS } from '@cld/ydoc';
import type { AnnoSelection } from './editorStore';
import { polygonIntersectsMarquee, rotatedRectCorners, type Marquee, type Pt } from './render/marqueeMath';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import {
  bricksByLayer,
  deleteAnchoredLabel,
  deleteBricksAcrossLayers,
  deleteRulerItem,
  deleteTextCell,
  moveAnchoredLabel,
  moveRulerItem,
  moveTextCell,
  translateBricksAcrossLayers,
} from './mutations';
import { pivotOf } from './brickGeometry';
import type { PartWire } from '../api';

// ---------------------------------------------------------------------------
// Keys and set helpers
// ---------------------------------------------------------------------------

/** Text cells have no id; they are addressed by layer + index. */
export function textKey(layerId: string, cellIndex: number): string {
  return `${layerId}#${cellIndex}`;
}

export function parseTextKey(key: string): { layerId: string; cellIndex: number } | null {
  const at = key.lastIndexOf('#');
  if (at <= 0) return null;
  const cellIndex = Number(key.slice(at + 1));
  if (!Number.isInteger(cellIndex) || cellIndex < 0) return null;
  return { layerId: key.slice(0, at), cellIndex };
}

export function annoCount(a: AnnoSelection): number {
  return a.rulers.length + a.labels.length + a.texts.length;
}

/** Add `id` to `list`, or remove it when present (Shift/Ctrl+click). */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function union(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const id of b) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

export function mergeAnno(a: AnnoSelection, b: AnnoSelection): AnnoSelection {
  return {
    rulers: union(a.rulers, b.rulers),
    labels: union(a.labels, b.labels),
    texts: union(a.texts, b.texts),
  };
}

/**
 * Click on an annotation: plain click selects just it (bricks cleared);
 * Shift/Ctrl toggles it and keeps everything else, as Qt does.
 */
export function clickAnno(
  bricks: readonly string[],
  anno: AnnoSelection,
  kind: keyof AnnoSelection,
  id: string,
  additive: boolean,
): { bricks: string[]; anno: AnnoSelection } {
  if (!additive) {
    return { bricks: [], anno: { rulers: [], labels: [], texts: [], [kind]: [id] } };
  }
  return { bricks: [...bricks], anno: { ...anno, [kind]: toggleId(anno[kind], id) } };
}

// ---------------------------------------------------------------------------
// Label geometry (shared with render/AnchoredLabels.tsx)
// ---------------------------------------------------------------------------

export interface LabelIndex {
  brickById: Map<string, Brick>;
  bricksByGroup: Map<string, Brick[]>;
  bricksByModule: Map<string, Brick[]>;
  /** A brick's pivot (sprite centre); absent = its displayArea centre. */
  pivot?: (b: Brick) => { x: number; y: number };
}

export function buildLabelIndex(
  map: BbmMap,
  modules: readonly SidecarModule[],
  partsByKey?: ReadonlyMap<string, PartWire>,
): LabelIndex {
  const brickById = new Map<string, Brick>();
  const bricksByGroup = new Map<string, Brick[]>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      brickById.set(b.id, b);
      if (b.myGroup) {
        const arr = bricksByGroup.get(b.myGroup) ?? [];
        arr.push(b);
        bricksByGroup.set(b.myGroup, arr);
      }
    }
  }
  const bricksByModule = new Map<string, Brick[]>();
  for (const mod of modules) {
    const members: Brick[] = [];
    for (const id of mod.members) {
      const b = brickById.get(id);
      if (b) members.push(b);
    }
    if (members.length > 0) bricksByModule.set(mod.id, members);
  }
  return {
    brickById,
    bricksByGroup,
    bricksByModule,
    ...(partsByKey ? { pivot: (b: Brick) => pivotOf(b, partsByKey.get(b.partNumber.toLowerCase())) } : {}),
  };
}

/**
 * The brick a label is attached to: only Brick labels (kind 1) are
 * children of a scene item on desktop (SceneBuilderSidecar.cpp:216-224).
 * Group and Module labels — and a Brick label whose brick is gone — are
 * placed at their offset as a world position.
 */
export function labelAnchorBricks(label: AnchoredLabel, index: LabelIndex): Brick[] {
  if (label.kind !== 1) return [];
  const b = index.brickById.get(label.targetId);
  return b ? [b] : [];
}

/**
 * Anchor point in studs: the brick's sprite centre (its pivot, as desktop
 * SceneBuilder brickCentreByGuid_) for an attached Brick label, else the
 * origin (the offset is then the label's world position).
 */
export function labelAnchorStuds(label: AnchoredLabel, index: LabelIndex): { x: number; y: number } {
  const b = labelAnchorBricks(label, index)[0];
  if (!b) return { x: 0, y: 0 };
  if (index.pivot) return index.pivot(b);
  return { x: b.displayArea.x + b.displayArea.width / 2, y: b.displayArea.y + b.displayArea.height / 2 };
}

/**
 * Where a label's text origin (top-left) lands, in studs, and its total
 * rotation. A Brick label is a child of the brick item, which sits at the
 * brick centre rotated by its orientation: the offset is in the brick's
 * local frame and the text rotation adds to the brick's
 * (SceneBuilderSidecar.cpp:208-221, SceneBuilder.cpp:215-216).
 */
export function labelPlacement(
  label: AnchoredLabel,
  index: LabelIndex,
): { x: number; y: number; rotation: number } {
  const b = labelAnchorBricks(label, index)[0];
  if (!b) return { x: label.offset.x, y: label.offset.y, rotation: label.rot };
  const a = labelAnchorStuds(label, index);
  const r = (b.orientation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    x: a.x + label.offset.x * c - label.offset.y * s,
    y: a.y + label.offset.x * s + label.offset.y * c,
    rotation: b.orientation + label.rot,
  };
}

/**
 * Turn a world-space move (studs) into the label offset change. For an
 * attached Brick label the offset lives in the brick's rotated frame, so
 * the world delta is rotated back by the brick orientation; the label
 * then lands where it was dropped.
 */
export function labelOffsetDelta(
  label: AnchoredLabel,
  index: LabelIndex,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const b = labelAnchorBricks(label, index)[0];
  if (!b || b.orientation % 360 === 0) return { dx, dy };
  const r = (-b.orientation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { dx: dx * c - dy * s, dy: dx * s + dy * c };
}

/** Desktop's default label font (core/FontSpec.h:11-14). */
export const DEFAULT_LABEL_FONT = { family: 'Microsoft Sans Serif', size: 8.25, style: 'Regular' } as const;

/** C# FontStyle.ToString() form the sidecar carries: "Regular", "Bold", "Bold, Italic". */
export function labelFontStyle(bold: boolean, italic: boolean): string {
  return [bold && 'Bold', italic && 'Italic'].filter(Boolean).join(', ') || 'Regular';
}

/**
 * Scene-unit (world px at zoom 1, 8 px per stud) height of a label font.
 * Desktop builds `QFont(family, int(sizePt))` — the point size truncated
 * to an integer — and Qt lays points out at 96 logical DPI, so one point
 * is 96/72 scene px (SceneBuilderSidecar.cpp). The size is first brought
 * into range as the desktop does when it reads a label (1 to 500 pt; not a
 * number, 8.25 pt: DRAWN_LIMITS.fontSize): any writer may store any number
 * there, and a huge one would draw a label without end. What is stored is
 * left as it is.
 */
export function labelFontPx(sizePt: number): number {
  const r = DRAWN_LIMITS.fontSize;
  const size = typeof sizePt === 'number' && Number.isFinite(sizePt) ? Math.min(r.max, Math.max(r.min, sizePt)) : r.fallback;
  return (Math.trunc(size) * 96) / 72;
}

/**
 * CSS font stack for a label family. "Microsoft Sans Serif" (the .NET
 * default the files carry) is missing off Windows, so fall back to its
 * closest metric matches.
 */
export function labelFontFamily(_family: string): string {
  // The bundled map font, whatever the label names (render/mapText.ts).
  return MAP_FONT_STACK;
}

/**
 * Approximate text outline of a label in studs (four rotated corners), for
 * marquee hit-testing. Width is estimated at 0.6 em per character of the
 * longest line since text metrics need a canvas.
 */
export function labelShapeStuds(label: AnchoredLabel, index: LabelIndex): Pt[] {
  const p = labelPlacement(label, index);
  const hPx = labelFontPx(label.font.size);
  const lines = label.text.split('\n');
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const wPx = longest * hPx * 0.6;
  return rotatedRectCorners({ x: p.x, y: p.y }, wPx / 8, (hPx * lines.length) / 8, p.rotation);
}

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

function overlaps(m: Marquee, r: RectangleF): boolean {
  const x0 = Math.min(m.x0, m.x1);
  const y0 = Math.min(m.y0, m.y1);
  const x1 = Math.max(m.x0, m.x1);
  const y1 = Math.max(m.y0, m.y1);
  return r.x + r.width >= x0 && r.x <= x1 && r.y + r.height >= y0 && r.y <= y1;
}

/**
 * Rulers, labels and text cells the rubber band touches, on visible
 * layers only (same AABB-overlap rule as `bricksInMarquee`). Labels
 * hidden by their `minZoom` at `zoom` are skipped, as they aren't drawn.
 */
export function annotationsInMarquee(
  marquee: Marquee,
  map: BbmMap,
  labels: readonly AnchoredLabel[],
  modules: readonly SidecarModule[],
  zoom: number,
  partsByKey?: ReadonlyMap<string, PartWire>,
): AnnoSelection {
  const rulers: string[] = [];
  const texts: string[] = [];
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    if (layer.type === 'ruler') {
      for (const r of layer.rulerItems) if (overlaps(marquee, r.displayArea)) rulers.push(r.id);
    } else if (layer.type === 'text') {
      layer.textCells.forEach((c, i) => {
        if (overlaps(marquee, c.displayArea)) texts.push(textKey(layer.id, i));
      });
    }
  }
  const out: string[] = [];
  if (labels.length > 0) {
    const index = buildLabelIndex(map, modules, partsByKey);
    for (const l of labels) {
      if (l.minZoom > 0 && zoom < l.minZoom) continue;
      if (polygonIntersectsMarquee(labelShapeStuds(l, index), marquee)) out.push(l.id);
    }
  }
  return { rulers, labels: out, texts };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Layer holding each ruler id. */
function rulerLayers(map: BbmMap, ids: readonly string[]): Map<string, string> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  for (const layer of map.layers) {
    if (layer.type !== 'ruler') continue;
    for (const r of layer.rulerItems) if (want.has(r.id)) out.set(r.id, layer.id);
  }
  return out;
}

/**
 * Labels whose anchor moves with the bricks already follow them, so
 * shifting their offset too would move them twice. A label is skipped
 * when every brick it is anchored to is in `movingBricks`.
 */
export function labelsToOffset(
  labelIds: readonly string[],
  labels: readonly AnchoredLabel[],
  index: LabelIndex,
  movingBricks: ReadonlySet<string>,
): string[] {
  const want = new Set(labelIds);
  const out: string[] = [];
  for (const l of labels) {
    if (!want.has(l.id)) continue;
    const anchors = labelAnchorBricks(l, index);
    if (anchors.length > 0 && anchors.every((b) => movingBricks.has(b.id))) continue;
    out.push(l.id);
  }
  return out;
}

export interface MixedMove {
  bricks: readonly string[];
  anno: AnnoSelection;
  /** Delta for rulers and labels, in studs. */
  dx: number;
  dy: number;
  /** Delta for bricks when it differs (grid snap applied to bricks only). */
  brickDx?: number;
  brickDy?: number;
  /**
   * Bricks the caller moves itself in the same transaction (a single-brick
   * drag commits its own snapped pose). Only used so labels anchored to
   * them are not shifted twice.
   */
  movedBricks?: readonly string[];
}

/**
 * Translate bricks, rulers and labels in one undo step — port of the
 * desktop "Drag" / "Move selection" macros (MapViewDrag.cpp:412-450,
 * MapView.cpp:1033-1041). Text cells stay put.
 */
export function translateMixedSelection(
  doc: Y.Doc,
  map: BbmMap,
  labels: readonly AnchoredLabel[],
  modules: readonly SidecarModule[],
  move: MixedMove,
): void {
  const bdx = move.brickDx ?? move.dx;
  const bdy = move.brickDy ?? move.dy;
  doc.transact(() => {
    if (move.bricks.length > 0) translateBricksAcrossLayers(doc, bricksByLayer(map, move.bricks), bdx, bdy);
    if (move.dx === 0 && move.dy === 0) return;
    for (const [id, layerId] of rulerLayers(map, move.anno.rulers)) {
      moveRulerItem(doc, layerId, id, move.dx, move.dy);
    }
    for (const key of move.anno.texts) {
      const c = parseTextKey(key);
      if (c) moveTextCell(doc, c.layerId, c.cellIndex, move.dx, move.dy);
    }
    if (move.anno.labels.length > 0) {
      const moving = new Set<string>(move.movedBricks ?? []);
      if (bdx !== 0 || bdy !== 0) for (const id of move.bricks) moving.add(id);
      const index = buildLabelIndex(map, modules);
      const byId = new Map(labels.map((l) => [l.id, l]));
      for (const id of labelsToOffset(move.anno.labels, labels, index, moving)) {
        const l = byId.get(id);
        const d = l ? labelOffsetDelta(l, index, move.dx, move.dy) : { dx: move.dx, dy: move.dy };
        moveAnchoredLabel(doc, id, d.dx, d.dy);
      }
    }
  }, LOCAL_ORIGIN);
}

/** Delete every selected brick, ruler, label and text cell in one undo step. */
export function deleteMixedSelection(
  doc: Y.Doc,
  map: BbmMap,
  bricks: readonly string[],
  anno: AnnoSelection,
): void {
  doc.transact(() => {
    if (bricks.length > 0) deleteBricksAcrossLayers(doc, bricksByLayer(map, bricks));
    for (const [id, layerId] of rulerLayers(map, anno.rulers)) deleteRulerItem(doc, layerId, id);
    for (const id of anno.labels) deleteAnchoredLabel(doc, id);
    // Highest index first per layer so earlier deletions don't shift later ones.
    const cells = anno.texts
      .map(parseTextKey)
      .filter((c): c is { layerId: string; cellIndex: number } => c !== null)
      .sort((a, b) => (a.layerId === b.layerId ? b.cellIndex - a.cellIndex : a.layerId < b.layerId ? -1 : 1));
    for (const c of cells) deleteTextCell(doc, c.layerId, c.cellIndex);
  }, LOCAL_ORIGIN);
}

/**
 * The picked parts that are still on the map, or null when all are: someone
 * else deleted one (live), or an undo took it away. Without this the touch
 * bar went on saying "1 picked" and offered Rotate and Duplicate for a part
 * that was gone.
 */
export function stillPicked(present: ReadonlySet<string>, selection: readonly string[]): string[] | null {
  if (selection.length === 0) return null;
  const kept = selection.filter((id) => present.has(id));
  return kept.length === selection.length ? null : kept;
}

/** Every brick id in the doc, on any sheet. */
export function brickIdsInDoc(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  doc.getMap('layerData').forEach((layer) => {
    if (!(layer instanceof Y.Map)) return;
    const bricks = layer.get('bricks');
    if (!(bricks instanceof Y.Array)) return;
    bricks.forEach((b) => {
      if (b instanceof Y.Map) ids.add(b.get('id') as string);
    });
  });
  return ids;
}
