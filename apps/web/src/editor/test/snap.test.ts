import { describe, expect, it } from 'vitest';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../../api';
import { rebuildConnectivity } from '@cld/parts-catalog/browser';
import { catalogFromParts } from '../catalogFromParts';
import {
  linkKeys,
  liveDragSnap,
  nearestConnectionIndex,
  rotationAlignedCentre,
  snapPlacement,
  snapIndex,
  snapToAnchorBrick,
  type PlaceCandidate,
} from '../snap';
import { SnapSession, applyGroupTurn, wrap180 } from '../snapFeel';

// ---- helpers ---------------------------------------------------------------

function makePart(overrides: Partial<PartWire> = {}): PartWire {
  return {
    key: 'test.0',
    partNumber: 'TEST',
    colorCode: '0',
    kind: 'leaf',
    description: 'test part',
    sortingKey: '0',
    spritePath: '',
    pxPerStud: 32,
    category: 'test',
    connections: [],
    subparts: [],
    hullPts: [],
    source: 'bundled',
    customPartId: null,
    ...overrides,
  };
}

function makeBrick(overrides: {
  id?: string;
  partNumber?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  orientation?: number;
  connexions?: import('@cld/model').Connexion[];
  activeConnectionPointIndex?: number;
} = {}): import('@cld/model').Brick {
  return {
    id: overrides.id ?? 'b1',
    partNumber: overrides.partNumber ?? 'TEST',
    altitude: 0,
    orientation: overrides.orientation ?? 0,
    activeConnectionPointIndex: overrides.activeConnectionPointIndex ?? 0,
    connexions: overrides.connexions ?? [],
    displayArea: {
      x: overrides.x ?? 0,
      y: overrides.y ?? 0,
      width: overrides.w ?? 8,
      height: overrides.h ?? 8,
    },
    myGroup: '',
  };
}

const HULL: import('@cld/model').HullProperties = {
  isVisible: false,
  hullColor: { kind: 'argb', argb: '00000000' },
  hullThickness: 0,
};

function emptyMap(): BbmMap {
  return { layers: [] } as unknown as BbmMap;
}

function brickLayerMap(bricks: import('@cld/model').Brick[]): BbmMap {
  return {
    layers: [{
      type: 'brick',
      id: 'L1',
      name: 'Layer 1',
      visible: true,
      transparency: 0,
      hullProperties: HULL,
      displayBrickElevation: false,
      bricks,
      groups: [],
    }],
  } as unknown as BbmMap;
}

// ---- snapPlacement — grid snap --------------------------------------------

describe('snapPlacement — grid snap', () => {
  const partsByKey = new Map<string, PartWire>([['test.0', makePart()]]);

  it('puts the box corner on the grid, held by its middle as BlueBrick drops a part', () => {
    const candidate: PlaceCandidate = {
      part: makePart(),
      // The corner is 4 studs up and left of the cursor: 4 whole steps from
      // the grid line at or before it (3, 10), so (-1, 6), centre (3, 10).
      centreX: 3.7,
      centreY: 10.2,
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 1, reach: 3,
    };
    const result = snapPlacement(candidate, emptyMap(), partsByKey);
    expect(result.snappedToConnection).toBe(false);
    expect(result.newOrientation).toBeNull();
    expect(result.centreX).toBeCloseTo(3);
    expect(result.centreY).toBeCloseTo(10);
  });

  it('passes through unchanged when snap step is 0', () => {
    const candidate: PlaceCandidate = {
      part: makePart(),
      centreX: 3.7,
      centreY: 5.9,
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 0, reach: 4,
    };
    const result = snapPlacement(candidate, emptyMap(), partsByKey);
    expect(result.centreX).toBe(3.7);
    expect(result.centreY).toBe(5.9);
  });

  it('snaps on a larger step', () => {
    const candidate: PlaceCandidate = {
      part: makePart(),
      centreX: 19,  // TL = 19 - 4 = 15, nearest step-8 = 16, centre = 20
      centreY: 36,  // TL = 36 - 4 = 32, nearest step-8 = 32, centre = 36
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 8, reach: 10,
    };
    const result = snapPlacement(candidate, emptyMap(), partsByKey);
    expect(result.centreX).toBeCloseTo(20);
    expect(result.centreY).toBeCloseTo(36);
  });
});

// ---- snapPlacement — connection snap --------------------------------------

describe('snapPlacement — connection snap', () => {
  it('snaps to a nearby free connection on an existing brick', () => {
    const partWithConn = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    // Anchor brick: centre at (0, 0), connection at (4, 0) world.
    const anchor = makeBrick({ x: -4, y: -4, w: 8, h: 8, orientation: 0 });
    const partsByKey = new Map<string, PartWire>([['test.0', partWithConn]]);
    const map = brickLayerMap([anchor]);

    // Candidate: part with a female conn at (-4, 0) — currently near (4, 0).
    const newPart = makePart({
      connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    const candidate: PlaceCandidate = {
      part: newPart,
      centreX: 7,
      centreY: 0,
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 1, reach: 3,
    };
    const result = snapPlacement(candidate, map, partsByKey);
    expect(result.snappedToConnection).toBe(true);
    // New centre must place the new brick's conn exactly on anchor's conn.
    expect(result.centreX).toBeCloseTo(8); // 4 (anchor conn) - (-4) (new conn local)
    expect(result.centreY).toBeCloseTo(0);
  });

  it('does NOT snap when existing connection is already linked', () => {
    const partWithConn = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    // Anchor brick with the connection already linked.
    const anchor = makeBrick({
      x: -4, y: -4, w: 8, h: 8,
      connexions: [{ id: 'cx1', linkedTo: 'someOtherBrick' }],
    });
    const partsByKey = new Map<string, PartWire>([['test.0', partWithConn]]);
    const map = brickLayerMap([anchor]);

    const newPart = makePart({
      connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    const candidate: PlaceCandidate = {
      part: newPart,
      centreX: 8,
      centreY: 0,
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 1, reach: 3,
    };
    const result = snapPlacement(candidate, map, partsByKey);
    // Linked conn must be ignored — falls back to grid snap.
    expect(result.snappedToConnection).toBe(false);
  });

  it('returns unsnapped position when part has no connections', () => {
    const partsByKey = new Map<string, PartWire>([['test.0', makePart()]]);
    const candidate: PlaceCandidate = {
      part: makePart(),
      centreX: 5.5,
      centreY: 5.5,
      orientation: 0,
      width: 8,
      height: 8,
      snapStepStuds: 1, reach: 3,
    };
    const result = snapPlacement(candidate, emptyMap(), partsByKey);
    // Falls through to grid snap, no connection snap possible.
    expect(result.snappedToConnection).toBe(false);
  });
});

// ---- snapToAnchorBrick ----------------------------------------------------

describe('snapToAnchorBrick', () => {
  it('returns null when the new part has no connections', () => {
    const anchor = makeBrick();
    const anchorMeta = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const newPart = makePart(); // no connections
    expect(snapToAnchorBrick(anchor, anchorMeta, newPart, 8, 8)).toBeNull();
  });

  it('returns null when anchor has no compatible connection type', () => {
    const anchor = makeBrick({ connexions: [] });
    const anchorMeta = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const newPart = makePart({
      connections: [{ type: 'female', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    // 'male' ≠ 'female', so no snap.
    expect(snapToAnchorBrick(anchor, anchorMeta, newPart, 8, 8)).toBeNull();
  });

  it('returns a snap result when types match', () => {
    const anchor = makeBrick({ x: 0, y: 0, w: 8, h: 8, orientation: 0, connexions: [] });
    const anchorMeta = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const newPart = makePart({
      connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    const result = snapToAnchorBrick(anchor, anchorMeta, newPart, 8, 8);
    expect(result).not.toBeNull();
    expect(result!.snappedToConnection).toBe(true);
    // Anchor brick at displayArea (0,0,8,8) → centre (4,4).
    // Anchor conn at (+4, 0) from centre → world (8, 4).
    // newOrient = targetAngle+180-nc.angle = (0+0)+180-180 = 0°.
    // rotate(nc.local=(-4,0), orient=0°) = (-4, 0).
    // new centre = anchorCP - rotated nc = (8,4) - (-4,0) = (12, 4).
    expect(result!.centreX).toBeCloseTo(12);
    expect(result!.centreY).toBeCloseTo(4);
  });

  it('skips already-linked connections when connexions data exists', () => {
    const anchor = makeBrick({
      x: 0, y: 0, w: 8, h: 8, orientation: 0,
      connexions: [{ id: 'cx2', linkedTo: 'taken' }],
    });
    const anchorMeta = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const newPart = makePart({
      connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    // The only connection is already linked, so snap should fail.
    expect(snapToAnchorBrick(anchor, anchorMeta, newPart, 8, 8)).toBeNull();
  });

  it('takes the first free connection in order, whatever the active one (MapView.cpp:1226-1258)', () => {
    const anchorMeta = makePart({
      connections: [
        { type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 },
        { type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 },
      ],
    });
    const newPart = makePart({
      connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }],
    });
    // Both free and connection 1 active: desktop still anchors on 0.
    const both = makeBrick({ x: 0, y: 0, w: 8, h: 8, activeConnectionPointIndex: 1, connexions: [{ id: 'a0', linkedTo: '' }, { id: 'a1', linkedTo: '' }] });
    expect(snapToAnchorBrick(both, anchorMeta, newPart, 8, 8)!.centreX).toBeCloseTo(-4);
    // Connection 0 taken: the free one, 1.
    const oneTaken = makeBrick({ x: 0, y: 0, w: 8, h: 8, connexions: [{ id: 'a0', linkedTo: 'x' }, { id: 'a1', linkedTo: '' }] });
    expect(snapToAnchorBrick(oneTaken, anchorMeta, newPart, 8, 8)!.centreX).toBeCloseTo(12);
  });

  it('measures the anchor connection from its sprite centre (pivot)', () => {
    // 32 x 16 px sprite, hull = left half: the pivot is 1 stud right of
    // the 2 x 2 box centre.
    const anchorMeta = makePart({
      pxPerStud: 8,
      spriteSize: { w: 32, h: 16 },
      hullPts: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 15 }],
      connections: [{ type: 'male', x: 2, y: 0, angle: 0, electricPlug: 0 }],
    });
    const newPart = makePart({
      connections: [{ type: 'male', x: -1, y: 0, angle: 180, electricPlug: 0 }],
    });
    // Box (0,0)-(2,2): centre (1,1), pivot (2,1), connection at (4,1).
    const anchor = makeBrick({ x: 0, y: 0, w: 2, h: 2, connexions: [{ id: 'a0', linkedTo: '' }] });
    const r = snapToAnchorBrick(anchor, anchorMeta, newPart, 2, 2)!;
    expect(r.centreX).toBeCloseTo(5);
    expect(r.centreY).toBeCloseTo(1);
  });
});

// ---- liveDragSnap ---------------------------------------------------------

describe('liveDragSnap', () => {
  it('returns grid-snapped position when map is empty', () => {
    const part = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const partsByKey = new Map<string, PartWire>([['test.0', part]]);
    const result = liveDragSnap(
      {
        part,
        movingId: 'drag1',
        movingLinks: [],
        centreX: 3.3,
        centreY: 7.8,
        mouseStudX: 3,
        mouseStudY: 7,
        orientation: 0,
        snapStepStuds: 1, reach: 3,
      },
      emptyMap(),
      partsByKey,
    );
    expect(result.snappedToConnection).toBe(false);
    // Its corner (no size given: the centre) is 0.3 and 0.8 studs past the
    // pointer, so a step past the grid line at or before it.
    expect(result.centreX).toBeCloseTo(4);
    expect(result.centreY).toBeCloseTo(8);
  });

  it('excludes the moving brick from target connections', () => {
    const part = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const dragged = makeBrick({ id: 'drag1', x: 0, y: 0, w: 8, h: 8 });
    const partsByKey = new Map<string, PartWire>([
      ['test.0', part],
      ['drag1', part],
    ]);
    // Only the dragged brick is in the map — it should not snap to itself.
    const map = brickLayerMap([dragged]);
    const result = liveDragSnap(
      {
        part,
        movingId: 'drag1',
        movingLinks: [],
        centreX: 4,
        centreY: 4,
        mouseStudX: 4,
        mouseStudY: 4,
        orientation: 0,
        snapStepStuds: 0, reach: 4,
      },
      map,
      partsByKey,
    );
    expect(result.snappedToConnection).toBe(false);
  });

  it('snaps to a compatible connection on a nearby stationary brick', () => {
    const part = makePart({
      connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }],
    });
    const stationary = makeBrick({ id: 'static1', x: 8, y: 0, w: 8, h: 8 }); // centre (12, 4)
    const partsByKey = new Map<string, PartWire>([['test.0', part]]);
    const map = brickLayerMap([stationary]);
    // Dragged brick centre at (7, 4) — its conn is at (7+4, 4) = (11, 4).
    // Stationary conn is at (12+4, 4) = (16, 4)… actually (12-4, 4) = (8, 4)
    // because angle=0 means CP is at (+4, 0) from centre.
    // Actually stationary centre = (8 + 4, 0 + 4) = (12, 4), conn at (12+4, 4) = (16, 4).
    // Dragged centre (7, 4), conn at (7+4, 4) = (11, 4). Distance = 5 studs.
    // With reach = 3 (step 1 + 2), 5 > 3, so NO snap.
    // Move dragged to (11, 4) → conn at (15, 4), distance to (16, 4) = 1 → snap.
    const result = liveDragSnap(
      {
        part,
        movingId: 'drag1',
        movingLinks: [],
        centreX: 11,
        centreY: 4,
        mouseStudX: 11,
        mouseStudY: 4,
        orientation: 0,
        snapStepStuds: 1, reach: 3,
      },
      map,
      partsByKey,
    );
    expect(result.snappedToConnection).toBe(true);
    expect(result.ringStudX).not.toBeNull();
    expect(result.ringStudY).not.toBeNull();
  });

  it('passes through unsnapped when step is 0 and no connections match', () => {
    const part = makePart();
    const partsByKey = new Map<string, PartWire>([['test.0', part]]);
    const result = liveDragSnap(
      {
        part,
        movingId: 'drag1',
        movingLinks: [],
        centreX: 3.14,
        centreY: 2.71,
        mouseStudX: 3,
        mouseStudY: 2,
        orientation: 0,
        snapStepStuds: 0, reach: 4,
      },
      emptyMap(),
      partsByKey,
    );
    expect(result.centreX).toBe(3.14);
    expect(result.centreY).toBe(2.71);
    expect(result.snappedToConnection).toBe(false);
  });
});

// ---- liveDragSnap — desktop parity (rotation, multi-select, grid TL) -------

describe('liveDragSnap — desktop parity', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });

  it('rotation-aligns the centre so the moving joint lands exactly on the target', () => {
    const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
    const oneEnd = makePart({ key: 'end.0', partNumber: 'END', connections: [conn(4, 0, 0)] });
    const partsByKey = new Map<string, PartWire>([['test.0', track], ['end.0', oneEnd]]);
    // Stationary centre (12,4): free conns (8,4)@180 and (16,4)@0.
    const map = brickLayerMap([makeBrick({ id: 's', x: 8, y: 0, w: 8, h: 8 })]);
    // Dragged at 90°: local (4,0) → world offset (0,4). Centre (16,1) puts
    // the conn at (16,5), 1 stud from the target (16,4).
    const r = liveDragSnap(
      {
        part: oneEnd, movingId: 'd', movingLinks: [],
        centreX: 16, centreY: 1, mouseStudX: 16, mouseStudY: 5,
        orientation: 90, snapStepStuds: 1, reach: 3,
      },
      map, partsByKey,
    );
    expect(r.snappedToConnection).toBe(true);
    expect(r.newOrientation).toBeCloseTo(180);
    // Moving conn at the NEW orientation must coincide with the target.
    const t = (r.newOrientation! * Math.PI) / 180;
    expect(r.centreX + 4 * Math.cos(t)).toBeCloseTo(16);
    expect(r.centreY + 4 * Math.sin(t)).toBeCloseTo(4);
  });

  it('multi-select drag snaps via a sibling connection, turning the group to face it', () => {
    const noConn = makePart({ key: 'plain.0', partNumber: 'PLAIN' });
    const track = makePart({ connections: [conn(4, 0, 0)] });
    const sibPart = makePart({ key: 'sib.0', partNumber: 'SIB', connections: [conn(-4, 0, 90)] });
    const partsByKey = new Map<string, PartWire>([
      ['test.0', track], ['plain.0', noConn], ['sib.0', sibPart],
    ]);
    // Stationary centre (12,4) → free conn (16,4)@0.
    const map = brickLayerMap([makeBrick({ id: 's', x: 8, y: 0, w: 8, h: 8 })]);
    const r = liveDragSnap(
      {
        part: noConn, movingId: 'lead', movingLinks: [],
        siblings: [{ id: 'sib', part: sibPart, links: [], offsetX: 10, offsetY: 0, orientation: 0 }],
        centreX: 10.5, centreY: 4.5, mouseStudX: 10.5, mouseStudY: 4.5,
        orientation: 0, snapStepStuds: 1, reach: 3,
      },
      map, partsByKey,
    );
    expect(r.snappedToConnection).toBe(true);
    expect(r.newOrientation).toBeNull();
    // The sibling's end faces 90°, the target 0°: the group turns 90°
    // about the sibling's end (16.5, 4.5), which lands on (16, 4).
    expect(r.groupTurn?.degrees).toBeCloseTo(90);
    expect(r.centreX).toBeCloseTo(16);
    expect(r.centreY).toBeCloseTo(-2);
  });

  it('never snaps the group onto its own siblings', () => {
    const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
    const partsByKey = new Map<string, PartWire>([['test.0', track]]);
    const map = brickLayerMap([makeBrick({ id: 'sib', x: 8, y: 0, w: 8, h: 8 })]);
    const r = liveDragSnap(
      {
        part: track, movingId: 'lead', movingLinks: [],
        siblings: [{ id: 'sib', part: track, links: [], offsetX: 8, offsetY: 0, orientation: 0 }],
        centreX: 4.3, centreY: 4, mouseStudX: 4, mouseStudY: 4,
        orientation: 0, snapStepStuds: 0, reach: 4,
      },
      map, partsByKey,
    );
    expect(r.snappedToConnection).toBe(false);
  });

  it('grid fallback puts the box corner on the grid, whole steps from the pointer', () => {
    const part = makePart();
    const r = liveDragSnap(
      {
        part, movingId: 'd', movingLinks: [],
        centreX: 1.8, centreY: 2.4, width: 3, height: 5,
        mouseStudX: 0, mouseStudY: 0, orientation: 0, snapStepStuds: 1, reach: 3,
      },
      emptyMap(), new Map(),
    );
    // TL (0.3, -0.1): from the pointer at (0, 0), 0.3 right (a step past
    // the line) and 0.1 up (none), so (1, 0) and the centre (2.5, 2.5).
    expect(r.centreX).toBeCloseTo(2.5);
    expect(r.centreY).toBeCloseTo(2.5);
  });

  it('grid fallback puts the snap corner, not the box, on the grid', () => {
    const part = makePart();
    // A 9V straight: 17 studs wide, its snap corner half a stud in.
    const r = liveDragSnap(
      {
        part, movingId: 'd', movingLinks: [],
        centreX: 30.3, centreY: 12.2, width: 17, height: 8,
        snapCornerX: 30.3 - 8.5 + 0.5, snapCornerY: 12.2 - 4,
        mouseStudX: 27.6, mouseStudY: 13.9, orientation: 0, snapStepStuds: 8, reach: 3,
      },
      emptyMap(), new Map(),
    );
    // The corner (22.3, 8.2) is 5.3 / 5.7 studs from the pointer: no whole
    // step, so it goes to the line at or before the pointer, (24, 8).
    expect(r.centreX).toBeCloseTo(24 - 0.5 + 8.5);
    expect(r.centreY).toBeCloseTo(8 + 4);
  });
});

describe('rotationAlignedCentre', () => {
  it('returns target minus the rotated local point', () => {
    const c = rotationAlignedCentre(10, 10, 4, 0, 90);
    expect(c.x).toBeCloseTo(10);
    expect(c.y).toBeCloseTo(6);
  });
});

// ---- grab anchor (MapViewDrag.cpp:60-217) ----------------------------------

describe('nearestConnectionIndex', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
  const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });

  it('picks the connection nearest the click', () => {
    const b = makeBrick({ x: 0, y: 0, w: 8, h: 8 });
    expect(nearestConnectionIndex(b, track, 7, 4)).toBe(1);
    expect(nearestConnectionIndex(b, track, 1, 4)).toBe(0);
  });

  it('follows the brick rotation', () => {
    // At 90° local (4,0) sits below the centre.
    const b = makeBrick({ x: 0, y: 0, w: 8, h: 8, orientation: 90 });
    expect(nearestConnectionIndex(b, track, 4, 7)).toBe(1);
    expect(nearestConnectionIndex(b, track, 4, 1)).toBe(0);
  });

  it('takes the nearer end even when it is linked to a part left behind', () => {
    const b = makeBrick({ connexions: [{ id: 'c0', linkedTo: 'other' }, { id: 'c1', linkedTo: '' }] });
    expect(nearestConnectionIndex(b, track, 1, 4)).toBe(0);
  });

  it('passes over a nearer end linked to a part moving with it', () => {
    const b = makeBrick({ connexions: [{ id: 'c0', linkedTo: 'o1' }, { id: 'c1', linkedTo: '' }] });
    expect(nearestConnectionIndex(b, track, 1, 4, new Set(['b1', 'c0', 'c1', 'O', 'o1']))).toBe(1);
  });

  it('falls back to the nearest connection when every end is linked', () => {
    const b = makeBrick({ connexions: [{ id: 'c0', linkedTo: 'a' }, { id: 'c1', linkedTo: 'b' }] });
    expect(nearestConnectionIndex(b, track, 1, 4)).toBe(0);
  });

  it('returns -1 without connections or metadata', () => {
    expect(nearestConnectionIndex(makeBrick(), makePart(), 0, 0)).toBe(-1);
    expect(nearestConnectionIndex(makeBrick(), undefined, 0, 0)).toBe(-1);
  });
});

describe('liveDragSnap — grab anchor lead', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
  const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
  const partsByKey = new Map<string, PartWire>([['test.0', track]]);
  // A: centre (-8,4), free conn (-4,4)@0. B: centre (14,4), free conn (10,4)@180.
  const map = brickLayerMap([
    makeBrick({ id: 'a', x: -12, y: 0, w: 8, h: 8 }),
    makeBrick({ id: 'b', x: 10, y: 0, w: 8, h: 8 }),
  ]);
  const base = {
    part: track, movingId: 'd', movingLinks: [],
    centreX: 0.5, centreY: 4, mouseStudX: 0.5, mouseStudY: 4, orientation: 0,
  };

  it('without a lead the smallest translation wins (left end)', () => {
    const r = liveDragSnap({ ...base, snapStepStuds: 8, reach: 10 }, map, partsByKey);
    expect(r.snappedToConnection).toBe(true);
    expect(r.centreX).toBeCloseTo(0);
  });

  it('the grabbed connection leads when it has a target in reach', () => {
    const r = liveDragSnap({ ...base, snapStepStuds: 8, reach: 10, leadConnIndex: 1 }, map, partsByKey);
    expect(r.snappedToConnection).toBe(true);
    expect(r.ringStudX).toBeCloseTo(10);
    expect(r.centreX).toBeCloseTo(6);
  });

  it('only the grabbed end snaps, even when another end is in reach (BlueBrick)', () => {
    const r = liveDragSnap({ ...base, snapStepStuds: 0, reach: 3, leadConnIndex: 1 }, map, partsByKey);
    expect(r.snappedToConnection).toBe(false);
    expect(r.centreX).toBeCloseTo(0.5);
  });

  it('leads a multi-brick drag too', () => {
    const r = liveDragSnap(
      {
        ...base, snapStepStuds: 8, reach: 10, leadConnIndex: 1,
        siblings: [{ id: 'sib', part: undefined, links: [], offsetX: 0, offsetY: 40, orientation: 0 }],
      },
      map, partsByKey,
    );
    expect(r.ringStudX).toBeCloseTo(10);
  });

  it('grabbed by a part whose ends are both joined inside the run, the run\'s free end nearest the grab leads', () => {
    // L | d | R in a row, d joined to both (the middle of a flex track run); a still part's end at (13,4),
    // half a stud past R's free right end (12.5,4). d is grabbed by its right end (index 1), which is joined to R.
    const still = brickLayerMap([makeBrick({ id: 'b', x: 13, y: 0, w: 8, h: 8 })]);
    const r = liveDragSnap(
      {
        ...base, snapStepStuds: 0, reach: 1, leadConnIndex: 1,
        movingLinks: [{ id: 'd0', linkedTo: 'l1' }, { id: 'd1', linkedTo: 'r0' }],
        siblings: [
          { id: 'l', part: track, links: [{ id: 'l0', linkedTo: '' }, { id: 'l1', linkedTo: 'd0' }], offsetX: -8, offsetY: 0, orientation: 0 },
          { id: 'r', part: track, links: [{ id: 'r0', linkedTo: 'd1' }, { id: 'r1', linkedTo: '' }], offsetX: 8, offsetY: 0, orientation: 0 },
        ],
      },
      still, partsByKey,
    );
    expect(r.snappedToConnection).toBe(true);
    expect(r.ringStudX).toBeCloseTo(13);
    expect(r.centreX).toBeCloseTo(1);
  });
});

// ---- calm snapping: hold, Alt, speed gate, the drop -------------------------

describe('liveDragSnap — calm snapping', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
  const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
  const partsByKey = new Map<string, PartWire>([['test.0', track]]);
  // A: centre (-8,4); its free right end is at (-4,4). The dragged track's
  // left end sits 4 studs left of its centre, so centre x = 0 joins them.
  const map = brickLayerMap([makeBrick({ id: 'a', x: -12, y: 0, w: 8, h: 8 })]);
  const at = (centreX: number, extra: Partial<Parameters<typeof liveDragSnap>[0]> = {}) =>
    liveDragSnap(
      {
        part: track, movingId: 'd', movingLinks: [],
        centreX, centreY: 4, mouseStudX: centreX, mouseStudY: 4, orientation: 0,
        snapStepStuds: 0, reach: 1, ...extra,
      },
      map, partsByKey,
    );

  it('snaps within the reach and not beyond it', () => {
    expect(at(0.9).snappedToConnection).toBe(true);
    expect(at(0.9).centreX).toBeCloseTo(0);
    expect(at(1.1).snappedToConnection).toBe(false);
    expect(at(1.1).centreX).toBeCloseTo(1.1);
  });

  it('holds on inside 1.6x the reach and lets go past it', () => {
    const session = new SnapSession();
    expect(at(0.9, { session }).snappedToConnection).toBe(true);
    const held = at(1.5, { session });
    expect(held.snappedToConnection).toBe(true);
    expect(held.centreX).toBeCloseTo(0);
    expect(held.ringStudX).toBeCloseTo(-4);
    expect(at(1.7, { session }).snappedToConnection).toBe(false);
    expect(session.lock).toBeNull();
    // Coming back in, it waits for the plain reach again.
    expect(at(1.5, { session }).snappedToConnection).toBe(false);
    expect(at(1.0, { session }).snappedToConnection).toBe(true);
  });

  it('Alt places without connection snap, keeping the grid', () => {
    const r = at(0.6, { bypass: true, snapStepStuds: 1 });
    expect(r.snappedToConnection).toBe(false);
    expect(r.centreX).toBeCloseTo(0);
    expect(at(0.6, { bypass: true }).centreX).toBeCloseTo(0.6);
  });

  it('a fast drag starts no snap until the drop, which snaps at the normal reach', () => {
    const session = new SnapSession();
    session.sample(0, 0, 0);
    session.sample(60, 0, 10);
    session.sample(120, 0, 20);
    expect(at(0.5, { session }).snappedToConnection).toBe(false);
    const drop = at(0.5, { session, final: true });
    expect(drop.snappedToConnection).toBe(true);
    expect(drop.centreX).toBeCloseTo(0);
    // The drop's reach is the normal one: no further.
    const far = new SnapSession();
    expect(at(1.2, { session: far, final: true }).snappedToConnection).toBe(false);
  });

  it('no reach (Snap strength off) never snaps', () => {
    expect(at(0.1, { reach: 0 }).snappedToConnection).toBe(false);
  });

  it('shows the moving connection: the grabbed end, or the joined one', () => {
    const free = at(3, { leadConnIndex: 1 });
    expect(free.snappedToConnection).toBe(false);
    expect(free.movingStudX).toBeCloseTo(7);
    expect(free.movingStudY).toBeCloseTo(4);
    const joined = at(0.5);
    expect(joined.movingStudX).toBeCloseTo(-4);
    expect(joined.ringStudX).toBeCloseTo(-4);
  });
});

describe('snapPlacement — calm snapping', () => {
  const partWithConn = makePart({ connections: [{ type: 'male', x: 4, y: 0, angle: 0, electricPlug: 0 }] });
  const partsByKey = new Map<string, PartWire>([['test.0', partWithConn]]);
  const map = brickLayerMap([makeBrick({ x: -4, y: -4, w: 8, h: 8 })]);
  const newPart = makePart({ connections: [{ type: 'male', x: -4, y: 0, angle: 180, electricPlug: 0 }] });
  // The new part's connection is 4 studs left of its centre; centre 8 joins.
  const place = (centreX: number, extra: Partial<PlaceCandidate> = {}) =>
    snapPlacement(
      { part: newPart, centreX, centreY: 0, orientation: 0, width: 8, height: 8, snapStepStuds: 0, reach: 1, ...extra },
      map,
      partsByKey,
    );

  it('reaches only as far as the reach, holds with a session, and gives the ring', () => {
    expect(place(9.2).snappedToConnection).toBe(false);
    const session = new SnapSession();
    const first = place(8.8, { session });
    expect(first.snappedToConnection).toBe(true);
    expect(first.ringStudX).toBeCloseTo(4);
    expect(place(9.5, { session }).centreX).toBeCloseTo(8);
    expect(place(9.7, { session }).snappedToConnection).toBe(false);
  });

  it('Alt and a fast drag hold back; the drop snaps', () => {
    expect(place(8.5, { bypass: true }).snappedToConnection).toBe(false);
    const session = new SnapSession();
    session.sample(0, 0, 0);
    session.sample(100, 0, 10);
    expect(place(8.5, { session }).snappedToConnection).toBe(false);
    expect(place(8.5, { session, final: true }).snappedToConnection).toBe(true);
  });
});

// ---- a part linked at one end snaps elsewhere in the same drag --------------

describe('liveDragSnap — links to the parts left behind', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
  // A 4 x 2 straight (pivot = box centre), ends 2 studs either side.
  const track = makePart({ connections: [conn(-2, 0, 180), conn(2, 0, 0)] });
  const partsByKey = new Map<string, PartWire>([['test.0', track]]);
  const cx = (id: string, i: number, linkedTo = '') => ({ id: `${id}${i}`, linkedTo });
  // A (0..4) joined to B (4..8) at x 4; C (14..18) has a free right end at x 18.
  const map = () =>
    brickLayerMap([
      makeBrick({ id: 'A', x: 0, y: 0, w: 4, h: 2, connexions: [cx('a', 0), cx('a', 1, 'b0')] }),
      makeBrick({ id: 'B', x: 4, y: 0, w: 4, h: 2, connexions: [cx('b', 0, 'a1'), cx('b', 1)] }),
      makeBrick({ id: 'C', x: 14, y: 0, w: 4, h: 2, connexions: [cx('c', 0), cx('c', 1)] }),
    ]);
  const dragB = (centreX: number, centreY: number, m: BbmMap, extra: Partial<Parameters<typeof liveDragSnap>[0]> = {}) =>
    liveDragSnap(
      {
        part: track, movingId: 'B', movingLinks: [cx('b', 0, 'a1'), cx('b', 1)],
        centreX, centreY, mouseStudX: centreX - 2, mouseStudY: centreY, orientation: 0,
        snapStepStuds: 0, reach: 1, leadConnIndex: 0, ...extra,
      },
      m, partsByKey,
    );

  it('the joined end, pulled to another free end, snaps there', () => {
    // B's left end 0.4 studs past C's right end (18, 1).
    const r = dragB(20.4, 1, map());
    expect(r.snappedToConnection).toBe(true);
    expect(r.ringStudX).toBeCloseTo(18);
    expect(r.centreX).toBeCloseTo(20);
  });

  it('the end it left behind is free for it again', () => {
    // Pulled away and back: B's left end 0.3 studs off A's right end.
    const r = dragB(6, 1.3, map());
    expect(r.snappedToConnection).toBe(true);
    expect(r.ringStudX).toBeCloseTo(4);
    expect(r.centreY).toBeCloseTo(1);
  });

  it('a joint inside the moving set stays joined', () => {
    // A and B dragged together: B's left end is joined to A, which moves too.
    const r = dragB(20.4, 1, map(), {
      siblings: [{ id: 'A', part: track, links: [cx('a', 0), cx('a', 1, 'b0')], offsetX: -4, offsetY: 0, orientation: 0 }],
    });
    // Only A's free left end (at 14.4) is free: C's left end is 0.4 studs
    // off but faces the same way (a half turn, more than a group may
    // turn), C's right end is out of reach. Never B's joined end.
    expect(r.snappedToConnection).toBe(false);
  });

  it('the grab anchor takes the grabbed end even when it is joined', () => {
    const m = map();
    const b = (m.layers[0] as import('@cld/model').LayerBrick).bricks[1]!;
    expect(nearestConnectionIndex({ ...b, id: 'B' }, track, 4.2, 1)).toBe(0);
    // Unless it is joined to a part moving with it.
    expect(nearestConnectionIndex(b, track, 4.2, 1, linkKeys([{ id: 'B', connexions: b.connexions }, { id: 'A', connexions: [cx('a', 0), cx('a', 1, 'b0')] }]))).toBe(1);
  });

  it('on the drop, connectivity lets go of A and joins C', () => {
    const m = map();
    const bricks = (m.layers[0] as import('@cld/model').LayerBrick).bricks;
    bricks[1]!.displayArea.x = 18; // where the snap put B
    rebuildConnectivity(m, catalogFromParts([track]));
    expect(bricks[1]!.connexions[0]!.linkedTo).toBe('c1');
    expect(bricks[2]!.connexions[1]!.linkedTo).toBe('b0');
    expect(bricks[0]!.connexions[1]!.linkedTo).toBe('');
  });
});

// ---- a joined group of curves snaps by turning as a whole ------------------

describe('liveDragSnap — group of curves at an angle', () => {
  // BlueBrick's 9V curve (2867): 22.5 degrees of an R40 circle.
  const curve = makePart({
    connections: [
      { type: '1', x: -8.1875, y: -1.375, angle: 180, electricPlug: 0 },
      { type: '1', x: 7.1198, y: 1.6698, angle: 22.5, electricPlug: 0 },
    ],
  });
  const partsByKey = new Map<string, PartWire>([['test.0', curve]]);
  const rot = (x: number, y: number, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
  };
  const end = (cx: number, cy: number, o: number, i: number) => {
    const c = curve.connections[i]!;
    const p = rot(c.x, c.y, o);
    return { x: cx + p.x, y: cy + p.y, angle: c.angle + o };
  };
  const at = (id: string, cx: number, cy: number, o: number, links: { id: string; linkedTo: string }[]) =>
    makeBrick({ id, x: cx - 8, y: cy - 4, w: 16, h: 8, orientation: o, connexions: links });
  // A at the origin, turned 0; B joined to A's end, turned 22.5.
  const aEnd = end(0, 0, 0, 1);
  const bOff = rot(curve.connections[0]!.x, curve.connections[0]!.y, 22.5);
  const bCentre = { x: aEnd.x - bOff.x, y: aEnd.y - bOff.y };
  const bFree = end(bCentre.x, bCentre.y, 22.5, 1); // faces 45

  // A target curve C whose free first end sits 3 studs right of B's free
  // end and needs the group to turn `turn` degrees to face it.
  const scene = (turn: number) => {
    const phi = turn - 135; // facingTurn(phi, 45) = turn
    const oc = phi - 180;
    const p = { x: bFree.x + 3, y: bFree.y };
    const off = rot(curve.connections[0]!.x, curve.connections[0]!.y, oc);
    const map = brickLayerMap([at('C', p.x - off.x, p.y - off.y, oc, [{ id: 'c0', linkedTo: '' }, { id: 'c1', linkedTo: '' }])]);
    return { map, p };
  };
  const drag = (map: BbmMap, shiftX: number, session: SnapSession, final = false) =>
    liveDragSnap(
      {
        part: curve, movingId: 'A', movingLinks: [{ id: 'a0', linkedTo: '' }, { id: 'a1', linkedTo: 'b0' }],
        siblings: [{ id: 'B', part: curve, links: [{ id: 'b0', linkedTo: 'a1' }, { id: 'b1', linkedTo: '' }], offsetX: bCentre.x, offsetY: bCentre.y, orientation: 22.5 }],
        centreX: shiftX, centreY: 0.1, mouseStudX: bCentre.x + shiftX, mouseStudY: bCentre.y, orientation: 0,
        snapStepStuds: 0, reach: 1, session, ...(final ? { final: true } : {}),
      },
      map, partsByKey,
    );

  for (const turn of [0, 22.5, -22.5, 45, -45]) {
    it(`turns ${turn} degrees to join, and keeps one target over a slow approach`, () => {
      const { map, p } = scene(turn);
      const session = new SnapSession();
      let first = -1;
      let r = drag(map, 0, session);
      for (let i = 0; i <= 12; i++) {
        r = drag(map, i * 0.25, session, i === 12);
        if (r.snappedToConnection && first < 0) first = i;
        if (first >= 0) {
          // Once joined, the same end every frame: no flipping.
          expect(r.snappedToConnection, `frame ${i}`).toBe(true);
          expect(r.ringStudX).toBeCloseTo(p.x, 6);
          expect(r.ringStudY).toBeCloseTo(p.y, 6);
        }
      }
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(12);
      // The group turned as one about the joint and B's free end meets C's,
      // mouth to mouth; A and B are still joined.
      expect(r.groupTurn?.degrees ?? 0).toBeCloseTo(turn, 6);
      const t = r.groupTurn ?? { degrees: 0, pivotX: 0, pivotY: 0, toX: r.centreX - 3, toY: r.centreY - 0.1 };
      const place = (x: number, y: number) =>
        r.groupTurn ? applyGroupTurn(t, x + 3, y + 0.1) : { x: x + r.centreX, y: y + r.centreY - 0 };
      const a = place(0, 0);
      expect(a.x).toBeCloseTo(r.centreX, 6);
      expect(a.y).toBeCloseTo(r.centreY, 6);
      const b = r.groupTurn ? applyGroupTurn(t, bCentre.x + 3, bCentre.y + 0.1) : { x: bCentre.x + r.centreX, y: bCentre.y + r.centreY };
      const bEnd = end(b.x, b.y, 22.5 + turn, 1);
      expect(bEnd.x).toBeCloseTo(p.x, 6);
      expect(bEnd.y).toBeCloseTo(p.y, 6);
      expect(wrap180(bEnd.angle - (turn - 135) - 180)).toBeCloseTo(0, 6);
      const aJoint = end(r.centreX, r.centreY, turn, 1);
      const bJoint = end(b.x, b.y, 22.5 + turn, 0);
      expect(aJoint.x).toBeCloseTo(bJoint.x, 6);
      expect(aJoint.y).toBeCloseTo(bJoint.y, 6);
    });
  }

  it('joins at any angle: a 112.5 degree turn too (BlueBrick has no angle window)', () => {
    const { map, p } = scene(112.5);
    const session = new SnapSession();
    let r = drag(map, 0, session);
    for (let i = 0; i <= 12; i++) r = drag(map, i * 0.25, session, i === 12);
    expect(r.snappedToConnection).toBe(true);
    expect(r.ringStudX).toBeCloseTo(p.x, 6);
    expect(r.groupTurn?.degrees).toBeCloseTo(112.5, 6);
  });
});

describe('liveDragSnap — level targets prefer the smaller turn', () => {
  it('takes the end that needs no turn over one nearer the cursor that needs a big one', () => {
    const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
    const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
    const partsByKey = new Map<string, PartWire>([['test.0', track]]);
    // L: right end at (-4, 4) facing 0 — the dragged left end faces it already.
    // R: turned 45, its left end at (4.4, 4) facing 225 — the dragged right end must turn.
    const r45 = (45 * Math.PI) / 180;
    const map = brickLayerMap([
      makeBrick({ id: 'L', x: -12, y: 0, w: 8, h: 8 }),
      makeBrick({ id: 'R', x: 4.4 + 4 * Math.cos(r45) - 4, y: 4 + 4 * Math.sin(r45) - 4, w: 8, h: 8, orientation: 45 }),
    ]);
    const r = liveDragSnap(
      {
        part: track, movingId: 'd', movingLinks: [],
        centreX: 0.3, centreY: 4, mouseStudX: 4.3, mouseStudY: 4, orientation: 0,
        snapStepStuds: 0, reach: 1,
      },
      map, partsByKey,
    );
    expect(r.ringStudX).toBeCloseTo(-4);
    expect(r.newOrientation).toBeCloseTo(0);
  });
});

// ---- the grabbed end alone snaps, at any angle, steady under jitter --------

describe('liveDragSnap — big angles, a jittering pointer', () => {
  const conn = (x: number, y: number, angle: number) => ({ type: '1', x, y, angle, electricPlug: 0 });
  const track = makePart({ connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
  const partsByKey = new Map<string, PartWire>([['test.0', track]]);
  const P = { x: 20, y: 4 };
  const rad = (d: number) => (d * Math.PI) / 180;
  // T turned `turn`: its first end on P, facing turn + 180, so the dragged
  // right end (facing 0) must turn `turn` to face it. U: a second free end
  // 2 studs below, a different way.
  const scene = (turn: number) =>
    brickLayerMap([
      makeBrick({ id: 'T', x: P.x + 4 * Math.cos(rad(turn)) - 4, y: P.y + 4 * Math.sin(rad(turn)) - 4, w: 8, h: 8, orientation: turn }),
      makeBrick({ id: 'U', x: P.x + 4 * Math.cos(rad(turn + 30)) - 4, y: P.y + 2 + 4 * Math.sin(rad(turn + 30)) - 4, w: 8, h: 8, orientation: turn + 30 }),
    ]);
  // The dragged right end, where the pointer has it: an approach, then a
  // jittering hand near P, all inside the hold distance.
  const path = [
    ...[-3, -2.5, -2, -1.5, -1.25, -1, -0.75, -0.5].map((dx) => ({ x: dx, y: 0.2 })),
    { x: 0.6, y: 0.3 }, { x: -0.4, y: 0.9 }, { x: 0.3, y: -0.5 }, { x: 0.9, y: 0.6 }, { x: -0.2, y: 0.2 },
    { x: 1.1, y: -0.4 }, { x: -0.9, y: -0.7 }, { x: 0.1, y: 0.05 },
  ];
  const run = (turn: number, multi: boolean) => {
    const map = scene(turn);
    const session = new SnapSession();
    const frames = path.map((o, i) =>
      liveDragSnap(
        {
          part: track, movingId: 'D', movingLinks: [{ id: 'd0', linkedTo: multi ? 's1' : '' }, { id: 'd1', linkedTo: '' }],
          ...(multi ? { siblings: [{ id: 'S', part: track, links: [{ id: 's0', linkedTo: '' }, { id: 's1', linkedTo: 'd0' }], offsetX: -8, offsetY: 0, orientation: 0 }] } : {}),
          centreX: P.x + o.x - 4, centreY: P.y + o.y, mouseStudX: P.x + o.x - 1, mouseStudY: P.y + o.y,
          orientation: 0, snapStepStuds: 0, reach: 1, leadConnIndex: 1, session,
          ...(i === path.length - 1 ? { final: true } : {}),
        },
        map, partsByKey,
      ),
    );
    return frames;
  };

  for (const turn of [45, 90, 135, 180]) {
    for (const multi of [false, true]) {
      it(`${multi ? 'two parts picked together' : 'one part'}, a ${turn} degree turn: snaps once, then never flickers or lets go`, () => {
        const frames = run(turn, multi);
        const first = frames.findIndex((r) => r.snappedToConnection);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThanOrEqual(7); // during the approach
        frames.slice(first).forEach((r, k) => {
          expect(r.snappedToConnection, `frame ${first + k}`).toBe(true);
          expect(r.ringStudX).toBeCloseTo(P.x, 9);
          expect(r.ringStudY).toBeCloseTo(P.y, 9);
          if (multi) expect(Math.abs(r.groupTurn!.degrees)).toBeCloseTo(turn, 6);
          else expect(r.newOrientation).toBeCloseTo(turn % 360, 6);
          // The grabbed end sits exactly on P: the centre is 4 studs back along the turn.
          expect(r.centreX).toBeCloseTo(P.x - 4 * Math.cos(rad(turn)), 6);
          expect(r.centreY).toBeCloseTo(P.y - 4 * Math.sin(rad(turn)), 6);
        });
      });
    }
  }
});

// ---- the map's ends by place -----------------------------------------------

describe('liveDragSnap — the ends near the drag', () => {
  const conn = (x: number, y: number, angle: number, type = '1') => ({ type, x, y, angle, electricPlug: 0 });
  const track = makePart({ key: 'track.0', partNumber: 'TRACK', connections: [conn(-4, 0, 180), conn(4, 0, 0)] });
  const cross = makePart({ key: 'cross.0', partNumber: 'CROSS', connections: [conn(-4, 0, 180), conn(4, 0, 0), conn(0, -4, 270, '2'), conn(0, 4, 90, '2')] });
  const partsByKey = new Map<string, PartWire>([['track.0', track], ['cross.0', cross]]);
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  it('snaps as going through every end does, drag after drag, as the layout changes', () => {
    let snapped = 0;
    for (let round = 0; round < 12; round++) {
      let bricks = Array.from({ length: 300 }, (_, i) => {
        const b = makeBrick({ id: `p${i}`, partNumber: rnd() < 0.8 ? 'track.0' : 'cross.0', x: Math.round(rnd() * 60) * 8, y: Math.round(rnd() * 30) * 8, orientation: [0, 90, 180, 270][Math.floor(rnd() * 4)]! });
        b.connexions = [{ id: `p${i}a`, linkedTo: '' }, { id: `p${i}b`, linkedTo: '' }];
        return b;
      });
      // Some ends linked, some of them to the part that will move.
      for (const b of bricks) if (rnd() < 0.2) b.connexions[0]!.linkedTo = bricks[Math.floor(rnd() * bricks.length)]!.connexions[1]!.id;
      for (let drag = 0; drag < 6; drag++) {
        const map = brickLayerMap(bricks);
        const m = bricks[Math.floor(rnd() * bricks.length)]!;
        const part = partsByKey.get(m.partNumber)!;
        const siblings = rnd() < 0.3 ? [{ id: bricks[0]!.id, part: track, links: bricks[0]!.connexions, offsetX: 8, offsetY: 0, orientation: 0 }] : [];
        const sessions = [new SnapSession(), new SnapSession()];
        let x = m.displayArea.x;
        let y = m.displayArea.y;
        for (let frame = 0; frame < 25; frame++) {
          x += (rnd() - 0.5) * 12;
          y += (rnd() - 0.5) * 12;
          const input = {
            part, movingId: m.id, movingLinks: m.connexions, siblings, centreX: x, centreY: y, mouseStudX: x, mouseStudY: y,
            orientation: m.orientation, snapStepStuds: rnd() < 0.5 ? 8 : 0, reach: [0.5, 2, 6, 40][Math.floor(rnd() * 4)]!,
            ...(rnd() < 0.5 ? { leadConnIndex: Math.floor(rnd() * part.connections.length) } : {}),
          };
          const results = [true, false].map((on, i) => {
            snapIndex.enabled = on;
            try {
              return liveDragSnap({ ...input, session: sessions[i]! }, map, partsByKey);
            } finally {
              snapIndex.enabled = true;
            }
          });
          expect(results[0], `round ${round} drag ${drag} frame ${frame}`).toEqual(results[1]);
          if (results[0]!.snappedToConnection) snapped++;
        }
        // The drop: the part where the drag left it (a new object), as the next layout.
        bricks = [...bricks];
        const i = bricks.indexOf(m);
        bricks[i] = { ...m, displayArea: { ...m.displayArea, x: Math.round(x), y: Math.round(y) } };
        if (rnd() < 0.15) bricks.push(makeBrick({ id: `n${round}-${drag}`, partNumber: 'track.0', x: Math.round(rnd() * 60) * 8, y: 0 }));
      }
    }
    // (Snapped often enough to tell.)
    expect(snapped).toBeGreaterThan(300);
  });

  it('a frame looks only at the ends near the dragged one', () => {
    const bricks = Array.from({ length: 2000 }, (_, i) => makeBrick({ id: `p${i}`, partNumber: 'track.0', x: (i % 100) * 16, y: Math.floor(i / 100) * 16 }));
    const map = brickLayerMap(bricks);
    snapIndex.looked = 0;
    const r = liveDragSnap({ part: track, movingId: 'p0', movingLinks: [], centreX: 796.4, centreY: 164, mouseStudX: 796.4, mouseStudY: 164, orientation: 0, snapStepStuds: 0, reach: 2, leadConnIndex: 0 }, map, partsByKey);
    expect(r.snappedToConnection).toBe(true);
    // A few cells' ends (there are 4,000 on the map).
    expect(snapIndex.looked).toBeLessThan(100);
  });
});
