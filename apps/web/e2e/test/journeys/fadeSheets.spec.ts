// Journey — "Fade other sheets while editing" makes the active sheet stand
// out, and never reaches a picture or the layout.
//
//   A layout with two parts sheets, one part on "Layout" and two on "Parts"
//   → export a PNG with the setting off → turn it on in the "Adding to"
//   menu: "Parts" fades, "Layout" stays full → pick "Parts": the fade
//   follows → export again: the PNG is byte-for-byte the first one, the
//   screen is still faded after it, and the server's .bbm is unchanged.
// SHOTS_DIR=<dir> also saves screenshots.

import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS_DIR;

const sheetsPanel = (page: Page) => page.locator('aside').filter({ has: page.getByText('Sheets', { exact: true }) }).last();
const control = (page: Page) => page.getByTestId('active-sheet-control');

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder(/fuzzy filter/i).first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function pickSheet(page: Page, name: string): Promise<void> {
  await control(page).click();
  await page.getByTestId('active-sheet-menu').getByRole('menuitemradio', { name: new RegExp(`^${name} `) }).click();
}

/** Each parts sheet's group on the map, as [parts on it, opacity], most parts last. */
function brickSheets(page: Page): Promise<[number, number][]> {
  return page.evaluate(() => {
    type N = { opacity: () => number; getChildren: () => unknown[] };
    const stage = (window as unknown as { Konva: { stages: { findOne: (s: string) => { find: (s: string) => N[] } }[] } }).Konva.stages[0]!;
    return stage
      .findOne('.parts-layer')
      .find('.sheet-fade')
      .map((g) => [g.getChildren().length, Math.round(g.opacity() * 100) / 100] as [number, number])
      .sort((a, b) => a[0] - b[0]);
  });
}

async function exportPng(page: Page): Promise<Buffer> {
  await mapMenu(page, 'Download & export', 'Export as image…');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const file = await (await download).path();
  await expect(page.getByRole('dialog', { name: 'Export / Print' })).toHaveCount(0);
  return readFile(file!);
}

test('fading the other sheets shows on screen only, never in a picture or the layout', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-fade-sheets-${ts}@example.com`, 'Fade Fay');
  const res = await page.request.post('/api/layouts', { data: { title: `Fade sheets ${ts}` } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  // "Layout" gets one part, a new "Parts" sheet two.
  await placePart(page);
  await sheetsPanel(page).getByTitle('Add a new sheet').click();
  await page.getByRole('button', { name: 'Parts sheet', exact: true }).click();
  await expect(page.getByTestId('active-sheet-name')).toHaveText('Parts');
  await placePart(page);
  await placePart(page);
  await pickSheet(page, 'Layout');
  await expect.poll(() => brickSheets(page)).toEqual([[1, 1], [2, 1]]);

  // Off by default: nothing fades. The picture to compare with.
  const bbm = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  await expect.poll(async () => (await bbm()).match(/<Brick /g)?.length ?? 0, { timeout: 15000 }).toBe(3);
  const savedBefore = await bbm();
  const plain = await exportPng(page);

  // Turn it on in the "Adding to" menu: the sheet not being added to fades.
  await control(page).click();
  const box = page.getByTestId('fade-other-sheets');
  await expect(box).not.toBeChecked();
  await expect(page.getByTestId('active-sheet-menu').getByRole('button', { name: /help/i })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-fade-menu.png` });
  await box.check();
  await page.keyboard.press('Escape');
  await expect.poll(() => brickSheets(page)).toEqual([[1, 1], [2, 0.35]]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-fade-on.png` });

  // Switch sheets: the fade follows at once.
  await pickSheet(page, 'Parts');
  await expect.poll(() => brickSheets(page)).toEqual([[1, 0.35], [2, 1]]);

  // The picture is the same as with the fade off, and the screen stays faded.
  const faded = await exportPng(page);
  expect(faded.equals(plain)).toBe(true);
  expect(await brickSheets(page)).toEqual([[1, 0.35], [2, 1]]);

  // A viewer preference: the layout on the server didn't change.
  expect(await bbm()).toBe(savedBefore);

  // It stays on in this browser, and off turns everything back to full.
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await control(page).click();
  await expect(page.getByTestId('fade-other-sheets')).toBeChecked();
  await page.getByTestId('fade-other-sheets').uncheck();
  await page.keyboard.press('Escape');
  await expect.poll(() => brickSheets(page)).toEqual([[1, 1], [2, 1]]);
});
