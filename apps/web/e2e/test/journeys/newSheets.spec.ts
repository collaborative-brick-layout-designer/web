// Journey — every kind of sheet added from the Sheets panel is kept.
//
//   The server checks the drawing settings of every live edit and refuses
//   one it can't draw. A new grid sheet was written with its cell-index
//   corner as '' instead of an {x, y} point, so from 2026-10-26 the server
//   refused the edit adding it: the sheet showed, and was gone after a
//   reload. Here: a new layout → add a Parts, Text, Area, Ruler and Grid
//   sheet → reload → all five are there.

import { test, expect } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();

test('each kind of new sheet is kept after a reload', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, `j-new-sheets-${ts}@example.com`, 'Sheet Sam');
  const res = await page.request.post('/api/layouts', { data: { title: `New sheets ${ts}` } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  const sheets = page.locator('aside', { hasText: 'Sheets' });
  // The new layout has a "Grid" and a "Layout" sheet; the new ones get these names.
  const added = [
    ['Parts sheet', 'Parts'],
    ['Text sheet', 'Text'],
    ['Area sheet', 'Area'],
    ['Ruler sheet', 'Ruler'],
    ['Grid sheet', 'Grid 2'],
  ] as const;
  for (const [kind, name] of added) {
    await sheets.getByTitle('Add a new sheet').click();
    await page.getByRole('button', { name: kind, exact: true }).click();
    await expect(sheets.locator('li', { hasText: name }).first()).toBeVisible();
  }

  // Kept by the server: there after a reload.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (const [, name] of added) await expect(sheets.getByText(name, { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(sheets.getByText('Grid', { exact: true })).toBeVisible();
});
