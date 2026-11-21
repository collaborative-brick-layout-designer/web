// A module's table and power: heights typed and shown in the length unit,
// the Table and power dialog writing them on the placed module at once,
// the layout's summary for its coordinator, and the Module library
// carrying them both ways (saved with the parts; a placed copy gets them).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { readSidecarFromDoc } from '@cld/ydoc';
import { setupSummary } from '@cld/modules';
import type { SidecarModule } from '@cld/bbm';
import { addSidecarModule, ensureBrickLayer, importBricksAsModule, placeBrick, updateSidecarModule } from '../mutations';
import { PlacedModuleSetupDialog } from '../ModuleSetupDialog';
import { SetupSummaryBox } from '../ModulesPanel';
import { saveModuleToLibrary } from '../moduleLibrary';
import { formatHeight, parseHeightMm, powerText, summaryPowerText, summaryTableLines, tableText } from '../moduleSetupText';
import { useYjsSnapshot } from '../useYjsSnapshot';
import { PrefsContext, type PrefsContextValue } from '../../theme/PrefsProvider';
import { DEFAULT_PREFERENCES } from '../../theme/theme';

let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: input, body });
    const json = (status: number, out: unknown) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && input === '/api/modules') return json(201, { id: 'm1', title: 'Yard' });
    if (method === 'PUT' && input.startsWith('/api/modules/m1/snapshot')) return json(200, { updatedAt: 1, version: 1 });
    if (method === 'PATCH' && input === '/api/modules/m1') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function layout() {
  const doc = new Y.Doc();
  const layer = ensureBrickLayer(doc);
  const id = placeBrick(doc, layer, { partNumber: '3001', x: 0, y: 0, width: 4, height: 2 });
  addSidecarModule(doc, { id: 'pm', name: 'Yard', members: [id], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  return doc;
}
const yard = (doc: Y.Doc) => readSidecarFromDoc(doc)!.modules!.find((m) => m.id === 'pm')!;

describe('heights in the length unit', () => {
  it('reads what people type', () => {
    expect(parseHeightMm('30 3/4', 'ftin')).toBeCloseTo(781, 0);
    expect(parseHeightMm('32"', 'ftin')).toBeCloseTo(812.8, 0);
    expect(parseHeightMm("2' 8\"", 'ftin')).toBeCloseTo(812.8, 0);
    expect(parseHeightMm('78', 'm')).toBe(780);
    expect(parseHeightMm('0.78 m', 'm')).toBe(780);
    expect(parseHeightMm('98', 'studs')).toBe(784);
    for (const bad of ['', 'tall', '-3', '0', '400 m']) expect(parseHeightMm(bad, 'ftin')).toBeNull();
  });

  it('shows heights in inches, centimeters or studs', () => {
    const mm = parseHeightMm('30 3/4', 'ftin')!;
    expect(formatHeight(mm, 'ftin')).toBe('30¾″');
    expect(formatHeight(780, 'm')).toBe('78.0 cm');
    expect(formatHeight(784, 'studs')).toBe('98 studs');
  });

  it('says a table and power in a line', () => {
    expect(tableText({ type: 'mils', heightMm: 812.8, measuredTo: 'rail' }, 'ftin')).toBe('MILS · 32″ to the rails');
    expect(tableText({ type: 'baseplate' }, 'ftin')).toBe('Plain baseplate');
    expect(powerText({ needed: false })).toBe('No power');
    expect(powerText({ needed: true, outlets: 2, watts: 60, plugSide: 'back' })).toBe('Power: 2 outlets, ~60 W, plug at the back');
    expect(powerText({ needed: true })).toBe('Power: 1 outlet');
  });

  it('sums the layout for its coordinator', () => {
    const s = setupSummary([
      { table: { type: 'mils', heightMm: 781 }, power: { needed: true, outlets: 2, watts: 60 } },
      { table: { type: 'mils', heightMm: 781 }, power: { needed: true, outlets: 9, watts: 390 } },
      { table: { type: 'custom', heightMm: 812.8, measuredTo: 'rail' }, power: { needed: false } },
      {},
    ]);
    expect(summaryPowerText(s)).toBe('Power: 2 modules need 11 outlets, ~450 W (not set for 1)');
    expect(summaryTableLines(s, 'ftin')).toEqual(['MILS: 2 — 30¾″ (2)', 'Custom: 1 — 32″ to the rails (1)', 'Table not set: 1']);
    expect(summaryPowerText(setupSummary([{}]))).toBe('Power: not set for any module');
    expect(summaryPowerText(setupSummary([{ power: { needed: false } }]))).toBe('Power: none needed');
  });
});

describe('Table and power…', () => {
  it('writes each choice on the placed module at once, and Clear all takes them off', async () => {
    const doc = layout();
    render(<PlacedModuleSetupDialog doc={doc} moduleId="pm" onClose={() => undefined} />);
    expect((screen.getByTestId('setup-height') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('setup-table-type'), { target: { value: 'mils' } });
    expect(yard(doc).table).toEqual({ type: 'mils' });
    expect(screen.getByText(/its own legs or table/)).toBeTruthy();

    const height = screen.getByTestId('setup-height');
    fireEvent.change(height, { target: { value: '30 3/4' } });
    fireEvent.blur(height);
    expect((yard(doc).table as { heightMm: number }).heightMm).toBeCloseTo(781, 0);
    await waitFor(() => expect((screen.getByTestId('setup-height') as HTMLInputElement).value).toBe('30¾″'));
    fireEvent.click(screen.getByTestId('setup-to-rail'));
    expect(yard(doc).table).toMatchObject({ measuredTo: 'rail' });

    // Something it can't read says so, and changes nothing.
    fireEvent.change(height, { target: { value: 'tall' } });
    fireEvent.blur(height);
    expect(screen.getByRole('alert').textContent).toMatch(/isn’t a height/);
    expect((yard(doc).table as { heightMm: number }).heightMm).toBeCloseTo(781, 0);

    fireEvent.change(screen.getByTestId('setup-power'), { target: { value: 'yes' } });
    expect(yard(doc).power).toEqual({ needed: true, outlets: 1 });
    fireEvent.change(screen.getByTestId('setup-outlets'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('setup-watts'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('setup-plug-side'), { target: { value: 'back' } });
    expect(yard(doc).power).toEqual({ needed: true, outlets: 3, watts: 120, plugSide: 'back' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(yard(doc).table).toBeUndefined();
    expect(yard(doc).power).toBeUndefined();
  });

  it("shows someone else's change at once, and closes when the module goes", async () => {
    const doc = layout();
    const onClose = vi.fn();
    render(<PlacedModuleSetupDialog doc={doc} moduleId="pm" onClose={onClose} />);
    act(() => updateSidecarModule(doc, 'pm', (m) => ({ ...m, power: { needed: false } })));
    expect((screen.getByTestId('setup-power') as HTMLSelectElement).value).toBe('no');
    act(() => updateSidecarModule(doc, 'pm', (m) => ({ ...m, table: { type: 'custom', heightMm: 900 } })));
    await waitFor(() => expect((screen.getByTestId('setup-height') as HTMLInputElement).value).toBe('35½″'));
  });
});

/** The Modules panel's summary over the live layout. */
function LiveSummary({ doc }: { doc: Y.Doc }) {
  useYjsSnapshot(doc);
  return <SetupSummaryBox modules={(readSidecarFromDoc(doc)?.modules ?? []) as SidecarModule[]} unit="ftin" />;
}

describe('the layout summary', () => {
  it('follows every change with no refresh', () => {
    const doc = layout();
    render(<LiveSummary doc={doc} />);
    expect(screen.getByTestId('module-setup-power').textContent).toBe('Power: not set for any module');
    act(() => updateSidecarModule(doc, 'pm', (m) => ({ ...m, power: { needed: true, outlets: 2, watts: 60 }, table: { type: 'mils', heightMm: 781 } })));
    expect(screen.getByTestId('module-setup-power').textContent).toBe('Power: 1 module needs 2 outlets, ~60 W');
    expect(screen.getByTestId('module-setup-tables').textContent).toBe('MILS: 1 — 30¾″ (1)');
  });
});

describe('the Module library carries them', () => {
  it('Save to Module library… sends them with the parts', async () => {
    const doc = layout();
    updateSidecarModule(doc, 'pm', (m) => ({ ...m, table: { type: 'baseplate' }, power: { needed: false } }));
    await saveModuleToLibrary(doc, 'pm', { title: 'Yard', ownerSlug: '' });
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/api/modules/m1',
      body: { setup: { table: { type: 'baseplate' }, power: { needed: false } } },
    });
  });

  it("doesn't touch the library's when the placed module has none", async () => {
    await saveModuleToLibrary(layout(), 'pm', { title: 'Yard', ownerSlug: '' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a module added from the Module library gets them', () => {
    const doc = new Y.Doc();
    ensureBrickLayer(doc);
    const res = importBricksAsModule(doc, [{ layerName: 'Layout', bricks: [{ partNumber: '3001', displayArea: { x: 0, y: 0, width: 4, height: 2 } }] }] as never, {
      name: 'Yard',
      library: { id: '11111111-1111-4111-8111-111111111111', version: 2, setup: { table: { type: 'mils', heightMm: 781 } } },
    })!;
    const placed = readSidecarFromDoc(doc)!.modules!.find((m) => m.id === res.moduleId)!;
    expect(placed.table).toEqual({ type: 'mils', heightMm: 781 });
    expect(placed.libraryVersion).toBe(2);
  });
});

describe('heights follow the account length unit', () => {
  it('the Table and power window types and shows heights in centimeters for a metric account', async () => {
    const doc = layout();
    updateSidecarModule(doc, 'pm', (m) => ({ ...m, table: { type: 'mils', heightMm: 781 } }));
    const value: PrefsContextValue = {
      prefs: { ...DEFAULT_PREFERENCES, lengthUnit: 'm' },
      mode: 'light',
      setPrefs: () => undefined,
      syncedToAccount: true,
      updatedAt: null,
      ready: true,
    };
    render(
      <PrefsContext.Provider value={value}>
        <PlacedModuleSetupDialog doc={doc} moduleId="pm" onClose={() => undefined} />
      </PrefsContext.Provider>,
    );
    expect((screen.getByTestId('setup-height') as HTMLInputElement).value).toBe('78.1 cm');
    const height = screen.getByTestId('setup-height');
    fireEvent.change(height, { target: { value: '80' } });
    fireEvent.blur(height);
    expect((yard(doc).table as { heightMm: number }).heightMm).toBe(800);
  });
});
