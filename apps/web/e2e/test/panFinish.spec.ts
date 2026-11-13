// A pan's end on a big layout (render/cullOffscreen.ts): the parts sheet's
// canvases are shifted with the view and only the strip the pan brought in
// is drawn, so the frame the pan ends in is short. A shifted sprite at a
// part-px place can come out a hair off a fresh draw, so that one frame has
// a named, bounded exception; once the view is still and the page idle the
// canvases are drawn again in full, and from then on they match a fresh
// draw as everywhere else.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');

/** Everywhere: at most 1 in 255 off a fresh draw, in any channel of any pixel. */
const SAME_AS_FRESH = 1;
/**
 * The one exception: the frame a pan ends in, before the sharp draw. Its
 * shifted pixels were up to 7 in 255 off a fresh draw in about 30 places
 * (accepted by Aaron, 2026-11-12); 8 passes, anything more fails.
 */
const PAN_FINISH_SHIFT_MAX = 8;
/** And only in a few places: more than this many pixels over SAME_AS_FRESH fails too. */
const PAN_FINISH_SHIFT_PIXELS = 400;

interface Off {
  /** The biggest difference in any channel of any pixel, screen canvas and hit canvas. */
  scene: number;
  hit: number;
  /** Pixels of the screen canvas off by more than SAME_AS_FRESH. */
  scenePixels: number;
  /** Whether its canvases still hold shifted pixels. */
  soft: boolean;
}

/** The parts sheet's canvases as they are, against drawing everything again. */
function offAFreshDraw(page: Page): Promise<Off> {
  return page.evaluate((same) => {
    type C = { _canvas: HTMLCanvasElement };
    type L = { getCanvas: () => C; hitCanvas: C; draw: () => void; redrawStats: () => { soft: boolean } };
    const st = (window as unknown as { Konva: { stages: { findOne: (s: string) => L }[] } }).Konva.stages[0]!;
    const layer = st.findOne('.parts-layer');
    const soft = layer.redrawStats().soft;
    const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.slice();
    const before = { scene: pixels(layer.getCanvas()._canvas), hit: pixels(layer.hitCanvas._canvas) };
    // Nothing marked the layer, so this draws everything.
    layer.draw();
    const after = { scene: pixels(layer.getCanvas()._canvas), hit: pixels(layer.hitCanvas._canvas) };
    const most = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      if (a.length !== b.length) return 255;
      let m = 0;
      for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
      return m;
    };
    let scenePixels = 0;
    for (let i = 0; i < before.scene.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(before.scene[i + k]! - after.scene[i + k]!));
      if (d > same) scenePixels++;
    }
    return { scene: most(before.scene, after.scene), hit: most(before.hit, after.hit), scenePixels, soft };
  }, SAME_AS_FRESH);
}

function soft(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type L = { redrawStats: () => { soft: boolean } };
    return (window as unknown as { Konva: { stages: { findOne: (s: string) => L }[] } }).Konva.stages[0]!.findOne('.parts-layer').redrawStats().soft;
  });
}

async function pan(page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (by.x * i) / 10, from.y + (by.y * i) / 10);
  await page.mouse.up({ button: 'middle' });
}

test('a pan ends with a shifted frame close to a fresh draw, then the sharp draw replaces it', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `pan-finish-${Date.now()}@example.com`, 'Pan Finish');
  const res = await page.request.post('/api/layouts', { data: { title: 'Pan finish', bbm: FORDYCE } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 60000 });
  await expect(page.getByText('940 pieces').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(1500);
  const area = (await page.locator('.konvajs-content').first().boundingBox())!;
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };

  for (const where of ['the whole map', 'zoomed in'] as const) {
    if (where === 'zoomed in') {
      for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).first().click();
      await page.waitForTimeout(1500);
    }
    // The frame the pan ends in: shifted, and within the named exception.
    await pan(page, c, { x: 120, y: 60 });
    await page.waitForTimeout(60);
    const ended = await offAFreshDraw(page);
    expect(ended.soft, `${where}: the pan's end shifted the canvases`).toBe(true);
    expect(ended.scene, `${where}: the pan's end frame, off a fresh draw`).toBeLessThanOrEqual(PAN_FINISH_SHIFT_MAX);
    expect(ended.scenePixels, `${where}: and in only a few places`).toBeLessThanOrEqual(PAN_FINISH_SHIFT_PIXELS);
    await page.waitForTimeout(1500);

    // Once still and idle, the sharp draw: the same as a fresh draw.
    await pan(page, c, { x: -90, y: -40 });
    await page.waitForTimeout(30);
    expect(await soft(page), `${where}: shifted at first`).toBe(true);
    const t0 = Date.now();
    await expect.poll(() => soft(page), { timeout: 3000, intervals: [25] }).toBe(false);
    const took = Date.now() - t0;
    expect(took, `${where}: the sharp draw comes within about half a second`).toBeLessThan(1500);
    const sharp = await offAFreshDraw(page);
    // (In the report: how far off the pan's end was, and how long the sharp draw took.)
    test.info().annotations.push({ type: where, description: `pan end ${JSON.stringify(ended)}; sharp after ${took} ms ${JSON.stringify(sharp)}` });
    console.log(`${where}: pan end ${JSON.stringify(ended)}; sharp after ${took} ms ${JSON.stringify(sharp)}`);
    expect(sharp, `${where}: after the sharp draw (${took} ms)`).toMatchObject({ scene: expect.any(Number), soft: false });
    expect(sharp.scene, `${where}: screen canvas after the sharp draw`).toBeLessThanOrEqual(SAME_AS_FRESH);
    expect(sharp.hit, `${where}: hit canvas after the sharp draw`).toBeLessThanOrEqual(SAME_AS_FRESH);
    await page.waitForTimeout(1500);
  }
});
