// Two people changing one module's parts at the same instant, with the
// editor's own edits (mutations.ts) and its undo: each part added or taken
// out is a key of its own in the shared layout (@cld/ydoc moduleMembers.ts),
// so both changes stay. Each case runs with the two people's client ids
// both ways round: Yjs breaks a tie by them.
//
// The last part is the vectors the desktop checks too
// (fixtures/contracts/module-members.json `docs`): a layout, an edit the
// web made on it, and the edit the desktop makes at the same time.
// BLD_WRITE_CONTRACTS=1 writes them afresh into the copy here (then copy it
// to fixtures/contracts/, update MANIFEST.sha256 and copy both to the
// desktop repo).

// A copy of fixtures/contracts/module-members.json (the image build has no
// fixtures/; the server's contracts test checks the copy is the same).
import contractJson from './fixtures/module-members.json';

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bbmToDoc,
  createDefaultLayoutDoc,
  docToBbm,
  exportSidecarFromDoc,
  memberKey,
  readSidecarCache,
  removeDuplicateItems,
  repairSidecarCache,
  sidecarBlobHash,
  stampMemberKeys,
} from '@cld/ydoc';
import {
  addSidecarModule,
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

// ---------------------------------------------------------------------------
// Across the apps (contract)
// ---------------------------------------------------------------------------

interface Want {
  /** Every module: its name and its parts, sorted. */
  modules: { name: string; members: string[] }[];
}
interface DocsContract {
  /** The five parts on the map, and the module's id. */
  parts: string[];
  moduleId: string;
  /** The layout as a build from before the keys left it: the module holds parts 0 and 1. */
  base: string;
  concurrent: { name: string; web: string; desktop: string; expect: Want }[];
  /** The layout after the web added part 2 and took part 0 out, what it then reads as, and its part keys. */
  keyed: string;
  keyedExpect: Want;
  keyedKeys: Record<string, number | false>;
  /** Its part keys after part 3 is added and part 1 taken out (by either app). */
  keyedThenKeys: Record<string, number | false>;
}
const contract = contractJson as unknown as { docs?: DocsContract };
// (Node in tests; the app's types are the browser's.)
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(''));
const unb64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const decoded = (...updates: (string | Uint8Array)[]): Y.Doc => {
  const d = new Y.Doc();
  for (const u of updates) Y.applyUpdate(d, typeof u === 'string' ? unb64(u) : u, 'remote');
  return d;
};
/** What `edit` writes on a copy of `base` held by client `id`. */
function editOf(base: Y.Doc | string, id: number, edit: (d: Y.Doc) => void): Uint8Array {
  const d = new Y.Doc();
  d.clientID = id;
  Y.applyUpdate(d, typeof base === 'string' ? unb64(base) : Y.encodeStateAsUpdate(base), 'remote');
  const updates: Uint8Array[] = [];
  d.on('update', (u: Uint8Array) => updates.push(u));
  edit(d);
  return Y.mergeUpdates(updates);
}
const wantOf = (d: Y.Doc): Want => ({
  modules: ((readSidecarCache(d)?.modules ?? []) as Mod[]).map((m) => ({ name: m.name, members: [...m.members].sort() })),
});
const partKeys = (d: Y.Doc): Record<string, number | false> => {
  const out: Record<string, number | false> = {};
  d.getMap('sidecarItems').forEach((v, k) => {
    if (k.startsWith('p:')) out[k] = v as number | false;
  });
  return out;
};
const layerOf = (d: Y.Doc): string => ensureBrickLayer(d);
const MODULE = 'yard-module';

/** The module written whole, with its list: what a build from before the keys does (@cld/ydoc at 330850e). */
function olderBuildSetsMembers(d: Y.Doc, members: string[]): void {
  d.transact(() => {
    const items = d.getMap('sidecarItems');
    const cache = d.getMap('meta').get('cache') as { modules: Mod[] };
    const next = { ...cache, modules: cache.modules.map((m) => (m.id === MODULE ? { ...m, members } : m)) };
    next.modules.forEach((m, i) => items.set(`m:${m.id}`, { ...m, _order: i }));
    d.getMap('meta').set('cache', next);
    items.set('__blob', sidecarBlobHash(next));
  });
}

interface Case {
  name: string;
  web: (d: Y.Doc, p: string[]) => void;
  /** The desktop's edit, in words (its test makes it), and the same edit made here to stand in for it. */
  desktop: string;
  local: (d: Y.Doc, p: string[]) => void;
  expect: (p: string[]) => Want;
}
const sorted = (...ids: string[]) => [...ids].sort();
const desktopEdits: Record<string, Case['local']> = {
  'add part 3 to the module': (d, p) => add(d, MODULE, p[3]!),
  'take part 0 out of the module': (d, p) => takeOut(d, MODULE, p[0]!),
  'rename the module Harbour': (d) => renameSidecarModule(d, MODULE, 'Harbour'),
  'delete part 1 from the map': (d, p) => deleteBricks(d, layerOf(d), [p[1]!]),
};
const cases: Case[] = [
  {
    name: 'both add a part',
    web: (d, p) => add(d, MODULE, p[2]!),
    desktop: 'add part 3 to the module',
    expect: (p) => ({ modules: [{ name: 'Yard', members: sorted(p[0]!, p[1]!, p[2]!, p[3]!) }] }),
  },
  {
    name: 'the web adds a part, the desktop takes one out',
    web: (d, p) => add(d, MODULE, p[2]!),
    desktop: 'take part 0 out of the module',
    expect: (p) => ({ modules: [{ name: 'Yard', members: sorted(p[1]!, p[2]!) }] }),
  },
  {
    name: 'the web takes a part out, the desktop adds one',
    web: (d, p) => takeOut(d, MODULE, p[1]!),
    desktop: 'add part 3 to the module',
    expect: (p) => ({ modules: [{ name: 'Yard', members: sorted(p[0]!, p[3]!) }] }),
  },
  {
    name: 'the web renames the module, the desktop adds a part',
    web: (d) => renameSidecarModule(d, MODULE, 'Depot'),
    desktop: 'add part 3 to the module',
    expect: (p) => ({ modules: [{ name: 'Depot', members: sorted(p[0]!, p[1]!, p[3]!) }] }),
  },
  {
    name: 'the web adds a part and takes one out, the desktop renames the module',
    web: (d, p) => {
      add(d, MODULE, p[2]!);
      takeOut(d, MODULE, p[0]!);
    },
    desktop: 'rename the module Harbour',
    expect: (p) => ({ modules: [{ name: 'Harbour', members: sorted(p[1]!, p[2]!) }] }),
  },
  {
    name: 'a web build from before the keys adds a part (the list written whole), the desktop adds one',
    web: (d, p) => olderBuildSetsMembers(d, [p[0]!, p[1]!, p[4]!]),
    desktop: 'add part 3 to the module',
    expect: (p) => ({ modules: [{ name: 'Yard', members: sorted(p[0]!, p[1]!, p[3]!, p[4]!) }] }),
  },
  {
    name: 'the web adds a part, the desktop deletes a part of the module from the map',
    web: (d, p) => add(d, MODULE, p[2]!),
    desktop: 'delete part 1 from the map',
    expect: (p) => ({ modules: [{ name: 'Yard', members: sorted(p[0]!, p[2]!) }] }),
  },
  {
    name: 'the web ungroups the module, the desktop adds a part: it stays ungrouped',
    web: (d) => deleteSidecarModule(d, MODULE),
    desktop: 'add part 3 to the module',
    expect: () => ({ modules: [] }),
  },
].map((c) => ({ ...c, local: desktopEdits[c.desktop]! }));

/** The layout the vectors start from: five parts, a module of the first two, made by client 1. */
function baseLayout(): { doc: Y.Doc; parts: string[] } {
  const doc = new Y.Doc();
  doc.clientID = 1;
  bbmToDoc(docToBbm(createDefaultLayoutDoc()), doc);
  const L = ensureBrickLayer(doc);
  const parts = [0, 1, 2, 3, 4].map((i) => placeBrick(doc, L, { ...brick, x: i * 8, y: 0 }));
  addSidecarModule(doc, { id: MODULE, name: 'Yard', members: [parts[0]!, parts[1]!], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  return { doc, parts };
}
const keyedEdit = (d: Y.Doc, p: string[]) => {
  add(d, MODULE, p[2]!);
  takeOut(d, MODULE, p[0]!);
};
const keyedThenEdit = (d: Y.Doc, p: string[]) => {
  add(d, MODULE, p[3]!);
  takeOut(d, MODULE, p[1]!);
};

describe('one module, the web and the desktop (contract)', () => {
  if (nodeEnv.BLD_WRITE_CONTRACTS === '1') {
    it('writes the vectors', async () => {
      const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { writeFileSync: (p: string, s: string) => void };
      const { doc, parts } = baseLayout();
      const base = b64(Y.encodeStateAsUpdate(doc));
      const keyed = decoded(base, editOf(base, 2, (d) => keyedEdit(d, parts)));
      const then = decoded(Y.encodeStateAsUpdate(keyed), editOf(keyed, 2, (d) => keyedThenEdit(d, parts)));
      const docs: DocsContract = {
        parts,
        moduleId: MODULE,
        base,
        concurrent: cases.map((k) => ({ name: k.name, web: b64(editOf(base, 2, (d) => k.web(d, parts))), desktop: k.desktop, expect: k.expect(parts) })),
        keyed: b64(Y.encodeStateAsUpdate(keyed)),
        keyedExpect: wantOf(keyed),
        keyedKeys: partKeys(keyed),
        keyedThenKeys: partKeys(then),
      };
      const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd(); // apps/web
      fs.writeFileSync(`${cwd}/src/editor/test/fixtures/module-members.json`, `${JSON.stringify({ ...contractJson, docs }, null, 2)}\n`);
    });
    return;
  }
  const c = contract.docs!;
  const p = c.parts;

  it('the layout from before the keys reads as it always did, and nothing is written on opening it', () => {
    const d = decoded(c.base);
    const before = Y.encodeStateVector(d);
    expect(wantOf(d)).toEqual({ modules: [{ name: 'Yard', members: sorted(p[0]!, p[1]!) }] });
    expect(d.getMap('meta').get('schemaVersion')).toBe(1);
    expect(partKeys(d)).toEqual({});
    expect(repairSidecarCache(d, 'repair')).toBe(false);
    expect(stampMemberKeys(d)).toBe(false);
    expect(Y.encodeStateVector(d)).toEqual(before);
  });

  it.each(c.concurrent)('$name', ({ name, web, desktop, expect: want }) => {
    expect(want).toEqual(cases.find((k) => k.name === name)!.expect(p));
    // The web's edit, and (standing in for the desktop's) the same edit made
    // here on the layout at the same time, arriving in either order.
    const mine = editOf(c.base, 3, (d) => desktopEdits[desktop]!(d, p));
    for (const order of [[web, mine], [mine, web]] as const) {
      const d = decoded(c.base, ...order);
      repairSidecarCache(d, 'repair');
      expect(wantOf(d)).toEqual(want);
    }
  });

  it('a layout with part keys reads the same, and the next edit writes the same keys as the desktop', () => {
    const d = decoded(c.keyed);
    expect(wantOf(d)).toEqual(c.keyedExpect);
    expect(c.keyedExpect).toEqual({ modules: [{ name: 'Yard', members: sorted(p[1]!, p[2]!) }] });
    expect(d.getMap('meta').get('schemaVersion')).toBe(3);
    expect(partKeys(d)).toEqual(c.keyedKeys);
    expect(c.keyedKeys).toEqual({ [memberKey(MODULE, p[2]!)]: 0, [memberKey(MODULE, p[0]!)]: false });
    keyedThenEdit(d, p);
    expect(partKeys(d)).toEqual(c.keyedThenKeys);
    expect(c.keyedThenKeys).toEqual({ [memberKey(MODULE, p[2]!)]: 0, [memberKey(MODULE, p[0]!)]: false, [memberKey(MODULE, p[3]!)]: 1, [memberKey(MODULE, p[1]!)]: false });
  });
});
