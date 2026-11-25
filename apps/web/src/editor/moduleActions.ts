// Make a module (Map ▸ Modules & sets, the context menu, the Modules panel
// and the phone's touch bar): the picked parts become a module in this
// layout. The dialog names it (ModuleDialogs.tsx); saving it to the Module library
// is a separate step, from the placed module's ⋯ menu (or the dialog's
// "Also save to my Module library").

import type * as Y from 'yjs';
import { modulePlaces, PLACE_LIMITS, withPlaces, type SidecarModule } from '@cld/bbm';
import { readSidecarFromDoc } from '@cld/ydoc';
import { useEditorStore } from './editorStore';
import { bricksByLayer, deleteSidecarModule, updateSidecarModule } from './mutations';
import { pinnedAmong, withMembersAdded, withMembersRemoved, withPinned } from './moduleEdit';
import { projectDoc } from './useDocMap';
import { moduleLocked } from './sharedLock';

/** Opens Make a module for the picked parts (says so when none are picked). */
export function openMakeModule(doc: Y.Doc): void {
  const { selection } = useEditorStore.getState();
  // Only parts can be in a module.
  const map = projectDoc(doc);
  const members = map ? [...bricksByLayer(map, selection).values()].flat() : [];
  if (members.length === 0) {
    useEditorStore.getState().showNotice('Select one or more parts first, then choose Make a module.');
    return;
  }
  useEditorStore.getState().setModuleDialog({ kind: 'make' });
}

// ---------------------------------------------------------------------------
// Edit module and Pin in place (moduleEdit.ts has the rules).
// ---------------------------------------------------------------------------

/** Opens a module to change it part by part; `partId` (the part double-clicked) is picked. */
export function enterModuleEdit(doc: Y.Doc, id: string, partId?: string): void {
  const st = useEditorStore.getState();
  // A shared module's parts are its owner's (sharedLock.ts): it says why instead.
  if (moduleLocked(doc, id, 'edit')) return;
  st.setEditingModule(id);
  if (partId) st.setSelection([partId]);
}

/** Back to editing the whole layout. */
export function leaveModuleEdit(): void {
  useEditorStore.getState().setEditingModule(null);
}

/** New parts placed while a module is edited join it (one undo step with the placing, when inside its transaction). */
export function joinEditedModule(doc: Y.Doc, ids: readonly string[]): void {
  const id = useEditorStore.getState().editingModuleId;
  if (!id || ids.length === 0) return;
  updateSidecarModule(doc, id, (m) => withMembersAdded(m, ids));
}

/** Takes parts out of a module (they stay on the map, on their own). */
export function takeOutOfModule(doc: Y.Doc, moduleId: string, ids: readonly string[]): void {
  updateSidecarModule(doc, moduleId, (m) => withMembersRemoved(m, ids));
}

export function setModulePinned(doc: Y.Doc, id: string, pinned: boolean): void {
  updateSidecarModule(doc, id, (m) => withPinned(m, pinned));
}

/** Says why a move didn't happen: the module is pinned in place. */
export function tellPinned(m: SidecarModule): void {
  useEditorStore
    .getState()
    .showNotice(`“${m.name || 'This module'}” is pinned in place. Unpin it from its ⋯ menu to move it, or use Edit module to change its parts.`, 'error', 6000);
}

/**
 * Whether the selection may move or turn as a whole; tells the person
 * when a pinned module stops it.
 */
export function selectionMayMove(doc: Y.Doc, ids: readonly string[]): boolean {
  const pinned = pinnedAmong(ids, readSidecarFromDoc(doc)?.modules ?? [], useEditorStore.getState().editingModuleId);
  if (pinned) tellPinned(pinned);
  return !pinned;
}

/**
 * Parts placed while a module is edited join it. A set or a library
 * module dropped in arrives as a module of its own: that one is dissolved
 * into the edited module (no module inside a module).
 */
export function absorbIntoEditedModule(doc: Y.Doc, ids: readonly string[]): void {
  const editing = useEditorStore.getState().editingModuleId;
  if (!editing || ids.length === 0) return;
  const placed = new Set(ids);
  doc.transact(() => {
    for (const m of readSidecarFromDoc(doc)?.modules ?? []) {
      if (m.id !== editing && m.members.length > 0 && m.members.every((id) => placed.has(id))) {
        // Its places become the edited module's.
        const places = modulePlaces(m);
        deleteSidecarModule(doc, m.id, false);
        if (places.length > 0) updateSidecarModule(doc, editing, (e) => withPlaces(e, [...modulePlaces(e), ...places].slice(0, PLACE_LIMITS.places)));
      }
    }
    joinEditedModule(doc, ids);
  });
}
