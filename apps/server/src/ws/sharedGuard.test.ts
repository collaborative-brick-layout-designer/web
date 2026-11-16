// The server's lock on shared modules (ws/sharedGuard.ts): what an app may
// do to one (move, turn, another sheet, remove it whole, its look and
// placement) and what is refused (changing, adding or taking out a part,
// unlocking it, leaving its parts behind), worked out from what the layout
// reads as before and after, so apps racing each other aren't refused; and
// that layouts without shared modules, and edits that can't touch one,
// cost no copy of the layout.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { createDefaultLayoutDoc, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { appendBricks, replaceModuleParts } from '@cld/modules';
import { decodeIncoming, guardWork } from './decoded.js';
import { LOCK_COPY_BUDGET_SPENT, sharedLockProblem } from './sharedGuard.js';
import { SHEET, contents, moduleOf, place, partsOf } from '../test/sharedWorld.js';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const V1 = contents([{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }]);

/** A room with a shared module "locked" (two parts), an ordinary module "free" (one part), a loose part and a second sheet. */
function room(): { doc: Y.Doc; locked: string[]; free: string[]; loose: string } {
  const doc = createDefaultLayoutDoc();
  doc.transact(() => {
    const l = new Y.Map<unknown>();
    l.set('id', 'brick-2');
    l.set('type', 'brick');
    l.set('name', 'Scenery');
    l.set('visible', true);
    l.set('transparency', 100);
    l.set('hullProperties', { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 });
    l.set('displayBrickElevation', false);
    l.set('bricks', new Y.Array());
    l.set('groups', new Y.Array());
    doc.getMap('layerData').set('brick-2', l);
    doc.getArray<string>('layers').push(['brick-2']);
  });
  const locked = place(doc, { placedId: 'locked', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
  const free = place(doc, { placedId: 'free', moduleId: LIB, version: 1, bytes: contents([{ pn: 'f.1', x: 0, y: 0 }]), placement: { degrees: 0, x: 0, y: 0 }, shared: false, name: 'Free' });
  let loose = '';
  doc.transact(() => {
    loose = appendBricks(doc, SHEET, [{ partNumber: 'loose.1', displayArea: { x: 200, y: 200, width: 2, height: 2 } }])[0]!;
  });
  return { doc, locked, free, loose };
}

/** The update a client that had the room's document would send for `edit`. */
function edit(doc: Y.Doc, change: (client: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(client);
  change(client);
  const update = Y.encodeStateAsUpdate(client, before);
  client.destroy();
  return update;
}

const verdict = (doc: Y.Doc, update: Uint8Array, mayCopy?: () => boolean) => sharedLockProblem(doc, update, decodeIncoming(update)!, mayCopy);

function brick(doc: Y.Doc, id: string): { map: Y.Map<unknown>; list: Y.Array<unknown>; index: number } {
  for (const layer of doc.getMap<Y.Map<unknown>>('layerData').values()) {
    const list = layer.get('bricks');
    if (!(list instanceof Y.Array)) continue;
    for (let i = 0; i < list.length; i++) {
      const b = list.get(i);
      if (b instanceof Y.Map && b.get('id') === id) return { map: b, list, index: i };
    }
  }
  throw new Error(`no part ${id}`);
}

function patchModule(doc: Y.Doc, id: string, change: (m: SidecarModule) => SidecarModule | null): void {
  doc.transact(() => {
    const cache = readSidecarCache(doc)!;
    const next: SidecarModule[] = [];
    for (const m of cache.modules as SidecarModule[]) {
      const out = m.id === id ? change(m) : m;
      if (out) next.push(out);
    }
    writeSidecarCache(doc, { ...cache, modules: next });
  });
}

function removeParts(doc: Y.Doc, ids: readonly string[]): void {
  doc.transact(() => {
    for (const id of ids) {
      const b = brick(doc, id);
      b.list.delete(b.index, 1);
    }
  });
}

describe('the lock on shared modules', () => {
  it('lets a shared module be moved, turned, pinned, recolored and put on another sheet', () => {
    const { doc, locked } = room();
    // Moved and turned: where its parts are, and its placement.
    const moved = edit(doc, (c) => {
      c.transact(() => {
        for (const id of locked) {
          const b = brick(c, id).map;
          const a = b.get('displayArea') as { x: number; y: number; width: number; height: number };
          b.set('displayArea', { ...a, x: a.x + 8, y: a.y + 8 });
          b.set('orientation', 90);
        }
      });
      patchModule(c, 'locked', (m) => ({ ...m, pinned: true, outlineColor: '#ff0000', shared: { ...(m.shared as object), placement: { degrees: 90, x: 108, y: 58 } } }));
    });
    expect(verdict(doc, moved)).toBeNull();
    // Another sheet: the same parts, deleted and added again.
    const sheet = edit(doc, (c) => {
      c.transact(() => {
        const to = (c.getMap<Y.Map<unknown>>('layerData').get('brick-2')!.get('bricks') as Y.Array<unknown>);
        for (const id of locked) {
          const b = brick(c, id);
          const copy = new Y.Map<unknown>();
          for (const [k, v] of b.map.entries()) copy.set(k, v);
          b.list.delete(b.index, 1);
          to.push([copy]);
        }
      });
    });
    expect(verdict(doc, sheet)).toBeNull();
    // The update notice dismissed (its `review` cleared).
    patchModule(doc, 'locked', (m) => ({ ...m, shared: { ...(m.shared as object), review: { from: 1, to: 2, at: 5 } } }));
    const ok = edit(doc, (c) => patchModule(c, 'locked', (m) => {
      const { review: _review, ...shared } = m.shared as Record<string, unknown>;
      return { ...m, shared };
    }));
    expect(verdict(doc, ok)).toBeNull();
  });

  it('lets a shared module be removed whole, and placed again', () => {
    const { doc, locked } = room();
    const removed = edit(doc, (c) => {
      removeParts(c, locked);
      patchModule(c, 'locked', () => null);
    });
    expect(verdict(doc, removed)).toBeNull();
    Y.applyUpdate(doc, removed);
    expect(moduleOf(doc, 'locked')).toBeUndefined();
    const again = edit(doc, (c) => {
      place(c, { placedId: 'again', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 0, y: 0 } });
    });
    expect(verdict(doc, again)).toBeNull();
  });

  it('refuses a change to one of its parts: which part it is, its color, its height', () => {
    const { doc, locked } = room();
    for (const [field, value] of [['partNumber', 'zzz.9'], ['partNumber', 'a.4'], ['altitude', 3]] as const) {
      const bad = edit(doc, (c) => brick(c, locked[0]!).map.set(field, value));
      expect(verdict(doc, bad), field).toBe('it changes a part of a shared module');
    }
    // Its id: the part the module holds is gone, another is in its place.
    const renamed = edit(doc, (c) => brick(c, locked[0]!).map.set('id', '424242'));
    expect(verdict(doc, renamed)).toBe('it takes a part out of a shared module');
  });

  it('refuses a part taken out or deleted, one added, and one swapped', () => {
    const { doc, locked, loose } = room();
    const deleted = edit(doc, (c) => removeParts(c, [locked[0]!]));
    expect(verdict(doc, deleted)).toBe('it takes a part out of a shared module');
    const takenOut = edit(doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, members: [locked[1]!] })));
    expect(verdict(doc, takenOut)).toBe('it takes a part out of a shared module');
    const added = edit(doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, members: [...m.members, loose] })));
    expect(verdict(doc, added)).toBe('it adds a part to a shared module');
    const swapped = edit(doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, members: [locked[0]!, loose] })));
    expect(verdict(doc, swapped)).toBe('it swaps a part of a shared module for another');
    // The same through a part key written by hand.
    const key = edit(doc, (c) => c.getMap('sidecarItems').set(`p:6:locked:${loose}`, 7));
    expect(verdict(doc, key)).toBe('it adds a part to a shared module');
  });

  it('refuses unlocking it, pointing it at another module, and removing it while leaving its parts', () => {
    const { doc, locked } = room();
    const unlocked = edit(doc, (c) => patchModule(c, 'locked', (m) => {
      const { shared: _shared, ...rest } = m;
      return rest as SidecarModule;
    }));
    expect(verdict(doc, unlocked)).toBe('it unlocks a shared module (only "Make it mine" does that)');
    const unlinked = edit(doc, (c) => patchModule(c, 'locked', (m) => {
      const { libraryModuleId: _id, ...rest } = m;
      return rest as SidecarModule;
    }));
    expect(verdict(doc, unlinked)).toBe('it unlocks a shared module (only "Make it mine" does that)');
    const other = edit(doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, libraryModuleId: '11111111-1111-4111-8111-111111111111' })));
    expect(verdict(doc, other)).toBe('it makes a shared module follow another module');
    const dissolved = edit(doc, (c) => patchModule(c, 'locked', () => null));
    expect(verdict(doc, dissolved)).toBe('it removes a shared module but leaves some of its parts');
    const half = edit(doc, (c) => {
      removeParts(c, [locked[0]!]);
      patchModule(c, 'locked', () => null);
    });
    expect(verdict(doc, half)).toBe('it removes a shared module but leaves some of its parts');
    // The whole sidecar replaced by one without it.
    const wiped = edit(doc, (c) => {
      c.transact(() => {
        c.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '' });
        for (const k of [...c.getMap('sidecarItems').keys()]) c.getMap('sidecarItems').delete(k);
      });
    });
    expect(verdict(doc, wiped)).toBe('it removes a shared module but leaves some of its parts');
    expect(partsOf(doc)).toHaveLength(4);
  });

  it('leaves everything that is not a shared module alone', () => {
    const { doc, free, loose } = room();
    const edits = [
      edit(doc, (c) => brick(c, free[0]!).map.set('partNumber', 'g.1')),
      edit(doc, (c) => removeParts(c, [free[0]!])),
      edit(doc, (c) => patchModule(c, 'free', () => null)),
      edit(doc, (c) => patchModule(c, 'free', (m) => ({ ...m, members: [...m.members, loose] }))),
      edit(doc, (c) => brick(c, loose).map.set('partNumber', 'h.1')),
      edit(doc, (c) => removeParts(c, [loose])),
    ];
    for (const [i, u] of edits.entries()) expect(verdict(doc, u), `edit ${i}`).toBeNull();
  });

  it('does not refuse apps racing each other, or the server', () => {
    // One person removes the module as another moves it: whichever arrives second.
    const a = room();
    const remove = edit(a.doc, (c) => {
      removeParts(c, a.locked);
      patchModule(c, 'locked', () => null);
    });
    const move = edit(a.doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, shared: { ...(m.shared as object), placement: { degrees: 0, x: 1, y: 2 } } })));
    const first = new Y.Doc();
    Y.applyUpdate(first, Y.encodeStateAsUpdate(a.doc));
    Y.applyUpdate(first, move);
    expect(verdict(first, remove)).toBeNull();
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(a.doc));
    Y.applyUpdate(second, remove);
    expect(verdict(second, move)).toBeNull();

    // Someone moves it, or removes it, as the server puts a new version in.
    const b = room();
    const staleMove = edit(b.doc, (c) => {
      c.transact(() => {
        for (const id of b.locked) {
          const m = brick(c, id).map;
          const area = m.get('displayArea') as { x: number; y: number; width: number; height: number };
          m.set('displayArea', { ...area, x: area.x + 8 });
        }
      });
      patchModule(c, 'locked', (m) => ({ ...m, shared: { ...(m.shared as object), placement: { degrees: 0, x: 108, y: 50 } } }));
    });
    const staleRemove = edit(b.doc, (c) => {
      removeParts(c, b.locked);
      patchModule(c, 'locked', () => null);
    });
    replaceModuleParts(b.doc, 'locked', [{ layerName: 'Layout', bricks: [{ partNumber: 'n.1', displayArea: { x: 100, y: 50, width: 2, height: 2 } }] }], () => SHEET, { libraryVersion: 2 }, 'server');
    expect(verdict(b.doc, staleMove)).toBeNull();
    expect(verdict(b.doc, staleRemove)).toBeNull();
    // After either, the module still holds the server's part.
    for (const u of [staleMove, staleRemove]) {
      const after = new Y.Doc();
      Y.applyUpdate(after, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(after, u);
      expect(partsOf(after).filter((p) => moduleOf(after, 'locked')?.members.includes(p.id)).map((p) => p.pn)).toEqual(['n.1']);
    }
  });

  it('costs no copy of the layout when there is no shared module, or the edit cannot touch one', () => {
    const { doc, loose } = room();
    const copies = () => guardWork.docCopies;
    const before = copies();
    // Ordinary edits next to a shared module: a part moved, a part added, another turned.
    const quiet = [
      edit(doc, (c) => {
        const m = brick(c, loose).map;
        m.set('displayArea', { x: 1, y: 2, width: 2, height: 2 });
        m.set('orientation', 45);
      }),
      edit(doc, (c) => c.transact(() => appendBricks(c, SHEET, [{ partNumber: 'new.1', displayArea: { x: 9, y: 9, width: 2, height: 2 } }]))),
      edit(doc, (c) => c.getMap('layerData').get('brick-2') && (c.getMap<Y.Map<unknown>>('layerData').get('brick-2')!).set('name', 'Hills')),
    ];
    for (const u of quiet) expect(verdict(doc, u)).toBeNull();
    expect(copies()).toBe(before);
    // One that might: looked at on a copy, when the sender may have one made.
    const moved = edit(doc, (c) => patchModule(c, 'locked', (m) => ({ ...m, pinned: true })));
    expect(verdict(doc, moved, () => false)).toBe(LOCK_COPY_BUDGET_SPENT);
    expect(copies()).toBe(before);
    expect(verdict(doc, moved, () => true)).toBeNull();
    expect(copies()).toBe(before + 1);

    // A layout with no shared module: anything goes, and nothing is copied.
    const plain = createDefaultLayoutDoc();
    const ids = place(plain, { placedId: 'free', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 0, y: 0 }, shared: false });
    const at = copies();
    expect(verdict(plain, edit(plain, (c) => patchModule(c, 'free', () => null)))).toBeNull();
    expect(verdict(plain, edit(plain, (c) => brick(c, ids[0]!).map.set('partNumber', 'x.1')))).toBeNull();
    expect(copies()).toBe(at);
  });
});
