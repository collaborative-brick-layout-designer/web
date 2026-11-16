// The hub's squash window: a repeat inside it is held, not lost, so the
// stream's last word is about the latest change (a role lowered and raised
// again within half a second left the person's tab on view only).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQUASH_MS, addConnection, closeAll, deliver, removeConnection, type EventConnection, type Hint } from './hub.js';

function fakeConn(userId: string): EventConnection & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    userId,
    openedAt: Date.now(),
    recent: new Map(),
    chunks,
    write: (c) => {
      chunks.push(c);
      return true;
    },
    close: () => {},
  };
}

const hint: Hint = { kind: 'layout', id: 'L1', action: 'update:collaborators' };

describe('hub squash window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    closeAll();
    vi.useRealTimers();
  });

  it('sends a repeat inside the window once more when the window ends', () => {
    const conn = fakeConn('u1');
    addConnection(conn);
    deliver(hint, ['u1']);
    vi.advanceTimersByTime(SQUASH_MS - 100);
    deliver(hint, ['u1']);
    deliver(hint, ['u1']);
    expect(conn.chunks).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(conn.chunks).toHaveLength(2);
    expect(conn.chunks[1]).toBe(conn.chunks[0]);
    // Nothing more after that.
    vi.advanceTimersByTime(SQUASH_MS * 4);
    expect(conn.chunks).toHaveLength(2);
  });

  it('a hint sent once stays one hint', () => {
    const conn = fakeConn('u1');
    addConnection(conn);
    deliver(hint, ['u1']);
    vi.advanceTimersByTime(SQUASH_MS * 4);
    expect(conn.chunks).toHaveLength(1);
  });

  it('a repeat after the window goes at once', () => {
    const conn = fakeConn('u1');
    addConnection(conn);
    deliver(hint, ['u1']);
    vi.advanceTimersByTime(SQUASH_MS);
    deliver(hint, ['u1']);
    expect(conn.chunks).toHaveLength(2);
  });

  it('a stream closed inside the window gets nothing more', () => {
    const conn = fakeConn('u1');
    addConnection(conn);
    deliver(hint, ['u1']);
    deliver(hint, ['u1']);
    removeConnection(conn);
    vi.advanceTimersByTime(SQUASH_MS);
    expect(conn.chunks).toHaveLength(1);
  });
});
