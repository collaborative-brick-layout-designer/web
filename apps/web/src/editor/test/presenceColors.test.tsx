// Presence colors and who's listed (full review area 4, Bugs 9 and 10):
// both apps give the people here the same colors, two people share one only
// when more than eight are here, and you aren't listed as someone else.

import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import { PRESENCE_MIN_CONTRAST, PRESENCE_PALETTE, PRESENCE_TEXT, contrastRatio, firstChoice, presenceColors, presenceTextColor } from '../presenceColors';
import { PresencePanel } from '../PresencePanel';
import { newLivePresence } from '../useLayoutDoc';
import contractText from '../../../../../fixtures/contracts/presence-colors.json?raw';

const CONTRACT = JSON.parse(contractText) as {
  palette: string[];
  textColors: { dark: string; light: string };
  minContrast: number;
  textOn: Record<string, string>;
  firstChoices: { userId: string; layoutId: string; color: string }[];
  groups: { layoutId: string; userIds: string[]; colors: Record<string, string> }[];
};

const person = (id: string, displayName: string, lastActivityMs = Date.now()) => ({
  user: { id, displayName, avatarUrl: null, color: '#000000' },
  cursor: null,
  selection: { brickIds: [] },
  tool: 'select',
  editingModule: null,
  lastActivityMs,
});

function arrive(into: Awareness, state: unknown, clientID: number): void {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const peer = new Awareness(doc);
  peer.setLocalState(state as Record<string, unknown>);
  applyAwarenessUpdate(into, encodeAwarenessUpdate(peer, [clientID]), 'remote');
  peer.destroy();
}

describe('presence colors', () => {
  it('are the desktop’s (fixtures/contracts/presence-colors.json)', () => {
    expect([...PRESENCE_PALETTE]).toEqual(CONTRACT.palette);
    for (const f of CONTRACT.firstChoices) expect(PRESENCE_PALETTE[firstChoice(f.userId, f.layoutId)]).toBe(f.color);
    for (const g of CONTRACT.groups) expect(Object.fromEntries(presenceColors(g.userIds, g.layoutId))).toEqual(g.colors);
  });

  // A name on its presence color reads: dark ink on a light color, white on
  // a dark one, the same in both apps, and at least WCAG AA (4.5:1). White
  // on the yellow used to be 1.5:1.
  it('draw names in a color that contrasts with every palette color (the contract\'s textOn)', () => {
    expect(PRESENCE_TEXT).toEqual(CONTRACT.textColors);
    expect(PRESENCE_MIN_CONTRAST).toBe(CONTRACT.minContrast);
    for (const color of PRESENCE_PALETTE) {
      const text = presenceTextColor(color);
      expect(text).toBe(CONTRACT.textOn[color]);
      expect(contrastRatio(color, text)).toBeGreaterThanOrEqual(PRESENCE_MIN_CONTRAST);
    }
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(presenceTextColor('#1e3a8a')).toBe(PRESENCE_TEXT.light);
  });

  it('never give two of up to eight people the same color', () => {
    for (let l = 0; l < 50; l++) {
      const ids = Array.from({ length: 8 }, (_, i) => `member-${l}-${i}`);
      expect(new Set(presenceColors(ids, `L${l}`).values()).size).toBe(8);
    }
  });

  it("don't give the same two people the same first choice on most layouts", () => {
    let often = 0;
    for (let p = 0; p < 2000; p++) {
      let same = 0;
      for (let l = 0; l < 20; l++) if (firstChoice(`a${p}`, `L${l}`) === firstChoice(`b${p}`, `L${l}`)) same++;
      if (same > 10) often++;
    }
    // The old hash: 8% of pairs on more than half of all layouts.
    expect(often).toBeLessThan(10);
  });
});

describe('People here now', () => {
  it('lists each other person once, never you, each in their own color', () => {
    const mine = newLivePresence(new Y.Doc(), 'L1');
    mine.setLocalState(person('u-alice', 'Alice Builder'));
    // Alice in another tab, and Bob in two (his older tab idle).
    arrive(mine, person('u-alice', 'Alice Builder'), 301);
    arrive(mine, person('u-bob', 'Bob Builder', Date.now() - 60_000), 302);
    arrive(mine, person('u-bob', 'Bob Builder'), 303);
    render(<PresencePanel awareness={mine} />);
    const avatars = screen.getByRole('group', { name: 'People here now' }).querySelectorAll(':scope > span');
    expect([...avatars].map((a) => a.getAttribute('title'))).toEqual(['Bob Builder']);
    // u-alice and u-bob have the same first choice on L1: Bob gets the next one along.
    expect(firstChoice('u-alice', 'L1')).toBe(firstChoice('u-bob', 'L1'));
    const bob = presenceColors(['u-alice', 'u-bob'], 'L1').get('u-bob')!;
    expect(bob).not.toBe(PRESENCE_PALETTE[firstChoice('u-alice', 'L1')]);
    expect((avatars[0] as HTMLElement).style.backgroundColor).toBe(hexToRgb(bob));
    // Initials in the color that reads on it (dark ink on these light colors), not white.
    expect((avatars[0] as HTMLElement).style.color).toBe(hexToRgb(presenceTextColor(bob)));
    mine.destroy();
  });
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
