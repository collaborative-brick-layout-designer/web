// Modules in a layout act as one piece: a click on any part picks the
// whole module, drags and box-select take it whole, and it moves and turns
// as a unit. "Edit module" opens one module to change it part by part,
// with the rest of the layout out of reach; "Pin in place" keeps a module
// from moving as a whole (Edit module still works). Pure functions over
// the sidecar's modules; the desktop's ui/ModuleEdit.h is the same.

import type { SidecarModule } from '@cld/bbm';

/** The module each part belongs to (the first one listing it). */
export function moduleByPart(modules: readonly SidecarModule[]): Map<string, SidecarModule> {
  const out = new Map<string, SidecarModule>();
  for (const m of modules) for (const id of m.members) if (!out.has(id)) out.set(id, m);
  return out;
}

/**
 * What a selection becomes. Not editing: any part of a module brings the
 * whole module. Editing a module: only that module's parts can be picked.
 */
export function shapeSelection(ids: readonly string[], modules: readonly SidecarModule[], editingId: string | null): string[] {
  if (editingId !== null) {
    const editing = modules.find((m) => m.id === editingId);
    if (!editing) return [...ids];
    const members = new Set(editing.members);
    return ids.filter((id) => members.has(id));
  }
  if (modules.length === 0 || ids.length === 0) return [...ids];
  const byPart = moduleByPart(modules);
  const out = [...ids];
  const seen = new Set(ids);
  for (const id of ids) {
    const m = byPart.get(id);
    if (!m) continue;
    for (const member of m.members) {
      if (seen.has(member)) continue;
      seen.add(member);
      out.push(member);
    }
  }
  return out;
}

/**
 * What a click on a part picks: its whole module (unless that module is
 * the one being edited), else its BlueBrick group, else just the part.
 */
export function selectionUnit(
  partId: string,
  modules: readonly SidecarModule[],
  editingId: string | null,
  groupMembers: readonly string[],
): string[] {
  if (editingId === null) {
    const m = moduleByPart(modules).get(partId);
    if (m) return [...m.members];
  }
  return groupMembers.length > 0 ? [...groupMembers] : [partId];
}

/** While a module is edited: the parts that aren't in it are out of reach. */
export function outsideEdit(partId: string, modules: readonly SidecarModule[], editingId: string | null): boolean {
  if (editingId === null) return false;
  const editing = modules.find((m) => m.id === editingId);
  return !!editing && !editing.members.includes(partId);
}

/**
 * Whether a part outside the edited module is dimmed on its own. Only one
 * inside the module's frame is: the dim overlay (ModuleEditDim) covers
 * everything beyond the frame as one layer, so parts there keep their own
 * look under it and a covered part never shows through the one above it.
 */
export function dimInEdit(
  partId: string,
  area: StudRect,
  modules: readonly SidecarModule[],
  editingId: string | null,
  frame: StudRect | null,
): boolean {
  if (!outsideEdit(partId, modules, editingId)) return false;
  if (!frame) return true;
  return area.x < frame.x + frame.width && area.x + area.width > frame.x && area.y < frame.y + frame.height && area.y + area.height > frame.y;
}

/**
 * A pinned module (not the one being edited) with a part among `ids`: the
 * selection can't be moved or turned as a whole. Null when nothing is pinned.
 */
export function pinnedAmong(ids: readonly string[], modules: readonly SidecarModule[], editingId: string | null): SidecarModule | null {
  if (ids.length === 0) return null;
  const set = new Set(ids);
  for (const m of modules) {
    if (!m.pinned || m.id === editingId) continue;
    if (m.members.some((id) => set.has(id))) return m;
  }
  return null;
}

/** Whether a part can be dragged: not out of reach, and not in a pinned module (unless editing it). */
export function canDragPart(partId: string, modules: readonly SidecarModule[], editingId: string | null): boolean {
  if (outsideEdit(partId, modules, editingId)) return false;
  return pinnedAmong([partId], modules, editingId) === null;
}

/** Pins a module in place or lets it go (not pinned is the default, so it isn't written). */
export function withPinned(m: SidecarModule, pinned: boolean): SidecarModule {
  const out: SidecarModule = { ...m };
  delete out.pinned;
  return pinned ? { ...out, pinned: true } : out;
}

/** The module with `ids` added (new parts dropped in while it's edited join it). */
export function withMembersAdded(m: SidecarModule, ids: readonly string[]): SidecarModule {
  const have = new Set(m.members);
  const add = ids.filter((id) => !have.has(id));
  return add.length === 0 ? m : { ...m, members: [...m.members, ...add] };
}

/** The module without `ids` (parts taken out of it). */
export function withMembersRemoved(m: SidecarModule, ids: readonly string[]): SidecarModule {
  const drop = new Set(ids);
  return { ...m, members: m.members.filter((id) => !drop.has(id)) };
}

export interface StudRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bounds of `ids` among `areas` (each part's display area, studs); null when none. */
export function boundsOf(ids: Iterable<string>, areas: ReadonlyMap<string, StudRect>): StudRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const a = areas.get(id);
    if (!a) continue;
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  return isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Whether a part dropped at `area` is clear of the module's outline (no overlap at all). */
export function outsideOutline(area: StudRect, outline: StudRect): boolean {
  return (
    area.x >= outline.x + outline.width ||
    area.x + area.width <= outline.x ||
    area.y >= outline.y + outline.height ||
    area.y + area.height <= outline.y
  );
}

/** "Sam is here too", "Sam and Alex are here too", "Sam, Alex and 2 others are here too"; '' for nobody. */
export function hereTooText(names: readonly string[]): string {
  const n = [...new Set(names)];
  if (n.length === 0) return '';
  if (n.length === 1) return `${n[0]} is here too`;
  if (n.length === 2) return `${n[0]} and ${n[1]} are here too`;
  const rest = n.length - 2;
  return `${n[0]}, ${n[1]} and ${rest === 1 ? 'one other' : `${rest} others`} are here too`;
}
