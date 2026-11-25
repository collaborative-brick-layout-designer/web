// The lock on shared (read-only) modules, in the editor
// (docs/shared-modules.md, "Keeping it read-only").
//
// A shared placed module's parts are its owner's. It can be moved, turned,
// pinned, recolored (its outline and name), put on another sheet,
// duplicated and removed, always as a whole; nothing changes its parts,
// which parts it holds, or its name. Every change the editor makes goes
// through editor/mutations.ts, so the rule is kept there: a mutation that
// would break it does nothing and says why (`onSharedLock`, a notice in
// the editor), whichever tool, menu or shortcut asked for it. The server
// keeps the same rule for apps that don't (ws/sharedGuard.ts).

import type * as Y from 'yjs';
import { readSidecarCache } from '@cld/ydoc';
import { sharedModulesIn, sharedPlaced, type SharedPlaced } from '@cld/modules';
import { modulePlaces, type SidecarModule } from '@cld/bbm';

/** What was asked of a shared module (for the reason given). */
export type LockedAction = 'parts' | 'edit' | 'rename' | 'members' | 'dissolve' | 'bend' | 'places';

/** Why it can't be done, in plain words. */
export function lockMessage(s: Pick<SharedPlaced, 'name' | 'by'>, what: LockedAction): string {
  const name = s.name ? `“${s.name}”` : 'This module';
  const by = s.by ? `shared by ${s.by}` : 'a shared module';
  const whose = s.by ? `${s.by}’s` : 'its owner’s';
  switch (what) {
    case 'rename':
      return `${name} is ${by}, so its name is ${whose}. You can move it, turn it and change its outline color.`;
    case 'members':
      return `${name} is ${by}, so parts can’t be added to it or taken out of it here.`;
    case 'dissolve':
      return `${name} is ${by}, so it stays one module. You can remove it from this layout, or its layout’s owner can make it theirs.`;
    case 'bend':
      return `${name} is ${by}, so its track can’t be bent here. You can move and turn the whole module.`;
    case 'places':
      return `${name} is ${by}, so its places are ${whose}. They change here with ${whose} updates.`;
    case 'edit':
    case 'parts':
      return `${name} is ${by}, so its parts can’t be changed here. You can move it, turn it or remove it as a whole.`;
  }
}

type Tell = (s: SharedPlaced, what: LockedAction) => void;
let tell: Tell = () => undefined;

/** How a refused change is told to the person (the editor shows a notice). */
export function onSharedLock(fn: Tell): void {
  tell = fn;
}

/** The layout's shared modules. */
export function sharedModulesOf(doc: Y.Doc): SharedPlaced[] {
  return sharedModulesIn(readSidecarCache(doc));
}

/** The shared module with id `moduleId`, or null when that module isn't shared. */
export function sharedModule(doc: Y.Doc, moduleId: string): SharedPlaced | null {
  return sharedModulesOf(doc).find((s) => s.placedId === moduleId) ?? null;
}

/**
 * The shared module that a change to the parts `ids` would break: one with
 * some of its parts among them. With `whole`, a module whose every part is
 * among them is left out (moving it to another sheet, removing it).
 */
export function sharedLockOn(doc: Y.Doc, ids: Iterable<string>, whole = false): SharedPlaced | null {
  const shared = sharedModulesOf(doc);
  if (shared.length === 0) return null;
  const picked = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  if (picked.size === 0) return null;
  for (const s of shared) {
    let n = 0;
    for (const id of s.members) if (picked.has(id)) n++;
    if (n === 0) continue;
    if (whole && n === s.members.length) continue;
    return s;
  }
  return null;
}

/** True (and the person is told) when changing the parts `ids` isn't allowed. */
export function partsLocked(doc: Y.Doc, ids: Iterable<string>, what: LockedAction = 'parts', whole = false): boolean {
  const s = sharedLockOn(doc, ids, whole);
  if (s) tell(s, what);
  return !!s;
}

/** True (and the person is told) when the module `moduleId` is shared, so `what` isn't allowed. */
export function moduleLocked(doc: Y.Doc, moduleId: string, what: LockedAction): boolean {
  const s = sharedModule(doc, moduleId);
  if (s) tell(s, what);
  return !!s;
}

/** Whether changing a shared module's value from `was` to `next` keeps the lock: the same parts, still shared, following the same module, under the same name. */
export function keepsLock(was: SidecarModule, next: SidecarModule): LockedAction | null {
  const a = sharedPlaced(was);
  if (!a) return null;
  const b = sharedPlaced(next);
  if (!b || b.moduleId !== a.moduleId) return 'dissolve';
  if (b.members.length !== a.members.length || b.members.some((id, i) => id !== a.members[i])) return 'members';
  if ((next.name ?? '') !== (was.name ?? '')) return 'rename';
  if (JSON.stringify(modulePlaces(next)) !== JSON.stringify(modulePlaces(was))) return 'places';
  return null;
}
