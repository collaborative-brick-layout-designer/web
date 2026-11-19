// The preview's numbers are the desktop's (src/ui/ImportPipeline.cpp
// rotatePart / alignPart): the same cases as its ImportPipelineTest.

import { describe, expect, it } from 'vitest';
import { aligned, connectionTypeName, rotated } from '../previewMath';

const sample = {
  widthStuds: 4,
  heightStuds: 2,
  contentStuds: { x: 0, y: 0, width: 4, height: 2 },
  baseOnGrid: true,
  connections: [
    { type: '1', x: -2, y: 0, angle: 180 },
    { type: '1', x: 2, y: 0, angle: 0 },
  ],
};

describe('import preview geometry', () => {
  it('a turn swaps the footprint and turns the connection points clockwise (ImportPreviewDialog.RotateAndDropConnection)', () => {
    const r = rotated(sample, 1);
    expect([r.widthStuds, r.heightStuds]).toEqual([2, 4]);
    expect(r.connections[1]!.x).toBeCloseTo(0);
    expect(r.connections[1]!.y).toBeCloseTo(2);
    expect(r.connections[1]!.angle).toBe(90);
    expect(r.connections[0]!.angle).toBe(-90);
    expect(rotated(sample, 4)).toEqual(sample);
  });

  it('a quarter-stud nudge moves everything by exactly that, and the frame grows to whole studs (ImportAlign.AQuarterStudNudge…)', () => {
    const f = aligned(sample, '', { x: 0.25, y: 0 });
    expect([f.widthStuds, f.heightStuds]).toEqual([5, 2]);
    expect(f.imageAt).toEqual({ x: 0.25, y: 0 });
    // Relative to the new centre (2.5): the right end moved from 2 to 2.25 - 0.5.
    expect(f.connections[1]!.x).toBeCloseTo(1.75);
  });

  it('Bounding box centres an off-grid model in whole studs', () => {
    const off = { ...sample, widthStuds: 5, contentStuds: { x: 0.3, y: 0, width: 4.4, height: 2 }, baseOnGrid: false };
    const f = aligned(off, 'box', { x: 0, y: 0 });
    expect([f.widthStuds, f.heightStuds]).toEqual([5, 2]);
    expect(f.imageAt.x).toBeCloseTo(0);
    const b = aligned(off, 'bottom', { x: 0, y: 0 });
    expect(b).toEqual(f); // Bottom plates without a flat base is Bounding box.
  });

  it('names connection types as the desktop does', () => {
    expect(connectionTypeName('1')).toBe('Rail');
    expect(connectionTypeName('2')).toBe('Road');
    expect(connectionTypeName('16x16road')).toBe('Type 16x16road');
  });
});

describe('angles', () => {
  it('a half turn of 0° is 180°, not -180°, as std::remainder gives', () => {
    expect(rotated(sample, 2).connections[1]!.angle).toBe(180);
  });
});
