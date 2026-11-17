// Modules act as one piece; Edit module opens one part by part; Pin in
// place stops it moving as a whole (moduleEdit.ts, moduleActions.ts and
// the editor store's selection shaper).

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { readSidecarFromDoc } from '@cld/ydoc';
import {
  boundsOf,
  canDragPart,
  hereTooText,
  moduleByPart,
  outsideEdit,
  outsideOutline,
  pinnedAmong,
  selectionUnit,
  shapeSelection,
  withMembersAdded,
  withMembersRemoved,
  withPinned,
} from '../moduleEdit';
import { absorbIntoEditedModule, enterModuleEdit, joinEditedModule, leaveModuleEdit, selectionMayMove, setModulePinned, takeOutOfModule } from '../moduleActions';
import { setSelectionShaper, useEditorStore } from '../editorStore';
import { addSidecarModule, createSidecarModule } from '../mutations';

const mod = (id: string, members: string[], extra: Partial<SidecarModule> = {}): SidecarModule => ({
  id,
  name: id.toUpperCase(),
  members,
  transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  ...extra,
});
const A = mod('a', ['a1', 'a2', 'a3']);
const B = mod('b', ['b1', 'b2'], { pinned: true });
const modules = [A, B];

afterEach(() => {
  setSelectionShaper(null);
  useEditorStore.setState({ editingModuleId: null, selection: [] });
});

describe('a module is one piece', () => {
  it('any of its parts brings the whole module into the selection', () => {
    expect(shapeSelection(['a2'], modules, null)).toEqual(['a2', 'a1', 'a3']);
    expect(shapeSelection(['x', 'b2'], modules, null)).toEqual(['x', 'b2', 'b1']);
    expect(shapeSelection(['x'], modules, null)).toEqual(['x']);
    expect(moduleByPart(modules).get('b1')?.id).toBe('b');
  });

  it('a click picks the whole module, else the BlueBrick group, else the part', () => {
    expect(selectionUnit('a1', modules, null, ['a1', 'q'])).toEqual(['a1', 'a2', 'a3']);
    expect(selectionUnit('x', modules, null, ['x', 'y'])).toEqual(['x', 'y']);
    expect(selectionUnit('x', modules, null, [])).toEqual(['x']);
  });

  it('box-select and every other pick go through the store as whole modules', () => {
    setSelectionShaper((ids) => shapeSelection(ids, modules, useEditorStore.getState().editingModuleId));
    useEditorStore.getState().setSelection(['a3', 'x']);
    expect(new Set(useEditorStore.getState().selection)).toEqual(new Set(['a1', 'a2', 'a3', 'x']));
    useEditorStore.getState().setMixedSelection(['b1'], { rulers: ['r'], labels: [], texts: [] });
    expect(new Set(useEditorStore.getState().selection)).toEqual(new Set(['b1', 'b2']));
  });
});

describe('Edit module', () => {
  it('picks the edited module’s parts one by one and nothing outside it', () => {
    expect(selectionUnit('a1', modules, 'a', [])).toEqual(['a1']);
    expect(shapeSelection(['a1', 'b1', 'x'], modules, 'a')).toEqual(['a1']);
    expect(outsideEdit('b1', modules, 'a')).toBe(true);
    expect(outsideEdit('x', modules, 'a')).toBe(true);
    expect(outsideEdit('a2', modules, 'a')).toBe(false);
    expect(outsideEdit('b1', modules, null)).toBe(false);
  });

  it('entering clears the selection (or picks the double-clicked part) and leaving clears it again', () => {
    setSelectionShaper((ids) => shapeSelection(ids, modules, useEditorStore.getState().editingModuleId));
    useEditorStore.getState().setSelection(['a1']);
    enterModuleEdit(new Y.Doc(), 'a', 'a2');
    expect(useEditorStore.getState().editingModuleId).toBe('a');
    expect(useEditorStore.getState().selection).toEqual(['a2']);
    // Box-select inside it picks only its parts.
    useEditorStore.getState().setSelection(['a1', 'a3', 'b1']);
    expect(useEditorStore.getState().selection).toEqual(['a1', 'a3']);
    leaveModuleEdit();
    expect(useEditorStore.getState().editingModuleId).toBeNull();
    expect(useEditorStore.getState().selection).toEqual([]);
  });

  it('new parts join the edited module, and a set or module dropped in melts into it', () => {
    const doc = new Y.Doc();
    const id = createSidecarModule(doc, 'Harbour', ['p1'])!;
    joinEditedModule(doc, ['p2']);
    expect(readSidecarFromDoc(doc)!.modules![0]!.members).toEqual(['p1']); // not editing: nothing joins
    useEditorStore.getState().setEditingModule(id);
    joinEditedModule(doc, ['p2']);
    // A set placed while editing arrives as a module of its own…
    const setId = createSidecarModule(doc, 'Set', ['s1', 's2'])!;
    absorbIntoEditedModule(doc, ['s1', 's2']);
    const mods = readSidecarFromDoc(doc)!.modules!;
    expect(mods.map((m) => m.id)).toEqual([id]);
    expect(setId).not.toBe(id);
    expect(mods[0]!.members).toEqual(['p1', 'p2', 's1', 's2']);
  });

  it('a part dragged clear of the outline can be taken out', () => {
    const outline = { x: 0, y: 0, width: 10, height: 10 };
    expect(outsideOutline({ x: 10, y: 0, width: 2, height: 2 }, outline)).toBe(true);
    expect(outsideOutline({ x: 9, y: 9, width: 2, height: 2 }, outline)).toBe(false);
    expect(outsideOutline({ x: -3, y: 4, width: 3, height: 2 }, outline)).toBe(true);
    expect(outsideOutline({ x: 4, y: -2, width: 2, height: 2 }, outline)).toBe(true);
    expect(outsideOutline({ x: 4, y: 10, width: 2, height: 2 }, outline)).toBe(true);
    const doc = new Y.Doc();
    const id = createSidecarModule(doc, 'Harbour', ['p1', 'p2'])!;
    takeOutOfModule(doc, id, ['p2']);
    expect(readSidecarFromDoc(doc)!.modules![0]!.members).toEqual(['p1']);
    expect(withMembersRemoved(A, ['a1', 'zz']).members).toEqual(['a2', 'a3']);
    expect(withMembersAdded(A, ['a1', 'n']).members).toEqual(['a1', 'a2', 'a3', 'n']);
    expect(withMembersAdded(A, ['a1'])).toBe(A);
    expect(boundsOf(['a', 'b', 'c'], new Map([['a', { x: 0, y: 0, width: 2, height: 2 }], ['b', { x: 5, y: -1, width: 1, height: 1 }]]))).toEqual({
      x: 0,
      y: -1,
      width: 6,
      height: 3,
    });
    expect(boundsOf(['z'], new Map())).toBeNull();
  });

  it('says who else is editing the same module', () => {
    expect(hereTooText([])).toBe('');
    expect(hereTooText(['Sam'])).toBe('Sam is here too');
    expect(hereTooText(['Sam', 'Sam'])).toBe('Sam is here too');
    expect(hereTooText(['Sam', 'Alex'])).toBe('Sam and Alex are here too');
    expect(hereTooText(['Sam', 'Alex', 'Jo'])).toBe('Sam, Alex and one other are here too');
    expect(hereTooText(['Sam', 'Alex', 'Jo', 'Kim'])).toBe('Sam, Alex and 2 others are here too');
    // The desktop says the same (core/ModuleEdit.h).
  });
});

describe('Pin in place', () => {
  it('a pinned module can’t be dragged or moved as a whole, but its parts can while it’s edited', () => {
    expect(pinnedAmong(['b1'], modules, null)?.id).toBe('b');
    expect(pinnedAmong(['a1', 'x'], modules, null)).toBeNull();
    expect(pinnedAmong([], modules, null)).toBeNull();
    expect(canDragPart('b1', modules, null)).toBe(false);
    expect(canDragPart('a1', modules, null)).toBe(true);
    expect(canDragPart('b1', modules, 'b')).toBe(true);
    expect(pinnedAmong(['b1'], modules, 'b')).toBeNull();
    // While another module is edited, everything outside it is out of reach.
    expect(canDragPart('x', modules, 'a')).toBe(false);
  });

  it('is saved on the module, and stops a move with a message', () => {
    const doc = new Y.Doc();
    addSidecarModule(doc, mod('m', ['p1', 'p2']));
    setModulePinned(doc, 'm', true);
    expect(readSidecarFromDoc(doc)!.modules![0]!.pinned).toBe(true);
    expect(selectionMayMove(doc, ['p1'])).toBe(false);
    expect(useEditorStore.getState().notice?.text).toMatch(/pinned in place/);
    expect(selectionMayMove(doc, ['zz'])).toBe(true);
    useEditorStore.getState().setEditingModule('m');
    expect(selectionMayMove(doc, ['p1'])).toBe(true);
    setModulePinned(doc, 'm', false);
    expect('pinned' in readSidecarFromDoc(doc)!.modules![0]!).toBe(false);
    expect(withPinned(withPinned(A, true), false)).toEqual(A);
  });
});
