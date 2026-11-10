// What a client sends before its handler is ready (the route checks access
// and loads the layout first) is kept in order and handed over, never lost.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from '@fastify/websocket';
import { earlyMessages } from './handler.js';

function fakeSocket() {
  const ws = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  ws.close = vi.fn();
  return ws;
}

describe('earlyMessages', () => {
  it('keeps what arrives first, in order, and stops listening once taken', () => {
    const ws = fakeSocket();
    const early = earlyMessages(ws as unknown as WebSocket);
    ws.emit('message', Buffer.from([1]));
    ws.emit('message', Buffer.from([2]));
    expect(early.take().map((b) => b[0])).toEqual([1, 2]);
    ws.emit('message', Buffer.from([3]));
    expect(early.take()).toEqual([]);
    expect(ws.listenerCount('message')).toBe(0);
  });

  it('a flood before the handler is ready is told to slow down', () => {
    const ws = fakeSocket();
    earlyMessages(ws as unknown as WebSocket);
    for (let i = 0; i < 300; i++) ws.emit('message', Buffer.from([i & 255]));
    expect(ws.close).toHaveBeenCalledWith(1013, 'slow_down');
  });
});
