// "Fade other sheets while editing": which sheets fade, and that a picture
// always draws every sheet at its own strength (exportRender unfadeSheets).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Konva from 'konva';
import * as Y from 'yjs';
import { docToBbm } from '@cld/ydoc';
import { ensureBrickLayer, placeBrick } from '../mutations';
import { renderMapToCanvas, unfadeSheets } from '../exportRender';
import { FADED_SHEET_OPACITY, SHEET_FADE, SHEET_FULL_OPACITY, sheetFadeOpacity } from '../render/sheetFade';
import { useEditorStore } from '../editorStore';

describe('sheetFadeOpacity', () => {
  it('fades every sheet but the active one, only while the setting is on', () => {
    expect(sheetFadeOpacity('a', true, 'a')).toBe(1);
    expect(sheetFadeOpacity('b', true, 'a')).toBe(FADED_SHEET_OPACITY);
    expect(sheetFadeOpacity('b', false, 'a')).toBe(1);
    // No active sheet: nothing to make stand out, so nothing fades.
    expect(sheetFadeOpacity('b', true, null)).toBe(1);
  });

  it('is off by default and kept in this browser, not in the layout', () => {
    expect(useEditorStore.getState().fadeOtherSheets).toBe(false);
    useEditorStore.getState().setFadeOtherSheets(true);
    expect(localStorage.getItem('cld:fadeOtherSheets')).toBe('true');
    useEditorStore.getState().setFadeOtherSheets(false);
    expect(localStorage.getItem('cld:fadeOtherSheets')).toBe('false');
  });
});

/** A sheet group as Konva has it: its opacity, and its own transparency when it carries one. */
function group(opacity: number, full?: number) {
  let o = opacity;
  return {
    opacity: (v?: number) => (v === undefined ? o : ((o = v), undefined)),
    getAttr: (k: string) => (k === SHEET_FULL_OPACITY ? full : undefined),
  };
}

describe('a picture never shows the fade', () => {
  afterEach(() => vi.restoreAllMocks());

  it('unfadeSheets draws each sheet at its own strength, then puts the fade back', () => {
    const faded = group(FADED_SHEET_OPACITY);
    const fadedSeeThrough = group(0.5 * FADED_SHEET_OPACITY, 0.5);
    const active = group(1);
    const stage = { find: (s: string) => (s === `.${SHEET_FADE}` ? [faded, fadedSeeThrough, active] : []) } as unknown as Konva.Stage;
    const refade = unfadeSheets(stage);
    expect([faded.opacity(), fadedSeeThrough.opacity(), active.opacity()]).toEqual([1, 0.5, 1]);
    refade();
    expect([faded.opacity(), fadedSeeThrough.opacity(), active.opacity()]).toEqual([FADED_SHEET_OPACITY, 0.5 * FADED_SHEET_OPACITY, 1]);
  });

  it('renderMapToCanvas draws while every sheet is at full strength', () => {
    const doc = new Y.Doc();
    placeBrick(doc, ensureBrickLayer(doc), { partNumber: 'p', x: 0, y: 0, width: 10, height: 5 });
    const faded = group(FADED_SHEET_OPACITY);
    const seen: number[] = [];
    const content = document.createElement('canvas');
    const stage = {
      x: () => 0, y: () => 0, scaleX: () => 1, scaleY: () => 1, scale: () => {}, position: () => {},
      find: (s: string) => (s === `.${SHEET_FADE}` ? [faded] : []),
      toCanvas: () => (seen.push(faded.opacity() as number), content),
      batchDraw: () => {},
    } as unknown as Konva.Stage;
    const ctx = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), globalCompositeOperation: '', fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    renderMapToCanvas(stage, docToBbm(doc), null, { pixelRatio: 1, transparent: false });
    expect(seen).toEqual([1]);
    expect(faded.opacity()).toBe(FADED_SHEET_OPACITY);
  });
});
