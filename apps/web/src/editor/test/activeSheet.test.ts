import { describe, expect, it } from 'vitest';
import { displaySheetName, placementTarget, renamedSheet, sheetName, startingSheetId } from '../activeSheet';

const layers = [
  { id: 'g', type: 'grid' as const, name: 'Grid', visible: true },
  { id: 'b1', type: 'brick' as const, name: 'Tracks', visible: true },
  { id: 't', type: 'text' as const, name: 'Notes', visible: true },
  { id: 'b2', type: 'brick' as const, name: 'Tables', visible: false },
];

describe('placementTarget', () => {
  it('uses the active sheet when it holds parts', () => {
    const p = placementTarget(layers, 'b2');
    expect(p.target?.id).toBe('b2');
    expect(p.redirected).toBe(false);
  });
  it('sends parts to the first parts sheet when the active one cannot hold them', () => {
    const p = placementTarget(layers, 't');
    expect(p.active?.id).toBe('t');
    expect(p.target?.id).toBe('b1');
    expect(p.redirected).toBe(true);
  });
  it('has no target when there is no parts sheet', () => {
    expect(placementTarget(layers.filter((l) => l.type !== 'brick'), 'g')).toMatchObject({ target: undefined, redirected: true });
    expect(placementTarget(layers, null)).toMatchObject({ active: undefined, redirected: false });
  });
});

describe('startingSheetId (the same rule as the desktop)', () => {
  it('opens on the saved sheet when it holds parts', () => {
    expect(startingSheetId(layers, 1)).toBe('b1');
  });
  it('else on the topmost parts sheet', () => {
    expect(startingSheetId(layers, 2)).toBe('b2');
    expect(startingSheetId(layers, 99)).toBe('b2');
    expect(startingSheetId(layers, null)).toBe('b2');
  });
  it('is null without a parts sheet', () => {
    expect(startingSheetId([layers[0]!, layers[2]!], 0)).toBeNull();
  });
});

describe('displaySheetName (BlueBrick\'s default "Layer N")', () => {
  it('shows an untouched "Layer N" as "Sheet N", and any other name as typed', () => {
    expect(displaySheetName('Layer 1')).toBe('Sheet 1');
    expect(displaySheetName('Layer 12')).toBe('Sheet 12');
    expect(displaySheetName('Layer 1 old')).toBe('Layer 1 old');
    expect(displaySheetName('layer 1')).toBe('layer 1');
    expect(displaySheetName('Tracks')).toBe('Tracks');
    expect(sheetName({ name: 'Layer 3' })).toBe('Sheet 3');
  });
  it('a rename box left at the shown default changes nothing', () => {
    expect(renamedSheet('Layer 1', 'Sheet 1')).toBeNull();
    expect(renamedSheet('Layer 1', ' Layer 1 ')).toBeNull();
    expect(renamedSheet('Layer 1', '')).toBeNull();
    expect(renamedSheet('Layer 1', 'Baseplates')).toBe('Baseplates');
  });
});
