// Regression: the brick layer must only re-render what changed. With
// thousands of bricks, every canvas re-render (pan, marquee, HUD), every
// selection change and every one-brick edit used to re-render every
// glyph (2000+ Konva primitives for 1000 bricks). Picking parts (Select
// all on a thousand) re-renders none: the selection overlay draws them.

import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BbmMap } from '@cld/model';
import { createDefaultLayoutDoc, docToBbm, readSidecarFromDoc, writeSidecarCache } from '@cld/ydoc';

let prims = 0;
vi.mock('react-konva', () => {
  const mk = () => (p: { children?: ReactNode }) => {
    prims++;
    return h(Fragment, null, p.children);
  };
  return { Group: mk(), Image: mk(), Rect: mk(), Circle: mk(), Line: mk(), Text: mk(), Shape: mk() };
});

// Each part's element is made with what canDragPart says: its calls count the elements made.
let made = 0;
vi.mock('../moduleEdit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../moduleEdit')>();
  return {
    ...real,
    canDragPart: (...a: Parameters<typeof real.canDragPart>) => {
      made++;
      return real.canDragPart(...a);
    },
  };
});

import { moveBrick, placeBrick } from '../mutations';
import { BrickLayer } from '../render/BrickLayer';
import { useEditorStore } from '../editorStore';
import { projectDoc } from '../useDocMap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BrickLayer re-render scope', () => {
  it('re-renders only the glyphs whose brick or selection state changed', async () => {
    const N = 1000;
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < N; i++) {
        ids.push(placeBrick(doc, layerId, { partNumber: 'track.0', x: i * 16, y: 0, width: 16, height: 8 }));
      }
    });
    const qc = new QueryClient();
    qc.setQueryData(['parts-catalog'], { parts: [] });
    const onEditBrick = () => undefined;
    const root = createRoot(document.createElement('div'));
    const render = (m: BbmMap) =>
      h(QueryClientProvider, { client: qc }, h(BrickLayer, { map: m, doc, onEditBrick }));

    let map = projectDoc(doc)!;
    await act(async () => root.render(render(map)));
    expect(prims).toBeGreaterThanOrEqual(N);

    // Parent re-render with the same map (pan / zoom / marquee / HUD).
    prims = 0;
    await act(async () => root.render(render(map)));
    expect(prims).toBe(0);

    // Selecting one brick re-renders the layer groups and the overlay, no glyph.
    prims = 0;
    await act(async () => useEditorStore.getState().setSelection([ids[0]!]));
    expect(prims).toBeLessThanOrEqual(3);

    // Select all (Ctrl+A) on a thousand parts: still no glyph. It used to
    // re-render every one and make two halo shapes each (7000+ here).
    prims = 0;
    await act(async () => useEditorStore.getState().setSelection([...ids]));
    expect(prims).toBeLessThanOrEqual(3);
    prims = 0;
    await act(async () => useEditorStore.getState().setSelection([]));
    expect(prims).toBeLessThanOrEqual(3);
    await act(async () => useEditorStore.getState().setSelection([ids[0]!]));

    // Moving one brick: new projection, but only that glyph re-renders.
    moveBrick(doc, layerId, ids[5]!, 3, 3);
    const next = projectDoc(doc)!;
    expect(next).not.toBe(map);
    map = next;
    prims = 0;
    await act(async () => root.render(render(map)));
    expect(prims).toBeLessThan(15);

    // A snap starting redraws the overlay (the halo turns green) and no
    // glyph; further live-snap updates during the drag touch nothing.
    prims = 0;
    await act(async () => useEditorStore.getState().setLiveSnap({ studX: 1, studY: 0 }));
    expect(prims).toBeGreaterThan(0);
    expect(prims).toBeLessThanOrEqual(3);
    prims = 0;
    await act(async () => useEditorStore.getState().setLiveSnap({ studX: 2, studY: 0 }));
    expect(prims).toBe(0);
    await act(async () => useEditorStore.getState().setLiveSnap(null));

    await act(async () => root.unmount());
  });

  // On a layout with modules, a read of the sidecar can give a new list of
  // modules that are the same (they're kept one per key and put together
  // again when the sidecar changes), so every part's element was made
  // again, and compared with the one before: one part moved went through
  // every part. The list is kept while the modules are the same (web #564).
  it('on a layout with modules, a re-render or one part moved makes no other part again', async () => {
    const N = 600;
    const doc = createDefaultLayoutDoc();
    const layerId = docToBbm(doc).layers.find((l) => l.type === 'brick')!.id;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < N; i++) ids.push(placeBrick(doc, layerId, { partNumber: 'track.0', x: i * 16, y: 0, width: 16, height: 8 }));
    });
    const modules = [0, 1, 2].map((m) => ({
      id: `m${m}`,
      name: `Module ${m}`,
      members: ids.slice(m * 200, m * 200 + 150),
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    }));
    doc.transact(() => writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules }));

    const qc = new QueryClient();
    qc.setQueryData(['parts-catalog'], { parts: [] });
    const root = createRoot(document.createElement('div'));
    const render = (m: BbmMap) => h(QueryClientProvider, { client: qc }, h(BrickLayer, { map: m, doc }));
    await act(async () => useEditorStore.getState().setSelection([]));
    let map = projectDoc(doc)!;
    made = 0;
    await act(async () => root.render(render(map)));
    expect(made).toBe(N);

    // A re-render with the same map (a pan, the HUD): no part made again.
    made = 0;
    prims = 0;
    await act(async () => root.render(render(map)));
    expect(made).toBe(0);
    expect(prims).toBe(0);

    // A part in a module moved, then one outside every module: only it.
    for (const id of [ids[10]!, ids[170]!]) {
      moveBrick(doc, layerId, id, 3, 3);
      map = projectDoc(doc)!;
      made = 0;
      prims = 0;
      await act(async () => root.render(render(map)));
      expect(made).toBe(1);
      expect(prims).toBeLessThan(15);
    }

    // A label added: the sidecar is read again, and its modules are put
    // together again from their keys, the same but a new list. No part is made again.
    const before = readSidecarFromDoc(doc)!.modules;
    doc.transact(() =>
      writeSidecarCache(doc, { ...readSidecarFromDoc(doc)!, anchoredLabels: [{ id: 'l1', text: 'Yard' }] } as unknown as Record<string, unknown>),
    );
    expect(readSidecarFromDoc(doc)!.modules).toEqual(before);
    expect(readSidecarFromDoc(doc)!.modules).not.toBe(before);
    made = 0;
    await act(async () => root.render(render(projectDoc(doc)!)));
    expect(made).toBe(0);

    // A module changed: every part is made with the new list, once.
    doc.transact(() =>
      writeSidecarCache(doc, { ...readSidecarFromDoc(doc)!, modules: modules.map((m, i) => (i === 0 ? { ...m, pinned: true } : m)) } as unknown as Record<string, unknown>),
    );
    made = 0;
    await act(async () => root.render(render(projectDoc(doc)!)));
    expect(made).toBe(N);
    made = 0;
    await act(async () => root.render(render(projectDoc(doc)!)));
    expect(made).toBe(0);

    await act(async () => root.unmount());
  });
});
