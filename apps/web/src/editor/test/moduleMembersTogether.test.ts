// Two people changing one module's parts at the same instant, with the
// editor's own edits (mutations.ts) and its undo: each part added or taken
// out is a key of its own in the shared layout (@cld/ydoc moduleMembers.ts),
// so both changes stay. Each case runs with the two people's client ids
// both ways round: Yjs breaks a tie by them.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, exportSidecarFromDoc, readSidecarCache, removeDuplicateItems, repairSidecarCache, stampMemberKeys } from '@cld/ydoc';
import {
  createSidecarModule,
  deleteBricks,
  deleteSidecarModule,
  ensureBrickLayer,
  placeBrick,
  renameSidecarModule,
  setSidecarModuleMembers,
} from '../mutations';
import { createUndoManager } from '../useUndoManager';

interface Mod {
  id: string;
  name: string;
  members: string[];
}
const brick = { partNumber: '3001.1', width: 4, height: 2 };

function sync(a: Y.Doc, b: Y.Doc): void {
  const sa = Y.encodeStateVector(a);
  const sb = Y.encodeStateVector(b);
  const ua = Y.encodeStateAsUpdate(a, sb);
  const ub = Y.encodeStateAsUpdate(b, sa);
  Y.applyUpdate(b, ua, 'remote');
  Y.applyUpdate(a, ub, 'remote');
}
/** Everyone hears everything, and each editor does what it does after someone else's change (useLayoutDoc.ts). */
function settle(a: Y.Doc, b: Y.Doc): void {
  for (let round = 0; round < 3; round++) {
    sync(a, b);
    for (const d of [a, b]) {
      repairSidecarCache(d, 'repair');
      stampMemberKeys(d);
      removeDuplicateItems(d, 'repair');
    }
  }
  sync(a, b);
}
const mod = (d: Y.Doc): Mod | undefined => ((readSidecarCache(d)?.modules ?? []) as Mod[])[0];
const members = (d: Y.Doc): string[] => [...(mod(d)?.members ?? [])].sort();
const cached = (d: Y.Doc): string[] => [...(((d.getMap('meta').get('cache') as { modules?: Mod[] }).modules ?? [])[0]?.members ?? [])].sort();

interface Scene {
  a: Y.Doc;
  b: Y.Doc;
  L: string;
  M: string;
  /** Five parts on the map; the module holds the first two. */
  p: string[];
}
function scene(aFirst: boolean): Scene {
  const a = createDefaultLayoutDoc();
  a.clientID = aFirst ? 1001 : 2002;
  const L = ensureBrickLayer(a);
  const p = [0, 1, 2, 3, 4].map((i) => placeBrick(a, L, { ...brick, x: i * 8, y: 0 }));
  const M = createSidecarModule(a, 'Yard', [p[0]!, p[1]!])!;
  const b = new Y.Doc();
  b.clientID = aFirst ? 2002 : 1001;
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  return { a, b, L, M, p };
}
const add = (d: Y.Doc, M: string, ...ids: string[]) => setSidecarModuleMembers(d, M, [...mod(d)!.members, ...ids]);
const takeOut = (d: Y.Doc, M: string, ...ids: string[]) => setSidecarModuleMembers(d, M, mod(d)!.members.filter((x) => !ids.includes(x)));

const both = (name: string, run: (s: Scene) => void): void => {
  for (const aFirst of [true, false]) {
    it(`${name} (${aFirst ? 'the first' : 'the second'} person has the lower client id)`, () => {
      const s = scene(aFirst);
      run(s);
      // Whatever happened: both show the same module, and so does the copy the desktop and the files read.
      expect(mod(s.b)).toEqual(mod(s.a));
      expect(cached(s.a)).toEqual(members(s.a));
      expect(cached(s.b)).toEqual(members(s.a));
    });
  }
};

describe('one module, two people, the same instant', () => {
  both('each adds a part: both are in the module', ({ a, b, M, p }) => {
    add(a, M, p[2]!);
    add(b, M, p[3]!);
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[1], p[2], p[3]].sort());
  });

  both('one adds a part, the other takes one out: both happen', ({ a, b, M, p }) => {
    add(a, M, p[2]!);
    takeOut(b, M, p[0]!);
    settle(a, b);
    expect(members(a)).toEqual([p[1], p[2]].sort());
  });

  both('one deletes a part of the module from the map, the other adds one', ({ a, b, L, M, p }) => {
    deleteBricks(a, L, [p[1]!]);
    add(b, M, p[4]!);
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[4]].sort());
  });

  both('one renames it, the other adds a part and takes one out', ({ a, b, M, p }) => {
    renameSidecarModule(a, M, 'Harbour');
    add(b, M, p[3]!);
    takeOut(b, M, p[1]!);
    settle(a, b);
    expect(mod(a)!.name).toBe('Harbour');
    expect(members(a)).toEqual([p[0], p[3]].sort());
  });

  both('the layout is stamped shape 3 once a part changes, and not before', ({ a, b, M, p }) => {
    renameSidecarModule(a, M, 'Harbour');
    settle(a, b);
    expect(a.getMap('meta').get('schemaVersion')).toBe(1);
    add(b, M, p[3]!);
    settle(a, b);
    expect(a.getMap('meta').get('schemaVersion')).toBe(3);
    expect(b.getMap('meta').get('schemaVersion')).toBe(3);
  });

  both('the file it saves lists every part, as before', ({ a, b, M, p }) => {
    add(a, M, p[2]!);
    takeOut(b, M, p[0]!);
    settle(a, b);
    const saved = exportSidecarFromDoc(a) as unknown as { modules: Mod[] };
    expect([...saved.modules[0]!.members].sort()).toEqual([p[1], p[2]].sort());
    expect(Object.keys(saved.modules[0]!).sort()).toEqual(Object.keys(mod(a)!).sort());
    expect(JSON.stringify(saved)).not.toMatch(/_order|__blob|"p:/);
  });
});

describe('undo and redo', () => {
  both("undo takes back my part and keeps the other person's; redo puts mine back", ({ a, b, M, p }) => {
    const undo = createUndoManager(a);
    add(a, M, p[2]!);
    add(b, M, p[3]!);
    settle(a, b);
    undo.undo();
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[1], p[3]].sort());
    undo.redo();
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[1], p[2], p[3]].sort());
    // The stamp is no undo step: older builds still refuse the layout.
    undo.undo();
    settle(a, b);
    expect(a.getMap('meta').get('schemaVersion')).toBe(3);
    undo.destroy();
  });

  both('undo of a part taken out, as the other person takes another out', ({ a, b, M, p }) => {
    const undo = createUndoManager(a);
    takeOut(a, M, p[0]!);
    add(b, M, p[4]!);
    takeOut(b, M, p[1]!);
    settle(a, b);
    expect(members(a)).toEqual([p[4]]);
    undo.undo();
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[4]].sort());
    undo.redo();
    settle(a, b);
    expect(members(a)).toEqual([p[4]]);
    undo.destroy();
  });

  both('undo of an ungroup brings the module back with the parts both added', ({ a, b, M, p }) => {
    add(a, M, p[2]!);
    add(b, M, p[3]!);
    settle(a, b);
    const undo = createUndoManager(a);
    deleteSidecarModule(a, M);
    settle(a, b);
    expect(mod(b)).toBeUndefined();
    undo.undo();
    settle(a, b);
    expect(members(a)).toEqual([p[0], p[1], p[2], p[3]].sort());
    undo.destroy();
  });
});

describe('offline, then back', () => {
  both('what one did to the module while away merges with what the other did meanwhile', ({ a, b, L, M, p }) => {
    // b is away. Both go on.
    add(b, M, p[2]!);
    takeOut(b, M, p[0]!);
    const extra = placeBrick(b, L, { ...brick, x: 80, y: 0 });
    add(b, M, extra);
    add(a, M, p[3]!);
    takeOut(a, M, p[1]!);
    renameSidecarModule(a, M, 'Harbour');
    // b's page was closed and opened again while away (its kept copy).
    const back = new Y.Doc();
    Y.applyUpdate(back, Y.encodeStateAsUpdate(b), 'remote');
    settle(a, back);
    expect(mod(back)).toEqual(mod(a));
    expect(members(a)).toEqual([p[2], p[3], extra].sort());
    expect(mod(a)!.name).toBe('Harbour');
    // (So the checks after this compare what came back.)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(back), 'remote');
    settle(a, b);
  });
});
