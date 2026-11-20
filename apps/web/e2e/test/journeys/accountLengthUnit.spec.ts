// Settings › Units (the account's length unit, trains design Phase 0): a
// room drawn without a unit of its own follows it, in the Venue Designer
// and on the layout, the moment it changes, with no reload. A room whose
// unit was picked keeps its own.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

/** What the wall labels say, as drawn. */
function wallLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type N = { name: () => string; className: string; getAttr: (k: string) => unknown; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st
      .find((n) => n.name() === 'venue-label')
      .flatMap((g) => g.find((n) => n.className === 'Text').map((t) => String(t.getAttr('text'))));
  });
}

const lengths = async (page: Page) => (await wallLabels(page)).map((t) => t.replace(/^.* — /, '')).sort();

test('the account unit shows venue lengths in feet, meters or studs at once', async ({ page }) => {
  const VENUE = `Unit hall ${Date.now()}`;
  await signIn(page, `length-unit-${Date.now()}@example.com`, 'Length Unit');

  // Settings › Units: feet and inches until set; picking Metric is saved to the account.
  await page.goto('/settings');
  const units = page.getByRole('radiogroup', { name: 'Units' });
  await expect(units.getByTestId('length-unit-ftin')).toHaveAttribute('aria-checked', 'true');
  await units.getByTestId('length-unit-m').click();
  await expect(units.getByTestId('length-unit-m')).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(async () => (await (await page.request.get('/api/me/preferences')).json()).prefs.lengthUnit)
    .toBe('m');

  // A new venue starts in the account's unit, without one of its own.
  await page.goto('/venues/new');
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
  const pick = page.locator('label:has-text("Units") select');
  await expect(pick).toHaveValue('m');
  await page.keyboard.press('r');
  const box = (await page.getByTestId('venue-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect.poll(() => lengths(page)).toEqual(['12.19 m', '12.19 m', '6.10 m', '6.10 m']);
  await page.keyboard.press('Escape');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByLabel('Name').fill(VENUE);
  await inspector.getByLabel('Name').press('Enter');
  await page.getByRole('button', { name: 'Save venue' }).click();
  await expect(page).toHaveURL(/\/venues\/[^/]+\/design$/);
  await page.getByRole('button', { name: 'Close' }).click();

  // A layout started in it shows meters.
  await page.locator('li', { hasText: VENUE }).getByRole('link', { name: 'Start layout' }).click();
  const create = page.getByRole('dialog', { name: 'New layout' });
  await expect(create.getByRole('combobox')).toHaveValue(/.+/);
  await create.getByLabel('Title').fill(`In the ${VENUE}`);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => lengths(page), { timeout: 15000 }).toEqual(['12.19 m', '12.19 m', '6.10 m', '6.10 m']);

  // Settings over the editor: Studs, and the walls change under the dialog, no reload.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('radiogroup', { name: 'Units' }).getByTestId('length-unit-studs').click();
  await expect.poll(() => lengths(page)).toEqual(['1523.9 studs', '1523.9 studs', '762 studs', '762 studs']);
  await dialog.getByRole('radiogroup', { name: 'Units' }).getByTestId('length-unit-ftin').click();
  await expect.poll(() => lengths(page)).toEqual(['20.00 ft', '20.00 ft', '40.00 ft', '40.00 ft']);
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('a venue whose unit was picked keeps it, whatever the account says', async ({ page }) => {
  await signIn(page, `length-unit-own-${Date.now()}@example.com`, 'Length Unit');
  await page.goto('/settings');
  await page.getByRole('radiogroup', { name: 'Units' }).getByTestId('length-unit-studs').click();
  await expect
    .poll(async () => (await (await page.request.get('/api/me/preferences')).json()).prefs.lengthUnit)
    .toBe('studs');

  await page.goto('/venues/new');
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
  const pick = page.locator('label:has-text("Units") select');
  await expect(pick).toHaveValue('studs');
  await page.keyboard.press('r');
  const box = (await page.getByTestId('venue-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect.poll(() => lengths(page)).toEqual(['1523.9 studs', '1523.9 studs', '762 studs', '762 studs']);
  // Feet and inches picked here is the venue's own (written, not the default).
  await pick.selectOption('ftin');
  await expect.poll(() => lengths(page)).toEqual(['20.00 ft', '20.00 ft', '40.00 ft', '40.00 ft']);
});
