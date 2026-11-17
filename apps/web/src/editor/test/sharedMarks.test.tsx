// What an update left a shared module overlapping, and a copy changed
// outside the app (sharedMarks.ts, SharedModulesBar.tsx): the parts it now
// lies over (not ones it only touches), its track ends that no longer meet
// someone else's, the words for them, and the notices that say so with
// Go back, Put back and Make it mine.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BbmMap, Brick } from '@cld/model';
import type { SharedPlaced } from '@cld/modules';
import { clipConvex, convexHull, marksNote, marksText, polygonArea, sharedMarks, type MarkPart } from '../sharedMarks';
import { SharedModulesBar } from '../SharedModulesBar';

const brick = (id: string, x: number, y: number, partNumber = 'plate.1', width = 4, height = 4, orientation = 0, linked: string[] = []): Brick =>
  ({ id, partNumber, displayArea: { x, y, width, height }, orientation, altitude: 0, activeConnectionPointIndex: 0, myGroup: '', connexions: linked.map((l, i) => ({ id: `${id}:${i}`, linkedTo: l })) }) as unknown as Brick;
const sheet = (id: string, bricks: Brick[]) => ({ id, type: 'brick' as const, name: id, bricks }) as unknown as BbmMap['layers'][number];

/** A straight track 8 studs long: an end at each short side (its connections are relative to its centre). */
const TRACK: MarkPart = {
  pxPerStud: 8,
  spriteSize: { w: 64, h: 16 },
  hullPts: [],
  connections: [
    { type: 'rail', x: -4, y: 0, angle: 180, electricPlug: 0 },
    { type: 'rail', x: 4, y: 0, angle: 0, electricPlug: 0 },
  ],
};
const partOf = (n: string) => (n === 'track.1' ? TRACK : undefined);

describe('polygons', () => {
  it('a hull, its area, and what two of them share', () => {
    const sq = convexHull([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }]);
    expect(sq).toHaveLength(4);
    expect(polygonArea(sq)).toBeCloseTo(4, 9);
    const shifted = sq.map((p) => ({ x: p.x + 1, y: p.y + 1 }));
    expect(polygonArea(clipConvex(sq, shifted))).toBeCloseTo(1, 9);
    expect(polygonArea(clipConvex(sq, shifted.map((p) => ({ x: p.x + 5, y: p.y }))))).toBe(0);
  });
});

describe('the marks after an update', () => {
  it('counts the parts it lies over, on its own sheets only, not ones that only touch it', () => {
    const map = {
      layers: [
        sheet('Track', [brick('m1', 0, 0), brick('m2', 4, 0), brick('over', 2, 2), brick('touch', 8, 0), brick('far', 40, 40)]),
        // Under the module, but on a sheet it has no parts on.
        sheet('Scenery', [brick('below', 0, 0)]),
      ],
    };
    expect(sharedMarks(map, new Set(['m1', 'm2']), partOf)).toEqual({ overlaps: 1, looseEnds: 0 });
  });

  it('counts its free track ends with a free end close by that it doesn’t meet', () => {
    // The module's track ends at x = 8; a neighbor's starts at x = 10 (2 studs away), another's right on it.
    const map = {
      layers: [
        sheet('Track', [
          brick('m', 0, 0, 'track.1', 8, 2),
          brick('near', 10, 0, 'track.1', 8, 2),
          brick('mine-left', -8, 0, 'track.1', 8, 2),
        ]),
      ],
    };
    // Left end: meets mine-left's right end exactly (a joined end). Right end: 2 studs from near's left end.
    expect(sharedMarks(map, new Set(['m']), partOf)).toEqual({ overlaps: 0, looseEnds: 1 });
    // Linked ends are joined whatever the distance says.
    const linked = { layers: [sheet('Track', [brick('m', 0, 0, 'track.1', 8, 2, 0, ['x', 'y']), brick('near', 10, 0, 'track.1', 8, 2)])] };
    expect(sharedMarks(linked, new Set(['m']), partOf).looseEnds).toBe(0);
  });

  it('says so in words', () => {
    expect(marksText({ overlaps: 2, looseEnds: 1 })).toBe('It overlaps 2 parts. 1 track end no longer meets.');
    expect(marksText({ overlaps: 1, looseEnds: 3 })).toBe('It overlaps 1 part. 3 track ends no longer meet.');
    expect(marksText({ overlaps: 0, looseEnds: 0 })).toBe('');
    expect(marksNote({ overlaps: 2, looseEnds: 0 })).toBe('Overlaps 2 parts');
    expect(marksNote({ overlaps: 0, looseEnds: 2 })).toBe('');
  });
});

describe('the notices', () => {
  const placed = (o: Partial<SharedPlaced> = {}): SharedPlaced => ({
    placedId: 'p1', name: 'Harbor crane', moduleId: 'm', version: 8, by: 'Alice', server: null, placement: null, review: { from: 7, to: 8, at: 1 }, members: ['a'], ...o,
  });
  const noop = () => undefined;

  it('after an update: what it is now and what it overlaps, with Go back', () => {
    const onGoBack = vi.fn();
    render(
      <SharedModulesBar updates={[]} reviews={[placed()]} marks={{ p1: { overlaps: 2, looseEnds: 1 } }} canUpdate busy={false} onShow={noop} onUpdate={noop} onGoBack={onGoBack} onOk={noop} />,
    );
    expect(screen.getByTestId('shared-module-updated').textContent).toContain('“Harbor crane” is now version 8. It overlaps 2 parts. 1 track end no longer meets.');
    fireEvent.click(screen.getByRole('button', { name: 'Go back to version 7' }));
    expect(onGoBack).toHaveBeenCalledWith(expect.objectContaining({ placedId: 'p1' }), 7);
  });

  it('a copy changed outside the app: Put back Alice’s version, Make it mine, Not now', () => {
    const onPutBack = vi.fn();
    const onMakeItMine = vi.fn();
    const { rerender } = render(
      <SharedModulesBar updates={[]} reviews={[]} drifted={[placed({ review: null })]} canUpdate canDetach busy={false} onShow={noop} onUpdate={noop} onGoBack={noop} onOk={noop} onPutBack={onPutBack} onMakeItMine={onMakeItMine} />,
    );
    const drift = screen.getByTestId('shared-module-drift');
    expect(drift.textContent).toContain('“Harbor crane” was changed outside the app');
    expect(drift.textContent).toContain('Its parts aren’t Alice’s version 8 anymore: another app changed this layout. Put Alice’s version back, or make the module yours.');
    fireEvent.click(screen.getByRole('button', { name: 'Put back Alice’s version' }));
    expect(onPutBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Make it mine…' }));
    expect(onMakeItMine).toHaveBeenCalled();
    // Someone who can't change the layout sees why, with no buttons to press.
    rerender(<SharedModulesBar updates={[]} reviews={[]} drifted={[placed({ review: null })]} canUpdate={false} busy={false} onShow={noop} onUpdate={noop} onGoBack={noop} onOk={noop} onPutBack={onPutBack} />);
    expect(screen.queryByRole('button', { name: 'Put back Alice’s version' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('shared-module-drift')).toBeNull();
  });
});
