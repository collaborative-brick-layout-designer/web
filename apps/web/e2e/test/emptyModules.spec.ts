// A module with no parts yet is labeled and can't be inserted, in the
// Insert module dialog and in the editor's Module library panel, so nobody
// places nothing. A module with parts beside it still inserts.
// SHOTS_DIR=<dir> also saves pictures, light and dark.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn, makeModule } from '../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('an empty module says "No parts yet" and can\'t be inserted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signIn(page, `empty-mod-${ts}@example.com`, 'Empty Modules');

  // One module with a part (made in a layout and saved), one blank one.
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Yard' } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await page.keyboard.press('Control+a');
  await makeModule(page, 'Has parts', { alsoSave: true });
  const blank = await page.request.post('/api/modules', { data: { title: 'Blank module' } });
  expect(blank.status()).toBe(201);

  // The server says which one is empty.
  const list = (await (await page.request.get('/api/modules')).json()) as { modules: { title: string; empty?: boolean }[] };
  expect(list.modules.find((m) => m.title === 'Blank module')?.empty).toBe(true);
  expect(list.modules.find((m) => m.title === 'Has parts')?.empty).toBe(false);

  // Insert module dialog.
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Insert module' }).click();
  const dialog = page.getByRole('dialog', { name: 'Insert module' });
  const blankRow = dialog.locator('li', { hasText: 'Blank module' });
  await expect(blankRow.getByTestId('module-empty')).toContainText('No parts yet');
  await expect(blankRow.getByRole('button', { name: 'Insert' })).toBeDisabled();
  const fullRow = dialog.locator('li', { hasText: 'Has parts' });
  await expect(fullRow.getByTestId('module-empty')).toHaveCount(0);
  await expect(fullRow.getByRole('button', { name: 'Insert' })).toBeEnabled();
  await shot(page, 'insert-module-dialog');
  await page.keyboard.press('Escape');

  // The Module library panel in the editor.
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Module library', { exact: true }).check();
  await page.mouse.click(600, 500);
  const row = page.getByTestId('module-library-row').filter({ hasText: 'Blank module' });
  await expect(row.getByTestId('module-empty')).toHaveText('No parts yet');
  await expect(row.getByRole('button', { name: 'Add to layout' })).toBeDisabled();
  const full = page.getByTestId('module-library-row').filter({ hasText: 'Has parts' });
  await expect(full.getByRole('button', { name: 'Add to layout' })).toBeEnabled();
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'module-library-panel');
});
