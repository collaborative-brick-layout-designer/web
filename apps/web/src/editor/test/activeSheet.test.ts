import { describe, expect, it } from 'vitest';
import { placementTarget } from '../activeSheet';

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
