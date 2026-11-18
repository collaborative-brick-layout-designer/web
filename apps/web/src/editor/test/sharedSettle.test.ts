// Undo and redo across an update that kept a shared module's unchanged
// parts (doc shape 5; sharedSettle.ts, useUndoManager.ts stepWhole): Bob
// places a shared module and moves it; the server then puts version 2 in,
// keeping the parts that didn't change. His undo of the move takes the
// whole module back (the new parts too, and its placement), his undo of
// placing it removes the whole module, and redo puts each back whole; each
// is one change for the server. An undo with no shared module in it is
// left as it was. His pick of unchanged parts stays good across the update.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import { partsInPlace, placeVersion, readPlacement, updateModuleParts, withShared, type ModuleBatch as Batch } from '@cld/modules';
import { addLayer, ensureBrickLayer, importBricksAsModule, moveBricksToLayer, moveModuleBricks, placeBrick, rotateModuleBricks } from '../mutations';
import { createUndoManager, stepWhole } from '../useUndoManager';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const noPart = () => undefined;
const V1: Batch[] = [
  {
    layerName: 'Track',
    bricks: [
      { partNumber: 'a.1', displayArea: { x: 0, y: 0, width: 2, height: 2 } },
      { partNumber: 'b.1', displayArea: { x: 4, y: 0, width: 2, height: 2 } },
      { partNumber: 'c.1', displayArea: { x: 8, y: 0, width: 2, height: 2 } },
    ],
  },
];
/** Version 2: c.1 moved, d.1 added; a.1 and b.1 as they were. */
const V2: Batch[] = [
  {
    layerName: 'Track',
    bricks: [
      { partNumber: 'a.1', displayArea: { x: 0, y: 0, width: 2, height: 2 } },
      { partNumber: 'b.1', displayArea: { x: 4, y: 0, width: 2, height: 2 } },
      { partNumber: 'c.1', displayArea: { x: 8, y: 4, width: 2, height: 2 } },
      { partNumber: 'd.1', displayArea: { x: 12, y: 0, width: 2, height: 2 } },
    ],
  },
];

const mod = (doc: Y.Doc, id: string) => readSidecarFromDoc(doc)?.modules?.find((m) => m.id === id) as (SidecarModule & { shared?: Record<string, unknown> }) | undefined;
const placementOf = (doc: Y.Doc, id: string) => readPlacement(mod(doc, id)!.shared!.placement)!;
const near = (p: { degrees: number; x: number; y: number }, want: Partial<Record<'degrees' | 'x' | 'y', number>>) =>
  Object.entries(want).every(([k, v]) => Math.abs(p[k as 'x'] - v) < 1e-6);
const parts = (doc: Y.Doc) => docToBbm(doc).layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []));
/** The module's parts are exactly version `v` where its placement puts it. */
const whole = (doc: Y.Doc, id: string, v: Batch[]) => {
  const m = mod(doc, id)!;
  const placed = parts(doc).filter((b) => m.members.includes(b.id));
  const total = v.reduce((n, b) => n + b.bricks.length, 0);
  return placed.length === total && partsInPlace(v, placed, readPlacement(m.shared!.placement)!, noPart) === total;
};

/** The server's step: version `v` in, where the module's placement says, keeping unchanged parts. */
function serverUpdate(server: Y.Doc, id: string, v: Batch[], version: number): void {
  const m = mod(server, id)!;
  const placement = readPlacement(m.shared!.placement)!;
  const first = docToBbm(server).layers.find((l) => l.type === 'brick')!.id;
  updateModuleParts(server, id, placeVersion(v, placement, noPart), (name) => placement.sheets?.[name] ?? first, noPart, (x) => withShared({ ...x, libraryVersion: version }, { placement }), 'server');
}

function room() {
  const bob = new Y.Doc();
  ensureBrickLayer(bob);
  const um = createUndoManager(bob);
  const placed = importBricksAsModule(bob, V1, { name: 'Harbor crane', offset: { dx: 100, dy: 50 }, library: { id: LIB, version: 1, shared: { by: 'Alice', placement: { degrees: 0, x: 0, y: 0 } } } })!;
  um.stopCapturing();
  const server = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(server, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(server)));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server, Y.encodeStateVector(bob)));
  };
  return { bob, um, placed, server, sync };
}

describe('undo and redo across an update that kept parts', () => {
  it('undoing a move takes the whole module back, its new parts and placement too, in one change; redo moves it all again', () => {
    for (const turn of [false, true]) {
      const { bob, um, placed, server, sync } = room();
      if (turn) rotateModuleBricks(bob, placed.ids, 90, noPart);
      else moveModuleBricks(bob, placed.ids, 16, 8);
      um.stopCapturing();
      sync();
      serverUpdate(server, placed.moduleId, V2, 2);
      sync();
      expect(whole(bob, placed.moduleId, V2)).toBe(true);
      // Two of its parts are the ones Bob moved; the update kept them.
      expect(placed.ids.filter((id) => mod(bob, placed.moduleId)!.members.includes(id))).toHaveLength(2);
      const sent: Uint8Array[] = [];
      bob.on('update', (u: Uint8Array) => sent.push(u));
      stepWhole(bob, um, 'undo', noPart);
      expect(sent, `turn ${turn}`).toHaveLength(1);
      expect(whole(bob, placed.moduleId, V2), `turn ${turn}`).toBe(true);
      expect(near(placementOf(bob, placed.moduleId), { degrees: 0, x: 100, y: 50 })).toBe(true);
      stepWhole(bob, um, 'redo', noPart);
      expect(whole(bob, placed.moduleId, V2)).toBe(true);
      expect(near(placementOf(bob, placed.moduleId), turn ? { degrees: 90 } : { degrees: 0, x: 116, y: 58 })).toBe(true);
      // And back once more.
      stepWhole(bob, um, 'undo', noPart);
      expect(whole(bob, placed.moduleId, V2)).toBe(true);
    }
  });

  it('undoing placing it removes the whole module; redo puts it back whole', () => {
    const { bob, um, placed, server, sync } = room();
    sync();
    serverUpdate(server, placed.moduleId, V2, 2);
    sync();
    const sent: Uint8Array[] = [];
    bob.on('update', (u: Uint8Array) => sent.push(u));
    stepWhole(bob, um, 'undo', noPart);
    expect(sent).toHaveLength(1);
    expect(mod(bob, placed.moduleId)).toBeUndefined();
    expect(parts(bob)).toHaveLength(0);
    stepWhole(bob, um, 'redo', noPart);
    expect(mod(bob, placed.moduleId)).toBeDefined();
    expect(whole(bob, placed.moduleId, V2)).toBe(true);
  });

  it('undoing a change of sheet brings back no part the update took out, and the module is whole on its sheet', () => {
    const { bob, um, placed, server, sync } = room();
    const other = addLayer(bob, 'brick');
    um.stopCapturing();
    const bySheet = new Map<string, string[]>();
    for (const l of docToBbm(bob).layers) if (l.type === 'brick') bySheet.set(l.id, l.bricks.filter((b) => placed.ids.includes(b.id)).map((b) => b.id));
    moveBricksToLayer(bob, bySheet, other);
    um.stopCapturing();
    sync();
    // Version 2 goes in: c.1 moved (taken out, a new one in), d.1 added.
    serverUpdate(server, placed.moduleId, V2, 2);
    sync();
    const c1 = placed.ids[2]!;
    const sheetOf = (id: string) => docToBbm(bob).layers.find((l) => l.type === 'brick' && l.bricks.some((b) => b.id === id))?.id;
    stepWhole(bob, um, 'undo', noPart);
    // The part version 2 took out doesn't come back as a loose part; every part of the module is on the sheet it was on.
    expect(parts(bob).some((b) => b.id === c1)).toBe(false);
    expect(parts(bob)).toHaveLength(4);
    const m = mod(bob, placed.moduleId)!;
    expect(new Set(m.members.map(sheetOf)).size).toBe(1);
    expect(sheetOf(m.members[0]!)).not.toBe(other);
    expect(whole(bob, placed.moduleId, V2)).toBe(true);
    stepWhole(bob, um, 'redo', noPart);
    expect(parts(bob)).toHaveLength(4);
    expect(new Set(mod(bob, placed.moduleId)!.members.map(sheetOf))).toEqual(new Set([other]));
  });

  it('keeps his pick of the unchanged parts across the update', () => {
    const { bob, placed, server, sync } = room();
    sync();
    const picked = placed.ids.slice(0, 2);
    serverUpdate(server, placed.moduleId, V2, 2);
    sync();
    const now = new Set(parts(bob).map((b) => b.id));
    expect(picked.every((id) => now.has(id))).toBe(true);
  });

  it('leaves an undo with no shared module in it as Yjs does it', () => {
    const doc = new Y.Doc();
    const layer = ensureBrickLayer(doc);
    const um = createUndoManager(doc);
    placeBrick(doc, layer, { partNumber: 'x.1', x: 0, y: 0, width: 2, height: 2 });
    stepWhole(doc, um, 'undo', noPart);
    expect(parts(doc)).toHaveLength(0);
    stepWhole(doc, um, 'redo', noPart);
    expect(parts(doc)).toHaveLength(1);
  });
});
