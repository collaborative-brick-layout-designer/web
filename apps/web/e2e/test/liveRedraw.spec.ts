// Someone else's move on a big layout (full review area 4, Bug 4): every
// open tab drew every part again, then every part again for the view
// picture, so on 7,520 parts each move froze every tab for about a second.
// Now a tab draws the parts on screen once, and the picture copies them.

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

/** Someone else moves a part: the receiving tab's part pictures drawn for it. */
async function drawsForARemoteMove(alice: Page, bob: Page): Promise<number> {
  await bob.waitForTimeout(2500);
  const done = await countDraws(bob);
  // Alice nudges a picked part with the keyboard (one edit).
  await alice.keyboard.press('ArrowRight');
  // Bob's tab draws it, then (once still) takes the picture for the next pan.
  await bob.waitForTimeout(2500);
  return done();
}

test("someone else's move draws the parts on screen once, not every part twice", async ({ browser }) => {
  test.setTimeout(120_000);
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

  // The whole map on screen: each part's picture once (it was twice: the
  // screen, then the view picture again).
  const atFit = await drawsForARemoteMove(alice, bob);
  expect(atFit).toBeGreaterThan(PARTS * 0.8);
  expect(atFit).toBeLessThan(PARTS * 1.4);

  // Zoomed in: only the parts on screen, and those in the picture's margin.
  for (let i = 0; i < 10; i++) await bob.getByRole('button', { name: 'Zoom in' }).first().click();
  const zoomed = await drawsForARemoteMove(alice, bob);
  console.log(`[measure] part pictures drawn for a remote move: ${atFit} at Fit, ${zoomed} zoomed in (${PARTS} parts)`);
  expect(zoomed).toBeLessThan(atFit * 0.7);
  await ctxA.close();
  await ctxB.close();
});
