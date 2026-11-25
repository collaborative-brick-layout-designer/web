// Waybills, jobs and routing in the editor (Live Ops Phase 3): two people at
// once, through Undo, with the places, cars, jobs and track they name
// deleted, and through files; and the Live Ops panel.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as Y from 'yjs';
import networkFile from '../../../../../fixtures/contracts/route-search.json?raw';
import { readSidecar, writeSidecar, type Place } from '@cld/bbm';
import { deleteRecord, ensureRecordMaps, exportSidecarFromDoc, importSidecarIntoDoc, OPS_JOBS_KEY, readRecordsFromDoc, ROLLING_STOCK_KEY, WAYBILLS_KEY } from '@cld/ydoc';
import { asStock, OPS_LIMITS, placeTrain, TrackNetwork, trackRuns } from '@cld/parts-catalog/browser';
import { putCarsOnTrack, readStanding, takeCarOff } from '../cuts';
import { blueBrickLeavesOut } from '../DownloadAsDialog';
import { LiveOpsPanel } from '../LiveOpsPanel';
import {
  addJob, addMadeWaybills, addStop, addWaybill, cantText, deletedCarText, deletedPlacesText, giveWaybill, moveJob, moveStop, openLiveOps, opsView, previewWaybills, readOps, removeJob, removeStop, removeWaybill, restartWaybill, saveJob, saveWaybill, setCarOps, turnCar,
} from '../ops';
import { placeGroups, removePlace, savePlace, spotKey, spotNow } from '../places';
import { forRoster, fromRoster, removeStock, saveStock, updatedFromRoster } from '../trains';
import { createUndoManager, stepWhole } from '../useUndoManager';

afterEach(cleanup);

const net0 = JSON.parse(networkFile) as { parts: Record<string, never>; bricks: { id: string; part: string; points: number[][]; connexions: never }[] };
const networkOf = (without: string[] = []) =>
  new TrackNetwork(net0.bricks.filter((b) => !without.includes(b.id)).map((b) => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })));
const net = networkOf();
const runs = trackRuns(net);
const car = (id: string, more: object = {}) => asStock({ id, number: id.toUpperCase(), type: 'Boxcar', length: 12, trucks: [{ at: 3 }, { at: -3 }], ...more });
const place = (id: string, brick: string | null, over: Partial<Place> = {}): Place => ({ id, name: id, kind: 'industry', spots: brick ? [{ id: 's1', name: 'Dock', track: { brick, from: 0, to: 1 }, capacity: 3 }] : [], accepts: [], ships: [], tags: [], notes: '', ...over });

/** Cannery on M (a and b stand there), Mill on another piece of the same track, and the world off the layout. */
const MILL = net0.bricks.map((b) => b.id).find((id) => id !== 'M' && net.path(id, 0, 1).length > 1 && net.pathLength(id, 0, 1) > 12 && Math.hypot(net.path(id, 0, 1)[0]!.p.x - net.path('M', 0, 1)[0]!.p.x, net.path(id, 0, 1)[0]!.p.y - net.path('M', 0, 1)[0]!.p.y) > 60)!;
function layout(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('version', 5);
  ensureRecordMaps(doc);
  for (const id of ['a', 'b', 'c']) saveStock(doc, car(id));
  savePlace(doc, null, place('cannery', 'M', { ships: ['boxcar'] }));
  savePlace(doc, null, place('mill', MILL, { accepts: [' BOXCAR '] }));
  savePlace(doc, null, place('world', null, { kind: 'staging', accepts: ['boxcar'] }));
  putCarsOnTrack(doc, net, {}, ['a', 'b'], { brick: 'M', from: 0, to: 1, s: 30, facing: 'to' });
  return doc;
}
const view = (doc: Y.Doc, on = net) => {
  const { trains, stock } = readStanding(doc);
  const groups = placeGroups(doc);
  const spots = new Map(groups.flatMap((g) => g.places.flatMap((p) => p.spots.map((s) => [spotKey(g.owner, p.id, s.id), spotNow(on, on === net ? runs : trackRuns(on), g.owner, p, s)] as const))));
  return opsView({ records: readOps(doc), groups, spots, net: on, stock, trains, placed: new Map(trains.map((t) => [t.id, t.position ? placeTrain(on, t, stock) : null])) });
};
const copy = (of: Y.Doc) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(of));
  return d;
};
function sync(...docs: Y.Doc[]) {
  for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}
const pocket = (doc: Y.Doc, id: string) => view(doc).pockets.get(id)?.id ?? null;
const steps = (doc: Y.Doc) => {
  const um = createUndoManager(doc);
  um.stopCapturing();
  return { undo: () => stepWhole(doc, um, 'undo'), redo: () => stepWhole(doc, um, 'redo'), cut: () => um.stopCapturing() };
};
/** A waybill for a car: to the mill, loaded. */
function bound(doc: Y.Doc, id: string, to = 'mill'): string {
  const w = addWaybill(doc, id)!;
  saveWaybill(doc, w, { to1: to, load1: 'loaded' });
  return w;
}
function job(doc: Y.Doc, ...stops: string[]): string {
  const id = addJob(doc)!;
  for (const s of stops) addStop(doc, id, s);
  return id;
}

describe('routing', () => {
  it('cars at a place with a waybill go by the job that stops there and, later, where they go; every move changes the list', () => {
    const doc = layout();
    bound(doc, 'a');
    bound(doc, 'b', 'world');
    expect(view(doc).routing.cantRoute.map((c) => [c.car, cantText(view(doc), c)])).toEqual([['a', 'No job goes from cannery to mill.'], ['b', 'No job goes from cannery to world.']]);
    const j = job(doc, 'cannery', 'mill', 'world');
    expect(view(doc).routing.cantRoute).toEqual([]);
    expect(view(doc).routing.lists.get(j)).toEqual([
      { place: 'cannery', setOut: [], pickUp: [{ car: 'a', to: 'mill' }, { car: 'b', to: 'world' }] },
      { place: 'mill', setOut: [{ car: 'a', spot: 's1' }], pickUp: [] },
      { place: 'world', setOut: [{ car: 'b', spot: '' }], pickUp: [] },
    ]);
    // Moved to the mill: it is there.
    takeCarOff(doc, net, {}, 'a');
    putCarsOnTrack(doc, net, {}, ['a'], { brick: MILL, from: 0, to: 1, s: net.pathLength(MILL, 0, 1) / 2, facing: 'to' });
    expect(view(doc).at.get('a')).toEqual({ place: 'mill', spot: 's1' });
    expect(view(doc).routing.arrived).toEqual(['a']);
    expect(view(doc).routing.lists.get(j)![1]!.setOut).toEqual([]);
    // Delivered: finished, its load turned over; no home: it stays.
    turnCar(doc, 'a');
    expect(readStanding(doc).stock.get('a')!.opsLoad).toBe('empty');
    expect(view(doc).to.has('a')).toBe(false);
    // Off the layout: the car leaves the track and is there.
    turnCar(doc, 'b', { place: 'world', net, states: {} });
    expect(view(doc).at.get('b')).toEqual({ place: 'world', spot: '' });
    expect(readStanding(doc).trains.some((t) => t.position && t.units.some((u) => u.stock === 'b'))).toBe(false);
  });

  it('a car set aside, one nowhere, and a home', () => {
    const doc = layout();
    job(doc, 'cannery', 'mill');
    setCarOps(doc, 'a', { opsHome: 'mill', opsHold: true });
    setCarOps(doc, 'c', { opsHome: 'mill' });
    const v = view(doc);
    expect(v.routing.cantRoute).toEqual([{ car: 'a', why: 'held' }, { car: 'c', why: 'offTrack' }]);
    setCarOps(doc, 'a', { opsHold: false });
    expect(view(doc).routing.cars.get('a')).toMatchObject({ setOut: 1 });
  });
});

describe('what is deleted', () => {
  it('a place: nothing is lost, the cars are listed with why, and Undo brings them back', () => {
    const doc = layout();
    const w = bound(doc, 'a');
    const j = job(doc, 'cannery', 'mill');
    setCarOps(doc, 'b', { opsHome: 'mill' });
    expect(deletedPlacesText(doc, ['mill'])).toBe('In use by 1 waybill, 1 job, 1 car’s home: nothing is lost, and those cars are listed under Can’t route in Live Ops until you send them somewhere else.');
    expect(deletedPlacesText(doc, ['world'])).toBe('');
    const um = steps(doc);
    removePlace(doc, null, 'mill');
    const v = view(doc);
    expect(v.routing.cantRoute.map((c) => cantText(v, c))).toEqual(['The place it goes to was deleted. Pick another on its waybill.', 'Its home was deleted. Pick another.']);
    expect(v.waybills.get(w)!.legs[0]!.to).toBe('mill');
    expect(v.jobs.find((x) => x.id === j)!.stops).toHaveLength(2);
    um.undo();
    expect(view(doc).routing.cars.size).toBe(2);
  });

  it('a car: its waybill waits for another', () => {
    const doc = layout();
    const w = bound(doc, 'a');
    expect(deletedCarText(doc, 'a')).toContain('waiting for another car');
    expect(deletedCarText(doc, 'c')).toBe('');
    const um = steps(doc);
    removeStock(doc, 'a', readStanding(doc).trains, net);
    expect(view(doc).waybills.get(w)).toBeDefined();
    expect([...view(doc).pockets.values()]).toEqual([]);
    expect(view(doc).routing.cantRoute).toEqual([]);
    um.undo();
    expect(pocket(doc, 'a')).toBe(w);
    // Given to another instead.
    removeStock(doc, 'a', readStanding(doc).trains, net);
    giveWaybill(doc, w, 'b');
    expect(pocket(doc, 'b')).toBe(w);
    expect(readStanding(doc).stock.get('b')!.opsLoad).toBe('loaded');
  });

  it('the track under a car or a place, and a job', () => {
    const doc = layout();
    bound(doc, 'a');
    const j = job(doc, 'cannery', 'mill');
    expect(view(doc, networkOf(['M'])).routing.cantRoute).toEqual([{ car: 'a', why: 'nowhere' }]);
    removeJob(doc, j);
    expect(view(doc).routing.cantRoute[0]).toMatchObject({ car: 'a', why: 'noJob' });
  });
});

describe('two people at once', () => {
  it('their first waybills and jobs both stay', () => {
    const a = layout();
    const b = copy(a);
    addWaybill(a, 'a');
    addWaybill(b, 'b');
    addJob(a);
    addJob(b);
    sync(a, b);
    for (const d of [a, b]) {
      expect(readOps(d).waybills.size).toBe(2);
      expect(readOps(d).jobs).toHaveLength(2);
      expect(pocket(d, 'a')).not.toBeNull();
      expect(pocket(d, 'b')).not.toBeNull();
    }
  });

  it('different legs, fields and stops of one merge', () => {
    const a = layout();
    const w = bound(a, 'a');
    const j = job(a, 'cannery');
    const b = copy(a);
    saveWaybill(a, w, { to2: 'world' });
    saveWaybill(b, w, { note1: 'Ice first' });
    addStop(a, j, 'mill');
    addStop(b, j, 'world');
    saveJob(a, j, { name: 'A' });
    saveJob(b, j, { kind: 'turn' });
    setCarOps(a, 'a', { opsHome: 'world' });
    setCarOps(b, 'a', { opsHold: true });
    sync(a, b);
    for (const d of [a, b]) {
      const x = readOps(d);
      expect(x.waybills.get(w)!.legs.slice(0, 2)).toEqual([{ to: 'mill', spot: '', load: 'loaded', note: 'Ice first' }, { to: 'world', spot: '', load: '', note: '' }]);
      expect(x.jobs[0]!.stops.map((s) => s.place).sort()).toEqual(['cannery', 'mill', 'world']);
      expect(x.jobs[0]).toMatchObject({ name: 'A', kind: 'turn' });
      expect(readStanding(d).stock.get('a')).toMatchObject({ opsHome: 'world', opsHold: true });
    }
  });

  it('one waybill given to two cars is one car’s; two given to one car: one is in its pocket, the other waits', () => {
    const a = layout();
    const w = addWaybill(a)!;
    const w2 = addWaybill(a)!;
    const b = copy(a);
    giveWaybill(a, w, 'a');
    giveWaybill(b, w, 'b');
    sync(a, b);
    const has = (d: Y.Doc) => ['a', 'b'].filter((c) => pocket(d, c) === w);
    expect(has(a)).toHaveLength(1);
    expect(has(b)).toEqual(has(a));
    giveWaybill(a, w, 'c');
    giveWaybill(b, w2, 'c');
    sync(a, b);
    for (const d of [a, b]) {
      expect([w, w2]).toContain(pocket(d, 'c'));
      expect(readOps(d).waybills.size).toBe(2);
    }
    expect(pocket(a, 'c')).toBe(pocket(b, 'c'));
  });

  it('both press Delivered: it turns once', () => {
    const a = layout();
    const w = bound(a, 'a');
    saveWaybill(a, w, { to2: 'world', load2: 'empty', to3: 'cannery' });
    const b = copy(a);
    turnCar(a, 'a');
    turnCar(b, 'a');
    sync(a, b);
    for (const d of [a, b]) {
      expect(readOps(d).waybills.get(w)!.leg).toBe(2);
      expect(readStanding(d).stock.get('a')!.opsLoad).toBe('empty');
    }
  });

  it('one deletes a waybill or job while the other changes it: it is gone, and nothing is left half', () => {
    const a = layout();
    const w = bound(a, 'a');
    const j = job(a, 'cannery', 'mill');
    const b = copy(a);
    removeWaybill(a, w);
    saveWaybill(b, w, { note1: 'x' });
    removeJob(a, j);
    addStop(b, j, 'world');
    sync(a, b);
    for (const d of [a, b]) {
      expect(readOps(d).waybills.size).toBe(0);
      expect(readOps(d).jobs).toEqual([]);
      expect(pocket(d, 'a')).toBeNull();
      expect(view(d).routing.cantRoute).toEqual([]);
    }
  });

  it('a car’s editor, open while someone gives it a waybill, doesn’t take it back', () => {
    const doc = layout();
    const open = readStanding(doc).stock.get('a')!;
    const w = bound(doc, 'a');
    saveStock(doc, { ...open, name: 'Renamed' });
    expect(pocket(doc, 'a')).toBe(w);
    expect(readStanding(doc).stock.get('a')!.name).toBe('Renamed');
  });
});

describe('Undo', () => {
  it('takes back one step each', () => {
    const doc = layout();
    const um = steps(doc);
    const w = addWaybill(doc, 'a')!;
    um.cut();
    saveWaybill(doc, w, { to1: 'mill', load1: 'loaded', to2: 'world', load2: 'empty' });
    um.cut();
    turnCar(doc, 'a');
    expect(readOps(doc).waybills.get(w)!.leg).toBe(2);
    um.undo();
    expect(readOps(doc).waybills.get(w)!.leg).toBe(1);
    expect(readStanding(doc).stock.get('a')!.opsLoad).toBeUndefined();
    um.undo();
    um.undo();
    expect(readOps(doc).waybills.size).toBe(0);
    expect(pocket(doc, 'a')).toBeNull();
    um.redo();
    expect(pocket(doc, 'a')).toBe(w);
  });

  it('of a waybill someone else has given away since leaves theirs', () => {
    const a = layout();
    const um = steps(a);
    const w = addWaybill(a, 'a')!;
    um.cut();
    saveWaybill(a, w, { to1: 'mill' });
    um.cut();
    const b = copy(a);
    giveWaybill(b, w, 'b');
    sync(a, b);
    um.undo();
    sync(a, b);
    for (const d of [a, b]) {
      expect(pocket(d, 'b')).toBe(w);
      expect(pocket(d, 'a')).toBeNull();
    }
  });

  it('of Make waybills takes them all back; a finished one is replaced', () => {
    const doc = layout();
    const old = bound(doc, 'a');
    turnCar(doc, 'a');
    const um = steps(doc);
    const made = previewWaybills(view(doc), 7);
    expect(made).toEqual(previewWaybills(view(doc), 7));
    expect(made.made.map((m) => m.car).sort()).toEqual(['a', 'b', 'c']);
    expect(addMadeWaybills(doc, made)).toBe(3);
    expect(readOps(doc).waybills.has(old)).toBe(false);
    expect(view(doc).pockets.size).toBe(3);
    um.undo();
    expect([...readOps(doc).waybills.keys()]).toEqual([old]);
    // Someone gave one a waybill since the preview: that one keeps it.
    const w = bound(doc, 'b');
    expect(addMadeWaybills(doc, made)).toBe(2);
    expect(pocket(doc, 'b')).toBe(w);
  });
});

describe('order', () => {
  it('jobs and stops move, any number of times', () => {
    const doc = layout();
    const ids = [addJob(doc)!, addJob(doc)!, addJob(doc)!];
    expect(readOps(doc).jobs.map((j) => j.name)).toEqual(['Job 1', 'Job 2', 'Job 3']);
    for (let i = 0; i < 130; i++) moveJob(doc, readOps(doc).jobs[2]!.id, -1);
    expect(readOps(doc).jobs.map((j) => j.id).sort()).toEqual([...ids].sort());
    moveJob(doc, readOps(doc).jobs[0]!.id, -1);
    const first = readOps(doc).jobs[0]!.id;
    moveJob(doc, first, 1);
    expect(readOps(doc).jobs[1]!.id).toBe(first);
    const j = ids[0]!;
    for (const p of ['cannery', 'mill', 'world']) addStop(doc, j, p);
    const stops = () => readOps(doc).jobs.find((x) => x.id === j)!.stops;
    moveStop(doc, j, stops()[2]!.id, -1);
    expect(stops().map((s) => s.place)).toEqual(['cannery', 'world', 'mill']);
    moveStop(doc, j, stops()[0]!.id, 1);
    expect(stops().map((s) => s.place)).toEqual(['world', 'cannery', 'mill']);
    removeStop(doc, j, stops()[1]!.id);
    expect(stops().map((s) => s.place)).toEqual(['world', 'mill']);
  });

  it('no more than the limits', () => {
    const doc = layout();
    for (let i = 0; i < OPS_LIMITS.jobs; i++) expect(addJob(doc)).not.toBeNull();
    expect(addJob(doc)).toBeNull();
    const j = readOps(doc).jobs[0]!.id;
    for (let i = 0; i < OPS_LIMITS.stops + 5; i++) addStop(doc, j, 'mill');
    expect(readOps(doc).jobs[0]!.stops).toHaveLength(OPS_LIMITS.stops);
  });
});

describe('files', () => {
  it('go out and come back, in both kinds; a BlueBrick file says it leaves them out', () => {
    const doc = layout();
    const w = bound(doc, 'a');
    const j = job(doc, 'cannery', 'mill');
    setCarOps(doc, 'b', { opsHome: 'mill', opsHold: true });
    setCarOps(doc, 'c', { opsAt: 'world' });
    const out = readSidecar(writeSidecar(exportSidecarFromDoc(doc)!));
    const again = new Y.Doc();
    importSidecarIntoDoc(again, out);
    for (const key of [WAYBILLS_KEY, OPS_JOBS_KEY, ROLLING_STOCK_KEY] as const) expect(readRecordsFromDoc(again, key)).toEqual(readRecordsFromDoc(doc, key));
    expect(readOps(again).waybills.has(w)).toBe(true);
    expect(readOps(again).jobs[0]!.id).toBe(j);
    expect(blueBrickLeavesOut(out)).toEqual(expect.arrayContaining(['waybills', 'jobs']));
  });

  it('a roster’s copy has none of them; an update from it keeps the layout’s', () => {
    const s = car('a', { opsWaybill: 'w', opsHome: 'mill', opsAt: 'world', opsHold: true });
    for (const k of ['opsWaybill', 'opsHome', 'opsAt', 'opsHold']) {
      expect(forRoster(s)).not.toHaveProperty(k);
      expect(fromRoster({ ...s })).not.toHaveProperty(k);
    }
    expect(updatedFromRoster(s, { number: 'X', opsWaybill: 'z', opsHold: false })).toMatchObject({ number: 'X', opsWaybill: 'w', opsHome: 'mill', opsAt: 'world', opsHold: true });
  });
});

describe('the panel', () => {
  const panel = (doc: Y.Doc, isViewer = false, open: { tab?: 'cars' | 'waybills' | 'jobs'; waybill?: string; n: number } | null = null) => <LiveOpsPanel doc={doc} net={net} states={{}} view={view(doc)} isViewer={isViewer} open={open} onTrains={() => undefined} />;

  it('makes waybills, a job and its stops, and shows the switch list and what can’t be routed', () => {
    const doc = layout();
    const r = render(panel(doc));
    const redo = () => r.rerender(panel(doc));
    fireEvent.click(screen.getByTestId('ops-tab-waybills'));
    fireEvent.click(screen.getByTestId('ops-make'));
    expect(within(screen.getByTestId('ops-making')).getAllByRole('listitem').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByTestId('ops-make-add'));
    redo();
    expect(readOps(doc).waybills.size).toBe(3);
    expect(screen.getByTestId('ops-cant').textContent).toContain('No job goes from cannery to');
    fireEvent.click(screen.getByTestId('ops-tab-jobs'));
    fireEvent.click(screen.getByTestId('ops-new-job'));
    redo();
    for (const p of ['cannery', 'mill', 'world']) {
      fireEvent.change(screen.getByTestId('ops-add-stop'), { target: { value: p } });
      redo();
    }
    expect(screen.getByTestId('ops-switch-list').textContent).toContain('Pick up A for');
    fireEvent.change(screen.getByTestId('ops-job-name'), { target: { value: 'Cannery Turn' } });
    fireEvent.blur(screen.getByTestId('ops-job-name'));
    redo();
    fireEvent.click(screen.getByTestId('ops-back'));
    redo();
    expect(screen.getByRole('list', { name: 'Jobs' }).textContent).toContain('Cannery Turn');
    expect(screen.getByTestId('ops-job-moves').textContent).toMatch(/3 stops · 4 moves/);
  });

  it('a waybill by hand: its car, legs, the leg it is on, and starting it again', () => {
    const doc = layout();
    const w = addWaybill(doc)!;
    const r = render(panel(doc, false, { waybill: w, n: 1 }));
    const redo = () => r.rerender(panel(doc, false, { waybill: w, n: 1 }));
    fireEvent.change(screen.getByTestId('ops-waybill-car'), { target: { value: 'a' } });
    redo();
    fireEvent.change(screen.getAllByTestId('ops-leg-to')[0]!, { target: { value: 'mill' } });
    redo();
    fireEvent.change(screen.getByTestId('ops-leg-load'), { target: { value: 'loaded' } });
    fireEvent.change(screen.getByTestId('ops-leg-spot'), { target: { value: 's1' } });
    fireEvent.change(screen.getAllByTestId('ops-leg-to')[2]!, { target: { value: 'world' } });
    redo();
    expect(readOps(doc).waybills.get(w)).toMatchObject({ car: 'a', legs: [{ to: 'mill', spot: 's1', load: 'loaded' }, null, { to: 'world' }, null] });
    fireEvent.click(screen.getByTestId('ops-delivered'));
    redo();
    expect(readOps(doc).waybills.get(w)!.leg).toBe(3);
    turnCar(doc, 'a');
    redo();
    fireEvent.click(screen.getByTestId('ops-restart'));
    expect(readOps(doc).waybills.get(w)!.leg).toBe(1);
    expect(readStanding(doc).stock.get('a')!.opsLoad).toBe('loaded');
    restartWaybill(doc, 'nothing');
  });

  it('has no dead ends: no places, no cars; and a viewer changes nothing', () => {
    const doc = new Y.Doc();
    const opened = vi.fn();
    window.addEventListener('cld:open-places', opened);
    const r = render(panel(doc));
    fireEvent.click(screen.getByRole('button', { name: 'Open Places' }));
    expect(opened).toHaveBeenCalled();
    savePlace(doc, null, place('mill', null));
    r.rerender(panel(doc));
    expect(screen.getByRole('button', { name: 'Open Trains' })).toBeTruthy();
    r.unmount();
    const full = layout();
    bound(full, 'a');
    render(panel(full, true, { tab: 'waybills', n: 1 }));
    expect(screen.queryByTestId('ops-make')).toBeNull();
    fireEvent.click(screen.getByTestId('ops-tab-cars'));
    for (const box of screen.getAllByTestId('ops-hold')) expect((box as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ops-tab-jobs'));
    expect(screen.queryByTestId('ops-new-job')).toBeNull();
    const ev = vi.fn();
    window.addEventListener('cld:open-live-ops', ev);
    openLiveOps({ tab: 'jobs' });
    expect(ev).toHaveBeenCalled();
  });
});

describe('odd records', () => {
  it('two places of one id, a waybill with no fields, a job of text: nothing breaks', () => {
    const doc = layout();
    const meta = doc.getMap('meta');
    (meta.get(WAYBILLS_KEY) as Y.Map<unknown>).set('odd', new Y.Map());
    (meta.get(OPS_JOBS_KEY) as Y.Map<unknown>).set('odd', new Y.Map<unknown>([['stop_', 5], ['order', 'x']]));
    const v = view(doc);
    expect(v.waybills.get('odd')).toMatchObject({ car: '', leg: 1 });
    expect(v.jobs[0]).toMatchObject({ id: 'odd', stops: [] });
    doc.transact(() => deleteRecord(doc, WAYBILLS_KEY, 'odd'));
    expect(v.routing.cantRoute).toEqual([]);
  });
});
