// Scale bar — port of MapViewPaint.cpp:195-222.

import { describe, expect, it } from 'vitest';
import { scaleBar } from '../scaleBar';

describe('scaleBar', () => {
  it('picks the track-friendly step closest to 120 px', () => {
    expect(scaleBar(8)!.studs).toBe(16); // zoom 1: 16 studs = 128 px
    expect(scaleBar(0.8)!.studs).toBe(128); // zoom 0.1: 128 studs = 102 px
    expect(scaleBar(4)!.studs).toBe(32);
    expect(scaleBar(24)!.studs).toBe(5);
  });

  it('labels studs, then mm below 1 m and metres to 2 decimals above (not cm from mm)', () => {
    // 20 studs = 160 mm; the old HUD said "160 cm".
    expect(scaleBar(6)).toMatchObject({ studs: 20, primary: '20 studs', secondary: '160 mm' });
    expect(scaleBar(0.8)).toMatchObject({ primary: '128 studs', secondary: '1.02 m' });
    expect(scaleBar(0.4)).toMatchObject({ studs: 256, secondary: '2.05 m' });
  });

  it('says "1 stud", not "1 studs", zoomed right in', () => {
    expect(scaleBar(120)).toMatchObject({ studs: 1, primary: '1 stud', secondary: '8 mm' });
  });

  it('the bar width is the step at the current zoom', () => {
    const b = scaleBar(3)!;
    expect(b.px).toBe(b.studs * 3);
  });

  it('nothing for a degenerate zoom', () => {
    expect(scaleBar(0)).toBeNull();
    expect(scaleBar(Number.NaN)).toBeNull();
  });
});
