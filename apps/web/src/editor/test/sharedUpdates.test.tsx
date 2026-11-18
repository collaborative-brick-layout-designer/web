// Shared modules, phase 2 (docs/shared-modules.md): the layout setting
// (Map › Modules & sets › Updates from shared modules…), "Updated while
// you were away" with Go back, and the layout lists' "2 updates" badge.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SharedPlaced } from '@cld/modules';
import { api } from '../../api';
import { awayLine, awayText, type AwayUpdate } from '../sharedModules';
import { SharedModulesBar } from '../SharedModulesBar';
import { SharedUpdatesDialog } from '../SharedUpdatesDialog';
import { SharedUpdatesBadge } from '../../layouts/LayoutsPage';
import { mapMenuEntries, phoneMapEntries, type MapMenuActions, type MapMenuToggles, type PhoneMapActions, type PhoneMapToggles } from '../mapMenu';
import { resolveMenu, type ResolvedEntry } from '../../ui/menu/menuModel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const placed = (o: Partial<SharedPlaced> = {}): SharedPlaced => ({
  placedId: 'p1', name: 'Harbor crane', moduleId: 'm', version: 9, by: 'Alice', server: null, placement: null, review: { from: 8, to: 9, at: 1 }, members: ['a'], ...o,
});
const noop = () => undefined;

describe('Updated while you were away', () => {
  it('says what went in, and that this layout takes them automatically', () => {
    const one: AwayUpdate = { placed: placed(), from: 7, to: 9 };
    expect(awayText([one])).toBe('“Harbor crane” went from version 7 to 9: this layout takes Alice’s updates automatically.');
    expect(awayText([{ ...one, from: null }])).toBe('“Harbor crane” is now version 9: this layout takes Alice’s updates automatically.');
    expect(awayText([{ ...one, placed: placed({ by: null }) }])).toContain('its owner’s updates');
    const two: AwayUpdate = { placed: placed({ placedId: 'p2', name: 'Tunnel', by: 'Dan' }), from: 2, to: 3 };
    expect(awayText([one, two])).toBe('2 shared modules were updated: this layout takes their owners’ updates automatically.');
    expect([one, two].map(awayLine)).toEqual(['“Harbor crane” v7 → v9', '“Tunnel” v2 → v3']);
  });

  it('the notice: Show, Go back to the version it had, OK; the module isn’t also told as "is now version 9"', () => {
    const onGoBack = vi.fn();
    const onAwayOk = vi.fn();
    const onShow = vi.fn();
    const p = placed();
    render(
      <SharedModulesBar
        updates={[]}
        reviews={[p]}
        away={[{ placed: p, from: 7, to: 9 }]}
        onAwayOk={onAwayOk}
        marks={{ p1: { overlaps: 2, looseEnds: 0 } }}
        canUpdate
        busy={false}
        onShow={onShow}
        onUpdate={noop}
        onGoBack={onGoBack}
        onOk={noop}
      />,
    );
    const card = screen.getByTestId('shared-module-away');
    expect(card.textContent).toContain('Updated while you were away');
    expect(card.textContent).toContain('“Harbor crane” went from version 7 to 9: this layout takes Alice’s updates automatically. It overlaps 2 parts.');
    expect(screen.queryByTestId('shared-module-updated')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(onShow).toHaveBeenCalledWith(['p1']);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to version 7' }));
    expect(onGoBack).toHaveBeenCalledWith(expect.objectContaining({ placedId: 'p1' }), 7);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onAwayOk).toHaveBeenCalledWith([expect.objectContaining({ from: 7, to: 9 })]);
  });

  it('someone who only views the layout reads it, with no Go back', () => {
    const p = placed();
    render(<SharedModulesBar updates={[]} reviews={[]} away={[{ placed: p, from: 7, to: 9 }]} canUpdate={false} busy={false} onShow={noop} onUpdate={noop} onGoBack={noop} onOk={noop} />);
    expect(screen.getByTestId('shared-module-away')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go back/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
  });
});

describe('the layout setting', () => {
  function withClient(ui: React.ReactElement) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  }
  const layout = (sharedModuleUpdates: 'ask' | 'auto') =>
    ({ layout: { id: 'L', title: 'Show plan', sharedModuleUpdates }, role: 'editor' }) as unknown as Awaited<ReturnType<typeof api.layouts.get>>;

  it('Ask first by default; choosing Automatically asks the server, with ⓘ help', async () => {
    vi.spyOn(api.layouts, 'get').mockResolvedValue(layout('ask'));
    const set = vi.spyOn(api.sharedModules, 'setUpdates').mockResolvedValue({ ok: true, updates: 'auto' });
    withClient(<SharedUpdatesDialog layoutId="L" readOnly={false} onClose={noop} />);
    const ask = await screen.findByRole('radio', { name: /Ask first/ });
    await waitFor(() => expect((ask as HTMLInputElement).checked).toBe(true));
    expect(screen.getByRole('dialog', { name: 'Updates from shared modules' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Automatically/ }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('L', 'auto'));
  });

  it('someone who can’t change the layout sees the choice, not the buttons', async () => {
    vi.spyOn(api.layouts, 'get').mockResolvedValue(layout('auto'));
    const set = vi.spyOn(api.sharedModules, 'setUpdates');
    withClient(<SharedUpdatesDialog layoutId="L" readOnly onClose={noop} />);
    const auto = await screen.findByRole('radio', { name: /Automatically/ });
    await waitFor(() => expect((auto as HTMLInputElement).checked).toBe(true));
    expect(auto.matches(':disabled')).toBe(true);
    expect(screen.getByText('Someone who can change this layout can change this.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Ask first/ }));
    expect(set).not.toHaveBeenCalled();
  });

  const items = (es: ResolvedEntry[]): string[] => es.flatMap((e) => (e.kind === 'separator' ? [] : e.kind === 'submenu' ? items(e.items) : [e.label]));
  const toggles = new Proxy({}, { get: () => ({ on: false, set: noop }) });

  it('is in Map › Modules & sets for a layout, not in a module’s own editor', () => {
    const actions = new Proxy({} as Record<string, () => void>, { get: (t, k: string) => (t[k] ??= vi.fn()) });
    const desk = (moduleMode: boolean) => items(resolveMenu(mapMenuEntries(actions as unknown as MapMenuActions, toggles as MapMenuToggles, 'Ctrl'), { moduleMode }));
    expect(desk(false)).toContain('Updates from shared modules…');
    expect(desk(true)).not.toContain('Updates from shared modules…');
    const phone = items(resolveMenu(phoneMapEntries(actions as unknown as PhoneMapActions, toggles as PhoneMapToggles, true), { moduleMode: false }));
    expect(phone).toContain('Updates from shared modules…');
    // Without the action (no layout on the server), it isn't offered.
    const none = { ...Object.fromEntries(['openFile', 'generalInfo'].map((k) => [k, noop])) } as unknown as MapMenuActions;
    const without = new Proxy(none as unknown as Record<string, unknown>, { get: (t, k: string) => (k === 'sharedModuleUpdates' ? undefined : (t[k] ?? noop)) });
    expect(items(resolveMenu(mapMenuEntries(without as unknown as MapMenuActions, toggles as MapMenuToggles, 'Ctrl'), { moduleMode: false }))).not.toContain('Updates from shared modules…');
  });
});

describe('the layout lists', () => {
  it('a badge says how many updates wait', () => {
    render(<SharedUpdatesBadge n={2} />);
    const b = screen.getByTestId('shared-updates-badge');
    expect(b.textContent).toContain('2 updates');
    expect(b.getAttribute('title')).toBe('2 shared modules in this layout have new versions. Open the layout to update them.');
    cleanup();
    render(<SharedUpdatesBadge n={1} />);
    expect(screen.getByTestId('shared-updates-badge').textContent).toContain('1 update');
  });
});
