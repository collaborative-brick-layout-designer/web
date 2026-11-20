// The editor's rolling stock and trains (trains design 2.3, 2.4, 2.6, 6.4):
// records read back whole, quick cars, edits as undo steps, roster copies
// linked by libraryId/libraryVersion, and the Trains panel's main paths.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import { readRecordsFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY } from '@cld/ydoc';
import { asStock, simpleStock } from '@cld/parts-catalog/browser';
import { asTrain, fromRoster, newStock, newTrain, removeStock, removeTrain, rosterIsNewer, saveStock, saveTrain, stockLabel, trainState, updatedFromRoster, withLength } from '../trains';
import { TrainsPanel } from '../TrainsPanel';
import { createUndoManager } from '../useUndoManager';

vi.mock('../../api', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, api: { ...(real.api as object), rollingStock: { list: async () => ({ stock: [] }) }, orgs: { list: async () => ({ orgs: [] }) } } };
});

describe('editor trains', () => {
  it('reads a train back whole, with defaults and unknown fields kept', () => {
    const t = asTrain({ id: 't1', units: [{ stock: 'a' }, { stock: 'b', reversed: true }, { nope: 1 }], position: { brick: 'X', from: 0, to: 1, s: 3, facing: 'from' }, later: 7 });
    expect(t).toMatchObject({ id: 't1', name: '', units: [{ stock: 'a', reversed: false }, { stock: 'b', reversed: true }], position: { brick: 'X', s: 3, facing: 'from' }, later: 7 });
    expect(asTrain({ id: 't2' }).position).toBeNull();
  });

  it('makes quick cars in turn colors, and keeps trucks in proportion when the length changes', () => {
    const a = newStock({ number: '1' }, []);
    const b = newStock({ number: '2' }, [a]);
    expect(a.look.color).not.toBe(b.look.color);
    expect(a.trucks.map((t) => t.at)).toEqual([8, -8]);
    const longer = withLength(a, 48);
    expect(longer.trucks.map((t) => t.at)).toEqual([12, -12]);
    expect(longer.bodyLength).toBe(46);
    expect(stockLabel({ ...a, number: '', name: '' })).toBe('Car');
  });

  it('deleting a car takes it out of its trains, in one undo step', () => {
    const doc = new Y.Doc();
    const undo = createUndoManager(doc);
    const a = simpleStock('a', { number: '1' });
    const b = simpleStock('b', { number: '2' });
    saveStock(doc, a);
    saveStock(doc, b);
    const t = { ...newTrain('T', [{ stock: 'a', reversed: false }, { stock: 'b', reversed: false }], []), position: { brick: 'X', from: 0, to: 1, s: 1, facing: 'to' as const } };
    saveTrain(doc, t);
    undo.stopCapturing();
    removeStock(doc, 'a', [t]);
    expect(readRecordsFromDoc(doc, ROLLING_STOCK_KEY).map((r) => r.id)).toEqual(['b']);
    expect(asTrain(readRecordsFromDoc(doc, TRAINS_KEY)[0]!).units).toEqual([{ stock: 'b', reversed: false }]);
    undo.undo();
    expect(readRecordsFromDoc(doc, ROLLING_STOCK_KEY).map((r) => r.id)).toEqual(['a', 'b']);
    expect(asTrain(readRecordsFromDoc(doc, TRAINS_KEY)[0]!).units).toHaveLength(2);
    undo.stopCapturing();
    // The last car out: the train comes off the track.
    removeStock(doc, 'a', [t]);
    removeStock(doc, 'b', [asTrain(readRecordsFromDoc(doc, TRAINS_KEY)[0]!)]);
    expect(asTrain(readRecordsFromDoc(doc, TRAINS_KEY)[0]!).position).toBeNull();
    removeTrain(doc, t.id);
    expect(readRecordsFromDoc(doc, TRAINS_KEY)).toEqual([]);
  });

  it('copies roster cars in with a new id, and updates keep the layout id', () => {
    const rec = { number: '9', name: 'Hopper', length: 28, libraryId: 'L1', libraryVersion: 2 };
    const c = fromRoster(rec);
    expect(c.id).toBeTruthy();
    expect(c).toMatchObject({ number: '9', libraryId: 'L1', libraryVersion: 2, length: 28 });
    expect(rosterIsNewer(c, { id: 'L1', version: 3 })).toBe(true);
    expect(rosterIsNewer(c, { id: 'L1', version: 2 })).toBe(false);
    expect(rosterIsNewer(c, { id: 'L2', version: 9 })).toBe(false);
    const up = updatedFromRoster(c, { ...rec, name: 'Covered hopper', libraryVersion: 3 });
    expect(up).toMatchObject({ id: c.id, name: 'Covered hopper', libraryVersion: 3 });
  });

  it('says where a train is', () => {
    const t = newTrain('T', [], []);
    expect(trainState(t, undefined)).toBe('off');
    const on = { ...t, position: { brick: 'X', from: 0, to: 1, s: 0, facing: 'to' as const } };
    expect(trainState(on, null)).toBe('lost');
    expect(trainState(on, { units: [], offTrack: true })).toBe('offEnd');
    expect(trainState(on, { units: [], offTrack: false })).toBe('ok');
  });
});

describe('Trains panel', () => {
  function open(doc: Y.Doc) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (stock = readRecordsFromDoc(doc, ROLLING_STOCK_KEY), trains = readRecordsFromDoc(doc, TRAINS_KEY)) => (
      <QueryClientProvider client={qc}>
        <TrainsPanel
          doc={doc}
          net={null}
          stock={stock.map((r) => asStock(r))}
          trains={trains.map(asTrain)}
          placed={new Map()}
          switchStates={{}}
          parts={[]}
          isViewer={false}
          canUseRoster={false}
        />
      </QueryClientProvider>
    );
    const r = render(view());
    return { rerender: () => r.rerender(view()) };
  }

  it('makes a quick car, then a train of it', () => {
    const doc = new Y.Doc();
    const { rerender } = open(doc);
    expect(screen.getByText(/No rolling stock yet/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('stock-new'));
    fireEvent.change(screen.getByLabelText('Road number'), { target: { value: '4021' } });
    fireEvent.change(screen.getByTestId('stock-length'), { target: { value: '28' } });
    fireEvent.click(screen.getByTestId('stock-save'));
    const saved = readRecordsFromDoc(doc, ROLLING_STOCK_KEY);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ number: '4021', length: 28 });
    rerender();
    fireEvent.click(screen.getByLabelText(/Pick 4021 for a new train/));
    fireEvent.click(screen.getByTestId('train-from-ticked'));
    const trains = readRecordsFromDoc(doc, TRAINS_KEY).map(asTrain);
    expect(trains).toHaveLength(1);
    expect(trains[0]!.units).toEqual([{ stock: saved[0]!.id, reversed: false }]);
    rerender();
    expect(screen.getByTestId('train-state').textContent).toBe('Not on the map');
    // No track on this layout: nowhere to put it yet.
    expect((screen.getByTestId('train-place') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the roster for someone without an account, and shows the trucks under More details', () => {
    const doc = new Y.Doc();
    open(doc);
    expect(screen.queryByTestId('roster-open')).toBeNull();
    fireEvent.click(screen.getByTestId('stock-new'));
    expect(screen.queryByTestId('stock-front-truck')).toBeNull();
    fireEvent.click(screen.getByTestId('stock-more'));
    expect((screen.getByTestId('stock-front-truck') as HTMLInputElement).value).toBe('8');
    // A rear truck ahead of the front one can't be saved.
    fireEvent.change(screen.getByTestId('stock-front-truck'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('stock-rear-truck'), { target: { value: '0' } });
    expect((screen.getByTestId('stock-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
