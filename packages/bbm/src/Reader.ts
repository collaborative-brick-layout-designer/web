import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  BbmMap,
  Brick,
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
  LayerType,
  LinearRulerItem,
  CircularRulerItem,
  RectangleF,
  RulerItem,
  TextCell,
} from '@cld/model';
import { readColorSpec } from './color.js';
import { parseBool, parseXmlFloat, parseXmlInt } from './format.js';

// Parser config:
//   - preserve attributes under a stable key (`@`)
//   - keep text as strings (we re-parse numbers ourselves so we never silently
//     drop precision the way auto-typing can)
//   - never trim whitespace inside <Text>...</Text> content
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  textNodeName: '#text',
});

type Node = Record<string, unknown>;

export interface ReadResult {
  map: BbmMap;
  /** Warnings about unrecognised content (forward compat). */
  warnings: string[];
}

// A file cut off or damaged part way: the parser reads what it can, so the
// layout would open with only part of it, and saving would write that over
// the whole file. Refuse it, as BlueBrick and the desktop do, naming the line.
function refuseDamaged(xml: string): void {
  const valid = XMLValidator.validate(xml);
  if (valid === true) return;
  const { code, msg, line, col } = valid.err;
  // Elements still open at the end: the file ends before the layout does.
  if (code === 'InvalidXml' && msg.startsWith("Invalid '[")) {
    const lastLine = xml.split('\n').length;
    throw new Error(
      `The file is cut off at line ${lastLine}: it ends before the layout does. It may not have finished saving or copying. Nothing was changed.`,
    );
  }
  throw new Error(`The file is damaged at line ${line}, column ${col}, so it can't be opened safely. Nothing was changed.`);
}

export function readBbm(xml: string): ReadResult {
  refuseDamaged(xml);
  const tree = parser.parse(xml) as Node;
  const root = required<Node>(tree, 'Map');
  const warnings: string[] = [];

  const map: BbmMap = {
    version: parseXmlInt(stringField(root, 'Version')),
    nbItems: parseXmlInt(stringField(root, 'nbItems')),
    backgroundColor: readColorSpec(required<Node>(root, 'BackgroundColor')),
    author: stringField(root, 'Author'),
    lug: stringField(root, 'LUG'),
    event: stringField(root, 'Event'),
    date: readDate(required<Node>(root, 'Date')),
    comment: optionalString(root, 'Comment') ?? '',
    exportInfo: readExportInfo(required<Node>(root, 'ExportInfo')),
    selectedLayerIndex: parseXmlInt(stringField(root, 'SelectedLayerIndex')),
    layers: readLayers(root.Layers, warnings),
  };

  return { map, warnings };
}

// ---------------------------------------------------------------------------
// Element-level readers
// ---------------------------------------------------------------------------

function readDate(node: Node): { day: number; month: number; year: number } {
  return {
    day: parseXmlInt(stringField(node, 'Day')),
    month: parseXmlInt(stringField(node, 'Month')),
    year: parseXmlInt(stringField(node, 'Year')),
  };
}

function readExportInfo(node: Node): ExportInfo {
  return {
    exportPath: stringField(node, 'ExportPath'),
    exportFileType: parseXmlInt(stringField(node, 'ExportFileType')),
    exportArea: readRect(required<Node>(node, 'ExportArea')),
    exportScale: parseXmlFloat(stringField(node, 'ExportScale')),
    exportWatermark: parseBool(stringField(node, 'ExportWatermark')),
    exportElectricCircuit: parseBool(stringField(node, 'ExportElectricCircuit')),
    exportConnectionPoints: parseBool(stringField(node, 'ExportConnectionPoints')),
  };
}

function readRect(node: Node): RectangleF {
  return {
    x: parseXmlFloat(stringField(node, 'X')),
    y: parseXmlFloat(stringField(node, 'Y')),
    width: parseXmlFloat(stringField(node, 'Width')),
    height: parseXmlFloat(stringField(node, 'Height')),
  };
}

function readHullProperties(node: Node): HullProperties {
  return {
    isVisible: parseBool(stringAttr(node, 'isVisible')),
    hullColor: readColorSpec(required<Node>(node, 'hullColor')),
    hullThickness: parseXmlInt(stringField(node, 'hullThickness')),
  };
}

/** What a layer from before v9 (no HullProperties) gets, as on the desktop. */
function defaultHull(): HullProperties {
  return { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 };
}

function readFont(node: Node): FontSpec {
  return {
    family: stringField(node, 'FontFamily'),
    size: parseXmlFloat(stringField(node, 'Size')),
    // <Style> came in v6; the desktop reads older fonts as Regular.
    style: optionalString(node, 'Style') ?? 'Regular',
  };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function readLayers(layersNode: unknown, warnings: string[]): Layer[] {
  if (!layersNode) return [];
  const node = layersNode as Node;
  const raw = node.Layer;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  const out: Layer[] = [];
  for (const item of list) {
    const layerNode = item as Node;
    const type = stringAttr(layerNode, 'type') as LayerType;
    const id = stringAttr(layerNode, 'id');
    // Older files lack what later versions added, as the desktop reads
    // them (LayerIO.cpp readCommonField): Transparency came in v5 (an area
    // sheet had it in its body before; it's read by name either way) and
    // HullProperties in v9 (BlueBrick 1.9). A BlueBrick 1.8 file has none.
    const transparency = optionalString(layerNode, 'Transparency');
    const hull = layerNode.HullProperties;
    const common = {
      id,
      name: optionalString(layerNode, 'Name') ?? '',
      visible: parseBool(stringField(layerNode, 'Visible')),
      transparency: transparency === undefined ? 100 : parseXmlInt(transparency),
      hullProperties: hull && typeof hull === 'object' ? readHullProperties(hull as Node) : defaultHull(),
    };

    switch (type) {
      case 'grid':
        out.push(readLayerGrid(layerNode, common));
        break;
      case 'brick':
        out.push(readLayerBrick(layerNode, common));
        break;
      case 'text':
        out.push(readLayerText(layerNode, common));
        break;
      case 'area':
        out.push(readLayerArea(layerNode, common));
        break;
      case 'ruler':
        out.push(readLayerRuler(layerNode, common));
        break;
      default:
        warnings.push(`unknown layer type: ${String(type)}; skipped`);
    }
  }
  return out;
}

function readLayerGrid(n: Node, c: Omit<LayerGrid, 'type' | keyof LayerGridOnly>): LayerGrid {
  return {
    ...c,
    type: 'grid',
    gridColor: readColorSpec(required<Node>(n, 'GridColor')),
    // Desktop reads these as float (LayerIO.cpp:120,122), so do the same
    // here — otherwise fractional thickness from a desktop-saved file is
    // lost on round-trip.
    gridThickness: parseXmlFloat(stringField(n, 'GridThickness')),
    subGridColor: readColorSpec(required<Node>(n, 'SubGridColor')),
    subGridThickness: parseXmlFloat(stringField(n, 'SubGridThickness')),
    gridSizeInStud: parseXmlInt(stringField(n, 'GridSizeInStud')),
    subDivisionNumber: parseXmlInt(stringField(n, 'SubDivisionNumber')),
    displayGrid: parseBool(stringField(n, 'DisplayGrid')),
    displaySubGrid: parseBool(stringField(n, 'DisplaySubGrid')),
    displayCellIndex: parseBool(stringField(n, 'DisplayCellIndex')),
    cellIndexFont: readFont(required<Node>(n, 'CellIndexFont')),
    cellIndexColor: readColorSpec(required<Node>(n, 'CellIndexColor')),
    cellIndexColumnType: stringField(n, 'CellIndexColumnType'),
    cellIndexRowType: stringField(n, 'CellIndexRowType'),
    // Desktop reads this via xml::readPoint (LayerIO.cpp:132) — an integer
    // point with <X>/<Y> children, defaulting missing children to 0.
    cellIndexCorner: readIntPoint(required<Node>(n, 'CellIndexCorner')),
  };
}
type LayerGridOnly = Omit<LayerGrid, keyof LayerBrick & keyof LayerGrid>;

function readLayerBrick(n: Node, c: Omit<LayerBrick, 'type' | 'displayBrickElevation' | 'bricks' | 'groups'>): LayerBrick {
  return {
    ...c,
    type: 'brick',
    displayBrickElevation: parseBool(optionalString(n, 'DisplayBrickElevation') ?? 'false'),
    bricks: readBricks(n.Bricks),
    groups: readGroups(n.Groups),
  };
}

function readLayerText(n: Node, c: Omit<LayerText, 'type' | 'textCells' | 'groups'>): LayerText {
  return {
    ...c,
    type: 'text',
    textCells: readTextCells(n.TextCells),
    groups: readGroups(n.Groups),
  };
}

function readLayerArea(n: Node, c: Omit<LayerArea, 'type' | 'areaCellSize' | 'areas'>): LayerArea {
  return {
    ...c,
    type: 'area',
    areaCellSize: parseXmlInt(stringField(n, 'AreaCellSize')),
    areas: readAreas(n.Areas),
  };
}

function readLayerRuler(n: Node, c: Omit<LayerRuler, 'type' | 'rulerItems' | 'groups'>): LayerRuler {
  return {
    ...c,
    type: 'ruler',
    rulerItems: readRulerItems(n.RulerItems),
    groups: readGroups(n.Groups),
  };
}

/**
 * Parse `<RulerItems>`. Mirrors desktop `readLayerRuler`/`readRulerItem`
 * (saveload/LayerIO.cpp:395-465). Each child is either a
 * `<LinearRuler>` or `<CircularRuler>` element. Field order follows
 * `RulerItemBase` (LayerIO.cpp:381-393) plus the subclass-specific
 * fields appended at the end.
 */
function readRulerItems(node: unknown): RulerItem[] {
  if (!node || typeof node !== 'object') return [];
  const out: RulerItem[] = [];
  const linear = (node as Node).LinearRuler;
  for (const item of asArray<unknown>(linear)) {
    if (item && typeof item === 'object') out.push(readLinearRuler(item as Node));
  }
  const circular = (node as Node).CircularRuler;
  for (const item of asArray<unknown>(circular)) {
    if (item && typeof item === 'object') out.push(readCircularRuler(item as Node));
  }
  return out;
}

function readLinearRuler(n: Node): LinearRulerItem {
  return {
    kind: 'linear',
    ...readRulerCommon(n),
    point1: readPoint(required<Node>(n, 'Point1')),
    point2: readPoint(required<Node>(n, 'Point2')),
    attachedBrick1Id: optionalString(n, 'AttachedBrick1') ?? '',
    attachedBrick2Id: optionalString(n, 'AttachedBrick2') ?? '',
    offsetDistance: parseXmlFloat(stringField(n, 'OffsetDistance')),
    allowOffset: parseBool(stringField(n, 'AllowOffset')),
  };
}

function readCircularRuler(n: Node): CircularRulerItem {
  return {
    kind: 'circular',
    ...readRulerCommon(n),
    center: readPoint(required<Node>(n, 'Center')),
    radius: parseXmlFloat(stringField(n, 'Radius')),
    attachedBrickId: optionalString(n, 'AttachedBrick') ?? '',
  };
}

function readRulerCommon(n: Node) {
  return {
    // Mint a fresh id on read — `<LinearRuler>`/`<CircularRuler>` XML
    // has no id attribute upstream, so every load assigns new ids.
    // That's fine: ruler ids are in-memory only and never persisted.
    // Mirrors desktop's `LayerItem.guid = newBbmId()` at
    // RulerCommands.cpp:33 / 102 / 169 etc.
    id: mintRulerId(),
    displayArea: readRect(required<Node>(n, 'DisplayArea')),
    myGroup: optionalString(n, 'MyGroup') ?? '',
    color: readColorSpec(required<Node>(n, 'Color')),
    lineThickness: parseXmlFloat(stringField(n, 'LineThickness')),
    displayDistance: parseBool(stringField(n, 'DisplayDistance')),
    displayUnit: parseBool(stringField(n, 'DisplayUnit')),
    guidelineColor: readColorSpec(required<Node>(n, 'GuidelineColor')),
    guidelineThickness: parseXmlFloat(stringField(n, 'GuidelineThickness')),
    guidelineDashPattern: readFloatArray(n.GuidelineDashPattern),
    unit: parseXmlInt(stringField(n, 'Unit')),
    measureFont: readFont(required<Node>(n, 'MeasureFont')),
    measureFontColor: readColorSpec(required<Node>(n, 'MeasureFontColor')),
  };
}

function mintRulerId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')}`;
}

function readPoint(node: Node): { x: number; y: number } {
  return {
    x: parseXmlFloat(stringField(node, 'X')),
    y: parseXmlFloat(stringField(node, 'Y')),
  };
}

/**
 * Mirrors desktop `xml::readPoint` (XmlPrimitives.cpp:85): integer X/Y,
 * missing children default to 0. A self-closed `<CellIndexCorner />`
 * parses to '' and yields {0,0}.
 */
function readIntPoint(node: unknown): { x: number; y: number } {
  if (!node || typeof node !== 'object') return { x: 0, y: 0 };
  const n = node as Node;
  const x = optionalString(n, 'X');
  const y = optionalString(n, 'Y');
  return { x: parseXmlInt(x), y: parseXmlInt(y) };
}

/**
 * `<GuidelineDashPattern><value>2</value><value>4</value></GuidelineDashPattern>`
 * — the element name desktop reads/writes (XmlPrimitives.cpp:122,207) and
 * what real BlueBrick files contain. Earlier web builds wrote `<double>`
 * children, so accept those too. fast-xml-parser collapses single-child
 * arrays to a string, so accept both shapes.
 */
function readFloatArray(node: unknown): number[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Node;
  const inner = [...asArray<unknown>(n.value as unknown), ...asArray<unknown>(n.double as unknown)];
  return inner.map((v) => parseXmlFloat(textOf(v)));
}

function textOf(v: unknown): string {
  if (v && typeof v === 'object' && '#text' in (v as Node)) return String((v as Node)['#text']);
  return String(v);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Sub-collections
// ---------------------------------------------------------------------------

function readBricks(node: unknown): Brick[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as Node).Brick;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((b) => readBrick(b as Node));
}

function readBrick(n: Node): Brick {
  return {
    id: stringAttr(n, 'id'),
    displayArea: readRect(required<Node>(n, 'DisplayArea')),
    myGroup: optionalString(n, 'MyGroup') ?? '',
    partNumber: stringField(n, 'PartNumber'),
    orientation: parseXmlFloat(stringField(n, 'Orientation')),
    activeConnectionPointIndex: parseXmlInt(stringField(n, 'ActiveConnectionPointIndex')),
    // <Altitude> came in v3.
    altitude: parseXmlFloat(optionalString(n, 'Altitude')),
    connexions: readConnexions(n.Connexions),
  };
}

function readConnexions(node: unknown): Connexion[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as Node).Connexion;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => readConnexion(c as Node));
}

function readConnexion(n: Node): Connexion {
  return {
    id: stringAttr(n, 'id'),
    linkedTo: optionalString(n, 'LinkedTo') ?? '',
  };
}

function readTextCells(node: unknown): TextCell[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as Node).TextCell;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((t) => readTextCell(t as Node));
}

function readTextCell(n: Node): TextCell {
  const id = n['@id'];
  return {
    ...(typeof id === 'string' && id !== '' ? { id } : {}),
    displayArea: readRect(required<Node>(n, 'DisplayArea')),
    myGroup: optionalString(n, 'MyGroup') ?? '',
    text: optionalString(n, 'Text') ?? '',
    orientation: parseXmlFloat(stringField(n, 'Orientation')),
    fontColor: readColorSpec(required<Node>(n, 'FontColor')),
    font: readFont(required<Node>(n, 'Font')),
    textAlignment: stringField(n, 'TextAlignment'),
  };
}

function readAreas(node: unknown): { x: number; y: number; color: string }[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as Node).Area;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((a) => {
    const an = a as Node;
    return {
      x: parseXmlInt(stringField(an, 'x')),
      y: parseXmlInt(stringField(an, 'y')),
      color: stringField(an, 'color'),
    };
  });
}

function readGroups(node: unknown): Group[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as Node).Group;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((g) => {
    const gn = g as Node;
    const out: Group = { id: stringAttr(gn, 'id') };
    const partNumber = optionalString(gn, 'PartNumber');
    if (partNumber !== undefined) out.partNumber = partNumber;
    const orientation = optionalString(gn, 'Orientation');
    if (orientation !== undefined) out.orientation = parseXmlFloat(orientation);
    const altitude = optionalString(gn, 'Altitude');
    if (altitude !== undefined) out.altitude = parseXmlFloat(altitude);
    const myGroup = optionalString(gn, 'MyGroup');
    if (myGroup !== undefined) out.myGroup = myGroup;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function stringField(node: Node, key: string): string {
  const raw = node[key];
  if (raw === undefined || raw === null) {
    throw new Error(`missing required field: ${key}`);
  }
  if (typeof raw === 'object' && '#text' in (raw as Node)) {
    return String((raw as Node)['#text']);
  }
  return String(raw);
}

/**
 * Returns the text content of an element if present, or `undefined` if the
 * element is missing OR self-closed (`<Comment />`). The two are
 * indistinguishable in the parsed tree because fast-xml-parser collapses
 * `<Foo />` to an empty string node.
 */
function optionalString(node: Node, key: string): string | undefined {
  const raw = node[key];
  if (raw === undefined || raw === null) return undefined;
  if (raw === '') return '';
  if (typeof raw === 'object' && '#text' in (raw as Node)) {
    const t = (raw as Node)['#text'];
    return t === undefined || t === null ? '' : String(t);
  }
  return String(raw);
}

function stringAttr(node: Node, attr: string): string {
  const v = node[`@${attr}`];
  if (v === undefined || v === null) throw new Error(`missing attribute: ${attr}`);
  return String(v);
}

function required<T>(node: Node, key: string): T {
  const v = node[key];
  if (v === undefined || v === null) throw new Error(`missing required element: ${key}`);
  return v as T;
}
