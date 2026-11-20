// A module's table and power, as a layout coordinator uses them: set a
// module's table type, height and power from its ⋯ menu, see its row and
// the layout's Tables and power summary change at once, save it to the
// Module library (the table and power go along), and add it to another
// layout, where the placed copy has them too.

import { test, expect, type Page } from '@playwright/test';
import { signIn, makeModule } from '../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';

async function openModulesPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
}

test('set a module’s table and power, see the summary, and take them through the Module library', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, `tablepower-${ts}@example.com`, 'Table User');
  const res = await page.request.post('/api/layouts', { data: { title: 'Show layout' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Depot ${ts}`);
  await openModulesPanel(page);

  const summary = page.getByTestId('module-setup-summary');
  await expect(summary.getByTestId('module-setup-power')).toHaveText('Power: not set for any module');

  // ⋯ › Table and power…
  await page.getByRole('button', { name: `More for Depot ${ts}` }).click();
  await page.getByTestId('module-menu-setup').click();
  const dialog = page.getByRole('dialog', { name: `Table and power: Depot ${ts}` });
  await dialog.getByTestId('setup-table-type').selectOption('mils');
  await dialog.getByTestId('setup-height').fill('30 3/4');
  await dialog.getByTestId('setup-height').press('Enter');
  await expect(dialog.getByTestId('setup-height')).toHaveValue('30¾″');
  await dialog.getByTestId('setup-power').selectOption('yes');
  await dialog.getByTestId('setup-outlets').fill('2');
  await dialog.getByTestId('setup-watts').fill('60');
  await dialog.getByTestId('setup-plug-side').selectOption('back');
  // Shows behind the dialog at once, no refresh.
  await expect(summary.getByTestId('module-setup-power')).toHaveText('Power: 1 module needs 2 outlets, ~60 W');
  await dialog.getByTestId('setup-done').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('module-setup-note')).toHaveText('MILS · 30¾″ · Power: 2 outlets, ~60 W, plug at the back');
  await expect(summary.getByTestId('module-setup-tables')).toHaveText('MILS: 1 — 30¾″ (1)');

  // Save to Module library…: the library module has them.
  await page.getByRole('button', { name: `More for Depot ${ts}` }).click();
  await page.getByRole('menuitem', { name: 'Save to Module library…' }).click();
  await page.getByRole('dialog', { name: `Save “Depot ${ts}” to the Module library` }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “Depot ${ts}” to the Module library`)).toBeVisible({ timeout: 15000 });
  const listed = ((await (await page.request.get('/api/modules')).json()) as { modules: { title: string; setup: unknown }[] }).modules.find(
    (m) => m.title === `Depot ${ts}`,
  );
  expect(listed?.setup).toEqual({ table: { type: 'mils', heightMm: 781 }, power: { needed: true, outlets: 2, watts: 60, plugSide: 'back' } });

  // Home shows them on the module, and Table and power… there changes them.
  await page.goto('/');
  const row = page.getByTestId('module-row').filter({ hasText: `Depot ${ts}` });
  await expect(row.getByTestId('module-row-setup')).toHaveText('MILS · 30¾″ · Power: 2 outlets, ~60 W, plug at the back');
  await row.getByRole('button', { name: `More for Depot ${ts}` }).click();
  await page.getByTestId('module-row-setup-open').click();
  const libDialog = page.getByRole('dialog', { name: `Table and power: Depot ${ts}` });
  await libDialog.getByTestId('setup-outlets').fill('3');
  await libDialog.getByTestId('setup-done').click();
  await expect(row.getByTestId('module-row-setup')).toHaveText('MILS · 30¾″ · Power: 3 outlets, ~60 W, plug at the back');

  // Another layout: added from the Module library, the placed copy has them.
  const other = (await (await page.request.post('/api/layouts', { data: { title: 'Second layout' } })).json()) as { id: string };
  await page.goto(`/editor/${other.id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  // Only the Module library, so its rows have the room (the Modules panel is remembered open).
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).uncheck();
  await page.getByLabel('Module library', { exact: true }).check();
  await page.mouse.click(400, 400);
  const libRow = page.getByTestId('module-library-row').filter({ hasText: `Depot ${ts}` });
  await expect(libRow.getByTestId('module-library-setup')).toHaveText('MILS · 30¾″ · Power: 3 outlets, ~60 W, plug at the back');
  await libRow.getByRole('button', { name: 'Add to layout' }).click();
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Module library', { exact: true }).uncheck();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await expect(page.getByTestId('module-setup-summary').getByTestId('module-setup-power')).toHaveText('Power: 1 module needs 3 outlets, ~60 W', {
    timeout: 15000,
  });
});
