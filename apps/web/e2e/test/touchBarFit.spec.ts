// The touch bar on a phone, with parts picked: every word sits inside its
// own button (they used to run into each other on a Pixel 7), the notice
// after Make a module sits above the bar instead of over its buttons, and
// a picked module's sheet has Show / Hide name and Colors… as the
// desktop's menus do.

import { test, expect, devices, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';
const { defaultBrowserType: _a, ...pixel7 } = devices['Pixel 7'];
const { defaultBrowserType: _b, ...iPhoneSE } = devices['iPhone SE'];

async function boxes(page: Page, sel: string) {
  return page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
}

for (const phone of [{ name: 'Pixel 7', use: pixel7 }, { name: 'iPhone SE', use: iPhoneSE }]) {
  test.describe(`the touch bar on ${phone.name}`, () => {
    test.use(phone.use);

    test('words fit their buttons, the notice clears the bar, and the module sheet has its look', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'touch emulation');
      await signIn(page, `bar-fit-${phone.name.replace(/\W+/g, '-').toLowerCase()}-${Date.now()}@example.com`, 'Bar Fit');
      const res = await page.request.post('/api/layouts', { data: { title: 'Bar fit' } });
      const { id } = (await res.json()) as { id: string };
      await page.goto(`/editor/${id}`);
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
      await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
      await page.getByTestId('add-part').tap();
      const sheet = page.getByRole('dialog', { name: 'Add a part' });
      await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
      await sheet.locator(`[data-part-key="${PART}"]`).tap();
      const bar = page.getByTestId('touch-bar');
      await expect(bar).toHaveAttribute('aria-label', '1 picked');

      // Each word inside its button, and no two buttons overlap; the bar fits the screen.
      const buttons = await boxes(page, '[data-testid="touch-bar"] button');
      const words = await boxes(page, '[data-testid="touch-bar"] button > span');
      expect(buttons.length).toBeGreaterThanOrEqual(8);
      expect(words.length).toBe(buttons.length);
      buttons.forEach((b, i) => {
        expect(words[i]!.left).toBeGreaterThanOrEqual(b.left - 0.5);
        expect(words[i]!.right).toBeLessThanOrEqual(b.right + 0.5);
        expect(b.right - b.left).toBeGreaterThanOrEqual(43.5);
        if (i > 0) expect(b.left).toBeGreaterThanOrEqual(buttons[i - 1]!.right - 0.5);
      });
      // The page itself never scrolls sideways (the narrowest phones scroll the bar's row instead).
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      if (phone.name === 'Pixel 7') expect(buttons.at(-1)!.right).toBeLessThanOrEqual(page.viewportSize()!.width);
      // Still named in full for screen readers and tests.
      await expect(bar.getByRole('button', { name: 'Turn right' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Select area' })).toBeVisible();

      // Make a module: the notice is above the bar, and the bar's buttons still work.
      await page.getByTestId('touch-module').tap();
      const make = page.getByRole('dialog', { name: 'Make a module' });
      await make.getByLabel('Module name').fill('Bar module');
      await make.getByRole('button', { name: 'Make module' }).tap();
      const notice = page.getByTestId('notice');
      await expect(notice).toContainText('tap Module');
      const n = (await notice.boundingBox())!;
      const b = (await bar.boundingBox())!;
      expect(n.y + n.height).toBeLessThanOrEqual(b.y + 0.5);
      await bar.getByRole('button', { name: 'Module' }).tap();

      // The module's sheet: Hide name, then Colors… opens the colors dialog.
      const modSheet = page.getByTestId('touch-module-sheet');
      await expect(modSheet.getByRole('button', { name: 'Hide name' })).toBeVisible();
      await modSheet.getByRole('button', { name: 'Hide name' }).tap();
      await expect(modSheet).toHaveCount(0);
      await bar.getByRole('button', { name: 'Module' }).tap();
      await expect(modSheet.getByRole('button', { name: 'Show name' })).toBeVisible();
      await modSheet.getByRole('button', { name: 'Colors…' }).tap();
      await expect(page.getByRole('dialog', { name: /^Module look/ })).toBeVisible();
    });
  });
}
