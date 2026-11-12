// Budget usage — part ids match case-insensitively (desktop Budget.cpp).

import { describe, expect, it } from 'vitest';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../../api';
import { budgetRows, canAddToBudget, countUsage, effectiveLimit, limitFor, overBudgetCount, sameBudgetOr, setLeafParts, withinBudget } from '../budgetUsage';

function mapWith(parts: string[]): BbmMap {
  return {
    layers: [{ type: 'brick', id: 'L', name: 'Bricks', bricks: parts.map((partNumber, i) => ({ id: String(i), partNumber })) }],
  } as unknown as BbmMap;
}

describe('budget usage is case-insensitive', () => {
  const map = mapWith(['3001.1', '3001.1', 'ts_curve.8', 'TS_CURVE.8', '3710.1']);

  it('a limit entered in another case applies to the placed bricks', () => {
    const limits = new Map([['TS_CURVE.8', 1]]);
    expect(limitFor(limits, 'ts_curve.8')).toBe(1);
    const rows = budgetRows(map, limits);
    // One row, not one per spelling; shown with the limit's own spelling.
    expect(rows.filter((r) => r.part.toLowerCase() === 'ts_curve.8')).toEqual([
      { part: 'TS_CURVE.8', used: 2, limit: 1, limitKey: 'TS_CURVE.8' },
    ]);
    expect(overBudgetCount(map, limits)).toBe(1);
  });

  it('rows cover placed and limited parts; unlimited parts have no limit key', () => {
    const rows = budgetRows(map, new Map([['9999.1', 0]]));
    expect(rows.map((r) => [r.part, r.used, r.limit])).toEqual([
      ['3001.1', 2, undefined],
      ['3710.1', 1, undefined],
      ['9999.1', 0, 0],
      ['ts_curve.8', 2, undefined],
    ]);
  });

  it('nothing is over budget without limits', () => {
    expect(overBudgetCount(map, new Map())).toBe(0);
  });
});

describe('Use Budget Limitation (desktop canAddToBudget)', () => {
  const map = mapWith(['3001.1', '3001.1', '3710.1']);
  const usage = countUsage(map);
  const limits = new Map([['3001.1', 2], ['3710.1', 5]]);

  it('parts without a limit are unlimited or forbidden by preference', () => {
    expect(effectiveLimit(limits, '9999.1', true)).toBe(-1);
    expect(effectiveLimit(limits, '9999.1', false)).toBe(0);
    expect(canAddToBudget(limits, usage, '9999.1', 1, true)).toBe(true);
    expect(canAddToBudget(limits, usage, '9999.1', 1, false)).toBe(false);
  });

  it('refuses once the limit is reached, case-insensitively', () => {
    expect(canAddToBudget(limits, usage, '3001.1', 1, true)).toBe(false);
    expect(canAddToBudget(limits, usage, '3710.1', 4, true)).toBe(true);
    expect(canAddToBudget(limits, usage, '3710.1', 5, true)).toBe(false);
  });

  const group = (key: string, subKeys: string[]) =>
    ({ key, partNumber: key, kind: 'group', subparts: subKeys.map((subKey) => ({ subKey, x: 0, y: 0, angle: 0 })) }) as unknown as PartWire;
  const leaf = (key: string) => ({ key, partNumber: key, kind: 'leaf', subparts: [] }) as unknown as PartWire;
  const index = new Map<string, PartWire>([
    ['inner.set', group('inner.set', ['3710.1', '3710.1'])],
    ['outer.set', group('outer.set', ['3001.1', 'inner.set', '3710.1'])],
    ['3001.1', leaf('3001.1')],
    ['3710.1', leaf('3710.1')],
  ]);

  it('a set counts its leaf parts, nested sets expanded', () => {
    expect([...setLeafParts(index, 'outer.set')]).toEqual([['3001.1', 1], ['3710.1', 3]]);
    // 3710.1: 1 used + 3 in the set ≤ 5, but 3001.1 is already at its limit.
    expect(canAddToBudget(limits, usage, 'outer.set', 1, true, index)).toBe(false);
    expect(canAddToBudget(new Map([['3710.1', 3]]), usage, 'inner.set', 1, true, index)).toBe(true);
    expect(canAddToBudget(new Map([['3710.1', 2]]), usage, 'inner.set', 1, true, index)).toBe(false);
  });

  it('a set named like one of its own parts counts that part once, not copies of itself', () => {
    const own = new Map<string, PartWire>([
      ['yard', group('yard', ['yard', '3710.1'])],
      ['3710.1', leaf('3710.1')],
    ]);
    expect([...setLeafParts(own, 'yard')]).toEqual([['yard', 1], ['3710.1', 1]]);
  });

  it('paste keeps bricks in order while they fit and counts the rest as refused', () => {
    const pasted = ['3710.1', '3001.1', '3710.1', '3710.1', '3710.1', '3710.1'].map((p, i) => ({ p, i }));
    const { kept, refused } = withinBudget(limits, map, pasted, (b) => b.p, true);
    // 3001.1 is full; 3710.1 has room for 4 more.
    expect(kept.map((b) => b.i)).toEqual([0, 2, 3, 4]);
    expect(refused).toBe(2);
  });
});

// The budget is read again on every change to the map. A new Map each time
// re-rendered the Parts list's every picture after anyone's move.
describe('the budget read again', () => {
  it('is the same Map while each limit is the same', () => {
    const kept = new Map([['3001.1', 4], ['3024.5', 0]]);
    expect(sameBudgetOr(kept, new Map([['3024.5', 0], ['3001.1', 4]]))).toBe(kept);
    const empty = new Map<string, number>();
    expect(sameBudgetOr(empty, new Map())).toBe(empty);
    const changed = new Map([['3001.1', 5], ['3024.5', 0]]);
    expect(sameBudgetOr(kept, changed)).toBe(changed);
    const more = new Map([...kept, ['3622.1', 2]]);
    expect(sameBudgetOr(kept, more)).toBe(more);
    const other = new Map([['3001.1', 4], ['3023.5', 0]]);
    expect(sameBudgetOr(kept, other)).toBe(other);
  });
});
