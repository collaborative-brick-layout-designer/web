// Running trains in the editor (trains design 5): which trains run and on
// which route, speeds in the account's units, the layout's scale (shared,
// one undo step, kept in the sidecar), the plain sentences, and the Run
// panel: Play, the speed choice, an empty layout, and running making no
// change to the layout.

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { readSidecar, writeSidecar } from '@cld/bbm';
import { importSidecarIntoDoc, readSidecarFromDoc, readTrainScaleFromDoc } from '@cld/ydoc';
import { type PlacedTrain, type Route, type RouteStatus, type Train } from '@cld/parts-catalog/browser';
import { formatRealSpeed, formatScaleSpeed, kmhToShown, noteText, picksFor, resetRun, setTrainScale, speedToKmh, useRunStore, withNotes } from '../trainRun';
import { RunPanel } from '../RunPanel';
import { createUndoManager } from '../useUndoManager';
import { blueBrickLeavesOut } from '../DownloadAsDialog';

const train = (id: string, fields: Partial<Train> = {}): Train => ({ id, name: id, trackKind: 'rail', units: [{ stock: 'a', reversed: false }], position: null, color: '#E07000', speed: 40, ...fields });
const route = (id: string, fields: Partial<Route> = {}): Route => ({
  id,
  name: `Route ${id}`,
  train: null,
  from: { brick: 'A', from: 0, to: 1, s: 0 },
  to: { brick: 'B', from: 0, to: 1, s: 4 },
  via: [],
  steps: [{ brick: 'A', from: 0, to: 1 }],
  color: '#3B82F6',
  ...fields,
});
const ok: RouteStatus = { status: 'ok', setAgainst: [] } as unknown as RouteStatus;
const broken = { status: 'broken', at: 0 } as unknown as RouteStatus;
const somewhere = { units: [], offTrack: false } as PlacedTrain;

afterEach(() => {
  cleanup();
  resetRun();
});

describe('which trains run', () => {
  it("runs a train on its own route, else from where it stands; one with neither can't run", () => {
    const trains = [train('own'), train('standing'), train('lost'), train('empty', { units: [] })];
    const routes = [route('r1', { train: 'own' }), route('r2')];
    const statuses = new Map([['r1', ok], ['r2', ok]]);
    const placed = new Map([['standing', somewhere], ['own', somewhere], ['empty', somewhere]]);
    const picks = picksFor(trains, routes, placed, statuses, {});
    expect(picks.get('own')).toEqual({ on: true, route: 'r1' });
    expect(picks.get('standing')).toEqual({ on: true, route: null });
    expect(picks.get('lost')).toBeNull();
    expect(picks.get('empty')).toBeNull();
    // A choice is kept while it still works; a broken route falls back.
    const chosen = picksFor(trains, routes, placed, new Map([['r1', broken], ['r2', ok]]), { lost: { on: true, route: 'r2' }, standing: { on: false, route: null }, own: { on: true, route: 'r1' } });
    expect(chosen.get('lost')).toEqual({ on: true, route: 'r2' });
    expect(chosen.get('standing')).toEqual({ on: false, route: null });
    expect(chosen.get('own')).toEqual({ on: true, route: null });
  });
});

describe('speeds in your units', () => {
  it('shows scale speeds in mph for feet and inches, km/h otherwise, and the real speed of the model', () => {
    expect(formatScaleSpeed(40, 'ftin')).toBe('25 mph');
    expect(formatScaleSpeed(40, 'm')).toBe('40 km/h');
    expect(formatRealSpeed(40, 38, 'm')).toBe('0.29 m/s');
    expect(formatRealSpeed(40, 38, 'ftin')).toBe('11.5 in/s');
    expect(formatRealSpeed(40, 38, 'studs')).toBe('37 studs/s');
    expect(speedToKmh(25, 'ftin')).toBeCloseTo(40.2336, 3);
    expect(kmhToShown(40, 'ftin')).toBe(25);
    expect(kmhToShown(40, 'studs')).toBe(40);
  });

  it('says what happened in plain words', () => {
    const name = (id: string) => ({ a: 'Coast Daylight', b: 'Freight 2' })[id] ?? id;
    expect(noteText({ kind: 'collision', train: 'a', other: 'b', at: { x: 0, y: 0 } }, name)).toBe('Coast Daylight and Freight 2 would collide here, so both stopped.');
    expect(noteText({ kind: 'arrived', train: 'a', at: { x: 0, y: 0 } }, name, () => 'Yard to platform 2')).toBe('Coast Daylight reached the end of Yard to platform 2.');
    expect(noteText({ kind: 'pushedThrough', train: 'b', at: { x: 0, y: 0 } }, name)).toMatch(/^Freight 2 pushed through a switch/);
  });
});

describe('what happened', () => {
  it("doesn't say the same collision twice (Play again and they still meet), but says a new one", () => {
    const hit = { kind: 'collision' as const, train: 'a', other: 'b', at: { x: 10, y: 10 } };
    const once = withNotes([], [hit]);
    expect(once).toHaveLength(1);
    expect(withNotes(once, [{ ...hit, train: 'b', other: 'a', at: { x: 10.5, y: 10 } }])).toHaveLength(1);
    expect(withNotes(once, [{ ...hit, at: { x: 40, y: 10 } }])).toHaveLength(2);
    expect(withNotes(once, [{ kind: 'arrived', train: 'a', at: { x: 0, y: 0 } }])).toHaveLength(2);
    // The last 20 only.
    let many = once;
    for (let i = 0; i < 30; i++) many = withNotes(many, [{ kind: 'arrived', train: `t${i}`, at: { x: 0, y: 0 } }]);
    expect(many).toHaveLength(20);
  });
});

describe("the layout's train scale", () => {
  it('is shared, one undo step, kept in the sidecar and left out of a .bbm', () => {
    const doc = new Y.Doc();
    const undo = createUndoManager(doc);
    expect(readTrainScaleFromDoc(doc)).toBeUndefined();
    setTrainScale(doc, 87);
    expect(readTrainScaleFromDoc(doc)).toBe(87);
    const side = readSidecarFromDoc(doc)!;
    expect(side.trainScale).toBe(87);
    expect(blueBrickLeavesOut(side)).toContain('the train scale');
    const back = readSidecar(writeSidecar(side));
    expect(back.trainScale).toBe(87);
    const doc2 = new Y.Doc();
    importSidecarIntoDoc(doc2, back);
    expect(readTrainScaleFromDoc(doc2)).toBe(87);
    undo.undo();
    expect(readTrainScaleFromDoc(doc)).toBeUndefined();
    // 1:38 is the default: setting it back takes the key away.
    setTrainScale(doc, 38);
    expect(readTrainScaleFromDoc(doc)).toBeUndefined();
    // Out of range in a file: not read.
    expect(readSidecar(JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', trainScale: 3 })).trainScale).toBeUndefined();
  });
});

describe('the Run panel', () => {
  const stockDoc = () => {
    const doc = new Y.Doc();
    return doc;
  };

  it('offers the Trains panel when the layout has no trains', () => {
    render(<RunPanel doc={stockDoc()} trains={[]} routes={[]} statuses={new Map()} placed={new Map()} scale={38} isViewer={false} />);
    expect(screen.getByTestId('run-empty').textContent).toMatch(/no trains/);
    expect((screen.getByTestId('run-play') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists each train with where it runs and its speed; Play starts, the speed choice is kept', () => {
    const trains = [train('Daylight', { position: { brick: 'A', from: 0, to: 1, s: 0, facing: 'to' } }), train('Ghost')];
    render(<RunPanel doc={stockDoc()} trains={trains} routes={[route('r1')]} statuses={new Map([['r1', ok]])} placed={new Map([['Daylight', somewhere]])} scale={38} isViewer={false} />);
    const rows = screen.getAllByTestId('run-train');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/25 mph/);
    expect((screen.getAllByTestId('run-route')[0] as HTMLSelectElement).value).toBe('');
    // A train not on the track is run on a route, picked here.
    expect(rows[1]!.textContent).toMatch(/Put it on the track, or draw a route/);
    fireEvent.click(screen.getByTestId('run-real-speed'));
    expect(screen.getAllByTestId('run-speed')[0]!.textContent).toBe('11.5 in/s');
    fireEvent.change(screen.getByTestId('run-multiplier'), { target: { value: '2' } });
    expect(useRunStore.getState().multiplier).toBe(2);
    expect(JSON.parse(localStorage.getItem('cld:run')!)).toEqual({ multiplier: 2, realSpeed: true });
    act(() => fireEvent.click(screen.getByTestId('run-play')));
    expect(useRunStore.getState().playing).toBe(true);
    expect(screen.getByTestId('run-play').textContent).toMatch(/Pause/);
  });

  it("changes the layout's scale for everyone, but not for a viewer", () => {
    const doc = stockDoc();
    const { rerender } = render(<RunPanel doc={doc} trains={[train('T')]} routes={[]} statuses={new Map()} placed={new Map()} scale={38} isViewer={false} />);
    const box = screen.getByTestId('run-scale') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '64' } });
    fireEvent.blur(box);
    expect(readTrainScaleFromDoc(doc)).toBe(64);
    fireEvent.change(box, { target: { value: '2' } });
    fireEvent.blur(box);
    expect(readTrainScaleFromDoc(doc)).toBe(64);
    rerender(<RunPanel doc={doc} trains={[train('T')]} routes={[]} statuses={new Map()} placed={new Map()} scale={64} isViewer />);
    expect((screen.getByTestId('run-scale') as HTMLInputElement).disabled).toBe(true);
  });

});
