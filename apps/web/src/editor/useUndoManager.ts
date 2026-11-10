// Per-user undo/redo via Y.UndoManager.
//
// Y.UndoManager scopes by `trackedOrigins`: only transactions whose origin
// matches an entry in the set are reversible. Phase 4 (realtime collab)
// will swap LOCAL_ORIGIN for the y-websocket clientID so each user only
// undoes their OWN edits, not their collaborators'. For Phase 3 (single
// user), LOCAL_ORIGIN is enough — every mutation goes through that origin.
//
// Scope: `layerData` (every brick/text/area/ruler edit), the `layers`
// order array (add/delete/reorder layer — without it, undoing deleteLayer
// restored the layer's data but not its id in the order, leaving an
// invisible layer) and `meta` (general info, background color, and the
// sidecar cache: venue, anchored labels, modules, background image) and
// `sidecarItems` (each module and anchored label under its own key, which
// is what readers use once two people's changes are merged: undoing only
// meta.cache left a label someone else's edit had merged in, see
// @cld/ydoc readSidecarCache).
// Connectivity write-backs use their own untracked origin, and remote
// updates carry the provider as origin, so neither lands on the stack.

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { useEditorStore } from './editorStore';
import { isEditableTarget } from './keyboardGuard';
import { brickIdsInDoc } from './mixedSelection';

export interface UndoState {
  manager: Y.UndoManager | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/** Build the editor's UndoManager for `doc` (scope + origins above). */
export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(
    [doc.getMap('layerData'), doc.getArray('layers'), doc.getMap('meta'), doc.getMap('sidecarItems')],
    {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      // 200ms group means rapid keypress-driven edits (e.g. holding Q) all
      // collapse into one undo step. Larger drag operations are already
      // single transactions, so this only affects micro-edits.
      captureTimeout: 200,
    },
  );
}

/** Said when an undo or redo found nothing left to change (the desktop says the same). */
export const NOTHING_TO_UNDO = 'Someone else changed that after you, so there was nothing to undo.';
export const NOTHING_TO_REDO = 'Someone else changed that after you, so there was nothing to redo.';

/**
 * Undo or redo, then pick the parts it brought back (an undone Delete, a
 * redone paste), as BlueBrick does. Nothing came back: the selection stays.
 *
 * A step someone else has changed since (they moved the part you moved) is
 * dropped by Yjs without changing anything and without the event the
 * buttons listen for: `after` refreshes them, and the editor says why
 * nothing happened. Returns whether the layout changed.
 */
export function undoAndPick(doc: Y.Doc, manager: Y.UndoManager, which: 'undo' | 'redo', after?: () => void): boolean {
  const had = which === 'undo' ? manager.canUndo() : manager.canRedo();
  const before = brickIdsInDoc(doc);
  let changed = false;
  const onUpdate = (): void => {
    changed = true;
  };
  doc.on('update', onUpdate);
  try {
    if (which === 'undo') manager.undo();
    else manager.redo();
  } finally {
    doc.off('update', onUpdate);
  }
  after?.();
  if (had && !changed) {
    useEditorStore.getState().showNotice(which === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO, 'error', 7000);
    return false;
  }
  const back = [...brickIdsInDoc(doc)].filter((id) => !before.has(id));
  if (back.length > 0) useEditorStore.getState().setSelection(back);
  return changed;
}

export function useUndoManager(doc: Y.Doc | null): UndoState {
  const [state, setState] = useState<UndoState>({
    manager: null,
    canUndo: false,
    canRedo: false,
    undo: noop,
    redo: noop,
  });
  useEffect(() => {
    if (!doc) {
      setState({ manager: null, canUndo: false, canRedo: false, undo: noop, redo: noop });
      return;
    }

    const manager = createUndoManager(doc);
    const d = doc;

    const updateState = () => {
      // Prune undo stack to configured depth (0 = unlimited, default 100).
      const limit = useEditorStore.getState().undoStackDepth;
      if (limit > 0 && manager.undoStack.length > limit) {
        manager.undoStack.splice(0, manager.undoStack.length - limit);
      }
      setState({
        manager,
        canUndo: manager.canUndo(),
        canRedo: manager.canRedo(),
        undo: () => void undoAndPick(d, manager, 'undo', updateState),
        redo: () => void undoAndPick(d, manager, 'redo', updateState),
      });
    };

    manager.on('stack-item-added', updateState);
    manager.on('stack-item-popped', updateState);
    updateState();

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoAndPick(d, manager, 'undo', updateState);
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        undoAndPick(d, manager, 'redo', updateState);
      }
    }
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      manager.destroy();
    };
  }, [doc]);

  return state;
}

function noop(): void {
  // intentional
}
