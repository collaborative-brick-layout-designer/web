// The Venue Designer's tools, driven through the reducer as the canvas
// drives them: clicks (world points), typed lengths, Enter and Esc.

import { describe, expect, it } from 'vitest';
import { initialState, parseSize, reducer, venueOf, type Action, type DesignerState } from '../designerState';
import { addRoom, emptyVenue } from '../model';
import { STUDS_PER_INCH } from '../units';

const IN = STUDS_PER_INCH;
const FT = 12 * IN;
const run = (s: DesignerState, ...actions: Action[]) => actions.reduce(reducer, s);
const click = (x: number, y: number, free = false): Action => ({ type: 'down', at: { x, y }, tol: 0.5, free });
const hover = (x: number, y: number): Action => ({ type: 'move', at: { x, y }, tol: 0.5, free: false });
const tool = (t: DesignerState['tool']): Action => ({ type: 'tool', tool: t });

describe('drawing tools', () => {
  it('draws walls corner to corner, with a typed length, and closes on the first corner', () => {
    let s = run(initialState(emptyVenue()), tool('wall'), click(0, 0), hover(50, 1), { type: 'type', text: "10'" }, { type: 'enter' });
    const v1 = venueOf(s);
    expect(v1.edges).toHaveLength(1);
    expect(v1.edges[0]!.poly[1]!.x).toBeCloseTo(10 * FT); // along the snapped direction (east)
    expect(v1.edges[0]!.poly[1]!.y).toBeCloseTo(0);
    s = run(s, click(10 * FT, 5 * FT), click(0, 5 * FT), click(0, 0));
    expect(venueOf(s).edges).toHaveLength(4);
    expect(s.draft).toEqual([]); // closed: finished
    // Esc after one corner draws nothing.
    s = run(s, click(200, 200), { type: 'escape' });
    expect(venueOf(s).edges).toHaveLength(4);
    expect(s.draft).toEqual([]);
  });

  it('makes a room from a typed width x depth, towards the pointer', () => {
    const s = run(initialState(emptyVenue()), tool('room'), click(50 * FT, 10 * FT), hover(0, 20 * FT), { type: 'type', text: "40' 4\" x 20'" }, { type: 'enter' });
    const e = venueOf(s).edges;
    expect(e).toHaveLength(4);
    const xs = e.flatMap((x) => x.poly.map((p) => p.x));
    expect(Math.min(...xs)).toBeCloseTo(50 * FT - 484 * IN);
    expect(Math.max(...e.flatMap((x) => x.poly.map((p) => p.y)))).toBeCloseTo(10 * FT + 240 * IN);
  });

  it('cuts a typed-width door into a wall from where it was clicked', () => {
    const room = addRoom(emptyVenue(), { x: 0, y: 0 }, { x: 40 * FT, y: 20 * FT });
    const s = run(initialState(room), tool('door'), click(10 * FT, 0.2), hover(20 * FT, 0), { type: 'type', text: "6'" }, { type: 'enter' });
    const e = venueOf(s).edges;
    expect(e.map((x) => x.kind)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(e[1]!.doorWidthStuds).toBeCloseTo(6 * FT);
    expect(e[1]!.poly[0]!.x).toBeCloseTo(10 * FT);
    expect(s.selection).toEqual({ kind: 'edge', index: 1 });
    // Not on a wall: nothing starts.
    const off = run(initialState(room), tool('opening'), click(10 * FT, 10 * FT));
    expect(off.cut).toBeNull();
    expect(off.message).toBe('Click on a wall');
  });

  it('places obstacles, power (wall or floor by where), notes and measurements, selecting each', () => {
    const room = addRoom(emptyVenue(), { x: 0, y: 0 }, { x: 40 * FT, y: 20 * FT });
    let s = run(initialState(room), tool('stairs'), click(10 * FT, 0), click(30 * FT, 15 * FT));
    expect(venueOf(s).obstacles[0]).toMatchObject({ kind: 'stairs', upDegrees: 270 });
    expect(s.selection).toEqual({ kind: 'obstacle', index: 0 });
    s = run(s, tool('power'), click(5 * FT, 0.1), click(5 * FT, 10 * FT));
    expect(venueOf(s).power!.map((p) => p.kind)).toEqual(['wall', 'floor']);
    s = run(s, tool('note'), click(2 * FT, 2 * FT));
    expect(venueOf(s).notes).toEqual([{ x: 2 * FT, y: 2 * FT, text: 'Note' }]);
    expect(s.selection).toEqual({ kind: 'note', index: 0 });
    s = run(s, tool('measure'), click(0, 0), click(40 * FT, 0));
    expect(venueOf(s).dimensions![0]!.label).toBe('40′ 0″');
  });
});

describe('select tool', () => {
  it('drags a part in whole inches as one undo step, and Esc puts it back', () => {
    const room = addRoom(emptyVenue(), { x: 0, y: 0 }, { x: 40 * FT, y: 20 * FT });
    let s = run(initialState(room), tool('stairs'), click(10 * FT, 5 * FT), click(12 * FT, 7 * FT), tool('select'));
    s = run(s, click(11 * FT, 6 * FT), hover(11 * FT + 3.3, 6 * FT), hover(11 * FT + 10.2, 6 * FT), { type: 'up' });
    const moved = venueOf(s).obstacles[0]!.poly[0]!;
    expect(moved.x).toBeCloseTo(10 * FT + Math.round(10.2 / IN) * IN);
    s = run(s, { type: 'undo' });
    expect(venueOf(s).obstacles[0]!.poly[0]!.x).toBeCloseTo(10 * FT);
    // Esc mid-drag: back where it was.
    s = run(s, click(11 * FT, 6 * FT), hover(20 * FT, 6 * FT), { type: 'escape' });
    expect(venueOf(s).obstacles[0]!.poly[0]!.x).toBeCloseTo(10 * FT);
    expect(s.drag).toBeNull();
  });

  it('drags a corner, deletes and duplicates the selection', () => {
    const room = addRoom(emptyVenue(), { x: 0, y: 0 }, { x: 40 * FT, y: 20 * FT });
    let s = run(initialState(room), click(40 * FT, 0), hover(45 * FT, 0), { type: 'up' });
    // Both walls meeting at that corner follow it.
    expect(venueOf(s).edges[0]!.poly[1]!.x).toBeCloseTo(45 * FT);
    expect(venueOf(s).edges[1]!.poly[0]!.x).toBeCloseTo(45 * FT);
    s = run(s, { type: 'duplicate' });
    expect(venueOf(s).edges).toHaveLength(5);
    s = run(s, { type: 'delete' });
    expect(venueOf(s).edges).toHaveLength(4);
    expect(s.selection).toBeNull();
    // Clicking empty floor clears the selection.
    s = run(s, click(40 * FT, 0), { type: 'up' }, click(20 * FT, 10 * FT));
    expect(s.selection).toBeNull();
  });

  it('reads sizes as width x depth, with any unit mix', () => {
    expect(parseSize("40' x 20'", 'ftin')).toEqual([480 * IN, 240 * IN]);
    expect(parseSize('3m × 2m', 'ftin')).toEqual([375, 250]);
    expect(parseSize('129', 'ftin')).toEqual([129 * IN]);
    expect(parseSize("40' x", 'ftin')).toEqual([480 * IN]);
    expect(parseSize('x', 'ftin')).toBeNull();
    expect(parseSize("1' x 2' x 3'", 'ftin')).toBeNull();
  });
});

describe('units', () => {
  it('the Units pick is kept with the venue, and comes back when it is opened again', () => {
    let s = initialState(emptyVenue());
    expect(s.unit).toBe('ftin');
    expect(venueOf(s).lengthUnit).toBeUndefined();
    const before = venueOf(s);

    s = run(s, { type: 'unit', unit: 'm' });
    expect(s.unit).toBe('m');
    expect(venueOf(s).lengthUnit).toBe('m');
    expect(venueOf(s)).not.toBe(before); // a change to save
    // Typed lengths read in it.
    s = run(s, tool('wall'), click(0, 0), hover(50, 1), { type: 'type', text: '3' }, { type: 'enter' }, { type: 'escape' });
    expect(venueOf(s).edges[0]!.poly[1]!.x).toBeCloseTo(375); // 3 m

    // Opened again: the designer starts in the venue's unit.
    expect(initialState(venueOf(s)).unit).toBe('m');
    expect(initialState({ ...emptyVenue(), lengthUnit: 'studs' }).unit).toBe('studs');
    // A unit this version doesn't know reads as feet and inches.
    expect(initialState({ ...emptyVenue(), lengthUnit: 'furlongs' as never }).unit).toBe('ftin');
  });

  it('feet and inches is the default and is not written; undo and redo take the unit with them', () => {
    let s = run(initialState(emptyVenue()), { type: 'unit', unit: 'studs' });
    const studs = venueOf(s);
    s = run(s, { type: 'unit', unit: 'studs' });
    expect(venueOf(s)).toBe(studs); // the same pick again changes nothing
    s = run(s, { type: 'unit', unit: 'ftin' });
    expect('lengthUnit' in venueOf(s)).toBe(false);
    s = run(s, { type: 'undo' });
    expect(s.unit).toBe('studs');
    expect(venueOf(s).lengthUnit).toBe('studs');
    s = run(s, { type: 'undo' });
    expect(s.unit).toBe('ftin');
    s = run(s, { type: 'redo' });
    expect(s.unit).toBe('studs');
  });
});
