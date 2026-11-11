// The people circles are a button that lists everyone by name (a finger
// has no hover to read initials with), a phone's header shows at most two
// circles' worth, and "View only" says why on a tap.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { PresencePanel } from '../PresencePanel';
import { ViewOnlyPill } from '../ViewOnlyPill';

afterEach(cleanup);

function withPeople(names: string[]): Awareness {
  const mine = new Awareness(new Y.Doc());
  mine.setLocalState(null);
  names.forEach((name, i) => {
    const other = new Awareness(new Y.Doc());
    other.setLocalState({
      user: { id: `u${i}`, displayName: name, color: '#3b82f6' },
      cursor: null,
      selection: { brickIds: [] },
      tool: 'select',
      editingModule: null,
      lastActivityMs: Date.now(),
    });
    applyAwarenessUpdate(mine, encodeAwarenessUpdate(other, [other.clientID]), 'server');
    other.destroy();
  });
  return mine;
}
const circles = () => screen.getByRole('group', { name: 'People here now' }).querySelectorAll(':scope > span');

describe('People here now, as a button', () => {
  it('lists everyone by name on a tap, and closes on Esc', () => {
    const mine = withPeople(['Alice Builder', 'Bob Editor', 'Carol Viewer']);
    render(<PresencePanel awareness={mine} />);
    expect(circles()).toHaveLength(3);
    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    const button = screen.getByTestId('people-here');
    fireEvent.click(button);
    const list = screen.getByRole('dialog', { name: 'Who is here' });
    expect(list.textContent).toContain('3 other people are here');
    for (const name of ['Alice Builder', 'Bob Editor', 'Carol Viewer']) expect(list.textContent).toContain(name);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
    mine.destroy();
  });

  it("a phone's header shows one circle, with +N for the rest", () => {
    const one = withPeople(['Alice Builder']);
    const { unmount } = render(<PresencePanel awareness={one} compact />);
    expect(circles()).toHaveLength(1);
    expect(screen.queryByTestId('people-more')).toBeNull();
    // No separate "?": the list says what the circles mean.
    expect(screen.queryByRole('button', { name: /Help/ })).toBeNull();
    unmount();
    one.destroy();

    const five = withPeople(['Alice Builder', 'Bob Editor', 'Carol Viewer', 'Dan Driver', 'Eve Engineer']);
    render(<PresencePanel awareness={five} compact />);
    expect(circles()).toHaveLength(1);
    expect(screen.getByTestId('people-more').textContent).toContain('+4');
    fireEvent.click(screen.getByTestId('people-here'));
    const list = screen.getByRole('dialog', { name: 'Who is here' });
    expect(list.textContent).toContain('5 other people are here');
    expect(list.textContent).toContain('Eve Engineer');
    five.destroy();
  });

  it('one other person reads "1 other person is here"', () => {
    const mine = withPeople(['Alice Builder']);
    render(<PresencePanel awareness={mine} compact />);
    fireEvent.click(screen.getByTestId('people-here'));
    expect(screen.getByRole('dialog', { name: 'Who is here' }).textContent).toContain('1 other person is here');
    mine.destroy();
  });
});

describe('"View only"', () => {
  it('is plain words when there is nothing more to say', () => {
    render(<ViewOnlyPill />);
    expect(screen.getByTestId('view-only').tagName).toBe('SPAN');
  });

  it('says why on a tap when the club is the reason', () => {
    const reason = 'Ask a club admin for the Edit layouts permission.';
    render(<ViewOnlyPill reason={reason} />);
    const pill = screen.getByTestId('view-only');
    expect(pill.tagName).toBe('BUTTON');
    fireEvent.click(pill);
    expect(screen.getByRole('dialog', { name: 'Why this is view only' }).textContent).toContain(reason);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Why this is view only' })).toBeNull();
  });
});
