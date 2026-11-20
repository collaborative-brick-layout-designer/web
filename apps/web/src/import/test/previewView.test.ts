// Zoom and pan for the import preview (previewView.ts), as the desktop's.

import { describe, expect, it } from 'vitest';
import { aligned } from '../previewMath';
import { clampK, contentBox, fit, frameBox, toScreen, wheelFactor, zoomAt, zoomPercent, zoomTo, MAX_ZOOM, MIN_ZOOM } from '../previewView';

const part = { widthStuds: 8, heightStuds: 2, contentStuds: { x: 0, y: 0, width: 8, height: 2 }, baseOnGrid: true, connections: [] };

describe('preview view', () => {
  it('fits the model, centered, with room around it', () => {
    const v = fit({ x: 0, y: 0, width: 8, height: 2 }, 832, 400);
    expect(v.k).toBe(100); // (832 - 32) / 8
    expect(toScreen(v, 4, 1)).toEqual({ x: 416, y: 200 });
  });

  it('zooms towards the pointer: the point under it stays put', () => {
    const v = { k: 10, tx: 5, ty: 7 };
    const z = zoomAt(v, 2, 105, 57, 32);
    expect(z.k).toBe(20);
    // World point under (105, 57) was (10, 5); it still is.
    expect(toScreen(z, 10, 5)).toEqual({ x: 105, y: 57 });
  });

  it('stops at the desktop’s 5% and 3200% of the picture’s own pixels', () => {
    expect(clampK(1e9, 32)).toBe(MAX_ZOOM * 32);
    expect(clampK(0, 32)).toBe(MIN_ZOOM * 32);
    const v = zoomAt({ k: 1000, tx: 0, ty: 0 }, 10, 0, 0, 32);
    expect(v.k).toBe(1024);
  });

  it('100% is one picture pixel per screen pixel', () => {
    const v = zoomTo({ k: 3, tx: 0, ty: 0 }, 32, 200, 100, 32);
    expect(v.k).toBe(32);
    expect(zoomPercent(v, 32)).toBe(100);
    expect(zoomPercent({ k: 64, tx: 0, ty: 0 }, 32)).toBe(200);
  });

  it('a mouse notch zooms about as much as the desktop’s 1.15', () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(1.16, 2);
    expect(wheelFactor(100, 0, false)).toBeCloseTo(1 / 1.16, 2);
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(1.16, 2);
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(1.1);
  });

  it('a nudge slides the grid under the picture, not the picture', () => {
    const before = aligned(part, '', { x: 0, y: 0 });
    const after = aligned(part, '', { x: 0.25, y: 0 });
    expect(frameBox(before)).toEqual({ x: 0, y: 0, width: 8, height: 2 });
    // The model moved right against the grid: the grid starts a quarter stud to its left.
    expect(frameBox(after)).toEqual({ x: -0.25, y: 0, width: 9, height: 2 });
    // Fit shows both the picture and the grown frame.
    expect(contentBox(after)).toEqual({ x: -0.25, y: 0, width: 9, height: 2 });
  });
});
