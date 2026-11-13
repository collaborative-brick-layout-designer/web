// The hand-drawn menus (Sheets, Parts, Modules): closing one gives the focus
// back, unless the item chosen put it somewhere (Rename…'s name box).

import { afterEach, describe, expect, it } from 'vitest';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMenuRoles } from '../useMenuRoles';

afterEach(cleanup);

function Row() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMenuRoles(ref, open, 'Sheet Parts', () => setOpen(false));
  return (
    <div>
      <button onClick={() => setOpen(true)}>Sheet</button>
      {editing && <input aria-label="Name" autoFocus onBlur={() => setEditing(false)} />}
      {open && (
        <div ref={ref}>
          <button onClick={() => { setEditing(true); setOpen(false); }}>Rename…</button>
          <button onClick={() => setOpen(false)}>Move up</button>
        </div>
      )}
    </div>
  );
}

describe('useMenuRoles', () => {
  it('gives the focus back to where it was when the menu closes', () => {
    render(<Row />);
    const sheet = screen.getByRole('button', { name: 'Sheet' });
    sheet.focus();
    fireEvent.click(sheet);
    expect(document.activeElement?.textContent).toBe('Rename…');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(sheet);
  });

  it('leaves the focus in a box the chosen item opened, so Rename… can be typed in', () => {
    render(<Row />);
    const sheet = screen.getByRole('button', { name: 'Sheet' });
    sheet.focus();
    fireEvent.click(sheet);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(document.activeElement).toBe(name);
  });
});
