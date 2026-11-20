// Switches in the editor (trains design 6.3): their arrows, the switch a
// Run mode click means, the right-click choices, and flips as undo steps
// (in Run mode too: Aaron, 2026-11-19) that copies of parts keep.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TrackNetwork, type TrackBrickInput, type TrackConn } from '@cld/parts-catalog/browser';
import { readSwitchStatesFromDoc } from '@cld/ydoc';
import { legLabel, switchArrows, switchAt, switchMenuItems } from '../trackSwitches';
import { copySwitchStates, ensureBrickLayer, placeBrick, setSwitch } from '../mutations';
import { createUndoManager } from '../useUndoManager';

// The 9V left point and a straight, as in fixtures/contracts/track-network.json.
const POINT: TrackConn[] = [
  { type: '1', x: -16.9375, y: 6.375, angle: 180, plug: 1 },
  { type: '1', x: 15.0625, y: 6.375, angle: 0, plug: -1 },
  { type: '1', x: 15.7552, y: -6.58018, angle: -22.5, plug: -1 },
];
const CROSSOVER: TrackConn[] = [
  { type: '1', x: -24, y: -8, angle: 180, plug: 1 },
  { type: '1', x: -24, y: 8, angle: 180, plug: 1 },
  { type: '1', x: 24, y: -8, angle: 0, plug: -1 },
  { type: '1', x: 24, y: 8, angle: 0, plug: -1 },
];

function brick(id: string, conns: TrackConn[], at: { x: number; y: number }): TrackBrickInput {
  return {
    id,
    partKey: id === 'X' ? '7996.8' : '2861.8',
    conns,
    points: conns.flatMap((c) => [at.x + c.x, at.y + c.y]),
    orientation: 0,
    connexions: conns.map((_, i) => ({ id: `${id}${i}`, linkedTo: '' })),
  };
}

const net = new TrackNetwork([brick('P', POINT, { x: 0, y: 0 }), brick('X', CROSSOVER, { x: 0, y: 100 })]);

describe('switch arrows', () => {
  it('point along the set leg, the others faint, and say when a switch is set the other way', () => {
    const plain = switchArrows(net, {});
    expect(plain.map((a) => a.key)).toEqual(['P/0', 'X/0', 'X/1', 'X/2', 'X/3']);
    const p = plain.find((a) => a.key === 'P/0')!;
    expect(p.turned).toBe(false);
    expect(p.others).toHaveLength(1);
    // Starts at the heel, goes along the straight leg (y stays 6.375).
    expect(p.set[0]).toBeCloseTo(-16.9375);
    expect(p.set[p.set.length - 1]).toBeCloseTo(6.375);
    const turned = switchArrows(net, { 'P/0': 2 }).find((a) => a.key === 'P/0')!;
    expect(turned.turned).toBe(true);
    expect(turned.tip.dy).toBeLessThan(0); // up the left leg
  });
});

describe('a click in Run mode', () => {
  it('means the switch whose heel or set leg is nearest, within reach', () => {
    expect(switchAt(net, {}, { x: -16, y: 6 }, 4)?.key).toBe('P/0');
    expect(switchAt(net, {}, { x: -23, y: 108 }, 4)?.key).toBe('X/1');
    expect(switchAt(net, {}, { x: 23, y: 92 }, 4)?.key).toBe('X/2');
    expect(switchAt(net, {}, { x: 300, y: 300 }, 4)).toBeNull();
  });
});

describe('the right-click menu', () => {
  it('lists the ways a switch can be set, the usual one first, ticked where it is set', () => {
    expect(switchMenuItems(net, {}, 'P')).toEqual([
      { key: 'P/0', exit: 1, label: 'Straight', checked: true },
      { key: 'P/0', exit: 2, label: 'Turn left', checked: false },
    ]);
    expect(switchMenuItems(net, { 'P/0': 2 }, 'P').map((i) => i.checked)).toEqual([false, true]);
    // A part with a switch at each end names the end.
    expect(switchMenuItems(net, {}, 'X').map((i) => i.label)).toEqual([
      'From end 1: Straight', 'From end 1: Turn right',
      'From end 2: Straight', 'From end 2: Turn left',
      'From end 3: Straight', 'From end 3: Turn left',
      'From end 4: Straight', 'From end 4: Turn right',
    ]);
    expect(switchMenuItems(net, {}, 'nothing')).toEqual([]);
    expect(switchMenuItems(null, {}, 'P')).toEqual([]);
  });

  it('names legs in plain words', () => {
    expect(legLabel('straight')).toBe('Straight');
    expect(legLabel('left')).toBe('Turn left');
    expect(legLabel('right 2')).toBe('Turn right (2)');
  });
});

describe('flipping a switch', () => {
  function docWithPart(): { doc: Y.Doc; id: string } {
    const doc = new Y.Doc();
    const layer = ensureBrickLayer(doc);
    const id = placeBrick(doc, layer, { partNumber: '2861.8', x: 0, y: 0, width: 35, height: 21 });
    return { doc, id };
  }

  it('is one undo step, and back to the default clears the key', () => {
    const { doc, id } = docWithPart();
    const undo = createUndoManager(doc);
    setSwitch(doc, `${id}/0`, 2);
    expect(readSwitchStatesFromDoc(doc)).toEqual({ [`${id}/0`]: 2 });
    undo.stopCapturing();
    setSwitch(doc, `${id}/0`, null);
    expect(readSwitchStatesFromDoc(doc)).toEqual({});
    undo.undo();
    expect(readSwitchStatesFromDoc(doc)).toEqual({ [`${id}/0`]: 2 });
    undo.undo();
    expect(readSwitchStatesFromDoc(doc)).toEqual({});
    undo.redo();
    expect(readSwitchStatesFromDoc(doc)).toEqual({ [`${id}/0`]: 2 });
  });

  it('drops the keys of parts no longer on the map as it writes', () => {
    const { doc, id } = docWithPart();
    doc.getMap('meta').set('switchStates', new Y.Map());
    (doc.getMap('meta').get('switchStates') as Y.Map<number>).set('gone/0', 1);
    setSwitch(doc, `${id}/0`, 2);
    expect(readSwitchStatesFromDoc(doc)).toEqual({ [`${id}/0`]: 2 });
  });

  it('copies of parts keep their originals’ settings', () => {
    const { doc, id } = docWithPart();
    setSwitch(doc, `${id}/0`, 2);
    doc.transact(() => copySwitchStates(doc, [id, 'other'], ['copy', 'copy2']));
    expect(readSwitchStatesFromDoc(doc)).toEqual({ [`${id}/0`]: 2, 'copy/0': 2 });
  });
});
