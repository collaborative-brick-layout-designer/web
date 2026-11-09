// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenameDialog } from '../RenameDialog';
import { LayoutNameMenu } from '../../editor/EditorChrome';

afterEach(cleanup);

describe('renaming a layout', () => {
  it('saves the new name, trimmed, and closes', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    const view = render(<RenameDialog heading="Rename layout" current="Old yard" onSave={onSave} onClose={onClose} />);
    const input = view.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Old yard');
    fireEvent.change(input, { target: { value: '  New yard  ' } });
    fireEvent.click(view.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('New yard');
  });

  it('won’t save an empty name, and keeps the box open on a failure', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('')));
    const onClose = vi.fn();
    const view = render(<RenameDialog heading="Rename layout" current="Yard" onSave={onSave} onClose={onClose} />);
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    expect((view.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Yard 2' } });
    fireEvent.click(view.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(view.getByText(/Couldn’t rename it/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says why when the save gives a reason', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('There’s already a venue called “Hall”.')));
    const view = render(<RenameDialog heading="Rename venue" current="Gym" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Hall' } });
    fireEvent.click(view.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(view.getByText('There’s already a venue called “Hall”.')).toBeTruthy());
  });

  it('the layout name menu offers Rename… only when it may be renamed', () => {
    const onRename = vi.fn();
    const view = render(
      <MemoryRouter>
        <LayoutNameMenu title="Yard" onRename={onRename} />
      </MemoryRouter>,
    );
    fireEvent.click(view.getByRole('button', { name: /Yard/ }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Rename…' }));
    expect(onRename).toHaveBeenCalled();
    view.unmount();
    const viewer = render(
      <MemoryRouter>
        <LayoutNameMenu title="Yard" />
      </MemoryRouter>,
    );
    fireEvent.click(viewer.getByRole('button', { name: /Yard/ }));
    expect(viewer.queryByRole('menuitem', { name: 'Rename…' })).toBeNull();
  });
});
