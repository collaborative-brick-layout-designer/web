// Snap helpers for the place + drag tools.
//
// Two snap strategies, applied in order:
//
//   1. Connection snap. Find the nearest unlinked connection point on
//      any existing brick that matches a connection on the candidate
//      part. If the distance is within `CONN_SNAP_STUDS`, return the
//      offset that would put the candidate's matching point exactly on
//      the existing point. Mirrors desktop's `applyLiveConnectionSnap`.
//
//   2. Grid snap. If no connection snap fired, the part's snap corner
//      lands on the grid (gridSnap.ts, as BlueBrick), like the desktop.
//
// All inputs are in stud-space.

import type { BbmMap, Brick, LayerBrick } from '@cld/model';
import type { PartWire } from '../api';
import { pivotOf } from './brickGeometry';
import { dragShift, snapOffset } from './gridSnap';
import { applyGroupTurn, facingTurn, holdReach, pickSnap, type GroupTurn, type SnapCandidate, type SnapSession } from './snapFeel';

export interface PlaceCandidate {
  part: PartWire;
  /** World-space target centre, before snapping. */
  centreX: number;
  centreY: number;
  /** Brick orientation in degrees (clockwise positive). */
  orientation: number;
  /** Brick width/height in studs (display area). */
  width: number;
  height: number;
  /**
   * Pivot minus displayArea centre, in studs (non-zero only for parts
   * with a <hull>). `centreX/Y` are the pivot; the grid rounds the box.
   */
  pivotOffsetX?: number;
  pivotOffsetY?: number;
  /** Active grid snap step in studs (0 = grid snap disabled). */
  snapStepStuds: number;
  /** Connection-snap reach in studs (`snapReachStuds`); 0 = no connection snap. */
  reach: number;
  /** The placement drag's session (hold, speed gate); none = a one-off placement. */
  session?: SnapSession;
  /** Alt held: no connection snap. */
  bypass?: boolean;
  /** The drop: one last snap with the speed gate off. */
  final?: boolean;
}

export interface SnapResult {
  /** Final centre after snapping. */
  centreX: number;
  centreY: number;
  /** True if a connection snap fired (overrides grid snap). */
  snappedToConnection: boolean;
  /**
   * Orientation the candidate brick should be rotated to when a
   * connection snap fired. `null` when `snappedToConnection` is false.
   */
  newOrientation: number | null;
  /** Where the joined connections meet (studs), for the snap ring; absent without a connection snap. */
  ringStudX?: number;
  ringStudY?: number;
}

export interface AnchorSnapResult extends SnapResult {
  /**
   * Index into `newPart.connections` of the connection that was used to
   * snap. The outgoing connection (for the next chain step) is:
   *   newPart.connections[newConnIndex].nextConnexionPreference ?? (the other one)
   * Store this on the placed brick as `activeConnectionPointIndex` so the
   * next click-to-place knows which end is the free outgoing end without
   * needing the connectivity worker to run first.
   */
  newConnIndex: number;
}

/**
 * Selection-anchor snap — port of `resolvePartPlacement` lines 1147-1202
 * (MapView.cpp). When exactly one brick is selected, find the correct free
 * connection on it that is compatible with any connection on `newPart`.
 * Returns the rotation-aligned centre + orientation for the new brick so
 * the two connections meet mouth-to-mouth.
 *
 * "Correct free connection" priority:
 *   1. If connexions data exists (connectivity has run), skip linked ones.
 *   2. If connexions is empty (just placed, no connectivity yet), use
 *      `anchorBrick.activeConnectionPointIndex` as the preferred anchor
 *      connection — this was set after the previous snap placement so it
 *      points to the outgoing free end. Only fall through to index 0 if
 *      `activeConnectionPointIndex` has no compatible connection.
 *
 * Returns `null` if:
 *   - the anchor has no free compatible connection with `newPart`, or
 *   - `newPart` has no connections at all.
 */
export function snapToAnchorBrick(
  anchorBrick: import('@cld/model').Brick,
  anchorMeta: PartWire,
  newPart: PartWire,
  _newWidth: number,
  _newHeight: number,
  /** The anchor's connections to try, in order (a set's preference order); all of them when left out. */
  only?: readonly number[],
): AnchorSnapResult | null {
  if (newPart.connections.length === 0) return null;

  // Connection points hang off the sprite centre (BlueBrick's pivot).
  const { x: anchorCx, y: anchorCy } = pivotOf(anchorBrick, anchorMeta);
  const rA = (anchorBrick.orientation * Math.PI) / 180;
  const cosA = Math.cos(rA);
  const sinA = Math.sin(rA);

  // Desktop tries the anchor's connections in order and takes the first
  // free one with a compatible connection on the new part
  // (MapView.cpp:1226-1258). Links are current: placement rebuilds
  // connectivity straight away.
  const order = only ?? anchorMeta.connections.map((_, i) => i);
  for (const i of order) {
    const ac = anchorMeta.connections[i];
    if (!ac) continue;
    if (!ac.type) continue;
    const link = anchorBrick.connexions[i];
    if (link && link.linkedTo !== '') continue;

    // Find the first compatible connection on the new part.
    let newCi = -1;
    for (let j = 0; j < newPart.connections.length; j++) {
      if (newPart.connections[j]!.type === ac.type) { newCi = j; break; }
    }
    if (newCi < 0) continue;

    const nc = newPart.connections[newCi]!;

    // World position of the anchor connection point.
    const acWorldX = anchorCx + ac.x * cosA - ac.y * sinA;
    const acWorldY = anchorCy + ac.x * sinA + ac.y * cosA;

    // New orientation so nc.angle + newOrient = ac.angle + anchor.orient + 180°.
    const targetAngle = ac.angle + anchorBrick.orientation;
    let newOrient = targetAngle + 180 - nc.angle;
    // Normalise to (-180, 180] — matches desktop's while-loop.
    while (newOrient >  180) newOrient -= 360;
    while (newOrient <= -180) newOrient += 360;

    const rN = (newOrient * Math.PI) / 180;
    const cosN = Math.cos(rN);
    const sinN = Math.sin(rN);

    // New centre: anchor CP world pos - rotate(nc.position, newOrient).
    const newCentreX = acWorldX - (nc.x * cosN - nc.y * sinN);
    const newCentreY = acWorldY - (nc.x * sinN + nc.y * cosN);

    return {
      centreX: newCentreX,
      centreY: newCentreY,
      snappedToConnection: true,
      newOrientation: newOrient,
      newConnIndex: newCi,
    };
  }

  return null;
}

/**
 * Snap the candidate brick's centre to either a nearby existing
 * connection point or the grid. Existing free connection points are
 * collected from every brick layer in `map`.
 */
export function snapPlacement(
  candidate: PlaceCandidate,
  map: BbmMap,
  partsByKey: Map<string, PartWire>,
): SnapResult {
  const candidateConns = candidate.part.connections;
  if (candidateConns.length > 0) {
    const free = collectFreeConnectionsInWorld(map, partsByKey);
    const best = findBestConnectionMatch(candidate, candidateConns, free);
    if (best) {
      return {
        centreX: best.newCentreX,
        centreY: best.newCentreY,
        snappedToConnection: true,
        newOrientation: best.newOrientation,
        ringStudX: best.ringX,
        ringStudY: best.ringY,
      };
    }
  }

  // The grid, as BlueBrick drops a part from the library (and the desktop's
  // resolvePartPlacement): held by the middle of its box, its snap corner
  // (box top-left plus its <SnapMargin> offset) lands on the grid.
  if (candidate.snapStepStuds <= 0) {
    return {
      centreX: candidate.centreX,
      centreY: candidate.centreY,
      snappedToConnection: false,
      newOrientation: null,
    };
  }
  const cursor = { x: candidate.centreX, y: candidate.centreY };
  const off = snapOffset(candidate.part.snapMargin, candidate.orientation);
  const shift = dragShift(
    cursor,
    { x: cursor.x - candidate.width / 2 + off.x, y: cursor.y - candidate.height / 2 + off.y },
    candidate.snapStepStuds,
  );
  return {
    centreX: cursor.x + shift.x + (candidate.pivotOffsetX ?? 0),
    centreY: cursor.y + shift.y + (candidate.pivotOffsetY ?? 0),
    snappedToConnection: false,
    newOrientation: null,
  };
}

export interface WorldConnection {
  x: number;
  y: number;
  type: string;
  /** World-space outward angle in degrees. Used for orientation snap. */
  angle: number;
}

/**
 * Walk every brick in every brick layer and emit world-space positions
 * for every free (unlinked) connection point. The catalog is consulted
 * for the connection geometry; bricks whose part isn't in the catalog
 * are skipped (no ground truth to snap to).
 */
function collectFreeConnectionsInWorld(
  map: BbmMap,
  partsByKey: Map<string, PartWire>,
): OwnedWorldConnection[] {
  return freeConnectionsCached(map, partsByKey);
}

export interface OwnedWorldConnection extends WorldConnection {
  brickId: string;
  /** Index of the connection on its brick's part. */
  index: number;
}

/** A linked connection on the map, with what it links to. */
interface LinkedWorldConnection extends OwnedWorldConnection {
  linkedTo: string;
}

/**
 * What the links of a moving set can point at: its brick ids and their
 * connexion ids (linkedTo holds the partner connexion's id; a brick id is
 * accepted too, as the desktop's rebuildConnectivity writes one).
 */
export function linkKeys(bricks: Iterable<{ id: string; connexions: readonly { id?: string }[] }>): Set<string> {
  const keys = new Set<string>();
  for (const b of bricks) {
    keys.add(b.id);
    for (const c of b.connexions) if (c.id) keys.add(c.id);
  }
  return keys;
}

/**
 * During a drag a link to the parts left behind no longer holds: a moving
 * connection is taken only when it links inside the moving set (`keys`
 * from linkKeys).
 */
export function takenWhileMoving(linkedTo: string | undefined, keys: ReadonlySet<string>): boolean {
  return !!linkedTo && keys.has(linkedTo);
}

/** Stable key of a brick's connection, for snap locks. */
export function connKey(brickId: string, index: number): string {
  return `${brickId}#${index}`;
}

// Free-connection lists per (map, catalog). A drag fires dragmove at
// frame rate against the same map object, and the placement ghost
// re-snaps on every dragover; rebuilding every free connection point of
// every brick each time cost ~3.6 ms per frame at 5k bricks. Maps are
// immutable snapshots (the editor's shared projection gets a new object
// on every doc change), so keying on identity is safe.
const freeConnCache = new WeakMap<
  BbmMap,
  { partsByKey: Map<string, PartWire>; conns: OwnedWorldConnection[]; linked: LinkedWorldConnection[] }
>();

export function freeConnectionsCached(
  map: BbmMap,
  partsByKey: Map<string, PartWire>,
): OwnedWorldConnection[] {
  return connectionsCached(map, partsByKey).conns;
}

// Each part's own ends, per part object (the shared projection keeps a
// part the same object while it doesn't change), so a new layout after a
// drop works out only the parts that changed: every end of every part was
// worked out again at the start of each drag (about 25 ms on 7,520 parts
// at 4x slowed CPU).
const brickConnCache = new WeakMap<Map<string, PartWire>, WeakMap<Brick, { conns: OwnedWorldConnection[]; linked: LinkedWorldConnection[] }>>();

function brickConnections(brick: Brick, partsByKey: Map<string, PartWire>): { conns: OwnedWorldConnection[]; linked: LinkedWorldConnection[] } {
  const conns: OwnedWorldConnection[] = [];
  const linked: LinkedWorldConnection[] = [];
  const meta = lookupPart(partsByKey, brick.partNumber);
  if (!meta) return { conns, linked };
  for (let i = 0; i < meta.connections.length; i++) {
    const cp = meta.connections[i]!;
    if (!cp.type) continue;
    const link = brick.connexions[i];
    const [wx, wy] = transformLocalToWorld(cp.x, cp.y, brick, meta);
    const conn = {
      x: wx,
      y: wy,
      type: cp.type,
      angle: mod360(cp.angle + brick.orientation),
      brickId: brick.id,
      index: i,
    };
    // Taken ends are kept aside: one linked to a part being dragged
    // away is free for that drag.
    if (link && link.linkedTo !== '') linked.push({ ...conn, linkedTo: link.linkedTo });
    else conns.push(conn);
  }
  return { conns, linked };
}

function connectionsCached(
  map: BbmMap,
  partsByKey: Map<string, PartWire>,
): { conns: OwnedWorldConnection[]; linked: LinkedWorldConnection[] } {
  const hit = freeConnCache.get(map);
  if (hit && hit.partsByKey === partsByKey) return hit;
  const conns: OwnedWorldConnection[] = [];
  const linked: LinkedWorldConnection[] = [];
  let kept = brickConnCache.get(partsByKey);
  if (!kept) brickConnCache.set(partsByKey, (kept = new WeakMap()));
  for (const layer of map.layers) {
    if (!isBrickLayer(layer)) continue;
    for (const brick of layer.bricks) {
      let own = kept.get(brick);
      if (!own) kept.set(brick, (own = brickConnections(brick, partsByKey)));
      for (const c of own.conns) conns.push(c);
      for (const c of own.linked) linked.push(c);
    }
  }
  const entry = { partsByKey, conns, linked };
  freeConnCache.set(map, entry);
  return entry;
}

/**
 * Where the map's connections are, in cells of GRID_STUDS, kept from one
 * layout to the next: a new layout (after a drop, anyone's move) updates
 * only the parts that are new objects. A drag's start put every part's
 * ends in one list (about 25 ms on 7,520 parts at 4x slowed CPU, and as
 * much again collecting the garbage), and each of its frames went through
 * that list; it now looks at the cells around the dragged ends.
 */
const GRID_STUDS = 16;
/** Off: every end is gone through, as before (for tests). `looked`: how many ends were (for tests). */
export const snapIndex = { enabled: true, looked: 0 };

interface GridEntry {
  c: OwnedWorldConnection | LinkedWorldConnection;
  linked: boolean;
  layerId: string;
  /** The brick's index in its sheet, and the connection's on its part (the order the whole list had). */
  bi: number;
  cx: number;
  cy: number;
}

interface GridSheet {
  bricks: readonly Brick[];
  entries: GridEntry[][];
}

class ConnGrid {
  private sheets = new Map<string, GridSheet>();
  private cells = new Map<number | string, GridEntry[]>();
  private map: BbmMap | null = null;
  /** The sheets' order in the map, for ordering what is found as the whole list was. */
  order = new Map<string, number>();
  /** Free ends in all, and per brick id. */
  freeTotal = 0;
  freeOf = new Map<string, number>();
  constructor(private readonly partsByKey: Map<string, PartWire>, private readonly own: WeakMap<Brick, { conns: OwnedWorldConnection[]; linked: LinkedWorldConnection[] }>) {}

  update(map: BbmMap): void {
    if (map === this.map) return;
    this.map = map;
    this.order.clear();
    const seen = new Set<string>();
    map.layers.forEach((layer, li) => {
      if (!isBrickLayer(layer)) return;
      this.order.set(layer.id, li);
      seen.add(layer.id);
      const sheet = this.sheets.get(layer.id);
      const bricks = layer.bricks;
      if (!sheet || sheet.bricks.length !== bricks.length) {
        if (sheet) this.dropSheet(sheet);
        this.addSheet(layer.id, bricks);
        return;
      }
      if (sheet.bricks === bricks) return;
      for (let bi = 0; bi < bricks.length; bi++) {
        const b = bricks[bi]!;
        const was = sheet.bricks[bi]!;
        if (b === was) continue;
        if (b.id !== was.id) {
          // Reordered: the sheet again from the start.
          this.dropSheet(sheet);
          this.addSheet(layer.id, bricks);
          return;
        }
        this.dropEntries(sheet.entries[bi]!);
        sheet.entries[bi] = this.addBrick(layer.id, b, bi);
      }
      sheet.bricks = bricks;
    });
    for (const [id, sheet] of this.sheets) {
      if (seen.has(id)) continue;
      this.dropSheet(sheet);
      this.sheets.delete(id);
    }
  }

  /** The entries in the cells within `r` of (x, y), onto `out`; false when that would be most of the cells (then go through them all). */
  near(x: number, y: number, r: number, out: GridEntry[]): boolean {
    const x0 = Math.floor((x - r) / GRID_STUDS);
    const x1 = Math.floor((x + r) / GRID_STUDS);
    const y0 = Math.floor((y - r) / GRID_STUDS);
    const y1 = Math.floor((y + r) / GRID_STUDS);
    if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1)) || (x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) return false;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const arr = this.cells.get(cellKey(cx, cy));
        if (arr) for (const e of arr) out.push(e);
      }
    }
    return true;
  }

  /** Every entry. */
  all(out: GridEntry[]): void {
    for (const arr of this.cells.values()) for (const e of arr) out.push(e);
  }

  private addSheet(id: string, bricks: readonly Brick[]): void {
    const entries: GridEntry[][] = new Array(bricks.length);
    for (let bi = 0; bi < bricks.length; bi++) entries[bi] = this.addBrick(id, bricks[bi]!, bi);
    this.sheets.set(id, { bricks, entries });
  }

  private dropSheet(sheet: GridSheet): void {
    for (const e of sheet.entries) this.dropEntries(e);
  }

  private addBrick(layerId: string, b: Brick, bi: number): GridEntry[] {
    let own = this.own.get(b);
    if (!own) this.own.set(b, (own = brickConnections(b, this.partsByKey)));
    const out: GridEntry[] = [];
    const put = (c: OwnedWorldConnection | LinkedWorldConnection, linked: boolean) => {
      const e: GridEntry = { c, linked, layerId, bi, cx: Math.floor(c.x / GRID_STUDS), cy: Math.floor(c.y / GRID_STUDS) };
      const key = cellKey(e.cx, e.cy);
      const arr = this.cells.get(key);
      if (arr) arr.push(e);
      else this.cells.set(key, [e]);
      out.push(e);
    };
    for (const c of own.conns) put(c, false);
    for (const c of own.linked) put(c, true);
    if (own.conns.length > 0) {
      this.freeTotal += own.conns.length;
      this.freeOf.set(b.id, (this.freeOf.get(b.id) ?? 0) + own.conns.length);
    }
    return out;
  }

  private dropEntries(entries: readonly GridEntry[]): void {
    for (const e of entries) {
      const key = cellKey(e.cx, e.cy);
      const arr = this.cells.get(key);
      if (!arr) continue;
      const i = arr.indexOf(e);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.cells.delete(key);
      if (!e.linked) {
        this.freeTotal--;
        const n = (this.freeOf.get(e.c.brickId) ?? 1) - 1;
        if (n > 0) this.freeOf.set(e.c.brickId, n);
        else this.freeOf.delete(e.c.brickId);
      }
    }
  }
}

/** A cell's key: a number for any cell a layout really has, a string past that. */
function cellKey(cx: number, cy: number): number | string {
  const span = 1 << 24;
  if (cx > -span && cx < span && cy > -span && cy < span) return (cx + span) * 2 * span + (cy + span);
  return `${cx},${cy}`;
}

const grids = new WeakMap<Map<string, PartWire>, ConnGrid>();
function connGrid(map: BbmMap, partsByKey: Map<string, PartWire>): ConnGrid {
  let g = grids.get(partsByKey);
  if (!g) {
    let kept = brickConnCache.get(partsByKey);
    if (!kept) brickConnCache.set(partsByKey, (kept = new WeakMap()));
    grids.set(partsByKey, (g = new ConnGrid(partsByKey, kept)));
  }
  g.update(map);
  return g;
}

/**
 * The free ends within `r` of (x, y) that a drag of `excludeIds` can snap
 * to, in the order the whole list of them has (every free end, sheet by
 * sheet and part by part, then the ends linked to the moving set): the
 * same candidates, in the same order, as going through that list.
 */
function targetsNear(grid: ConnGrid, x: number, y: number, r: number, excludeIds: ReadonlySet<string>, keys: ReadonlySet<string>): OwnedWorldConnection[] {
  const found: GridEntry[] = [];
  if (!snapIndex.enabled || !grid.near(x, y, r, found)) {
    found.length = 0;
    grid.all(found);
  }
  snapIndex.looked += found.length;
  const ok = found.filter((e) => !excludeIds.has(e.c.brickId) && (!e.linked || keys.has((e.c as LinkedWorldConnection).linkedTo)));
  ok.sort((a, b) => Number(a.linked) - Number(b.linked) || grid.order.get(a.layerId)! - grid.order.get(b.layerId)! || a.bi - b.bi || a.c.index - b.c.index);
  return ok.map((e) => e.c);
}

/** Whether a drag of `excludeIds` has any end to snap to at all (the whole list wasn't empty). */
function anyTarget(grid: ConnGrid, excludeIds: ReadonlySet<string>, keys: ReadonlySet<string>): boolean {
  let moving = 0;
  for (const id of excludeIds) moving += grid.freeOf.get(id) ?? 0;
  if (grid.freeTotal - moving > 0) return true;
  const all: GridEntry[] = [];
  grid.all(all);
  return all.some((e) => e.linked && !excludeIds.has(e.c.brickId) && keys.has((e.c as LinkedWorldConnection).linkedTo));
}

interface MatchOffset {
  /** Rotation-aligned centre — where the brick should be placed with `newOrientation`. */
  newCentreX: number;
  newCentreY: number;
  /** New orientation for the candidate brick after snapping, degrees. */
  newOrientation: number;
  /** The target connection (where the two meet). */
  ringX: number;
  ringY: number;
}

interface PlaceMatch extends SnapCandidate {
  cc: PartWire['connections'][number];
  fc: WorldConnection;
}

/**
 * Pick the (existing connection, candidate connection) join for a new
 * part (snapFeel.pickSnap: reach, hold, switching, ties, speed gate).
 * Returns the rotation-aligned centre and new orientation so the
 * candidate's CP meets the target CP mouth-to-mouth.
 *
 * Mirrors desktop `newPartPlacementSnap` (ConnectionSnap.cpp):
 *   newCenter = target.worldPos - rotatePoint(c.position, newOrient)
 *
 * Null if nothing is within reach.
 */
function findBestConnectionMatch(
  candidate: PlaceCandidate,
  candidateConns: PartWire['connections'],
  free: OwnedWorldConnection[],
): MatchOffset | null {
  const reach = candidate.reach;
  const session = candidate.session;
  if (!(reach > 0) || candidate.bypass) {
    if (session) session.lock = null;
    return null;
  }
  const limit = holdReach(reach);
  const limitSq = limit * limit;

  // Pre-rotate candidate connection points using current orientation to
  // compute world positions for distance checks.
  const theta0 = (candidate.orientation * Math.PI) / 180;
  const cos0 = Math.cos(theta0);
  const sin0 = Math.sin(theta0);

  const matches: PlaceMatch[] = [];
  for (let ci = 0; ci < candidateConns.length; ci++) {
    const cc = candidateConns[ci]!;
    if (!cc.type) continue;
    // Current world position of this CP (at candidate's current orientation).
    const candWorldX = candidate.centreX + cc.x * cos0 - cc.y * sin0;
    const candWorldY = candidate.centreY + cc.x * sin0 + cc.y * cos0;
    for (const fc of free) {
      if (fc.type !== cc.type) continue;
      const ddx = fc.x - candWorldX;
      const ddy = fc.y - candWorldY;
      const distSq = ddx * ddx + ddy * ddy;
      if (distSq > limitSq) continue;
      const dist = Math.sqrt(distSq);
      // The placed part sits centred on the cursor: its connection's
      // distance to the cursor is just its distance from the centre.
      matches.push({
        movingKey: `new#${ci}`,
        targetKey: connKey(fc.brickId, fc.index),
        dist,
        mouseDist: Math.hypot(cc.x, cc.y),
        cc,
        fc,
      });
    }
  }
  const pick = session
    ? session.step(matches, reach, { ...(candidate.final ? { final: true } : {}) })
    : pickSnap(matches, null, reach);
  if (!pick) return null;
  const { cc, fc } = pick;
  // Required orientation: moving CP angle + newOrientation = target angle + 180°
  const newOrientation = mod360(fc.angle + 180 - cc.angle);
  // Rotation-aligned centre: target.worldPos - rotate(cp.position, newOrient)
  const aligned = rotationAlignedCentre(fc.x, fc.y, cc.x, cc.y, newOrientation);
  return { newCentreX: aligned.x, newCentreY: aligned.y, newOrientation, ringX: fc.x, ringY: fc.y };
}

/** The brick's pivot (sprite centre), then rotate the local point into world. */
function transformLocalToWorld(
  localX: number,
  localY: number,
  brick: Brick,
  part: PartWire,
): [number, number] {
  const { x: cx, y: cy } = pivotOf(brick, part);
  const theta = (brick.orientation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [cx + localX * cos - localY * sin, cy + localX * sin + localY * cos];
}

function isBrickLayer(layer: { type: string }): layer is LayerBrick {
  return layer.type === 'brick';
}

export function lookupPart(
  partsByKey: Map<string, PartWire>,
  partNumber: string,
): PartWire | undefined {
  // Bricks store the catalog KEY (`<partNumber>.<colorCode>` lowercased)
  // in their `partNumber` field. The catalog's `partNumber` is just the
  // numeric prefix WITHOUT color code. Look up by `key` first; only
  // fall back to a `partNumber`-only match for bricks that arrived
  // without a color code (group parts, some custom uploads).
  const lower = partNumber.toLowerCase();
  const direct = partsByKey.get(lower);
  if (direct) return direct;
  // The partNumber-only fallback is an O(catalog) scan; memoise it per
  // catalog (hits AND misses) instead of rescanning for every brick on
  // every drag frame (~166 ms/frame at 5k bricks of an unknown part).
  let memo = fallbackMemo.get(partsByKey);
  if (!memo) {
    memo = new Map();
    fallbackMemo.set(partsByKey, memo);
  }
  if (memo.has(lower)) return memo.get(lower);
  let found: PartWire | undefined;
  for (const p of partsByKey.values()) {
    if (p.partNumber.toLowerCase() === lower) {
      found = p;
      break;
    }
  }
  memo.set(lower, found);
  return found;
}

const fallbackMemo = new WeakMap<Map<string, PartWire>, Map<string, PartWire | undefined>>();

function mod360(v: number): number {
  const r = v % 360;
  return r < 0 ? r + 360 : r;
}

// ---------------------------------------------------------------------------
// Live drag snap — port of MapView::applyLiveConnectionSnap
// (MapViewDrag.cpp:239-410).
// ---------------------------------------------------------------------------

/**
 * A non-leader brick moving rigidly with the leader in a multi-select
 * drag. Its current centre is `leader centre + (offsetX, offsetY)`.
 */
export interface DragSibling {
  id: string;
  /** Catalog metadata; undefined = no connection geometry (skipped). */
  part: PartWire | undefined;
  /** Per-connection link state, index-aligned with `part.connections`. */
  links: { linkedTo: string; id?: string }[];
  /** Centre offset from the leader's centre, in studs. */
  offsetX: number;
  offsetY: number;
  orientation: number;
}

export interface DragSnapInput {
  /** Catalog metadata for the dragged brick (the "leader" — the one
   *  the cursor is on; the rest of the selection moves rigidly with it). */
  part: PartWire | undefined;
  /** Brick id of the leader (excluded from "free targets"). */
  movingId: string;
  /**
   * Every brick id participating in this drag — for multi-select drag
   * the user grabs ONE brick but the entire selection translates. We
   * use this to mask out free conns on the rest of the selection so a
   * group never "self-snaps" to itself. Empty/unset = single-brick drag,
   * same as `[movingId]`.
   */
  movingIds?: string[];
  /**
   * The other bricks of a multi-select drag, with their connection
   * geometry. Desktop tries EVERY free connection of EVERY moving brick
   * (MapViewDrag.cpp:270-290), not only the grabbed one's.
   */
  siblings?: DragSibling[];
  /**
   * The leader's current per-connection link state. Index-aligned with
   * `part.connections`. Connections whose `linkedTo` is non-empty are
   * skipped — they're already glued to another brick, so the user is
   * moving the whole chain and we don't try to re-snap that joint.
   * Mirrors `MapView::applyLiveConnectionSnap` lines 277-279 and the
   * `master.connections[activeConnIdx].linkedToId` check in
   * `masterBrickSnap` (ConnectionSnap.cpp:93-94).
   */
  movingLinks: { linkedTo: string; id?: string }[];
  /** Current (mid-drag) pivot (sprite centre) of the LEADER in studs. */
  centreX: number;
  centreY: number;
  /**
   * Leader displayArea size in studs. The grid fallback rounds the
   * displayArea TOP-LEFT like desktop's commit (MapViewDrag.cpp:572-580);
   * omitted = 0, i.e. round the centre.
   */
  width?: number;
  height?: number;
  /** Leader pivot minus displayArea centre (parts with a <hull>); omitted = 0. */
  pivotOffsetX?: number;
  pivotOffsetY?: number;
  /**
   * Where the pointer has the leader's snap corner (gridSnap.ts
   * grabSnapCorner, moved with the drag), in studs; the grid puts it on a
   * grid point. Omitted: the box's top-left.
   */
  snapCornerX?: number;
  snapCornerY?: number;
  /** Mouse position in studs — a tiebreaker between snap candidates, and what the grid snap follows. */
  mouseStudX: number;
  mouseStudY: number;
  /** Leader brick orientation. */
  orientation: number;
  /** Active grid snap step in studs (0 = off). */
  snapStepStuds: number;
  /** Connection-snap reach in studs (`snapReachStuds`); 0 = no connection snap. */
  reach: number;
  /** The drag's session (hold, speed gate); none = a one-off snap. */
  session?: SnapSession;
  /** Alt held: no connection snap, grid snap only. */
  bypass?: boolean;
  /** The drop: one last snap with the speed gate off. */
  final?: boolean;
  /**
   * Grab anchor: index into `part.connections` of the leader connection
   * nearest the click that started the drag (desktop `captureGrabAnchor`,
   * MapViewDrag.cpp:155-217 + MapView.cpp:538-543). For a single-brick
   * drag this connection leads the snap: it is tried on its own first,
   * and the other free connections are only considered when it has no
   * target in reach. Ignored for multi-brick drags.
   */
  leadConnIndex?: number;
}

export interface DragSnapResult {
  /** Where the LEADER's centre should be placed. For a multi-brick drag
   *  every sibling moves by the same (result - input) translation. */
  centreX: number;
  centreY: number;
  /** True if a connection-snap fired. */
  snappedToConnection: boolean;
  /**
   * World-space coords of the connection point that fired the snap —
   * used to draw the green ring overlay. Null when no connection snap.
   */
  ringStudX: number | null;
  ringStudY: number | null;
  /**
   * The moving connection that joins (or would join): the grab anchor of a
   * single-brick drag, else the free one nearest the cursor; where it is
   * after the snap. Null when the moving set has no free connection.
   */
  movingStudX: number | null;
  movingStudY: number | null;
  /**
   * Orientation the dragged brick should be rotated to so the matched
   * CPs align angle-to-angle (mouth-to-mouth). Only for a single-brick
   * drag — desktop never rotates a multi-brick group on snap
   * (MapViewDrag.cpp:551-567). Null otherwise. Degrees, [0, 360).
   * When set, `centreX/Y` is the rotation-aligned centre: the moving
   * connection, rotated to `newOrientation`, lands exactly on the target.
   */
  newOrientation: number | null;
  /**
   * A multi-brick snap whose ends don't already face: the whole group
   * turns about the joined connection and lands on the target. Every
   * moving point p (pivot, studs, where the pointer has it) goes to
   * applyGroupTurn(groupTurn, p), every orientation gains its degrees.
   * Null for a single brick (newOrientation) and for a straight join.
   */
  groupTurn: GroupTurn | null;
  /** Studs from the raw grabbed end to the joined target; null without a connection snap. */
  snapDist: number | null;
  /** Free connections considered on the moving set (status-bar hint). */
  movingConnCount: number;
}

/**
 * Compute the centre position the dragged brick should be at, given:
 *   - free connections on every moving brick (local-coords from catalog)
 *   - free connections on every NON-moving brick in the map
 * Every (moving conn, target conn) pair within the hold distance is a
 * candidate; snapFeel.pickSnap picks one (reach, hold, clearly-better
 * switching, steady ties, speed gate).
 *
 * Single brick: the result is rotation-aligned (ConnectionSnap.cpp,
 * newCentre = target - rotate(conn.local, newOrient)). Multi-brick: pure
 * translation of the whole group.
 *
 * Falls back to grid snap when no connection match is picked.
 */
export function liveDragSnap(
  drag: DragSnapInput,
  map: BbmMap,
  partsByKey: Map<string, PartWire>,
): DragSnapResult {
  const reach = drag.bypass ? 0 : drag.reach;
  const limit = holdReach(reach);
  const limitSq = limit * limit;

  // Free targets — every brick NOT in the moving set. For a multi-brick
  // drag this excludes the whole selection so the group can't snap to
  // its own connection points (matches desktop's `movingGuids` arg to
  // `scanForNearestFreeTarget` — ConnectionSnap.cpp).
  const siblings = drag.siblings ?? [];
  const movingSet = new Set<string>(drag.movingIds ?? [drag.movingId]);
  movingSet.add(drag.movingId);
  for (const s of siblings) movingSet.add(s.id);
  // Links to the parts left behind don't hold while dragging; links
  // inside the moving set do.
  const keys = linkKeys([
    { id: drag.movingId, connexions: drag.movingLinks },
    ...siblings.map((s) => ({ id: s.id, connexions: s.links })),
    ...[...movingSet].map((id) => ({ id, connexions: [] })),
  ]);
  // The map's ends by place (`ConnGrid`): each moving end looks only near itself.
  const grid = reach > 0 ? connGrid(map, partsByKey) : null;
  const hasTargets = grid ? anyTarget(grid, movingSet, keys) : false;
  const single = siblings.length === 0;

  // Free connections on every moving brick at its CURRENT pose. Skip
  // conns that are already linked to another brick — desktop bails on
  // those at MapView::applyLiveConnectionSnap.
  interface MovingConn {
    /** True for the leader's connections; `index` is into its part. */
    leader: boolean;
    key: string;
    index: number;
    worldX: number;
    worldY: number;
    type: string;
    mouseDist: number;
    localX: number;
    localY: number;
    localAngle: number;
    /** World angle the connection faces now. */
    worldAngle: number;
  }
  const movingConns: MovingConn[] = [];
  const addConns = (
    id: string,
    leader: boolean,
    part: PartWire | undefined,
    links: { linkedTo: string; id?: string }[],
    cx: number,
    cy: number,
    orientation: number,
  ) => {
    if (!part) return;
    const theta = (orientation * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let i = 0; i < part.connections.length; i++) {
      const cp = part.connections[i]!;
      if (!cp.type) continue;
      if (takenWhileMoving(links[i]?.linkedTo, keys)) continue;
      const wx = cx + cp.x * cos - cp.y * sin;
      const wy = cy + cp.x * sin + cp.y * cos;
      movingConns.push({
        leader,
        key: connKey(id, i),
        index: i,
        worldX: wx,
        worldY: wy,
        type: cp.type,
        mouseDist: Math.hypot(wx - drag.mouseStudX, wy - drag.mouseStudY),
        localX: cp.x,
        localY: cp.y,
        localAngle: cp.angle,
        worldAngle: cp.angle + orientation,
      });
    }
  };
  addConns(drag.movingId, true, drag.part, drag.movingLinks, drag.centreX, drag.centreY, drag.orientation);
  for (const s of siblings) {
    addConns(s.id, false, s.part, s.links, drag.centreX + s.offsetX, drag.centreY + s.offsetY, s.orientation);
  }

  // As in BlueBrick (LayerBrick.getMovedSnapPoint), the active connection
  // is the grabbed part's end nearest the grab, picked on the press and
  // kept for the whole drag: it alone snaps, for one part or a selection.
  // Taken (joined inside the moving set), nothing snaps. Without a grab
  // anchor (a programmatic snap), every free moving end is tried.
  const hasLead = drag.leadConnIndex !== undefined && drag.leadConnIndex >= 0;
  let lead = hasLead ? movingConns.find((m) => m.leader && m.index === drag.leadConnIndex) : undefined;
  // The grabbed part has no free end (a flex half in the middle of a picked
  // run): the moving set's free end nearest the grabbed end leads instead, as
  // a BlueBrick group's own connection does (the desktop's captureGrabAnchor).
  // The set moves rigidly, so it is the same end all through the drag.
  const grabbed = hasLead ? drag.part?.connections[drag.leadConnIndex!] : undefined;
  if (hasLead && !lead && grabbed) {
    const t = (drag.orientation * Math.PI) / 180;
    const gx = drag.centreX + grabbed.x * Math.cos(t) - grabbed.y * Math.sin(t);
    const gy = drag.centreY + grabbed.x * Math.sin(t) + grabbed.y * Math.cos(t);
    for (const m of movingConns) {
      if (!lead || Math.hypot(m.worldX - gx, m.worldY - gy) < Math.hypot(lead.worldX - gx, lead.worldY - gy)) lead = m;
    }
  }

  interface Pair extends SnapCandidate {
    mc: MovingConn;
    tc: OwnedWorldConnection;
    /** Signed turn that makes the two ends face. */
    delta: number;
  }
  const pairs = (candidates: MovingConn[]): Pair[] => {
    const out: Pair[] = [];
    for (const mc of candidates) {
      for (const tc of targetsNear(grid!, mc.worldX, mc.worldY, limit, movingSet, keys)) {
        if (tc.type !== mc.type) continue;
        const dx = tc.x - mc.worldX;
        const dy = tc.y - mc.worldY;
        const sq = dx * dx + dy * dy;
        if (sq > limitSq) continue;
        // Any angle: the part or selection turns to make the ends face.
        const delta = facingTurn(tc.angle, mc.worldAngle);
        out.push({
          movingKey: mc.key,
          targetKey: connKey(tc.brickId, tc.index),
          dist: Math.sqrt(sq),
          mouseDist: mc.mouseDist,
          turn: Math.abs(delta),
          mc,
          tc,
          delta,
        });
      }
    }
    return out;
  };
  const choose = (cands: Pair[]): Pair | null => {
    if (drag.session) return drag.session.step(cands, reach, { ...(drag.final ? { final: true } : {}) });
    return pickSnap(cands, null, reach);
  };

  let best: Pair | null = null;
  if (reach > 0 && movingConns.length > 0 && hasTargets) {
    // Measured from where the pointer has the parts (never the snapped
    // pose), so the hold and switch rules see a steady end.
    best = choose(pairs(hasLead ? (lead ? [lead] : []) : movingConns));
  } else if (drag.session) {
    drag.session.lock = null;
  }

  // The connection to highlight: the joined one, else the grab anchor,
  // else the free one nearest the cursor.
  let shown: MovingConn | undefined = best?.mc ?? lead;
  if (!shown) for (const m of movingConns) if (!shown || m.mouseDist < shown.mouseDist) shown = m;

  if (best === null) {
    const r = gridFallback(drag, movingConns.length);
    if (shown) {
      r.movingStudX = shown.worldX + (r.centreX - drag.centreX);
      r.movingStudY = shown.worldY + (r.centreY - drag.centreY);
    }
    return r;
  }
  const { mc, tc } = best;
  if (!single) {
    // The whole group turns about the joined connection (none when the
    // ends already face), then that connection lands on the target.
    const groupTurn: GroupTurn | null =
      Math.abs(best.delta) > 1e-6
        ? { degrees: best.delta, pivotX: mc.worldX, pivotY: mc.worldY, toX: tc.x, toY: tc.y }
        : null;
    const leader = groupTurn
      ? applyGroupTurn(groupTurn, drag.centreX, drag.centreY)
      : { x: drag.centreX + (tc.x - mc.worldX), y: drag.centreY + (tc.y - mc.worldY) };
    return {
      centreX: leader.x,
      centreY: leader.y,
      snappedToConnection: true,
      ringStudX: tc.x,
      ringStudY: tc.y,
      movingStudX: tc.x,
      movingStudY: tc.y,
      newOrientation: null,
      groupTurn,
      snapDist: best.dist,
      movingConnCount: movingConns.length,
    };
  }
  // Required orientation: moving CP's local angle + new orientation = target angle + 180°.
  const newOrientation = mod360(tc.angle + 180 - mc.localAngle);
  const aligned = rotationAlignedCentre(tc.x, tc.y, mc.localX, mc.localY, newOrientation);
  return {
    centreX: aligned.x,
    centreY: aligned.y,
    snappedToConnection: true,
    ringStudX: tc.x,
    ringStudY: tc.y,
    movingStudX: tc.x,
    movingStudY: tc.y,
    newOrientation,
    groupTurn: null,
    snapDist: best.dist,
    movingConnCount: movingConns.length,
  };
}

/**
 * Grab anchor — port of desktop `nearestConnectionIndex`
 * (MapViewDrag.cpp). The connection of `brick` whose world position is
 * nearest to the click. The grabbed end leads even when it is linked to a
 * part left behind (the drag pulls it away); only an end linked inside the
 * moving set (`keys`, from linkKeys; default: just this brick) is passed
 * over. Falls back to the nearest connection of any link state; -1 when
 * the part has no typed connections.
 */
export function nearestConnectionIndex(
  brick: Pick<Brick, 'displayArea' | 'orientation' | 'connexions'> & { id?: string },
  part: PartWire | undefined,
  clickX: number,
  clickY: number,
  keys: ReadonlySet<string> = linkKeys([{ id: brick.id ?? '', connexions: brick.connexions }]),
): number {
  if (!part || part.connections.length === 0) return -1;
  const { x: cx, y: cy } = pivotOf(brick, part);
  const t = (brick.orientation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const pick = (freeOnly: boolean): number => {
    let bestIdx = -1;
    let bestSq = Infinity;
    for (let i = 0; i < part.connections.length; i++) {
      const c = part.connections[i]!;
      if (!c.type) continue;
      if (freeOnly && takenWhileMoving(brick.connexions[i]?.linkedTo, keys)) continue;
      const wx = cx + c.x * cos - c.y * sin;
      const wy = cy + c.x * sin + c.y * cos;
      const sq = (wx - clickX) ** 2 + (wy - clickY) ** 2;
      if (sq < bestSq) {
        bestSq = sq;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  const free = pick(true);
  return free >= 0 ? free : pick(false);
}

/**
 * Centre that puts a brick's local connection point `(localX, localY)`
 * exactly on `(targetX, targetY)` once the brick is at `orientation`:
 * `target - rotate(local, orientation)` (ConnectionSnap.cpp:109).
 */
export function rotationAlignedCentre(
  targetX: number,
  targetY: number,
  localX: number,
  localY: number,
  orientation: number,
): { x: number; y: number } {
  const t = (orientation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: targetX - (localX * c - localY * s), y: targetY - (localX * s + localY * c) };
}

/**
 * Grid fallback: the leader's snap corner lands on the grid as BlueBrick's
 * getMovedSnapPoint puts it (gridSnap.ts dragShift), as the desktop does
 * live and on the drop (MapViewDrag.cpp brickGridShift). Without the
 * corner, the box's top-left stands in.
 */
function gridFallback(drag: DragSnapInput, movingConnCount: number): DragSnapResult {
  const base = {
    snappedToConnection: false,
    ringStudX: null,
    ringStudY: null,
    movingStudX: null,
    movingStudY: null,
    newOrientation: null,
    groupTurn: null,
    snapDist: null,
    movingConnCount,
  };
  if (drag.snapStepStuds <= 0) return { ...base, centreX: drag.centreX, centreY: drag.centreY };
  const corner = {
    x: drag.snapCornerX ?? drag.centreX - (drag.width ?? 0) / 2 - (drag.pivotOffsetX ?? 0),
    y: drag.snapCornerY ?? drag.centreY - (drag.height ?? 0) / 2 - (drag.pivotOffsetY ?? 0),
  };
  const shift = dragShift({ x: drag.mouseStudX, y: drag.mouseStudY }, corner, drag.snapStepStuds);
  return { ...base, centreX: drag.centreX + shift.x, centreY: drag.centreY + shift.y };
}

