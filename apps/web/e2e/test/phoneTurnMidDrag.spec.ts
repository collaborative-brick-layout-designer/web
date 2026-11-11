// Turning the phone in the middle of a drag (the 11-11 checks): the view
// fits the new screen, and the dragged part used to jump out from under
// the finger. Now the drag ends where the part is when the screen turns,
// as a second finger ends it: the part stays put, the finger moving on
// moves nothing, and one Undo takes the move back.

import { test, expect, devices, type CDPSession, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';
const { defaultBrowserType: _a, ...pixel7 } = devices['Pixel 7'];

interface Brick {
  id: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  dragging: boolean;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = {
      name: () => string;
      getClassName: () => string;
      x: () => number;
      y: () => number;
      isDragging: () => boolean;
      getAbsolutePosition: () => { x: number; y: number };
    };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), x: n.x() / 8, y: n.y() / 8, sx: box.left + a.x, sy: box.top + a.y, dragging: n.isDragging() };
      });
  });
}

const touch = (cdp: CDPSession, type: string, pts: { x: number; y: number }[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });

test.use(pixel7);

test('turning the phone mid-drag ends the drag where the part is', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
  await signIn(page, `turn-drag-${Date.now()}@example.com`, 'Turn Drag');
  const res = await page.request.post('/api/layouts', { data: { title: 'Turn mid-drag' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
  await page.getByTestId('add-part').tap();
  const add = page.getByRole('dialog', { name: 'Add a part' });
  await add.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
  await add.locator(`[data-part-key="${PART}"]`).tap();
  await expect(page.getByTestId('touch-bar')).toHaveAttribute('aria-label', '1 picked');
  await expect.poll(async () => (await bricks(page)).length).toBe(1);
  const start = (await bricks(page))[0]!;

  // A finger on the picked part drags it.
  const cdp = await page.context().newCDPSession(page);
  let at = { x: start.sx, y: start.sy };
  await touch(cdp, 'touchStart', [at]);
  for (let i = 0; i < 8; i++) {
    at = { x: at.x - 5, y: at.y - 4 };
    await touch(cdp, 'touchMove', [at]);
  }
  await expect.poll(async () => (await bricks(page))[0]!.dragging).toBe(true);
  const moved = (await bricks(page))[0]!;
  expect(moved.x).toBeLessThan(start.x - 1);

  // The phone turns, with the finger still down.
  await page.setViewportSize({ width: 915, height: 412 });
  await expect.poll(async () => (await bricks(page))[0]!.dragging).toBe(false);
  // The part stayed where the drag had it (no jump on the map).
  const turned = (await bricks(page))[0]!;
  expect(turned.x).toBeCloseTo(moved.x, 3);
  expect(turned.y).toBeCloseTo(moved.y, 3);
  // The finger moving on moves nothing (not the part, not by a jump), then lifts.
  for (let i = 0; i < 6; i++) {
    at = { x: at.x + 9, y: at.y + 2 };
    await touch(cdp, 'touchMove', [at]);
  }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  const after = (await bricks(page))[0]!;
  expect(after.x).toBeCloseTo(moved.x, 3);
  expect(after.y).toBeCloseTo(moved.y, 3);
  // Still picked, and editing goes on: one Undo puts it back where it began.
  await expect(page.getByTestId('touch-bar')).toHaveAttribute('aria-label', '1 picked');
  await page.getByRole('button', { name: 'Undo' }).tap();
  await expect.poll(async () => (await bricks(page))[0]!.x).toBeCloseTo(start.x, 3);
  expect((await bricks(page))[0]!.y).toBeCloseTo(start.y, 3);

  // Turned back the other way, a new drag works as before.
  await page.setViewportSize({ width: 412, height: 839 });
  await page.waitForTimeout(300);
  const again = (await bricks(page))[0]!;
  await touch(cdp, 'touchStart', [{ x: again.sx, y: again.sy }]);
  for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: again.sx + i * 5, y: again.sy }]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(async () => (await bricks(page))[0]!.x).toBeGreaterThan(again.x + 1);
});
