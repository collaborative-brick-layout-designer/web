// Journey — it is always plain which sheet new parts go on.
//
//   A layout with two parts sheets → pick "Layout" with the "Adding to"
//   control → the control, the Sheets panel's Active badge and the Parts
//   panel's title all say "Layout" → a part placed lands on "Layout" (the
//   server's .bbm) → a part dragged over the map carries "→ Layout" → rename
//   the sheet: the control follows → place a part on a hidden sheet: a
//   notice says so and "Show sheet" shows it → with a text sheet active a
//   part goes on a parts sheet, and the notice names it.
// SHOTS_DIR=<dir> also saves screenshots.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS_DIR;

const sheetsPanel = (page: Page) => page.locator('aside').filter({ has: page.getByText('Sheets', { exact: true }) }).last();
const control = (page: Page) => page.getByTestId('active-sheet-control');
const partsTitle = (page: Page) => page.locator('[data-panel="parts"] h2');

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder(/fuzzy filter/i).first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function pickSheet(page: Page, name: string): Promise<void> {
  await control(page).click();
  await page.getByTestId('active-sheet-menu').getByRole('menuitemradio', { name: new RegExp(`^${name} `) }).click();
}

/** The control, the Sheets panel and the Parts panel all name `name`. */
async function allSay(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('active-sheet-name')).toHaveText(name);
  const active = sheetsPanel(page).locator('li[data-active]');
  await expect(active).toHaveCount(1);
  await expect(active).toContainText(name);
  await expect(active.getByTestId('active-sheet-badge')).toHaveText('Active');
  await expect(partsTitle(page)).toHaveText(`Parts → ${name}`);
}

/** Parts on each parts sheet, from the server's .bbm. */
async function serverSheets(page: Page, id: string): Promise<Record<string, number>> {
  const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  return Object.fromEntries(
    [...xml.matchAll(/<Layer type="brick"[^>]*>\s*<Name>([^<]*)<\/Name>([\s\S]*?)<\/Layer>/g)].map((m) => [m[1]!, (m[2]!.match(/<Brick /g) ?? []).length]),
  );
}

test('the sheet new parts go on is named everywhere, and surprises are explained', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-active-sheet-${ts}@example.com`, 'Active Ava');
  const res = await page.request.post('/api/layouts', { data: { title: `Active sheet ${ts}` } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  // A second parts sheet, "Parts": a new sheet becomes the active one.
  const sheets = sheetsPanel(page);
  await sheets.getByTitle('Add a new sheet').click();
  await page.getByRole('button', { name: 'Parts sheet', exact: true }).click();
  await allSay(page, 'Parts');

  // Switch back with the control; everything agrees.
  await pickSheet(page, 'Layout');
  await allSay(page, 'Layout');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-active-sheet.png` });

  // A placed part lands on that sheet.
  await placePart(page);
  await expect.poll(() => serverSheets(page, id), { timeout: 15000 }).toEqual({ Layout: 1, Parts: 0 });

  // A part dragged over the map says where it will land.
  await page.evaluate(() => {
    const target = document.querySelector('.konvajs-content')!;
    const r = target.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/x-cld-part', 'ts_narrowgauge_straight.8');
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200 }));
  });
  await expect(page.getByTestId('drop-sheet-tag')).toHaveText('→ Layout');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-drop-tag.png` });
  await page.evaluate(() => document.querySelector('.konvajs-content')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true })));
  await expect(page.getByTestId('drop-sheet-tag')).toHaveCount(0);

  // Renaming the active sheet: the control follows at once.
  const row = sheets.locator('li[data-active]');
  await row.focus();
  await row.press('F2');
  await row.locator('input:not([type])').fill('Tables');
  await row.locator('input:not([type])').press('Enter');
  await allSay(page, 'Tables');

  // A hidden sheet: placing on it says so, and offers to show it.
  await row.locator('input[type="checkbox"]').uncheck();
  await expect(control(page)).toContainText('hidden');
  await placePart(page);
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('“Tables”, which is hidden');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-hidden-warning.png` });
  await notice.getByTestId('notice-action').click();
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();
  await expect(control(page)).not.toContainText('hidden');
  await expect.poll(() => serverSheets(page, id), { timeout: 15000 }).toEqual({ Tables: 2, Parts: 0 });

  // A text sheet can't hold parts: the part goes on the first parts sheet,
  // which becomes the active one, and the notice says which.
  await sheets.getByTitle('Add a new sheet').click();
  await page.getByRole('button', { name: 'Text sheet', exact: true }).click();
  await expect(page.getByTestId('active-sheet-name')).toHaveText('Text');
  await expect(partsTitle(page)).toHaveText('Parts → Tables');
  await placePart(page);
  await expect(page.getByTestId('notice')).toContainText('went on “Tables”, not “Text”, a text sheet');
  await allSay(page, 'Tables');
  await expect.poll(() => serverSheets(page, id), { timeout: 15000 }).toEqual({ Tables: 3, Parts: 0 });
});

// Both apps open a file on the same sheet: the one saved as selected when it
// takes parts, else the topmost parts sheet. Fordyce was saved with "rulers"
// selected, so it opens adding to "Tracks" (the desktop does the same).
test('a file opens on its saved sheet, or the topmost parts sheet', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const bbm = readFileSync(fileURLToPath(new URL('../../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm', import.meta.url)), 'utf-8');
  await signIn(page, `j-start-sheet-${ts}@example.com`, 'Start Sam');
  for (const [saved, expected] of [[4, 'Tracks'], [1, 'Tables']] as const) {
    const data = { title: `Fordyce ${saved}`, bbm: bbm.replace('<SelectedLayerIndex>4</SelectedLayerIndex>', `<SelectedLayerIndex>${saved}</SelectedLayerIndex>`) };
    const { id } = (await (await page.request.post('/api/layouts', { data })).json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.getByTestId('active-sheet-name')).toHaveText(expected, { timeout: 15000 });
  }
});
