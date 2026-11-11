// A notice never covers an open bottom sheet's buttons on a phone (the
// 11-11 checks): Make a module says "pick it, tap Module…", and tapping
// Module right away opened the module's sheet under the notice, its first
// buttons hidden for the seconds the notice showed. With a sheet open the
// notice sits at the top of the screen, over the dimmed map; once the
// sheet closes it's back above the touch bar.
// SHOTS_DIR=<dir> saves light and dark pictures.

import { test, expect, devices, type Locator, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS_DIR;
const { defaultBrowserType: _a, ...pixel7 } = devices['Pixel 7'];
const { defaultBrowserType: _b, ...iPhoneSE } = devices['iPhone SE'];

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The two boxes don't overlap. */
async function apart(a: Locator, b: Locator) {
  const x = (await a.boundingBox())!;
  const y = (await b.boundingBox())!;
  const overlap = x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
  expect(overlap, `notice ${JSON.stringify(x)} over sheet ${JSON.stringify(y)}`).toBe(false);
}

for (const phone of [{ name: 'Pixel 7', use: pixel7 }, { name: 'iPhone SE', use: iPhoneSE }]) {
  test.describe(`notices and sheets on ${phone.name}`, () => {
    test.use(phone.use);

    test('a notice moves clear of an open bottom sheet and comes back when it closes', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'touch emulation');
      const slug = phone.name.replace(/\W+/g, '-').toLowerCase();
      await signIn(page, `notice-sheet-${slug}-${Date.now()}@example.com`, 'Notice Sheet');
      const res = await page.request.post('/api/layouts', { data: { title: 'Notice and sheet' } });
      const { id } = (await res.json()) as { id: string };
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
      await page.getByTestId('add-part').tap();
      const add = page.getByRole('dialog', { name: 'Add a part' });
      await add.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
      await add.locator(`[data-part-key="${PART}"]`).tap();
      const bar = page.getByTestId('touch-bar');
      await expect(bar).toHaveAttribute('aria-label', '1 picked');

      // Make a module: the notice says to tap Module, above the bar.
      await page.getByTestId('touch-module').tap();
      const make = page.getByRole('dialog', { name: 'Make a module' });
      await make.getByLabel('Module name').fill('Siding');
      await make.getByRole('button', { name: 'Make module' }).tap();
      const notice = page.getByTestId('notice');
      await expect(notice).toContainText('tap Module');
      const below = (await notice.boundingBox())!;

      // Tap Module at once: the sheet opens, and the notice is clear of it, at the top.
      await bar.getByRole('button', { name: 'Module' }).tap();
      const sheet = page.getByTestId('touch-module-sheet');
      await expect(sheet.getByRole('button', { name: 'Hide name' })).toBeVisible();
      await page.waitForTimeout(300); // (the sheet slides up)
      await expect(notice).toBeVisible();
      await apart(notice, sheet);
      expect((await notice.boundingBox())!.y).toBeLessThan(below.y);
      await shoot(page, `phone-${slug}-notice-over-sheet`);
      // The sheet's first buttons take a tap (nothing lies over them).
      const hide = sheet.getByRole('button', { name: 'Hide name' });
      const h = (await hide.boundingBox())!;
      const onTop = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid="touch-module-sheet"]') !== null,
        [h.x + h.width / 2, h.y + h.height / 2],
      );
      expect(onTop).toBe(true);
      await sheet.getByRole('button', { name: 'Close' }).tap();
      await expect(sheet).toHaveCount(0);

      // Closed: back above the bar.
      await expect(notice).toBeVisible();
      const back = (await notice.boundingBox())!;
      expect(back.y).toBeCloseTo(below.y, 0);
    });
  });
}
