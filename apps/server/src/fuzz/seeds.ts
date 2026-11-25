// Seed inputs: what real clients send, for the fuzzer to start from.
//
//   - guard: the contract vectors (fixtures/contracts/update-guard.json,
//     the desktop's regressions among them), the rooms, a layout as the
//     desktop writes it, and every edit below;
//   - room: on each room, the edits the web makes (the same Yjs writes as
//     apps/web/src/editor/mutations.ts: place, move and delete a part, a
//     grid's size and lines, a sheet's transparency and hull, the shape-2
//     conversion and a ruler move, painting and moving an area, adding and
//     deleting a sheet), each sent live and as one offline session; two
//     edits arriving out of order; a viewer's edit; presence, a takeover of
//     it and a reconnect; values out of range; and the contract's grid and
//     drawing-settings updates on their own rooms;
//   - on the shared-module room: the module moved, turned (a quarter, and
//     by a connection snap's odd angle), nudged and put on another sheet as
//     a whole (taken, never put back), by two people at once, and an
//     outdated app's changes that break it (one part moved, turned or
//     recolored, a part deleted: put back).

import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { deleteRecord, PLACES_KEY, writePlace } from '@cld/ydoc';
import { fromHex, fuzzData, updateGuardContract } from './common.js';
import { SHARED_ROOM, convertShape, encodeRoomInput, roomStates } from './room.js';

type Msg = [number, Uint8Array];

function frame(write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder();
  write(enc);
  return encoding.toUint8Array(enc);
}

export const msgUpdate = (u: Uint8Array) =>
  frame((e) => {
    encoding.writeVarUint(e, 0);
    syncProtocol.writeUpdate(e, u);
  });
export const msgStep2 = (u: Uint8Array) =>
  frame((e) => {
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(e, u);
  });
export const msgStep1 = (sv: Uint8Array) =>
  frame((e) => {
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep1);
    encoding.writeVarUint8Array(e, sv);
  });
export const msgAwareness = (entries: [number, number, unknown][]) =>
  frame((e) => {
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint8Array(
      e,
      frame((a) => {
        encoding.writeVarUint(a, entries.length);
        for (const [id, clock, state] of entries) {
          encoding.writeVarUint(a, id);
          encoding.writeVarUint(a, clock);
          encoding.writeVarString(a, JSON.stringify(state));
        }
      }),
    );
  });

/** A client synced to `state`, recording the updates its edits make. */
function client(state: Uint8Array, id: number): { doc: Y.Doc; edits: Uint8Array[] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  doc.clientID = id;
  const edits: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => edits.push(u));
  return { doc, edits };
}

function sheets(doc: Y.Doc): Y.Map<unknown>[] {
  try {
    return [...doc.getMap('layerData').values()].filter((l): l is Y.Map<unknown> => l instanceof Y.Map);
  } catch {
    return [];
  }
}

let nextId = 1;
const newId = () => `90000000000000${nextId++}`;

/** The web's edits, each in its own transaction, on whatever the layout has. */
const EDITS: ((doc: Y.Doc) => void)[] = [
  // Place a part (placeBrick).
  (doc) => {
    const bricks = sheets(doc).map((l) => l.get('bricks')).find((b) => b instanceof Y.Array) as Y.Array<unknown> | undefined;
    if (!bricks) return;
    doc.transact(() => {
      const b = new Y.Map<unknown>();
      b.set('id', newId());
      b.set('displayArea', { x: 8, y: 16, width: 32, height: 16 });
      b.set('myGroup', '');
      b.set('partNumber', '3001.1');
      b.set('orientation', 0);
      b.set('activeConnectionPointIndex', 0);
      b.set('altitude', 0);
      b.set('connexions', []);
      bricks.push([b]);
    });
  },
  // Move a part, then delete another.
  (doc) => {
    const bricks = sheets(doc).map((l) => l.get('bricks')).find((b) => b instanceof Y.Array && b.length > 1) as Y.Array<unknown> | undefined;
    if (!bricks) return;
    const first = bricks.get(0);
    if (first instanceof Y.Map) doc.transact(() => first.set('displayArea', { x: 40, y: 0, width: 32, height: 16 }));
    doc.transact(() => bricks.delete(1, 1));
  },
  // A grid's size, lines, sub-divisions and cell index font (the layer options dialog).
  (doc) => {
    const grid = sheets(doc).find((l) => l.get('type') === 'grid');
    if (!grid) return;
    doc.transact(() => {
      grid.set('gridSizeInStud', 64);
      grid.set('gridThickness', 3);
      grid.set('subDivisionNumber', 4);
      grid.set('cellIndexFont', { family: 'Arial', size: 12, style: 'Regular' });
    });
  },
  // A sheet's transparency and hull (setLayerTransparency, setLayerHullProperties).
  (doc) => {
    const sheet = sheets(doc)[0];
    if (!sheet) return;
    doc.transact(() => sheet.set('transparency', 50));
    doc.transact(() => sheet.set('hullProperties', { isVisible: true, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 4 }));
  },
  // The shape-2 conversion, then a ruler moved and restyled (moveRulerItem, editRulerItem).
  (doc) => {
    convertShape(doc);
    for (const l of sheets(doc)) {
      const rulers = l.get('rulerItems');
      if (!(rulers instanceof Y.Array)) continue;
      const r = rulers.toArray().find((v) => v instanceof Y.Map) as Y.Map<unknown> | undefined;
      if (!r) continue;
      doc.transact(() => {
        r.set('point1', { x: 10, y: 10 });
        r.set('guidelineDashPattern', [4, 2]);
        r.set('unit', 2);
      });
    }
  },
  // Paint an area cell, then move the sheet (paintAreaCells, moveArea).
  (doc) => {
    const area = sheets(doc).find((l) => l.get('areas') instanceof Y.Array);
    if (!area) return;
    doc.transact(() => (area.get('areas') as Y.Array<unknown>).push([{ x: 3, y: 4, color: 'FF00FF00' }]));
    convertShape(doc);
  },
  // Add a grid sheet (addLayer), then delete the first sheet (deleteLayer).
  (doc) => {
    let layers: Y.Array<unknown>;
    let layerData: Y.Map<unknown>;
    try {
      layers = doc.getArray('layers');
      layerData = doc.getMap('layerData');
    } catch {
      return;
    }
    const id = newId();
    doc.transact(() => {
      const l = new Y.Map<unknown>();
      l.set('id', id);
      l.set('type', 'grid');
      l.set('name', 'Grid 2');
      l.set('visible', true);
      l.set('transparency', 100);
      l.set('hullProperties', { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 });
      l.set('gridSizeInStud', 32);
      l.set('subDivisionNumber', 4);
      l.set('groups', new Y.Array());
      layerData.set(id, l);
      layers.push([id]);
    });
    const first = layers.get(0);
    if (typeof first === 'string' && first !== id) {
      doc.transact(() => {
        layerData.delete(first);
        layers.delete(0, 1);
      });
    }
  },
  // Name a place, change it, add another and delete it (writePlace, deleteRecord).
  (doc) => {
    const place = fuzzPlace;
    try {
      doc.transact(() => writePlace(doc, place('pl-1', 'Acme Cannery')));
      doc.transact(() => writePlace(doc, { ...place('pl-1', 'Cannery'), notes: '' }));
      doc.transact(() => writePlace(doc, place('pl-2', 'Mill')));
      doc.transact(() => deleteRecord(doc, PLACES_KEY, 'pl-2'));
    } catch {
      /* not a map here */
    }
  },
  // Rename the layout (setGeneralInfo).
  (doc) => {
    try {
      doc.transact(() => doc.getMap('meta').set('title', 'Fuzz 🚂 layout'));
    } catch {
      /* not a map here */
    }
  },
];

/** A place as the apps write one. */
const fuzzPlace = (id: string, name: string) => ({ id, name, kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick: '1', from: 0, to: 1 }, capacity: 3 }], accepts: ['reefer'], ships: [], tags: [], notes: 'Ice at\nthe yard' });

/** Out of range: refused by the drawing-settings and grid guards. */
const BAD_EDITS: ((doc: Y.Doc) => void)[] = [
  (doc) => {
    const grid = sheets(doc).find((l) => l.get('type') === 'grid');
    if (grid) doc.transact(() => grid.set('gridSizeInStud', 0));
  },
  (doc) => {
    const sheet = sheets(doc)[0];
    if (sheet) doc.transact(() => sheet.set('transparency', 500));
  },
  // Places out of their limits (placesGuard.ts): a field, an entry, the list, a module's.
  (doc) => {
    try {
      doc.transact(() => writePlace(doc, { id: 'pl-3', name: 'x'.repeat(5000), kind: 'yard', spots: [], accepts: [], ships: [], tags: [], notes: '' }));
      doc.transact(() => doc.getMap('meta').set(PLACES_KEY, 'text'));
      doc.transact(() => doc.getMap('sidecarItems').set('m:bad', { id: 'bad', members: [], places: [{ id: 'p' }] }));
    } catch {
      /* not a map here */
    }
  },
];

const presence = (id: number, user: string) => [id, 1, { user: { id: user, name: user }, cursor: { x: 1.5, y: -2, layerId: 'L1' }, selection: { brickIds: ['1', '2'] } }] as [number, number, unknown];

/** A room seed, and whether it is only what real clients send (every update in it must be taken). */
export interface RoomSeed {
  input: Uint8Array;
  real: boolean;
}

export function roomSeeds(): Uint8Array[] {
  return taggedRoomSeeds().map((s) => s.input);
}

export function taggedRoomSeeds(): RoomSeed[] {
  const out: RoomSeed[] = [];
  const realClient = (input: Uint8Array) => out.push({ input, real: true });
  const other = (input: Uint8Array) => out.push({ input, real: false });
  const states = roomStates();
  const c = updateGuardContract();
  const empty = Y.encodeStateVector(new Y.Doc());
  states.forEach((state, r) => {
    // The edits below don't know which parts are a shared module's (the web's
    // tools refuse those), so on the shared room they aren't a real client's.
    const real = r === SHARED_ROOM.index ? other : realClient;
    const roomSv = (() => {
      const d = new Y.Doc();
      Y.applyUpdate(d, state);
      return Y.encodeStateVector(d);
    })();
    // Each edit live, after the client's own sync step 1.
    EDITS.forEach((edit, i) => {
      const a = client(state, 7000 + r * 100 + i);
      edit(a.doc);
      if (a.edits.length) real(encodeRoomInput(r, 0, [[0, msgStep1(empty)], ...a.edits.map((u): Msg => [0, msgUpdate(u)])]));
    });
    // Every edit offline, sent as one sync step 2 on reconnect.
    const off = client(state, 7050 + r * 100);
    for (const edit of EDITS) edit(off.doc);
    real(encodeRoomInput(r, 0, [[1, msgStep1(empty)], [1, msgStep2(Y.encodeStateAsUpdate(off.doc, roomSv))]]));
    // Two edits of one client arriving out of order (the second waits for the
    // first), with another editor's in between: a parts edit, and a drawing
    // setting's change. Both are taken: the second is held back whole until
    // the first arrives (ws/held.ts), so a drawing setting's deletion of the
    // old value never lands before the new value.
    const b = client(state, 7070 + r * 100);
    EDITS[3]!(b.doc);
    for (const second of [1, 2, 3, 4]) {
      const a = client(state, 7060 + r * 100 + second);
      EDITS[0]!(a.doc);
      EDITS[second]!(a.doc);
      if (a.edits.length < 2) continue;
      const [u1, ...rest] = a.edits;
      const early = rest.map((u): Msg => [0, msgUpdate(u)]);
      real(encodeRoomInput(r, 0, [...early, ...b.edits.map((u): Msg => [3, msgUpdate(u)]), [0, msgUpdate(u1!)]]));
      // The same, the first edit arriving over the same person's other connection.
      real(encodeRoomInput(r, 0, [...early, [2, msgUpdate(u1!)]]));
      // The early connection closes before the first edit arrives: what it held goes (its sync step 2 brings it again).
      real(encodeRoomInput(r, 0, [...early, [0, new Uint8Array()], [2, msgUpdate(u1!)]]));
    }
    // A value out of range arriving before the edit it follows: refused.
    BAD_EDITS.forEach((edit, i) => {
      const a = client(state, 7090 + r * 100 + i);
      EDITS[0]!(a.doc);
      edit(a.doc);
      if (a.edits.length < 2) return;
      const [u1, ...rest] = a.edits;
      other(encodeRoomInput(r, 0, [...rest.map((u): Msg => [0, msgUpdate(u)]), [1, msgUpdate(u1!)]]));
    });
    // A place's edits out of order (the second waits for the first): good ones, and one out of its limits.
    for (const name of ['Cannery Row', 'x'.repeat(5000)]) {
      const p = client(state, 7095 + r * 100 + (name.length > 80 ? 1 : 0));
      try {
        p.doc.transact(() => writePlace(p.doc, fuzzPlace('pl-1', 'Acme Cannery')));
        p.doc.transact(() => p.doc.getMap('meta').set('title', 'In between'));
        p.doc.transact(() => writePlace(p.doc, fuzzPlace('pl-1', name)));
      } catch {
        /* not a map here */
      }
      const [first, ...rest] = p.edits;
      if (first && rest.length) (name.length > 80 ? other : real)(encodeRoomInput(r, 0, [...rest.map((u): Msg => [0, msgUpdate(u)]), [0, msgUpdate(first)]]));
    }
    // A viewer's edit (dropped), and a viewer asking for the layout.
    if (b.edits.length) real(encodeRoomInput(r, 0b10, [[1, msgStep1(empty)], [1, msgUpdate(b.edits[0]!)]]));
    // Values out of range.
    BAD_EDITS.forEach((edit, i) => {
      const x = client(state, 7080 + r * 100 + i);
      edit(x.doc);
      if (x.edits.length) other(encodeRoomInput(r, 0, x.edits.map((u): Msg => [2, msgUpdate(u)])));
    });
    // Presence: set, taken over by the same person's other connection, claimed by another person, removed; a reconnect.
    real(
      encodeRoomInput(r, 0, [
        [0, msgAwareness([presence(4242, 'alice')])],
        [1, msgAwareness([presence(4242, 'bob'), presence(4343, 'bob')])],
        [2, msgAwareness([presence(4242, 'mallory')])],
        [0, new Uint8Array()],
        [1, msgAwareness([[4343, 2, null]])],
      ]),
    );
  });
  sharedSeeds(states[SHARED_ROOM.index]!, realClient, other);
  // The contract's grid and drawing-settings updates on their own rooms (2 and 3).
  for (const [room, vectors] of [
    [2, c.gridSize.vectors],
    [3, c.drawingSettings.vectors],
  ] as const) {
    for (const v of vectors) {
      if (v.kind === 'update') other(encodeRoomInput(room, 0, [[0, msgUpdate(fromHex(v.hex))]]));
      else other(encodeRoomInput(0, 0, [[0, msgStep2(fromHex(v.hex))]]));
    }
  }
  // The update guard's vectors, live on an empty room.
  for (const v of c.vectors) {
    other(encodeRoomInput(0, 0, [[0, v.kind === 'stateVector' ? msgStep1(fromHex(v.hex)) : msgUpdate(fromHex(v.hex))]]));
  }
  // A desktop uploading its layout into an empty room, with its presence.
  realClient(
    encodeRoomInput(0, 0, [
      [0, msgStep1(empty)],
      [0, msgStep2(new Uint8Array(readFileSync(fuzzData('seeds', 'desktop-tight-corner.ydoc'))))],
      [0, frame((e) => {
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint8Array(e, new Uint8Array(readFileSync(fuzzData('seeds', 'desktop-awareness.bin'))));
      })],
    ]),
  );
  return out;
}

/** The shared module's parts in `doc`, by id. */
function sharedParts(doc: Y.Doc): Y.Map<unknown>[] {
  const ids = new Set<string>(SHARED_ROOM.parts.map((p) => p.id));
  const out: Y.Map<unknown>[] = [];
  for (const l of sheets(doc)) {
    const bricks = l.get('bricks');
    if (bricks instanceof Y.Array) for (const b of bricks) if (b instanceof Y.Map && ids.has(b.get('id') as string)) out.push(b);
  }
  return out;
}

/** Turn every part of the module by `deg` about `about` and move it by (dx, dy), as the apps do (parts without a hull: about the box center). */
function moveShared(parts: readonly Y.Map<unknown>[], deg: number, about: { x: number; y: number }, dx: number, dy: number): void {
  const r = (deg * Math.PI) / 180;
  for (const b of parts) {
    const a = b.get('displayArea') as { x: number; y: number; width: number; height: number };
    const cx = a.x + a.width / 2 - about.x;
    const cy = a.y + a.height / 2 - about.y;
    const to = { x: about.x + cx * Math.cos(r) - cy * Math.sin(r) + dx, y: about.y + cx * Math.sin(r) + cy * Math.cos(r) + dy };
    const quarter = Math.round(deg / 90) % 2 !== 0;
    const w = quarter ? a.height : a.width;
    const h = quarter ? a.width : a.height;
    b.set('displayArea', { x: to.x - w / 2, y: to.y - h / 2, width: w, height: h });
    b.set('orientation', ((((b.get('orientation') as number) ?? 0) + deg) % 360 + 360) % 360);
  }
}

function sharedSeeds(state: Uint8Array, real: (u: Uint8Array) => void, other: (u: Uint8Array) => void): void {
  const r = SHARED_ROOM.index;
  const whole: ((doc: Y.Doc) => void)[] = [
    (doc) => doc.transact(() => moveShared(sharedParts(doc), 0, { x: 0, y: 0 }, 24.5, -8)),
    (doc) => doc.transact(() => moveShared(sharedParts(doc), 0, { x: 0, y: 0 }, 1, 0)),
    (doc) => doc.transact(() => moveShared(sharedParts(doc), 90, { x: 104, y: 54 }, 0, 0)),
    (doc) => doc.transact(() => moveShared(sharedParts(doc), 33.333, { x: 96, y: 50 }, -12.25, 3)),
    (doc) =>
      doc.transact(() => {
        // Another sheet: the same ids deleted and added again, on the layout's first parts sheet.
        const to = sheets(doc).find((l) => l.get('id') !== SHARED_ROOM.sheet && l.get('bricks') instanceof Y.Array);
        const from = sheets(doc).find((l) => l.get('id') === SHARED_ROOM.sheet);
        if (!to || !from) return;
        const list = from.get('bricks') as Y.Array<Y.Map<unknown>>;
        const copies = list.toArray().map((b) => {
          const c = new Y.Map<unknown>();
          for (const [k, v] of b.entries()) c.set(k, v);
          return c;
        });
        list.delete(0, list.length);
        (to.get('bricks') as Y.Array<unknown>).push(copies);
      }),
  ];
  const broken: ((doc: Y.Doc) => void)[] = [
    (doc) => doc.transact(() => moveShared(sharedParts(doc).slice(0, 1), 0, { x: 0, y: 0 }, 3, 0)),
    (doc) => doc.transact(() => moveShared(sharedParts(doc).slice(0, 2), 90, { x: 104, y: 54 }, 0, 0)),
    (doc) => doc.transact(() => sharedParts(doc)[1]?.set('partNumber', '3001.4')),
    (doc) =>
      doc.transact(() => {
        const from = sheets(doc).find((l) => l.get('id') === SHARED_ROOM.sheet);
        (from?.get('bricks') as Y.Array<unknown> | undefined)?.delete(2, 1);
      }),
  ];
  whole.forEach((edit, i) => {
    const a = client(state, 7700 + i);
    edit(a.doc);
    if (a.edits.length) real(encodeRoomInput(r, 0, a.edits.map((u): Msg => [0, msgUpdate(u)])));
  });
  // Two people at once: a turn and a move made on the same layout, in both orders.
  for (const [x, y] of [[2, 0], [0, 2], [3, 1]] as const) {
    const a = client(state, 7720 + x);
    const b = client(state, 7730 + y);
    whole[x]!(a.doc);
    whole[y]!(b.doc);
    real(encodeRoomInput(r, 0, [...a.edits.map((u): Msg => [0, msgUpdate(u)]), ...b.edits.map((u): Msg => [3, msgUpdate(u)])]));
  }
  // An outdated app's changes that break it, each after a move of the whole (put back; the connection stays).
  broken.forEach((edit, i) => {
    const a = client(state, 7740 + i);
    whole[0]!(a.doc);
    edit(a.doc);
    other(encodeRoomInput(r, 0, a.edits.map((u): Msg => [i % 2, msgUpdate(u)])));
  });
}

export function guardSeeds(): Uint8Array[] {
  const c = updateGuardContract();
  const out: Uint8Array[] = [
    ...c.vectors.map((v) => fromHex(v.hex)),
    ...c.gridSize.vectors.map((v) => fromHex(v.hex)),
    ...c.drawingSettings.vectors.map((v) => fromHex(v.hex)),
    ...roomStates(),
    new Uint8Array(readFileSync(fuzzData('seeds', 'desktop-awareness.bin'))),
  ];
  // Every update of the room seeds, on its own.
  for (const seed of roomSeeds()) {
    for (let p = 2; p < seed.length; ) {
      p++;
      let len = 0;
      let scale = 1;
      for (;;) {
        const b = seed[p++]!;
        len += (b & 0x7f) * scale;
        scale *= 128;
        if (b < 0x80) break;
      }
      const msg = seed.subarray(p, p + len);
      p += len;
      // [0 sync, type, varUint length, update]
      if (msg[0] === 0 && (msg[1] === 1 || msg[1] === 2)) {
        let q = 2;
        while (msg[q]! >= 0x80) q++;
        out.push(msg.subarray(q + 1));
      }
    }
  }
  return out;
}
