// A layout doc newer than this page reads is refused, not synced.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { DOC_SCHEMA_VERSION } from '@cld/ydoc';

type Handler = (arg: unknown) => void;
const providers: FakeProvider[] = [];

class FakeProvider {
  handlers = new Map<string, Handler[]>();
  awareness: Awareness;
  // (sendOnlyOwnPresence swaps it for its own.)
  _awarenessUpdateHandler = (): void => undefined;
  disconnected = false;
  constructor(
    _url: string,
    _room: string,
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
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
  destroy() {}
}

vi.mock('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

const { UNREADABLE_LAYOUT, useLayoutDoc } = await import('../useLayoutDoc');

describe('useLayoutDoc and the layout schema', () => {
  afterEach(() => {
    providers.length = 0;
  });

  it('opens a layout at the schema this page reads', () => {
    expect(DOC_SCHEMA_VERSION).toBe(3);
    const { result } = renderHook(() => useLayoutDoc('a'));
    const p = providers.at(-1)!;
    act(() => {
      p.doc.getMap('meta').set('schemaVersion', 1);
      p.emit('sync', true);
    });
    expect(result.current.loadError).toBeNull();
    expect(result.current.doc).toBe(p.doc);
    expect(p.disconnected).toBe(false);
  });

  it('refuses a layout from a newer version and stops syncing', () => {
    const { result } = renderHook(() => useLayoutDoc('b'));
    const p = providers.at(-1)!;
    act(() => {
      p.doc.getMap('meta').set('schemaVersion', DOC_SCHEMA_VERSION + 1);
      p.emit('sync', true);
    });
    expect(result.current.loadError?.message).toBe(UNREADABLE_LAYOUT);
    expect(result.current.doc).toBeNull();
    expect(p.disconnected).toBe(true);
  });

  it('stops when someone with a newer version changes it mid-edit', () => {
    const { result } = renderHook(() => useLayoutDoc('c'));
    const p = providers.at(-1)!;
    act(() => p.emit('sync', true));
    expect(result.current.doc).toBe(p.doc);
    act(() => p.doc.getMap('meta').set('schemaVersion', 99));
    expect(result.current.loadError?.message).toBe(UNREADABLE_LAYOUT);
    expect(p.disconnected).toBe(true);
  });
});
