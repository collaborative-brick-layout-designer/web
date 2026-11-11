// The module part keys the server takes (ws/memberGuard.ts): what the apps
// write passes, a key or value no app makes is refused, on a live update
// and in a whole document.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { memberKey, readSidecarCache, repairSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { decodeIncoming } from './decoded.js';
import { memberKeyProblem, snapshotMemberKeyProblem } from './memberGuard.js';
import { checkUpdate } from './updateGuard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const contract = JSON.parse(readFileSync(join(ROOT, 'fixtures/contracts/module-members.json'), 'utf8')) as {
  keys: { key: string }[];
  badKeys: string[];
  values: { value: unknown; valid: boolean }[];
};

type Mod = { id: string; name: string; members: string[] };
const sidecar = { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm1', name: 'Yard', members: ['a', 'b'] }] };

/** The room's document: a layout with one module. */
function room(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', 1);
  doc.transact(() => writeSidecarCache(doc, sidecar));
  return doc;
}
/** Someone who has the room's layout. */
function client(of: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(of));
  return doc;
}
/** What `edit` writes on `doc`, as the update the server gets. */
function updateOf(doc: Y.Doc, edit: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  // (With what it deletes: encodeStateAsUpdate carries the whole delete set.)
  const updates: Uint8Array[] = [];
  const on = (u: Uint8Array) => updates.push(u);
  doc.on('update', on);
  edit();
  doc.off('update', on);
  return updates.length > 0 ? Y.mergeUpdates(updates) : Y.encodeStateAsUpdate(doc, before);
}
const problem = (server: Y.Doc | null, update: Uint8Array): string | null => {
  // Only what the byte check lets through gets this far.
  expect(checkUpdate(update)).toBeNull();
  return memberKeyProblem(server, decodeIncoming(update)!);
};
const setModule = (doc: Y.Doc, f: (m: Mod) => Mod) =>
  doc.transact(() => {
    const cache = readSidecarCache(doc)!;
    writeSidecarCache(doc, { ...cache, modules: (cache.modules as Mod[]).map(f) });
  });

describe('what the apps write passes', () => {
  it('a part added, a part taken out, put back, and the stamp', () => {
    const server = room();
    const c = client(server);
    const take = (u: Uint8Array) => {
      expect(problem(server, u)).toBeNull();
      Y.applyUpdate(server, u);
    };
    take(updateOf(c, () => setModule(c, (m) => ({ ...m, members: [...m.members, 'c', 'd'] }))));
    take(updateOf(c, () => setModule(c, (m) => ({ ...m, members: m.members.filter((x) => x !== 'a' && x !== 'c') }))));
    take(updateOf(c, () => setModule(c, (m) => ({ ...m, members: ['a', 'b', 'c', 'd'] }))));
    // Replacing a key's value (its key comes from the value it replaces, in the room).
    take(updateOf(c, () => c.getMap('sidecarItems').set(memberKey('m1', 'd'), 7)));
    take(updateOf(c, () => c.getMap('sidecarItems').set(memberKey('m1', 'd'), false)));
    take(updateOf(c, () => setModule(c, (m) => ({ ...m, name: 'Harbour' }))));
    take(updateOf(c, () => repairSidecarCache(c, 'repair')));
    expect((readSidecarCache(server)!.modules as Mod[])[0]).toEqual((readSidecarCache(c)!.modules as Mod[])[0]);
    expect(server.getMap('meta').get('schemaVersion')).toBe(3);
  });

  it('undo and redo of a part change', () => {
    const server = room();
    const c = client(server);
    const undo = new Y.UndoManager([c.getMap('meta'), c.getMap('sidecarItems')], { captureTimeout: 0 });
    for (const edit of [
      () => setModule(c, (m) => ({ ...m, members: ['b', 'c'] })),
      () => undo.undo(),
      () => undo.redo(),
      () => undo.undo(),
    ]) {
      const u = updateOf(c, edit);
      expect(problem(server, u)).toBeNull();
      Y.applyUpdate(server, u);
    }
    expect((readSidecarCache(server)!.modules as Mod[])[0]!.members).toEqual(['a', 'b']);
  });

  it('every key and valid value of the shared vectors, live and as a whole document', () => {
    const server = room();
    const c = client(server);
    const u = updateOf(c, () =>
      c.transact(() => {
        for (const { key } of contract.keys) for (const v of contract.values) if (v.valid) c.getMap('sidecarItems').set(key, v.value);
      }),
    );
    expect(problem(server, u)).toBeNull();
    expect(snapshotMemberKeyProblem(Y.encodeStateAsUpdate(c))).toBeNull();
  });

  it('a whole layout with part keys, and an offline session sent in one go', () => {
    const server = room();
    const c = client(server);
    setModule(c, (m) => ({ ...m, members: [...m.members, 'c'] }));
    setModule(c, (m) => ({ ...m, members: m.members.filter((x) => x !== 'b') }));
    setModule(c, (m) => ({ ...m, members: [...m.members, 'e'] }));
    expect(problem(server, Y.encodeStateAsUpdate(c, Y.encodeStateVector(server)))).toBeNull();
    expect(snapshotMemberKeyProblem(Y.encodeStateAsUpdate(c))).toBeNull();
  });

  it('other maps and other keys are not looked at', () => {
    const server = room();
    const c = client(server);
    const u = updateOf(c, () =>
      c.transact(() => {
        c.getMap('meta').set('p:2:m1:x', 'anything');
        c.getMap('sidecarItems').set('q:2:m1:x', 'anything');
        const budget = new Y.Map<unknown>();
        c.getMap('meta').set('budgetLimits', budget);
        budget.set('p:nonsense', 4);
      }),
    );
    expect(problem(server, u)).toBeNull();
  });
});

describe('what no app writes is refused', () => {
  const badValues: [string, () => unknown][] = [
    ...contract.values.filter((v) => !v.valid).map((v): [string, () => unknown] => [JSON.stringify(v.value), () => v.value]),
    ['a nested map', () => new Y.Map()],
    ['a nested list', () => new Y.Array()],
    ['bytes', () => new Uint8Array([1, 2])],
  ];

  for (const [what, value] of badValues) {
    it(`a part key holding ${what}: a new key, a replaced one, and in a whole document`, () => {
      const server = room();
      const c = client(server);
      const fresh = updateOf(c, () => c.getMap('sidecarItems').set(memberKey('m1', 'zz'), value()));
      expect(problem(server, fresh)).toMatch(/module's part/);
      expect(snapshotMemberKeyProblem(Y.encodeStateAsUpdate(c))).toMatch(/module's part/);
      // Replacing a good value the room has.
      const d = client(server);
      const good = updateOf(d, () => setModule(d, (m) => ({ ...m, members: [...m.members, 'c'] })));
      Y.applyUpdate(server, good);
      const replaced = updateOf(d, () => d.getMap('sidecarItems').set(memberKey('m1', 'c'), value()));
      expect(problem(server, replaced)).toMatch(/module's part/);
    });
  }

  it('a good value replaced by a bad one in the same update (the key comes from the update itself)', () => {
    const server = room();
    const c = client(server);
    const u = updateOf(c, () =>
      c.transact(() => {
        c.getMap('sidecarItems').set(memberKey('m1', 'c'), 1);
      }),
    );
    const v = updateOf(c, () => c.getMap('sidecarItems').set(memberKey('m1', 'c'), 'x'));
    expect(problem(server, Y.mergeUpdates([u, v]))).toMatch(/module's part/);
  });

  it('a key that names no module and part', () => {
    for (const key of contract.badKeys) {
      const server = room();
      const c = client(server);
      const u = updateOf(c, () => c.getMap('sidecarItems').set(key, 0));
      expect(problem(server, u), key).toMatch(/names no module/);
    }
  });

  it('a bad value the same update deletes is let through: nobody reads it', () => {
    const server = room();
    const c = client(server);
    const u = updateOf(c, () =>
      c.transact(() => {
        c.getMap('sidecarItems').set(memberKey('m1', 'zz'), 'x');
        c.getMap('sidecarItems').delete(memberKey('m1', 'zz'));
      }),
    );
    expect(problem(server, u)).toBeNull();
  });

  it('a refused update leaves the room as it was', () => {
    const server = room();
    const before = Y.encodeStateAsUpdate(server);
    const c = client(server);
    const u = updateOf(c, () => c.getMap('sidecarItems').set(memberKey('m1', 'zz'), true));
    expect(problem(server, u)).not.toBeNull();
    expect(Y.encodeStateAsUpdate(server)).toEqual(before);
  });
});
