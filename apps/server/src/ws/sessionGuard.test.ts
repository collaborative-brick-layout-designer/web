// Who may write what while an operating session runs (ws/opsGuard.ts),
// through the live handler: each role against each key, viewer crew, no
// session; and every way an update could slip past (out of order, two
// structs for one id, a value of another kind, a whole map put in place,
// deletes, growth, a nearby key, a write after the session ended or the
// role went, two sessions, another person's client id, a check that
// throws), each also after the layout is opened again.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from '@fastify/websocket';
import { createDefaultLayoutDoc, ensureRecordMaps, importSidecarIntoDoc, OPS_JOBS_KEY, OPS_LOG_KEY, OPS_SESSIONS_KEY, ROLLING_STOCK_KEY, SWITCH_STATES_KEY, TRAINS_KEY, WAYBILLS_KEY, writeRecord } from '@cld/ydoc';
import { DocSession } from './docHub.js';
import { handleMessage, OPS_REFUSED_REASON, type Sender } from './handler.js';
import { newPace, resetCopyBudgets } from './pacing.js';
import { opsProblemSafe } from './opsGuard.js';
import { decodeIncoming } from './decoded.js';

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

const LAYOUT = 'lay-1';
const yardPlace = { id: 'pl-yard', name: 'Yard', kind: 'yard', spots: [], accepts: [], ships: [], tags: [], notes: '' };
const canneryPlace = { id: 'pl-can', name: 'Cannery', kind: 'industry', spots: [], accepts: [], ships: [], tags: [], notes: '' };
const millPlace = { id: 'pl-mill', name: 'Mill', kind: 'industry', spots: [{ id: 'sp', name: 'Dock', track: { brick: 'B-mill', from: 0, to: 1 } }], accepts: [], ships: [], tags: [], notes: '' };
const pos = (brick: string, s = 1) => ({ brick, from: 0, to: 1, s, facing: 'to' });
const cut = (id: string, brick: string, cars: string[], more: object = {}) => ({ id, name: '', trackKind: 'rail', units: cars.map((stock) => ({ stock, reversed: false })), position: pos(brick), color: '#888888', speed: 0, cut: true, ...more });
const CREW = [
  { userId: 'vic', name: 'Vic', role: 'crew', places: [], job: 'j1' },
  { userId: 'yan', name: 'Yan', role: 'yardmaster', places: ['pl-yard'], job: '' },
  { userId: 'dan', name: 'Dan', role: 'dispatcher', places: [], job: '' },
  { userId: 'wes', name: 'Wes', role: 'crew', places: [], job: 'j2' },
  { userId: 'eve', name: 'Eve', role: 'crew', places: [], job: 'j1' },
];
const session = (id: string, status: string, more: object = {}) => ({ id, name: 'Session 1', status, seed: 7, layout: LAYOUT, host: 'alice', crew: CREW, clockFast: 0, clockStart: '', startedAt: 1, endedAt: 0, start: null, ...more });

function seeded(status = 'running'): Y.Doc {
  const doc = createDefaultLayoutDoc();
  importSidecarIntoDoc(doc, {
    schemaVersion: 1,
    bbmHashSha256: '',
    modules: [
      { id: 'm-yard', name: 'Yard', members: ['B-yard1', 'B-yard2'], places: [yardPlace] },
      { id: 'm-can', name: 'Cannery', members: ['B-can'], places: [canneryPlace] },
    ] as never,
    layoutPlaces: [millPlace] as never,
  });
  ensureRecordMaps(doc);
  doc.transact(() => {
    for (const c of ['car1', 'car2', 'car3', 'car4', 'car5']) writeRecord(doc, ROLLING_STOCK_KEY, { id: c, number: c, length: 32 });
    writeRecord(doc, TRAINS_KEY, cut('t-local', 'B-main', ['car4'], { cut: false, name: 'Local' }));
    writeRecord(doc, TRAINS_KEY, cut('cut-yard', 'B-yard1', ['car1']));
    writeRecord(doc, TRAINS_KEY, cut('cut-can', 'B-can', ['car2']));
    writeRecord(doc, TRAINS_KEY, cut('cut-main', 'B-main', ['car3']));
    writeRecord(doc, TRAINS_KEY, cut('cut-empty', 'B-can', [], { emptiedAt: 1 }));
    writeRecord(doc, TRAINS_KEY, cut('cut-mill', 'B-mill', ['car5']));
    for (const [car, c] of [['car1', 'cut-yard'], ['car2', 'cut-can'], ['car3', 'cut-main'], ['car4', 't-local'], ['car5', 'cut-mill']]) (doc.getMap('meta').get(ROLLING_STOCK_KEY) as Y.Map<Y.Map<unknown>>).get(car!)!.set('opsCut', c);
    writeRecord(doc, OPS_JOBS_KEY, { id: 'j1', name: 'Cannery Turn', kind: 'turn', train: 't-local', order: 1, status: 'out', stop_a: { place: 'pl-can', at: 1 }, stop_b: { place: 'pl-mill', at: 2 } });
    writeRecord(doc, OPS_JOBS_KEY, { id: 'j2', name: 'Yard Job', kind: 'yard', train: '', order: 2, status: 'waiting', stop_a: { place: 'pl-yard', at: 1 } });
    writeRecord(doc, WAYBILLS_KEY, { id: 'w1', car: 'car2', leg: 1, to1: 'pl-mill' });
    writeRecord(doc, OPS_SESSIONS_KEY, session('s1', status));
    writeRecord(doc, OPS_LOG_KEY, { id: 'log-1', session: 's1', at: 1, by: 'alice', kind: 'status', what: 's1', from: null, to: 'running', note: '' });
  });
  // The parts, on the layout's sheet.
  const bricks = (doc.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
  bricks.push(['B-main', 'B-yard1', 'B-yard2', 'B-can', 'B-mill'].map((id) => new Y.Map<unknown>([['id', id], ['partNumber', '2865.8']])));
  return doc;
}

let n = 0;
type Role = 'owner' | 'editor' | 'viewer';
function room(status = 'running') {
  const s = new DocSession(`sess-${++n}`);
  (s as unknown as { layoutId: string }).layoutId = LAYOUT;
  Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(seeded(status)));
  open.push(s);
  resetCopyBudgets();
  /** One person's connection: their client doc (its id is their presence), and what they send. */
  const person = (userId: string, role: Role, opts: { crew?: boolean; clientId?: number; present?: boolean } = {}) => {
    const d = new Y.Doc();
    d.clientID = opts.clientId ?? 5000 + ++n;
    Y.applyUpdate(d, Y.encodeStateAsUpdate(s.doc));
    let closed = '';
    const ws = { OPEN: 1, readyState: 1, send() {}, close: (_c: number, why: string) => void (closed = why) };
    s.clients.add(ws as never);
    s.clientUsers.set(ws as never, userId);
    if (opts.present !== false) s.awarenessOwners.set(d.clientID, ws);
    const sender: Sender = { layoutId: LAYOUT, userId, client: 't', noted: new Set(), pace: newPace(), crew: opts.crew ?? true };
    const sendBytes = (u: Uint8Array): string => {
      closed = '';
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      handleMessage(ws as unknown as WebSocket, s, encoding.toUint8Array(enc), role, sender);
      return closed;
    };
    return {
      d,
      ws,
      sender,
      /** Make an edit on their copy and send it; '' when taken, else the close reason. */
      edit(fn: (d: Y.Doc) => void): string {
        const sv = Y.encodeStateVector(d);
        d.transact(() => fn(d));
        return sendBytes(Y.encodeStateAsUpdate(d, sv));
      },
      sendBytes,
      /** Write as client `id` from now on (Yjs would pick a new id if their copy saw its own one come in). */
      writeAs(id: number) {
        d.clientID = id;
        if (opts.present !== false) s.awarenessOwners.set(id, ws);
      },
      /** Their copy catches up with the room. */
      sync() {
        Y.applyUpdate(d, Y.encodeStateAsUpdate(s.doc, Y.encodeStateVector(d)));
      },
    };
  };
  return { s, doc: s.doc, person };
}

const meta = (d: Y.Doc) => d.getMap('meta');
const rec = (d: Y.Doc, key: string, id: string) => (meta(d).get(key) as Y.Map<Y.Map<unknown>>).get(id)!;
const trains = (d: Y.Doc) => meta(d).get(TRAINS_KEY) as Y.Map<Y.Map<unknown>>;
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
/** The layout as text, the same whatever order its keys came in. */
const json = (d: Y.Doc) => JSON.stringify(sorted({ meta: d.getMap('meta').toJSON(), layerData: d.getMap('layerData').toJSON(), layers: d.getArray('layers').toJSON(), elsewhere: d.getMap('elsewhere').toJSON() }));
/** Opened again (a restart, someone joining): the same layout. */
const reopened = (d: Y.Doc) => {
  const again = new Y.Doc();
  Y.applyUpdate(again, Y.encodeStateAsUpdate(d));
  return json(again);
};
const logEntry = (id: string, by: string, more: object = {}) => new Y.Map<unknown>(Object.entries({ id, session: 's1', at: 2, by, kind: 'move', what: 'cut-can', from: null, to: null, note: '', ...more }));

/** Refused, and the layout is as it was, now and opened again. */
function refusedWhole(r: ReturnType<typeof room>, who: ReturnType<ReturnType<typeof room>['person']>, fn: (d: Y.Doc) => void) {
  const before = json(r.doc);
  const why = who.edit(fn);
  expect(why).toBe(OPS_REFUSED_REASON);
  expect(json(r.doc)).toBe(before);
  expect(reopened(r.doc)).toBe(before);
}
function taken(r: ReturnType<typeof room>, who: ReturnType<ReturnType<typeof room>['person']>, fn: (d: Y.Doc) => void) {
  expect(who.edit(fn)).toBe('');
  const a = json(r.doc);
  const b = json(who.d);
  if (a !== b) {
    let i = 0;
    while (a[i] === b[i]) i++;
    expect(a.slice(Math.max(0, i - 60), i + 30)).toBe(b.slice(Math.max(0, i - 60), i + 30));
  }
  expect(reopened(r.doc)).toBe(json(who.d));
}

describe('a viewer in the running session’s crew', () => {
  it('a crew moves their job’s train anywhere, and the cuts at their stops, and flips switches there', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    taken(r, vic, (d) => rec(d, TRAINS_KEY, 't-local').set('position', pos('B-far', 3)));
    taken(r, vic, (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 5)));
    taken(r, vic, (d) => rec(d, TRAINS_KEY, 'cut-mill').set('position', pos('B-mill', 2)));
    taken(r, vic, (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-can/0', 1));
    taken(r, vic, (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).delete('B-can/0'));
    taken(r, vic, (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'vic')));
  });

  it('a crew sets a car out (a new cut at a stop) and picks one up (coupled to their train)', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    taken(r, vic, (d) => {
      trains(d).set('cut-new', new Y.Map<unknown>(Object.entries(cut('cut-new', 'B-can', ['car4']))));
      rec(d, TRAINS_KEY, 't-local').set('units', []);
      rec(d, ROLLING_STOCK_KEY, 'car4').set('opsCut', 'cut-new');
    });
    taken(r, vic, (d) => {
      rec(d, TRAINS_KEY, 't-local').set('units', [{ stock: 'car2', reversed: false }]);
      rec(d, TRAINS_KEY, 'cut-can').set('units', []);
      rec(d, TRAINS_KEY, 'cut-can').set('emptiedAt', 5);
      rec(d, ROLLING_STOCK_KEY, 'car2').set('opsCut', 't-local');
    });
    taken(r, vic, (d) => trains(d).delete('cut-empty'));
  });

  it('a crew can’t touch another job’s cars, the main line’s or the yard’s, nor switches there', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    refusedWhole(r, vic, (d) => rec(d, TRAINS_KEY, 'cut-main').set('position', pos('B-main', 4)));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-yard').set('position', pos('B-yard1', 4)));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-main', 4)));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-main/0', 1));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-yard1/0', 1));
    // Taking another cut's car into their train.
    refusedWhole(r, r.person('vic', 'viewer'), (d) => rec(d, TRAINS_KEY, 't-local').set('units', [{ stock: 'car4', reversed: false }, { stock: 'car3', reversed: false }]));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => rec(d, ROLLING_STOCK_KEY, 'car3').set('opsCut', 't-local'));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => rec(d, ROLLING_STOCK_KEY, 'car4').set('opsCut', 'cut-main'));
    // A new cut made of a car that isn't theirs, or put where they can't reach.
    refusedWhole(r, r.person('vic', 'viewer'), (d) => trains(d).set('cut-x', new Y.Map<unknown>(Object.entries(cut('cut-x', 'B-can', ['car3'])))));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => trains(d).set('cut-x', new Y.Map<unknown>(Object.entries(cut('cut-x', 'B-main', ['car4'])))));
    // A cut with cars deleted; a train made, not a cut.
    refusedWhole(r, r.person('vic', 'viewer'), (d) => trains(d).delete('cut-can'));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => trains(d).set('t-x', new Y.Map<unknown>(Object.entries(cut('t-x', 'B-can', [], { cut: false })))));
    refusedWhole(r, r.person('vic', 'viewer'), (d) => trains(d).set('t-x', new Y.Map<unknown>(Object.entries({ ...cut('t-x', 'B-can', []), cut: undefined }).filter(([, v]) => v !== undefined))));
  });

  it('a yardmaster moves the yard’s cuts and flips its switches; a dispatcher, any', () => {
    const r = room();
    taken(r, r.person('yan', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-yard').set('position', pos('B-yard2', 4)));
    taken(r, r.person('yan', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-yard2/1', 2));
    refusedWhole(r, r.person('yan', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 4)));
    refusedWhole(r, r.person('yan', 'viewer'), (d) => rec(d, TRAINS_KEY, 't-local').set('position', pos('B-main', 4)));
    refusedWhole(r, r.person('yan', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-main/0', 1));
    taken(r, r.person('dan', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-main').set('position', pos('B-main', 9)));
    taken(r, r.person('dan', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-main/0', 1));
    taken(r, r.person('dan', 'viewer'), (d) => trains(d).delete('cut-yard'));
  });

  it('a crew whose job isn’t out, and someone not in the crew, move nothing', () => {
    const r = room();
    refusedWhole(r, r.person('wes', 'viewer'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-yard1/0', 1));
    refusedWhole(r, r.person('zed', 'viewer'), (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 4)));
  });

  it('nothing else: track, modules, places, waybills, jobs, sessions, layout settings, a car’s other fields, a nearby key', () => {
    const r = room();
    const edits: [string, (d: Y.Doc) => void][] = [
      ['a part', (d) => ((d.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).get(0).set('partNumber', '3001')],
      ['a sheet', (d) => d.getArray('layers').push([new Y.Map()])],
      ['a module', (d) => meta(d).set('cache', { schemaVersion: 1, bbmHashSha256: '', modules: [] })],
      ['a waybill', (d) => rec(d, WAYBILLS_KEY, 'w1').set('to1', 'pl-can')],
      ['a job’s status', (d) => rec(d, OPS_JOBS_KEY, 'j2').set('status', 'out')],
      ['the session’s crew', (d) => rec(d, OPS_SESSIONS_KEY, 's1').set('crew', [...CREW, { userId: 'zed', name: 'Z', role: 'dispatcher', places: [], job: '' }])],
      ['a session', (d) => (meta(d).get(OPS_SESSIONS_KEY) as Y.Map<unknown>).set('s2', new Y.Map([['status', 'running']]))],
      ['the train scale', (d) => meta(d).set('trainScale', 20)],
      ['a car’s name', (d) => rec(d, ROLLING_STOCK_KEY, 'car2').set('number', 'X')],
      ['a car’s load', (d) => rec(d, ROLLING_STOCK_KEY, 'car2').set('opsLoad', 'loaded')],
      ['where a car is, by place', (d) => rec(d, ROLLING_STOCK_KEY, 'car2').set('opsAt', 'pl-can')],
      ['a nearby field of a cut', (d) => rec(d, TRAINS_KEY, 'cut-can').set('positions', pos('B-can'))],
      ['a cut’s name', (d) => rec(d, TRAINS_KEY, 'cut-can').set('name', 'Mine')],
      ['a cut’s color', (d) => rec(d, TRAINS_KEY, 'cut-can').set('color', '#000000')],
      ['a cut no longer a cut', (d) => rec(d, TRAINS_KEY, 'cut-can').set('cut', false)],
      ['a field taken away', (d) => rec(d, TRAINS_KEY, 'cut-can').delete('position')],
      ['a nested value for a place', (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', new Y.Map(Object.entries(pos('B-can'))))],
      ['text for a switch', (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<unknown>).set('B-can/0', new Y.Text('1'))],
      ['the trains replaced', (d) => meta(d).set(TRAINS_KEY, new Y.Map())],
      ['the switches replaced', (d) => meta(d).set(SWITCH_STATES_KEY, new Y.Map())],
      ['the log replaced', (d) => meta(d).set(OPS_LOG_KEY, new Y.Map())],
      ['a key of its own', (d) => meta(d).set('opsCut', 'x')],
      ['a root of its own', (d) => d.getMap('elsewhere').set('x', 1)],
      ['a log entry in someone else’s name', (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'alice'))],
      ['a log entry with no author', (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', new Y.Map([['session', 's1']]))],
      ['a log entry for another session', (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'vic', { session: 's9' }))],
      ['a log entry changed', (d) => rec(d, OPS_LOG_KEY, 'log-1').set('note', 'x')],
      ['a log entry deleted', (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).delete('log-1')],
      ['a log entry put over another', (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-1', logEntry('log-1', 'vic'))],
    ];
    for (const [what, fn] of edits) {
      const before = json(r.doc);
      expect(r.person('vic', 'viewer').edit(fn), what).toBe(OPS_REFUSED_REASON);
      expect(json(r.doc), what).toBe(before);
      expect(reopened(r.doc), what).toBe(before);
    }
  });

  it('a whole edit that is partly allowed is refused whole', () => {
    const r = room();
    refusedWhole(r, r.person('vic', 'viewer'), (d) => {
      rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 4));
      rec(d, WAYBILLS_KEY, 'w1').set('to1', 'pl-can');
    });
  });
});

describe('when the session isn’t running, or the role is gone', () => {
  const move = (d: Y.Doc) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 6));
  it('no session, a paused one, an ended one: a viewer’s writes are refused', () => {
    for (const status of ['setup', 'paused', 'ended']) {
      const r = room(status);
      refusedWhole(r, r.person('vic', 'viewer'), move);
    }
  });

  it('a write made while it ran, landing after it ended or the role went, is refused', () => {
    for (const end of [
      (d: Y.Doc) => rec(d, OPS_SESSIONS_KEY, 's1').set('status', 'ended'),
      (d: Y.Doc) => rec(d, OPS_SESSIONS_KEY, 's1').set('status', 'paused'),
      (d: Y.Doc) => rec(d, OPS_SESSIONS_KEY, 's1').set('crew', CREW.filter((c) => c.userId !== 'vic')),
      (d: Y.Doc) => rec(d, OPS_JOBS_KEY, 'j1').set('status', 'done'),
      (d: Y.Doc) => rec(d, OPS_SESSIONS_KEY, 's1').set('layout', 'another'),
    ]) {
      const r = room();
      const vic = r.person('vic', 'viewer');
      // Vic's edit, made on their copy, not yet sent.
      const sv = Y.encodeStateVector(vic.d);
      vic.d.transact(() => move(vic.d));
      const queued = Y.encodeStateAsUpdate(vic.d, sv);
      expect(r.person('alice', 'owner').edit(end)).toBe('');
      const before = json(r.doc);
      expect(vic.sendBytes(queued)).toBe(OPS_REFUSED_REASON);
      expect(json(r.doc)).toBe(before);
    }
  });

  it('a read-only token or a suspended person (held to viewer) gets nothing: dropped as before', () => {
    const r = room();
    const vic = r.person('vic', 'viewer', { crew: false });
    const before = json(r.doc);
    expect(vic.edit(move)).toBe('');
    expect(json(r.doc)).toBe(before);
  });

  it('two sessions running: nobody gets crew rights, and a second can’t be started', () => {
    const r = room();
    const alice = r.person('alice', 'owner');
    refusedWhole(r, alice, (d) => (meta(d).get(OPS_SESSIONS_KEY) as Y.Map<unknown>).set('s2', new Y.Map(Object.entries(session('s2', 'running')))));
    // Two at once (an older server's room): no rights.
    const two = room();
    two.doc.transact(() => writeRecord(two.doc, OPS_SESSIONS_KEY, session('s2', 'running')));
    refusedWhole(two, two.person('dan', 'viewer'), move);
  });

  it('a session copied into another layout gives its crew nothing', () => {
    const r = room();
    r.doc.transact(() => writeRecord(r.doc, OPS_SESSIONS_KEY, { id: 's1', layout: 'the-original' }));
    refusedWhole(r, r.person('dan', 'viewer'), move);
  });
});

describe('how a viewer’s update arrives', () => {
  const move = (d: Y.Doc) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 6));
  it('out of order: the second of two edits, alone, is refused and nothing is held', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    const sv = Y.encodeStateVector(vic.d);
    vic.d.transact(() => move(vic.d));
    const sv2 = Y.encodeStateVector(vic.d);
    vic.d.transact(() => rec(vic.d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 7)));
    const second = Y.encodeStateAsUpdate(vic.d, sv2);
    const before = json(r.doc);
    expect(vic.sendBytes(second)).toBe(OPS_REFUSED_REASON);
    expect(json(r.doc)).toBe(before);
    expect(r.doc.store.pendingStructs).toBeNull();
    expect(r.s.held.count).toBe(0);
    // Both, in order, are taken.
    const both = r.person('vic', 'viewer', { clientId: vic.d.clientID });
    expect(both.sendBytes(Y.encodeStateAsUpdate(vic.d, sv))).toBe('');
  });

  it('a change left waiting before the session started can’t be landed by a viewer', () => {
    const r = room('paused');
    // An editor's change waits in the room for one it lacks.
    const ed = r.person('ed', 'editor');
    ed.d.transact(() => meta(ed.d).set('a', 1));
    const sv2 = Y.encodeStateVector(ed.d);
    ed.d.transact(() => meta(ed.d).set('b', 2));
    expect(ed.sendBytes(Y.encodeStateAsUpdate(ed.d, sv2))).toBe('');
    expect(r.doc.store.pendingStructs).not.toBeNull();
    r.doc.transact(() => writeRecord(r.doc, OPS_SESSIONS_KEY, { id: 's1', status: 'running' }));
    // A viewer forging the editor's missing change (same client) to land the rest.
    const vic = r.person('vic', 'viewer');
    vic.writeAs(ed.d.clientID);
    const before = json(r.doc);
    expect(vic.edit(move)).toBe(OPS_REFUSED_REASON);
    expect(json(r.doc)).toBe(before);
    expect(reopened(r.doc)).toBe(before);
  });

  it('two structs for one id: refused', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    const one = Y.encodeStateAsUpdate(vic.d, Y.encodeStateVector(vic.d));
    void one;
    const a = new Y.Doc();
    a.clientID = vic.d.clientID;
    Y.applyUpdate(a, Y.encodeStateAsUpdate(r.doc));
    const b = new Y.Doc();
    b.clientID = vic.d.clientID;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(r.doc));
    const sva = Y.encodeStateVector(a);
    a.transact(() => move(a));
    b.transact(() => rec(b, WAYBILLS_KEY, 'w1').set('to1', 'pl-can'));
    const ua = Y.encodeStateAsUpdate(a, sva);
    const ub = Y.encodeStateAsUpdate(b, sva);
    // One update carrying both blocks of one client at the same clock.
    const x = ua.subarray(1, ua.length - 1);
    const y = ub.subarray(1, ub.length - 1);
    for (const u of [new Uint8Array([2, ...x, ...y, 0]), new Uint8Array([2, ...y, ...x, 0])]) {
      if (!decodeIncoming(u)?.overlapping) continue;
      const before = json(r.doc);
      expect(vic.sendBytes(u)).toBe(OPS_REFUSED_REASON);
      expect(json(r.doc)).toBe(before);
      expect(reopened(r.doc)).toBe(before);
    }
  });

  it('one new cut written twice in one update: refused', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    const a = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(r.doc));
    a.clientID = vic.d.clientID;
    const sv = Y.encodeStateVector(a);
    a.transact(() => {
      trains(a).set('cut-new', new Y.Map<unknown>(Object.entries(cut('cut-new', 'B-can', []))));
      trains(a).set('cut-new', new Y.Map<unknown>(Object.entries({ ...cut('cut-new', 'B-can', []), cut: false })));
    });
    const before = json(r.doc);
    expect(vic.sendBytes(Y.encodeStateAsUpdate(a, sv))).toBe(OPS_REFUSED_REASON);
    expect(json(r.doc)).toBe(before);
  });

  it('another person’s client id, one the layout knows, or one without their presence: refused', () => {
    const r = room();
    const alice = r.person('alice', 'owner');
    expect(alice.edit((d) => rec(d, WAYBILLS_KEY, 'w1').set('to1', 'pl-can'))).toBe('');
    // Vic writing as Alice's client (the layout knows it; their presence isn't Vic's).
    const asAlice = r.person('vic', 'viewer', { present: false });
    asAlice.writeAs(alice.d.clientID);
    refusedWhole(r, asAlice, move);
    // With a presence of their own but a client the layout knows.
    const known = r.person('vic', 'viewer');
    known.writeAs(alice.d.clientID);
    refusedWhole(r, known, move);
    // A client another viewer claimed.
    const yan = r.person('yan', 'viewer');
    taken(r, yan, (d) => rec(d, TRAINS_KEY, 'cut-yard').set('position', pos('B-yard2', 2)));
    const stolen = r.person('dan', 'viewer');
    stolen.writeAs(yan.d.clientID);
    refusedWhole(r, stolen, move);
    // Their own, again (a new connection): fine.
    const again = r.person('yan', 'viewer');
    again.writeAs(yan.d.clientID);
    taken(r, again, (d) => rec(d, TRAINS_KEY, 'cut-yard').set('position', pos('B-yard2', 3)));
  });

  it('a stale copy: a viewer’s edit made on an old copy of a cut that has since left their reach', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    // The dispatcher moves the cannery's cut to the main line.
    expect(r.person('dan', 'viewer').edit((d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-main', 2)))).toBe('');
    refusedWhole(r, vic, (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 2)));
  });

  it('growth: a log entry too big, or more entries than the limit', () => {
    const r = room();
    const before = json(r.doc);
    const why = r.person('vic', 'viewer').edit((d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'vic', { note: 'x'.repeat(5000) })));
    expect(why).not.toBe('');
    expect(json(r.doc)).toBe(before);
  });

  it('a check that throws refuses (for a viewer, or while a session runs)', () => {
    const r = room();
    const vic = r.person('vic', 'viewer');
    const sv = Y.encodeStateVector(vic.d);
    vic.d.transact(() => move(vic.d));
    const decoded = decodeIncoming(Y.encodeStateAsUpdate(vic.d, sv))!;
    const boom = () => {
      throw new Error('boom');
    };
    expect(opsProblemSafe(r.doc, decoded, LAYOUT, { userId: 'vic', role: 'viewer', crew: true, ownsClient: boom, claims: new Map() })).toMatch(/can’t be checked/);
    expect(opsProblemSafe(r.doc, decoded, LAYOUT, { userId: 'ed', role: 'editor', crew: false, ownsClient: boom, claims: new Map() })).not.toBeNull();
  });
});

describe('everyone while a session runs', () => {
  const part = (d: Y.Doc) => ((d.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).get(0);
  it('the sheets are locked, the host’s and the owner’s too; paused, they aren’t', () => {
    const r = room();
    refusedWhole(r, r.person('alice', 'owner'), (d) => part(d).set('partNumber', '3001'));
    refusedWhole(r, r.person('ed', 'editor'), (d) => ((d.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<unknown>).delete(0));
    refusedWhole(r, r.person('ed', 'editor'), (d) => d.getArray('layers').push([new Y.Map()]));
    const paused = room('paused');
    taken(paused, paused.person('ed', 'editor'), (d) => part(d).set('partNumber', '3001'));
  });

  it('an editor who isn’t crew can’t move cars or flip switches; the host and the owner can; other edits go through', () => {
    const r = room();
    refusedWhole(r, r.person('ed', 'editor'), (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 6)));
    refusedWhole(r, r.person('ed', 'editor'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-can/0', 1));
    taken(r, r.person('ed', 'editor'), (d) => rec(d, WAYBILLS_KEY, 'w1').set('to1', 'pl-can'));
    taken(r, r.person('ed', 'editor'), (d) => rec(d, ROLLING_STOCK_KEY, 'car1').set('number', '42'));
    taken(r, r.person('alice', 'editor'), (d) => rec(d, TRAINS_KEY, 'cut-main').set('position', pos('B-main', 6)));
    taken(r, r.person('olga', 'owner'), (d) => (meta(d).get(SWITCH_STATES_KEY) as Y.Map<number>).set('B-main/0', 1));
    // An editor in the crew: their role's reach.
    taken(r, r.person('eve', 'editor'), (d) => rec(d, TRAINS_KEY, 'cut-can').set('position', pos('B-can', 8)));
    refusedWhole(r, r.person('eve', 'editor'), (d) => rec(d, TRAINS_KEY, 'cut-main').set('position', pos('B-main', 8)));
  });
});

describe('the log and the host, for everyone', () => {
  it('a log entry is by whoever sends it; it isn’t changed or deleted while its session is live', () => {
    const r = room();
    refusedWhole(r, r.person('alice', 'owner'), (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'vic')));
    taken(r, r.person('alice', 'owner'), (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-2', logEntry('log-2', 'alice')));
    refusedWhole(r, r.person('alice', 'owner'), (d) => rec(d, OPS_LOG_KEY, 'log-1').set('by', 'bob'));
    refusedWhole(r, r.person('alice', 'owner'), (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).delete('log-1'));
  });

  it('an ended session’s log goes with it, and its history can be brought in from a file', () => {
    const r = room('ended');
    taken(r, r.person('ed', 'editor'), (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).delete('log-1'));
    const f = room('ended');
    taken(f, f.person('ed', 'editor'), (d) => {
      (meta(d).get(OPS_SESSIONS_KEY) as Y.Map<unknown>).set('s-old', new Y.Map(Object.entries(session('s-old', 'ended', { host: '' }))));
      (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-9', logEntry('log-9', 'sam', { session: 's-old' }));
    });
    // …but not into a session that is live, nor one that ends later.
    refusedWhole(f, f.person('ed', 'editor'), (d) => (meta(d).get(OPS_LOG_KEY) as Y.Map<unknown>).set('log-10', logEntry('log-10', 'sam', { session: 's-new' })));
    refusedWhole(f, f.person('ed', 'editor'), (d) => rec(d, OPS_SESSIONS_KEY, 's1').set('status', 'running'));
  });

  it('whoever starts a session is its host', () => {
    const r = room('setup');
    refusedWhole(r, r.person('ed', 'editor'), (d) => rec(d, OPS_SESSIONS_KEY, 's1').set('status', 'running'));
    taken(r, r.person('ed', 'editor'), (d) => {
      rec(d, OPS_SESSIONS_KEY, 's1').set('status', 'running');
      rec(d, OPS_SESSIONS_KEY, 's1').set('host', 'ed');
    });
    refusedWhole(r, r.person('ed', 'editor'), (d) => rec(d, OPS_SESSIONS_KEY, 's1').set('host', 'alice'));
  });

  it('a layout with no sessions: an editor’s edits pay nothing and go through as before', () => {
    const r = room();
    taken(r, r.person('ed', 'editor'), (d) => rec(d, WAYBILLS_KEY, 'w1').set('to1', 'pl-can'));
  });
});
