// Someone else's move on a big layout (full review area 4, Bug 4): every
// open tab drew every part again, then every part again for the view
// picture, so on 7,520 parts each move froze every tab for about a second.
// Now a tab draws again only the places where the moved part was and is,
// on its screen canvas, its hit canvas (what a click lands on) and the
// view picture kept for the next pan (render/cullOffscreen.ts).

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'), 'utf-8');
const PARTS = 940;

/** Counts part pictures drawn on any canvas (screen, hit, view picture), from now. */
async function countDraws(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    type S = { drawScene: (...a: unknown[]) => unknown; __scene?: (...a: unknown[]) => unknown; getClassName: () => string };
    const w = window as unknown as { Konva: { Shape: { prototype: S } }; __draws: number };
    w.__draws = 0;
    const p = w.Konva.Shape.prototype;
    p.__scene ??= p.drawScene;
    const scene = p.__scene;
    p.drawScene = function (this: S, ...a: unknown[]) {
      if (this.getClassName() === 'Image') w.__draws++;
      return scene.apply(this, a);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __draws: number }).__draws);
}

/** How the parts layer drew since the page opened (render/cullOffscreen.ts). */
interface Stats {
  whole: number;
  partial: number;
  why: string;
}
function stats(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    type L = { redrawStats: () => { whole: number; partial: number; why: string } };
    const st = (window as unknown as { Konva: { stages: { findOne: (s: string) => L }[] } }).Konva.stages[0]!;
    return st.findOne('.parts-layer').redrawStats();
  });
}

/** The parts layer's canvases as they are, against the same after drawing everything again. */
interface Compared {
  /** The biggest difference in any color channel of any pixel, on the screen canvas and on the hit canvas (what a click lands on). */
  scene: number;
  hit: number;
  /** Points of a grid over the view where a click would land on another node. */
  picks: number;
  /** Whether the screen canvas has nothing on it. */
  blank: boolean;
}
/**
 * What a whole draw gives. A part's soft edge can come out a step or two
 * lighter or darker when it's drawn into a clipped place, so a difference
 * of up to 3 in 255 passes on the screen canvas, and 12 on the hit canvas
 * (each part has a color of its own there, so the same step shows more);
 * a part left where it was, or missing, is a difference of 100 and more.
 */
const SAME: Compared = { scene: 0, hit: 0, picks: 0, blank: false };
async function sameAsAWholeDraw(page: Page): Promise<Compared> {
  const got = await page.evaluate(() => {
    type C = { _canvas: HTMLCanvasElement };
    type L = { getCanvas: () => C; hitCanvas: C; draw: () => void };
    type St = { findOne: (s: string) => L; width: () => number; height: () => number; getIntersection: (p: { x: number; y: number }) => { _id: number } | null };
    const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
    const layer = st.findOne('.parts-layer');
    const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const picks = () => {
      const out: number[] = [];
      for (let y = 5; y < st.height(); y += 23) for (let x = 5; x < st.width(); x += 23) out.push(st.getIntersection({ x, y })?._id ?? 0);
      return out;
    };
    const now = () => ({ scene: pixels(layer.getCanvas()._canvas).slice(), hit: pixels(layer.hitCanvas._canvas).slice(), picks: picks() });
    const before = now();
    // Nothing marked the layer, so this draws everything.
    layer.draw();
    const after = now();
    const most = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      if (a.length !== b.length) return 255;
      let m = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i]! > b[i]! ? a[i]! - b[i]! : b[i]! - a[i]!;
        if (d > m) m = d;
      }
      return m;
    };
    return {
      scene: most(before.scene, after.scene),
      hit: most(before.hit, after.hit),
      picks: before.picks.filter((id, i) => id !== after.picks[i]).length,
      blank: after.scene.every((v) => v === 0),
    };
  });
  return { scene: got.scene <= 3 ? 0 : got.scene, hit: got.hit <= 12 ? 0 : got.hit, picks: got.picks, blank: got.blank };
}

/** Someone else changes a part (`edit` in Alice's tab): the receiving tab's part pictures drawn for it, and how its parts layer drew. */
async function drawsFor(bob: Page, edit: () => Promise<void>): Promise<{ pictures: number; whole: number; partial: number; why: string }> {
  await bob.waitForTimeout(2500);
  const was = await stats(bob);
  const done = await countDraws(bob);
  await edit();
  // Bob's tab draws it, then (once still) brings the picture for the next pan up to date.
  await bob.waitForTimeout(2500);
  const is = await stats(bob);
  return { pictures: await done(), whole: is.whole - was.whole, partial: is.partial - was.partial, why: is.why };
}

test("someone else's move draws only where the part was and is", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await signIn(ctxA, `redraw-a-${Date.now()}@example.com`, 'Ann Redraw');
  const alice = await ctxA.newPage();
  const res = await alice.request.post('/api/layouts', { data: { title: 'Redraw', bbm: FORDYCE } });
  const { id } = (await res.json()) as { id: string };
  const ctxB = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await ctxB.addCookies(await ctxA.cookies());
  const bob = await ctxB.newPage();
  for (const p of [alice, bob]) {
    await p.goto(`/editor/${id}`);
    await expect(p.getByTestId('save-status')).toHaveText(/Saved/, { timeout: 30000 });
    await p.getByRole('button', { name: 'Fit', exact: true }).click();
  }
  // Alice picks a part near the middle.
  const part = await alice.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getClientRect: () => { x: number; y: number; width: number; height: number } };
    const st = (window as unknown as { Konva: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva.stages[0]!;
    const b = st.container().getBoundingClientRect();
    let best: { x: number; y: number; d: number } | null = null;
    for (const n of st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))) {
      const r = n.getClientRect();
      if (r.width < 10 || r.height < 10) continue;
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const d = Math.hypot(x - b.width / 2, y - b.height / 2);
      if (!best || d < best.d) best = { x: b.left + x, y: b.top + y, d };
    }
    return best;
  });
  expect(part).not.toBeNull();
  await alice.mouse.click(part!.x, part!.y);
  const nudge = () => alice.keyboard.press('ArrowRight');

  // The whole map on screen. It used to draw each part's picture once
  // (940), and before that twice; now just the ones around the moved part,
  // on the screen canvas and in the picture.
  const atFit = await drawsFor(bob, nudge);
  expect(atFit.whole, `whole draws, the last for: ${atFit.why}`).toBe(0);
  // The screen canvas and the hit canvas, each once.
  expect(atFit.partial).toBe(2);
  expect(atFit.pictures).toBeLessThan(PARTS * 0.1);
  // And what's on the canvases is what drawing everything gives.
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);

  // Several moves in a row, and the mover's own tab too.
  for (let i = 0; i < 3; i++) await nudge();
  await bob.waitForTimeout(1500);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);
  expect(await sameAsAWholeDraw(alice)).toEqual(SAME);

  // In the mover's own tab, letting go of the part, picking it again and
  // moving it draw only around it too (the selection's halo is drawn over
  // just the picked parts: it used to draw the whole view).
  for (const [what, act] of [
    ['let go', () => alice.keyboard.press('Escape')],
    ['picked', () => alice.mouse.click(part!.x + 1, part!.y)],
    ['moved', nudge],
  ] as const) {
    const own = await drawsFor(alice, act);
    expect(own.whole, `${what}: whole draws, the last for: ${own.why}`).toBe(0);
    expect(own.pictures, what).toBeLessThan(PARTS * 0.1);
    expect(await sameAsAWholeDraw(alice), what).toEqual(SAME);
  }

  // Zoomed in: the same, with part of the map off screen.
  for (let i = 0; i < 10; i++) await bob.getByRole('button', { name: 'Zoom in' }).first().click();
  const zoomed = await drawsFor(bob, nudge);
  console.log(`[measure] part pictures drawn for a remote move: ${atFit.pictures} at Fit, ${zoomed.pictures} zoomed in (${PARTS} parts)`);
  expect(zoomed.whole, `whole draws, the last for: ${zoomed.why}`).toBe(0);
  expect(zoomed.pictures).toBeLessThan(PARTS * 0.1);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);

  // The part is deleted: where it was is drawn again, and nothing of it is left.
  const removed = await drawsFor(bob, () => alice.keyboard.press('Delete'));
  expect(removed.pictures).toBeLessThan(PARTS * 0.1);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);
  // And it comes back with Undo.
  await alice.keyboard.press('Control+z');
  await bob.waitForTimeout(1500);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);

  // A pan starts on the picture kept for it, and ends drawn whole and right.
  await bob.mouse.move(650, 500);
  await bob.mouse.down({ button: 'middle' });
  await bob.mouse.move(600, 470, { steps: 4 });
  await bob.mouse.up({ button: 'middle' });
  await bob.waitForTimeout(1500);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);
  await nudge();
  await bob.waitForTimeout(1500);
  expect(await sameAsAWholeDraw(bob)).toEqual(SAME);
  await ctxA.close();
  await ctxB.close();
});
