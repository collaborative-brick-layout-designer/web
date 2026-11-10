// The Edit Ruler dialog keeps every number to what the server takes in a
// live update (apps/server/src/ws/drawingSettings.ts): a ruler thickness of
// 500 or a dash of 5000 would have the server refuse the edit and end the
// live layout. Values out of range land on the nearest end, as the desktop
// dialog's spin boxes do.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import type { CircularRulerItem, LinearRulerItem } from '@cld/model';
import { EditRulerDialog } from '../EditRulerDialog';
import { addCircularRuler, addLinearRuler, editRulerItem, ensureRulerLayer } from '../mutations';

afterEach(cleanup);

function setup(kind: 'linear' | 'circular') {
  const doc = createDefaultLayoutDoc();
  const layerId = ensureRulerLayer(doc);
  if (kind === 'linear') addLinearRuler(doc, layerId, { x: 0, y: 0 }, { x: 10, y: 0 });
  else addCircularRuler(doc, layerId, { x: 0, y: 0 }, 5);
  const ruler = () => docToBbm(doc).layers.flatMap((l) => (l.type === 'ruler' ? l.rulerItems : []))[0]!;
  return { doc, layerId, ruler };
}

// The server's limits (drawingSettings.ts RULER_RULES).
function serverTakes(r: Record<string, unknown>): string[] {
  const bad: string[] = [];
  const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!inRange(r.lineThickness, 0, 100)) bad.push('lineThickness');
  if (!inRange(r.guidelineThickness, 0, 100)) bad.push('guidelineThickness');
  if (!inRange((r.measureFont as { size: number }).size, 1, 1000)) bad.push('measureFont');
  const dash = r.guidelineDashPattern as number[];
  if (dash.length > 64 || !dash.every((d) => inRange(d, 0, 1000)) || (dash.length > 0 && dash.reduce((a, b) => a + b, 0) < 0.01)) bad.push('dash');
  if (r.offsetDistance !== undefined && !inRange(r.offsetDistance, -1e7, 1e7)) bad.push('offsetDistance');
  if (r.radius !== undefined && !inRange(r.radius, 0, 1e7)) bad.push('radius');
  return bad;
}

describe('ruler settings stay in what the server takes', () => {
  it('editRulerItem brings far-out values to the nearest end', () => {
    const { doc, layerId, ruler } = setup('linear');
    editRulerItem(doc, layerId, ruler().id, {
      lineThickness: 500,
      guidelineThickness: -3,
      measureFont: { family: 'Arial', size: 5000, style: 'Regular' },
      guidelineDashPattern: [5000, ...Array.from({ length: 100 }, () => 2)],
      offsetDistance: 1e12,
    });
    const r = ruler() as LinearRulerItem;
    expect(serverTakes(r as unknown as Record<string, unknown>)).toEqual([]);
    expect(r.lineThickness).toBe(50);
    expect(r.guidelineThickness).toBe(0);
    expect(r.measureFont.size).toBe(200);
    expect(r.guidelineDashPattern).toHaveLength(64);
    expect(r.guidelineDashPattern[0]).toBe(1000);
    expect(r.offsetDistance).toBe(1e7);
  });

  it('a circle radius past the edge lands on it', () => {
    const { doc, layerId, ruler } = setup('circular');
    editRulerItem(doc, layerId, ruler().id, { radius: 1e12 });
    expect((ruler() as CircularRulerItem).radius).toBe(1e7);
  });

  it('a dash pattern that adds up to (nearly) nothing becomes a solid line', () => {
    const { doc, layerId, ruler } = setup('linear');
    editRulerItem(doc, layerId, ruler().id, { guidelineDashPattern: [0.001, 0.001] });
    expect(ruler().guidelineDashPattern).toEqual([]);
  });

  it('typing past the dialog edges saves values the server takes', () => {
    const { doc, layerId, ruler } = setup('linear');
    render(<EditRulerDialog item={ruler()} layerId={layerId} doc={doc} onClose={() => {}} />);
    const [lineThickness, , guideThickness, offset] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(lineThickness!.max).toBe('50');
    fireEvent.change(lineThickness!, { target: { value: '900' } });
    fireEvent.change(guideThickness!, { target: { value: '900' } });
    fireEvent.change(offset!, { target: { value: '99999999999' } });
    fireEvent.change(screen.getByLabelText(/^Dashes/), { target: { value: '4, 99999, 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const r = ruler() as LinearRulerItem;
    expect(serverTakes(r as unknown as Record<string, unknown>)).toEqual([]);
    expect(r.lineThickness).toBe(50);
    expect(r.guidelineDashPattern).toEqual([4, 1000, 2]);
  });
});
