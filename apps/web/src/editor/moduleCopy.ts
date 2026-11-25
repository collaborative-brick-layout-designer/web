// Copies of a module: Duplicate or paste of exactly one picked module, and
// the Modules panel's Duplicate, make a real module named "X (copy)" with
// the original's look (colors, Show name). The copy is its own module:
// not linked to the Module library, and not pinned (it is there to be moved).

import type { SidecarModule } from '@cld/bbm';
import { copyPlaces, modulePlaces, withPlaces } from '@cld/bbm';
import { makeId } from '@cld/ydoc';

/** The one module the selection is exactly (all its parts, nothing else), or null. */
export function wholeModule(modules: readonly SidecarModule[], selection: readonly string[]): SidecarModule | null {
  if (selection.length === 0) return null;
  const picked = new Set(selection);
  for (const m of modules) {
    if (m.members.length !== picked.size) continue;
    if (m.members.every((id) => picked.has(id))) return m;
  }
  return null;
}

/** A copy of `module` holding `members`: a new id, "X (copy)", the same look, no library link, unpinned. `renamed` gives each part's id in the copy, for its places' spots. */
export function moduleCopy(module: SidecarModule, members: string[], newId: () => string = makeId, renamed: ReadonlyMap<string, string> = new Map()): SidecarModule {
  // (A shared module's link goes too: the copy follows nothing. sharedModules.ts pastedShared makes a shared copy.)
  const { id: _id, members: _m, libraryModuleId: _l, libraryVersion: _v, sourceFile: _s, importedAt: _i, pinned: _p, shared: _sh, ...look } = module as SidecarModule & { shared?: unknown };
  const places = copyPlaces(modulePlaces(module), (id) => renamed.get(id) ?? null, newId);
  return {
    ...withPlaces(look, places),
    id: newId(),
    name: module.name ? `${module.name} (copy)` : '(copy)',
    members,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}
