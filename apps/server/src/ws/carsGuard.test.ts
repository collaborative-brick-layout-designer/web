// The cars and trains the server takes (ws/carsGuard.ts), through the live
// handler: what the apps write passes; one outside the limits leaves the
// layout as it was, however its changes arrive (in any order, as two
// structs for one id, in a map put in place of the layout's), and after the
// layout is opened again.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from '@fastify/websocket';
import { createDefaultLayoutDoc, deleteRecord, ensureRecordMaps, readRecordsFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY, writeRecord } from '@cld/ydoc';
import { CUT_LIMITS, newCut, simpleStock } from '@cld/parts-catalog/browser';
import { DocSession } from './docHub.js';
import { handleMessage, type Sender } from './handler.js';
import { decodeIncoming, guardWork } from './decoded.js';
import { newPace, resetCopyBudgets } from './pacing.js';
import { carsProblem, docCarsProblems, MAX_RECORDS, MAX_RECORD_SIZE, MAX_UNITS, validCarField } from './carsGuard.js';
import { PLACES_COPY_BUDGET_SPENT, placesProblem } from './placesGuard.js';

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
let open: DocSession[] = [];
afterEach(() => {
  for (const s of open) {
    s.awareness.destroy();
    s.doc.destroy();
  }
  open = [];
});

const plain = <T>(v: T) => JSON.parse(JSON.stringify(v)) as Record<string, unknown> & { id: string };
const car = (id: string, more: object = {}) => plain({ ...simpleStock(id, { number: id }), ...more });
const cut = (id: string, cars: string[], more: object = {}) => plain({ ...newCut(id, cars.map((c) => simpleStock(c)), { brick: 'a', from: 0, to: 1, s: 4, facing: 'to' }), ...more });

let n = 0;
function live() {
  const doc = createDefaultLayoutDoc();
  ensureRecordMaps(doc);
  doc.transact(() => {
    writeRecord(doc, ROLLING_STOCK_KEY, car('c1', { opsCut: 't1', opsLoad: 'loaded' }));
    writeRecord(doc, TRAINS_KEY, cut('t1', ['c1']));
  });
  const s = new DocSession(`cars-${++n}`);
  Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(doc));
  open.push(s);
  resetCopyBudgets();
  let closed = false;
  const ws = { OPEN: 1, readyState: 1, send() {}, close: () => void (closed = true) };
  s.clients.add(ws as never);
  s.clientUsers.set(ws as never, 'alice');
  const sender: Sender = { layoutId: s.layoutId, userId: 'alice', client: 't', noted: new Set(), pace: newPace() };
  return {
    doc: s.doc,
    refused: () => closed,
    send(u: Uint8Array) {
      closed = false;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      handleMessage(ws as unknown as WebSocket, s, encoding.toUint8Array(enc), 'editor', sender);
      return closed;
    },
    client(id = 900 + n) {
      const d = new Y.Doc();
      d.clientID = id;
      Y.applyUpdate(d, Y.encodeStateAsUpdate(s.doc));
      return d;
    },
  };
}
type Live = ReturnType<typeof live>;
function updateOf(doc: Y.Doc, edit: () => void): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  doc.transact(edit);
  return Y.encodeStateAsUpdate(doc, sv);
}
const map = (d: Y.Doc, key: string) => d.getMap('meta').get(key) as Y.Map<Y.Map<unknown>>;
/** The layout is within the limits now, and when it is opened again (a join, a restart). */
function sound(l: Live) {
  expect([...docCarsProblems(l.doc)]).toEqual([]);
  const again = new Y.Doc();
  Y.applyUpdate(again, Y.encodeStateAsUpdate(l.doc));
  ensureRecordMaps(again);
  expect([...docCarsProblems(again)]).toEqual([]);
}
const tries = (edit: (d: Y.Doc) => void) => {
  const l = live();
  const c = l.client();
  const refused = l.send(updateOf(c, () => edit(c)));
  return { l, refused };
};

const BAD: [string, (d: Y.Doc) => void][] = [
  ['a car’s length', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('length', 1e9)],
  ['no length', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('length', Number.NaN)],
  ['a whole number too big', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('length', 5n)],
  ['its trucks', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('trucks', [{ at: Infinity }, { at: 1 }])],
  ['many trucks', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('trucks', Array.from({ length: 17 }, () => ({ at: 1 })))],
  ['its cut as something else', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('opsCut', { id: 't1' })],
  ['its cut as a map', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('opsCut', new Y.Map())],
  ['its load as text to edit', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('opsLoad', new Y.Text('loaded'))],
  ['its load', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('opsLoad', 'x'.repeat(99))],
  ['a field’s name', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('f'.repeat(99), 1)],
  ['a field of bytes', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('later', new Uint8Array(9))],
  ['a car too big', (d) => map(d, ROLLING_STOCK_KEY).get('c1')!.set('notes', 'x'.repeat(MAX_RECORD_SIZE))],
  ['units as a list of their own', (d) => map(d, TRAINS_KEY).get('t1')!.set('units', new Y.Array())],
  ['units as text', (d) => map(d, TRAINS_KEY).get('t1')!.set('units', 'c1')],
  ['a unit', (d) => map(d, TRAINS_KEY).get('t1')!.set('units', [{ stock: 5 }])],
  ['too many units', (d) => map(d, TRAINS_KEY).get('t1')!.set('units', Array.from({ length: MAX_UNITS + 1 }, () => ({ stock: 'c1', reversed: false })))],
  ['a position', (d) => map(d, TRAINS_KEY).get('t1')!.set('position', { brick: 'a', from: 0, to: 1, s: Infinity, facing: 'to' })],
  ['a position’s end', (d) => map(d, TRAINS_KEY).get('t1')!.set('position', { brick: 'a', from: -1, to: 1, s: 1, facing: 'to' })],
  ['a position as a map', (d) => map(d, TRAINS_KEY).get('t1')!.set('position', new Y.Map([['brick', 'a']]))],
  ['a way it faces', (d) => map(d, TRAINS_KEY).get('t1')!.set('position', { brick: 'a', from: 0, to: 1, s: 1, facing: 'up' })],
  ['the switches it stands over', (d) => map(d, TRAINS_KEY).get('t1')!.set('over', { 'a/0': 'x' })],
  ['a list of them', (d) => map(d, TRAINS_KEY).get('t1')!.set('over', [1])],
  ['whether it is a cut', (d) => map(d, TRAINS_KEY).get('t1')!.set('cut', 1)],
  ['when it was emptied', (d) => map(d, TRAINS_KEY).get('t1')!.set('emptiedAt', 'now')],
  ['a record as a plain value', (d) => (map(d, TRAINS_KEY) as Y.Map<unknown>).set('t2', cut('t2', ['c1']))],
  ['a record as text', (d) => (map(d, ROLLING_STOCK_KEY) as Y.Map<unknown>).set('c2', 'car')],
  ['a record as a list', (d) => (map(d, ROLLING_STOCK_KEY) as Y.Map<unknown>).set('c1', new Y.Array())],
  ['a record as a hook', (d) => (map(d, TRAINS_KEY) as Y.Map<unknown>).set('t1', new Y.XmlHook('x'))],
  ['a record’s id', (d) => map(d, TRAINS_KEY).set('t'.repeat(200), new Y.Map())],
  ['the trains as text', (d) => d.getMap('meta').set(TRAINS_KEY, 'text')],
  ['the cars as a plain value', (d) => d.getMap('meta').set(ROLLING_STOCK_KEY, { c1: car('c1') })],
  ['the trains as a list', (d) => d.getMap('meta').set(TRAINS_KEY, new Y.Array())],
  ['another map of trains, a bad one in it', (d) => d.getMap('meta').set(TRAINS_KEY, new Y.Map([['t1', new Y.Map([['units', 'c1']])]]))],
  ['another map of cars, a plain one in it', (d) => d.getMap('meta').set(ROLLING_STOCK_KEY, new Y.Map([['c1', car('c1')]]))],
];

describe('what the apps write passes', () => {
  it('a car, its load and cut; a cut, moved, split, emptied and deleted; another map of them', () => {
    for (const edit of [
      (d: Y.Doc) => writeRecord(d, ROLLING_STOCK_KEY, car('c2', { look: { mode: 'model', color: '#fff', picture: 'p'.repeat(60_000) } })),
      (d: Y.Doc) => writeRecord(d, TRAINS_KEY, cut('t1', ['c1'], { over: { 'P/0': 2 }, position: { brick: 'b', from: 0, to: 2, s: 1.5, facing: 'from' } })),
      (d: Y.Doc) => {
        writeRecord(d, TRAINS_KEY, cut('t2', ['c1']));
        writeRecord(d, TRAINS_KEY, cut('t1', [], { emptiedAt: 1.7e12 }));
        writeRecord(d, ROLLING_STOCK_KEY, car('c1', { opsCut: 't2' }));
      },
      (d: Y.Doc) => map(d, ROLLING_STOCK_KEY).get('c1')!.delete('opsCut'),
      (d: Y.Doc) => deleteRecord(d, TRAINS_KEY, 't1'),
      (d: Y.Doc) => writeRecord(d, TRAINS_KEY, { id: 'old', name: 'A train from before', trackKind: 'rail', units: [{ stock: 'c1', reversed: true }], position: null, color: '#123456', speed: 40, later: { any: [1, 'x', null] } }),
      (d: Y.Doc) => d.getMap('meta').set(TRAINS_KEY, new Y.Map([['t1', new Y.Map(Object.entries(cut('t1', ['c1'])))]])),
    ]) {
      const { l, refused } = tries(edit);
      expect(refused, String(edit)).toBe(false);
      sound(l);
    }
  });

  it('the limits are the contract’s, doubled', () => {
    expect(MAX_UNITS).toBe(2 * CUT_LIMITS.units);
    expect(MAX_RECORDS).toBe(2 * CUT_LIMITS.records);
    expect(validCarField(TRAINS_KEY, 'units', Array.from({ length: MAX_UNITS }, () => ({ stock: 'c', reversed: false })))).toBe(true);
  });
});

describe('outside the limits: the layout stays as it was', () => {
  for (const [what, edit] of BAD)
    it(what, () => {
      const { l, refused } = tries(edit);
      expect(refused).toBe(true);
      sound(l);
      expect(readRecordsFromDoc(l.doc, TRAINS_KEY)).toMatchObject([{ id: 't1', units: [{ stock: 'c1' }] }]);
      expect(readRecordsFromDoc(l.doc, ROLLING_STOCK_KEY)).toMatchObject([{ id: 'c1', opsCut: 't1' }]);
    });

  it('more of them than a layout may have, added at once or in turn', () => {
    const l = live();
    const c = l.client();
    const many = (from: number, to: number) => updateOf(c, () => { for (let i = from; i < to; i++) map(c, TRAINS_KEY).set(`q${i}`, new Y.Map()); });
    expect(l.send(many(0, MAX_RECORDS - 1))).toBe(false);
    expect(l.send(many(MAX_RECORDS - 1, MAX_RECORDS))).toBe(true);
    sound(l);
  });

  it('many fields, written in turn, can’t make one too big; a big one can still be changed', () => {
    const l = live();
    let refusedAt = 0;
    for (let i = 0; i < 12 && !refusedAt; i++) {
      const c = l.client(2000 + i);
      if (l.send(updateOf(c, () => map(c, ROLLING_STOCK_KEY).get('c1')!.set(`f${i}`, 'e'.repeat(20_000))))) refusedAt = i;
    }
    expect(refusedAt).toBeGreaterThan(4);
    sound(l);
    const c = l.client(3000);
    expect(l.send(updateOf(c, () => map(c, ROLLING_STOCK_KEY).get('c1')!.set('f0', 'a'.repeat(20_000))))).toBe(false);
    expect(l.send(updateOf(c, () => map(c, ROLLING_STOCK_KEY).get('c1')!.set('opsLoad', 'empty')))).toBe(false);
  });

  it('an odd one that is there already doesn’t stop other edits', () => {
    const l = live();
    l.doc.transact(() => map(l.doc, TRAINS_KEY).set('odd', new Y.Map([['units', 'x']])));
    const c = l.client();
    expect(l.send(updateOf(c, () => map(c, TRAINS_KEY).get('odd')!.set('name', 'Odd')))).toBe(false);
    expect(l.send(updateOf(c, () => map(c, TRAINS_KEY).get('odd')!.set('units', [])))).toBe(false);
    sound(l);
  });
});

/** An update without its deletions (a room holds one with them whole: ws/held.ts). */
const noDeletes = (u: Uint8Array): Uint8Array => {
  const d = Y.decodeUpdate(u);
  for (let k = u.length - 1; k > 0; k--) {
    const t = new Uint8Array([...u.slice(0, k), 0]);
    try {
      const r = Y.decodeUpdate(t);
      if (r.structs.length === d.structs.length && r.ds.clients.size === 0) return t;
    } catch {
      /* not there */
    }
  }
  throw new Error('no cut');
};

describe('however the changes arrive', () => {
  it('in any order, with their deletions and without', () => {
    for (const [, edit] of BAD)
      for (const strip of [false, true])
        for (const order of [[1, 0], [1, 2, 0], [2, 1, 0], [2, 0, 1], [0, 2, 1]]) {
          const l = live();
          const c = l.client();
          const us = [
            updateOf(c, () => map(c, TRAINS_KEY).get('t1')!.set('name', 'x')),
            updateOf(c, () => edit(c)),
            updateOf(c, () => c.getMap('meta').set('author', 'me')),
          ].map((u) => (strip && u.length < 4000 ? noDeletes(u) : u));
          for (const i of order) l.send(us[i]!);
          sound(l);
          l.doc.destroy();
        }
  }, 60_000);

  it('a parent that arrives after what is in it', () => {
    const l = live();
    const c = l.client();
    const fresh = new Y.Map<unknown>();
    const a = updateOf(c, () => map(c, TRAINS_KEY).set('late', fresh));
    const b = updateOf(c, () => fresh.set('units', 'none'));
    l.send(b);
    l.send(a);
    sound(l);
  });

  it('two blocks of one client, in either order', () => {
    for (const swap of [false, true]) {
      const l = live();
      const c = l.client(9001);
      const bad = noDeletes(updateOf(c, () => map(c, TRAINS_KEY).get('t1')!.set('units', 'none')));
      const other = new Y.Doc();
      other.clientID = 9001;
      other.getMap('m').set('k', 1);
      const a = bad.subarray(1, bad.length - 1);
      const full = Y.encodeStateAsUpdate(other);
      const b = full.subarray(1, full.length - 1);
      const u = new Uint8Array([2, ...(swap ? [...b, ...a] : [...a, ...b]), 0]);
      l.send(u);
      sound(l);
    }
  });

  it('what the update deletes itself is never read; what another left is', () => {
    const l = live();
    const c = l.client();
    const u = updateOf(c, () => {
      const t = map(c, TRAINS_KEY).get('t1')!;
      t.set('name', 'a');
      t.set('name', 'b');
    });
    expect(l.send(u)).toBe(false);
    sound(l);
  });

  it('a copy is made only while the sender may have one', () => {
    const l = live();
    const c = l.client();
    const a = updateOf(c, () => c.getMap('meta').set('x', 1));
    const b = updateOf(c, () => map(c, TRAINS_KEY).get('t1')!.set('speed', 41));
    Y.applyUpdate(l.doc, noDeletes(b));
    expect(placesProblem(l.doc, decodeIncoming(a)!, a, () => false)).toBe(PLACES_COPY_BUDGET_SPENT);
    const copies = guardWork.docCopies;
    expect(placesProblem(l.doc, decodeIncoming(a)!, a, () => true)).toBeNull();
    expect(guardWork.docCopies).toBe(copies + 1);
  });

  it('maps nested without end are read to a depth and no further', () => {
    const c = new Y.Doc();
    const u = updateOf(c, () => {
      let m = new Y.Map<unknown>();
      c.getMap('meta').set('x', m);
      for (let i = 0; i < 5000; i++) {
        const next = new Y.Map<unknown>();
        m.set(TRAINS_KEY, next);
        m = next;
      }
    });
    expect(carsProblem(live().doc, decodeIncoming(u)!)).toBeNull();
  });
});
