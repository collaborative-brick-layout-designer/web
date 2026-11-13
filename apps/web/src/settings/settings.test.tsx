// Settings shows what people can change, and nothing held back for later
// (Expert mode is skipped in this first round of the redesign).

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsContent } from './SettingsPage';

describe('Settings', () => {
  it('offers the look, color, text size and help, without Expert mode', () => {
    render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('Look and feel').length).toBeGreaterThan(0);
    expect(screen.getByText('Bigger text and buttons')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show help buttons' })).toBeTruthy();
    expect(screen.queryByText(/Expert mode/)).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Expert mode' })).toBeNull();
  });

  it('offers the Snap strength under Editing, Gentle until changed', () => {
    const { container } = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    const view = within(container);
    expect(view.getAllByText('Editing').length).toBeGreaterThan(0);
    const group = view.getByRole('radiogroup', { name: 'Snap strength' });
    const radios = group.querySelectorAll('[role="radio"]');
    expect([...radios].map((r) => r.querySelector('span')?.textContent)).toEqual(['Off', 'Gentle', 'Strong']);
    expect(view.getByTestId('snap-strength-gentle').getAttribute('aria-checked')).toBe('true');
    expect(view.getByTestId('snap-strength-strong').getAttribute('aria-checked')).toBe('false');
  });
});

describe('grid snap and rotation step (a phone has no toolbar for them)', () => {
  it('sets the editor steps from Settings › Editing, and remembers them', async () => {
    const { useEditorStore } = await import('../editor/editorStore');
    const { act, fireEvent } = await import('@testing-library/react');
    const { container } = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    const view = within(container);
    const snap = view.getByTestId('settings-snap-step') as HTMLSelectElement;
    expect([...snap.options].map((o) => o.textContent)).toContain('1 stud');
    fireEvent.change(snap, { target: { value: '8' } });
    expect(useEditorStore.getState().snapStepStuds).toBe(8);
    expect(localStorage.getItem('cld:snapStepStuds')).toBe('8');
    fireEvent.change(view.getByTestId('settings-rotation-step'), { target: { value: '45' } });
    expect(useEditorStore.getState().rotationStepDegrees).toBe(45);
    // A change made in the editor's toolbar shows here at once.
    act(() => useEditorStore.getState().setSnapStep(0));
    expect(snap.value).toBe('0');
  });
});

describe('snap trace (hidden)', () => {
  it('stays hidden until /settings?snaptrace=1 turns it on, and Turn off hides it again', async () => {
    const { setSnapTraceEnabled } = await import('../editor/snapTrace');
    setSnapTraceEnabled(false);
    const first = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    expect(within(first.container).queryByTestId('snap-trace')).toBeNull();
    first.unmount();
    window.history.replaceState(null, '', '/settings?snaptrace=1');
    const second = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    const row = within(second.container).getByTestId('snap-trace');
    expect(row.textContent).toContain('Snap trace is on');
    within(row).getByRole('button', { name: 'Turn off' }).click();
    window.history.replaceState(null, '', '/settings');
    await new Promise((r) => setTimeout(r, 0));
    expect(within(second.container).queryByTestId('snap-trace')).toBeNull();
    expect(localStorage.getItem('cld:snapTrace')).toBeNull();
  });
});

describe('Color: any LEGO color and how much color', () => {
  it('opens a searchable list of LEGO colors with LEGO and BrickLink names', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { container } = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    const view = within(container);
    expect(view.queryByTestId('lego-color-picker')).toBeNull();
    fireEvent.click(view.getByTestId('lego-color-toggle'));
    const picker = view.getByTestId('lego-color-picker');
    const list = within(picker).getByRole('radiogroup', { name: 'Any LEGO color' });
    expect(within(list).getAllByRole('radio').length).toBeGreaterThan(100);
    const search = within(picker).getByRole('searchbox');
    // By BrickLink name...
    fireEvent.change(search, { target: { value: 'dark blue' } });
    expect(within(list).getByRole('radio', { name: /^Earth Blue \(LEGO 140\), BrickLink: Dark Blue \(63\)/ })).toBeTruthy();
    // ...by LEGO number...
    fireEvent.change(search, { target: { value: '24' } });
    expect(within(list).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toContain('Bright Yellow (LEGO 24), BrickLink: Yellow (3)');
    // ...and nothing found offers the way back.
    fireEvent.change(search, { target: { value: 'trans clear' } });
    expect(within(picker).getByRole('status').textContent).toMatch(/No LEGO color matches/);
    fireEvent.click(within(picker).getByRole('button', { name: 'Show all colors' }));
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('offers the whole app (the default, listed first) or just the highlights (the original look)', () => {
    const { container } = render(
      <MemoryRouter>
        <SettingsContent />
      </MemoryRouter>,
    );
    const view = within(container);
    const group = view.getByRole('radiogroup', { name: 'How much color' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBe(view.getByTestId('color-style-full'));
    expect(view.getByTestId('color-style-full').getAttribute('aria-checked')).toBe('true');
    expect(view.getByTestId('color-style-original').getAttribute('aria-checked')).toBe('false');
    expect(view.getByTestId('color-style-original').textContent).toMatch(/original look/);
  });

  it('reads an unmarked "original" as the whole app, and a pick marks it as chosen', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { PrefsContext } = await import('../theme/PrefsProvider');
    const { DEFAULT_PREFERENCES } = await import('../theme/theme');
    const setPrefs = vi.fn();
    const show = (extra: object) =>
      render(
        <PrefsContext.Provider
          value={{ prefs: { ...DEFAULT_PREFERENCES, ...extra }, mode: 'light', setPrefs, syncedToAccount: true, updatedAt: null, ready: true }}
        >
          <MemoryRouter>
            <SettingsContent />
          </MemoryRouter>
        </PrefsContext.Provider>,
      );
    // Every save used to store "original", chosen or not.
    let view = within(show({ colorStyle: 'original' }).container);
    expect(view.getByTestId('color-style-full').getAttribute('aria-checked')).toBe('true');
    expect(view.getByTestId('color-style-original').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(view.getByTestId('color-style-original'));
    expect(setPrefs).toHaveBeenCalledWith({ colorStyle: 'original', colorStyleChosen: true });
    fireEvent.click(view.getByTestId('color-style-full'));
    expect(setPrefs).toHaveBeenCalledWith({ colorStyle: 'full', colorStyleChosen: true });
    // Picked in Settings: kept.
    view = within(show({ colorStyle: 'original', colorStyleChosen: true }).container);
    expect(view.getByTestId('color-style-original').getAttribute('aria-checked')).toBe('true');
  });
});

describe('matchesLegoColor', () => {
  it('finds a color by either name, either number, and "grey" or "gray"', async () => {
    const { matchesLegoColor } = await import('./LegoColorPicker');
    const { legoColor } = await import('@cld/model');
    const lbg = legoColor(194)!; // Medium Stone Grey / Light Bluish Gray
    expect(matchesLegoColor(lbg, 'medium stone gray')).toBe(true);
    expect(matchesLegoColor(lbg, 'Light Bluish Grey')).toBe(true);
    expect(matchesLegoColor(lbg, '194')).toBe(true);
    expect(matchesLegoColor(lbg, '86')).toBe(true);
    expect(matchesLegoColor(lbg, '19')).toBe(false);
    expect(matchesLegoColor(lbg, 'red')).toBe(false);
  });

  it('finds the BrickLink matches Rebrickable filled in, by BrickLink name or number', async () => {
    const { matchesLegoColor } = await import('./LegoColorPicker');
    const { legoColor, LEGO_COLORS } = await import('@cld/model');
    const lemon = legoColor(15)!; // Lemon, BrickLink Lemon (171): Studio had none
    expect(lemon.blId).toBe(171);
    expect(matchesLegoColor(lemon, '171')).toBe(true);
    const lilac = legoColor(220)!; // Light Lilac, BrickLink 246
    expect(matchesLegoColor(lilac, '246')).toBe(true);
    // Where Studio and Rebrickable differ, Rebrickable's BrickLink match.
    expect(legoColor(179)).toMatchObject({ blId: 239, bl: 'Bionicle Silver' });
    expect(legoColor(196)).toMatchObject({ blId: 109, bl: 'Dark Blue-Violet' });
    expect(matchesLegoColor(legoColor(196)!, 'dark blue-violet')).toBe(true);
    // Only four LEGO colors are left without a BrickLink match, each with no name either.
    const none = LEGO_COLORS.filter((c) => c.blId === 0);
    expect(none.map((c) => c.id).sort((a, b) => a - b)).toEqual([13, 131, 296, 337]);
    expect(none.every((c) => c.bl === '')).toBe(true);
  });
});
