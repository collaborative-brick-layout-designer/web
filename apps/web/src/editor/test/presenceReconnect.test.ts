// After a dropped connection the people list came back empty on both sides
// for up to 15 s (until y-protocols re-sent each presence). These follow
// the messages y-websocket and the server exchange around a reconnect.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';
import { keepPresenceAcrossReconnects } from '../useLayoutDoc';

function fakeProvider(awareness: Awareness) {
  const handlers = new Set<(e: { status: string }) => void>();
  const provider = {
    awareness,
    on: (_: string, f: (e: { status: string }) => void) => handlers.add(f),
    off: (_: string, f: (e: { status: string }) => void) => handlers.delete(f),
  } as unknown as WebsocketProvider;
  return { provider, status: (status: string) => handlers.forEach((f) => f({ status })) };
}
/** What y-websocket does when the connection closes: everyone else is forgotten. */
const closeConnection = (a: Awareness) =>
  removeAwarenessStates(a, [...a.getStates().keys()].filter((id) => id !== a.clientID), 'closed');

describe('who is here, after a dropped connection', () => {
  for (const kept of [true, false]) {
    it(`the others show again as soon as the server lists them${kept ? '' : ' (not without the fix)'}`, () => {
      const mine = new Awareness(new Y.Doc());
      const server = new Awareness(new Y.Doc());
      server.setLocalState(null);
      const alice = new Awareness(new Y.Doc());
      alice.setLocalState({ user: { id: 'a', displayName: 'Alice' } });
      applyAwarenessUpdate(server, encodeAwarenessUpdate(alice, [alice.clientID]), 'alice');
      const everyone = () => encodeAwarenessUpdate(server, [...server.getStates().keys()]);
      const { provider, status } = fakeProvider(mine);
      if (kept) keepPresenceAcrossReconnects(provider);

      applyAwarenessUpdate(mine, everyone(), 'server');
      expect(mine.getStates().has(alice.clientID)).toBe(true);

      closeConnection(mine);
      status('disconnected');
      expect(mine.getStates().has(alice.clientID)).toBe(false);

      // Back: the server sends who is here. Alice hasn't moved, so her presence is the same one.
      status('connecting');
      status('connected');
      applyAwarenessUpdate(mine, everyone(), 'server');
      expect(mine.getStates().has(alice.clientID)).toBe(kept);
      for (const a of [mine, server, alice]) a.destroy();
    });

    it(`this tab shows again for the others as soon as it is back${kept ? '' : ' (not without the fix)'}`, () => {
      const mine = new Awareness(new Y.Doc());
      mine.setLocalState({ user: { id: 'b', displayName: 'Bob' } });
      const alice = new Awareness(new Y.Doc());
      const { provider, status } = fakeProvider(mine);
      if (kept) keepPresenceAcrossReconnects(provider);
      const send = () => applyAwarenessUpdate(alice, encodeAwarenessUpdate(mine, [mine.clientID]), 'server');

      send();
      expect(alice.getStates().has(mine.clientID)).toBe(true);
      // The connection drops: the server tells Alice this tab left.
      status('disconnected');
      removeAwarenessStates(alice, [mine.clientID], 'server');
      expect(alice.getStates().has(mine.clientID)).toBe(false);

      // Back: y-websocket sends this tab's presence as it connects.
      status('connected');
      send();
      expect(alice.getStates().has(mine.clientID)).toBe(kept);
      for (const a of [mine, alice]) a.destroy();
    });
  }

  it('a tab still opening the layout (no presence yet) sends nothing on reconnecting', () => {
    const mine = new Awareness(new Y.Doc());
    mine.setLocalState(null);
    const { provider, status } = fakeProvider(mine);
    const stop = keepPresenceAcrossReconnects(provider);
    let sent = 0;
    mine.on('update', () => sent++);
    status('connected');
    expect(sent).toBe(0);
    expect(mine.getLocalState()).toBeNull();
    stop();
    mine.destroy();
  });
});
