// All Yjs doc mutations the editor performs. Pulled out of the React tree
// so the rules (origin-tagging, transaction granularity, brick lookup) can
// be unit-tested directly against a Y.Doc.
//
// Every mutation wraps in `doc.transact(fn, LOCAL_ORIGIN)` so that
// Y.UndoManager configured with `trackedOrigins: new Set([LOCAL_ORIGIN])`
// only walks back transactions originating in this client. Phase 4 will
// distinguish "this user's edits" from "other users' edits" using the
// y-websocket clientID; for Phase 3 single-user, LOCAL_ORIGIN is enough.

import { readSidecarCache as readMergedSidecar, writeSidecarCache as writeMergedSidecar } from '@cld/ydoc';
import * as Y from 'yjs';
import type { ColorSpec, FontSpec, Group, Layer, RectangleF } from '@cld/model';
import type { AnchoredLabel, BackgroundImage, SavedView, SidecarModule } from '@cld/bbm';
import {
  DOC_BASE_SCHEMA,
  cellOffsetOf,
  itemsInOrder,
  makeId,
  markShapeInPlace,
  pushOnTop,
  reorderByZ,
  rulerJson,
  rulersInPlace,
  setItemFields,
  toItemMap,
} from '@cld/ydoc';
import { moduleCopy } from './moduleCopy';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { imageOffset } from '@cld/parts-catalog/browser';
import { areaForPivot, connectionWorld, pivotOf, rotateAroundPivots, rotated, type PartGeom } from './brickGeometry';
import { connectedTurn, type TurnBrick } from './rotateTurn';
import { cloneGroups, topGroupId, type ExpandedSet, type SetModule } from './sets';
import { findPartsSheet, type SheetChoices } from './moduleSheets';

export interface BrickInsertSpec {
  partNumber: string;
  /** World position in studs (top-left of displayArea). */
  x: number;
  y: number;
  width: number;
  height: number;
  orientation?: number;
  altitude?: number;
  activeConnectionPointIndex?: number;
}

// Fresh decimal-numeric ids (bricks, layers, groups, text cells, ...).
// Lives in @cld/ydoc so the server's .bbm seeding mints the same shape.
export { makeId };

export function placeBrick(
  doc: Y.Doc,
  layerId: string,
  spec: BrickInsertSpec,
): string {
  const id = makeId();
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const bricks = layerData.get('bricks');
    if (!(bricks instanceof Y.Array)) return;

    const yBrick = new Y.Map<unknown>();
    yBrick.set('id', id);
    yBrick.set('displayArea', {
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
    } satisfies RectangleF);
    yBrick.set('myGroup', '');
    yBrick.set('partNumber', spec.partNumber);
    yBrick.set('orientation', spec.orientation ?? 0);
    yBrick.set('activeConnectionPointIndex', spec.activeConnectionPointIndex ?? 0);
    yBrick.set('altitude', spec.altitude ?? 0);
    yBrick.set('connexions', []);
    pushOnTop(bricks, [yBrick]);
  }, LOCAL_ORIGIN);
  return id;
}

export function deleteBricks(doc: Y.Doc, layerId: string, brickIds: string[]): void {
  if (brickIds.length === 0) return;
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const bricks = layerData.get('bricks');
    if (!(bricks instanceof Y.Array)) return;

    const idSet = new Set(brickIds);
    // Walk in reverse so deletions don't shift indices we still need.
    for (let i = bricks.length - 1; i >= 0; i--) {
      const b = bricks.get(i);
      if (b instanceof Y.Map && idSet.has(b.get('id') as string)) {
        bricks.delete(i, 1);
      }
    }
    pruneModuleMembers(doc, idSet);
  }, LOCAL_ORIGIN);
}

/**
 * Drop deleted brick ids from every sidecar module, and remove modules
 * left with no members — desktop `DeleteBricksCommand::redo`
 * (EditCommands.cpp:82-120). Writes the cache only when something changed.
 * Call inside a transaction.
 */
function pruneModuleMembers(doc: Y.Doc, deleted: Set<string>): void {
  const cache = readSidecarCache(doc);
  const modules = getSidecarModules(cache);
  if (modules.length === 0) return;
  let changed = false;
  const next: SidecarModule[] = [];
  for (const m of modules) {
    const members = m.members.filter((id) => !deleted.has(id));
    if (members.length === m.members.length) {
      next.push(m);
      continue;
    }
    changed = true;
    if (members.length > 0) next.push({ ...m, members });
  }
  if (changed) writeSidecarCache(doc, { ...cache, modules: next });
}

/**
 * Move a brick so its pivot (sprite centre, `pivotOf`) is at
 * (`pivotX`, `pivotY`). Without `part` the pivot is the displayArea centre.
 */
export function moveBrick(
  doc: Y.Doc,
  layerId: string,
  brickId: string,
  pivotX: number,
  pivotY: number,
  part?: PartGeom,
): void {
  doc.transact(() => {
    const yBrick = findBrick(doc, layerId, brickId);
    if (!yBrick) return;
    const area = yBrick.get('displayArea') as RectangleF;
    const off = part ? imageOffset(part, (yBrick.get('orientation') as number) ?? 0) : { x: 0, y: 0 };
    yBrick.set('displayArea', {
      ...area,
      x: pivotX - off.x - area.width / 2,
      y: pivotY - off.y - area.height / 2,
    });
  }, LOCAL_ORIGIN);
}

/**
 * Move a brick and set its orientation in one transaction — used when a
 * connection-snap fires on drag-end so position + rotation are one undo step.
 */
export function moveBrickAndOrient(
  doc: Y.Doc,
  layerId: string,
  brickId: string,
  pivotX: number,
  pivotY: number,
  newOrientation: number,
  part?: PartGeom,
): void {
  doc.transact(() => {
    const yBrick = findBrick(doc, layerId, brickId);
    if (!yBrick) return;
    const area = yBrick.get('displayArea') as RectangleF;
    const orientation = mod360(newOrientation);
    // The box follows the turned footprint (BrickPlacement placeByImageCentre).
    yBrick.set('displayArea', areaForPivot(part, orientation, { x: pivotX, y: pivotY }, area));
    yBrick.set('orientation', orientation);
  }, LOCAL_ORIGIN);
}

/**
 * Translate selected bricks that may span multiple layers in one Yjs
 * transaction so undo treats the whole drag as one step.
 *
 * `byLayer` is a map of layerId → brickIds to move in that layer.
 */
export function translateBricksAcrossLayers(
  doc: Y.Doc,
  byLayer: Map<string, string[]>,
  dxStuds: number,
  dyStuds: number,
): void {
  if (byLayer.size === 0 || (dxStuds === 0 && dyStuds === 0)) return;
  doc.transact(() => {
    for (const [layerId, brickIds] of byLayer) {
      if (brickIds.length === 0) continue;
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const bricks = layerData.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      const idSet = new Set(brickIds);
      for (let i = 0; i < bricks.length; i++) {
        const b = bricks.get(i);
        if (!(b instanceof Y.Map) || !idSet.has(b.get('id') as string)) continue;
        const area = b.get('displayArea') as import('@cld/model').RectangleF;
        b.set('displayArea', { ...area, x: area.x + dxStuds, y: area.y + dyStuds });
      }
    }
  }, LOCAL_ORIGIN);
}

/**
 * Translate every brick in `brickIds` by the same delta. Used for
 * multi-select drag — the dragged brick's `dx, dy` is computed by the
 * caller from the Konva event, then applied to every selected brick in
 * a single Yjs transaction so undo treats the whole drag as one step.
 */
export function translateBricks(
  doc: Y.Doc,
  layerId: string,
  brickIds: string[],
  dxStuds: number,
  dyStuds: number,
): void {
  if (brickIds.length === 0 || (dxStuds === 0 && dyStuds === 0)) return;
  doc.transact(() => {
    for (const brickId of brickIds) {
      const yBrick = findBrick(doc, layerId, brickId);
      if (!yBrick) continue;
      const area = yBrick.get('displayArea') as RectangleF;
      yBrick.set('displayArea', {
        ...area,
        x: area.x + dxStuds,
        y: area.y + dyStuds,
      });
    }
  }, LOCAL_ORIGIN);
}

/**
 * Insert a list of bricks (typically extracted from a module's snapshot)
 * into the given layer at an offset. New brick ids are minted so the
 * insertion can't collide with existing ids in the target layout.
 *
 * Returns the list of newly-minted ids in insertion order — useful for
 * the editor to immediately select what was inserted.
 */
export function insertBricks(
  doc: Y.Doc,
  layerId: string,
  bricks: Array<{
    partNumber: string;
    displayArea: { x: number; y: number; width: number; height: number };
    orientation?: number;
    altitude?: number;
    /** The group (set) it is in, already in the layer or added with it. */
    myGroup?: string;
  }>,
  offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
  groups: readonly Group[] = [],
): string[] {
  if (bricks.length === 0) return [];
  const ids: string[] = [];
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yBricks = layerData.get('bricks');
    if (!(yBricks instanceof Y.Array)) return;
    // All on top in one push: one per part scanned the whole sheet each
    // time (a paste of 500 parts into 5,000 read 2.5 million entries).
    const added: Y.Map<unknown>[] = [];
    for (const b of bricks) {
      const id = makeId();
      ids.push(id);
      const yBrick = new Y.Map<unknown>();
      yBrick.set('id', id);
      yBrick.set('displayArea', {
        x: b.displayArea.x + offset.dx,
        y: b.displayArea.y + offset.dy,
        width: b.displayArea.width,
        height: b.displayArea.height,
      });
      yBrick.set('myGroup', b.myGroup ?? '');
      yBrick.set('partNumber', b.partNumber);
      yBrick.set('orientation', b.orientation ?? 0);
      yBrick.set('activeConnectionPointIndex', 0);
      yBrick.set('altitude', b.altitude ?? 0);
      yBrick.set('connexions', []);
      added.push(yBrick);
    }
    pushOnTop(yBricks, added);
    const yGroups = layerData.get('groups');
    if (groups.length > 0 && yGroups instanceof Y.Array) {
      for (const g of groups) {
        const yGroup = new Y.Map<unknown>();
        yGroup.set('id', g.id);
        if (g.partNumber !== undefined) yGroup.set('partNumber', g.partNumber);
        yGroup.set('myGroup', g.myGroup ?? '');
        yGroups.push([yGroup]);
      }
    }
  }, LOCAL_ORIGIN);
  return ids;
}

export function rotateBricks(
  doc: Y.Doc,
  layerId: string,
  brickIds: string[],
  deltaDegrees: number,
): void {
  if (brickIds.length === 0 || deltaDegrees === 0) return;
  doc.transact(() => {
    for (const brickId of brickIds) {
      const yBrick = findBrick(doc, layerId, brickId);
      if (!yBrick) continue;
      const current = (yBrick.get('orientation') as number) ?? 0;
      // Preserve float orientation. Desktop stores `Brick.orientation` as
      // a float and rotateSelected adds a float delta (MapView.cpp:964-967
      // pushes ±90.0f through RotateBricksCommand). Rounding to an int
      // would silently quantise the values that came in from a desktop
      // save — and the .bbm writer at G7 already handles drift fine.
      yBrick.set('orientation', mod360(current + deltaDegrees));
    }
  }, LOCAL_ORIGIN);
}

/**
 * Group `ids` by the brick layer that holds them, in layer order. The
 * selection is a flat id list that can span layers; desktop commands act
 * on every selected brick whatever its layer (items carry their layer
 * index), so the web commands resolve layers from the map, never from the
 * active layer. Unknown ids are dropped.
 */
export function bricksByLayer(
  map: { layers: ReadonlyArray<{ id: string; type: string; bricks?: ReadonlyArray<{ id: string }> }> },
  ids: Iterable<string>,
  opts: { visibleOnly?: boolean } = {},
): Map<string, string[]> {
  const want = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  const out = new Map<string, string[]>();
  if (want.size === 0) return out;
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || !layer.bricks) continue;
    if (opts.visibleOnly && (layer as { visible?: boolean }).visible === false) continue;
    const hit: string[] = [];
    for (const b of layer.bricks) if (want.has(b.id)) hit.push(b.id);
    if (hit.length > 0) out.set(layer.id, hit);
  }
  return out;
}

/** Every brick id on every visible brick layer — desktop `selectAll` (MapView.cpp:1417). */
export function allVisibleBrickIds(
  map: { layers: ReadonlyArray<{ type: string; visible?: boolean; bricks?: ReadonlyArray<{ id: string }> }> },
): string[] {
  const out: string[] = [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || layer.visible === false || !layer.bricks) continue;
    for (const b of layer.bricks) out.push(b.id);
  }
  return out;
}

/**
 * `insertBricks` into several layers in one transaction; returns every
 * new id (layer order). Used by Duplicate so copies stay on their
 * source layers.
 */
export function insertBricksAcrossLayers(
  doc: Y.Doc,
  perLayer: Map<string, Parameters<typeof insertBricks>[2]>,
  offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
  groupsPerLayer: ReadonlyMap<string, readonly Group[]> = new Map(),
): string[] {
  const ids: string[] = [];
  doc.transact(() => {
    for (const [layerId, bricks] of perLayer) ids.push(...insertBricks(doc, layerId, bricks, offset, groupsPerLayer.get(layerId) ?? []));
  }, LOCAL_ORIGIN);
  return ids;
}

/** Delete bricks spanning several layers in ONE transaction (one undo step). */
export function deleteBricksAcrossLayers(doc: Y.Doc, byLayer: Map<string, string[]>): void {
  if (byLayer.size === 0) return;
  doc.transact(() => {
    for (const [layerId, ids] of byLayer) deleteBricks(doc, layerId, ids);
  }, LOCAL_ORIGIN);
}

/**
 * Rotate a (possibly multi-layer) selection by `degrees` around its pivot
 * — the mean of the bricks' sprite centres, so one brick turns in place —
 * with each displayArea following the turned footprint
 * (MapView::rotateSelected). `partOf` resolves a brick's catalog part;
 * without it the pivot is the displayArea centre and sizes are kept.
 * One transaction.
 */
export function rotateBricksAboutCentroid(
  doc: Y.Doc,
  byLayer: Map<string, string[]>,
  degrees: number,
  partOf: (partNumber: string) => PartGeom | undefined = () => undefined,
): void {
  if (byLayer.size === 0 || degrees === 0) return;
  const found: Array<{ yBrick: Y.Map<unknown>; area: RectangleF; orientation: number; part: PartGeom | undefined }> = [];
  for (const [layerId, ids] of byLayer) {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) continue;
    const bricks = layerData.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    const idSet = new Set(ids);
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks.get(i);
      if (b instanceof Y.Map && idSet.has(b.get('id') as string)) {
        found.push({
          yBrick: b,
          area: b.get('displayArea') as RectangleF,
          orientation: (b.get('orientation') as number) ?? 0,
          part: partOf(b.get('partNumber') as string),
        });
      }
    }
  }
  if (found.length === 0) return;
  const next = rotateAroundPivots(
    found.map(({ area, orientation, part }) => ({ brick: { displayArea: area, orientation }, part })),
    degrees,
  );
  doc.transact(() => {
    found.forEach(({ yBrick, area }, i) => {
      const n = next[i]!;
      const a = n.displayArea;
      if (
        Math.abs(a.x - area.x) > 1e-9 || Math.abs(a.y - area.y) > 1e-9 ||
        Math.abs(a.width - area.width) > 1e-9 || Math.abs(a.height - area.height) > 1e-9
      ) {
        yBrick.set('displayArea', a);
      }
      yBrick.set('orientation', mod360(n.orientation));
    });
  }, LOCAL_ORIGIN);
}

type Pt = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** True when a text at `orientation` stands upright (90 / 270), as the map's text layout reads it. */
function uprightText(orientation: number): boolean {
  const o = mod360(orientation);
  return Math.abs(o - 90) < 1 || Math.abs(o - 270) < 1;
}

/**
 * A text cell turned `degrees` about `pivot` (BlueBrick RotateText): its box
 * centre turns, its orientation adds up, and its box keeps the text's size
 * (width and height swap going to or from upright). Desktop rotatedTextCell.
 */
export function rotatedTextBox(area: Box, orientation: number, pivot: Pt, degrees: number): { displayArea: Box; orientation: number } {
  const next = orientation + degrees;
  const swap = uprightText(orientation) !== uprightText(next);
  const w = swap ? area.height : area.width;
  const h = swap ? area.width : area.height;
  const r = rotated({ x: area.x + area.width / 2 - pivot.x, y: area.y + area.height / 2 - pivot.y }, degrees);
  return { displayArea: { x: pivot.x + r.x - w / 2, y: pivot.y + r.y - h / 2, width: w, height: h }, orientation: mod360(next) };
}

function turnedPoint(p: Pt, pivot: Pt, degrees: number): Pt {
  const r = rotated({ x: p.x - pivot.x, y: p.y - pivot.y }, degrees);
  return { x: pivot.x + r.x, y: pivot.y + r.y };
}

/** The point a ruler turns about on its own: a line's middle, a circle's centre. */
export function rulerCentre(r: Pick<RulerLike, 'kind' | 'point1' | 'point2' | 'center'>): Pt {
  return r.kind === 'circular' ? r.center : { x: (r.point1.x + r.point2.x) / 2, y: (r.point1.y + r.point2.y) / 2 };
}

/**
 * Rotate CW / CCW for everything picked (BlueBrick RotateItems, RotateText,
 * RotateRulers): parts on any sheet, text cells (`sheet#index` keys) and
 * rulers (ids) turn by `degrees` about one pivot: the centre of their
 * bounding box, or one item's own centre. Parts joined to other track step
 * round that join (RotateBrick). Desktop MapView::rotateSelected. One transaction.
 */
export function rotateSelection(
  doc: Y.Doc,
  byLayer: Map<string, string[]>,
  anno: { texts: readonly string[]; rulers: readonly string[] },
  degrees: number,
  partOf: (partNumber: string) => PartGeom | undefined = () => undefined,
): void {
  if (degrees === 0) return;
  const bricks: Array<{ yBrick: Y.Map<unknown>; area: RectangleF; orientation: number; part: PartGeom | undefined }> = [];
  // Every part on the map, in sheet order, for joins to other track.
  const allBricks: TurnBrick[] = [];
  const pickedBricks: TurnBrick[] = [];
  const wantedIds = new Set([...byLayer.values()].flat());
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const layerData = doc.getMap('layerData').get(layerId);
    const yBricks = layerData instanceof Y.Map ? layerData.get('bricks') : undefined;
    if (!(yBricks instanceof Y.Array)) continue;
    const idSet = new Set(byLayer.get(layerId) ?? []);
    yBricks.forEach((b) => {
      if (!(b instanceof Y.Map)) return;
      const id = b.get('id') as string;
      const area = b.get('displayArea') as RectangleF;
      const orientation = (b.get('orientation') as number) ?? 0;
      const part = partOf(b.get('partNumber') as string);
      const turn: TurnBrick = { id, displayArea: area, orientation, part, connexions: (b.get('connexions') as TurnBrick['connexions']) ?? [] };
      allBricks.push(turn);
      if (idSet.has(id) && wantedIds.has(id)) {
        bricks.push({ yBrick: b, area, orientation, part });
        pickedBricks.push(turn);
      }
    });
  }
  const texts: Array<{ yCells: Y.Array<unknown>; index: number; area: Box; orientation: number }> = [];
  for (const key of anno.texts) {
    const at = key.lastIndexOf('#');
    if (at <= 0) continue;
    const layerData = doc.getMap('layerData').get(key.slice(0, at));
    const yCells = layerData instanceof Y.Map ? layerData.get('textCells') : undefined;
    if (!(yCells instanceof Y.Array)) continue;
    const index = Number(key.slice(at + 1));
    const cell = yCells.get(index) as unknown;
    const get = (k: string): unknown => (cell instanceof Y.Map ? cell.get(k) : (cell as Record<string, unknown> | undefined)?.[k]);
    const area = get('displayArea') as Box | undefined;
    if (area) texts.push({ yCells: yCells as Y.Array<unknown>, index, area, orientation: (get('orientation') as number) ?? 0 });
  }
  const rulers: Array<{ yItems: Y.Array<unknown>; ruler: RulerLike }> = [];
  if (anno.rulers.length > 0) {
    const wanted = new Set(anno.rulers);
    for (const lid of doc.getArray<string>('layers').toArray()) {
      const layerData = doc.getMap('layerData').get(lid);
      // Turned in place (shape 2): converted first, in its own step.
      const yItems = layerData instanceof Y.Map ? rulersInPlace(doc, layerData) : null;
      if (!yItems) continue;
      yItems.forEach((r) => {
        const ruler = rulerJson(r) as RulerLike | null;
        if (ruler && wanted.has(ruler.id)) rulers.push({ yItems: yItems as Y.Array<unknown>, ruler });
      });
    }
  }
  const count = bricks.length + texts.length + rulers.length;
  if (count === 0) return;
  // The pivot (BlueBrick RotateItems): one item turns about its own centre;
  // several about the centre of their bounding box, worked out afresh each
  // turn (vanilla's sLastCenter is cleared when its redo re-selects).
  const boxes: Box[] = [
    ...bricks.map(({ area }) => area),
    ...texts.map(({ area }) => area),
    ...rulers.map(({ ruler }) => (ruler.displayArea as Box | undefined) ?? { ...rulerCentre(ruler), width: 0, height: 0 }),
  ];
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  let pivot: Pt = { x: (left + right) / 2, y: (top + bottom) / 2 };
  if (count === 1) {
    if (bricks.length) pivot = pivotOf({ displayArea: bricks[0]!.area, orientation: bricks[0]!.orientation }, bricks[0]!.part);
    else if (texts.length) pivot = { x: texts[0]!.area.x + texts[0]!.area.width / 2, y: texts[0]!.area.y + texts[0]!.area.height / 2 };
    else pivot = rulerCentre(rulers[0]!.ruler);
  }
  // Parts joined to other track step round that join instead, so they stay
  // connected (RotateBrick).
  const joined = texts.length === 0 && rulers.length === 0 ? connectedTurn(pickedBricks, allBricks, degrees > 0 ? 1 : -1) : null;
  if (joined) degrees = joined.degrees;
  doc.transact(() => {
    const next = rotateAroundPivots(
      bricks.map(({ area, orientation, part }) => ({ brick: { displayArea: area, orientation }, part })),
      degrees,
      pivot,
    );
    if (joined) {
      // Moved so the new connection sits where the old join was.
      const i = pickedBricks.findIndex((b) => b.id === joined.brickId);
      const now = connectionWorld(next[i]!, bricks[i]!.part, joined.connection);
      const dx = joined.at.x - now.x;
      const dy = joined.at.y - now.y;
      for (const n of next) n.displayArea = { ...n.displayArea, x: n.displayArea.x + dx, y: n.displayArea.y + dy };
    }
    bricks.forEach(({ yBrick }, i) => {
      yBrick.set('displayArea', next[i]!.displayArea);
      yBrick.set('orientation', mod360(next[i]!.orientation));
    });
    for (const t of texts) patchTextCell(t.yCells, t.index, rotatedTextBox(t.area, t.orientation, pivot, degrees));
    for (const { yItems, ruler } of rulers) {
      const idx = findRulerIndex(yItems, ruler.id);
      if (idx < 0) continue;
      let turned: Record<string, unknown>;
      if (ruler.kind === 'linear') {
        const p1 = turnedPoint(ruler.point1, pivot, degrees);
        const p2 = turnedPoint(ruler.point2, pivot, degrees);
        turned = { ...ruler, point1: p1, point2: p2, displayArea: rectFromTwoPoints(p1, p2) };
      } else {
        const c = turnedPoint(ruler.center, pivot, degrees);
        turned = { ...ruler, center: c, displayArea: rectAroundCircle(c, ruler.radius) };
      }
      writeRuler(yItems, idx, turned);
    }
  }, LOCAL_ORIGIN);
}

/** A layer's groups and bricks as they are in the doc. */
function readGrouping(layerData: Y.Map<unknown>): { yBricks: Y.Array<unknown>; yGroups: Y.Array<unknown>; groups: Group[] } | null {
  const yBricks = layerData.get('bricks');
  const yGroups = layerData.get('groups');
  if (!(yBricks instanceof Y.Array) || !(yGroups instanceof Y.Array)) return null;
  const groups: Group[] = [];
  yGroups.forEach((g) => {
    if (!(g instanceof Y.Map)) return;
    const partNumber = g.get('partNumber') as string | undefined;
    groups.push({ id: g.get('id') as string, ...(partNumber ? { partNumber } : {}), myGroup: (g.get('myGroup') as string) || '' });
  });
  return { yBricks, yGroups, groups };
}

/**
 * Group a multi-layer selection — BlueBrick's GroupItems, the desktop's
 * GroupBricksCommand: per layer, the selected bricks' outermost items (a
 * set stays whole inside) go into one new group, when there are at least
 * two items in all. Returns the new group ids.
 */
export function groupBricksAcrossLayers(doc: Y.Doc, byLayer: Map<string, string[]>): string[] {
  const groupIds: string[] = [];
  doc.transact(() => {
    const layers: { g: NonNullable<ReturnType<typeof readGrouping>>; topGroups: Set<string>; loose: Y.Map<unknown>[] }[] = [];
    let items = 0;
    for (const [layerId, ids] of byLayer) {
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const g = readGrouping(layerData);
      if (!g) continue;
      const idSet = new Set(ids);
      const topGroups = new Set<string>();
      const loose: Y.Map<unknown>[] = [];
      g.yBricks.forEach((b) => {
        if (!(b instanceof Y.Map) || !idSet.has(b.get('id') as string)) return;
        const top = topGroupId(g.groups, (b.get('myGroup') as string) || '');
        if (top) topGroups.add(top);
        else loose.push(b);
      });
      items += topGroups.size + loose.length;
      if (topGroups.size + loose.length > 0) layers.push({ g, topGroups, loose });
    }
    // At least two items in all (desktop: one new group per layer).
    if (items < 2) return;
    for (const { g, topGroups, loose } of layers) {
      const groupId = makeId();
      const yGroup = new Y.Map<unknown>();
      yGroup.set('id', groupId);
      g.yGroups.push([yGroup]);
      groupIds.push(groupId);
      g.yGroups.forEach((y) => {
        if (y instanceof Y.Map && topGroups.has(y.get('id') as string)) y.set('myGroup', groupId);
      });
      for (const b of loose) b.set('myGroup', groupId);
    }
  }, LOCAL_ORIGIN);
  return groupIds;
}

/**
 * Ungroup a multi-layer selection in one transaction — BlueBrick's
 * UngroupItems: the selected bricks' outermost groups that may be split
 * are removed, their items going up a level. A set `canUngroup` refuses
 * (flex.group's <CanUngroup>false) stays whole. Returns how many refused.
 */
export function ungroupBricksAcrossLayers(
  doc: Y.Doc,
  byLayer: Map<string, string[]>,
  canUngroup: (group: Group) => boolean = () => true,
): { refused: number } {
  let refused = 0;
  if (byLayer.size === 0) return { refused };
  doc.transact(() => {
    for (const [layerId, ids] of byLayer) {
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const g = readGrouping(layerData);
      if (!g) continue;
      const idSet = new Set(ids);
      const tops = new Set<string>();
      g.yBricks.forEach((b) => {
        if (b instanceof Y.Map && idSet.has(b.get('id') as string)) {
          const top = topGroupId(g.groups, (b.get('myGroup') as string) || '');
          if (top) tops.add(top);
        }
      });
      for (const id of tops) {
        const group = g.groups.find((x) => x.id === id)!;
        if (!canUngroup(group)) {
          refused++;
          continue;
        }
        const up = group.myGroup ?? '';
        g.yGroups.forEach((y) => {
          if (y instanceof Y.Map && y.get('myGroup') === id) y.set('myGroup', up);
        });
        g.yBricks.forEach((b) => {
          if (b instanceof Y.Map && b.get('myGroup') === id) b.set('myGroup', up);
        });
        for (let i = g.yGroups.length - 1; i >= 0; i--) {
          const y = g.yGroups.get(i);
          if (y instanceof Y.Map && y.get('id') === id) g.yGroups.delete(i, 1);
        }
      }
    }
  }, LOCAL_ORIGIN);
  return { refused };
}

/**
 * Paint or erase area cells — port of `PaintAreaCellsCommand`
 * (AreaCommands.cpp:41-68).
 *
 * `color === null` ⇒ erase the cell at (x, y); otherwise upsert the
 * cell with the new color. All changes apply in one Yjs transaction
 * → one undo step.
 *
 * `color` is the AARRGGBB hex string (uppercase per AreaCell.color).
 */
export function paintAreaCells(
  doc: Y.Doc,
  layerId: string,
  changes: Array<{ x: number; y: number; color: string | null }>,
): void {
  if (changes.length === 0) return;
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yAreas = layerData.get('areas');
    if (!(yAreas instanceof Y.Array)) return;
    // Cells are kept relative to the sheet's offset (doc shape 2).
    const off = cellOffsetOf(layerData);
    const rel = changes.map((c) => ({ ...c, x: c.x - off.x, y: c.y - off.y }));

    // Index existing cells by `${x},${y}` for O(1) upsert. A cell can be
    // there twice (two people painted it at once), so erasing or
    // repainting takes every copy.
    const indexByKey = new Map<string, number[]>();
    for (let i = 0; i < yAreas.length; i++) {
      const cell = yAreas.get(i) as { x: number; y: number; color: string };
      const key = `${cell.x},${cell.y}`;
      indexByKey.set(key, [...(indexByKey.get(key) ?? []), i]);
    }

    // Sort changes so deletions happen highest-index first (so other
    // indices stay valid). Splits into upserts + deletes.
    const upserts = new Map<string, { x: number; y: number; color: string }>();
    const deletes: number[] = [];
    for (const c of rel) {
      const key = `${c.x},${c.y}`;
      const existing = indexByKey.get(key);
      // Erase deletes; repaint replaces (delete + push the upsert).
      if (existing !== undefined) deletes.push(...existing);
      indexByKey.delete(key);
      if (c.color !== null) upserts.set(key, { x: c.x, y: c.y, color: c.color });
      else upserts.delete(key);
    }
    deletes.sort((a, b) => b - a);
    for (const idx of deletes) yAreas.delete(idx, 1);
    for (const u of upserts.values()) yAreas.push([u]);
  }, LOCAL_ORIGIN);
}

/**
 * Paint cell size of a NEW Area layer, in studs — desktop
 * `LayerArea::areaCellSizeInStud = 32` (core/LayerArea.h:25). Existing
 * layers keep whatever size they were saved with.
 */
export const AREA_CELL_SIZE_DEFAULT = 32;

/**
 * Find the topmost (last in the layer order, matching desktop's
 * "for i = layers.size()-1 ... break" search at MapView.cpp:500-507)
 * visible Area layer. Creates a new Area layer with sane defaults
 * when no Area layer exists. Returns the layer id.
 */
/**
 * BlueBrick MoveArea: shift every painted cell of an area sheet by whole
 * cells (desktop MoveAreaCommand). One transaction.
 */
export function moveArea(doc: Y.Doc, layerId: string, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const layerData = doc.getMap('layerData').get(layerId);
  if (!(layerData instanceof Y.Map) || !(layerData.get('areas') instanceof Y.Array)) return;
  // The sheet's offset changes, not every cell (doc shape 2), so two people
  // moving it at once leave each cell once.
  markShapeInPlace(doc);
  doc.transact(() => {
    const off = cellOffsetOf(layerData);
    layerData.set('cellOffset', { x: off.x + dx, y: off.y + dy });
  }, LOCAL_ORIGIN);
}

/** The topmost shown area sheet (the one Paint and Erase work on), or null. */
export function shownAreaLayer(doc: Y.Doc): string | null {
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  // Walk in reverse order: topmost first (desktop convention).
  const ids = doc.getArray<string>('layers').toArray();
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    const l = layerData.get(id);
    if (l instanceof Y.Map && l.get('type') === 'area' && l.get('visible') !== false) return id;
  }
  return null;
}

export function ensureAreaLayer(doc: Y.Doc, defaultCellSizeStuds = AREA_CELL_SIZE_DEFAULT): string {
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const shown = shownAreaLayer(doc);
  if (shown) return shown;
  // None — create one.
  const id = makeId();
  doc.transact(() => {
    const yLayer = new Y.Map<unknown>();
    yLayer.set('id', id);
    yLayer.set('type', 'area');
    yLayer.set('name', 'Area');
    yLayer.set('visible', true);
    yLayer.set('transparency', 100);
    yLayer.set('hullProperties', {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' },
      hullThickness: 1,
    });
    yLayer.set('areaCellSize', defaultCellSizeStuds);
    yLayer.set('areas', new Y.Array<{ x: number; y: number; color: string }>());
    yLayer.set('groups', new Y.Array<Y.Map<unknown>>());
    layerData.set(id, yLayer);
    layerOrder.push([id]);
  }, LOCAL_ORIGIN);
  return id;
}

export interface GeneralInfoPatch {
  author?: string;
  lug?: string;
  event?: string;
  date?: { day: number; month: number; year: number };
  comment?: string;
}

/**
 * Edit Map > General Info — port of `ChangeGeneralInfoCommand`
 * (LayerCommands.cpp). Single Yjs transaction → one undo step.
 * Only fields present in `patch` change.
 */
export function setGeneralInfo(doc: Y.Doc, patch: GeneralInfoPatch): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    if (patch.author !== undefined) meta.set('author', patch.author);
    if (patch.lug !== undefined) meta.set('lug', patch.lug);
    if (patch.event !== undefined) meta.set('event', patch.event);
    if (patch.comment !== undefined) meta.set('comment', patch.comment);
    if (patch.date !== undefined) meta.set('date', { ...patch.date });
  }, LOCAL_ORIGIN);
}

/**
 * Map > Background Color — port of `ChangeBackgroundColorCommand`
 * (LayerCommands.cpp). `color` is a ColorSpec (known-name or argb hex).
 */
export function setBackgroundColor(
  doc: Y.Doc,
  color: { kind: 'known'; name: string } | { kind: 'argb'; argb: string },
): void {
  doc.transact(() => {
    doc.getMap('meta').set('backgroundColor', { ...color });
  }, LOCAL_ORIGIN);
}

/** Meta key of the budget limits: a Y.Map of part number → limit (≥ 0). */
const BUDGET_KEY = 'budgetLimits';

/**
 * Budget limits stored in the doc (part number → max count). Desktop keeps
 * them in a `.bbb` file beside the map (Budget.cpp); here they live in the
 * doc's `meta` so they survive reload and are shared with collaborators.
 * `.bbb` files are still read/written by the Budget dialog.
 */
export function readBudgetLimits(doc: Y.Doc): Map<string, number> {
  const out = new Map<string, number>();
  const y = doc.getMap('meta').get(BUDGET_KEY);
  if (!(y instanceof Y.Map)) return out;
  for (const [part, limit] of y.entries()) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) out.set(part, limit);
  }
  return out;
}

/**
 * Replace the budget limits with `limits`, as one undo step. Only the
 * changed parts are written, so two users editing different rows merge.
 */
export function setBudgetLimits(doc: Y.Doc, limits: Map<string, number>): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    let y = meta.get(BUDGET_KEY);
    if (!(y instanceof Y.Map)) {
      if (limits.size === 0) return;
      y = new Y.Map<number>();
      meta.set(BUDGET_KEY, y);
    }
    const ym = y as Y.Map<number>;
    for (const part of [...ym.keys()]) {
      if (!limits.has(part)) ym.delete(part);
    }
    for (const [part, limit] of limits) {
      if (!(limit >= 0)) {
        if (ym.has(part)) ym.delete(part);
      } else if (ym.get(part) !== limit) {
        ym.set(part, limit);
      }
    }
  }, LOCAL_ORIGIN);
}

/**
 * Set a layer's `visible` flag. Port of `SetLayerVisibilityCommand`
 * (LayerCommands.cpp).
 */
export function setLayerVisible(doc: Y.Doc, layerId: string, visible: boolean): void {
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (layer instanceof Y.Map) layer.set('visible', visible);
  }, LOCAL_ORIGIN);
}

/** Show all layers (port of LayerPanel.cpp "Show All" button). */
export function showAllLayers(doc: Y.Doc): void {
  const layerData = doc.getMap('layerData');
  doc.transact(() => {
    for (const [, layer] of layerData) {
      if (layer instanceof Y.Map) layer.set('visible', true);
    }
  }, LOCAL_ORIGIN);
}

/**
 * Solo the given layer — make it visible, hide all others.
 * Port of LayerPanel.cpp "Solo" button.
 */
export function soloLayer(doc: Y.Doc, layerId: string): void {
  const layerData = doc.getMap('layerData');
  doc.transact(() => {
    for (const [id, layer] of layerData) {
      if (layer instanceof Y.Map) layer.set('visible', id === layerId);
    }
  }, LOCAL_ORIGIN);
}

/** Set a layer's `transparency` (0-100). */
export function setLayerTransparency(doc: Y.Doc, layerId: string, transparency: number): void {
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (layer instanceof Y.Map) {
      layer.set('transparency', Math.max(0, Math.min(100, Math.round(transparency))));
    }
  }, LOCAL_ORIGIN);
}

/** Rename a layer. */
export function renameLayer(doc: Y.Doc, layerId: string, name: string): void {
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (layer instanceof Y.Map) layer.set('name', name);
  }, LOCAL_ORIGIN);
}

/** Set hull visibility, color, and thickness on a brick layer — port of `LayerOptionsDialog` changes. */
export function setLayerHullProperties(
  doc: Y.Doc,
  layerId: string,
  isVisible: boolean,
  hullColor: import('@cld/model').ColorSpec,
  hullThickness: number,
): void {
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (layer instanceof Y.Map) {
      layer.set('hullProperties', { isVisible, hullColor, hullThickness });
    }
  }, LOCAL_ORIGIN);
}

/** Toggle per-layer brick-elevation display (`LayerBrick.displayBrickElevation`). */
export function setLayerDisplayBrickElevation(doc: Y.Doc, layerId: string, v: boolean): void {
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (layer instanceof Y.Map) layer.set('displayBrickElevation', v);
  }, LOCAL_ORIGIN);
}

/**
 * Move a layer up (toward end of the array = topmost) or down. Mirrors
 * `MoveLayerCommand` (LayerCommands.cpp).
 */
export function moveLayer(doc: Y.Doc, layerId: string, direction: 'up' | 'down'): void {
  doc.transact(() => {
    const layerOrder = doc.getArray<string>('layers');
    const ids = layerOrder.toArray();
    const idx = ids.indexOf(layerId);
    if (idx < 0) return;
    const swap = direction === 'up' ? idx + 1 : idx - 1;
    if (swap < 0 || swap >= ids.length) return;
    const a = ids[idx]!;
    const b = ids[swap]!;
    layerOrder.delete(Math.min(idx, swap), 2);
    if (direction === 'up') {
      layerOrder.insert(Math.min(idx, swap), [b, a]);
    } else {
      layerOrder.insert(Math.min(idx, swap), [a, b]);
    }
  }, LOCAL_ORIGIN);
}

/** Delete a layer entirely (data + ordering). */
export function deleteLayer(doc: Y.Doc, layerId: string): void {
  doc.transact(() => {
    const layerOrder = doc.getArray<string>('layers');
    const ids = layerOrder.toArray();
    const idx = ids.indexOf(layerId);
    if (idx >= 0) layerOrder.delete(idx, 1);
    doc.getMap<Y.Map<unknown>>('layerData').delete(layerId);
  }, LOCAL_ORIGIN);
}

/**
 * Move a grid layer's cell-index origin by whole cells, as one undo step
 * (desktop MoveGridOriginCommand, LayerCommands.cpp:195-210).
 */
export function moveGridOrigin(doc: Y.Doc, layerId: string, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (!(layer instanceof Y.Map) || layer.get('type') !== 'grid') return;
    const cur = layer.get('cellIndexCorner') as { x?: number; y?: number } | undefined;
    layer.set('cellIndexCorner', { x: (cur?.x ?? 0) + dx, y: (cur?.y ?? 0) + dy });
  }, LOCAL_ORIGIN);
}

/**
 * The first ruler layer, or a new one named "Rulers" at the top — where
 * desktop's ruler tools put a new ruler (MapView.cpp:818-829).
 */
/**
 * The sheet of this kind new things go on: the active sheet when it's of
 * this kind and shown, else the first shown one, else the first hidden one
 * (the caller says so: announcePlacement). Null when there's none.
 */
export function sheetForNew(doc: Y.Doc, type: 'ruler' | 'text', activeId?: string | null): string | null {
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const ofType = doc
    .getArray<string>('layers')
    .toArray()
    .filter((id) => {
      const l = layerData.get(id);
      return l instanceof Y.Map && l.get('type') === type;
    });
  const shown = (id: string) => layerData.get(id)?.get('visible') !== false;
  if (activeId && ofType.includes(activeId) && shown(activeId)) return activeId;
  return ofType.find(shown) ?? ofType[0] ?? null;
}

export function ensureRulerLayer(doc: Y.Doc, activeId?: string | null): string {
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const found = sheetForNew(doc, 'ruler', activeId);
  if (found) return found;
  const id = makeId();
  doc.transact(() => {
    const yLayer = new Y.Map<unknown>();
    yLayer.set('id', id);
    yLayer.set('type', 'ruler');
    yLayer.set('name', 'Rulers');
    yLayer.set('visible', true);
    yLayer.set('transparency', 100);
    yLayer.set('hullProperties', {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' },
      hullThickness: 1,
    });
    yLayer.set('rulerItems', new Y.Array());
    yLayer.set('groups', new Y.Array<Y.Map<unknown>>());
    layerData.set(id, yLayer);
    layerOrder.push([id]);
  }, LOCAL_ORIGIN);
  return id;
}

/**
 * The label shown while drawing a ruler (MapView.cpp:941-946): length in
 * studs to one decimal and in mm (m with two decimals from 1 m), with
 * "r=" for a circle's radius.
 */
export function rulerPreviewLabel(lengthStuds: number, circular: boolean): string {
  const mm = lengthStuds * 8;
  const unit = mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
  return `${circular ? 'r=' : ''}${lengthStuds.toFixed(1)} studs (${unit})`;
}

/**
 * The status-bar readout while drawing a ruler (MapView.cpp:661-680),
 * kept alongside the floating label.
 */
export function rulerStatusMessage(lengthStuds: number, circular: boolean): string {
  const mm = lengthStuds * 8;
  const unit = mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
  return `Ruler ${circular ? 'radius' : 'length'}: ${lengthStuds.toFixed(1)} studs  (${unit})`;
}

/**
 * A new ruler, as desktop's RulerItemBase defaults (core/RulerItem.h:22-31,
 * FontSpec.h:11-12): black (the known color) line, guideline and
 * measure text, 1-thick solid lines, Microsoft Sans Serif 8.25.
 */
const RULER_DEFAULTS = {
  color: { kind: 'known' as const, name: 'Black' },
  lineThickness: 1,
  displayDistance: true,
  displayUnit: true,
  guidelineColor: { kind: 'known' as const, name: 'Black' },
  guidelineThickness: 1,
  guidelineDashPattern: [] as number[],
  unit: 0, // STUD
  measureFont: { family: 'Microsoft Sans Serif', size: 8.25, style: 'Regular' },
  measureFontColor: { kind: 'known' as const, name: 'Black' },
};

/**
 * Append a linear ruler — port of `AddRulerItemCommand`
 * (RulerCommands.cpp). Endpoints in studs.
 */
export function addLinearRuler(
  doc: Y.Doc,
  layerId: string,
  point1: { x: number; y: number },
  point2: { x: number; y: number },
): string {
  const id = makeId();
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const minX = Math.min(point1.x, point2.x);
    const minY = Math.min(point1.y, point2.y);
    const maxX = Math.max(point1.x, point2.x);
    const maxY = Math.max(point1.y, point2.y);
    pushOnTop(yItems, [toItemMap({
        id,
        kind: 'linear',
        displayArea: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        myGroup: '',
        ...RULER_DEFAULTS,
        point1,
        point2,
        attachedBrick1Id: '',
        attachedBrick2Id: '',
        offsetDistance: 0,
        allowOffset: false,
      })]);
  }, LOCAL_ORIGIN);
  return id;
}

/** Append a circular ruler. */
export function addCircularRuler(
  doc: Y.Doc,
  layerId: string,
  centre: { x: number; y: number },
  radiusStuds: number,
): string {
  const id = makeId();
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const r = Math.max(0, radiusStuds);
    pushOnTop(yItems, [toItemMap({
        id,
        kind: 'circular',
        displayArea: { x: centre.x - r, y: centre.y - r, width: 2 * r, height: 2 * r },
        myGroup: '',
        ...RULER_DEFAULTS,
        center: centre,
        radius: r,
        attachedBrickId: '',
      })]);
  }, LOCAL_ORIGIN);
  return id;
}

// ---------------------------------------------------------------------------
// Ruler verbs — port of `RulerCommands.cpp`. Each is one Yjs transaction
// so undo unwinds the whole edit. Items are addressed by stable `id`
// (minted in `addLinearRuler`/`addCircularRuler` and on `.bbm` read in
// `Reader.ts`).
// ---------------------------------------------------------------------------

/**
 * Find a ruler item's index inside the layer's `rulerItems` Y.Array.
 * Returns -1 if not found. Used by every ruler verb below.
 */
function findRulerIndex(yItems: Y.Array<unknown>, rulerId: string): number {
  for (let i = 0; i < yItems.length; i++) if (itemId(yItems.get(i)) === rulerId) return i;
  return -1;
}

/**
 * A ruler sheet's items, turned into Y.Maps first when they're plain
 * objects (doc shape 2, @cld/ydoc shape.ts), in a step of their own, so
 * every ruler edit changes the entry in place and merges with someone
 * else's edit or delete. Call before the edit's transaction.
 */
function rulerSheet(doc: Y.Doc, layerId: string): Y.Array<unknown> | null {
  const layer = doc.getMap('layerData').get(layerId);
  return layer instanceof Y.Map ? rulersInPlace(doc, layer) : null;
}

/** Change a ruler entry to `next`, in place when it's a Y.Map. */
function writeRuler(yItems: Y.Array<unknown>, idx: number, next: Record<string, unknown>): void {
  const m = yItems.get(idx);
  if (m instanceof Y.Map) {
    setItemFields(m, next);
    return;
  }
  yItems.delete(idx, 1);
  yItems.insert(idx, [next]);
}

/** Delete a ruler item. */
export function deleteRulerItem(doc: Y.Doc, layerId: string, rulerId: string): void {
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx >= 0) yItems.delete(idx, 1);
  }, LOCAL_ORIGIN);
}

/**
 * Translate a ruler item by `(dx, dy)` studs. For linear rulers both
 * endpoints move; for circular the centre moves. displayArea is
 * recomputed. Mirrors `MoveRulerItemCommand` (RulerCommands.cpp:162-199).
 */
export function moveRulerItem(
  doc: Y.Doc,
  layerId: string,
  rulerId: string,
  dxStuds: number,
  dyStuds: number,
): void {
  if (dxStuds === 0 && dyStuds === 0) return;
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx < 0) return;
    const cur = rulerJson(yItems.get(idx)) as RulerLike | null;
    if (!cur) return;
    if (cur.kind === 'linear') {
      const p1 = { x: cur.point1.x + dxStuds, y: cur.point1.y + dyStuds };
      const p2 = { x: cur.point2.x + dxStuds, y: cur.point2.y + dyStuds };
      writeRuler(yItems, idx, {
          ...cur,
          point1: p1,
          point2: p2,
          displayArea: rectFromTwoPoints(p1, p2),
        });
    } else {
      const c = { x: cur.center.x + dxStuds, y: cur.center.y + dyStuds };
      writeRuler(yItems, idx, {
          ...cur,
          center: c,
          displayArea: rectAroundCircle(c, cur.radius),
        });
    }
  }, LOCAL_ORIGIN);
}

/**
 * BlueBrick ScaleRuler: the offset of a linear ruler (signed, along
 * (Uy, -Ux) as vanilla draws it) or the radius of a circle that puts its
 * scale handle at `at` (studs). Desktop scaledRulerValue.
 */
export function scaledRulerValue(r: Pick<RulerLike, 'kind' | 'point1' | 'point2' | 'center'>, at: { x: number; y: number }): number {
  if (r.kind === 'circular') return Math.hypot(at.x - r.center.x, at.y - r.center.y);
  const dx = r.point2.x - r.point1.x;
  const dy = r.point2.y - r.point1.y;
  const len = Math.hypot(dx, dy);
  const u = len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  return (at.x - r.point1.x) * u.y - (at.y - r.point1.y) * u.x;
}

/** Drag a ruler's offset or a circle's radius to `at` (studs): ScaleRuler. */
export function scaleRuler(doc: Y.Doc, layerId: string, rulerId: string, at: { x: number; y: number }): void {
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx < 0) return;
    const cur = rulerJson(yItems.get(idx)) as RulerLike | null;
    if (!cur) return;
    const value = scaledRulerValue(cur, at);
    const next =
      cur.kind === 'circular'
        ? { ...cur, radius: Math.max(0, value), displayArea: rectAroundCircle(cur.center, Math.max(0, value)) }
        : { ...cur, offsetDistance: value };
    writeRuler(yItems, idx, next);
  }, LOCAL_ORIGIN);
}

/**
 * Move one endpoint of a linear ruler. `which` selects 0 = point1 or
 * 1 = point2. Mirrors `MoveRulerEndpointCommand` (RulerCommands.cpp:203-282).
 * Detaches the corresponding `attachedBrickN` automatically (the
 * desktop's command does the same — once the user has hand-moved an
 * endpoint, the attach link is stale).
 */
export function moveRulerEndpoint(
  doc: Y.Doc,
  layerId: string,
  rulerId: string,
  which: 0 | 1,
  newPoint: { x: number; y: number },
): void {
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx < 0) return;
    const cur = rulerJson(yItems.get(idx)) as RulerLike | null;
    if (!cur || cur.kind !== 'linear') return;
    const next = { ...cur };
    if (which === 0) {
      next.point1 = { ...newPoint };
      next.attachedBrick1Id = '';
    } else {
      next.point2 = { ...newPoint };
      next.attachedBrick2Id = '';
    }
    next.displayArea = rectFromTwoPoints(next.point1, next.point2);
    writeRuler(yItems, idx, next);
  }, LOCAL_ORIGIN);
}

/**
 * Attach (or detach) a ruler endpoint to a brick by guid. For circular
 * rulers, `which` is ignored and the centre is attached. Mirrors
 * `AttachRulerCommand` (RulerCommands.cpp:298-346). Pass an empty
 * brick id to detach.
 */
export function attachRulerEndpoint(
  doc: Y.Doc,
  layerId: string,
  rulerId: string,
  which: 0 | 1,
  brickId: string,
): void {
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx < 0) return;
    const cur = rulerJson(yItems.get(idx)) as RulerLike | null;
    if (!cur) return;
    if (cur.kind === 'linear') {
      const next = { ...cur };
      if (which === 0) next.attachedBrick1Id = brickId;
      else next.attachedBrick2Id = brickId;
      writeRuler(yItems, idx, next);
    } else {
      const next = { ...cur, attachedBrickId: brickId };
      writeRuler(yItems, idx, next);
    }
  }, LOCAL_ORIGIN);
}

export interface EditRulerPatch {
  color?: ColorSpec;
  lineThickness?: number;
  displayDistance?: boolean;
  displayUnit?: boolean;
  guidelineColor?: ColorSpec;
  guidelineThickness?: number;
  guidelineDashPattern?: number[];
  unit?: number;
  measureFont?: FontSpec;
  measureFontColor?: ColorSpec;
  // Linear-only:
  offsetDistance?: number;
  allowOffset?: boolean;
  // Circular-only:
  radius?: number;
}

/**
 * What the Edit Ruler dialog may write: the desktop dialog's ranges, all
 * inside what the server takes in a live update (apps/server/src/ws/
 * drawingSettings.ts), so an edit is never refused for a number typed past
 * the end of a field.
 */
export const RULER_LIMITS = {
  lineThickness: { min: 0.1, max: 50 },
  guidelineThickness: { min: 0, max: 50 },
  fontSize: { min: 1, max: 200 },
  /** Offset and radius, in studs. */
  distance: 1e7,
  maxDashes: 64,
  maxDash: 1000,
  /** A pattern adding up to less is drawn solid (none). */
  minDashTotal: 0.01,
} as const;

const clampTo = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** A dash pattern both apps draw: up to 64 lengths of 0 to 1000; one adding up to (nearly) nothing is none. */
export function rulerDashPattern(dashes: readonly number[]): number[] {
  const out = dashes
    .filter((d) => Number.isFinite(d))
    .slice(0, RULER_LIMITS.maxDashes)
    .map((d) => clampTo(d, 0, RULER_LIMITS.maxDash, 0));
  return out.reduce((a, b) => a + b, 0) >= RULER_LIMITS.minDashTotal ? out : [];
}

/**
 * Apply an `EditRulerPatch` — port of `EditRulerItemCommand`
 * (RulerCommands.cpp:99-149). Only fields present in the patch
 * change; everything else is preserved.
 */
export function editRulerItem(
  doc: Y.Doc,
  layerId: string,
  rulerId: string,
  patch: EditRulerPatch,
): void {
  const yItems = rulerSheet(doc, layerId);
  doc.transact(() => {
    if (!yItems) return;
    const idx = findRulerIndex(yItems, rulerId);
    if (idx < 0) return;
    const cur = rulerJson(yItems.get(idx)) as RulerLike | null;
    if (!cur) return;
    const next: Record<string, unknown> = { ...cur };
    for (const k of ['color', 'displayDistance', 'displayUnit', 'guidelineColor', 'unit', 'measureFontColor'] as const) {
      if (patch[k] !== undefined) next[k] = patch[k] as unknown;
    }
    const L = RULER_LIMITS;
    if (patch.lineThickness !== undefined) next.lineThickness = clampTo(patch.lineThickness, L.lineThickness.min, L.lineThickness.max, 1);
    if (patch.guidelineThickness !== undefined) {
      next.guidelineThickness = clampTo(patch.guidelineThickness, L.guidelineThickness.min, L.guidelineThickness.max, 1);
    }
    if (patch.guidelineDashPattern !== undefined) next.guidelineDashPattern = rulerDashPattern(patch.guidelineDashPattern);
    if (patch.measureFont !== undefined) {
      next.measureFont = { ...patch.measureFont, size: clampTo(patch.measureFont.size, L.fontSize.min, L.fontSize.max, 8.25) };
    }
    if (cur.kind === 'linear') {
      if (patch.offsetDistance !== undefined) next.offsetDistance = clampTo(patch.offsetDistance, -L.distance, L.distance, 0);
      if (patch.allowOffset !== undefined) next.allowOffset = patch.allowOffset;
    } else {
      if (patch.radius !== undefined) {
        const r = clampTo(patch.radius, 0, L.distance, 0);
        next.radius = r;
        next.displayArea = rectAroundCircle(cur.center, r);
      }
    }
    writeRuler(yItems, idx, next);
  }, LOCAL_ORIGIN);
}

type RulerLike = {
  id: string;
  kind: 'linear' | 'circular';
  point1: { x: number; y: number };
  point2: { x: number; y: number };
  center: { x: number; y: number };
  radius: number;
  attachedBrick1Id: string;
  attachedBrick2Id: string;
  attachedBrickId: string;
} & Record<string, unknown>;

function rectFromTwoPoints(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): RectangleF {
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rectAroundCircle(c: { x: number; y: number }, r: number): RectangleF {
  return { x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r };
}

export interface AddTextSpec {
  /** World centre of the displayArea, studs. */
  centreX: number;
  centreY: number;
  /** Approx box size in studs (used as displayArea dimensions). */
  widthStuds: number;
  heightStuds: number;
  text: string;
  /** Font shape — defaults applied if missing. */
  font: { family: string; size: number; style: string };
  /** Font color as `{ kind: 'argb', argb: '...' }` or `{ kind: 'known', name: '...' }`. */
  fontColor: { kind: 'argb'; argb: string } | { kind: 'known'; name: string };
  orientation?: number;
  textAlignment?: string;
}

/**
 * The first text layer, or a new one named "Labels" at the top — where
 * desktop's Insert Text puts a cell (MapView::addTextAtScenePos).
 */
export function ensureTextLayer(doc: Y.Doc, activeId?: string | null): string {
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const found = sheetForNew(doc, 'text', activeId);
  if (found) return found;
  const id = makeId();
  doc.transact(() => {
    const yLayer = new Y.Map<unknown>();
    yLayer.set('id', id);
    yLayer.set('type', 'text');
    yLayer.set('name', 'Labels');
    yLayer.set('visible', true);
    yLayer.set('transparency', 100);
    yLayer.set('hullProperties', {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' },
      hullThickness: 1,
    });
    yLayer.set('textCells', new Y.Array());
    yLayer.set('groups', new Y.Array<Y.Map<unknown>>());
    layerData.set(id, yLayer);
    layerOrder.push([id]);
  }, LOCAL_ORIGIN);
  return id;
}

/**
 * Box for new text, in studs: 10 studs high, 0.6 of that per character
 * wide and at least twice the height (MapView::addTextAtScenePos).
 */
export function newTextBox(text: string): { width: number; height: number } {
  const height = 10;
  return { width: Math.max(height * 0.6 * text.length, height * 2), height };
}

/**
 * Append a new text cell to the given layer — port of
 * `AddTextCellCommand` (TextCommands.cpp:30-50).
 *
 * Single Yjs transaction → one undo step.
 */
export function addTextCell(doc: Y.Doc, layerId: string, spec: AddTextSpec): void {
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yCells = layerData.get('textCells');
    if (!(yCells instanceof Y.Array)) return;
    // Text cells are Y.Maps, like every cell the .bbm import writes
    // (packages/ydoc textCellToYMap); the projection reads them with
    // Y.Map#get, so a plain object here made the whole doc unprojectable.
    yCells.push([
      textCellYMap({
        // Stable id for live-sync clients (doc schemaVersion 1).
        id: makeId(),
        displayArea: {
          x: spec.centreX - spec.widthStuds / 2,
          y: spec.centreY - spec.heightStuds / 2,
          width: spec.widthStuds,
          height: spec.heightStuds,
        },
        myGroup: '',
        text: spec.text,
        orientation: spec.orientation ?? 0,
        fontColor: spec.fontColor,
        font: spec.font,
        textAlignment: spec.textAlignment ?? 'Center',
      }),
    ]);
  }, LOCAL_ORIGIN);
}

function textCellYMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) y.set(k, v);
  return y;
}

/**
 * Apply `patch` to the text cell at `cellIndex`. Y.Map cells are edited
 * in place; a legacy plain-object cell (written by older web builds) is
 * replaced by an equivalent Y.Map. Either way a cell from a doc that
 * predates text-cell ids gets one here (lazy upgrade on edit).
 */
function patchTextCell(yCells: Y.Array<unknown>, cellIndex: number, patch: Record<string, unknown>): void {
  if (cellIndex < 0 || cellIndex >= yCells.length) return;
  const cell = yCells.get(cellIndex);
  if (cell instanceof Y.Map) {
    if (typeof cell.get('id') !== 'string') cell.set('id', makeId());
    for (const [k, v] of Object.entries(patch)) cell.set(k, v);
    return;
  }
  if (!cell || typeof cell !== 'object') return;
  const plain = cell as Record<string, unknown>;
  yCells.delete(cellIndex, 1);
  yCells.insert(cellIndex, [
    textCellYMap({ ...plain, id: typeof plain.id === 'string' ? plain.id : makeId(), ...patch }),
  ]);
}

/**
 * Edit an existing text cell's `text` field by index — port of
 * `EditTextCellTextCommand`. Still addressed by index (like desktop);
 * the cell's stable `id` is for live-sync clients.
 */
export function editTextCell(doc: Y.Doc, layerId: string, cellIndex: number, newText: string): void {
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yCells = layerData.get('textCells');
    if (!(yCells instanceof Y.Array)) return;
    patchTextCell(yCells, cellIndex, { text: newText });
  }, LOCAL_ORIGIN);
}

/** Move a text cell by (dx, dy) studs (BlueBrick's MoveText). */
export function moveTextCell(doc: Y.Doc, layerId: string, cellIndex: number, dx: number, dy: number): void {
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yCells = layerData.get('textCells');
    if (!(yCells instanceof Y.Array)) return;
    const cell = yCells.get(cellIndex);
    const area = (cell instanceof Y.Map ? cell.get('displayArea') : (cell as { displayArea?: unknown } | undefined)?.displayArea) as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (!area) return;
    patchTextCell(yCells, cellIndex, { displayArea: { ...area, x: area.x + dx, y: area.y + dy } });
  }, LOCAL_ORIGIN);
}

export interface EditTextCellPatch {
  text?: string;
  font?: { family: string; size: number; style: string };
  fontColor?: { kind: 'argb'; argb: string } | { kind: 'known'; name: string };
  orientation?: number;
}

/**
 * Edit all properties of a text cell — port of `EditTextCellCommand`.
 * Addressed by index (text cells have no GUID in the .bbm format).
 */
export function editTextCellFull(
  doc: Y.Doc,
  layerId: string,
  cellIndex: number,
  patch: EditTextCellPatch,
): void {
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yCells = layerData.get('textCells');
    if (!(yCells instanceof Y.Array)) return;
    const next: Record<string, unknown> = {};
    if (patch.text !== undefined) next.text = patch.text;
    if (patch.font !== undefined) next.font = { ...patch.font };
    if (patch.fontColor !== undefined) next.fontColor = { ...patch.fontColor };
    if (patch.orientation !== undefined) next.orientation = patch.orientation;
    patchTextCell(yCells, cellIndex, next);
  }, LOCAL_ORIGIN);
}

/**
 * Delete a text cell by index — port of `DeleteTextCellCommand`
 * (TextCommands.cpp). Text cells have no GUID so we address by index.
 */
export function deleteTextCell(doc: Y.Doc, layerId: string, cellIndex: number): void {
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yCells = layerData.get('textCells');
    if (!(yCells instanceof Y.Array)) return;
    if (cellIndex < 0 || cellIndex >= yCells.length) return;
    yCells.delete(cellIndex, 1);
  }, LOCAL_ORIGIN);
}

export interface EditBrickPatch {
  partNumber?: string;
  /** Top-left of displayArea (studs). */
  x?: number;
  y?: number;
  orientation?: number;
  altitude?: number;
  activeConnectionPointIndex?: number;
}

/**
 * Edit per-brick properties — port of `EditBrickCommand`
 * (EditCommands.cpp:264-289). Only fields present in `patch` change;
 * everything else stays put. Single Yjs transaction → one undo step.
 */
export function editBrick(
  doc: Y.Doc,
  layerId: string,
  brickId: string,
  patch: EditBrickPatch,
): void {
  // A new altitude may reorder the sheet, by z (doc shape 2).
  const before = findBrick(doc, layerId, brickId);
  if (before && patch.altitude !== undefined && patch.altitude !== before.get('altitude')) markShapeInPlace(doc);
  doc.transact(() => {
    const yBrick = findBrick(doc, layerId, brickId);
    if (!yBrick) return;
    if (patch.partNumber !== undefined) yBrick.set('partNumber', patch.partNumber);
    if (patch.orientation !== undefined) yBrick.set('orientation', mod360(patch.orientation));
    const newAltitude = patch.altitude !== undefined && patch.altitude !== yBrick.get('altitude');
    if (patch.altitude !== undefined) yBrick.set('altitude', patch.altitude);
    if (patch.activeConnectionPointIndex !== undefined) {
      yBrick.set('activeConnectionPointIndex', patch.activeConnectionPointIndex);
    }
    if (patch.x !== undefined || patch.y !== undefined) {
      const area = yBrick.get('displayArea') as RectangleF;
      yBrick.set('displayArea', {
        ...area,
        x: patch.x ?? area.x,
        y: patch.y ?? area.y,
      });
    }
    if (newAltitude) sortLayerByAltitude(doc, layerId);
  }, LOCAL_ORIGIN);
}

/**
 * Origin for UI-state writes that must sync and persist but are not
 * user edits, so the undo manager (tracking LOCAL_ORIGIN only) skips them.
 */
export const UI_STATE_ORIGIN = Symbol('cld-ui-state-origin');

/**
 * The map's "export electric circuits" choice (BlueBrick's
 * Map.ExportElectricCircuit, <ExportElectricCircuit> in the .bbm), saved
 * when an image is exported. Not an undo step (UI_STATE_ORIGIN).
 */
export function setExportElectricCircuit(doc: Y.Doc, on: boolean): void {
  const meta = doc.getMap('meta');
  const info = meta.get('exportInfo') as Record<string, unknown> | undefined;
  if (!info || info.exportElectricCircuit === on) return;
  doc.transact(() => meta.set('exportInfo', { ...info, exportElectricCircuit: on }), UI_STATE_ORIGIN);
}

/**
 * Persist the grab anchor: the connection the user clicked becomes the
 * brick's active connection point. Desktop `captureGrabAnchor` mutates
 * `activeConnectionPointIndex` in place without an undo command
 * (MapViewDrag.cpp:186-216) and BlueBrick saves it, so this writes under
 * UI_STATE_ORIGIN (synced, saved, not on the undo stack). No-op when
 * the value is unchanged.
 */
export function setActiveConnectionPoint(
  doc: Y.Doc,
  layerId: string,
  brickId: string,
  index: number,
): void {
  const yBrick = findBrick(doc, layerId, brickId);
  if (!yBrick || yBrick.get('activeConnectionPointIndex') === index) return;
  doc.transact(() => yBrick.set('activeConnectionPointIndex', index), UI_STATE_ORIGIN);
}

/**
 * Put a Y.Array of id'd maps into `targetIds` order, moving as few as
 * possible: the items on the longest run already in order stay; the rest
 * are taken out and put back at their new places. Yjs has no move (an item
 * is deleted and inserted again, which drops a concurrent edit to it), so
 * this keeps someone else's edits to every part that didn't need to move.
 * The desktop does the same (SyncDoc::syncItems). Call inside a transaction.
 */
function reorderYItems(yArr: Y.Array<unknown>, targetIds: readonly string[]): void {
  const cur = yArr.toArray().map(itemId);
  if (cur.length !== targetIds.length || cur.every((id, i) => id === targetIds[i])) return;
  const want = new Map(targetIds.map((id, i) => [id, i] as const));
  const seq = cur.map((id) => want.get(id) ?? -1);
  // Longest increasing run (patience sort).
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) keep.add(k);
  // Copy the movers first (a deleted Y.Map reads as empty), then take them out.
  // (Text cells are Y.Maps, or plain objects in old docs.)
  const movers = new Map<string, { json: Record<string, unknown>; map: boolean }>();
  for (let i = 0; i < cur.length; i++) {
    if (keep.has(i)) continue;
    const m = yArr.get(i);
    if (m instanceof Y.Map) movers.set(cur[i]!, { json: m.toJSON() as Record<string, unknown>, map: true });
    else if (m && typeof m === 'object') movers.set(cur[i]!, { json: { ...(m as Record<string, unknown>) }, map: false });
  }
  for (let i = cur.length - 1; i >= 0; i--) if (!keep.has(i)) yArr.delete(i, 1);
  targetIds.forEach((id, pos) => {
    const mover = movers.get(id);
    if (!mover) return;
    if (!mover.map) {
      yArr.insert(pos, [mover.json]);
      return;
    }
    const y = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(mover.json)) y.set(k, v);
    yArr.insert(pos, [y]);
  });
}

function itemId(item: unknown): string {
  if (item instanceof Y.Map) return (item.get('id') as string) ?? '';
  return item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : '';
}

/**
 * Bring to Front / Send to Back for text and rulers too, as BlueBrick does
 * (BringTextToFront, BringRulerToFront, ...): each picked one moves to the
 * end (front) or start (back) of its sheet, keeping their order. `texts`
 * are text keys (sheet#index); the new keys are returned, as the indexes
 * change. One transaction.
 */
export function reorderAnnotations(
  doc: Y.Doc,
  picked: { texts: readonly string[]; rulers: readonly string[] },
  to: 'front' | 'back',
): string[] {
  const rulerIds = new Set(picked.rulers);
  const textsByLayer = new Map<string, Set<number>>();
  for (const key of picked.texts) {
    const at = key.lastIndexOf('#');
    if (at <= 0) continue;
    const layerId = key.slice(0, at);
    const set = textsByLayer.get(layerId) ?? new Set<number>();
    set.add(Number(key.slice(at + 1)));
    textsByLayer.set(layerId, set);
  }
  const newKeys: string[] = [];
  if (rulerIds.size) {
    for (const lid of doc.getArray<string>('layers').toArray()) {
      const layer = doc.getMap('layerData').get(lid);
      if (layer instanceof Y.Map && layer.get('type') === 'ruler') rulersInPlace(doc, layer);
    }
  }
  doc.transact(() => {
    for (const lid of doc.getArray<string>('layers').toArray()) {
      const layer = doc.getMap('layerData').get(lid);
      if (!(layer instanceof Y.Map)) continue;
      const order = (arr: Y.Array<unknown>, moving: (id: string, i: number) => boolean) => {
        const ids = arr.toArray().map(itemId);
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return [] as string[];
        const move = ids.filter((id, i) => moving(id, i));
        if (move.length === 0) return [];
        const stay = ids.filter((id, i) => !moving(id, i));
        reorderYItems(arr, to === 'front' ? [...stay, ...move] : [...move, ...stay]);
        return move;
      };
      // Rulers by z, in place (shape 2): a concurrent edit or delete stays.
      const rulers = layer.get('rulerItems');
      if (rulerIds.size && rulers instanceof Y.Array) {
        const ids = itemsInOrder(rulers as Y.Array<unknown>).map(itemId);
        const move = ids.filter((id) => rulerIds.has(id));
        if (move.length && !ids.some((id) => !id) && new Set(ids).size === ids.length) {
          const stay = ids.filter((id) => !rulerIds.has(id));
          reorderByZ(rulers as Y.Array<unknown>, to === 'front' ? [...stay, ...move] : [...move, ...stay]);
        }
      }
      const cells = layer.get('textCells');
      const indexes = textsByLayer.get(lid);
      if (indexes && cells instanceof Y.Array) {
        const moved = new Set(order(cells as Y.Array<unknown>, (_id, i) => indexes.has(i)));
        (cells as Y.Array<unknown>).toArray().forEach((c, i) => {
          if (moved.has(itemId(c))) newKeys.push(`${lid}#${i}`);
        });
      }
    }
  }, LOCAL_ORIGIN);
  return newKeys;
}

/**
 * Bring-to-front / send-to-back — port of desktop's
 * `ReorderBricksCommand` (EditCommands.cpp). Repositions every brick in
 * `brickIds` within its own layer's `bricks` Y.Array (any layer) so it sits at the
 * front (last index = top z) or back (index 0 = bottom z). Within-group
 * order is preserved.
 *
 * Wraps in a single Yjs transaction so undo treats the whole reorder
 * as one step.
 */
export function reorderBricks(
  doc: Y.Doc,
  brickIds: string[],
  to: 'front' | 'back',
): void {
  if (brickIds.length === 0) return;
  const idSet = new Set(brickIds);
  // By z, in place (doc shape 2): the parts keep their entries, so someone
  // else deleting or dragging one at the same time isn't undone.
  markShapeInPlace(doc);
  doc.transact(() => {
    // Reorder within each layer that contains any of the selected bricks.
    // Iterating all layers handles cross-layer selections correctly.
    const layerOrder = doc.getArray<string>('layers');
    for (const lid of layerOrder.toArray()) {
      const layerData = doc.getMap('layerData').get(lid);
      if (!(layerData instanceof Y.Map)) continue;
      const yBricks = layerData.get('bricks');
      if (!(yBricks instanceof Y.Array)) continue;
      const ids = itemsInOrder(yBricks as Y.Array<unknown>).map(itemId);
      const movingIds = ids.filter((id) => idSet.has(id));
      if (movingIds.length === 0) continue;
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) continue;
      const stationary = ids.filter((id) => !idSet.has(id));
      reorderByZ(yBricks as Y.Array<unknown>, to === 'front' ? [...stationary, ...movingIds] : [...movingIds, ...stationary]);
    }
  }, LOCAL_ORIGIN);
}

/**
 * Move bricks to another part sheet (`targetLayerId`), on top of what's
 * there. A group goes with them when all of its parts do (with its own
 * group, and so on up); a part whose group stays behind leaves it. Links
 * are rebuilt from the parts' places, so parts moved together stay
 * linked and links to parts left behind go. Ids are kept, so modules,
 * labels and rulers still find the parts. One transaction.
 */
export function moveBricksToLayer(doc: Y.Doc, byLayer: Map<string, string[]>, targetLayerId: string): number {
  const layerData = doc.getMap('layerData');
  const target = layerData.get(targetLayerId);
  if (!(target instanceof Y.Map) || target.get('type') !== 'brick') return 0;
  let moved = 0;
  doc.transact(() => {
    let tBricks = target.get('bricks');
    if (!(tBricks instanceof Y.Array)) {
      tBricks = new Y.Array<Y.Map<unknown>>();
      target.set('bricks', tBricks);
    }
    let tGroups = target.get('groups');
    if (!(tGroups instanceof Y.Array)) {
      tGroups = new Y.Array<Y.Map<unknown>>();
      target.set('groups', tGroups);
    }
    for (const [layerId, ids] of byLayer) {
      if (layerId === targetLayerId || ids.length === 0) continue;
      const src = layerData.get(layerId);
      if (!(src instanceof Y.Map) || src.get('type') !== 'brick') continue;
      const yBricks = src.get('bricks');
      const yGroups = src.get('groups');
      if (!(yBricks instanceof Y.Array)) continue;
      const idSet = new Set(ids);
      const all = yBricks.toArray().filter((b): b is Y.Map<unknown> => b instanceof Y.Map);
      const groups = yGroups instanceof Y.Array ? yGroups.toArray().filter((g): g is Y.Map<unknown> => g instanceof Y.Map) : [];
      const parentOf = new Map(groups.map((g) => [g.get('id') as string, ((g.get('myGroup') as string) ?? '') || '']));
      // A group goes when every part under it (at any depth) does.
      const chain = (g: string): string[] => {
        const out: string[] = [];
        for (let c = g; c && !out.includes(c); c = parentOf.get(c) ?? '') out.push(c);
        return out;
      };
      const stays = new Set<string>();
      for (const b of all) {
        if (idSet.has(b.get('id') as string)) continue;
        for (const g of chain((b.get('myGroup') as string) ?? '')) stays.add(g);
      }
      const goes = new Set<string>();
      for (const b of all) {
        if (!idSet.has(b.get('id') as string)) continue;
        for (const g of chain((b.get('myGroup') as string) ?? '')) if (!stays.has(g)) goes.add(g);
      }
      const copy = (m: Y.Map<unknown>): Y.Map<unknown> => {
        const y = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(m.toJSON() as Record<string, unknown>)) if (k !== 'z') y.set(k, v); // z: its place on the new sheet
        return y;
      };
      // Copied before the originals go (a deleted Y.Map reads as empty).
      const newGroups: Y.Map<unknown>[] = [];
      for (const g of groups) {
        if (!goes.has(g.get('id') as string)) continue;
        // (Read from the original: a Y.Map not yet in the doc reads as empty.)
        const y = copy(g);
        if (!goes.has(((g.get('myGroup') as string) ?? '') || '')) y.set('myGroup', '');
        newGroups.push(y);
      }
      const newBricks: Y.Map<unknown>[] = [];
      for (const b of all) {
        if (!idSet.has(b.get('id') as string)) continue;
        const y = copy(b);
        if (!goes.has(((b.get('myGroup') as string) ?? '') || '')) y.set('myGroup', '');
        // Keep each connection point (its id), unlinked, like the desktop
        // (MoveBricksToLayerCommand); the connectivity pass links them again.
        const conns = (b.get('connexions') as { id: string; linkedTo: string }[] | undefined) ?? [];
        y.set('connexions', conns.map((c) => ({ ...c, linkedTo: '' })));
        newBricks.push(y);
      }
      for (let i = yBricks.length - 1; i >= 0; i--) {
        const b = yBricks.get(i);
        if (!(b instanceof Y.Map) || !idSet.has(b.get('id') as string)) continue;
        yBricks.delete(i, 1);
      }
      if (newGroups.length) tGroups.push(newGroups);
      if (newBricks.length) pushOnTop(tBricks as Y.Array<unknown>, newBricks);
      moved += newBricks.length;
      if (yGroups instanceof Y.Array) {
        for (let i = yGroups.length - 1; i >= 0; i--) {
          const g = yGroups.get(i);
          if (g instanceof Y.Map && goes.has(g.get('id') as string)) yGroups.delete(i, 1);
        }
      }
    }
  }, LOCAL_ORIGIN);
  return moved;
}

/**
 * Group every brick in `brickIds` under a freshly-minted group id.
 * Mirrors desktop's `GroupBricksCommand` (EditCommands.cpp:290-355):
 * one new Group entry per layer, every brick's `myGroup` points at it.
 *
 * Single transaction → one undo step.
 */
export function groupBricks(doc: Y.Doc, layerId: string, brickIds: string[]): string | null {
  if (brickIds.length < 2) return null;
  const groupId = makeId();
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yBricks = layerData.get('bricks');
    if (!(yBricks instanceof Y.Array)) return;
    const yGroups = layerData.get('groups');
    if (!(yGroups instanceof Y.Array)) return;

    const newGroup = new Y.Map<unknown>();
    newGroup.set('id', groupId);
    yGroups.push([newGroup]);

    const idSet = new Set(brickIds);
    for (let i = 0; i < yBricks.length; i++) {
      const b = yBricks.get(i);
      if (b instanceof Y.Map && idSet.has(b.get('id') as string)) {
        b.set('myGroup', groupId);
      }
    }
  }, LOCAL_ORIGIN);
  return groupId;
}

/**
 * Clear every selected brick's `myGroup`, then drop any group entries
 * that no longer have any members. Port of `UngroupBricksCommand`
 * (EditCommands.cpp:357-...).
 */
export function ungroupBricks(doc: Y.Doc, layerId: string, brickIds: string[]): void {
  if (brickIds.length === 0) return;
  doc.transact(() => {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) return;
    const yBricks = layerData.get('bricks');
    if (!(yBricks instanceof Y.Array)) return;
    const yGroups = layerData.get('groups');
    if (!(yGroups instanceof Y.Array)) return;

    const affectedGroups = new Set<string>();
    const idSet = new Set(brickIds);
    for (let i = 0; i < yBricks.length; i++) {
      const b = yBricks.get(i);
      if (!(b instanceof Y.Map)) continue;
      if (!idSet.has(b.get('id') as string)) continue;
      const prior = (b.get('myGroup') as string) ?? '';
      if (prior) affectedGroups.add(prior);
      b.set('myGroup', '');
    }

    if (affectedGroups.size === 0) return;
    // Recompute which groups still have at least one member; drop the
    // empty ones from `groups` array (desktop ReorderBricksCommand path).
    const stillUsed = new Set<string>();
    for (let i = 0; i < yBricks.length; i++) {
      const b = yBricks.get(i);
      if (b instanceof Y.Map) {
        const g = (b.get('myGroup') as string) ?? '';
        if (g) stillUsed.add(g);
      }
    }
    for (let i = yGroups.length - 1; i >= 0; i--) {
      const g = yGroups.get(i);
      if (g instanceof Y.Map) {
        const id = g.get('id') as string;
        if (affectedGroups.has(id) && !stillUsed.has(id)) {
          yGroups.delete(i, 1);
        }
      }
    }
  }, LOCAL_ORIGIN);
}

/**
 * A part sheet's bricks in altitude order, lowest first, equal ones keeping
 * their order: BlueBrick's LayerBrick.sortBricksByElevation after an
 * altitude edit, so higher parts draw over lower ones while Bring to Front
 * still decides among equals. Call inside a transaction.
 */
function sortLayerByAltitude(doc: Y.Doc, layerId: string): void {
  const layerData = doc.getMap('layerData').get(layerId);
  if (!(layerData instanceof Y.Map)) return;
  const yBricks = layerData.get('bricks');
  if (!(yBricks instanceof Y.Array)) return;
  const all = itemsInOrder(yBricks as Y.Array<unknown>).filter((b): b is Y.Map<unknown> => b instanceof Y.Map);
  const alt = (b: Y.Map<unknown>) => (typeof b.get('altitude') === 'number' ? (b.get('altitude') as number) : 0);
  const sorted = all.map((b, i) => [b, i] as const).sort((a, c) => alt(a[0]) - alt(c[0]) || a[1] - c[1]);
  if (sorted.every(([, i], k) => i === k)) return;
  // By z, in place (doc shape 2): the caller marks the doc first.
  reorderByZ(yBricks as Y.Array<unknown>, sorted.map(([b]) => b.get('id') as string));
}

/** Normalise to [0, 360) without losing fractional precision. */
function mod360(v: number): number {
  const r = v % 360;
  return r < 0 ? r + 360 : r;
}

function findBrick(doc: Y.Doc, layerId: string, brickId: string): Y.Map<unknown> | null {
  const layerData = doc.getMap('layerData').get(layerId);
  if (!(layerData instanceof Y.Map)) return null;
  const bricks = layerData.get('bricks');
  if (!(bricks instanceof Y.Array)) return null;
  for (let i = 0; i < bricks.length; i++) {
    const b = bricks.get(i);
    if (b instanceof Y.Map && b.get('id') === brickId) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Initialisers — used when starting from a blank layout and the user does
// their first interaction. We seed minimal defaults for layers / fonts.
// ---------------------------------------------------------------------------

export type LayerKind = 'grid' | 'brick' | 'area' | 'text' | 'ruler';

const NEW_LAYER_DEFAULTS: Record<LayerKind, { name: string; extraFields: () => Record<string, unknown> }> = {
  // Desktop LayerGrid defaults (core/LayerGrid.h:20-38): half-transparent
  // black lines, 32-stud cells, 4 sub-divisions, no cell index.
  grid: {
    name: 'Grid',
    extraFields: () => ({
      gridColor: { kind: 'argb', argb: '80000000' } satisfies ColorSpec,
      gridThickness: 2,
      subGridColor: { kind: 'argb', argb: '40000000' } satisfies ColorSpec,
      subGridThickness: 1,
      gridSizeInStud: 32,
      subDivisionNumber: 4,
      displayGrid: true,
      displaySubGrid: true,
      displayCellIndex: false,
      cellIndexFont: { family: 'Microsoft Sans Serif', size: 8.25, style: 'Regular' } satisfies FontSpec,
      cellIndexColor: { kind: 'known', name: 'Black' } satisfies ColorSpec,
      cellIndexColumnType: '0',
      cellIndexRowType: '1',
      // An {x, y} point (desktop LayerGrid.h): the server refuses any other
      // shape, so a '' here once made adding a grid sheet close the connection.
      cellIndexCorner: { x: 0, y: 0 },
    }),
  },
  brick: {
    name: 'Parts',
    extraFields: () => ({
      displayBrickElevation: false,
      bricks: new Y.Array<Y.Map<unknown>>(),
    }),
  },
  area: {
    name: 'Area',
    extraFields: () => ({
      areaCellSize: AREA_CELL_SIZE_DEFAULT,
      areas: new Y.Array<{ x: number; y: number; color: string }>(),
    }),
  },
  text: {
    name: 'Text',
    extraFields: () => ({ textCells: new Y.Array() }),
  },
  ruler: {
    name: 'Ruler',
    extraFields: () => ({ rulerItems: new Y.Array() }),
  },
};

/**
 * Unconditionally create a new layer of the given kind and return its id.
 * Unlike the `ensure*Layer` initialisers below (which are idempotent —
 * used to lazily seed a blank doc on first interaction), this always adds
 * a fresh layer, disambiguating the default name against existing layers
 * of the same kind (e.g. "Parts", "Parts 2", "Parts 3", ...).
 */
export function addLayer(doc: Y.Doc, kind: LayerKind): string {
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  const defaults = NEW_LAYER_DEFAULTS[kind];
  const existingNames = new Set(
    layerOrder
      .toArray()
      .map((id) => layerData.get(id))
      .filter((l): l is Y.Map<unknown> => l instanceof Y.Map && l.get('type') === kind)
      .map((l) => l.get('name')),
  );
  let name = defaults.name;
  for (let n = 2; existingNames.has(name); n++) name = `${defaults.name} ${n}`;

  const id = makeId();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    if (meta.get('version') === undefined) seedDefaultMeta(meta);
    const yLayer = new Y.Map<unknown>();
    yLayer.set('id', id);
    yLayer.set('type', kind);
    yLayer.set('name', name);
    yLayer.set('visible', true);
    yLayer.set('transparency', 100);
    yLayer.set('hullProperties', {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' } satisfies ColorSpec,
      hullThickness: 1,
    });
    for (const [k, v] of Object.entries(defaults.extraFields())) yLayer.set(k, v);
    yLayer.set('groups', new Y.Array<Y.Map<unknown>>());
    layerData.set(id, yLayer);
    layerOrder.push([id]);
  }, LOCAL_ORIGIN);
  return id;
}

export function ensureBrickLayer(doc: Y.Doc): string {
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  for (const id of layerOrder.toArray()) {
    const l = layerData.get(id);
    if (l instanceof Y.Map && l.get('type') === 'brick') return id;
  }
  // No brick layer exists — create one. Include a meta header if the doc
  // is fully empty so docToBbm doesn't trip on a missing version.
  const meta = doc.getMap('meta');
  doc.transact(() => {
    if (meta.get('version') === undefined) seedDefaultMeta(meta);
    const layerId = makeId();
    const yLayer = new Y.Map<unknown>();
    yLayer.set('id', layerId);
    yLayer.set('type', 'brick');
    yLayer.set('name', 'Parts');
    yLayer.set('visible', true);
    yLayer.set('transparency', 100);
    yLayer.set('hullProperties', {
      isVisible: false,
      hullColor: { kind: 'known', name: 'Black' } satisfies ColorSpec,
      hullThickness: 1,
    });
    yLayer.set('displayBrickElevation', false);
    yLayer.set('bricks', new Y.Array<Y.Map<unknown>>());
    yLayer.set('groups', new Y.Array<Y.Map<unknown>>());
    layerData.set(layerId, yLayer);
    layerOrder.push([layerId]);
  }, LOCAL_ORIGIN);
  return ensureBrickLayer(doc); // re-resolve the id after the transaction
}

function seedDefaultMeta(meta: Y.Map<unknown>): void {
  const today = new Date();
  meta.set('version', 9);
  meta.set('nbItems', 0);
  meta.set('backgroundColor', { kind: 'known', name: 'White' } satisfies ColorSpec);
  meta.set('author', '');
  meta.set('lug', '');
  meta.set('event', '');
  meta.set('date', {
    day: today.getDate(),
    month: today.getMonth() + 1,
    year: today.getFullYear(),
  });
  meta.set('comment', '');
  meta.set('exportInfo', {
    exportPath: '',
    exportFileType: 4,
    exportArea: { x: 0, y: 0, width: 0, height: 0 },
    exportScale: 0,
    exportWatermark: true,
    exportElectricCircuit: false,
    exportConnectionPoints: false,
  });
  meta.set('selectedLayerIndex', 0);
  meta.set('schemaVersion', DOC_BASE_SCHEMA);
}

// ---------------------------------------------------------------------------
// Sidecar — anchored label mutations
//
// The sidecar blob is stored as `meta.cache` (a plain JS object). Label
// mutations read it, patch the `anchoredLabels` array, and write it back in
// a Yjs transaction. This is last-write-wins at the sidecar level — the same
// trade-off accepted by venue + module sidecar entries — but correct for
// typical single-user editing sessions.
// ---------------------------------------------------------------------------

function readSidecarCache(doc: Y.Doc): Record<string, unknown> {
  // Everyone's modules and labels (@cld/ydoc keeps them one per key, so
  // concurrent edits merge). A layout's first label, view or venue starts
  // the sidecar: give it the fields every sidecar file has, or the
  // downloaded file won't open again.
  const base = readMergedSidecar(doc) ?? {};
  return { schemaVersion: 1, bbmHashSha256: '', ...base };
}

function writeSidecarCache(doc: Y.Doc, cache: Record<string, unknown>): void {
  writeMergedSidecar(doc, cache);
}

export function addAnchoredLabel(doc: Y.Doc, label: AnchoredLabel): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const existing = Array.isArray(cache.anchoredLabels) ? (cache.anchoredLabels as AnchoredLabel[]) : [];
    writeSidecarCache(doc, { ...cache, anchoredLabels: [...existing, label] });
  }, LOCAL_ORIGIN);
}

export function editAnchoredLabel(doc: Y.Doc, id: string, patch: Partial<AnchoredLabel>): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const existing = Array.isArray(cache.anchoredLabels) ? (cache.anchoredLabels as AnchoredLabel[]) : [];
    writeSidecarCache(doc, {
      ...cache,
      anchoredLabels: existing.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  }, LOCAL_ORIGIN);
}

export function deleteAnchoredLabel(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const existing = Array.isArray(cache.anchoredLabels) ? (cache.anchoredLabels as AnchoredLabel[]) : [];
    writeSidecarCache(doc, {
      ...cache,
      anchoredLabels: existing.filter((l) => l.id !== id),
    });
  }, LOCAL_ORIGIN);
}

export function moveAnchoredLabel(doc: Y.Doc, id: string, dx: number, dy: number): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const existing = Array.isArray(cache.anchoredLabels) ? (cache.anchoredLabels as AnchoredLabel[]) : [];
    writeSidecarCache(doc, {
      ...cache,
      anchoredLabels: existing.map((l) =>
        l.id === id ? { ...l, offset: { x: l.offset.x + dx, y: l.offset.y + dy } } : l,
      ),
    });
  }, LOCAL_ORIGIN);
}

// ---------------------------------------------------------------------------
// Sidecar — saved views (same pattern: a whole view is replaced at once,
// so the last edit of a view wins; views are kept in list order)
// ---------------------------------------------------------------------------

function getSidecarViews(cache: Record<string, unknown>): SavedView[] {
  return Array.isArray(cache.views) ? (cache.views as SavedView[]) : [];
}

/** The layout's saved views, in list order. */
export function readSavedViews(doc: Y.Doc): SavedView[] {
  return getSidecarViews(readSidecarCache(doc));
}

export function addSavedView(doc: Y.Doc, view: SavedView): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, { ...cache, views: [...getSidecarViews(cache), view] });
  }, LOCAL_ORIGIN);
}

/** Change one view; the other views are left as they are. */
export function updateSavedView(doc: Y.Doc, id: string, patch: Partial<Omit<SavedView, 'id'>>): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const views = getSidecarViews(cache);
    if (!views.some((v) => v.id === id)) return;
    writeSidecarCache(doc, { ...cache, views: views.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  }, LOCAL_ORIGIN);
}

export function deleteSavedView(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, { ...cache, views: getSidecarViews(cache).filter((v) => v.id !== id) });
  }, LOCAL_ORIGIN);
}

// ---------------------------------------------------------------------------
// Sidecar — module mutations (same last-write-wins pattern as labels)
// ---------------------------------------------------------------------------

function getSidecarModules(cache: Record<string, unknown>): SidecarModule[] {
  return Array.isArray(cache.modules) ? (cache.modules as SidecarModule[]) : [];
}

export function addSidecarModule(doc: Y.Doc, module: SidecarModule): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, { ...cache, modules: [...getSidecarModules(cache), module] });
  }, LOCAL_ORIGIN);
}

/**
 * Register the given bricks as a new sidecar module — desktop
 * `CreateModuleCommand` (ModuleCommands.cpp:38-58), reached from
 * Modules ▸ Create from Selection (MainWindow.cpp:1056). The bricks stay
 * where they are; only the module entry is added. Returns its id, or
 * null when there is nothing to group.
 */
export function createSidecarModule(doc: Y.Doc, name: string, memberIds: string[]): string | null {
  const members = [...new Set(memberIds)];
  if (members.length === 0) return null;
  const id = makeId();
  addSidecarModule(doc, {
    id,
    name: name.trim() || 'New Module',
    members,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  });
  return id;
}

/**
 * Place a set as BlueBrick does: its bricks and its groups (one named
 * group, nested sets as child groups), never a module — the desktop's
 * MapView::addPartAtScenePos. One undo step; returns the new brick ids.
 */
export function insertSet(doc: Y.Doc, layerId: string, set: ExpandedSet): string[] {
  let ids: string[] = [];
  doc.transact(() => {
    ids = insertBricks(doc, layerId, set.bricks, { dx: 0, dy: 0 }, set.groups);
  }, LOCAL_ORIGIN);
  return ids;
}

/**
 * Modules older versions made of placed sets become sets again: each
 * module is removed and its parts get the set's groups — the desktop's
 * makeSetsCommand. Loose sets (findLooseSets) have no module to remove.
 * One undo step.
 */
export function makeSetsOfModules(doc: Y.Doc, sets: readonly SetModule[]): void {
  if (sets.length === 0) return;
  doc.transact(() => {
    const gone = new Set(sets.map((s) => s.moduleId));
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, { ...cache, modules: getSidecarModules(cache).filter((m) => !gone.has(m.id)) });
    for (const set of sets) {
      const layerData = doc.getMap('layerData').get(set.layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const g = readGrouping(layerData);
      if (!g) continue;
      for (const group of set.groups) {
        const yGroup = new Y.Map<unknown>();
        yGroup.set('id', group.id);
        if (group.partNumber !== undefined) yGroup.set('partNumber', group.partNumber);
        yGroup.set('myGroup', group.myGroup ?? '');
        g.yGroups.push([yGroup]);
      }
      g.yBricks.forEach((b) => {
        if (!(b instanceof Y.Map)) return;
        const to = set.parentOf.get(b.get('id') as string);
        // A part grouped meanwhile (someone else made it a set first) keeps its group.
        if (to && !b.get('myGroup')) b.set('myGroup', to);
      });
    }
  }, LOCAL_ORIGIN);
}

/** One source brick layer of a module file — desktop `LayerBatch`. */
export interface ModuleBatch {
  layerName: string;
  bricks: Array<{
    partNumber: string;
    displayArea: RectangleF;
    orientation?: number;
    altitude?: number;
    myGroup?: string;
  }>;
  /** The source layer's groups: the sets in the module stay sets. */
  groups?: Group[];
}

/**
 * Insert a module's bricks and register them as a sidecar module in ONE
 * transaction — desktop `ImportBbmAsModuleCommand` (ModuleCommands.cpp:451-506).
 * Each batch lands on the host brick layer with the same name (ignoring
 * case and spaces at either end), so the module keeps its layering
 * (tracks stay above scenery). A batch with no such sheet goes where
 * `opts.sheets` says (the answer to "Where should these go?",
 * moduleSheets.ts): an existing sheet, or a new one by a given name.
 * Without an answer it gets a new sheet with its own name. Returns the
 * module id and the new brick ids.
 */
export function importBricksAsModule(
  doc: Y.Doc,
  batches: ModuleBatch[],
  opts: {
    name: string;
    offset?: { dx: number; dy: number };
    sourceFile?: string;
    sheets?: SheetChoices;
    /** From the library: the module is linked to it (Update from library, Update library version). */
    library?: { id: string; version?: number };
  },
): { moduleId: string; ids: string[] } | null {
  const nonEmpty = batches.filter((b) => b.bricks.length > 0);
  if (nonEmpty.length === 0) return null;
  const moduleId = makeId();
  const ids: string[] = [];
  doc.transact(() => {
    const layerData = doc.getMap('layerData');
    const sheets = () =>
      doc
        .getArray<string>('layers')
        .toArray()
        .map((id) => layerData.get(id))
        .filter((l): l is Y.Map<unknown> => l instanceof Y.Map)
        .map((l) => ({ id: l.get('id') as string, name: (l.get('name') as string) ?? '', type: l.get('type') as Layer['type'] }));
    const findOrMake = (name: string): string => {
      const found = findPartsSheet(sheets(), name);
      if (found) return found;
      const id = addLayer(doc, 'brick');
      renameLayer(doc, id, name);
      return id;
    };
    for (const batch of nonEmpty) {
      const name = batch.layerName || 'Module';
      let layerId = findPartsSheet(sheets(), name);
      if (!layerId) {
        const choice = opts.sheets?.[name];
        if (choice && 'layerId' in choice && layerData.get(choice.layerId) instanceof Y.Map) layerId = choice.layerId;
        else layerId = findOrMake(choice && 'newName' in choice ? choice.newName : name);
      }
      const copied = cloneGroups(batch.groups ?? [], batch.bricks, makeId);
      ids.push(...insertBricks(doc, layerId, copied.bricks, opts.offset, copied.groups));
    }
    const cache = readSidecarCache(doc);
    const mod: SidecarModule = {
      id: moduleId,
      name: opts.name || 'Module',
      members: ids,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      importedAt: new Date().toISOString(),
      ...(opts.sourceFile ? { sourceFile: opts.sourceFile } : {}),
      ...(opts.library ? { libraryModuleId: opts.library.id } : {}),
      ...(opts.library?.version ? { libraryVersion: opts.library.version } : {}),
    };
    writeSidecarCache(doc, { ...cache, modules: [...getSidecarModules(cache), mod] });
  }, LOCAL_ORIGIN);
  return { moduleId, ids };
}

export function renameSidecarModule(doc: Y.Doc, id: string, name: string): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, {
      ...cache,
      modules: getSidecarModules(cache).map((m) => (m.id === id ? { ...m, name } : m)),
    });
  }, LOCAL_ORIGIN);
}

export function deleteSidecarModule(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, {
      ...cache,
      modules: getSidecarModules(cache).filter((m) => m.id !== id),
    });
  }, LOCAL_ORIGIN);
}

/**
 * Delete a module and its parts on every sheet, in one undo step (the
 * Modules panel's Delete; Ungroup keeps the parts).
 */
export function deleteModuleWithParts(doc: Y.Doc, id: string): void {
  const module = getSidecarModules(readSidecarCache(doc)).find((m) => m.id === id);
  if (!module) return;
  const members = new Set(module.members);
  doc.transact(() => {
    for (const layerId of doc.getArray<string>('layers').toArray()) {
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const bricks = layerData.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      const ids: string[] = [];
      bricks.forEach((b) => {
        if (b instanceof Y.Map && members.has(b.get('id') as string)) ids.push(b.get('id') as string);
      });
      if (ids.length > 0) deleteBricks(doc, layerId, ids);
    }
    deleteSidecarModule(doc, id);
  }, LOCAL_ORIGIN);
}

/**
 * Replace the member list for a sidecar module — used after Flatten
 * removes bricks or Rescan re-discovers them.
 */
export function setSidecarModuleMembers(doc: Y.Doc, id: string, members: string[]): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, {
      ...cache,
      modules: getSidecarModules(cache).map((m) => (m.id === id ? { ...m, members } : m)),
    });
  }, LOCAL_ORIGIN);
}

/**
 * Flatten a module — unregisters it from the sidecar while leaving its
 * member bricks in place. Mirrors `FlattenModuleCommand` (ModuleCommands.cpp).
 */
export function flattenSidecarModule(doc: Y.Doc, id: string): void {
  deleteSidecarModule(doc, id);
}

/**
 * Translate all member bricks of a sidecar module by (dx, dy) studs.
 * Scans all layers — mirrors MoveModuleCommand (ModuleCommands.cpp:89-101).
 */
export function moveModuleBricks(
  doc: Y.Doc,
  memberIds: string[],
  dxStuds: number,
  dyStuds: number,
): void {
  if (memberIds.length === 0 || (dxStuds === 0 && dyStuds === 0)) return;
  const idSet = new Set(memberIds);
  const layerOrder = doc.getArray<string>('layers');
  doc.transact(() => {
    for (const layerId of layerOrder.toArray()) {
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const bricks = layerData.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      for (let i = 0; i < bricks.length; i++) {
        const b = bricks.get(i);
        if (!(b instanceof Y.Map) || !idSet.has(b.get('id') as string)) continue;
        const area = b.get('displayArea') as RectangleF;
        b.set('displayArea', { ...area, x: area.x + dxStuds, y: area.y + dyStuds });
      }
    }
  }, LOCAL_ORIGIN);
}

/**
 * Rotate all member bricks of a sidecar module by `degrees` around their
 * pivot, on every sheet (RotateModuleCommand, ModuleCommands.cpp:125-183).
 * The same turn as rotating the picked parts: each displayArea follows the
 * turned footprint, so BlueBrick shows the parts where this app does.
 * One undo step.
 */
export function rotateModuleBricks(
  doc: Y.Doc,
  memberIds: string[],
  degrees: number,
  partOf: (partNumber: string) => PartGeom | undefined = () => undefined,
): void {
  if (memberIds.length === 0 || degrees === 0) return;
  const idSet = new Set(memberIds);
  const byLayer = new Map<string, string[]>();
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) continue;
    const bricks = layerData.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    const ids: string[] = [];
    bricks.forEach((b) => {
      if (b instanceof Y.Map && idSet.has(b.get('id') as string)) ids.push(b.get('id') as string);
    });
    if (ids.length > 0) byLayer.set(layerId, ids);
  }
  rotateBricksAboutCentroid(doc, byLayer, degrees, partOf);
}

/**
 * Update arbitrary fields on a sidecar module entry (e.g. sourceFile after
 * Save to Library). Mirrors the pattern of renameSidecarModule.
 */
export function patchSidecarModule(
  doc: Y.Doc,
  id: string,
  patch: Partial<SidecarModule>,
): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, {
      ...cache,
      modules: getSidecarModules(cache).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }, LOCAL_ORIGIN);
}

/**
 * Replace one sidecar module entry with what `change` makes of it (its
 * look, pin, …), in one undo step. Nothing happens for an unknown id.
 */
export function updateSidecarModule(doc: Y.Doc, id: string, change: (m: SidecarModule) => SidecarModule): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    const modules = getSidecarModules(cache);
    if (!modules.some((m) => m.id === id)) return;
    writeSidecarCache(doc, { ...cache, modules: modules.map((m) => (m.id === id ? change(m) : m)) });
  }, LOCAL_ORIGIN);
}

/**
 * Clone a module — duplicate every member brick across all layers with fresh
 * IDs, offset by the module's bounding-box width + 2 studs, and register a
 * new sidecar module entry. Mirrors CloneModuleCommand (ModuleCommands.cpp:232-300).
 */
export function cloneModuleBricks(doc: Y.Doc, module: SidecarModule): void {
  if (module.members.length === 0) return;
  const idSet = new Set(module.members);
  const layerOrder = doc.getArray<string>('layers');

  // Compute bounding box to determine offset.
  let minX = Infinity, maxX = -Infinity;
  for (const layerId of layerOrder.toArray()) {
    const layerData = doc.getMap('layerData').get(layerId);
    if (!(layerData instanceof Y.Map)) continue;
    const bricks = layerData.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks.get(i);
      if (!(b instanceof Y.Map) || !idSet.has(b.get('id') as string)) continue;
      const area = b.get('displayArea') as RectangleF;
      minX = Math.min(minX, area.x);
      maxX = Math.max(maxX, area.x + area.width);
    }
  }
  const offsetX = Number.isFinite(maxX) ? maxX - minX + 2 : 4;

  const newMemberIds: string[] = [];
  doc.transact(() => {
    for (const layerId of layerOrder.toArray()) {
      const layerData = doc.getMap('layerData').get(layerId);
      if (!(layerData instanceof Y.Map)) continue;
      const bricks = layerData.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      // Snapshot so we don't iterate bricks we're appending.
      const snap: Y.Map<unknown>[] = [];
      for (let i = 0; i < bricks.length; i++) {
        const b = bricks.get(i);
        if (b instanceof Y.Map && idSet.has(b.get('id') as string)) snap.push(b);
      }
      // The sets in the module stay sets: their groups come along.
      const copied = cloneGroups(
        readGrouping(layerData)?.groups ?? [],
        snap.map((src) => ({ src, myGroup: (src.get('myGroup') as string) || '' })),
        makeId,
      );
      const added: Y.Map<unknown>[] = [];
      for (const { src, myGroup } of copied.bricks) {
        const area = src.get('displayArea') as RectangleF;
        const newId = makeId();
        newMemberIds.push(newId);
        const yNew = new Y.Map<unknown>();
        yNew.set('id', newId);
        yNew.set('displayArea', { ...area, x: area.x + offsetX });
        yNew.set('partNumber', src.get('partNumber'));
        yNew.set('orientation', src.get('orientation') ?? 0);
        yNew.set('altitude', src.get('altitude') ?? 0);
        yNew.set('activeConnectionPointIndex', 0);
        yNew.set('myGroup', myGroup);
        yNew.set('connexions', []);
        added.push(yNew);
      }
      pushOnTop(bricks, added);
      const yGroups = layerData.get('groups');
      if (yGroups instanceof Y.Array) {
        for (const g of copied.groups) {
          const yGroup = new Y.Map<unknown>();
          yGroup.set('id', g.id);
          if (g.partNumber !== undefined) yGroup.set('partNumber', g.partNumber);
          yGroup.set('myGroup', g.myGroup ?? '');
          yGroups.push([yGroup]);
        }
      }
    }

    const cache = readSidecarCache(doc);
    const cloned = moduleCopy(module, newMemberIds);
    writeSidecarCache(doc, { ...cache, modules: [...getSidecarModules(cache), cloned] });
  }, LOCAL_ORIGIN);
}

/**
 * Update from library: the module's parts are replaced by a library
 * version's (`batches`, already placed where the module is), in ONE
 * transaction (one undo step). The module keeps its id, name, look and
 * pin; `patch` sets its link (`libraryVersion`). Each batch goes on the
 * sheet `sheetFor` picks for its sheet name, so parts stay on their sheets.
 * Returns the new part ids, or null for an unknown module.
 */
export function replaceModuleParts(
  doc: Y.Doc,
  moduleId: string,
  batches: readonly ModuleBatch[],
  sheetFor: (sheetName: string) => string,
  patch: Partial<SidecarModule> = {},
): string[] | null {
  const mod = getSidecarModules(readSidecarCache(doc)).find((m) => m.id === moduleId);
  if (!mod) return null;
  const old = new Set(mod.members);
  const ids: string[] = [];
  doc.transact(() => {
    const layerData = doc.getMap('layerData');
    for (const layerId of doc.getArray<string>('layers').toArray()) {
      const l = layerData.get(layerId);
      if (!(l instanceof Y.Map)) continue;
      const bricks = l.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      for (let i = bricks.length - 1; i >= 0; i--) {
        const b = bricks.get(i);
        if (b instanceof Y.Map && old.has(b.get('id') as string)) bricks.delete(i, 1);
      }
    }
    for (const batch of batches) {
      if (batch.bricks.length === 0) continue;
      const copied = cloneGroups(batch.groups ?? [], batch.bricks, makeId);
      ids.push(...insertBricks(doc, sheetFor(batch.layerName || 'Module'), copied.bricks, undefined, copied.groups));
    }
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, {
      ...cache,
      modules: getSidecarModules(cache).map((m) => (m.id === moduleId ? { ...m, ...patch, members: ids } : m)),
    });
  }, LOCAL_ORIGIN);
  return ids;
}

// Sidecar — venue

/**
 * Replace the entire venue (or clear it). Mirrors SetVenueCommand
 * (VenueCommands.cpp). Pass `null` to clear.
 */
export function setVenue(doc: Y.Doc, venue: import('@cld/bbm').Venue | null): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    if (venue === null) {
      const { venue: _removed, ...rest } = cache as Record<string, unknown>;
      writeSidecarCache(doc, rest);
    } else {
      writeSidecarCache(doc, { ...cache, venue });
    }
  }, LOCAL_ORIGIN);
}

// Sidecar — background image

export function setBackgroundImage(doc: Y.Doc, bg: BackgroundImage): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc);
    writeSidecarCache(doc, { ...cache, backgroundImage: bg });
  }, LOCAL_ORIGIN);
}

/** Not on the undo stack: Undo can't bring back a picture whose file is gone. */
export const BACKGROUND_REMOVED_ORIGIN = Symbol('cld-background-removed');

/** `untracked`: after the server deleted the file, so Undo never brings back
 *  a picture that would only 404. */
export function clearBackgroundImage(doc: Y.Doc, opts: { untracked?: boolean } = {}): void {
  doc.transact(() => {
    const { backgroundImage: _removed, ...rest } = readSidecarCache(doc);
    writeSidecarCache(doc, rest);
  }, opts.untracked ? BACKGROUND_REMOVED_ORIGIN : LOCAL_ORIGIN);
}
