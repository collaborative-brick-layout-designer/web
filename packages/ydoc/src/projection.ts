// Yjs ↔ BbmMap projection.
//
// The Yjs document is the canonical in-memory shape during editing; the
// BbmMap is the import/export shape. Round-trip parity between the two is
// enforced by the property tests in projection.test.ts.
//
// Doc shape (sketched in PLAN.md §3.2, materialised here):
//
//   doc.getMap('meta')          → version, nbItems, BackgroundColor, author,
//                                 lug, event, date, comment, exportInfo,
//                                 selectedLayerIndex, schemaVersion (see
//                                 ids.ts DOC_SCHEMA_VERSION)
//   doc.getArray('layers')      → ordered list of layer ids (string)
//   doc.getMap('layerData')     → layerId → Y.Map of layer fields. Every
//                                 layer kind keeps its scalar fields directly
//                                 in the Y.Map. Child collections (bricks,
//                                 textCells, areas, groups) are nested
//                                 Y.Arrays of Y.Maps so per-item edits are
//                                 small Yjs updates rather than full-layer
//                                 rewrites. Text cells carry a stable
//                                 `id` (schemaVersion ≥ 1; see ids.ts).
//
// Two design choices worth highlighting:
//
//  - We persist BBM-specific structures (RectangleF, ColorSpec, FontSpec) as
//    plain JSON-serialisable objects inside Y.Maps, NOT as nested Y.Maps.
//    These values are mutated atomically — a brick's displayArea is always
//    replaced wholesale, never edited field-by-field — so the extra
//    granularity buys nothing and adds Yjs node overhead.
//
//  - The doc preserves layer/brick order (Y.Array). Per-id maps would let
//    us look up an item in O(1) but lose the iteration order that BBM
//    cares about.

import * as Y from 'yjs';
import type {
  AreaCell,
  BbmMap,
  Brick,
  ColorSpec,
  Connexion,
  ExportInfo,
  FontSpec,
  Group,
  HullProperties,
  Layer,
  LayerArea,
  LayerBrick,
  LayerGrid,
  LayerRuler,
  LayerText,
  PointF,
  RectangleF,
  RulerItem,
  TextCell,
} from '@cld/model';
import { makeId } from './ids.js';
import { DOC_BASE_SCHEMA, cellOffsetOf, itemsInOrder, rulerJson } from './shape.js';

// ---------------------------------------------------------------------------
// Top-level projection
// ---------------------------------------------------------------------------

/**
 * Apply a `BbmMap` into a fresh `Y.Doc`. The doc is left in a clean state
 * (no transactions, no history) — callers that want to seed an UndoManager
 * should do so AFTER this returns.
 */
export function bbmToDoc(map: BbmMap, doc: Y.Doc): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('version', map.version);
    meta.set('nbItems', map.nbItems);
    meta.set('backgroundColor', map.backgroundColor);
    meta.set('author', map.author);
    meta.set('lug', map.lug);
    meta.set('event', map.event);
    meta.set('date', { ...map.date });
    meta.set('comment', map.comment);
    meta.set('exportInfo', cloneExportInfo(map.exportInfo));
    meta.set('selectedLayerIndex', map.selectedLayerIndex);
    meta.set('schemaVersion', DOC_BASE_SCHEMA);

    const layerOrder = doc.getArray<string>('layers');
    const layerData = doc.getMap<Y.Map<unknown>>('layerData');

    // Clear any prior state — bbmToDoc replaces, not merges.
    layerOrder.delete(0, layerOrder.length);
    for (const k of [...layerData.keys()]) layerData.delete(k);

    for (const layer of map.layers) {
      const yLayer = new Y.Map<unknown>();
      writeLayer(layer, yLayer);
      layerData.set(layer.id, yLayer);
      layerOrder.push([layer.id]);
    }
  });
}

/** Reconstruct a `BbmMap` from a populated `Y.Doc`. */
export function docToBbm(doc: Y.Doc): BbmMap {
  const meta = doc.getMap('meta');
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');

  const layers: Layer[] = [];
  for (const id of layerOrder.toArray()) {
    const yLayer = layerData.get(id);
    if (!yLayer) continue;
    layers.push(readLayer(id, yLayer));
  }

  return { ...readMeta(meta), layers };
}

function readMeta(meta: Y.Map<unknown>): Omit<BbmMap, 'layers'> {
  return {
    version: requireScalar(meta, 'version') as number,
    nbItems: requireScalar(meta, 'nbItems') as number,
    backgroundColor: requireScalar(meta, 'backgroundColor') as ColorSpec,
    author: requireScalar(meta, 'author') as string,
    lug: requireScalar(meta, 'lug') as string,
    event: requireScalar(meta, 'event') as string,
    date: { ...(requireScalar(meta, 'date') as BbmMap['date']) },
    comment: requireScalar(meta, 'comment') as string,
    exportInfo: cloneExportInfo(requireScalar(meta, 'exportInfo') as ExportInfo),
    selectedLayerIndex: requireScalar(meta, 'selectedLayerIndex') as number,
  };
}

// ---------------------------------------------------------------------------
// Cached projection (structural sharing)
// ---------------------------------------------------------------------------

export interface DocProjector {
  /**
   * The doc as a `BbmMap`. Returns the SAME object until the doc changes;
   * after a change, layers and bricks whose Yjs subtree did not change
   * keep their previous object identity, so memoised renderers can skip
   * them. Throws exactly like `docToBbm` when the doc is incomplete.
   *
   * The returned objects are shared: callers must treat them as
   * read-only (use `docToBbm` for a private, mutable copy).
   */
  project(): BbmMap;
  /**
   * The Y.Map a brick of `project()`'s map was read from (undefined for a
   * brick that isn't from this projector, as `docToBbm`'s within a
   * transaction aren't): to write to just the bricks a pass changed.
   */
  brickYMap(brick: Brick): Y.Map<unknown> | undefined;
  /** Detach the doc observers. */
  destroy(): void;
}

/**
 * Build a cached projector for `doc`. Invalidation is driven by Yjs
 * observers: a change anywhere below a brick / layer Y.Map evicts that
 * node and every ancestor, so only the changed bricks (and their layer)
 * are re-read on the next `project()`.
 */
export function createDocProjector(doc: Y.Doc): DocProjector {
  const meta = doc.getMap('meta');
  const layerOrder = doc.getArray<string>('layers');
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  // Keyed on the Y types themselves; entries die with their Y.Map.
  const brickCache = new WeakMap<object, Brick>();
  const brickSource = new WeakMap<Brick, Y.Map<unknown>>();
  const layerCache = new WeakMap<object, Layer>();
  let current: BbmMap | null = null;

  const readBrickCached: BrickReader = (y) => {
    let b = brickCache.get(y);
    if (!b) {
      b = yMapToBrick(y);
      brickCache.set(y, b);
      brickSource.set(b, y);
    }
    return b;
  };

  const onLayerData = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    current = null;
    for (const ev of events) {
      let t: Y.AbstractType<unknown> | null = ev.target;
      while (t && t !== layerData) {
        brickCache.delete(t);
        layerCache.delete(t);
        t = t.parent as Y.AbstractType<unknown> | null;
      }
    }
  };
  const onOther = (): void => {
    current = null;
  };
  layerData.observeDeep(onLayerData);
  meta.observeDeep(onOther);
  layerOrder.observe(onOther);

  return {
    project(): BbmMap {
      // Observers only run when a transaction commits; inside one the
      // caches may be stale, so fall back to an uncached projection.
      if ((doc as unknown as { _transaction: unknown })._transaction) return docToBbm(doc);
      if (current) return current;
      const layers: Layer[] = [];
      for (const id of layerOrder.toArray()) {
        const yLayer = layerData.get(id);
        if (!yLayer) continue;
        let layer = layerCache.get(yLayer);
        if (!layer || layer.id !== id) {
          layer = readLayer(id, yLayer, readBrickCached);
          layerCache.set(yLayer, layer);
        }
        layers.push(layer);
      }
      current = { ...readMeta(meta), layers };
      return current;
    },
    brickYMap(brick: Brick): Y.Map<unknown> | undefined {
      return brickSource.get(brick);
    },
    destroy(): void {
      layerData.unobserveDeep(onLayerData);
      meta.unobserveDeep(onOther);
      layerOrder.unobserve(onOther);
      current = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Layer write
// ---------------------------------------------------------------------------

function writeLayer(layer: Layer, y: Y.Map<unknown>): void {
  // Common fields on every layer kind. `id` is implicit (it's the key in
  // layerData), but stash it inside the Y.Map too so reads don't need a
  // back-reference.
  y.set('id', layer.id);
  y.set('type', layer.type);
  y.set('name', layer.name);
  y.set('visible', layer.visible);
  y.set('transparency', layer.transparency);
  y.set('hullProperties', cloneHull(layer.hullProperties));

  switch (layer.type) {
    case 'grid':
      writeLayerGrid(layer, y);
      break;
    case 'brick':
      writeLayerBrick(layer, y);
      break;
    case 'text':
      writeLayerText(layer, y);
      break;
    case 'area':
      writeLayerArea(layer, y);
      break;
    case 'ruler':
      writeLayerRuler(layer, y);
      break;
  }
}

/**
 * A grid's cell size as both apps draw it: 1 to the largest 32-bit int (the
 * server refuses anything else, apps/server/src/ws/gridGuard.ts). A file's
 * size below 1 becomes 1 (as the desktop draws it), one too big the
 * largest, and one that isn't a number BlueBrick's default 32.
 */
export function drawableGridSize(size: number): number {
  if (typeof size !== 'number' || Number.isNaN(size)) return 32;
  return Math.min(2147483647, Math.max(1, size));
}

function writeLayerGrid(layer: LayerGrid, y: Y.Map<unknown>): void {
  y.set('gridColor', layer.gridColor);
  y.set('gridThickness', layer.gridThickness);
  y.set('subGridColor', layer.subGridColor);
  y.set('subGridThickness', layer.subGridThickness);
  y.set('gridSizeInStud', drawableGridSize(layer.gridSizeInStud));
  y.set('subDivisionNumber', layer.subDivisionNumber);
  y.set('displayGrid', layer.displayGrid);
  y.set('displaySubGrid', layer.displaySubGrid);
  y.set('displayCellIndex', layer.displayCellIndex);
  y.set('cellIndexFont', { ...layer.cellIndexFont });
  y.set('cellIndexColor', layer.cellIndexColor);
  y.set('cellIndexColumnType', layer.cellIndexColumnType);
  y.set('cellIndexRowType', layer.cellIndexRowType);
  y.set('cellIndexCorner', { x: layer.cellIndexCorner.x, y: layer.cellIndexCorner.y });
}

function writeLayerBrick(layer: LayerBrick, y: Y.Map<unknown>): void {
  y.set('displayBrickElevation', layer.displayBrickElevation);
  const bricks = new Y.Array<Y.Map<unknown>>();
  for (const b of layer.bricks) bricks.push([brickToYMap(b)]);
  y.set('bricks', bricks);
  const groups = new Y.Array<Y.Map<unknown>>();
  for (const g of layer.groups) groups.push([groupToYMap(g)]);
  y.set('groups', groups);
}

function brickToYMap(brick: Brick): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  y.set('id', brick.id);
  y.set('displayArea', cloneRect(brick.displayArea));
  y.set('myGroup', brick.myGroup);
  y.set('partNumber', brick.partNumber);
  y.set('orientation', brick.orientation);
  y.set('activeConnectionPointIndex', brick.activeConnectionPointIndex);
  y.set('altitude', brick.altitude);
  y.set(
    'connexions',
    brick.connexions.map((c) => ({ id: c.id, linkedTo: c.linkedTo })),
  );
  return y;
}

function groupToYMap(group: Group): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  y.set('id', group.id);
  if (group.partNumber !== undefined) y.set('partNumber', group.partNumber);
  if (group.orientation !== undefined) y.set('orientation', group.orientation);
  if (group.altitude !== undefined) y.set('altitude', group.altitude);
  if (group.myGroup !== undefined) y.set('myGroup', group.myGroup);
  return y;
}

function writeLayerText(layer: LayerText, y: Y.Map<unknown>): void {
  const cells = new Y.Array<Y.Map<unknown>>();
  for (const t of layer.textCells) cells.push([textCellToYMap(t)]);
  y.set('textCells', cells);
  const groups = new Y.Array<Y.Map<unknown>>();
  for (const g of layer.groups) groups.push([groupToYMap(g)]);
  y.set('groups', groups);
}

function textCellToYMap(t: TextCell): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  // Every text cell gets a stable id so live-sync clients can address it
  // without relying on its array index. A .bbm id is reused so it round-
  // trips; `idInBbm` remembers that, because only such ids are written
  // back out — minting one for an id-less file must not change its export.
  y.set('id', t.id ?? makeId());
  if (t.id !== undefined) y.set('idInBbm', true);
  y.set('displayArea', cloneRect(t.displayArea));
  y.set('myGroup', t.myGroup);
  y.set('text', t.text);
  y.set('orientation', t.orientation);
  y.set('fontColor', t.fontColor);
  y.set('font', { ...t.font });
  y.set('textAlignment', t.textAlignment);
  return y;
}

function writeLayerArea(layer: LayerArea, y: Y.Map<unknown>): void {
  y.set('areaCellSize', layer.areaCellSize);
  const areas = new Y.Array<AreaCell>();
  for (const a of layer.areas) areas.push([{ ...a }]);
  y.set('areas', areas);
}

function writeLayerRuler(layer: LayerRuler, y: Y.Map<unknown>): void {
  // Ruler items are written as plain-JSON entries (shape 1), which every
  // build reads; the first ruler edit turns them into Y.Maps (shape.ts).
  const rulers = new Y.Array<RulerItem>();
  for (const r of layer.rulerItems) {
    rulers.push([structuredClone(r)]);
  }
  y.set('rulerItems', rulers);
  const groups = new Y.Array<Y.Map<unknown>>();
  for (const g of layer.groups) groups.push([groupToYMap(g)]);
  y.set('groups', groups);
}

// ---------------------------------------------------------------------------
// Layer read
// ---------------------------------------------------------------------------

type BrickReader = (y: Y.Map<unknown>) => Brick;

function readLayer(id: string, y: Y.Map<unknown>, readBrick: BrickReader = yMapToBrick): Layer {
  const type = requireScalar(y, 'type') as Layer['type'];
  const common = {
    id,
    name: requireScalar(y, 'name') as string,
    visible: requireScalar(y, 'visible') as boolean,
    transparency: requireScalar(y, 'transparency') as number,
    hullProperties: cloneHull(requireScalar(y, 'hullProperties') as HullProperties),
  };

  switch (type) {
    case 'grid':
      return readLayerGrid(y, common);
    case 'brick':
      return readLayerBrick(y, common, readBrick);
    case 'text':
      return readLayerText(y, common);
    case 'area':
      return readLayerArea(y, common);
    case 'ruler':
      return readLayerRuler(y, common);
  }
}

type CommonFields = Pick<LayerGrid, 'id' | 'name' | 'visible' | 'transparency' | 'hullProperties'>;

function readLayerGrid(y: Y.Map<unknown>, c: CommonFields): LayerGrid {
  return {
    ...c,
    type: 'grid',
    gridColor: requireScalar(y, 'gridColor') as ColorSpec,
    gridThickness: requireScalar(y, 'gridThickness') as number,
    subGridColor: requireScalar(y, 'subGridColor') as ColorSpec,
    subGridThickness: requireScalar(y, 'subGridThickness') as number,
    gridSizeInStud: requireScalar(y, 'gridSizeInStud') as number,
    subDivisionNumber: requireScalar(y, 'subDivisionNumber') as number,
    displayGrid: requireScalar(y, 'displayGrid') as boolean,
    displaySubGrid: requireScalar(y, 'displaySubGrid') as boolean,
    displayCellIndex: requireScalar(y, 'displayCellIndex') as boolean,
    cellIndexFont: { ...(requireScalar(y, 'cellIndexFont') as FontSpec) },
    cellIndexColor: requireScalar(y, 'cellIndexColor') as ColorSpec,
    cellIndexColumnType: requireScalar(y, 'cellIndexColumnType') as string,
    cellIndexRowType: requireScalar(y, 'cellIndexRowType') as string,
    cellIndexCorner: readCellIndexCorner(y.get('cellIndexCorner')),
  };
}

/**
 * `cellIndexCorner` is an integer {x, y} point. Docs persisted before that
 * fix hold a string instead (the reader kept only the element's
 * whitespace text, dropping its <X>/<Y> children; new docs were seeded
 * with ''). The original coordinates are unrecoverable from such a doc,
 * so fall back to desktop's default {0, 0} (LayerGrid.h) — which is also
 * the value in every BlueBrick file we've seen.
 */
function readCellIndexCorner(v: unknown): PointF {
  if (v && typeof v === 'object') {
    const p = v as Partial<PointF>;
    const x = typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : 0;
    const y = typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : 0;
    return { x, y };
  }
  return { x: 0, y: 0 };
}

function readLayerBrick(y: Y.Map<unknown>, c: CommonFields, readBrick: BrickReader): LayerBrick {
  const bricksY = y.get('bricks') as Y.Array<Y.Map<unknown>> | undefined;
  const groupsY = y.get('groups') as Y.Array<Y.Map<unknown>> | undefined;
  return {
    ...c,
    type: 'brick',
    displayBrickElevation: requireScalar(y, 'displayBrickElevation') as boolean,
    bricks: bricksY ? itemsInOrder(bricksY).map(readBrick) : [],
    groups: groupsY ? groupsY.toArray().map(yMapToGroup) : [],
  };
}

function yMapToBrick(y: Y.Map<unknown>): Brick {
  const connexionsRaw = (y.get('connexions') ?? []) as Connexion[];
  return {
    id: requireScalar(y, 'id') as string,
    displayArea: cloneRect(requireScalar(y, 'displayArea') as RectangleF),
    myGroup: requireScalar(y, 'myGroup') as string,
    partNumber: requireScalar(y, 'partNumber') as string,
    orientation: requireScalar(y, 'orientation') as number,
    activeConnectionPointIndex: requireScalar(y, 'activeConnectionPointIndex') as number,
    altitude: requireScalar(y, 'altitude') as number,
    connexions: connexionsRaw.map((c) => ({ id: c.id, linkedTo: c.linkedTo })),
  };
}

function yMapToGroup(y: Y.Map<unknown>): Group {
  const out: Group = { id: requireScalar(y, 'id') as string };
  if (y.has('partNumber')) out.partNumber = y.get('partNumber') as string;
  if (y.has('orientation')) out.orientation = y.get('orientation') as number;
  if (y.has('altitude')) out.altitude = y.get('altitude') as number;
  if (y.has('myGroup')) out.myGroup = y.get('myGroup') as string;
  return out;
}

function readLayerText(y: Y.Map<unknown>, c: CommonFields): LayerText {
  const cellsY = y.get('textCells') as Y.Array<Y.Map<unknown>> | undefined;
  const groupsY = y.get('groups') as Y.Array<Y.Map<unknown>> | undefined;
  return {
    ...c,
    type: 'text',
    textCells: cellsY ? cellsY.toArray().map(yMapToTextCell) : [],
    groups: groupsY ? groupsY.toArray().map(yMapToGroup) : [],
  };
}

function yMapToTextCell(cell: Y.Map<unknown> | Record<string, unknown>): TextCell {
  // Older web builds pushed text cells as plain objects; read those too
  // rather than failing the whole projection.
  const y = cell instanceof Y.Map ? cell : plainAsMap(cell);
  // `id` is tolerated missing (docs from before schemaVersion 1).
  const id = y.get('id');
  return {
    ...(y.get('idInBbm') === true && typeof id === 'string' ? { id } : {}),
    displayArea: cloneRect(requireScalar(y, 'displayArea') as RectangleF),
    myGroup: requireScalar(y, 'myGroup') as string,
    text: requireScalar(y, 'text') as string,
    orientation: requireScalar(y, 'orientation') as number,
    fontColor: requireScalar(y, 'fontColor') as ColorSpec,
    font: { ...(requireScalar(y, 'font') as FontSpec) },
    textAlignment: requireScalar(y, 'textAlignment') as string,
  };
}

function readLayerArea(y: Y.Map<unknown>, c: CommonFields): LayerArea {
  const areasY = y.get('areas') as Y.Array<AreaCell> | undefined;
  // Cells are kept relative to the sheet's offset (shape 2, shape.ts).
  const off = cellOffsetOf(y);
  return {
    ...c,
    type: 'area',
    areaCellSize: requireScalar(y, 'areaCellSize') as number,
    areas: areasY ? areasY.toArray().map((a) => ({ ...a, x: a.x + off.x, y: a.y + off.y })) : [],
  };
}

function readLayerRuler(y: Y.Map<unknown>, c: CommonFields): LayerRuler {
  const groupsY = y.get('groups') as Y.Array<Y.Map<unknown>> | undefined;
  const rulersY = y.get('rulerItems') as Y.Array<RulerItem> | undefined;
  return {
    ...c,
    type: 'ruler',
    // Plain objects (shape 1) or Y.Maps ordered by z (shape 2).
    rulerItems: rulersY ? itemsInOrder(rulersY as Y.Array<unknown>).map((r) => rulerJson(r) as unknown as RulerItem).filter(Boolean) : [],
    groups: groupsY ? groupsY.toArray().map(yMapToGroup) : [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneRect(r: RectangleF): RectangleF {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function cloneHull(h: HullProperties): HullProperties {
  return { isVisible: h.isVisible, hullColor: h.hullColor, hullThickness: h.hullThickness };
}

function cloneExportInfo(info: ExportInfo): ExportInfo {
  return {
    exportPath: info.exportPath,
    exportFileType: info.exportFileType,
    exportArea: cloneRect(info.exportArea),
    exportScale: info.exportScale,
    exportWatermark: info.exportWatermark,
    exportElectricCircuit: info.exportElectricCircuit,
    exportConnectionPoints: info.exportConnectionPoints,
  };
}

function plainAsMap(o: Record<string, unknown>): Y.Map<unknown> {
  return { get: (k: string) => o[k] } as unknown as Y.Map<unknown>;
}

function requireScalar(y: Y.Map<unknown>, key: string): unknown {
  const v = y.get(key);
  if (v === undefined) throw new Error(`missing key in Y.Map: ${key}`);
  return v;
}
