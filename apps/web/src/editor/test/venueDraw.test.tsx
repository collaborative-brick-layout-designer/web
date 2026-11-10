// Drawing the venue model v2 parts (references/VENUE-MODEL.md, "Drawing"):
// the shared geometry (the desktop's VenueDraw test checks the same
// numbers) and what the overlay draws for the Grand Lobby fixture.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

type Drawn = { type: string; props: Record<string, unknown> };
let drawn: Drawn[] = [];
vi.mock('react-konva', () => {
  const mk = (type: string) => (p: Record<string, unknown> & { children?: ReactNode }) => {
    drawn.push({ type, props: p });
    return h(Fragment, null, p.children);
  };
  return { Group: mk('Group'), Line: mk('Line'), Text: mk('Text'), Circle: mk('Circle'), Rect: mk('Rect') };
});

import GRAND_LOBBY from '../../../../../packages/bbm/tests/fixtures/grand-lobby.bld-venue?raw';
import { parseVenueFile } from '../venueFile';
import { VenueOverlay } from '../render/VenueOverlay';
import { dimensionGeometry, elevatorCross, obstacleStyle, powerText, stairMarks } from '../render/venueDraw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('venue drawing geometry', () => {
  it('draws treads across stairs and an arrow pointing the way up', () => {
    // 40 wide (x) by 30 deep (y), up to the north.
    const stairs = { poly: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], upDegrees: 270 };
    const { treads, arrow } = stairMarks(stairs);
    // Every 10 studs along the way up, full width.
    expect(treads.map((t) => t.map((v) => Math.round(v) + 0))).toEqual([
      [0, 20, 40, 20],
      [0, 10, 40, 10],
    ]);
    const [tailX, tailY, tipX, tipY] = arrow[0]!.map((v) => Math.round(v * 100) / 100);
    expect([tailX, tipX]).toEqual([20, 20]);
    expect(tipY).toBeLessThan(tailY!); // points north
    expect(stairMarks({ poly: stairs.poly })).toEqual({ treads: [], arrow: [] });
  });

  it('crosses elevators, labels power and places measurement labels above the line', () => {
    expect(elevatorCross([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }])).toEqual([
      [0, 0, 4, 2],
      [4, 0, 0, 2],
    ]);
    expect(powerText({ label: 'Stage', amps: 20, volts: 120 })).toBe('Stage · 20 A · 120 V');
    expect(powerText({})).toBe('');
    const g = dimensionGeometry({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 } })!;
    expect(g.ticks.map((t) => t.map((v) => v + 0))).toEqual([
      [0, -5, 0, 5],
      [100, -5, 100, 5],
    ]);
    expect(g.label).toEqual({ x: 50, y: -8 });
    expect(g.angleDeg).toBe(0);
    // Right to left still reads left to right.
    expect(dimensionGeometry({ from: { x: 100, y: 0 }, to: { x: 0, y: 0 } })!.angleDeg).toBe(0);
    expect(dimensionGeometry({ from: { x: 1, y: 1 }, to: { x: 1, y: 1 } })).toBeNull();
    expect(obstacleStyle('railing').fill).toBeNull();
    expect(obstacleStyle(undefined)).toEqual(obstacleStyle('fountain' as never));
  });
});

describe('VenueOverlay', () => {
  it('draws the Grand Lobby: power, notes, measurements, estimates', async () => {
    drawn = [];
    const venue = parseVenueFile(GRAND_LOBBY);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(h(VenueOverlay, { venue })));

    const circles = drawn.filter((d) => d.type === 'Circle');
    expect(circles).toHaveLength(venue.power!.length);
    expect(circles.filter((c) => c.props.fill !== 'white')).toHaveLength(3); // floor outlets are filled
    const texts = drawn.filter((d) => d.type === 'Text').map((d) => String(d.props.text));
    expect(texts).toContain('Concessions entrance is on the floor above');
    expect(texts.some((t) => t.startsWith('East of the stairs') && t.endsWith('(est.)'))).toBe(true);
    expect(texts).toContain('20′');
    expect(texts).toContain('≈ 57′ (est.)');
    expect(texts.some((t) => t.startsWith('angled north-east wall') && t.endsWith('(est.)'))).toBe(true);
    // Estimated outline edges are faded.
    expect(drawn.filter((d) => d.type === 'Line' && d.props.opacity === 0.45)).toHaveLength(3);
    // The railing is an outline only.
    expect(drawn.some((d) => d.type === 'Line' && d.props.closed && d.props.fill === undefined && d.props.strokeWidth === 3)).toBe(true);
    await act(async () => root.unmount());
  });

  it('puts each wall’s label in a pill, and shows a shortened one whole under the pointer', async () => {
    drawn = [];
    const venue = {
      name: 'Hall',
      enabled: true,
      minWalkwayStuds: 0,
      bounds: { x: 0, y: 0, w: 600, h: 400 },
      edges: [
        { kind: 0 as const, doorWidthStuds: 0, label: 'West wall by the stage', poly: [{ x: 0, y: 400 }, { x: 0, y: 210 }] },
        { kind: 1 as const, doorWidthStuds: 0, label: 'Fire door', poly: [{ x: 0, y: 210 }, { x: 0, y: 190 }] },
      ],
      obstacles: [],
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(h(VenueOverlay, { venue, labelFontPx: 60 })));
    const pills = drawn.filter((d) => d.type === 'Rect');
    expect(pills).toHaveLength(2);
    let texts = drawn.filter((d) => d.type === 'Text').map((d) => String(d.props.text));
    expect(texts).toEqual(['4.99 ft', '6.3"']);
    // The pointer on the door's label: its whole text.
    const at = drawn.filter((d) => d.type === 'Group' && d.props.name === 'venue-label')[1]!.props;
    const door = { x: Number(at.x), y: Number(at.y) };
    drawn = [];
    await act(async () => root.render(h(VenueOverlay, { venue, labelFontPx: 60, pointer: door })));
    texts = drawn.filter((d) => d.type === 'Text').map((d) => String(d.props.text));
    expect(texts).toContain('Fire door — 6.3"');
    await act(async () => root.unmount());
  });

  it('shows wall lengths in the chosen unit, not always feet', async () => {
    const venue = {
      name: 'Hall',
      enabled: true,
      minWalkwayStuds: 30,
      bounds: { x: 0, y: 0, w: 400, h: 200 },
      edges: [
        { kind: 0 as const, doorWidthStuds: 0, label: 'North', poly: [{ x: 0, y: 0 }, { x: 400, y: 0 }] },
        { kind: 0 as const, doorWidthStuds: 0, label: 'East', poly: [{ x: 400, y: 0 }, { x: 400, y: 200 }] },
      ],
      obstacles: [],
    };
    const root = createRoot(document.createElement('div'));
    const textsFor = async (unit?: 'ftin' | 'm' | 'studs') => {
      drawn = [];
      await act(async () => root.render(h(VenueOverlay, { venue, ...(unit ? { unit } : {}) })));
      return drawn.filter((d) => d.type === 'Text').map((d) => String(d.props.text));
    };
    expect(await textsFor()).toEqual(['North — 10.50 ft', 'East — 5.25 ft']);
    expect(await textsFor('ftin')).toEqual(['North — 10.50 ft', 'East — 5.25 ft']);
    expect(await textsFor('m')).toEqual(['North — 3.20 m', 'East — 1.60 m']);
    expect(await textsFor('studs')).toEqual(['North — 400 studs', 'East — 200 studs']);
    await act(async () => root.unmount());
  });

  it('shows wall lengths in the unit the venue remembers (the layout editor and the public page pass none)', async () => {
    const hall = (lengthUnit?: string) => ({
      name: 'Hall',
      enabled: true,
      minWalkwayStuds: 30,
      bounds: { x: 0, y: 0, w: 400, h: 200 },
      edges: [{ kind: 0 as const, doorWidthStuds: 0, label: 'North', poly: [{ x: 0, y: 0 }, { x: 400, y: 0 }] }],
      obstacles: [],
      ...(lengthUnit ? { lengthUnit } : {}),
    });
    const root = createRoot(document.createElement('div'));
    const textsFor = async (props: Record<string, unknown>) => {
      drawn = [];
      await act(async () => root.render(h(VenueOverlay, props as never)));
      return drawn.filter((d) => d.type === 'Text').map((d) => String(d.props.text));
    };
    expect(await textsFor({ venue: hall('m') })).toEqual(['North — 3.20 m']);
    expect(await textsFor({ venue: hall('studs') })).toEqual(['North — 400 studs']);
    expect(await textsFor({ venue: hall() })).toEqual(['North — 10.50 ft']);
    expect(await textsFor({ venue: hall('ftin') })).toEqual(['North — 10.50 ft']);
    // A unit from a newer version: feet, as before.
    expect(await textsFor({ venue: hall('cubits') })).toEqual(['North — 10.50 ft']);
    // The Venue Designer passes its own pick, which wins.
    expect(await textsFor({ venue: hall('m'), unit: 'studs' })).toEqual(['North — 400 studs']);
    await act(async () => root.unmount());
  });
});
