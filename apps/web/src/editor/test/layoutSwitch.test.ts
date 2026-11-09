// Switching layouts never mixes them: each layout id gets its own doc and
// provider, and a layout left with offline edits keeps its own connection
// until they're sent, to that layout only.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

type Handler = (arg: unknown) => void;
const providers: FakeProvider[] = [];

class FakeProvider {
  handlers = new Map<string, Handler[]>();
  awareness: Awareness;
  // (sendOnlyOwnPresence swaps it for its own.)
  _awarenessUpdateHandler = (): void => undefined;
  wsconnected = true;
  synced = false;
  ws: { bufferedAmount: number } | null = { bufferedAmount: 0 };
  disconnected = false;
  destroyed = false;
  constructor(
    _url: string,
    readonly room: string,
    readonly doc: Y.Doc,
    opts: { awareness?: Awareness } = {},
  ) {
    this.awareness = opts.awareness ?? new Awareness(doc);
    providers.push(this);
  }
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
  }
  off(event: string, h: Handler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((x) => x !== h));
  }
  emit(event: string, arg: unknown) {
    if (event === 'sync') this.synced = arg as boolean;
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  disconnect() {
    this.disconnected = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

const { MERGE_REFUSED, UPDATE_REFUSED, layoutsStillSending, useLayoutDoc } = await import('../useLayoutDoc');
const { dropRefusedCopy, markRefusedCopyKept, useRefusedCopies } = await import('../refusedCopies');

function destroyed(doc: Y.Doc): () => boolean {
  let gone = false;
  doc.on('destroy', () => (gone = true));
  return () => gone;
}

function unloadAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

function addLayer(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    doc.getMap('layerData').set(id, new Y.Map());
    doc.getArray<string>('layers').push([id]);
  });
}

describe('switching layouts', () => {
  afterEach(() => {
    providers.length = 0;
    vi.useRealTimers();
    for (const c of useRefusedCopies.getState().copies) dropRefusedCopy(c.key);
  });

  it('gives each layout id its own doc and provider, and closes the one left', () => {
    const { result, rerender } = renderHook(({ id }) => useLayoutDoc(id), { initialProps: { id: 'A' } });
    const a = providers.at(-1)!;
    act(() => a.emit('sync', true));
    act(() => addLayer(a.doc, 'only-in-A'));
    expect(result.current.doc).toBe(a.doc);

    rerender({ id: 'B' });
    const b = providers.at(-1)!;
    expect(b).not.toBe(a);
    expect(b.room).toBe('B');
    expect(b.doc).not.toBe(a.doc);
    expect(b.doc.getArray('layers').toArray()).toEqual([]);
    // A was synced: nothing left to send, so its connection closes now.
    expect(a.destroyed).toBe(true);
    expect(layoutsStillSending()).toEqual([]);
  });

  it('a layout left with offline edits sends them to itself when back online, then closes', () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ id }) => useLayoutDoc(id), { initialProps: { id: 'A' } });
    const a = providers.at(-1)!;
    act(() => a.emit('sync', true));
    // Offline: the edit stays in A's doc until the connection is back.
    a.wsconnected = false;
    act(() => a.emit('sync', false));
    act(() => addLayer(a.doc, 'offline-edit'));

    rerender({ id: 'B' });
    const b = providers.at(-1)!;
    expect(a.destroyed).toBe(false);
    expect(layoutsStillSending()).toEqual(['A']);
    expect(b.doc.getArray('layers').toArray()).toEqual([]);

    // Back online: A's provider resyncs A (its step 2 carries the edit).
    a.wsconnected = true;
    act(() => a.emit('sync', true));
    act(() => vi.advanceTimersByTime(200));
    expect(a.destroyed).toBe(true);
    expect(layoutsStillSending()).toEqual([]);
    expect(b.doc.getArray('layers').toArray()).toEqual([]);
    unmount();
  });

  it('a left layout whose connection ends for good stops waiting', () => {
    const { rerender, unmount } = renderHook(({ id }) => useLayoutDoc(id), { initialProps: { id: 'A' } });
    const a = providers.at(-1)!;
    act(() => a.emit('sync', true));
    a.wsconnected = false;
    act(() => a.emit('sync', false));
    act(() => addLayer(a.doc, 'offline-edit'));
    rerender({ id: 'B' });
    expect(layoutsStillSending()).toEqual(['A']);
    act(() => a.emit('connection-close', { code: 4404, reason: 'access_revoked' }));
    expect(a.destroyed).toBe(true);
    expect(layoutsStillSending()).toEqual([]);
    unmount();
  });

  it('says plainly when the server refuses a merge, and stops reconnecting', () => {
    const { result } = renderHook(() => useLayoutDoc('C'));
    const p = providers.at(-1)!;
    act(() => p.emit('connection-close', { code: 1008, reason: 'layout_merge_refused' }));
    expect(result.current.loadError?.message).toBe(MERGE_REFUSED);
    expect(p.disconnected).toBe(true);
  });

  it('keeps the refused copy after leaving the editor, and asks before the page closes until it is kept', () => {
    const { unmount } = renderHook(() => useLayoutDoc('C'));
    const p = providers.at(-1)!;
    act(() => p.emit('sync', true));
    act(() => addLayer(p.doc, 'synced'));
    p.wsconnected = false;
    act(() => p.emit('sync', false));
    act(() => addLayer(p.doc, 'made-offline'));
    const gone = destroyed(p.doc);
    act(() => p.emit('connection-close', { code: 1008, reason: 'layout_merge_refused' }));
    unmount();
    expect(gone()).toBe(false);
    const [copy] = useRefusedCopies.getState().copies;
    expect(copy?.layoutId).toBe('C');
    expect(copy?.doc.getArray('layers').toArray()).toEqual(['synced', 'made-offline']);
    expect(unloadAsks()).toBe(true);
    // Saved or downloaded: no longer asks; let go: the doc goes.
    markRefusedCopyKept(copy!.key);
    expect(unloadAsks()).toBe(false);
    dropRefusedCopy(copy!.key);
    expect(gone()).toBe(true);
    expect(useRefusedCopies.getState().copies).toEqual([]);
  });

  it('a left layout refused by the server keeps its copy too', () => {
    const { rerender, unmount } = renderHook(({ id }) => useLayoutDoc(id), { initialProps: { id: 'A' } });
    const a = providers.at(-1)!;
    act(() => a.emit('sync', true));
    a.wsconnected = false;
    act(() => a.emit('sync', false));
    act(() => addLayer(a.doc, 'offline-edit'));
    rerender({ id: 'B' });
    const gone = destroyed(a.doc);
    act(() => a.emit('connection-close', { code: 1008, reason: 'layout_merge_refused' }));
    expect(layoutsStillSending()).toEqual([]);
    expect(a.destroyed).toBe(true);
    expect(gone()).toBe(false);
    expect(useRefusedCopies.getState().copies.map((c) => c.layoutId)).toEqual(['A']);
    unmount();
  });

  // Audit 2026-10-20: offline edits were dropped when the connection came
  // back to a sign-in that had ended (or a layout deleted) meanwhile.
  it('edits made offline are kept when the person was signed out meanwhile', () => {
    const { result, unmount } = renderHook(() => useLayoutDoc('E'));
    const p = providers.at(-1)!;
    act(() => p.emit('sync', true));
    act(() => addLayer(p.doc, 'synced'));
    p.wsconnected = false;
    act(() => p.emit('sync', false));
    act(() => addLayer(p.doc, 'made-offline'));
    const gone = destroyed(p.doc);
    act(() => p.emit('connection-close', { code: 1008, reason: 'unauthorized' }));
    expect(result.current.loadError).not.toBeNull();
    unmount();
    expect(gone()).toBe(false);
    const [copy] = useRefusedCopies.getState().copies;
    expect(copy?.why).toBe('signed_out');
    expect(copy?.doc.getArray('layers').toArray()).toEqual(['synced', 'made-offline']);
    expect(unloadAsks()).toBe(true);
  });

  it('signed out with nothing unsent keeps no copy', () => {
    const { unmount } = renderHook(() => useLayoutDoc('F'));
    const p = providers.at(-1)!;
    act(() => p.emit('sync', true));
    act(() => addLayer(p.doc, 'synced'));
    act(() => p.emit('connection-close', { code: 1008, reason: 'unauthorized' }));
    unmount();
    expect(useRefusedCopies.getState().copies).toEqual([]);
  });

  it('a left layout deleted before its offline edits got there keeps them', () => {
    const { rerender, unmount } = renderHook(({ id }) => useLayoutDoc(id), { initialProps: { id: 'A' } });
    const a = providers.at(-1)!;
    act(() => a.emit('sync', true));
    a.wsconnected = false;
    act(() => a.emit('sync', false));
    act(() => addLayer(a.doc, 'offline-edit'));
    rerender({ id: 'B' });
    act(() => a.emit('connection-close', { code: 4404, reason: 'not_found' }));
    expect(layoutsStillSending()).toEqual([]);
    const [copy] = useRefusedCopies.getState().copies;
    expect(copy?.why).toBe('gone');
    expect(copy?.doc.getArray('layers').toArray()).toEqual(['offline-edit']);
    unmount();
  });

  it('says plainly when the server cannot read a change, and keeps the copy', () => {
    const { result, unmount } = renderHook(() => useLayoutDoc('E'));
    const p = providers.at(-1)!;
    act(() => p.emit('sync', true));
    act(() => addLayer(p.doc, 'unreadable-edit'));
    const gone = destroyed(p.doc);
    act(() => p.emit('connection-close', { code: 1008, reason: 'unreadable_update' }));
    expect(result.current.loadError?.message).toBe(UPDATE_REFUSED);
    expect(p.disconnected).toBe(true);
    unmount();
    expect(gone()).toBe(false);
    const copy = useRefusedCopies.getState().copies.find((c) => c.layoutId === 'E');
    expect(copy?.why).toBe('unreadable');
    expect(copy?.doc.getArray('layers').toArray()).toEqual(['unreadable-edit']);
    dropRefusedCopy(copy!.key);
  });

  it('a refusal before the layout arrived has nothing to keep', () => {
    const { unmount } = renderHook(() => useLayoutDoc('D'));
    const p = providers.at(-1)!;
    act(() => p.emit('connection-close', { code: 1008, reason: 'layout_merge_refused' }));
    unmount();
    expect(useRefusedCopies.getState().copies).toEqual([]);
    expect(unloadAsks()).toBe(false);
  });
});
