// Modules and sheets, end to end: Make a module (saved to the Module library) says which
// sheets the module uses and keeps them (solid, so the module editor shows
// its parts); adding it to a layout without one of its sheets asks "Where
// should these go?" (the picked sheet, or a new sheet by that name), and
// the server keeps the answer; a module with parts on a hidden sheet gets
// a sparser dashed outline and a note in the Modules panel.
// SHOTS_DIR=<dir> also saves screenshots.

import { test, expect, type Page } from '@playwright/test';
import { signIn, mapMenu } from '../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS_DIR;

function bricks(page: Page): Promise<{ id: string; opacity: number }[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAbsoluteOpacity: () => number };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).map((n) => ({ id: n.name().slice(6), opacity: n.getAbsoluteOpacity() })) : [];
  });
}

function frameDash(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    type N = { dash: () => number[] };
    const st = (window as unknown as { Konva?: { stages: { findOne: (s: string) => N | undefined }[] } }).Konva?.stages[0];
    return st?.findOne('.module-frame')?.dash() ?? null;
  });
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

const sheetsPanel = (page: Page) => page.locator('aside').filter({ has: page.getByText('Sheets', { exact: true }) }).last();

async function openLayout(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/layouts', { data: { title } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return id;
}

/** The layout's parts sheets and how many parts are on each, from the server's .bbm. */
async function serverSheets(page: Page, id: string): Promise<{ name: string; parts: number; t: number }[]> {
  const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  return [...xml.matchAll(/<Layer type="brick"[^>]*>\s*<Name>([^<]*)<\/Name>[\s\S]*?<Transparency>(\d+)<\/Transparency>([\s\S]*?)<\/Layer>/g)].map((m) => ({
    name: m[1]!,
    t: Number(m[2]),
    parts: (m[3]!.match(/<Brick /g) ?? []).length,
  }));
}

test('a module keeps its sheets, and adding it asks where a missing sheet goes', async ({ page }) => {
  await signIn(page, `mod-sheets-${ts}@example.com`, 'Sheet Keeper');

  // A layout with a part on "Layout" and two on a new sheet "Buildings".
  await openLayout(page, 'Town');
  await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(1);
  const panel = sheetsPanel(page);
  await panel.getByRole('button', { name: 'Add sheet' }).click();
  await panel.getByRole('button', { name: 'Parts sheet' }).click();
  await panel.getByText('Parts', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename…/ }).click();
  await panel.locator('input:not([type])').fill('Buildings');
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Buildings', { exact: true })).toBeVisible();
  await placePart(page);
  await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(3);

  // Make a module and save it to the Module library: it says which sheets, and keeps them.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await mapMenu(page, 'Modules & sets', 'Make a module…');
  const make = page.getByRole('dialog', { name: 'Make a module' });
  await make.getByLabel('Module name').fill('Main street');
  await make.getByTestId('make-module-also-save').check();
  await expect(make.getByTestId('module-sheets')).toContainText('This module uses 2 sheets: Layout, Buildings.');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/save-module-sheets.png` });
  await make.getByRole('button', { name: 'Make and save' }).click();
  await expect(make).toHaveCount(0, { timeout: 15000 });
  const modules = (await (await page.request.get('/api/modules')).json()) as { modules: { id: string; title: string }[] };
  const moduleId = modules.modules.find((m) => m.title === 'Main street')!.id;

  // The module editor shows its parts, solid (an older save hid them).
  await page.goto(`/modules/${moduleId}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await bricks(page)).map((b) => b.opacity)).toEqual([1, 1, 1]);

  // A layout without "Buildings": the question, then a new sheet by that name.
  const b = await openLayout(page, 'Park');
  await page.getByRole('button', { name: 'Insert module' }).click();
  await page.locator('li', { hasText: 'Main street' }).getByRole('button', { name: 'Insert' }).click();
  const ask = page.getByTestId('sheet-choice-dialog');
  await expect(ask).toContainText('Where should these go?');
  await expect(ask).toContainText('“Main street” uses 2 sheets. Your layout doesn’t have “Buildings”.');
  await expect(ask).toContainText('Buildings (2 parts)');
  const where = ask.getByRole('combobox', { name: 'Where the parts on Buildings go' });
  await expect(where.locator('option:checked')).toHaveText('Layout (picked sheet)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/where-should-these-go.png` });
  await where.selectOption({ label: 'A new sheet named “Buildings”' });
  await ask.getByRole('button', { name: 'Place' }).click();
  await expect(ask).toHaveCount(0);
  await expect.poll(async () => (await bricks(page)).length).toBe(3);

  // Hide Buildings: the module's outline fits the rest, with sparser dashes, and the panel says so.
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await expect.poll(() => frameDash(page)).toEqual([6, 4]);
  await sheetsPanel(page).getByRole('checkbox', { name: 'Show Buildings' }).uncheck();
  await expect.poll(() => frameDash(page)).toEqual([2, 6]);
  await expect(page.getByTestId('module-hidden-note')).toHaveText('2 parts are on a hidden sheet');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/partly-hidden-module.png` });
  await sheetsPanel(page).getByRole('checkbox', { name: 'Show Buildings' }).check();

  // Another layout: Cancel puts nothing down; Place with the default goes on the picked sheet, no new sheet.
  const c = await openLayout(page, 'Harbour');
  await page.getByRole('button', { name: 'Insert module' }).click();
  const insert = page.locator('li', { hasText: 'Main street' }).getByRole('button', { name: 'Insert' });
  await insert.click();
  await page.getByTestId('sheet-choice-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('sheet-choice-dialog')).toHaveCount(0);
  expect(await bricks(page)).toHaveLength(0);
  // The Insert module dialog stays open to pick again.
  await insert.click();
  await page.getByTestId('sheet-choice-dialog').getByRole('button', { name: 'Place' }).click();
  await expect.poll(async () => (await bricks(page)).length).toBe(3);

  // The server keeps both answers.
  await page.goto('/');
  await expect.poll(() => serverSheets(page, b), { timeout: 10000 }).toEqual([
    { name: 'Layout', parts: 1, t: 100 },
    { name: 'Buildings', parts: 2, t: 100 },
  ]);
  await expect.poll(() => serverSheets(page, c), { timeout: 10000 }).toEqual([{ name: 'Layout', parts: 3, t: 100 }]);
});
