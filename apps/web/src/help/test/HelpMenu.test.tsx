// The top bar's Help menu: Getting started, Keyboard shortcuts, and
// turning the "?" buttons off or on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpMenu } from '../../editor/EditorChrome';
import { PrefsContext } from '../../theme/PrefsProvider';
import { DEFAULT_PREFERENCES } from '../../theme/theme';

afterEach(cleanup);

function setup(helpIcons: boolean) {
  const setPrefs = vi.fn();
  render(
    <MemoryRouter>
      <PrefsContext.Provider
        value={{ prefs: { ...DEFAULT_PREFERENCES, helpIcons }, mode: 'light', setPrefs, syncedToAccount: false, updatedAt: null, ready: true }}
      >
        <HelpMenu />
      </PrefsContext.Provider>
    </MemoryRouter>,
  );
  return { setPrefs, user: userEvent.setup() };
}

describe('Help menu', () => {
  it('lists Getting started, Keyboard shortcuts and turning help buttons off', async () => {
    const { user, setPrefs } = setup(true);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('button', { name: 'Getting started' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn help buttons off' }));
    expect(setPrefs).toHaveBeenCalledWith({ helpIcons: false });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('offers to turn them back on when they are off', async () => {
    const { user, setPrefs } = setup(false);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(screen.getByRole('button', { name: 'Turn help buttons on' }));
    expect(setPrefs).toHaveBeenCalledWith({ helpIcons: true });
  });

  it('shows the shortcuts and first steps, and Esc closes back to the Help button', async () => {
    const { user } = setup(true);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByText('Turn the selected pieces left (counterclockwise)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '← Help' }));
    await user.click(screen.getByRole('button', { name: 'Getting started' }));
    expect(screen.getByText(/Drag a part from the Parts panel/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Help' }));
  });
});
