// Cars on the track in the editor (Live Ops design 2.2, 2.3): two people
// moving cars at once, through Undo, and with the track under them deleted,
// leave every car in one place; roster copies leave out where a car stands;
// the panel's and the car bar's actions.

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import networkFile from '../../../../../fixtures/contracts/route-search.json?raw';
import { ensureRecordMaps, exportSidecarFromDoc, importSidecarIntoDoc, readRecordsFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY } from '@cld/ydoc';
import { asStock, EMPTIED_KEEP_MS, placeTrain, standingIn, startDrag, TrackNetwork, type Train } from '@cld/parts-catalog/browser';
import { CarBar } from '../CarBar';
import { cutName, namedTrains, putCarsOnTrack, putTrainOnTrack, readStanding, saveTrainCars, setLoad, takeCarOff, takeCutOff, writeCutChange } from '../cuts';
import { useEditorStore } from '../editorStore';
import { TrainsPanel } from '../TrainsPanel';
import { forRoster, fromRoster, newTrain, removeStock, saveStock, saveTrain, updatedFromRoster } from '../trains';
import { createUndoManager, stepWhole } from '../useUndoManager';

const net0 = JSON.parse(networkFile) as { parts: Record<string, never>; bricks: { id: string; part: string; points: number[][]; connexions: never }[] };
const bricks = (without: string[] = []) =>
  net0.bricks.filter((b) => !without.includes(b.id)).map((b) => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions }));
const net = new TrackNetwork(bricks());

const car = (id: string, more: object = {}) => asStock({ id, number: id.toUpperCase(), length: 12, trucks: [{ at: 3 }, { at: -3 }], ...more });
const at = (brick: string, s: number) => ({ brick, from: 0, to: 1, s, facing: 'to' as const });

function layout(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('version', 5);
  ensureRecordMaps(doc);
  for (const id of ['a', 'b', 'c', 'd']) saveStock(doc, car(id));
  putCarsOnTrack(doc, net, {}, ['a', 'b', 'c'], at('M', 30));
  return doc;
}
const copy = (of: Y.Doc) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(of));
  return d;
};
function sync(...docs: Y.Doc[]) {
  for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}
/** Where each car stands: "cut: a b" in order, however the cuts are named. */
const standing = (doc: Y.Doc) =>
  readStanding(doc)
    .trains.filter((t) => t.position && t.units.length)
    .map((t) => t.units.map((u) => u.stock).join(' '))
    .sort();
const cutOf = (doc: Y.Doc, id: string) => standingIn(id, readStanding(doc).trains)!;
let n = 0;
function drag(doc: Y.Doc, id: string, x: number, y = 0): void {
  const { trains, stock } = readStanding(doc);
  const t = standingIn(id, trains)!;
  const unit = placeTrain(net, t, stock)!.units.findIndex((u) => u.stock === id);
  const m = startDrag(net, trains, stock, {}, t.id, unit, `n${++n}`)!.to({ x, y });
  expect(m).not.toBeNull();
  writeCutChange(doc, m!.change);
}
const steps = (doc: Y.Doc) => {
  const um = createUndoManager(doc);
  // Each change a step of its own, whatever the clock says.
  um.stopCapturing();
  return { undo: () => stepWhole(doc, um, 'undo'), redo: () => stepWhole(doc, um, 'redo'), canUndo: () => um.canUndo() };
};
/** Both copies read the same, and every car stands once. */
function once(docs: Y.Doc[], cars = ['a', 'b', 'c'], why = '') {
  for (const d of docs) {
    expect(standing(d)).toEqual(standing(docs[0]!));
    expect(standing(d).join(' ').split(' ').sort(), why + ' ' + JSON.stringify(readRecordsFromDoc(d, TRAINS_KEY))).toEqual([...cars].sort());
  }
}

describe('two people at once', () => {
  it('the same car, split off to two places: it stands in one', () => {
    const a = layout();
    const b = copy(a);
    drag(a, 'c', 6);
    drag(b, 'c', 14);
    sync(a, b);
    once([a, b]);
    expect(standing(a)).toEqual(['a b', 'c']);
  });

  it('two cars off one cut', () => {
    const a = layout();
    const b = copy(a);
    drag(a, 'a', 84);
    drag(b, 'c', 6);
    sync(a, b);
    once([a, b]);
    expect(standing(a)).toEqual(['a', 'b', 'c']);
  });

  it('two cuts moved: both moves stay', () => {
    const a = layout();
    drag(a, 'c', 6);
    const b = copy(a);
    drag(a, 'c', 10);
    drag(b, 'b', 60);
    sync(a, b);
    once([a, b]);
    expect(cutOf(a, 'c').position!.brick).toBe('A');
    expect(cutOf(a, 'a').position!.brick).toBe(cutOf(b, 'a').position!.brick);
  });

  it('two cuts coupled to a third: all three are one, none is lost', () => {
    const a = layout();
    drag(a, 'c', 6);
    putCarsOnTrack(a, net, {}, ['d'], at('E', 12));
    drag(a, 'a', 70); // couples to d
    putCarsOnTrack(a, net, {}, ['d'], at('T', 8));
    const b = copy(a);
    drag(a, 'c', 60); // to the cut ahead of it
    drag(b, 'd', 60);
    sync(a, b);
    once([a, b], ['a', 'b', 'c', 'd']);
  });

  it('coupled to a cut that someone coupled elsewhere meanwhile', () => {
    const a = layout();
    drag(a, 'c', 6);
    drag(a, 'a', 84);
    const b = copy(a); // c | b | a
    drag(a, 'b', 80); // b couples to a: b's cut is left empty
    drag(b, 'c', 44); // c couples to b
    sync(a, b);
    once([a, b]);
  });

  it('a car loaded by one and moved by the other', () => {
    const a = layout();
    const b = copy(a);
    setLoad(a, 'c', 'loaded');
    drag(b, 'c', 6);
    sync(a, b);
    once([a, b]);
    expect(readStanding(a).stock.get('c')).toMatchObject({ opsLoad: 'loaded', opsCut: cutOf(a, 'c').id });
  });

  it('the first cut of a layout, made by both', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('version', 5);
    ensureRecordMaps(a);
    const b = copy(a);
    saveStock(a, car('a'));
    putCarsOnTrack(a, net, {}, ['a'], at('M', 20));
    saveStock(b, car('b'));
    putCarsOnTrack(b, net, {}, ['b'], at('E', 8));
    sync(a, b);
    once([a, b], ['a', 'b']);
  });

  it('every pair of moves, undone by either, in any order', () => {
    const moves: [string, number][] = [['a', 84], ['b', 70], ['b', 20], ['c', 6], ['c', 60], ['d', 40], ['d', 116]];
    for (const [ca, xa] of moves)
      for (const [cb, xb] of moves)
        for (const undo of ['none', 'a', 'b', 'both', 'late'] as const) {
          const a = layout();
          putCarsOnTrack(a, net, {}, ['d'], at('E', 12));
          const b = copy(a);
          const ua = steps(a);
          const ub = steps(b);
          drag(a, ca, xa);
          drag(b, cb, xb);
          if (undo === 'a') ua.undo();
          sync(a, b);
          if (undo === 'b' || undo === 'both') ub.undo();
          if (undo === 'late' || undo === 'both') ua.undo();
          sync(a, b);
          once([a, b], ['a', 'b', 'c', 'd'], [ca, xa, cb, xb, undo].join(' '));
          ua.redo();
          sync(a, b);
          once([a, b], ['a', 'b', 'c', 'd']);
        }
  });
});

describe('undo, and the track under standing cars', () => {
  it('a split is one step; undone and redone', () => {
    const doc = layout();
    const um = steps(doc);
    drag(doc, 'c', 6);
    expect(standing(doc)).toEqual(['a b', 'c']);
    um.undo();
    expect(standing(doc)).toEqual(['a b c']);
    expect(um.canUndo()).toBe(false);
    um.redo();
    expect(standing(doc)).toEqual(['a b', 'c']);
  });

  it('a split undone after someone coupled to what it made: their car stands where it was', () => {
    const a = layout();
    putCarsOnTrack(a, net, {}, ['d'], at('E', 12));
    const um = steps(a);
    drag(a, 'c', 6);
    const b = copy(a);
    drag(b, 'b', 25); // b goes back and couples to c
    sync(a, b);
    um.undo();
    sync(a, b);
    once([a, b], ['a', 'b', 'c', 'd']);
  });

  it('its track deleted: the cut says so, its cars stay in it, and the track’s return puts them back', () => {
    const doc = layout();
    const t = cutOf(doc, 'a');
    const { stock } = readStanding(doc);
    const was = placeTrain(net, t, stock);
    expect(placeTrain(new TrackNetwork(bricks(['M'])), t, stock)).toBeNull();
    expect(standing(doc)).toEqual(['a b c']);
    expect(placeTrain(new TrackNetwork(bricks()), t, stock)).toEqual(was);
  });

  it('a cut emptied a day ago goes with the next move, unless a car names it', () => {
    const doc = layout();
    drag(doc, 'c', 6);
    drag(doc, 'c', 34); // couples again: its own cut is left empty
    const empties = () => readRecordsFromDoc(doc, TRAINS_KEY).filter((t) => (t.units as unknown[]).length === 0);
    expect(empties()).toHaveLength(1);
    writeCutChange(doc, { trains: [cutOf(doc, 'a')], cars: {}, emptied: [] }, Date.now() + EMPTIED_KEEP_MS + 1000);
    expect(empties()).toHaveLength(0);
    expect(standing(doc)).toEqual(['a b c']);
  });
});

describe('off the track, trains and rosters', () => {
  it('a car taken off leaves the others where they stand; a whole cut too', () => {
    const doc = layout();
    const x = () => Object.fromEntries(readStanding(doc).trains.filter((t) => t.position && t.units.length).flatMap((t) => placeTrain(net, t, readStanding(doc).stock)!.units.map((u) => [u.stock, Math.round(u.centre.x)])));
    const before = x();
    takeCarOff(doc, net, {}, 'b');
    expect(x()).toEqual({ a: before.a, c: before.c });
    expect(readStanding(doc).stock.get('b')!.opsCut).toBeUndefined();
    takeCutOff(doc, cutOf(doc, 'a').id);
    expect(standing(doc)).toEqual(['c']);
  });

  it('deleting a car between two leaves them where they stand', () => {
    const doc = layout();
    removeStock(doc, 'b', readStanding(doc).trains, net);
    expect(standing(doc)).toEqual(['a', 'c']);
  });

  it('a train put on the track takes its cars from their cuts; one added in its editor too, and one left out is off', () => {
    const doc = layout();
    const t = newTrain('Local', [{ stock: 'b', reversed: false }], []);
    saveTrain(doc, t);
    expect(standing(doc)).toEqual(['a b c']);
    putTrainOnTrack(doc, net, {}, t, at('E', 8));
    expect(standing(doc)).toEqual(['a', 'b', 'c']);
    const now = () => readStanding(doc).trains.find((x) => x.id === t.id)!;
    saveTrainCars(doc, net, {}, { ...now(), units: [...now().units, { stock: 'c', reversed: true }] });
    expect(standing(doc)).toEqual(['a', 'b c']);
    saveTrainCars(doc, net, {}, { ...now(), units: [{ stock: 'c', reversed: true }] });
    expect(standing(doc)).toEqual(['a', 'c']);
  });

  it('two plain trains may still share a car', () => {
    const doc = new Y.Doc();
    saveStock(doc, car('a'));
    for (const id of ['T1', 'T2']) putTrainOnTrack(doc, net, {}, newTrain(id, [{ stock: 'a', reversed: false }], []), at('M', 20));
    expect(standing(doc)).toEqual(['a', 'a']);
  });

  it('a roster’s copy has no load and no place to stand; an update from it keeps the layout’s', () => {
    const s = car('a', { opsCut: 't1', opsLoad: 'loaded' });
    expect(forRoster(s)).not.toHaveProperty('opsCut');
    expect(forRoster(s)).not.toHaveProperty('opsLoad');
    expect(fromRoster({ ...s })).not.toHaveProperty('opsCut');
    expect(updatedFromRoster(s, { number: 'X', opsLoad: 'empty' })).toMatchObject({ number: 'X', opsCut: 't1', opsLoad: 'loaded' });
  });

  it('goes out to a file and comes back', () => {
    const doc = layout();
    drag(doc, 'c', 6);
    setLoad(doc, 'a', 'empty');
    const out = JSON.parse(JSON.stringify(exportSidecarFromDoc(doc))) as NonNullable<ReturnType<typeof exportSidecarFromDoc>>;
    const again = new Y.Doc();
    importSidecarIntoDoc(again, out);
    expect(standing(again)).toEqual(standing(doc));
    expect(readRecordsFromDoc(again, ROLLING_STOCK_KEY)).toEqual(readRecordsFromDoc(doc, ROLLING_STOCK_KEY));
    expect(readRecordsFromDoc(again, TRAINS_KEY)).toEqual(readRecordsFromDoc(doc, TRAINS_KEY));
  });
});

describe('on screen', () => {
  const panel = (doc: Y.Doc) => {
    const { trains, stock } = readStanding(doc);
    const shown: Train[] = trains.filter((t) => !t.cut || t.units.length > 0);
    return (
      <QueryClientProvider client={new QueryClient()}>
        <TrainsPanel doc={doc} net={net} stock={[...stock.values()]} trains={shown} placed={new Map(shown.map((t) => [t.id, t.position ? placeTrain(net, t, stock) : null]))} switchStates={{}} parts={[]} isViewer={false} canUseRoster={false} checks={[]} names={{ trains: new Map(), stock: new Map(), routes: new Map() } as never} />
      </QueryClientProvider>
    );
  };

  it('the panel lists cuts apart from trains, places ticked cars, and sets a load', () => {
    const doc = layout();
    const view = render(panel(doc));
    expect(screen.getByRole('list', { name: 'Cars on the track' }).textContent).toContain('A and 2 more');
    expect(screen.getByTestId('trains-tab-trains').textContent).toContain('Trains (0)');
    fireEvent.click(screen.getByTestId('trains-tab-stock'));
    expect(screen.getAllByTestId('car-standing').map((x) => x.textContent)).toEqual(['On the track, coupled to 2 others', 'On the track, coupled to 2 others', 'On the track, coupled to 2 others', 'Not on the map']);
    fireEvent.change(screen.getByLabelText('Load of A'), { target: { value: 'loaded' } });
    expect(readStanding(doc).stock.get('a')!.opsLoad).toBe('loaded');
    fireEvent.change(screen.getByLabelText('Load of A'), { target: { value: '' } });
    expect(readStanding(doc).stock.get('a')!.opsLoad).toBeUndefined();
    fireEvent.click(screen.getByLabelText('Pick D for a new train'));
    fireEvent.click(screen.getByTestId('cars-place'));
    expect(useEditorStore.getState().carsPlacing).toEqual(['d']);
    useEditorStore.getState().setCarsPlacing(null);
    fireEvent.click(screen.getAllByTestId('car-take-off')[0]!);
    expect(standing(doc)).toEqual(['b c']);
    view.unmount();
  });

  it('the car bar: its load, and off the track', () => {
    const doc = layout();
    useEditorStore.getState().setPickedCar('b');
    const bar = () => {
      const { trains, stock } = readStanding(doc);
      return <CarBar doc={doc} net={net} trains={trains} stock={stock} states={{}} />;
    };
    const view = render(bar());
    expect(screen.getByTestId('car-coupled').textContent).toContain('Coupled to 2 others');
    fireEvent.click(screen.getByTestId('car-load-empty'));
    view.rerender(bar());
    expect(screen.getByTestId('car-load-empty').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('car-off'));
    view.rerender(bar());
    expect(screen.queryByTestId('car-bar')).toBeNull();
    expect(useEditorStore.getState().pickedCar).toBeNull();
    expect(standing(doc)).toEqual(['a', 'c']);
  });

  it('a cut’s name is its cars’', () => {
    const doc = layout();
    const { trains, stock } = readStanding(doc);
    expect(namedTrains(trains, stock).map((t) => t.name)).toEqual(['A and 2 more']);
    expect(cutName({ ...trains[0]!, units: [] }, stock)).toBe('Cars');
  });
});
