// The grid guard (gridGuard.ts) reads every kind of content a list entry
// can hold. A ruler written as plain JSON (rulerView) can arrive as values,
// as an embed or as JSON content: each is checked like the others, so a
// ruler outside its range can't land by being written another way. (The
// update guard refuses JSON content before the grid guard sees it.)

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import { checkGridSizes, checkGridSizesOnCopy, drawingProblems } from './gridGuard.js';
import { checkUpdate } from './updateGuard.js';

function room(): { doc: Y.Doc; rulers: Y.Array<unknown> } {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const sheet = new Y.Map<unknown>();
  const rulers = new Y.Array<unknown>();
  doc.transact(() => {
    doc.getMap('layerData').set('sheet', sheet);
    sheet.set('type', 'ruler');
    sheet.set('rulerItems', rulers);
    rulers.push([{ id: 'r1', unit: 2, lineThickness: 1 }]);
  });
  return { doc, rulers };
}

/** One list entry put first in `rulers`, holding `json` as content kind `ref` (5 embed, 2 JSON). */
function entryUpdate(rulers: Y.Array<unknown>, ref: 2 | 5, json: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1); // one client
  encoding.writeVarUint(e, 1); // one struct
  encoding.writeVarUint(e, 4242); // client
  encoding.writeVarUint(e, 0); // clock
  encoding.writeUint8(e, ref); // no origins, no key: its parent follows
  encoding.writeVarUint(e, 0); // parent by id
  encoding.writeVarUint(e, rulers._item!.id.client);
  encoding.writeVarUint(e, rulers._item!.id.clock);
  if (ref === 5) encoding.writeVarString(e, json);
  else {
    encoding.writeVarUint(e, 1);
    encoding.writeVarString(e, json);
    // yrs reads one more string than the count (updateGuard.ts); Yjs reads it as an empty delete set.
    encoding.writeVarString(e, '');
  }
  encoding.writeVarUint(e, 0); // no deletes
  return encoding.toUint8Array(e);
}

describe('a ruler written as another kind of content', () => {
  const bad = JSON.stringify({ id: 'evil', unit: 1_000_000, measureFont: { size: 1e12 } });

  it.each([
    ['an embed', 5],
    ['JSON content', 2],
  ] as const)('is refused when it arrives as %s', (_what, ref) => {
    const { doc, rulers } = room();
    const update = entryUpdate(rulers, ref, bad);
    // The update guard takes an embed; JSON content it refuses first, as
    // Yjs and yrs read it differently (updateGuard.ts). The grid guard
    // refuses either on its own too.
    if (ref === 5) expect(checkUpdate(update)).toBeNull();
    else expect(checkUpdate(update)).toContain('JSON');
    // Applied, the sheet would hold a ruler outside its range...
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(copy, update);
    expect([...drawingProblems(copy)].some((p) => p.startsWith('sheet.rulers.evil.'))).toBe(true);
    expect(checkGridSizesOnCopy(doc, update)).toMatch(/outside/);
    // ...so the live check refuses it, as the copy does.
    expect(checkGridSizes(doc, update)).toMatch(/outside/);
  });

  it('is taken when it is within range', () => {
    const { doc, rulers } = room();
    expect(checkGridSizes(doc, entryUpdate(rulers, 5, JSON.stringify({ id: 'ok', unit: 3 })))).toBeNull();
  });
});
