// Two people changing one module at the same instant: its parts merge by
// their own keys (@cld/ydoc moduleMembers.ts), and a name or look changed
// here is put back when someone else's value replaced it
// (moduleMergeGuard.ts). Two Yjs documents that swap their changes, as two browsers do through
// the server. Each case runs twice, so each person is once the one whose
// value Yjs keeps and once the one whose value it drops.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readSidecarCache, repairSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { MODULE_MERGE_ORIGIN, mergeModule, watchModuleMerges } from './moduleMergeGuard';

interface Mod {
  id: string;
  name: string;
  members: string[];
  outlineColor?: string;
  pinned?: boolean;
}

const LOCAL = Symbol('local');
const REPAIR = Symbol('repair');

/** One person's browser: the layout, the guard, and what the app does after someone else's change. */
class Person {
  readonly doc = new Y.Doc();
  merges: string[] = [];
  private readonly stop: () => void;
  constructor(clientId: number) {
    this.doc.clientID = clientId;
    this.stop = watchModuleMerges(this.doc, (id) => this.merges.push(id));
    // As the editor does (useLayoutDoc.ts): the whole sidecar follows the merged modules.
    this.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.local) repairSidecarCache(this.doc, REPAIR);
    });
  }
  modules(): Mod[] {
    return ((readSidecarCache(this.doc)?.modules as Mod[] | undefined) ?? []).map((m) => ({ ...m }));
  }
  module(id = 'M'): Mod | undefined {
    return this.modules().find((m) => m.id === id);
  }
  /** Changes one module the way mutations.ts does (updateSidecarModule). */
  change(id: string, how: (m: Mod) => Mod): void {
    this.doc.transact(() => {
      const cache = readSidecarCache(this.doc) ?? {};
      writeSidecarCache(this.doc, { ...cache, modules: this.modules().map((m) => (m.id === id ? how(m) : m)) });
    }, LOCAL);
  }
  remove(id: string): void {
    this.doc.transact(() => {
      const cache = readSidecarCache(this.doc) ?? {};
      writeSidecarCache(this.doc, { ...cache, modules: this.modules().filter((m) => m.id !== id) });
    }, LOCAL);
  }
  /** Puts parts on the map (or takes one off). */
  parts(ids: string[]): void {
    this.doc.transact(() => {
      let layer = this.doc.getMap('layerData').get('L') as Y.Map<unknown> | undefined;
      if (!layer) {
        layer = new Y.Map();
        this.doc.getMap('layerData').set('L', layer);
        layer.set('bricks', new Y.Array());
      }
      const bricks = layer.get('bricks') as Y.Array<Y.Map<unknown>>;
      for (const id of ids) {
        const b = new Y.Map<unknown>();
        b.set('id', id);
        bricks.push([b]);
      }
    }, LOCAL);
  }
  deletePart(id: string): void {
    this.doc.transact(() => {
      const bricks = (this.doc.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
      const i = bricks.toArray().findIndex((b) => b.get('id') === id);
      if (i >= 0) bricks.delete(i, 1);
      // As deleteBricks does: it leaves its module.
      const cache = readSidecarCache(this.doc) ?? {};
      writeSidecarCache(this.doc, { ...cache, modules: this.modules().map((m) => ({ ...m, members: m.members.filter((x) => x !== id) })) });
    }, LOCAL);
  }
  close(): void {
    this.stop();
  }
}

/** Each gets what the other has, until neither has anything new. Returns how many rounds it took. */
function swap(a: Person, b: Person): number {
  for (let round = 1; round <= 20; round++) {
    const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(b.doc, toB, 'remote');
    Y.applyUpdate(a.doc, toA, 'remote');
    if (Y.encodeStateVector(a.doc).join() === Y.encodeStateVector(b.doc).join() && round > 1) return round;
  }
  throw new Error('the two never settled');
}

/** Sam and Alex with one module `M` of parts p1 and p2 on a map of p1..p5; `samWins` picks whose value Yjs keeps on a tie. */
function pair(samWins: boolean): { sam: Person; alex: Person } {
  // On a tie Yjs keeps the value from the higher client id.
  const sam = new Person(samWins ? 20 : 10);
  const alex = new Person(samWins ? 10 : 20);
  sam.parts(['p1', 'p2', 'p3', 'p4', 'p5']);
  sam.doc.transact(() => writeSidecarCache(sam.doc, { modules: [{ id: 'M', name: 'Yard', members: ['p1', 'p2'] }] }), LOCAL);
  swap(sam, alex);
  expect(alex.module()).toEqual({ id: 'M', name: 'Yard', members: ['p1', 'p2'] });
  sam.merges = [];
  alex.merges = [];
  return { sam, alex };
}

const both = (name: string, run: (sam: Person, alex: Person, samWins: boolean) => void): void => {
  for (const samWins of [true, false]) {
    it(`${name} (${samWins ? 'Sam' : 'Alex'}'s value is the one Yjs keeps)`, () => {
      const { sam, alex } = pair(samWins);
      run(sam, alex, samWins);
      // Whatever happened, both show the same, and they stay that way.
      expect(alex.modules()).toEqual(sam.modules());
      swap(sam, alex);
      expect(alex.modules()).toEqual(sam.modules());
      sam.close();
      alex.close();
    });
  }
};

describe('one module changed by two people at the same instant', () => {
  both('each adds a part: both parts are in the module', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p3'] }));
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p4'] }));
    swap(sam, alex);
    expect([...sam.module()!.members].sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    // The parts merged by themselves: nothing had to be put back.
    expect(sam.merges.length + alex.merges.length).toBe(0);
  });

  both('one renames it, the other adds a part: both stay', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, name: 'Yard east' }));
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p4'] }));
    swap(sam, alex);
    expect(sam.module()).toEqual({ id: 'M', name: 'Yard east', members: ['p1', 'p2', 'p4'] });
  });

  both('one takes a part out, the other adds one and pins it', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, members: m.members.filter((x) => x !== 'p2') }));
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p5'], pinned: true }));
    swap(sam, alex);
    expect(sam.module()).toEqual({ id: 'M', name: 'Yard', members: ['p1', 'p5'], pinned: true });
  });

  both('both rename it: one name stays, the same for both, and nobody keeps writing', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, name: 'North yard' }));
    alex.change('M', (m) => ({ ...m, name: 'South yard' }));
    swap(sam, alex);
    expect(['North yard', 'South yard']).toContain(sam.module()!.name);
    expect(sam.merges.length + alex.merges.length).toBe(0);
  });

  both('several changes while one was offline all come back', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p3'] }));
    sam.change('M', (m) => ({ ...m, outlineColor: '#ff8800' }));
    sam.change('M', (m) => ({ ...m, members: m.members.filter((x) => x !== 'p1') }));
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p4'] }));
    alex.change('M', (m) => ({ ...m, name: 'Yard east' }));
    swap(sam, alex);
    const m = sam.module()!;
    expect([...m.members].sort()).toEqual(['p2', 'p3', 'p4']);
    expect(m.name).toBe('Yard east');
    expect(m.outlineColor).toBe('#ff8800');
  });

  both('one changes its outline, the other renames it: one of them puts a change back, once', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, outlineColor: '#ff8800' }));
    alex.change('M', (m) => ({ ...m, name: 'Yard east' }));
    swap(sam, alex);
    expect(sam.module()).toEqual({ id: 'M', name: 'Yard east', members: ['p1', 'p2'], outlineColor: '#ff8800' });
    expect(sam.merges.length + alex.merges.length).toBe(1);
  });

  both('a part someone deleted at that instant isn’t in the module', (sam, alex) => {
    // A layout's own doc (the check for parts on the map is only made there).
    sam.doc.transact(() => {
      sam.doc.getMap('meta').set('version', 1);
      sam.doc.getArray<string>('layers').push(['L']);
    }, 'setup');
    swap(sam, alex);
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p3'] }));
    alex.deletePart('p3');
    alex.change('M', (m) => ({ ...m, name: 'Yard east' }));
    swap(sam, alex);
    expect(sam.module()!.name).toBe('Yard east');
    // Sam's key for it is still there, but the part is gone: it isn't read.
    expect(sam.module()!.members).toEqual(['p1', 'p2']);
    expect(alex.module()!.members).toEqual(['p1', 'p2']);
  });

  both('one deletes a part of the module, the other adds one: the deleted part isn’t a member', (sam, alex) => {
    sam.deletePart('p2');
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p4'] }));
    swap(sam, alex);
    expect([...sam.module()!.members].sort()).toEqual(['p1', 'p4']);
  });

  both('one ungroups it while the other changes it: the two agree, and nothing is written in a loop', (sam, alex) => {
    sam.remove('M');
    alex.change('M', (m) => ({ ...m, members: [...m.members, 'p4'] }));
    const rounds = swap(sam, alex);
    expect(rounds).toBeLessThan(6);
  });
});

describe('one after the other (each saw the other’s change)', () => {
  both('a part one person added and the other then took out stays out', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p3'] }));
    swap(sam, alex);
    alex.change('M', (m) => ({ ...m, members: m.members.filter((x) => x !== 'p3') }));
    swap(sam, alex);
    expect(sam.module()!.members).toEqual(['p1', 'p2']);
    expect(sam.merges.length + alex.merges.length).toBe(0);
  });

  both('a name changed back by the other stays changed back', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, name: 'Yard east' }));
    swap(sam, alex);
    alex.change('M', (m) => ({ ...m, name: 'Yard' }));
    swap(sam, alex);
    expect(sam.module()!.name).toBe('Yard');
    expect(sam.merges.length + alex.merges.length).toBe(0);
  });

  both('a change made after seeing one of mine, at the same instant as my next: only my next is put back', (sam, alex) => {
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p3'] }));
    swap(sam, alex);
    // Alex takes p3 out again, knowing it was added; Sam meanwhile adds p5.
    alex.change('M', (m) => ({ ...m, members: m.members.filter((x) => x !== 'p3') }));
    sam.change('M', (m) => ({ ...m, members: [...m.members, 'p5'] }));
    swap(sam, alex);
    expect([...sam.module()!.members].sort()).toEqual(['p1', 'p2', 'p5']);
  });
});

describe('the put-back', () => {
  it('isn’t an undo step, and other modules are left alone', () => {
    const { sam, alex } = pair(false);
    sam.doc.transact(() => {
      const cache = readSidecarCache(sam.doc) ?? {};
      writeSidecarCache(sam.doc, { ...cache, modules: [...sam.modules(), { id: 'N', name: 'Depot', members: ['p5'] }] });
    }, LOCAL);
    swap(sam, alex);
    const origins: unknown[] = [];
    sam.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.local) origins.push(tr.origin);
    });
    sam.change('M', (m) => ({ ...m, outlineColor: '#ff8800', members: [...m.members, 'p3'] }));
    alex.change('M', (m) => ({ ...m, name: 'Yard east', members: [...m.members, 'p4'] }));
    swap(sam, alex);
    expect(origins).toContain(MODULE_MERGE_ORIGIN);
    expect(sam.module()).toEqual({ id: 'M', name: 'Yard east', members: ['p1', 'p2', 'p3', 'p4'], outlineColor: '#ff8800' });
    expect(alex.module()).toEqual(sam.module());
    expect(sam.module('N')).toEqual({ id: 'N', name: 'Depot', members: ['p5'] });
    expect(alex.module('N')).toEqual({ id: 'N', name: 'Depot', members: ['p5'] });
  });
});

// Sam adds a part to the module while Alex renames it: Sam's part is put
// back on top of Alex's value, by a write that isn't an undo step. Sam's
// Undo then takes the part off the map but can't take back the module's
// value (it isn't Sam's any more), so the module would list a part that
// isn't there. The list is read and written without it (@cld/ydoc), and
// Redo brings the part back into both.
describe('undo after a put-back', () => {
  const onMap = (p: Person): string[] =>
    ((p.doc.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray().map((b) => String(b.get('id')));
  /** What the app does after an undo or redo (useLayoutDoc.ts): the sidecar follows. */
  const settle = (sam: Person, alex: Person): void => {
    repairSidecarCache(sam.doc, REPAIR);
    swap(sam, alex);
  };
  both('takes the part off the map and out of the module; redo puts it back in both', (sam, alex) => {
    // A layout's own doc (the check for parts on the map is only made there).
    sam.doc.transact(() => {
      sam.doc.getMap('meta').set('version', 1);
      sam.doc.getArray<string>('layers').push(['L']);
    }, 'setup');
    swap(sam, alex);
    // As createUndoManager does (useUndoManager.ts).
    const undo = new Y.UndoManager(
      [sam.doc.getMap('layerData'), sam.doc.getArray('layers'), sam.doc.getMap('meta'), sam.doc.getMap('sidecarItems')],
      { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 },
    );
    // One step: the part on the map and in the module.
    sam.doc.transact(() => {
      const bricks = (sam.doc.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
      const b = new Y.Map<unknown>();
      b.set('id', 'p9');
      bricks.push([b]);
      const cache = readSidecarCache(sam.doc) ?? {};
      writeSidecarCache(sam.doc, { ...cache, modules: sam.modules().map((m) => (m.id === 'M' ? { ...m, members: [...m.members, 'p9'] } : m)) });
    }, LOCAL);
    alex.change('M', (m) => ({ ...m, name: 'Depot' }));
    swap(sam, alex);
    expect(sam.module()).toEqual({ id: 'M', name: 'Depot', members: ['p1', 'p2', 'p9'] });

    expect(undo.undo()).not.toBeNull();
    settle(sam, alex);
    for (const p of [sam, alex]) {
      expect(onMap(p)).not.toContain('p9');
      // Never a member that isn't on the map: not in what the editor reads…
      expect(p.module()).toEqual({ id: 'M', name: 'Depot', members: ['p1', 'p2'] });
      // …nor in the copy the desktop reads (meta.cache).
      const cached = (p.doc.getMap('meta').get('cache') as { modules: Mod[] }).modules.find((m) => m.id === 'M');
      expect(cached?.members).toEqual(['p1', 'p2']);
    }

    expect(undo.redo()).not.toBeNull();
    settle(sam, alex);
    for (const p of [sam, alex]) {
      expect(onMap(p)).toContain('p9');
      expect(p.module()).toEqual({ id: 'M', name: 'Depot', members: ['p1', 'p2', 'p9'] });
      const cached = (p.doc.getMap('meta').get('cache') as { modules: Mod[] }).modules.find((m) => m.id === 'M');
      expect(cached?.members).toEqual(['p1', 'p2', 'p9']);
    }
    undo.destroy();
  });
});

describe('mergeModule', () => {
  const base = { id: 'M', name: 'Yard', members: ['a', 'b'] };
  it('leaves the parts as theirs: they merge by their own keys', () => {
    expect(mergeModule(base, { ...base, members: ['a', 'b', 'x'] }, { ...base, members: ['b', 'a', 'y'] }).members).toEqual(['b', 'a', 'y']);
  });
  it('puts back a field I changed, and leaves a field both changed as theirs', () => {
    expect(mergeModule(base, { ...base, name: 'Mine', pinned: true }, { ...base, name: 'Theirs', members: ['a', 'b', 'y'] })).toEqual({
      id: 'M',
      name: 'Theirs',
      members: ['a', 'b', 'y'],
      pinned: true,
    });
  });
  it('puts back a field I cleared and they left alone', () => {
    const colored = { ...base, outlineColor: '#f00' };
    expect(mergeModule(colored, base, { ...colored, pinned: true })).toEqual({ ...base, pinned: true });
  });
});
