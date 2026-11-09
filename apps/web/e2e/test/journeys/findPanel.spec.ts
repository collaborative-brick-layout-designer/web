// Journey — the Find panel never covers the toolbar's buttons.
//
//   At 1280 px, where the Edit toolbar wraps onto a second row, and on a
//   phone, where the touch bar sits at the bottom: open Find, search a part
//   number so its 72 parts are picked, and Turn left / Turn right are still
//   on screen with nothing over them, and a click on one works with the
//   panel open. The panel sits below the toolbar and above the touch bar.
//   (It used to sit at a fixed spot under the header, over a wrapped
//   toolbar's Turn buttons.)

import { test, expect, devices, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signIn } from '../../helpers';

const FORDYCE = readFileSync(fileURLToPath(new URL('../../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm', import.meta.url)), 'utf-8');
const ts = Date.now();
const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];

async function openFordyce(page: Page, who: string): Promise<void> {
  await signIn(page, `j-find-${who}-${ts}@example.com`, 'Find Fay');
  const res = await page.request.post('/api/layouts', { data: { title: `Find ${who}`, bbm: FORDYCE } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

/** Opens Find and picks every part numbered `part`. */
async function findPart(page: Page, part: string): Promise<Locator> {
  await page.keyboard.press('Control+f');
  const panel = page.getByRole('dialog', { name: 'Find & Replace' });
  await panel.getByLabel('Find in').selectOption('part');
  await panel.getByPlaceholder('Search…').fill(part);
  return panel;
}

/** The button is on screen and nothing lies over its middle. */
async function expectUncovered(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  const onTop = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(onTop, `${await button.getAttribute('aria-label')} is covered`).toBe(true);
}

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Turn left and Turn right stay clickable with Find open', async ({ page }) => {
    await openFordyce(page, 'wide');
    const panel = await findPart(page, '3857.0');
    await expect(page.locator('footer')).toContainText('selected: 72');
    const toolbar = page.getByRole('toolbar', { name: 'Edit' });
    for (const name of ['Turn left', 'Turn right']) await expectUncovered(toolbar.getByRole('button', { name, exact: true }));
    // The panel starts under the toolbar, however many rows it wraps to.
    const bar = (await toolbar.boundingBox())!;
    expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    // A click goes through to the button, with the panel still open.
    await toolbar.getByRole('button', { name: 'Turn right', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(panel).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use(pixel7);

  test('the touch bar\'s Turn buttons stay clickable with Find open', async ({ page }) => {
    await openFordyce(page, 'phone');
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    const panel = await findPart(page, '3857.0');
    const bar = page.getByTestId('touch-bar');
    await expect(bar).toHaveAttribute('aria-label', '72 picked');
    for (const name of ['Turn left', 'Turn right']) await expectUncovered(bar.getByRole('button', { name, exact: true }));
    // The panel ends above the touch bar.
    const box = (await panel.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
    await bar.getByRole('button', { name: 'Turn left', exact: true }).tap();
    await expect(panel).toBeVisible();
    await expect(bar).toHaveAttribute('aria-label', '72 picked');
  });
});
