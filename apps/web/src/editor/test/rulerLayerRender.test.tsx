// A move of a part no ruler is attached to renders no ruler again, and
// works out no part's centre: on 7,520 parts the rulers worked out every
// part's centre after each change (anyone's move), about 20 ms at 4x slowed
// CPU, and every ruler was rendered again with the new list.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';

let prims = 0;
vi.mock('react-konva', () => {
  const mk = () => (p: { children?: ReactNode }) => {
    prims++;
    return h(Fragment, null, p.children);
  };
  return { Group: mk(), Image: mk(), Rect: mk(), Circle: mk(), Line: mk(), Text: mk(), Shape: mk(), Arrow: mk(), Arc: mk(), Ring: mk(), Path: mk() };
});

// Each part's centre is worked out with pivotOf: its calls count them.
let centres = 0;
vi.mock('../brickGeometry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../brickGeometry')>();
  return {
    ...real,
    pivotOf: (...a: Parameters<typeof real.pivotOf>) => {
      centres++;
      return real.pivotOf(...a);
    },
  };
});

import { addLinearRuler, attachRulerEndpoint, ensureRulerLayer, moveBrick, placeBrick } from '../mutations';
import { RulerLayers } from '../render/RulerLayer';
import { projectDoc } from '../useDocMap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RulerLayers re-render scope', () => {
  it('a part no ruler is attached to moved: no ruler rendered, no centre worked out', async () => {
    const N = 500;
    const doc = createDefaultLayoutDoc();
    const brickLayer = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < N; i++) ids.push(placeBrick(doc, brickLayer, { partNumber: 'track.0', x: i * 16, y: 0, width: 16, height: 8 }));
    });
    const rulerLayer = ensureRulerLayer(doc);
    const ruler = addLinearRuler(doc, rulerLayer, { x: 0, y: 40 }, { x: 80, y: 40 });
    addLinearRuler(doc, rulerLayer, { x: 0, y: 80 }, { x: 80, y: 80 });
    attachRulerEndpoint(doc, rulerLayer, ruler, 0, ids[3]!);

    const root = createRoot(document.createElement('div'));
    const render = () => h(RulerLayers, { map: projectDoc(doc)! });
    centres = 0;
    await act(async () => root.render(render()));
    expect(centres).toBe(1);

    // Another part moved: the same centres, no ruler rendered again.
    moveBrick(doc, brickLayer, ids[100]!, 3, 3);
    centres = 0;
    prims = 0;
    await act(async () => root.render(render()));
    expect(centres).toBe(1);
    expect(prims).toBeLessThanOrEqual(3);

    // The attached part moved: its ruler follows.
    moveBrick(doc, brickLayer, ids[3]!, 5, 5);
    prims = 0;
    await act(async () => root.render(render()));
    expect(prims).toBeGreaterThan(3);
    await act(async () => root.unmount());
  });
});
