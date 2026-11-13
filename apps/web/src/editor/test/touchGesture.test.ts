// Touch pan and pinch zoom for the phone viewer.

import { describe, expect, it } from 'vitest';
import { panView, pinchView } from '../touchGesture';
import { isPhoneSize, shortSide } from '../useViewportSize';

const range = { min: 0.02, max: 40 };
const start = { zoom: 0.5, panX: 10, panY: 20 };
const toWorld = (v: typeof start, p: { x: number; y: number }) => ({ x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom });

describe('pinchView', () => {
  it('zooms by the change in finger spread', () => {
    const v = pinchView(start, { x: 100, y: 100 }, { x: 140, y: 100 }, { x: 60, y: 100 }, { x: 180, y: 100 }, range);
    expect(v.zoom).toBeCloseTo(1.5, 9); // 40 px -> 120 px: 3x
  });

  it('keeps the map point under the fingers under them, even when they move', () => {
    const a0 = { x: 100, y: 200 };
    const b0 = { x: 200, y: 260 };
    const before = toWorld(start, { x: 150, y: 230 });
    // Spread and slide 30 px right, 10 px down.
    const v = pinchView(start, a0, b0, { x: 80, y: 190 }, { x: 280, y: 290 }, range);
    const after = toWorld(v, { x: 180, y: 240 });
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('stays inside the zoom range', () => {
    const v = pinchView(start, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10000, y: 0 }, range);
    expect(v.zoom).toBe(40);
    const w = pinchView(start, { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, range);
    expect(w.zoom).toBe(0.02);
  });

  it('ignores two fingers on the same spot', () => {
    const v = pinchView(start, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, range);
    expect(v).toEqual(start);
  });
});

describe('panView', () => {
  it('moves the view by the finger movement, zoom unchanged', () => {
    expect(panView(start, { x: 50, y: 50 }, { x: 80, y: 20 })).toEqual({ zoom: 0.5, panX: 40, panY: -10 });
  });
});

describe('isPhoneSize', () => {
  it('is a phone when narrow, or short with a touch screen', () => {
    expect(isPhoneSize(412, 915, true)).toBe(true);
    expect(isPhoneSize(915, 412, true)).toBe(true); // on its side
    expect(isPhoneSize(915, 412, false)).toBe(false); // a short desktop window
    expect(isPhoneSize(1024, 768, true)).toBe(false); // a tablet
    expect(isPhoneSize(767, 1000, false)).toBe(true);
  });
});

describe('shortSide', () => {
  it("uses the screen's short side, which the on-screen keyboard never shrinks", () => {
    // A tablet on its side with the keyboard open: the window is 1080 x 380,
    // the screen is still 1080 x 810, so it stays a tablet.
    expect(isPhoneSize(1080, shortSide(1080, 810, 380), true)).toBe(false);
    // A phone on its side is still a phone.
    expect(isPhoneSize(915, shortSide(915, 412, 412), true)).toBe(true);
    // Without a screen size, the window's height is used.
    expect(shortSide(undefined, undefined, 380)).toBe(380);
    expect(shortSide(0, 0, 640)).toBe(640);
  });
});
