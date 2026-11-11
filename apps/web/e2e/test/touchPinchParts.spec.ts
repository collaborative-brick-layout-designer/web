// Two fingers zoom and move the map wherever they come down. On a layout
// full of parts they nearly always land on parts, and a finger on a part
// that wasn't picked used to drag it: the pinch zoomed the map and moved
// (and sometimes turned, by snapping) a part for everyone. Here: fingers
// land on two parts, one after the other and both at once, on a phone and
// on a tablet; the map zooms, no part moves, nothing is there to undo, and
// a picked part still drags afterwards.
//
// Touches are sent through CDP (Input.dispatchTouchEvent), so this runs in
// Chromium. SHOTS_DIR=<dir> also saves screenshots, light and dark.

import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { signIn } from '../helpers';

const SHOTS = process.env.SHOTS_DIR;
const PART = 'ts_narrowgauge_straight.8';
const { defaultBrowserType: _a, ...iPhone14 } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...iPad } = devices['iPad (gen 7)'];
const ts = Date.now();
let seq = 0;

interface Pt {
  x: number;
  y: number;
}
interface Brick extends Pt {
  id: string;
  rot: number;
  /** Middle on the screen. */
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = {
      name: () => string;
      getClassName: () => string;
      x: () => number;
      y: () => number;
      rotation: () => number;
      getClientRect: () => { x: number; y: number; width: number; height: number };
    };
    const st = (window as unknown as {
      Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] };
    }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const r = n.getClientRect();
        return { id: n.name().slice(6), x: n.x() / 8, y: n.y() / 8, rot: n.rotation(), sx: box.left + r.x + r.width / 2, sy: box.top + r.y + r.height / 2 };
      });
  });
}
const zoom = (page: Page) =>
  page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());

class Fingers {
  constructor(private cdp: CDPSession) {}
  static async on(page: Page): Promise<Fingers> {
    return new Fingers(await page.context().newCDPSession(page));
  }
  private send(type: string, pts: Pt[]) {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
  }
  /** Two fingers come down at `a` and `b` (one after the other, or both at once), spread apart, and lift. */
  async spread(page: Page, a: Pt, b: Pt, together: boolean) {
    if (!together) {
      await this.send('touchStart', [a]);
      await page.waitForTimeout(40);
    }
    await this.send('touchStart', [a, b]);
    const dir = Math.sign(b.x - a.x) || 1;
    for (let d = 1; d <= 8; d++) {
      await this.send('touchMove', [{ x: a.x - dir * d * 4, y: a.y - d }, { x: b.x + dir * d * 4, y: b.y + d }]);
      await page.waitForTimeout(16);
    }
    await this.send('touchEnd', [{ x: a.x - dir * 32, y: a.y - 8 }]);
    await page.waitForTimeout(30);
    await this.send('touchEnd', []);
  }
  async tap(p: Pt) {
    await this.send('touchStart', [p]);
    await this.send('touchEnd', []);
  }
  async drag(from: Pt, to: Pt) {
    await this.send('touchStart', [from]);
    for (let i = 1; i <= 12; i++) await this.send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 }]);
    await this.send('touchEnd', []);
  }
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
}

for (const device of [
  { name: 'phone', use: iPhone14 },
  { name: 'tablet', use: iPad },
]) {
  test.describe(`two fingers on parts, on a ${device.name}`, () => {
    test.use(device.use);

    test('a pinch that lands on parts zooms the map and moves none of them', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
      await signIn(page, `pinch-${device.name}-${ts}-${seq++}@example.com`, 'Pinch Tester');
      const res = await page.request.post('/api/layouts', { data: { title: 'Pinch layout' } });
      const { id } = (await res.json()) as { id: string };
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      if (device.name === 'phone') await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
      const bar = page.getByTestId('touch-bar');

      // Two parts side by side, neither picked.
      await page.getByTestId('add-part').tap();
      const sheet = page.getByRole('dialog', { name: 'Add a part' });
      await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
      await sheet.locator(`[data-part-key="${PART}"]`).tap();
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(1);
      await bar.getByRole('button', { name: 'Duplicate' }).tap();
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(2);
      await bar.getByRole('button', { name: 'Done' }).tap();
      await expect(bar).toHaveAttribute('aria-label', 'Touch editing');
      const undo = page.getByRole('button', { name: 'Undo' }).first();

      const fingers = await Fingers.on(page);
      for (const together of [false, true]) {
        const before = await bricks(page);
        const [a, b] = [...before].sort((p, q) => p.sx - q.sx);
        const z0 = await zoom(page);
        // (On each part, towards the other, so both fingers stay on the screen once it has zoomed.)
        const gap = b!.sx - a!.sx;
        await fingers.spread(page, { x: a!.sx + gap * 0.2, y: a!.sy }, { x: b!.sx - gap * 0.2, y: b!.sy }, together);
        // The map zoomed in...
        await expect.poll(() => zoom(page)).toBeGreaterThan(z0 * 1.2);
        // ...and both parts are where they were, turned as they were, and not picked.
        await page.waitForTimeout(300);
        const after = await bricks(page);
        for (const p of before) {
          const q = after.find((n) => n.id === p.id)!;
          expect(q.x).toBeCloseTo(p.x, 6);
          expect(q.y).toBeCloseTo(p.y, 6);
          expect(q.rot).toBe(p.rot);
        }
        await expect(bar).toHaveAttribute('aria-label', 'Touch editing');
        await expect(page.locator('footer')).not.toContainText(/Moved|Connection snap/);
      }
      await shoot(page, `pinch-on-parts-${device.name}`);

      // A picked part being dragged stops where it is when a second finger lands on the other part.
      let all = await bricks(page);
      const [left, right] = [...all].sort((p, q) => p.sx - q.sx);
      await fingers.tap({ x: left!.sx, y: left!.sy });
      await expect(bar).toHaveAttribute('aria-label', '1 picked');
      const apart = right!.sx - left!.sx;
      await fingers.spread(page, { x: left!.sx + apart * 0.2, y: left!.sy }, { x: right!.sx - apart * 0.2, y: right!.sy }, false);
      await page.waitForTimeout(300);
      all = await bricks(page);
      const other = all.find((n) => n.id === right!.id)!;
      expect(other.x).toBeCloseTo(right!.x, 6);
      expect(other.y).toBeCloseTo(right!.y, 6);

      // And one finger still drags the picked part afterwards.
      const picked = all.find((n) => n.id === left!.id)!;
      await fingers.drag({ x: picked.sx, y: picked.sy }, { x: picked.sx - 30, y: picked.sy + 50 });
      await expect.poll(async () => (await bricks(page)).find((n) => n.id === picked.id)!.y).toBeGreaterThan(picked.y + 1);
      await expect(undo).toBeEnabled();
    });
  });
}
