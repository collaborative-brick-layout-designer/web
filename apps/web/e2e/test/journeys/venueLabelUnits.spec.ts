// The Venue Designer's wall labels ("North — 40.00 ft") follow the Units
// pick (area 7 part B, 2026-11-10). They used to say feet whatever was
// chosen, next to a status bar that said metres.

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

test('wall labels follow the chosen units', async ({ page }) => {
  await signIn(page, `venue-units-${Date.now()}@example.com`, 'Venue Units');
  await page.goto('/venues/new');
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();

  // A 40' x 20' room.
  await page.keyboard.press('r');
  const box = (await page.getByTestId('venue-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Venue 40′ 0″ × 20′ 0″')).toBeVisible();
  const walls = (a: string, b: string) => [`north wall — ${a}`, `east wall — ${b}`, `south wall — ${a}`, `west wall — ${b}`];
  await expect.poll(() => wallLabels(page)).toEqual(walls('40.00 ft', '20.00 ft'));

  const units = page.locator('label:has-text("Units") select');
  await units.selectOption('m');
  await expect(page.getByText(/^Venue 12\.19 m × 6\.10 m/)).toBeVisible();
  await expect.poll(() => wallLabels(page)).toEqual(walls('12.19 m', '6.10 m'));

  await units.selectOption('studs');
  await expect.poll(() => wallLabels(page)).toEqual(walls('1523.9 studs', '762 studs'));

  await units.selectOption('ftin');
  await expect.poll(() => wallLabels(page)).toEqual(walls('40.00 ft', '20.00 ft'));
});

// The Units pick is kept with the venue (`lengthUnit`): opened again the
// designer is still in meters, and a layout started in the venue shows its
// wall lengths in meters too.
test('a venue remembers its units, in the designer and in a layout', async ({ page }) => {
  const VENUE = `Metric hall ${Date.now()}`;
  await signIn(page, `venue-units-kept-${Date.now()}@example.com`, 'Venue Units');
  await page.goto('/venues/new');
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
  await page.keyboard.press('r');
  const box = (await page.getByTestId('venue-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Venue 40′ 0″ × 20′ 0″')).toBeVisible();
  await page.keyboard.press('Escape');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByLabel('Name').fill(VENUE);
  await inspector.getByLabel('Name').press('Enter');

  // Picking a unit is a change to save.
  const units = page.locator('label:has-text("Units") select');
  await page.getByRole('button', { name: 'Save venue' }).click();
  await expect(page).toHaveURL(/\/venues\/[^/]+\/design$/);
  await expect(page.getByText('unsaved')).toHaveCount(0);
  await units.selectOption('m');
  await expect(page.getByText('unsaved')).toBeVisible();
  await page.getByRole('button', { name: 'Save venue' }).click();
  await expect(page.getByText('unsaved')).toHaveCount(0);

  // Opened again: still meters.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
  await expect(units).toHaveValue('m');
  await expect(page.getByText(/^Venue 12\.19 m × 6\.10 m/)).toBeVisible();
  await expect.poll(() => wallLabels(page)).toEqual(['north wall — 12.19 m', 'east wall — 6.10 m', 'south wall — 12.19 m', 'west wall — 6.10 m']);
  await page.getByRole('button', { name: 'Close' }).click();

  // A layout started in it: the layout editor's wall labels are in meters.
  const venueRow = page.locator('li', { hasText: VENUE });
  await venueRow.getByRole('link', { name: 'Start layout' }).click();
  const create = page.getByRole('dialog', { name: 'New layout' });
  await expect(create.getByRole('combobox')).toHaveValue(/.+/);
  await create.getByLabel('Title').fill(`In the ${VENUE}`);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  // (A label that would overlap another shows just its length.)
  await expect.poll(async () => (await wallLabels(page)).map((t) => t.replace(/^.* — /, '')).sort(), { timeout: 15000 }).toEqual(['12.19 m', '12.19 m', '6.10 m', '6.10 m']);
});
