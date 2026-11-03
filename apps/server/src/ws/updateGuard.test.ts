// The update guard: the shared vectors (fixtures/contracts/update-guard.json,
// the same file the desktop's UpdateGuard checks), every layout fixture as
// the server seeds it, and the updates the web writes while editing (moves,
// a paste of 1000 parts, deletions, unicode and emoji names, long names)
// all read as the apps read them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import { readBbm, readSidecar } from '@cld/bbm';
import { encodeDoc, seedFromBbm } from '@cld/ydoc';
import { MAX_NESTING, MAX_UPDATE_BYTES, checkStateVector, checkUpdate } from './updateGuard.js';
import { readZip } from '../test/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(ROOT, 'packages/bbm/tests/fixtures');

interface Vector {
  what: string;
  kind: 'update' | 'stateVector';
  hex: string;
  refused: boolean;
  contains?: string;
}
const contract = JSON.parse(readFileSync(join(ROOT, 'fixtures/contracts/update-guard.json'), 'utf8')) as {
  maxUpdateBytes: number;
  maxNesting: number;
  vectors: Vector[];
};

const check = (kind: Vector['kind'], bytes: Uint8Array) => (kind === 'update' ? checkUpdate(bytes) : checkStateVector(bytes));

/** Every file under `dir` ending in one of `exts`. */
function filesIn(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesIn(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out.sort();
}

/** A layout file as the server's create route seeds it (POST /api/layouts with bbm + sidecar). */
function seedLayoutFile(path: string): Y.Doc {
  const zip = readZip(readFileSync(path));
  const doc = seedFromBbm(readBbm(zip.get('layout.bbm')!.toString('utf8')).map);
  const sidecar = zip.get('sidecar.json');
  if (sidecar) doc.getMap('meta').set('cache', readSidecar(sidecar.toString('utf8')) as unknown as Record<string, unknown>);
  return doc;
}

function expectReadable(doc: Y.Doc, what: string): void {
  expect(checkUpdate(Y.encodeStateAsUpdate(doc)), what).toBeNull();
  expect(checkStateVector(Y.encodeStateVector(doc)), what).toBeNull();
  expect(checkUpdate(Y.encodeStateAsUpdate(doc, new Uint8Array([0]))), what).toBeNull();
}

describe('the update guard', () => {
  it('uses the limits the desktop uses', () => {
    expect(MAX_UPDATE_BYTES).toBe(contract.maxUpdateBytes);
    expect(MAX_NESTING).toBe(contract.maxNesting);
  });

  it('gives every shared vector the answer the desktop gives it', () => {
    expect(contract.vectors.length).toBeGreaterThanOrEqual(30);
    for (const v of contract.vectors) {
      const why = check(v.kind, Buffer.from(v.hex, 'hex'));
      if (v.refused) {
        expect(why, v.what).not.toBeNull();
        if (v.contains) expect(why, v.what).toContain(v.contains);
      } else {
        expect(why, v.what).toBeNull();
      }
    }
  });

  it('passes vectors the web Yjs reads, and they apply', () => {
    for (const v of contract.vectors.filter((x) => !x.refused && x.kind === 'update')) {
      expect(() => Y.applyUpdate(new Y.Doc(), Buffer.from(v.hex, 'hex')), v.what).not.toThrow();
    }
  });

  it('refuses anything over the size limit, quickly', () => {
    const big = new Uint8Array(MAX_UPDATE_BYTES + 1);
    expect(checkUpdate(big)).toContain('limit');
    expect(checkStateVector(big)).toContain('limit');
    // A value nested 100 000 deep is refused without recursing.
    // (meta.x = [[[…null…]]]: one client, one block of values, as in the vectors.)
    const head = Buffer.concat([Buffer.from([1, 1, 7, 0, 8 | 0x20, 1, 4]), Buffer.from('meta'), Buffer.from([1, 0x78, 1])]);
    const deep = Buffer.concat([head, Buffer.from('\x75\x01'.repeat(100_000), 'latin1'), Buffer.from([0x7e, 0])]);
    const t = performance.now();
    expect(checkUpdate(deep)).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('passes every layout fixture as the server seeds it (.bbm, .bld-layout)', () => {
    const bbms = filesIn(FIXTURES, ['.bbm']);
    const files = filesIn(FIXTURES, ['.bld-layout']);
    expect(bbms.length).toBeGreaterThanOrEqual(15);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const path of bbms) expectReadable(seedFromBbm(readBbm(readFileSync(path, 'utf8')).map), path);
    for (const path of files) expectReadable(seedLayoutFile(path), path);
  });

  it('passes the updates the web writes while editing a large layout', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeDoc(seedFromBbm(readBbm(readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8')).map)));
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const before = Y.encodeStateVector(doc);
    const layerData = doc.getMap<Y.Map<unknown>>('layerData');
    const bricks = [...layerData.values()]
      .map((l) => l.get('bricks'))
      .filter((b): b is Y.Array<Y.Map<unknown>> => b instanceof Y.Array)
      .sort((a, b) => b.length - a.length)[0]!;
    expect(bricks.length).toBeGreaterThan(300);
    // Moves and turns.
    for (let i = 0; i < 50; i++) {
      doc.transact(() => {
        const b = bricks.get(i);
        b.set('displayArea', { x: i * 8, y: 16.5, width: 32, height: 32 });
        b.set('orientation', (i * 22.5) % 360);
      });
    }
    // A paste of 1000 parts with unicode, emoji and long names.
    doc.transact(() => {
      const pasted: Y.Map<unknown>[] = [];
      for (let i = 0; i < 1000; i++) {
        const y = new Y.Map<unknown>();
        y.set('id', `pasted-${i}-ü✓😀日本`);
        y.set('displayArea', { x: i, y: -i, width: 8, height: 16 });
        y.set('myGroup', null);
        y.set('partNumber', i % 2 ? '3001.1' : 'custom:Zürich-Bahnhof-🚂');
        y.set('orientation', 0);
        y.set('activeConnectionPointIndex', 0);
        y.set('altitude', 0);
        y.set('connexions', [{ id: `c${i}`, linkedTo: null }]);
        pasted.push(y);
      }
      bricks.push(pasted);
    });
    const meta = doc.getMap('meta');
    meta.set('event', 'Fordyce 2026 — Großer Bahnhof 🚉 مرحبا '.repeat(100));
    meta.set('comment', 'x'.repeat(100_000));
    // Deletions (and an undo of them).
    const undo = new Y.UndoManager(bricks);
    bricks.delete(10, 200);
    undo.undo();
    expect(updates.length).toBeGreaterThan(50);
    for (const u of updates) expect(checkUpdate(u)).toBeNull();
    // What an offline session sends on reconnect (one step 2), and a merged backlog.
    expect(checkUpdate(Y.encodeStateAsUpdate(doc, before))).toBeNull();
    expect(checkUpdate(Y.mergeUpdates(updates))).toBeNull();
    expectReadable(doc, 'the edited layout');
  });

  it('passes deletions as the apps write them: many ranges, many editors, any order of deleting', () => {
    const editors = [1, 2, 3].map((id) => {
      const d = new Y.Doc();
      d.clientID = id;
      return d;
    });
    const room = new Y.Doc();
    const relayed: Uint8Array[] = [];
    room.on('update', (u: Uint8Array) => relayed.push(u));
    for (const d of editors) {
      d.getArray('parts').push([...Array(200).keys()].map((i) => `${d.clientID}-${i}`));
      Y.applyUpdate(room, Y.encodeStateAsUpdate(d));
    }
    for (const d of editors) Y.applyUpdate(d, Y.encodeStateAsUpdate(room));
    const before = Y.encodeStateVector(room);
    const sent: Uint8Array[] = [];
    for (const d of editors) {
      d.on('update', (u: Uint8Array) => sent.push(u));
      const parts = d.getArray('parts');
      // Every other part, from the end backwards, then a run from the front, in one transaction.
      d.transact(() => {
        for (let i = parts.length - 1; i >= 0; i -= 2) parts.delete(i, 1);
        parts.delete(0, 5);
      });
    }
    for (const u of sent) {
      expect(checkUpdate(u)).toBeNull();
      Y.applyUpdate(room, u);
    }
    for (const u of relayed) expect(checkUpdate(u)).toBeNull();
    expect(checkUpdate(Y.mergeUpdates(sent))).toBeNull();
    expect(checkUpdate(Y.encodeStateAsUpdate(room, before))).toBeNull();
    expectReadable(room, 'the room after the deletions');
  });

  it('passes a layout the desktop wrote (yrs)', () => {
    const bytes = new Uint8Array(readFileSync(join(ROOT, 'apps/server/fuzz/seeds/desktop-tight-corner.ydoc')));
    expect(checkUpdate(bytes)).toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    expectReadable(doc, 'the desktop layout');
  });

  it('refuses what Yjs would read but couldn\'t write back for the desktop', () => {
    // JSON content (Yjs reads `count` strings, yrs one more): a root entry
    // of the old JSON kind, as yrs would read it (count 0, one string).
    const json = Buffer.from('0101010002' + '0104' + Buffer.from('meta').toString('hex') + '00' + '00' + '00', 'hex');
    expect(checkUpdate(json)).toContain('JSON');
    // An item of no content: no values, an empty string, a deletion of 0.
    for (const [ref, body] of [
      [8, '00'],
      [4, '00'],
      [1, '00'],
    ] as const) {
      const empty = Buffer.from(`01010100${(ref | 0x20).toString(16).padStart(2, '0')}0104${Buffer.from('meta').toString('hex')}0178${body}00`, 'hex');
      expect(checkUpdate(empty), `content ${ref}`).toContain('empty block');
    }
    // Deleted ranges: empty, out of order, one client listed twice.
    expect(checkUpdate(Buffer.from('00' + '01' + '07' + '01' + '0500', 'hex'))).toContain('empty range');
    expect(checkUpdate(Buffer.from('00' + '01' + '07' + '02' + '0a01' + '0501', 'hex'))).toContain('out of order');
    expect(checkUpdate(Buffer.from('00' + '02' + '07' + '01' + '0501' + '07' + '01' + '0a01', 'hex'))).toContain('twice');
  });

  it('refuses a client id past 2^53 - 1, wherever it is, and takes one up to it', () => {
    const bytes = (write: (e: encoding.Encoder) => void) => {
      const e = encoding.createEncoder();
      write(e);
      return encoding.toUint8Array(e);
    };
    for (const [client, refused] of [
      [Number.MAX_SAFE_INTEGER, false],
      [2 ** 53, true],
      [2 ** 60, true],
    ] as const) {
      const v = (e: encoding.Encoder) => encoding.writeVarUint(e, client);
      // A block's client: one GC block of length 1.
      const block = bytes((e) => {
        [1, 1].forEach((n) => encoding.writeVarUint(e, n));
        v(e);
        [0, 0, 1, 0].forEach((n) => encoding.writeVarUint(e, n)); // clock 0, GC, length 1, no deletions
      });
      // The parent an item is in: (client, clock 0).
      const parent = bytes((e) => {
        [1, 1, 5, 0, 8, 0].forEach((n) => encoding.writeVarUint(e, n)); // client 5, clock 0: values in the type with id…
        v(e);
        [0, 1, 0x7e, 0].forEach((n) => encoding.writeVarUint(e, n)); // …(client, 0): one null; no deletions
      });
      const deleted = bytes((e) => {
        [0, 1].forEach((n) => encoding.writeVarUint(e, n));
        v(e);
        [1, 5, 1].forEach((n) => encoding.writeVarUint(e, n));
      });
      const sv = bytes((e) => {
        encoding.writeVarUint(e, 1);
        v(e);
        encoding.writeVarUint(e, 3);
      });
      for (const [what, why] of [
        ['block', checkUpdate(block)],
        ['parent', checkUpdate(parent)],
        ['deleted', checkUpdate(deleted)],
        ['state vector', checkStateVector(sv)],
      ] as const) {
        if (refused) expect(why, `${what} ${client}`).toContain('client id');
        else expect(why, `${what} ${client}`).toBeNull();
      }
    }
  });
});
