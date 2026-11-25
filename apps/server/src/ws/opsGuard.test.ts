// The waybills and jobs, and a car's own ops fields, the server takes (ws/carsGuard.ts), through the live
// handler: what the apps write passes; one outside the limits leaves the
// layout as it was, however its changes arrive (in any order, as two
// structs for one id, in a map put in place of the layout's), and after the
// layout is opened again.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from '@fastify/websocket';
import { createDefaultLayoutDoc, deleteRecord, ensureRecordMaps, readRecordsFromDoc, OPS_JOBS_KEY, ROLLING_STOCK_KEY, WAYBILLS_KEY, writeRecord } from '@cld/ydoc';
import { OPS_LIMITS } from '@cld/parts-catalog/browser';
import { DocSession } from './docHub.js';
import { handleMessage, type Sender } from './handler.js';
import { decodeIncoming, guardWork } from './decoded.js';
import { newPace, resetCopyBudgets } from './pacing.js';
import { carsProblem, docCarsProblems, MAX_OF, MAX_OPS_SIZE } from './carsGuard.js';
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

const waybill = (id: string, more: object = {}) => ({ id, car: 'c1', from: 'p1', leg: 1, to1: 'p1', spot1: '', load1: 'empty', note1: '', to2: 'p2', spot2: 's1', load2: 'loaded', note2: 'Ice first', ...more });
const job = (id: string, more: object = {}) => ({ id, name: 'Cannery Turn', kind: 'turn', train: '', order: 1, stop_a: { place: 'p1', at: 1 }, stop_b: { place: 'p2', at: 2 }, ...more });

let n = 0;
function live() {
  const doc = createDefaultLayoutDoc();
  ensureRecordMaps(doc);
  doc.transact(() => {
    writeRecord(doc, ROLLING_STOCK_KEY, { id: 'c1', number: '1', length: 32, opsWaybill: 'w1', opsHome: 'p1' });
    writeRecord(doc, WAYBILLS_KEY, waybill('w1'));
    writeRecord(doc, OPS_JOBS_KEY, job('j1'));
  });
  const s = new DocSession(`ops-${++n}`);
  Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(doc));
  open.push(s);
  resetCopyBudgets();
  let closed = false;
  let code = 0;
  const ws = { OPEN: 1, readyState: 1, send() {}, close: (c: number) => void ((closed = true), (code = c)) };
  s.clients.add(ws as never);
  s.clientUsers.set(ws as never, 'alice');
  const sender: Sender = { layoutId: s.layoutId, userId: 'alice', client: 't', noted: new Set(), pace: newPace() };
  return {
    doc: s.doc,
    code: () => code,
    send(u: Uint8Array, role: 'editor' | 'viewer' = 'editor') {
      closed = false;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      handleMessage(ws as unknown as WebSocket, s, encoding.toUint8Array(enc), role, sender);
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

const w1 = (d: Y.Doc) => map(d, WAYBILLS_KEY).get('w1')!;
const j1 = (d: Y.Doc) => map(d, OPS_JOBS_KEY).get('j1')!;
const c1 = (d: Y.Doc) => map(d, ROLLING_STOCK_KEY).get('c1')!;
const BAD: [string, (d: Y.Doc) => void][] = [
  ['a car’s waybill as something else', (d) => c1(d).set('opsWaybill', { id: 'w1' })],
  ['a car’s home as a map', (d) => c1(d).set('opsHome', new Y.Map())],
  ['where a car is', (d) => c1(d).set('opsAt', 'x'.repeat(200))],
  ['whether it is set aside', (d) => c1(d).set('opsHold', 1)],
  ['whether it is set aside, as text to edit', (d) => c1(d).set('opsHold', new Y.Text('yes'))],
  ['a waybill’s car', (d) => w1(d).set('car', 5)],
  ['its car as a list', (d) => w1(d).set('car', new Y.Array())],
  ['its leg', (d) => w1(d).set('leg', 5)],
  ['its leg as text', (d) => w1(d).set('leg', '1')],
  ['its leg, a whole number too big', (d) => w1(d).set('leg', 1n)],
  ['half a leg', (d) => w1(d).set('leg', 1.5)],
  ['where it goes', (d) => w1(d).set('to3', ['p1'])],
  ['where it goes, as a map', (d) => w1(d).set('to4', new Y.Map([['place', 'p1']]))],
  ['its spot', (d) => w1(d).set('spot1', 'x'.repeat(200))],
  ['its load', (d) => w1(d).set('load2', 'half')],
  ['its note', (d) => w1(d).set('note1', 'x'.repeat(201))],
  ['a field of bytes', (d) => w1(d).set('later', new Uint8Array(9))],
  ['a field’s name', (d) => w1(d).set('f'.repeat(99), 1)],
  ['a waybill too big', (d) => w1(d).set('later', 'x'.repeat(MAX_OPS_SIZE))],
  ['a stop as text', (d) => j1(d).set('stop_c', 'p1')],
  ['a stop as a map', (d) => j1(d).set('stop_c', new Y.Map([['place', 'p1']]))],
  ['a stop’s place', (d) => j1(d).set('stop_a', { place: '', at: 1 })],
  ['where a stop is among them', (d) => j1(d).set('stop_a', { place: 'p1', at: Infinity })],
  ['a job’s name', (d) => j1(d).set('name', 'x'.repeat(81))],
  ['a job’s kind', (d) => j1(d).set('kind', null)],
  ['a job’s train', (d) => j1(d).set('train', { id: 't1' })],
  ['a job’s order', (d) => j1(d).set('order', Number.NaN)],
  ['a job too big', (d) => j1(d).set('later', 'x'.repeat(MAX_OPS_SIZE))],
  ['a waybill as a plain value', (d) => (map(d, WAYBILLS_KEY) as Y.Map<unknown>).set('w2', waybill('w2'))],
  ['a waybill as text', (d) => (map(d, WAYBILLS_KEY) as Y.Map<unknown>).set('w1', 'waybill')],
  ['a job as a list', (d) => (map(d, OPS_JOBS_KEY) as Y.Map<unknown>).set('j1', new Y.Array())],
  ['a job as a hook', (d) => (map(d, OPS_JOBS_KEY) as Y.Map<unknown>).set('j1', new Y.XmlHook('x'))],
  ['a job’s id', (d) => map(d, OPS_JOBS_KEY).set('j'.repeat(200), new Y.Map())],
  ['the waybills as text', (d) => d.getMap('meta').set(WAYBILLS_KEY, 'text')],
  ['the jobs as a plain value', (d) => d.getMap('meta').set(OPS_JOBS_KEY, { j1: job('j1') })],
  ['the waybills as a list', (d) => d.getMap('meta').set(WAYBILLS_KEY, new Y.Array())],
  ['another map of waybills, a bad one in it', (d) => d.getMap('meta').set(WAYBILLS_KEY, new Y.Map([['w1', new Y.Map([['leg', 'x']])]]))],
  ['another map of jobs, a plain one in it', (d) => d.getMap('meta').set(OPS_JOBS_KEY, new Y.Map([['j1', job('j1')]]))],
];

describe('what the apps write passes', () => {
  it('waybills, turned and cleared; jobs and their stops; a car’s pocket, home, place and hold; another map of them', () => {
    for (const edit of [
      (d: Y.Doc) => writeRecord(d, WAYBILLS_KEY, waybill('w2', { car: '', leg: 0 })),
      (d: Y.Doc) => {
        w1(d).set('leg', 2);
        c1(d).set('opsLoad', 'loaded');
      },
      (d: Y.Doc) => w1(d).set('to2', ''),
      (d: Y.Doc) => deleteRecord(d, WAYBILLS_KEY, 'w1'),
      (d: Y.Doc) => writeRecord(d, OPS_JOBS_KEY, job('j2', { later: { any: [1, 'x', null] } })),
      (d: Y.Doc) => j1(d).set('stop_c', { place: 'p3', at: 1.5 }),
      (d: Y.Doc) => j1(d).delete('stop_a'),
      (d: Y.Doc) => writeRecord(d, ROLLING_STOCK_KEY, { id: 'c1', opsWaybill: '', opsHome: 'p2', opsAt: 'p3', opsHold: true }),
      (d: Y.Doc) => d.getMap('meta').set(WAYBILLS_KEY, new Y.Map([['w1', new Y.Map(Object.entries(waybill('w1')))]])),
    ]) {
      const { l, refused } = tries(edit);
      expect(refused, String(edit)).toBe(false);
      sound(l);
    }
  });
  it('the limits are the contract’s, doubled; a full job passes', () => {
    expect(MAX_OF[WAYBILLS_KEY]).toBe(2 * OPS_LIMITS.waybills);
    expect(MAX_OF[OPS_JOBS_KEY]).toBe(2 * OPS_LIMITS.jobs);
    const id = '0123456789abcdef0123456789abcdef0123';
    const stops = Object.fromEntries(Array.from({ length: 2 * OPS_LIMITS.stops }, (_, i) => [`stop_${id}${i}`, { place: 'p'.repeat(64), at: i }]));
    expect(tries((d) => writeRecord(d, OPS_JOBS_KEY, job('full', { name: 'n'.repeat(80), ...stops }))).refused).toBe(false);
    const full = Object.fromEntries([1, 2, 3, 4].flatMap((k) => [[`to${k}`, 'p'.repeat(64)], [`spot${k}`, 's'.repeat(64)], [`load${k}`, 'loaded'], [`note${k}`, 'n'.repeat(200)]]));
    expect(tries((d) => writeRecord(d, WAYBILLS_KEY, waybill('full', full))).refused).toBe(false);
  });
});

describe('outside the limits: the layout stays as it was', () => {
  for (const [what, edit] of BAD)
    it(what, () => {
      const { l, refused } = tries(edit);
      expect(refused).toBe(true);
      sound(l);
      expect(readRecordsFromDoc(l.doc, WAYBILLS_KEY)).toEqual([waybill('w1')]);
      expect(readRecordsFromDoc(l.doc, OPS_JOBS_KEY)).toEqual([job('j1')]);
      expect(readRecordsFromDoc(l.doc, ROLLING_STOCK_KEY)).toMatchObject([{ id: 'c1', opsWaybill: 'w1', opsHome: 'p1' }]);
    });

  it('more of them than a layout may have, added at once or in turn', () => {
    for (const key of [WAYBILLS_KEY, OPS_JOBS_KEY]) {
      const l = live();
      const c = l.client();
      const many = (from: number, to: number) => updateOf(c, () => { for (let i = from; i < to; i++) map(c, key).set(`q${i}`, new Y.Map()); });
      expect(l.send(many(0, MAX_OF[key]! - 1))).toBe(false);
      expect(l.send(many(MAX_OF[key]! - 1, MAX_OF[key]!))).toBe(true);
      sound(l);
    }
  });

  it('many fields, written in turn, can’t make one too big; a big one can still be changed', () => {
    for (const [key, id] of [[WAYBILLS_KEY, 'w1'], [OPS_JOBS_KEY, 'j1']] as const) {
      const l = live();
      let refusedAt = 0;
      for (let i = 0; i < 12 && !refusedAt; i++) {
        const c = l.client(2000 + i);
        if (l.send(updateOf(c, () => map(c, key).get(id)!.set(`f${i}`, 'e'.repeat(6_000))))) refusedAt = i;
      }
      expect(refusedAt).toBeGreaterThan(3);
      sound(l);
      const c = l.client(3000);
      expect(l.send(updateOf(c, () => map(c, key).get(id)!.set('f0', 'a'.repeat(6_000))))).toBe(false);
    }
  });

  it('stops, written in turn, are limited too', () => {
    const l = live();
    let refusedAt = 0;
    for (let i = 0; i < 400 && !refusedAt; i++) {
      const c = l.client(2000 + i);
      if (l.send(updateOf(c, () => j1(c).set(`stop_${i}`, { place: 'p'.repeat(64), at: i })))) refusedAt = i;
    }
    expect(refusedAt).toBeGreaterThan(2 * OPS_LIMITS.stops);
    sound(l);
  });

  it('an odd one that is there already doesn’t stop other edits', () => {
    const l = live();
    l.doc.transact(() => map(l.doc, WAYBILLS_KEY).set('odd', new Y.Map([['leg', 'x']])));
    const c = l.client();
    expect(l.send(updateOf(c, () => map(c, WAYBILLS_KEY).get('odd')!.set('car', 'c1')))).toBe(false);
    expect(l.send(updateOf(c, () => map(c, WAYBILLS_KEY).get('odd')!.set('leg', 1)))).toBe(false);
    sound(l);
  });

  it('a viewer writes none of them', () => {
    for (const edit of [(d: Y.Doc) => w1(d).set('leg', 2), (d: Y.Doc) => j1(d).set('name', 'x'), (d: Y.Doc) => c1(d).set('opsHold', true)]) {
      const l = live();
      const c = l.client();
      l.send(updateOf(c, () => edit(c)), 'viewer');
      expect(readRecordsFromDoc(l.doc, WAYBILLS_KEY)).toEqual([waybill('w1')]);
      expect(readRecordsFromDoc(l.doc, OPS_JOBS_KEY)).toEqual([job('j1')]);
      expect(readRecordsFromDoc(l.doc, ROLLING_STOCK_KEY)[0]).not.toHaveProperty('opsHold');
    }
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
            updateOf(c, () => j1(c).set('name', 'x')),
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
    const a = updateOf(c, () => map(c, WAYBILLS_KEY).set('late', fresh));
    const b = updateOf(c, () => fresh.set('leg', 'none'));
    l.send(b);
    l.send(a);
    sound(l);
  });

  it('two blocks of one client, in either order', () => {
    for (const swap of [false, true]) {
      const l = live();
      const c = l.client(9001);
      const bad = noDeletes(updateOf(c, () => w1(c).set('leg', 'none')));
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
      const t = j1(c);
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
    const b = updateOf(c, () => j1(c).set('order', 41));
    Y.applyUpdate(l.doc, noDeletes(b));
    expect(placesProblem(l.doc, decodeIncoming(a)!, a, () => false)).toBe(PLACES_COPY_BUDGET_SPENT);
    const copies = guardWork.docCopies;
    expect(placesProblem(l.doc, decodeIncoming(a)!, a, () => true)).toBeNull();
    expect(guardWork.docCopies).toBe(copies + 1);
  });

  it('one that waits, and what it waits for, after the room is opened again', () => {
    for (const [, edit] of BAD) {
      const l = live();
      const c = l.client();
      const first = updateOf(c, () => c.getMap('meta').set('author', 'me'));
      const bad = updateOf(c, () => edit(c));
      l.send(bad);
      // (A restart: what waited comes back with the document.)
      const again = new DocSession(`ops-again-${++n}`);
      Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(l.doc));
      open.push(again);
      l.send(first);
      l.send(bad);
      sound(l);
      Y.applyUpdate(l.doc, first);
      sound(l);
    }
  });

  it('maps nested without end are read to a depth and no further', () => {
    const c = new Y.Doc();
    const u = updateOf(c, () => {
      let m = new Y.Map<unknown>();
      c.getMap('meta').set('x', m);
      for (let i = 0; i < 5000; i++) {
        const next = new Y.Map<unknown>();
        m.set(WAYBILLS_KEY, next);
        m = next;
      }
    });
    expect(carsProblem(live().doc, decodeIncoming(u)!)).toBeNull();
  });
});

