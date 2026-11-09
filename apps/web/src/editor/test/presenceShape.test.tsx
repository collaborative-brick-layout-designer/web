// A tab still opening a layout shares an empty presence ({}), which the
// server used to pass on as { user: { id } }: every other web editor in the
// room then crashed drawing it (full review area 4, Bug 1). And each tab
// sent everyone's presence back to the server, so a crowded layout closed
// idle people for sending too fast (Bug 2).

import { act, fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPeerPresence } from '../awareness';
import { PresencePanel } from '../PresencePanel';
import { newLivePresence, sendOnlyOwnPresence, type LayoutDocState } from '../useLayoutDoc';
import { EditorErrorBoundary } from '../EditorErrorBoundary';

const person = (displayName: string, extra: Record<string, unknown> = {}) => ({
  user: { id: `id-${displayName}`, displayName, avatarUrl: null, color: '#60a5fa' },
  cursor: null,
  selection: { brickIds: [] },
  tool: 'select',
  editingModule: null,
  lastActivityMs: Date.now(),
  ...extra,
});

/** A peer's presence arriving the way the provider applies it. */
function arrive(into: Awareness, state: unknown, clientID: number): void {
  const doc = new Y.Doc();
  // (Awareness takes its clientID from the doc.)
  doc.clientID = clientID;
  const peer = new Awareness(doc);
  peer.setLocalState(state as Record<string, unknown> | null);
  applyAwarenessUpdate(into, encodeAwarenessUpdate(peer, [clientID]), 'remote');
  peer.destroy();
}

afterEach(() => vi.useRealTimers());

describe('presence from others', () => {
  it("isn't drawn unless it's a person's: a name, a selection and a last-activity time", () => {
    expect(readPeerPresence({})).toBeNull();
    expect(readPeerPresence({ user: { id: 'x' } })).toBeNull();
    expect(readPeerPresence({ user: { displayName: 'A' }, lastActivityMs: 1 })).toBeNull();
    expect(readPeerPresence({ user: { displayName: 'A' }, selection: { brickIds: [] } })).toBeNull();
    expect(readPeerPresence({ user: { displayName: 'A' }, selection: {}, lastActivityMs: 1 })).toBeNull();
    expect(readPeerPresence(null)).toBeNull();
    expect(readPeerPresence('x')).toBeNull();
    // A person's, with odd fields made safe to draw.
    const read = readPeerPresence({
      user: { displayName: 'A', color: 'red;}' },
      selection: { brickIds: ['1', 2, null] },
      cursor: { x: 'a', y: 1 },
      lastActivityMs: 5,
    });
    expect(read).toMatchObject({ user: { displayName: 'A', color: '#888888' }, selection: { brickIds: ['1'] }, cursor: null, tool: 'select' });
  });

  it("an empty or broken presence beside a person's doesn't break the people list", () => {
    const mine = new Awareness(new Y.Doc());
    arrive(mine, {}, 101);
    arrive(mine, { user: { id: 'still-opening' } }, 102);
    arrive(mine, person('Bob Builder'), 103);
    render(<PresencePanel awareness={mine} />);
    const group = screen.getByRole('group', { name: 'People here now' });
    expect(group.textContent).toContain('Bob Builder');
    expect(group.querySelectorAll(':scope > span')).toHaveLength(1);
    mine.destroy();
  });
});

describe('the presence this tab shares', () => {
  it('stays empty until the layout opens, and nothing is re-sent meanwhile', () => {
    vi.useFakeTimers();
    const awareness = newLivePresence(new Y.Doc());
    expect(awareness.getLocalState()).toBeNull();
    const updates = vi.fn();
    awareness.on('update', updates);
    // y-protocols renews a set presence every 15 s.
    vi.advanceTimersByTime(40_000);
    expect(updates).not.toHaveBeenCalled();
    awareness.destroy();
  });

  it("only this tab's own presence goes to the server, not everyone else's", () => {
    const awareness = new Awareness(new Y.Doc());
    const send = vi.fn();
    const provider = { awareness, _awarenessUpdateHandler: send } as unknown as WebsocketProvider;
    awareness.on('update', send);
    sendOnlyOwnPresence(provider);
    send.mockClear();
    // Someone else moves: nothing is sent.
    arrive(awareness, person('Alice'), 201);
    arrive(awareness, person('Alice', { cursor: { x: 1, y: 2, layerId: null } }), 201);
    expect(send).not.toHaveBeenCalled();
    // This tab's own change: sent, alone.
    awareness.setLocalState(person('Me'));
    expect(send).toHaveBeenCalledTimes(1);
    const changes = send.mock.calls[0]![0] as { added: number[]; updated: number[]; removed: number[] };
    expect([...changes.added, ...changes.updated, ...changes.removed]).toEqual([awareness.clientID]);
    // And the provider's destroy() takes this handler off.
    expect(provider._awarenessUpdateHandler).not.toBe(send);
    awareness.destroy();
  });
});

describe('when drawing the editor throws', () => {
  function Boom({ when }: { when: { throwIt: boolean } }) {
    if (when.throwIt) throw new Error('kaboom');
    return <p>the editor</p>;
  }

  it('a card says so and keeps the layout open behind it; Try again draws it again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const when = { throwIt: true };
    const docState = { doc: new Y.Doc(), awareness: null, status: { kind: 'offline', lastSyncedAt: null }, saveNow: async () => 'offline', loadError: null, loading: false } as unknown as LayoutDocState;
    render(
      <EditorErrorBoundary what="layout" layoutId="L1" docState={docState}>
        <Boom when={when} />
      </EditorErrorBoundary>,
    );
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('Something went wrong showing this layout');
    expect(card.textContent).toContain('Nothing is lost');
    // Not on the server yet: a copy can be downloaded first.
    expect(screen.getByRole('button', { name: 'Download a copy (.bld-layout)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    when.throwIt = false;
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(screen.getByText('the editor')).toBeTruthy();
  });
});
