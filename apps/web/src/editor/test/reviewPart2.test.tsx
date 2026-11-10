// Area 3 review, part 2: the status bar's map size, a new background
// picture fitted over the layout (and its removal not an undo step), an
// empty module's words, the Budget window's names and close button, the
// Budget reached words, the hand-drawn menus' roles and keys, and the touch
// bar saying how many are picked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createDefaultLayoutDoc, readSidecarFromDoc } from '@cld/ydoc';
import { studDisplay } from '../scaleBar';
import { fitImageRect } from '../background';
import { clearBackgroundImage, setBackgroundImage } from '../mutations';
import { createUndoManager } from '../useUndoManager';
import { EMPTY_MODULE, fetchModuleBatches } from '../moduleSnapshot';
import { BudgetDialog } from '../BudgetDialog';
import { BudgetReachedDialog } from '../BudgetReachedDialog';
import { useMenuRoles } from '../../ui/menu/useMenuRoles';
import { TouchActionBar } from '../TouchEdit';
import { useEditorStore } from '../editorStore';
import * as Y from 'yjs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useEditorStore.setState({ selection: [], touchSelectMore: false, touchSelectArea: false });
});

describe('status bar size', () => {
  it('rounds to one place, whole studs as they are, meters from 100', () => {
    expect(studDisplay(36.974999999999994)).toBe('37.0 st');
    expect(studDisplay(16)).toBe('16 st');
    expect(studDisplay(250)).toBe('2.0 m');
  });
});

describe('background picture', () => {
  it('a new picture is fitted over the parts, keeping its shape and centred', () => {
    // 400 x 200 px picture over a 100 x 100 stud layout: 100 wide, 50 high, in the middle.
    expect(fitImageRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 200 })).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    // An empty map: its own size (8 px a stud) from the corner.
    expect(fitImageRect(null, { width: 80, height: 40 })).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });

  it('removing it is not an undo step (the file is gone from the server)', () => {
    const doc = createDefaultLayoutDoc();
    const um = createUndoManager(doc);
    setBackgroundImage(doc, { url: '/api/layouts/x/background-image', opacity: 0.5 });
    um.stopCapturing();
    clearBackgroundImage(doc, { untracked: true });
    expect(readSidecarFromDoc(doc)?.backgroundImage).toBeUndefined();
    um.undo();
    // Undo goes back past the add, never to a picture that's gone.
    expect(readSidecarFromDoc(doc)?.backgroundImage).toBeUndefined();
  });
});

describe('an empty module', () => {
  it('says it has no parts yet, in plain words', async () => {
    const empty = new Y.Doc();
    const bytes = Y.encodeStateAsUpdate(empty);
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes).buffer, { status: 200 }));
    await expect(fetchModuleBatches('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/./);
    const seeded = createDefaultLayoutDoc();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(Y.encodeStateAsUpdate(seeded)).buffer, { status: 200 }));
    await expect(fetchModuleBatches('00000000-0000-4000-8000-000000000000')).rejects.toThrow(EMPTY_MODULE);
  });
});

describe('Budget', () => {
  it('names the parts and labels its close button', () => {
    render(
      <BudgetDialog
        map={null}
        limits={new Map([['3001.1', 2]])}
        onLimitsChange={() => {}}
        partName={(id) => (id.toLowerCase() === '3001.1' ? 'Brick 2 x 4' : undefined)}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Brick 2 x 4')).toBeTruthy();
    expect(screen.getByText('3001.1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close the budget' })).toBeTruthy();
  });

  it('Budget reached says what to do on the web, not BlueBrick words', () => {
    render(<BudgetReachedDialog onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Budget reached' });
    expect(dialog.textContent).toContain('Stop at the budget limits');
    expect(dialog.textContent).not.toMatch(/Budget Limitation|budget file/);
  });
});

function HandMenu({ onClosed }: { onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useMenuRoles(ref, open, 'Sheet Track', () => {
    setOpen(false);
    onClosed();
  });
  if (!open) return null;
  return (
    <div ref={ref}>
      <button>Hide sheet</button>
      <hr />
      <button>Rename</button>
    </div>
  );
}

describe('hand-drawn menus', () => {
  it('are menus with items, take the focus, move with the arrows and close with Esc', () => {
    const closed = vi.fn();
    render(<HandMenu onClosed={closed} />);
    const menu = screen.getByRole('menu', { name: 'Sheet Track' });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide sheet', 'Rename']);
    expect(document.activeElement?.textContent).toBe('Hide sheet');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Rename');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(closed).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('the touch bar', () => {
  const actions = { rotate: () => {}, duplicate: () => {}, delete: () => {} } as never;
  it('says how many are picked, and when taps add more', () => {
    act(() => useEditorStore.setState({ selection: ['a', 'b'] }));
    render(<TouchActionBar actions={actions} onAddPart={() => {}} />);
    expect(screen.getByTestId('picked-count').textContent).toBe('2 picked');
    act(() => useEditorStore.setState({ touchSelectMore: true }));
    expect(screen.getByTestId('picked-count').textContent).toContain('Select more is on');
  });
});

describe('Edit module dim', () => {
  it('dims a part on its own only inside the module frame; beyond it the one overlay does', async () => {
    const { dimInEdit } = await import('../moduleEdit');
    const modules = [{ id: 'm1', members: ['a'] }] as never;
    const frame = { x: 0, y: 0, width: 10, height: 10 };
    // In the module: never dimmed.
    expect(dimInEdit('a', { x: 1, y: 1, width: 2, height: 2 }, modules, 'm1', frame)).toBe(false);
    // Outside the module, overlapping its frame: dimmed on its own.
    expect(dimInEdit('b', { x: 8, y: 8, width: 4, height: 4 }, modules, 'm1', frame)).toBe(true);
    // Beyond the frame: under the overlay, drawn as it is (no show-through).
    expect(dimInEdit('c', { x: 20, y: 20, width: 4, height: 4 }, modules, 'm1', frame)).toBe(false);
    // Not editing a module: nothing dims.
    expect(dimInEdit('c', { x: 20, y: 20, width: 4, height: 4 }, modules, null, null)).toBe(false);
  });
});
