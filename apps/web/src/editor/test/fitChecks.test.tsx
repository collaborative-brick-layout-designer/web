// The fit checks' words and list (trains design 3.5, 6.2): each kind says
// what's wrong in plain words with the numbers in the person's unit, and
// Show me asks the map to bring the spot into view.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { simpleStock, type FitCheck } from '@cld/parts-catalog/browser';
import { checkText, namesOf } from '../fitChecks';
import { FitChecksList } from '../FitChecksList';
import { newTrain } from '../trains';

const car = { ...simpleStock('s1', { length: 40 }), number: '4021' };
const train = { ...newTrain('Freight', [{ stock: 's1', reversed: false }], []), id: 't1' };
const names = namesOf([train], new Map([['s1', car]]), [{ id: 'r1', name: 'Loop run', train: null, from: { brick: 'A', from: 0, to: 1, s: 0 }, to: { brick: 'A', from: 0, to: 1, s: 0 }, via: [], steps: [], color: '' }]);
const check = (kind: FitCheck['kind'], values: Record<string, number> = {}, extra: Partial<FitCheck> = {}): FitCheck => ({
  key: `${kind}:x`,
  kind,
  severity: kind === 'overlap' || kind === 'trackKind' ? 'error' : 'warning',
  train: 't1',
  stock: 's1',
  at: { x: 10, y: 20 },
  values,
  ...extra,
});

describe('fit check words', () => {
  it('say what is wrong, with the numbers in the person’s unit', () => {
    expect(checkText(check('siding', { length: 120, usable: 96 }), names, 'studs')).toBe('Freight (120 studs) is longer than the track it stands in (96 studs between its switches and ends).');
    expect(checkText(check('truck', { angle: 33.4, max: 30 }), names, 'studs')).toMatch(/4021 in Freight: the curve is too tight for its trucks \(they turn 33°; at most 30°\)/);
    expect(checkText(check('coupler', { angle: 3, max: 37, gap: 6.8 }), names, 'studs')).toMatch(/can't reach the car ahead: its couplers are 6.8 studs apart/);
    expect(checkText(check('coupler', { angle: 40, max: 37, gap: 0 }), names, 'studs')).toMatch(/its coupler turns 40°/);
    expect(checkText(check('uncoupled'), names, 'studs')).toMatch(/no coupler/);
    expect(checkText(check('clearance'), names, 'studs')).toMatch(/too close to the other track/);
    expect(checkText(check('overlap', {}, { other: 't9' }), names, 'studs')).toBe('Freight and another train are on top of each other.');
    expect(checkText(check('trackKind'), names, 'studs')).toMatch(/doesn't run on this kind of track/);
    expect(checkText(check('offEnd'), names, 'studs')).toMatch(/runs off the end/);
    expect(checkText(check('lost'), names, 'studs')).toMatch(/moved or removed/);
    expect(checkText(check('reverse', {}, { route: 'r1' }), names, 'studs')).toMatch(/^Loop run turns the train around/);
    expect(checkText(check('power', {}, { route: 'r1' }), names, 'studs')).toMatch(/polarity switch/);
  });

  it('list each one with Show me, which asks the map for the spot', () => {
    const seen = vi.fn();
    window.addEventListener('cld:show-spot', (e) => seen((e as CustomEvent).detail));
    render(<FitChecksList checks={[check('siding', { length: 120, usable: 96 }), check('overlap', {}, { other: 't9' })]} names={names} allClear="All fits." />);
    expect(screen.getByTestId('fit-checks-count').textContent).toBe('2');
    expect(screen.getAllByLabelText('Problem')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show me' })[0]!);
    expect(seen).toHaveBeenCalledWith({ x: 10, y: 20 });
  });

  it('say so when all is well', () => {
    render(<FitChecksList checks={[]} names={names} allClear="Every train on the track fits." />);
    expect(screen.getByTestId('fit-checks-clear').textContent).toBe('Every train on the track fits.');
  });
});
