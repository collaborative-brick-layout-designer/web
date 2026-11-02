// Journey — a layout saved with drawing settings out of range opens and
// draws normally after the one-time fix.
//
//   Before the server checked drawing settings, a layout could be saved
//   with a grid of a million sub-divisions, lines a billion pixels thick
//   and so on. The fix clamp-drawing-values (apps/server src/ops/
//   clampDrawingValues.ts; the server runs it at a start with
//   CBLD_DATA_FIX) puts them back in range. Here: such a layout → the dry
//   run names it and changes nothing → the fix → the layout opens, its
//   grid's Sheet options show the values in range, and a part placed on it
//   is counted and kept after a reload.

import { test, expect } from '@playwright/test';
import { signIn } from '../../helpers';
import { clampDrawingValuesFix, spoilSheetSettings } from '../../dbHelpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';

test('a layout with old drawing values out of range opens and draws normally after the fix', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-old-drawing-${ts}@example.com`, 'Old Ollie');
  const res = await page.request.post('/api/layouts', { data: { title: `Old drawing values ${ts}` } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };

  // ── Saved before the check: a grid no app could draw. ──
  spoilSheetSettings(id, 'grid', {
    subDivisionNumber: 1_000_000,
    gridThickness: 1e9,
    transparency: 500,
    cellIndexFont: { family: 'Arial', size: 1e6, style: 'Regular' },
  });

  // ── The dry run names it and writes nothing. ──
  const dry = clampDrawingValuesFix(false);
  expect(dry).toContain(`layout ${id} "Old drawing values ${ts}": 4 values`);
  expect(dry).toContain('grid.subDivisionNumber (sheet grid-1): 1000000 -> 100');
  expect(dry).toContain('dry run, nothing written');
  expect(clampDrawingValuesFix(false)).toContain(`layout ${id}`);

  // ── The fix. ──
  const applied = clampDrawingValuesFix(true);
  expect(applied).toContain(`layout ${id}`);
  expect(clampDrawingValuesFix(false)).not.toContain(`layout ${id}`);

  // ── It opens and draws. ──
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const sheets = page.locator('aside', { hasText: 'Sheets' });
  await sheets.locator('li', { hasText: 'Grid' }).first().dblclick();
  const options = page.getByRole('dialog', { name: 'Sheet options' });
  await expect(options).toBeVisible();
  await expect(options.getByLabel('Sub-divisions per cell')).toHaveValue('100');
  await expect(options.getByLabel('Grid line thickness')).toHaveValue('100');
  await expect(options.getByLabel('Transparency (%)')).toHaveValue('100');
  await options.getByRole('button', { name: 'Cancel' }).click();
  await expect(options).toHaveCount(0);

  // A part goes on it and stays: the editor works as on any layout.
  await page.getByPlaceholder(/fuzzy filter/i).first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect(page.locator('footer')).toContainText('1 piece');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('footer')).toContainText('1 piece', { timeout: 15000 });
});
