// The work Yjs does to apply an update (yjsWork.ts): every update the apps
// make, however big (a first sync, deleting a whole layout, a paste of
// 1000 parts, a long offline session, a 5,000-part layout), stays far
// inside the limit; a delete set listing the same range many times, or
// ranges and inserts that split one long struct many times, is past it.

import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { describe, expect, it, vi } from 'vitest';
import { readBbm } from '@cld/bbm';
import type { BbmMap, LayerBrick } from '@cld/model';
import { seedFromBbm } from '@cld/ydoc';
import { decodeIncoming } from './decoded.js';
import { MAX_UPDATE_WORK, applyStoredUpdate, checkUpdateWork, snapshotWork, yjsWork } from './yjsWork.js';

const fordyceText = readFileSync(new URL('../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm', import.meta.url), 'utf8');
const work = (doc: Y.Doc | null, update: Uint8Array) => yjsWork(doc, decodeIncoming(update)!);

/** Fordyce (940 parts), or its parts copied until there are at least `parts`. */
function layout(parts = 0): Y.Doc {
  const map = readBbm(fordyceText).map;
  const bricks = map.layers.filter((l): l is LayerBrick => l.type === 'brick');
  const count = () => bricks.reduce((n, l) => n + l.bricks.length, 0);
  const base = bricks.map((l) => [...l.bricks]);
  for (let copy = 1; count() < parts; copy++) {
    bricks.forEach((l, i) => l.bricks.push(...base[i]!.map((b) => ({ ...b, id: `${b.id}-${copy}`, displayArea: { ...b.displayArea, x: b.displayArea.x + copy * 500 } }))));
  }
  return seedFromBbm(map as BbmMap);
}

/** An editor in sync with `doc`, and what it does from here on. */
function editorOf(doc: Y.Doc): { ed: Y.Doc; since: () => Uint8Array } {
  const ed = new Y.Doc();
  Y.applyUpdate(ed, Y.encodeStateAsUpdate(doc));
  const sv = Y.encodeStateVector(doc);
  return { ed, since: () => Y.encodeStateAsUpdate(ed, sv) };
}

/** A delete set only: `ranges` of `client`. */
function deletes(client: number, ranges: [number, number][]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, ranges.length);
  for (const [clock, len] of ranges) {
    encoding.writeVarUint(e, clock);
    encoding.writeVarUint(e, len);
  }
  return encoding.toUint8Array(e);
}

describe('what the apps send', () => {
  for (const parts of [0, 5000]) {
    const name = parts ? 'a 5,000-part layout' : 'Fordyce (940 parts)';
    it(`stays far inside the limit on ${name}`, () => {
      const doc = layout(parts);
      const limit = MAX_UPDATE_WORK / 20;
      // The whole document, as a first sync or a snapshot.
      const all = Y.encodeStateAsUpdate(doc);
      expect(work(null, all)).toBeLessThan(limit);
      expect(work(new Y.Doc(), all)).toBeLessThan(limit);
      expect(snapshotWork(all)).toBeNull();

      // Every layer deleted.
      const whole = editorOf(doc);
      whole.ed.transact(() => {
        const data = whole.ed.getMap('layerData');
        for (const k of [...data.keys()]) data.delete(k);
        const order = whole.ed.getArray('layers');
        order.delete(0, order.length);
      });
      expect(work(doc, whole.since())).toBeLessThan(limit);

      // Every part of one sheet deleted, one at a time as a selection is.
      const sheet = [...doc.getMap<Y.Map<unknown>>('layerData').values()].find((l) => l.get('type') === 'brick')!;
      const sheetId = [...doc.getMap<Y.Map<unknown>>('layerData').entries()].find(([, l]) => l === sheet)![0];
      const picked = editorOf(doc);
      picked.ed.transact(() => {
        const bricks = picked.ed.getMap<Y.Map<unknown>>('layerData').get(sheetId)!.get('bricks') as Y.Array<unknown>;
        for (let i = bricks.length - 1; i >= 0; i -= 2) bricks.delete(i, 1);
      });
      expect(work(doc, picked.since())).toBeLessThan(limit);

      // A paste of 1000 parts, then 2,000 edits made offline.
      const offline = editorOf(doc);
      const bricks = () => offline.ed.getMap<Y.Map<unknown>>('layerData').get(sheetId)!.get('bricks') as Y.Array<Y.Map<unknown>>;
      offline.ed.transact(() => {
        for (let i = 0; i < 1000; i++) {
          const b = new Y.Map<unknown>();
          b.set('id', `paste-${i}`);
          b.set('partNumber', '3001.1');
          b.set('displayArea', { x: i, y: 0, width: 32, height: 16 });
          bricks().push([b]);
        }
      });
      expect(work(doc, offline.since())).toBeLessThan(limit);
      for (let i = 0; i < 2000; i++) bricks().get(i % bricks().length).set('displayArea', { x: i, y: 1, width: 32, height: 16 });
      for (let i = 0; i < 300; i++) bricks().delete((i * 7) % bricks().length, 1);
      expect(work(doc, offline.since())).toBeLessThan(limit);
    }, 120_000);
  }
});

describe('an update past the limit', () => {
  it('lists one range many times', () => {
    const doc = layout();
    const [client, list] = [...doc.store.clients.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
    const state = Y.getState(doc.store, client);
    expect(list.length).toBeGreaterThan(1000);
    const once = deletes(client, [[0, state]]);
    expect(work(doc, once)).toBeLessThan(MAX_UPDATE_WORK / 100);
    const many = deletes(client, Array.from({ length: 2000 }, () => [0, state] as [number, number]));
    expect(checkUpdateWork(doc, decodeIncoming(many)!)).toMatch(/more than/);
  });

  it('splits one long struct many times, by deletions or by inserts', () => {
    const doc = layout();
    const a = new Y.Doc();
    a.clientID = 31337;
    Y.applyUpdate(a, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(a);
    a.getArray('notes').push(Array.from({ length: 50_000 }, () => 0));
    const long = Y.encodeStateAsUpdate(a, sv);
    expect(work(doc, long)).toBeLessThan(MAX_UPDATE_WORK / 100);
    Y.applyUpdate(doc, long);
    // Deleting a few values of it, here and there, is fine; every other one is not.
    expect(work(doc, deletes(31337, [[10, 5], [40_000, 3]]))).toBeLessThan(MAX_UPDATE_WORK / 10);
    const every = deletes(31337, Array.from({ length: 2000 }, (_, i) => [i * 2, 1] as [number, number]));
    expect(checkUpdateWork(doc, decodeIncoming(every)!)).toMatch(/more than/);
    // Inserting between its values, one place each, the same.
    const b = new Y.Doc();
    b.clientID = 4040;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(doc));
    const svb = Y.encodeStateVector(b);
    b.transact(() => {
      const notes = b.getArray('notes');
      for (let i = 0; i < 2000; i++) notes.insert(1 + i * 3, ['x']);
    });
    expect(checkUpdateWork(doc, decodeIncoming(Y.encodeStateAsUpdate(b, svb))!)).toMatch(/more than/);
    // A few inserts are fine.
    const c = new Y.Doc();
    c.clientID = 4041;
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    const svc = Y.encodeStateVector(c);
    c.getArray('notes').insert(25_000, ['y']);
    expect(work(doc, Y.encodeStateAsUpdate(c, svc))).toBeLessThan(MAX_UPDATE_WORK / 10);
  });

  it('is skipped, and logged, when a layout is read back from its update log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = layout();
    const [client, list] = [...doc.store.clients.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
    const state = Y.getState(doc.store, client);
    const stored = deletes(client, Array.from({ length: 40_000 }, () => [0, state] as [number, number]));
    const started = performance.now();
    expect(applyStoredUpdate(doc, stored, 'layout test')).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped a stored update'));
    // Nothing of it was applied.
    expect(list.some((s) => s instanceof Y.Item && s.deleted && s.parentSub === 'gridSizeInStud')).toBe(false);
    // An ordinary one is applied.
    const { ed, since } = editorOf(doc);
    ed.getMap('meta').set('comment', 'kept');
    expect(applyStoredUpdate(doc, since(), 'layout test')).toBe(true);
    expect(doc.getMap('meta').get('comment')).toBe('kept');
    warn.mockRestore();
  });
});

describe('two blocks of one client that overlap', () => {
  // Found by the Fuzz workflow (fuzz/regressions/guard/crash-3d25a531…): a
  // short block and a ~2^30-clock one for the same client, and a delete
  // range over both. Counted on the short block it looked cheap; Yjs keeps
  // the long one, and the document it leaves cost the desktop 2^30 steps.
  const update = Uint8Array.from(Buffer.from('AwF6AQCw4nYAAAMBeiQA/////wMBegEA4gA=', 'base64'));

  it('counts the delete range on every block it touches, so the update is refused', () => {
    const decoded = decodeIncoming(update)!;
    expect(decoded.overlapping).toBe(true);
    expect(yjsWork(null, decoded)).toBeGreaterThan(MAX_UPDATE_WORK);
    expect(checkUpdateWork(null, decoded)).toMatch(/steps, more than/);
  });

  it('leaves updates without overlapping blocks counted as before', () => {
    const doc = new Y.Doc();
    doc.getMap('m').set('a', 'x'.repeat(50));
    const u = Y.encodeStateAsUpdate(doc);
    expect(decodeIncoming(u)!.overlapping).toBe(false);
    expect(work(null, u)).toBeLessThan(10);
  });
});

describe('a deleted range that starts where the update has nothing', () => {
  // Found by fuzzing (fuzz/regressions/guard/deleted-range-across-a-gap).
  const update = Uint8Array.from(Buffer.from('AwF6AAABAOIAAAF6JAD///8DAXoBA0FBcg==', 'base64'));

  it('counts the block it ends inside, as when it starts inside one', () => {
    expect(yjsWork(null, decodeIncoming(update)!)).toBeGreaterThan(MAX_UPDATE_WORK);
    // What the update makes is never counted dearer than twice the update.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    expect(yjsWork(null, decodeIncoming(Y.encodeStateAsUpdate(doc))!)).toBeLessThanOrEqual(2 * yjsWork(null, decodeIncoming(update)!));
  });
});
